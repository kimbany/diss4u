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
const kie = require('./kie-music');

const PORT = process.env.PORT || 3100;
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

    if (path.startsWith('/song-status/') && req.method === 'GET') {
      const jobId = decodeURIComponent(path.replace('/song-status/', ''));
      if (!jobId) return send(res, 400, { error: 'jobId 없음' });
      const out = await kie.songStatus(jobId);
      console.log('· song-status', jobId, '→', out.status);
      return send(res, 200, out);
    }

    return send(res, 404, { error: 'Invalid path' });
  } catch (e) {
    console.error('✖', path, e.message);
    return send(res, e.status || 502, { error: 'kie_error', message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🎤 kie 테스트 서버: http://localhost:${PORT}  (key ${process.env.KIE_API_KEY ? 'OK' : '없음'})`);
  console.log('   POST /generate-song  ·  GET /song-status/:id  ·  GET /health');
});
