// kie.ai 음악 생성 연동 모듈 (운영 프록시용, ESM)
// APIFRAME 대체: 곡 생성·폴링·단어별 타임스탬프. 결제/크레딧 로직은 server.js가 그대로 담당.
// 환경변수: KIE_API_KEY (필수), KIE_BASE(기본 https://api.kie.ai), KIE_CALLBACK(선택)

const KIE_BASE = process.env.KIE_BASE || 'https://api.kie.ai';

function pick(obj, ...keys) { for (const k of keys) if (obj && obj[k] != null) return obj[k]; return undefined; }
function authHeaders(apiKey) { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }; }

// 곡 생성마다 멜로디·리듬·보컬·후크 형태를 모두 랜덤으로 골라 같은 장르여도 매번 다른 곡이 나오게 한다.
// 같은 조합이 다시 나올 확률을 낮추기 위해 5개 축에서 각각 독립 랜덤 → 약 1만 가지 조합.
//
// ★ voice 옵션이 명시된 경우(robot/elder 등) variety의 VOCALS·MELODIC_FORCE를 빼고 호출한다.
//   안 그러면 'robotic vocal' 신호와 'energetic vocal performance' / 'fully sung melodic'이
//   동시에 Suno에 가서 충돌 → voice 선택이 무시되던 회귀가 있었음.
function pickVarietyModifier({ skipVocalConflict = false } = {}) {
  // 1) HOOK 멜로디 형태 — "입에 붙는 반복 후크"라는 강제 신호는 유지하되 표현을 매번 다르게.
  const HOOK_MELODY_VARIANTS = [
    'earworm catchy melodic hook, repetitive memorable chorus melody, looping singalong vocal motif',
    'sticky chant-like chorus hook, simple memorable refrain, addictive vocal phrase repeated multiple times',
    'meme-style sing-song hook, short looping vocal hook, easy-to-mimic chorus phrase',
    'rhythmic chant hook, punchy repeated catchphrase melody, group-singalong chorus',
    'percussive vocal hook with strong rhythm, repeated catchy syllables, viral-style refrain'
  ];
  // 2) 멜로디 컨투어 — 음의 진행 모양. 곡마다 멜로딕 캐릭터가 확 달라지는 핵심 축.
  const MELODIC_CONTOURS = [
    'melody with playful upward leaps and bouncy intervals',
    'descending stepwise melody with resigned funny tone',
    'melody centered around a single repeated note with rhythmic variations',
    'call-and-response melody with question-and-answer phrasing',
    'melody with surprise jumps between low growl and high screech notes',
    'pendulum melody swinging obsessively between two notes',
    'staircase melody climbing up then dramatically falling back',
    'chant-like flat melody with sudden punctuation notes',
    'wavy melody with playful slides and pitch bends'
  ];
  // 3) 리듬 필 — 박자 감각. 같은 BPM이어도 느낌이 달라짐.
  const RHYTHM_FEELS = [
    'with off-beat snare hits and syncopated groove',
    'with half-time groove that lands heavy',
    'with double-time fast rhythm and quick vocal flow',
    'in 6/8 swung shuffle feel',
    'with steady straight boom-bap rhythm',
    'with stuttered stop-and-go rhythm',
    'with marching beat and clappy snares',
    'with skippy bouncy two-step rhythm'
  ];
  // 4) 보컬 톤
  const VOCALS = [
    'energetic vocal performance', 'playful vocal delivery',
    'cheeky punchy vocals', 'sarcastic teasing vocals',
    'snappy rhythmic vocal flow', 'theatrical exaggerated vocals',
    'tight staccato vocal style', 'sing-song mocking delivery'
  ];
  // 5) 템포 톤
  const TEMPOS = [
    'punchy upbeat tempo', 'driving energetic rhythm',
    'bouncy snappy groove', 'tight rhythmic flow',
    'high-energy drum pattern', 'syncopated catchy beat'
  ];
  // 매번 강제: 말하는 듯한(스포큰/랩 위주) 톤이 아니라 멜로딕한 노래여야 한다.
  //   · 사용자 요청 — "말하는 듯한 느낌의 노래는 만들지 말고 최대한 멜로디가 다 있는 노래로"
  //   · 랩 장르여도 멜로딕 랩(챈트형 후크)으로 유도.
  //   · 후크의 키워드 음절을 멜로딕 모티프로 만들도록 추가 신호.
  const MELODIC_FORCE = 'fully sung melodic vocals with clear pitch and singable melody on every line, NOT spoken-word style, NOT rap-only delivery, even verses must have a clear sung melody, K-pop style chant-able syllabic hook (like Gee-gee-gee, Ring-ding-dong, Su-su-su-supernova), playful syllable repetition and vocalized fillers (la-la-la, di-gi-di-gi, dding-dding) as melodic ornamentation';
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  // skipVocalConflict=true 일 때 보컬·멜로딕 강제 신호 빼고 멜로디 형태/리듬/템포만 다양화.
  // (캐릭터 보이스 옵션과 충돌하지 않도록)
  if (skipVocalConflict) {
    return ', ' + pick(HOOK_MELODY_VARIANTS)
         + ', ' + pick(MELODIC_CONTOURS)
         + ', ' + pick(RHYTHM_FEELS)
         + ', ' + pick(TEMPOS);
  }
  return ', ' + MELODIC_FORCE
       + ', ' + pick(HOOK_MELODY_VARIANTS)
       + ', ' + pick(MELODIC_CONTOURS)
       + ', ' + pick(RHYTHM_FEELS)
       + ', ' + pick(VOCALS)
       + ', ' + pick(TEMPOS);
}

