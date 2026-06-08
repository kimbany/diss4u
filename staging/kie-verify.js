#!/usr/bin/env node
/**
 * 1단계 검증 스크립트 — 새 업체(kie.ai / sunoapi.org)가 "가사 타임스탬프"를 제대로 주는지 확인.
 *
 * ⚠️ 운영 앱(diss4u.com)·Render 서버·Firebase·결제와 완전히 분리된 독립 도구입니다.
 *    여기서 뭘 해도 실제 서비스엔 영향이 없습니다.
 *
 * 하는 일:
 *   1) 새 업체에 샘플 곡 1개 생성 요청
 *   2) 완성될 때까지 상태 폴링
 *   3) 완성된 곡의 "단어별 타임스탬프"를 받아옴
 *   4) staging/out/ 에 음원(song.mp3) + 타임스탬프(timestamps.json) 저장
 *      → 그 다음 staging/preview.html 을 열면 실제 싱크를 눈으로 확인 가능
 *
 * 실행 (API 키는 절대 코드/깃에 넣지 말고 환경변수로):
 *   PROVIDER=kie KIE_API_KEY=발급받은키 node staging/kie-verify.js
 *   PROVIDER=sunoapi SUNOAPI_KEY=발급받은키 node staging/kie-verify.js
 *
 * 선택 환경변수:
 *   MODEL   기본 V5        (V4 / V4_5 / V5 등)
 *   TITLE   기본 "테스트 디스곡"
 *   STYLE   기본 "korean hiphop diss"
 *   LYRICS_FILE  가사 텍스트 파일 경로 (없으면 내장 샘플 사용)
 */

const fs = require('fs');
const path = require('path');

// ── 업체 설정 (둘 다 동일한 Suno 공통 API 규격) ─────────────────────────────
const PROVIDERS = {
  kie:     { base: 'https://api.kie.ai',      key: process.env.KIE_API_KEY },
  sunoapi: { base: 'https://api.sunoapi.org', key: process.env.SUNOAPI_KEY },
};
const which = (process.env.PROVIDER || 'kie').toLowerCase();
const P = PROVIDERS[which];
if (!P) { console.error(`❌ PROVIDER는 kie 또는 sunoapi 여야 해요 (지금: ${which})`); process.exit(1); }
if (!P.key) { console.error(`❌ API 키가 없어요. 예) PROVIDER=${which} ${which === 'kie' ? 'KIE_API_KEY' : 'SUNOAPI_KEY'}=키 node staging/kie-verify.js`); process.exit(1); }

const MODEL = process.env.MODEL || 'V5';
const TITLE = process.env.TITLE || '테스트 디스곡';
const STYLE = process.env.STYLE || 'korean hiphop diss';
const SAMPLE_LYRICS = process.env.LYRICS_FILE
  ? fs.readFileSync(process.env.LYRICS_FILE, 'utf8')
  : [
      '[Verse]',
      '너의 자신감은 어디서 나오는지',
      '거울 속 모습부터 다시 봐야 할 텐데',
      '말은 번지르르 행동은 빈 깡통',
      '[Hook]',
      '체크 체크 마이크 잡고',
      '한 마디면 너는 게임 끝',
      '[End]',
    ].join('\n');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${P.key}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(obj, ...keys) { for (const k of keys) if (obj && obj[k] != null) return obj[k]; return undefined; }

