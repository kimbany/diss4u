'use strict';
/**
 * 테스트 프록시 서버 (2단계) — 운영(proxy/server.js)과 "같은 라우트"를 kie.ai로 구현.
 *
 * ⚠️ 운영 서버·Firebase·결제와 완전히 분리. 인증/크레딧 없음(테스트 전용).
 *   운영 프론트(index.html)가 워커 URL만 이 서버로 바꾸면 그대로 동작하도록 계약을 맞춤.
 *
 * 라우트:
 *   POST /generate-song   { lyrics, title, style }      → { jobId }
 *   GET  /song-status/:id                               → { status, audioUrl, timestampedLyrics, ... }
 *   GET  /health                                        → { ok, has_key }
 *
 * 실행:
 *   KIE_API_KEY=발급키 node staging/test-server.js          (기본 포트 3100)
 *   PORT=4000 KIE_API_KEY=... node staging/test-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const kie = require('./kie-music');

const ROOT = path.join(__dirname, '..');     // 저장소 루트(이미지 등 정적 파일)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg',
};
// 정적 파일 서빙: '/'·'/clone.html' → 복제본, 그 외엔 staging/ 또는 루트에서 찾아준다.
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '/clone.html') rel = '/clone.html';
  rel = rel.replace(/\.\.+/g, '');           // 경로 탈출 방지
  const candidates = [path.join(__dirname, rel), path.join(ROOT, rel)];
  for (const f of candidates) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const buf = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length, ...CORS });
      return res.end(buf);
    }
  }
  return send(res, 404, { error: 'not found', path: pathname });
}

const PORT = process.env.PORT || 3100;
// 가사 생성(/generate-lyrics)은 kie 소관이 아니라 운영 워커(Claude/Solar/Gemini)로 패스스루.
// → 복제본은 워커 URL만 이 서버로 바꾸면 가사+곡 둘 다 동작(곡만 kie).
const LYRICS_UPSTREAM = process.env.LYRICS_UPSTREAM || 'https://chinolsong-proxy.onrender.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, Authorization',
};

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (path === '/health') {
      return send(res, 200, { ok: true, service: 'kie-test-server', has_key: !!process.env.KIE_API_KEY });
    }

    if (path === '/generate-song' && req.method === 'POST') {
      const { lyrics, title, style } = await readBody(req);
      if (!lyrics || !title || !style) return send(res, 400, { error: '필수 항목 누락 (lyrics, title, style)' });
      const out = await kie.generateSong({ lyrics, title, style });
      console.log('▶ generate-song →', out.jobId);
      return send(res, 200, out);
    }

    // 가사 생성·기타 워커 라우트는 운영으로 패스스루 (곡 생성/상태만 kie)
    // 로그인 토큰(Authorization)도 그대로 넘겨서, 로그인하면 진짜 가사AI가 동작.
    if (path === '/generate-lyrics' && req.method === 'POST') {
      const body = await readBody(req);
      const fwd = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) fwd['Authorization'] = req.headers.authorization;
      const up = await fetch(LYRICS_UPSTREAM + '/generate-lyrics', {
        method: 'POST', headers: fwd, body: JSON.stringify(body),
      });
      const text = await up.text();
      console.log('↪ generate-lyrics 패스스루 →', up.status);
      res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
      return res.end(text);
    }

    // 오디오 중계: kie 오디오는 외부 CDN(aiquickdraw)이라 브라우저가 영상 만들 때
    // CORS로 막힘 → 우리 서버가 받아서 CORS 붙여 다시 내보낸다. (운영도 동일 필요)
    if (path === '/audio' && req.method === 'GET') {
      const u = url.searchParams.get('u');
      if (!u) return send(res, 400, { error: 'no url' });
      const up = await fetch(u);
      if (!up.ok) return send(res, up.status, { error: 'audio fetch fail' });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Content-Length': buf.length, ...CORS });
      return res.end(buf);
    }

    if (path.startsWith('/song-status/') && req.method === 'GET') {
      const jobId = decodeURIComponent(path.replace('/song-status/', ''));
      if (!jobId) return send(res, 400, { error: 'jobId 없음' });
      const out = await kie.songStatus(jobId);
      // 오디오 주소를 우리 중계 주소로 바꿔서 영상 만들 때 CORS 안 걸리게.
      if (out.audioUrl) {
        const self = 'http://' + (req.headers.host || ('localhost:' + PORT));
        out.audioUrlOriginal = out.audioUrl;
        out.audioUrl = self + '/audio?u=' + encodeURIComponent(out.audioUrl);
      }
      console.log('· song-status', jobId, '→', out.status);
      // 완성 시 줄별 타이밍을 표로 출력 + 파일 저장 → 싱크 진단용(터미널 캡처해서 보내면 됨)
      if (out.status === 'COMPLETED' && out.timestampedLyrics && out.timestampedLyrics.lines) {
        try {
          const outDir = path.join(__dirname, 'out');
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'last-song.json'), JSON.stringify(out.timestampedLyrics, null, 2));
        } catch (e) {}
        const L = out.timestampedLyrics.lines;
        console.log('┌── 싱크 진단: 줄별 타이밍 (start~end 초) ─────────────');
        L.forEach((ln, i) => console.log('│ ' + String(i + 1).padStart(2) + '줄 ' + ln.start.toFixed(2) + '~' + ln.end.toFixed(2) + 's  ' + ln.text));
        console.log('└──────────────────────  (staging/out/last-song.json 에도 저장됨)');
      }
      return send(res, 200, out);
    }

    // 그 외 GET 은 정적 파일(복제 사이트·이미지)로 서빙
    if (req.method === 'GET') return serveStatic(req, res, path);
    return send(res, 404, { error: 'Invalid path' });
  } catch (e) {
    console.error('✖', path, e.message);
    return send(res, e.status || 502, { error: 'kie_error', message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🎤 복제 사이트 + kie 서버 한 번에: http://localhost:${PORT}/  (key ${process.env.KIE_API_KEY ? 'OK' : '없음'})`);
  console.log('   → 브라우저에서 위 주소 열면 바로 테스트 (python·터미널 2개 불필요)');
});
