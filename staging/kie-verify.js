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
  try {
    const ar = await fetch(audioUrl);
    if (ar.ok) {
      const buf = Buffer.from(await ar.arrayBuffer());
      fs.writeFileSync(path.join(OUT, 'song.mp3'), buf);
      savedAudio = 'song.mp3';
      console.log(`   ✅ staging/out/song.mp3 (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
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

  // 요약 출력
  console.log('\n──────── 결과 요약 ────────');
  console.log(`단어 개수: ${words.length}`);
  console.log('처음 8단어 타이밍:');
  words.slice(0, 8).forEach((w) => console.log(`  ${w.start.toFixed(2)}s ~ ${w.end.toFixed(2)}s  "${w.word}"`));
  console.log('\n✅ 저장 완료: staging/out/timestamps.json , song.mp3');
  console.log('👉 다음: staging/preview.html 을 브라우저로 열어 실제 싱크를 눈으로 확인하세요.');
  console.log('   (로컬에서: staging 폴더에서  npx serve  또는  python3 -m http.server  후 preview.html 접속)\n');
})().catch((e) => { console.error('❌ 예외:', e); process.exit(1); });
