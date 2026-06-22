// kie.ai 음악 생성 연동 모듈 (운영 프록시용, ESM)
// APIFRAME 대체: 곡 생성·폴링·단어별 타임스탬프. 결제/크레딧 로직은 server.js가 그대로 담당.
// 환경변수: KIE_API_KEY (필수), KIE_BASE(기본 https://api.kie.ai), KIE_CALLBACK(선택)

const KIE_BASE = process.env.KIE_BASE || 'https://api.kie.ai';

function pick(obj, ...keys) { for (const k of keys) if (obj && obj[k] != null) return obj[k]; return undefined; }
function authHeaders(apiKey) { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }; }

// 곡 생성마다 살짝 다른 보컬·리듬 톤을 섞어서 다양성 확보 — 같은 장르여도 매번 색이 달라짐.
// 추가로 "입에 붙는 후크 멜로디"는 매번 강제 — Suno가 반복 멜로딕 후크를 만들도록 항상 박는다.
function pickVarietyModifier() {
  const VOCALS = [
    'energetic vocal performance', 'playful vocal delivery',
    'cheeky punchy vocals', 'sarcastic teasing vocals',
    'snappy rhythmic vocal flow', 'theatrical exaggerated vocals',
    'tight staccato vocal style', 'sing-song mocking delivery'
  ];
  const TEMPOS = [
    'punchy upbeat tempo', 'driving energetic rhythm',
    'bouncy snappy groove', 'tight rhythmic flow',
    'high-energy drum pattern', 'syncopated catchy beat'
  ];
  // 매번 들어가는 강제 후크 멜로디 키워드 — 중독성 있는 반복 멜로디를 만들도록 Suno에게 강제 신호.
  const HOOK_MELODY = 'earworm catchy melodic hook, repetitive memorable chorus melody, looping singalong vocal motif, melodic hook line repeats 4+ times';
  const v = VOCALS[Math.floor(Math.random() * VOCALS.length)];
  const t = TEMPOS[Math.floor(Math.random() * TEMPOS.length)];
  return ', ' + HOOK_MELODY + ', ' + v + ', ' + t;
}

// 곡 생성 요청 → { jobId }
export async function generateSong({ lyrics, title, style, model = 'V5', apiKey = process.env.KIE_API_KEY }) {
  if (!apiKey) throw Object.assign(new Error('KIE_API_KEY 없음'), { status: 500 });
  // 운영과 동일한 "짧은 곡" 힌트 + [End] 마커 (proxy/server.js 기존 처리와 동일)
  // + variety modifier — 호출마다 보컬/리듬 톤이 살짝 달라져 같은 장르라도 매번 색이 다른 곡.
  const SHORT_HINT = ', short song around 45 seconds, no long intro or outro, fade out at end';
  const variety = pickVarietyModifier();
  const finalStyle = /short|seconds|outro|fade/i.test(style || '') ? style : ((style || '') + SHORT_HINT + variety);
  const finalLyrics = /\[End\]\s*$/i.test((lyrics || '').trim()) ? lyrics : ((lyrics || '').trim() + '\n\n[End]');

  const r = await fetch(`${KIE_BASE}/api/v1/generate`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      prompt: finalLyrics, style: finalStyle, title,
      customMode: true, instrumental: false, model,
      callBackUrl: process.env.KIE_CALLBACK || 'https://example.com/no-callback',
    }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  if (!r.ok || (j.code && j.code !== 200)) {
    throw Object.assign(new Error('kie generate 실패: ' + r.status + ' ' + text.slice(0, 300)), { status: r.status });
  }
  const jobId = pick(j.data || j, 'taskId', 'task_id', 'id');
  if (!jobId) throw new Error('taskId 없음: ' + JSON.stringify(j).slice(0, 300));
  return { jobId };
}

