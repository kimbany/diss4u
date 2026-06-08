'use strict';
/**
 * kie.ai 음악 생성 연동 모듈 (2단계) — 테스트 서버용.
 *
 * ⚠️ 운영 코드(proxy/server.js)와 분리된 독립 모듈입니다. 운영엔 영향 없음.
 *   목적: 운영의 /generate-song · /song-status 와 "같은 계약"을 kie.ai로 구현하되,
 *         kie가 주는 단어별 타임스탬프까지 응답에 실어 보낸다(가사 싱크용).
 *
 * 운영 프론트(index.html)와의 호환:
 *   - generateSong({lyrics,title,style}) → { jobId }
 *   - songStatus(jobId) → { status:'COMPLETED'|'PENDING'|'FAILED', audioUrl, ... ,
 *                           timestampedLyrics:{ words:[{word,start,end,lead,br}],
 *                                               lines:[{text,start,end,words}] } }
 *     프론트의 findAudioUrl 은 audioUrl 을 그대로 집어가고,
 *     새 비디오 렌더러는 timestampedLyrics 를 써서 단어 단위로 가사를 켠다.
 */

const KIE_BASE = process.env.KIE_BASE || 'https://api.kie.ai';

function pick(obj, ...keys) { for (const k of keys) if (obj && obj[k] != null) return obj[k]; return undefined; }

function authHeaders(apiKey) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
}

// ── 1) 곡 생성 요청 → taskId(=jobId) 반환 ────────────────────────────────────
async function generateSong({ lyrics, title, style, model = 'V5', apiKey = process.env.KIE_API_KEY }) {
  if (!apiKey) throw new Error('KIE_API_KEY 없음');
  // 운영과 동일한 "짧은 곡" 힌트 유지 (proxy/server.js 와 같은 처리)
  const SHORT_HINT = ', short song around 45 seconds, no long intro or outro, fade out at end';
  const finalStyle = /short|seconds|outro|fade/i.test(style) ? style : (style + SHORT_HINT);
  const finalLyrics = /\[End\]\s*$/i.test((lyrics || '').trim()) ? lyrics : ((lyrics || '').trim() + '\n\n[End]');

  const r = await fetch(`${KIE_BASE}/api/v1/generate`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      prompt: finalLyrics,
      style: finalStyle,
      title,
      customMode: true,
      instrumental: false,
      model,
      callBackUrl: process.env.KIE_CALLBACK || 'https://example.com/no-callback', // 폴링으로 받음
    }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  if (!r.ok || (j.code && j.code !== 200)) {
    const err = new Error('kie generate 실패: ' + r.status + ' ' + text.slice(0, 300));
    err.status = r.status; throw err;
  }
  const jobId = pick(j.data || j, 'taskId', 'task_id', 'id');
  if (!jobId) throw new Error('taskId 없음: ' + JSON.stringify(j).slice(0, 300));
  return { jobId };
}

// ── 2) 상태 폴링(1회) → 운영 프론트가 이해하는 형태로 매핑 ──────────────────
//   PENDING(미완) / COMPLETED(완성+오디오) / FAILED
async function songStatus(jobId, { apiKey = process.env.KIE_API_KEY, withTimestamps = true } = {}) {
  if (!apiKey) throw new Error('KIE_API_KEY 없음');
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
    try { out.timestampedLyrics = await getTimestampedLyrics(jobId, audioId, { apiKey }); }
    catch (e) { out.timestampError = e.message; }
  }
  return out;
}

// ── 3) 단어별 타임스탬프 받아 정규화 + 적응형 lead 계산 ───────────────────────
async function getTimestampedLyrics(jobId, audioId, { apiKey = process.env.KIE_API_KEY, musicIndex = 0 } = {}) {
  const r = await fetch(`${KIE_BASE}/api/v1/generate/get-timestamped-lyrics`, {
    method: 'POST',
    headers: authHeaders(apiKey),
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

// ── 가공 유틸 (검증 단계 kie-verify.js 와 동일 규칙) ─────────────────────────

// 토큰 정리: [Verse]/[Hook]/[End] 태그 제거(쪼개진 것 포함), 공백 트림, \n→br 보존
function normalizeWords(aligned) {
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

// 적응형 선행값: 단어가 빽빽하면 더 일찍, 띄엄띄엄하면 onset 가깝게(0.05~0.30s).
function computeLeads(words) {
  for (let i = 0; i < words.length; i++) {
    const ioi = (i + 1 < words.length ? words[i + 1].start - words[i].start : 0.6);
    words[i].lead = Math.max(0.05, Math.min(0.30, 0.33 - 0.28 * ioi));
  }
  return words;
}

// 줄 묶기: br>0 기준(없으면 시간 간격 fallback)
function groupLines(words) {
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

module.exports = { generateSong, songStatus, getTimestampedLyrics, normalizeWords, computeLeads, groupLines };