// 음원(base64)·타임스탬프를 통째로 박아 넣은 단일 HTML 미리보기를 만든다.
// 서버 없이 더블클릭(file://)으로 열어도 동작 → 사용자에게 그대로 전달 가능.
function buildStandalone(data, audioSrc) {
  const json = JSON.stringify({ ...data, audioUrl: undefined }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>가사 싱크 검증</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#0d0f14;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center}
header{padding:18px;text-align:center}header h1{font-size:18px;margin:0 0 4px}header p{margin:0;color:#9aa3b2;font-size:13px}
.badge{display:inline-block;background:#1c2230;color:#d4ff3a;border-radius:999px;padding:2px 10px;font-size:12px;margin-top:6px}
#stage{width:min(92vw,460px);aspect-ratio:9/16;max-height:66vh;background:linear-gradient(160deg,#141a26,#0a0c11);border:1px solid #232a39;border-radius:18px;margin:8px 0 14px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:24px}
#line{font-size:30px;font-weight:800;line-height:1.35;text-align:center}#line .w{color:#56607a;transition:color .08s,text-shadow .08s;margin:0 .12em}
#line .w.on{color:#fff;text-shadow:0 0 18px rgba(212,255,58,.9)}#line .w.done{color:#c7d0e0}
#nextline{position:absolute;bottom:26px;left:0;right:0;text-align:center;color:#67708a;font-size:16px;padding:0 20px}
audio{width:min(92vw,460px);margin-bottom:10px}.controls{display:flex;gap:8px;justify-content:center;padding:0 12px 24px;align-items:center}
.controls label{background:#1c2230;color:#fff;border:1px solid #2c3445;border-radius:10px;padding:8px 14px;font-size:13px}
.msg{color:#d4ff3a;font-size:13px;text-align:center;max-width:460px;padding:0 14px 30px;line-height:1.5}</style></head>
<body><header><h1>🎤 가사 싱크 검증</h1><p>단어가 노래에 맞춰 켜지는지 확인하세요</p><div class="badge" id="meta"></div></header>
<div id="stage"><div id="line"></div><div id="nextline"></div></div>
<audio id="audio" controls src="${audioSrc}"></audio>
<div class="controls"><label>오프셋: <input id="offset" type="range" min="-1500" max="1500" step="50" value="0" style="vertical-align:middle"><span id="ov">0ms</span></label></div>
<div class="msg">▶ 재생을 누르고 단어가 노래에 맞춰 켜지는지 보세요. 살짝 밀리면 ‘오프셋’으로 맞춰보세요.</div>
<script>const DATA=${json};
const audio=document.getElementById('audio'),lineEl=document.getElementById('line'),nextEl=document.getElementById('nextline');
let offset=0;document.getElementById('offset').addEventListener('input',e=>{offset=+e.target.value;document.getElementById('ov').textContent=offset+'ms'});
const WORDS=(DATA.words||[]).filter(w=>w.word&&w.word.trim());
function group(ws){const L=[];let c=[];for(let i=0;i<ws.length;i++){c.push(ws[i]);const g=i+1<ws.length?ws[i+1].start-ws[i].end:Infinity;if(c.length>=9||g>0.7){L.push(c);c=[]}}if(c.length)L.push(c);return L.map(x=>({words:x,start:x[0].start,end:x[x.length-1].end}))}
const LINES=group(WORDS);
document.getElementById('meta').innerHTML='업체 <b>'+DATA.provider+'</b> · '+(DATA.model||'')+' · 단어 '+WORDS.length+'개'+(DATA.confidence!=null?' · 신뢰도 '+DATA.confidence:'');
function esc(s){return(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function render(){const t=audio.currentTime+offset/1000;let i=LINES.findIndex(l=>t>=l.start&&t<=l.end+0.4);if(i<0){i=LINES.findIndex(l=>l.start>t);if(i<0)i=LINES.length-1}const ln=LINES[i];if(!ln)return;lineEl.innerHTML=ln.words.map(w=>{let c='w';if(t>=w.start&&t<=w.end)c+=' on';else if(t>w.end)c+=' done';return'<span class="'+c+'">'+esc(w.word)+'</span>'}).join('');const nx=LINES[i+1];nextEl.textContent=nx?nx.words.map(w=>w.word).join(' '):''}
(function loop(){render();requestAnimationFrame(loop)})();</script></body></html>`;
}

async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { ok: r.ok, status: r.status, json, text };
}
async function jget(url) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { ok: r.ok, status: r.status, json, text };
}

(async () => {
  console.log(`\n🎤 [1단계 검증] 업체=${which}  모델=${MODEL}`);
  console.log(`   base=${P.base}\n`);

  // ── 1) 곡 생성 요청 ───────────────────────────────────────────────
  const genBody = {
    prompt: SAMPLE_LYRICS,
    style: STYLE,
    title: TITLE,
    customMode: true,
    instrumental: false,
    model: MODEL,
    // 일부 업체는 callBackUrl이 필수라 placeholder를 넣어둠. 우린 폴링으로 결과를 받음.
    callBackUrl: 'https://example.com/no-callback',
  };
  console.log('① 곡 생성 요청 중...');
  const gen = await jpost(`${P.base}/api/v1/generate`, genBody);
  fs.writeFileSync(path.join(OUT, 'generate-response.json'), JSON.stringify(gen.json, null, 2));
  if (!gen.ok || (gen.json.code && gen.json.code !== 200)) {
    console.error('❌ 생성 요청 실패:', gen.status, gen.text.slice(0, 600));
    console.error('   (응답 형식이 문서와 다르면 staging/out/generate-response.json 을 보고 알려주세요)');
    process.exit(1);
  }
  const taskId = pick(gen.json.data || gen.json, 'taskId', 'task_id', 'id');
  if (!taskId) { console.error('❌ taskId를 못 찾음. 응답:', JSON.stringify(gen.json).slice(0, 600)); process.exit(1); }
  console.log('   ✅ taskId =', taskId);

  // ── 2) 완성될 때까지 폴링 ─────────────────────────────────────────
  console.log('② 곡 생성 대기(최대 5분)...');
  let track = null, status = '';
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(8000);
    const rec = await jget(`${P.base}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`);
    const data = rec.json.data || {};
    status = (pick(data, 'status') || '').toString().toUpperCase();
    const list = pick(data.response || {}, 'sunoData', 'data') || pick(data, 'sunoData') || [];
    const ready = (Array.isArray(list) ? list : []).find((t) => pick(t, 'audioUrl', 'audio_url'));
    process.stdout.write(`   상태: ${status || '(대기)'}\r`);
    if (ready) { track = ready; }
    if (track && /SUCCESS/.test(status)) break;          // 완전 완료
    if (track && /FIRST_SUCCESS|TEXT_SUCCESS/.test(status)) break; // 첫 곡 오디오 준비됨
    if (/FAIL|ERROR/.test(status)) { console.error('\n❌ 생성 실패 상태:', status); process.exit(1); }
  }
  if (!track) { console.error('\n❌ 시간 내에 곡이 안 나왔어요. staging/out/generate-response.json 확인.'); process.exit(1); }

  const audioId = pick(track, 'id', 'audioId', 'audio_id');
  const audioUrl = pick(track, 'audioUrl', 'audio_url', 'streamAudioUrl', 'stream_audio_url');
  console.log(`\n   ✅ 곡 완성  audioId=${audioId}`);
  console.log(`   🔗 ${audioUrl}`);

  // ── 3) 타임스탬프(단어별 타이밍) 받기 ──────────────────────────────
  console.log('③ 단어별 타임스탬프 요청 중...');
  const ts = await jpost(`${P.base}/api/v1/generate/get-timestamped-lyrics`, {
    taskId, audioId, musicIndex: 0,
  });
  fs.writeFileSync(path.join(OUT, 'timestamps-raw.json'), JSON.stringify(ts.json, null, 2));
  if (!ts.ok || (ts.json.code && ts.json.code !== 200)) {
    console.error('❌ 타임스탬프 요청 실패:', ts.status, ts.text.slice(0, 600));
    console.error('   → 이 업체가 타임스탬프를 안 주거나 형식이 다를 수 있어요. timestamps-raw.json 확인.');
    process.exit(1);
  }
  const tdata = ts.json.data || ts.json;
  const aligned = pick(tdata, 'alignedWords', 'aligned_words', 'words') || [];
  if (!aligned.length) {
    console.error('❌ 정렬된 단어가 비어있어요. timestamps-raw.json 확인.');
    process.exit(1);
  }
  // 단어 배열을 preview.html이 쓰기 쉬운 형태로 정규화
  const words = aligned.map((w) => ({
    word: pick(w, 'word', 'text', 'w') || '',
    start: Number(pick(w, 'startS', 'start_s', 'start') || 0),
    end: Number(pick(w, 'endS', 'end_s', 'end') || 0),
    success: pick(w, 'success'),
  }));

  // ── 4) 음원 다운로드 + 결과 저장 ───────────────────────────────────
  console.log('④ 음원 다운로드 중...');
  let savedAudio = null;
  let audioBuffer = null;
  try {
    const ar = await fetch(audioUrl);
    if (ar.ok) {
      audioBuffer = Buffer.from(await ar.arrayBuffer());
      fs.writeFileSync(path.join(OUT, 'song.mp3'), audioBuffer);
      savedAudio = 'song.mp3';
      console.log(`   ✅ staging/out/song.mp3 (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
    } else {
      console.log('   ⚠️ 음원 다운로드 실패(만료/권한). preview는 원격 URL로 재생 시도.');
    }
  } catch (e) { console.log('   ⚠️ 음원 다운로드 예외:', e.message); }

  const out = {
    provider: which, model: MODEL, taskId, audioId,
    audioUrl, audioLocal: savedAudio,
    title: TITLE, lyrics: SAMPLE_LYRICS,
    confidence: pick(tdata, 'hootCer', 'confidence'),
    words,
  };
  fs.writeFileSync(path.join(OUT, 'timestamps.json'), JSON.stringify(out, null, 2));

  // ── 자체완결 미리보기 1개 파일 생성 (음원·데이터를 통째로 박아넣음) ─────────
  // 서버 없이 더블클릭만 하면 노래 들으며 싱크를 볼 수 있는 단일 HTML. (전달용)
  try {
    const audioSrc = audioBuffer
      ? `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`
      : audioUrl;
    const html = buildStandalone(out, audioSrc);
    fs.writeFileSync(path.join(OUT, 'preview-standalone.html'), html);
    console.log('   ✅ staging/out/preview-standalone.html (더블클릭으로 바로 확인 가능)');
  } catch (e) { console.log('   ⚠️ 자체완결 미리보기 생성 실패:', e.message); }

  // 요약 출력
  console.log('\n──────── 결과 요약 ────────');
  console.log(`단어 개수: ${words.length}`);
  console.log('처음 8단어 타이밍:');
  words.slice(0, 8).forEach((w) => console.log(`  ${w.start.toFixed(2)}s ~ ${w.end.toFixed(2)}s  "${w.word}"`));
  console.log('\n✅ 저장 완료: staging/out/  (timestamps.json, song.mp3, preview-standalone.html)');
  console.log('👉 더블클릭 확인: staging/out/preview-standalone.html (서버 불필요, 음원 내장)');
  console.log('   또는 staging 폴더에서  python3 -m http.server  후 preview.html 접속\n');
})().catch((e) => { console.error('❌ 예외:', e); process.exit(1); });