// 상태 폴링(1회) → { status:'PENDING'|'COMPLETED'|'FAILED', audioUrl, audioId, timestampedLyrics? }
export async function songStatus(jobId, { apiKey = process.env.KIE_API_KEY, withTimestamps = true } = {}) {
  if (!apiKey) throw Object.assign(new Error('KIE_API_KEY 없음'), { status: 500 });
  const r = await fetch(`${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(jobId)}`, {
    headers: authHeaders(apiKey),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  const data = j.data || {};
  const raw = (pick(data, 'status') || '').toString().toUpperCase();
  if (/FAIL|ERROR/.test(raw)) return { status: 'FAILED', error: raw };

  const list = pick(data.response || {}, 'sunoData', 'data') || pick(data, 'sunoData') || [];
  const track = (Array.isArray(list) ? list : []).find((t) => pick(t, 'audioUrl', 'audio_url', 'streamAudioUrl', 'stream_audio_url'));
  if (!track) return { status: 'PENDING', raw };

  const audioId = pick(track, 'id', 'audioId', 'audio_id');
  const audioUrl = pick(track, 'audioUrl', 'audio_url', 'streamAudioUrl', 'stream_audio_url');
  const out = { status: 'COMPLETED', jobId, audioId, audioUrl };
  if (withTimestamps && audioId) {
    // 타임스탬프는 완성 직후 몇 초 뒤 준비됨 → 짧게 재시도. 그래도 없으면 곡만 완료(프론트 폴백).
    for (let attempt = 0; attempt < 4; attempt++) {
      try { out.timestampedLyrics = await getTimestampedLyrics(jobId, audioId, { apiKey }); break; }
      catch (e) { out.timestampError = e.message; if (attempt < 3) await new Promise((res) => setTimeout(res, 3000)); }
    }
  }
  return out;
}

// 단어별 타임스탬프 → { words:[{word,start,end,lead,br}], lines:[{text,start,end,words}], confidence }
export async function getTimestampedLyrics(jobId, audioId, { apiKey = process.env.KIE_API_KEY, musicIndex = 0 } = {}) {
  const r = await fetch(`${KIE_BASE}/api/v1/generate/get-timestamped-lyrics`, {
    method: 'POST', headers: authHeaders(apiKey),
    body: JSON.stringify({ taskId: jobId, audioId, musicIndex }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  if (!r.ok || (j.code && j.code !== 200)) throw new Error('timestamps 실패: ' + r.status + ' ' + text.slice(0, 200));
  const tdata = j.data || j;
  const aligned = pick(tdata, 'alignedWords', 'aligned_words', 'words') || [];
  const words = computeLeads(normalizeWords(aligned));
  return { words, lines: groupLines(words), confidence: pick(tdata, 'hootCer', 'confidence') };
}

// [Verse]/[Hook]/[End] 태그 제거(쪼개진 것 포함), 공백 트림, \n→br 보존
export function normalizeWords(aligned) {
  const out = [];
  let inTag = false;
  for (const t of aligned) {
    let visible = '';
    for (const ch of String(pick(t, 'word', 'text', 'w') || '')) {
      if (inTag) { if (ch === ']') inTag = false; continue; }
      if (ch === '[') { inTag = true; continue; }
      visible += ch;
    }
    const leadNL = (visible.match(/^[ \t]*\n+/) || [''])[0].split('\n').length - 1;
    const tailNL = (visible.match(/\n+[ \t]*$/) || [''])[0].split('\n').length - 1;
    const word = visible.replace(/\s+/g, ' ').trim();
    if (leadNL && out.length) out[out.length - 1].br = Math.max(out[out.length - 1].br || 0, leadNL);
    if (!word) { if (tailNL && out.length) out[out.length - 1].br = Math.max(out[out.length - 1].br || 0, tailNL); continue; }
    out.push({
      word,
      start: Number(pick(t, 'startS', 'start_s', 'start') || 0),
      end: Number(pick(t, 'endS', 'end_s', 'end') || 0),
      br: tailNL,
    });
  }
  return out;
}

// 적응형 선행값: 빽빽하면 더 일찍, 띄엄띄엄하면 onset 가깝게 (0.05~0.30s)
export function computeLeads(words) {
  for (let i = 0; i < words.length; i++) {
    const ioi = (i + 1 < words.length ? words[i + 1].start - words[i].start : 0.6);
    words[i].lead = Math.max(0.05, Math.min(0.30, 0.33 - 0.28 * ioi));
  }
  return words;
}

// 줄 묶기: br>0 기준(없으면 시간 간격 fallback)
export function groupLines(words) {
  const useBr = words.some((w) => w.br > 0);
  const L = []; let c = [];
  for (let i = 0; i < words.length; i++) {
    c.push(words[i]);
    const brk = useBr ? words[i].br > 0
      : (c.length >= 9 || (i + 1 < words.length ? words[i + 1].start - words[i].end : Infinity) > 0.7);
    if (brk) { L.push(c); c = []; }
  }
  if (c.length) L.push(c);
  return L.map((x) => ({ text: x.map((w) => w.word).join(' '), start: x[0].start, end: x[x.length - 1].end, words: x }));
}