// 사용자가 UI "노래 부르는 목소리"에서 고른 voice를 Suno style에 명시적으로 박는다.
// (놀림 대상의 성별 'gender'와는 별개 — voice는 노래 부르는 가수의 보컬 성격)
//
// ★ Suno V5는 style 키워드만으로 vocal effect를 약하게 처리하는 경향이 있어서:
//   1) 키워드를 구체적 레퍼런스(Daft Punk/T-Pain 등)와 강제어(HEAVILY/NOT/MUST)로 강화.
//   2) 가사 안에도 효과 마커를 같이 박는다(아래 VOICE_LYRIC_MARKERS).
// random 또는 매핑 없는 값은 hint 안 박음 → variety 모디파이어가 다양성 제공.
const VOCAL_HINTS = {
  male:     'adult male solo vocal, masculine voice, single male singer',
  female:   'adult female solo vocal, feminine voice, single female singer',
  child:    'cute child-like vocal, playful innocent young child voice, high-pitched kid singer',
  group:    'group chorus vocals, 4 voices harmonizing together as a vocal group',
  duet:     'male and female duet, clear alternating call-and-response vocals between two distinct singers',
  husky:    'very husky low-pitched raspy vocal, smoky deep gravelly voice, gritty texture, NOT smooth or clean voice',
  hightone: 'extremely bright high-pitched soaring vocal, crystal clear soprano-like falsetto tone, NOT low or normal pitch',
  robot:    'HEAVILY auto-tuned robotic vocoder vocal throughout the entire song, metallic synthesized android voice with obvious pitch correction and talk-box effect, clearly artificial mechanical cyborg singing, NOT a natural human voice, electronic processed vocals must be obvious',
  elder:    'noticeably old elderly man voice, raspy weak aged trembling vocals with audible wobble and vibrato, grandfather-like wise warm gentle delivery, clearly an old man NOT a young adult'
};

// 가사 안에 보컬 효과 마커를 박는다. Suno V5는 가사 안의 [bracket vocal effect] 마커를
// style 키워드보다 더 강하게 따른다(사용자 보고: "오토튠 안 들린다" → style만으론 약함).
// male/female는 일반 솔로라 마커 없이도 OK → 매핑 안 함.
const VOICE_LYRIC_MARKERS = {
  child:    '[cute child-like high-pitched voice]',
  group:    '[group chorus harmonized vocals]',
  duet:     '[male and female duet alternating vocals]',
  husky:    '[husky deep raspy gravelly vocal]',
  hightone: '[bright high-pitched soaring falsetto vocal]',
  robot:    '[heavy auto-tune robotic vocoder vocal]',
  elder:    '[elderly raspy old man voice with vibrato]'
};

// 곡 생성 요청 → { jobId }
export async function generateSong({ lyrics, title, style, voice, model = 'V5', apiKey = process.env.KIE_API_KEY }) {
  if (!apiKey) throw Object.assign(new Error('KIE_API_KEY 없음'), { status: 500 });
  // 운영 힌트 (proxy/server.js 기존 처리와 동일).
  //  · 사용자 보고: 자체 인트로(보컬 없는 비트만 나오는 구간)가 20초+ 길어지는 회귀.
  //    → 'no long intro' 만으로는 부족. 'vocals start at 0:00 / no instrumental intro /
  //      no buildup' 같은 강한 신호 다중 박음.
  //  · variety modifier — 호출마다 보컬/리듬 톤이 살짝 달라져 같은 장르여도 매번 색이 다른 곡.
  const SHORT_HINT = ', short song around 45 seconds, vocals start at 0:00, no instrumental intro, no intro buildup, jump straight into the verse, no long outro, fade out at end';
  // ★ 장르 느낌 보존: style은 "장르 먼저", 목소리 힌트는 장르 뒤에 붙인다.
  //   Suno는 앞쪽 키워드를 더 강하게 반영하므로, 앞자리를 장르에 줘야 장르 특유의 색이 산다.
  //   (목소리 반영은 가사 안 [voice marker]가 더 강하게 담당하므로, 목소리를 뒤로 빼도 유지됨)
  const hasVoice = !!VOCAL_HINTS[voice];
  const variety = pickVarietyModifier({ skipVocalConflict: hasVoice });
  const vocalHint = hasVoice ? ', ' + VOCAL_HINTS[voice] : '';   // 장르 뒤에 붙임
  const baseStyle = style || '';
  const finalStyle = /short|seconds|outro|fade/i.test(baseStyle)
    ? (baseStyle + vocalHint)
    : (baseStyle + vocalHint + SHORT_HINT + variety);

  // 디버그 — voice 선택이 finalStyle/가사 마커에 잘 박혔는지 서버 로그에서 확인.
  console.log('[kie generateSong] voice=' + (voice || 'none')
    + ' / hasVoice=' + hasVoice
    + ' / lyricMarker=' + (VOICE_LYRIC_MARKERS[voice] || 'none')
    + ' / finalStyle head: ' + finalStyle.slice(0, 220));

  // 가사 안전망: LLM이 실수로 [Intro] 블록을 넣어도 통째로 제거 → Suno가 인트로 마커를 보고
  // 인트로를 만드는 경향을 차단. [End] 마커는 없으면 추가.
  let finalLyrics = (lyrics || '').trim();
  finalLyrics = finalLyrics.replace(/\[Intro\][\s\S]*?(?=\n\s*\[[^\]]+\]|$)/gi, '').trim();

  // 가사 안에 보컬 효과 마커 삽입 — Suno V5가 style 키워드만으로 약하게 처리하는 vocal effect를
  // 가사 안에 명시적으로 박아 강제. 첫 섹션 마커([Verse]/[Hook] 등) 바로 다음 줄에 삽입.
  const lyricMarker = VOICE_LYRIC_MARKERS[voice];
  if (lyricMarker) {
    finalLyrics = finalLyrics.replace(/^(\[[^\]]+\]\s*\n)/, '$1' + lyricMarker + '\n');
  }

  if (!/\[End\]\s*$/i.test(finalLyrics)) finalLyrics += '\n\n[End]';

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
