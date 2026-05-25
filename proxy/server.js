// 친놀송 프록시 (Node/Render 버전) v6.0
// Cloudflare Worker -> Node http 서버로 이전. 출구 IP가 미국(Render)이라 Claude/Gemini 차단 없음.
// 환경변수: ANTHROPIC_API_KEY, SOLAR_API_KEY, GEMINI_API_KEY, APIFRAME_API_KEY, PORTONE_V2_API_SECRET
import http from 'node:http';
import crypto from 'node:crypto';
import admin from 'firebase-admin';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, Authorization, X-Admin-Token',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json'
};

// ===== 크레딧 시스템 =====
const COST_PER_SONG = 10;   // 곡 1개 = 10포인트
const SIGNUP_BONUS = 20;    // 신규가입 보너스 = 20포인트(2곡)

// ===== 결제(충전) — 포트원 V2 =====
// 결제 금액(원)당 적립 크레딧. 클라가 보낸 금액이 아니라 포트원에서 조회한 실결제액으로만 매칭한다.
const CREDIT_PACKS = {
  990: 10,    // 1곡
  4900: 60,   // 6곡 (할인)
  9900: 150,  // 15곡 (할인)
};

// firebase-admin 초기화 (FIREBASE_SERVICE_ACCOUNT 없으면 레거시 모드)
let CREDITS_ENABLED = false;
let fdb = null;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svc) {
    const cred = JSON.parse(svc);
    if (cred.private_key && cred.private_key.includes('\\n')) {
      cred.private_key = cred.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    fdb = admin.firestore();
    CREDITS_ENABLED = true;
    console.log('✅ 크레딧 시스템 활성화 (firebase-admin)');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT 미설정 — 크레딧 비활성(레거시 무제한 모드)');
  }
} catch (e) {
  console.error('❌ firebase-admin 초기화 실패 — 레거시 모드로 동작:', e.message);
}

// Authorization: Bearer <idToken> 검증 → uid 반환 (실패시 null)
async function verifyAuth(req) {
  if (!CREDITS_ENABLED) return null;
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    return decoded.uid;
  } catch (e) {
    return null;
  }
}

// 위와 동일하나 email까지 반환 ({ uid, email } | null)
async function verifyAuthFull(req) {
  if (!CREDITS_ENABLED) return null;
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    return { uid: decoded.uid, email: decoded.email || null };
  } catch (e) {
    return null;
  }
}

// 유저 문서를 무료/충전 풀로 정규화 (구버전 단일 credits 문서 호환)
// 반환: { free, paid, freeGranted, paidGranted } — credits = free + paid 가 항상 유지됨.
function splitPools(data) {
  const d = data || {};
  const credits = (typeof d.credits === 'number') ? d.credits : 0;
  let free = (typeof d.freeCredits === 'number') ? d.freeCredits : undefined;
  let paid = (typeof d.paidCredits === 'number') ? d.paidCredits : undefined;
  if (free === undefined && paid === undefined) {
    // 레거시 문서: 분리 필드가 없으면 기존 잔액을 전부 무료로 간주
    free = credits; paid = 0;
  } else {
    free = free || 0; paid = paid || 0;
  }
  const freeGranted = (typeof d.freeGranted === 'number') ? d.freeGranted : free;
  const paidGranted = (typeof d.paidGranted === 'number') ? d.paidGranted : paid;
  return { free, paid, freeGranted, paidGranted };
}

// 풀 값으로 저장할 문서 patch 생성 (credits = free + paid 동기화)
function poolPatch(p, extra) {
  return {
    credits: p.free + p.paid,
    freeCredits: p.free,
    paidCredits: p.paid,
    freeGranted: p.freeGranted,
    paidGranted: p.paidGranted,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(extra || {})
  };
}

// 유저 문서 조회 (없으면 신규 보너스 지급하며 생성)
async function getOrCreateUser(uid, email) {
  const ref = fdb.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const p = { free: SIGNUP_BONUS, paid: 0, freeGranted: SIGNUP_BONUS, paidGranted: 0 };
    await ref.set(poolPatch(p, {
      email: email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
    return { credits: SIGNUP_BONUS, ...p };
  }
  const p = splitPools(snap.data());
  // 분리 필드/이메일 백필 (구버전 문서 보정)
  const patch = {};
  if (typeof snap.data().freeCredits !== 'number' || typeof snap.data().paidCredits !== 'number') {
    Object.assign(patch, poolPatch(p));
  }
  if (email && snap.data().email !== email) patch.email = email;
  if (Object.keys(patch).length) { try { await ref.set(patch, { merge: true }); } catch (e) {} }
  return { credits: p.free + p.paid, ...p };
}

// 트랜잭션으로 크레딧 차감 — 무료 먼저, 부족분은 충전에서 ({ ok, credits })
async function chargeCredits(uid, amount) {
  const ref = fdb.collection('users').doc(uid);
  return fdb.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const p = snap.exists
      ? splitPools(snap.data())
      : { free: SIGNUP_BONUS, paid: 0, freeGranted: SIGNUP_BONUS, paidGranted: 0 };
    const total = p.free + p.paid;
    if (total < amount) return { ok: false, credits: total };
    const takeFree = Math.min(p.free, amount);
    p.free -= takeFree;
    p.paid -= (amount - takeFree);
    t.set(ref, poolPatch(p), { merge: true });
    return { ok: true, credits: p.free + p.paid };
  });
}

// 크레딧 환불 — 차감 역순(충전 풀부터 복원, 나머지는 무료로)
async function refundCredits(uid, amount) {
  const ref = fdb.collection('users').doc(uid);
  try {
    await fdb.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return;
      const p = splitPools(snap.data());
      const restorePaid = Math.min(amount, Math.max(0, p.paidGranted - p.paid));
      p.paid += restorePaid;
      p.free += (amount - restorePaid);
      t.set(ref, poolPatch(p), { merge: true });
    });
  } catch (e) { console.warn('refund fail', e.message); }
}

// 관리자 크레딧 증정 — 무료 풀에 적립. 감사 로그도 기록. ({ credits, free, paid })
async function grantCredits(uid, amount, adminUser) {
  const ref = fdb.collection('users').doc(uid);
  const result = await fdb.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const p = snap.exists
      ? splitPools(snap.data())
      : { free: SIGNUP_BONUS, paid: 0, freeGranted: SIGNUP_BONUS, paidGranted: 0 };
    p.free += amount;
    p.freeGranted += amount;
    const extra = snap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() };
    t.set(ref, poolPatch(p, extra), { merge: true });
    return { credits: p.free + p.paid, free: p.free, paid: p.paid };
  });
  try {
    await fdb.collection('creditGrants').add({
      uid, amount, type: 'free', by: adminUser || 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.warn('grant log fail', e.message); }
  return result;
}

// ===== 관리자 인증 =====
// admin/config 문서: { username, salt, hash, updatedAt }
// 비밀번호는 scrypt 해시로만 저장(평문 저장/코드 하드코딩 없음).
const ADMIN_DOC = () => fdb.collection('admin').doc('config');
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12시간

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function timingEqualHex(a, b) {
  try {
    const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// 관리자 문서 조회. 없으면 환경변수(ADMIN_USERNAME/ADMIN_INITIAL_PASSWORD)로 1회 시드.
async function getAdminConfig() {
  const snap = await ADMIN_DOC().get();
  if (snap.exists) return snap.data();
  const u = process.env.ADMIN_USERNAME, p = process.env.ADMIN_INITIAL_PASSWORD;
  if (!u || !p) return null; // 시드 정보 없음 → 로그인 불가(설정 필요)
  const salt = makeSalt();
  const cfg = { username: String(u), salt, hash: hashPassword(p, salt), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await ADMIN_DOC().set(cfg, { merge: true });
  console.log('✅ 관리자 계정 시드 완료 (env ADMIN_USERNAME)');
  return cfg;
}

// 토큰 서명키 = 현재 비번 해시 기반 → 비번 변경 시 기존 토큰 자동 무효화
function adminSigningKey(cfg) {
  return crypto.createHash('sha256').update('admtok:' + (process.env.ADMIN_TOKEN_SECRET || '') + ':' + cfg.hash).digest();
}
function issueAdminToken(cfg) {
  const payload = Buffer.from(JSON.stringify({ u: cfg.username, exp: Date.now() + ADMIN_TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', adminSigningKey(cfg)).update(payload).digest('base64url');
  return payload + '.' + sig;
}
async function verifyAdmin(req) {
  if (!CREDITS_ENABLED) return false;
  const tok = req.headers['x-admin-token'] || req.headers['X-Admin-Token'] || '';
  if (!tok || tok.indexOf('.') < 0) return false;
  const cfg = await getAdminConfig();
  if (!cfg) return false;
  const [payload, sig] = tok.split('.');
  const expect = crypto.createHmac('sha256', adminSigningKey(cfg)).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!p.exp || Date.now() > p.exp) return false;
    return true;
  } catch { return false; }
}

// 포트원 V2에서 결제 단건 조회
async function lookupPortonePayment(paymentId) {
  const secret = process.env.PORTONE_V2_API_SECRET;
  if (!secret) return { ok: false, error: 'portone_not_configured' };
  try {
    const r = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'Authorization': `PortOne ${secret}` }
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `portone_http_${r.status}`, detail: text.slice(0, 200) };
    return { ok: true, payment: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: 'portone_unreachable', detail: e.message };
  }
}

// 결제 1건당 1회만 크레딧 적립 (중복 호출 방지). { credits, already }
async function creditPaymentOnce(uid, paymentId, credits, amount) {
  const pref = fdb.collection('payments').doc(paymentId);
  const uref = fdb.collection('users').doc(uid);
  return fdb.runTransaction(async (t) => {
    const psnap = await t.get(pref);   // 모든 read를 write보다 먼저
    const usnap = await t.get(uref);
    if (psnap.exists) {
      return { already: true, credits: (usnap.data() || {}).credits || 0 };
    }
    const p = usnap.exists
      ? splitPools(usnap.data())
      : { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
    p.paid += credits;
    p.paidGranted += credits;
    const next = p.free + p.paid;
    t.set(uref, poolPatch(p), { merge: true });
    t.set(pref, {
      uid, paymentId, amount, credits, status: 'completed',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { already: false, credits: next };
  });
}

// 작업(job) 기록 — 비동기 생성 실패 시 1회만 환불하기 위함
async function recordJob(jobId, uid, cost) {
  if (!fdb || !jobId) return;
  try {
    await fdb.collection('jobs').doc(String(jobId)).set({
      uid, cost, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.warn('recordJob fail', e.message); }
}

// 비동기 생성 실패 시 환불(중복 방지). 성공 시 done 마킹.
async function settleJob(jobId, outcome) {
  if (!fdb || !jobId) return;
  const ref = fdb.collection('jobs').doc(String(jobId));
  try {
    await fdb.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return;
      const j = snap.data();
      if (j.status !== 'pending') return; // 이미 정산됨
      if (outcome === 'failed') {
        const uref = fdb.collection('users').doc(j.uid);
        const usnap = await t.get(uref);
        const amount = j.cost || 0;
        const p = usnap.exists
          ? splitPools(usnap.data())
          : { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
        const restorePaid = Math.min(amount, Math.max(0, p.paidGranted - p.paid));
        p.paid += restorePaid;
        p.free += (amount - restorePaid);
        t.set(uref, poolPatch(p), { merge: true });
        t.update(ref, { status: 'refunded' });
      } else {
        t.update(ref, { status: 'done' });
      }
    });
  } catch (e) { console.warn('settleJob fail', e.message); }
}

function send(res, status, obj) {
  res.writeHead(status, CORS);
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

function buildPrompt(params) {
  const { name, relationship, keywords, genre, lang, gender, mustInclude } = params;
  const genderText = { male: '남자', female: '여자', pet: '반려동물' }[gender] || '미지정';
  const langText = { ko: '한글', en: '영어', mix: '섞기' }[lang] || '한글';
  const fixed = (mustInclude && mustInclude.trim()) ? mustInclude.trim() : '(없음)';
  const rel = (relationship && relationship.trim()) ? relationship.trim() : '친구';

  return `너는 최고의 작사가이고 사용자에 빙의한 작곡 작사가이다

이 가사의 목적은:
친구·지인·가족·반려동물을 웃기고 킹받게 놀리는 것이다.

핵심은:
- 실제 친구 놀리는 느낌
- 듣자마자 대상이 떠오르는 캐릭터성
- 약오르는데 웃긴 느낌
- 밈처럼 중독되는 Hook
- 자연스럽게 이어지는 상황극

이다.

--------------------------------------------------

가사에서 가장 중요한 것은:
1. 문장 간 자연스러운 연결
2. 하나의 상황(scene)이 이어지는 흐름
3. 키워드로 대상의 캐릭터를 살리는 것
4. 실제 친구를 놀리는 현실감
5. "킹받는 포인트"를 제대로 살리는 것

절대: 키워드 나열 / 설명문 / 의미없는 라임 / 뜬금없는 감정변화 / 맥락없는 영어 / 멋대로 만든 설정 추가 금지.

--------------------------------------------------

[대상 이름]
${name}

[성별]
${genderText}

[나와의 관계]
${rel}

[키워드]
${keywords}

[꼭 넣고 싶은 문장]
${fixed}

[가사 언어]
${langText}

[장르]
${genre}

--------------------------------------------------

관계에 맞는 말투로 작성:
- 친구→편하게 장난 / 형·오빠→친근하게 / 언니·누나→친밀한 장난 / 윗사람→무례하지 않게 장난 / 후배→귀엽게 / 반려동물→귀엽고 애정.
관계와 안 어울리는 말투 금지.

--------------------------------------------------

구성: Intro(2~4줄) / Verse(6~8줄) / Hook(4~6줄). 약 50초. 2절·브릿지·엔딩 금지. 틱톡/릴스서 반복재생될 중독성.

--------------------------------------------------

★ 가장 중요 ★ [키워드]는 대상의 약점·특징·습관·외모·행동·밈·놀림 포인트다.
"이 특징을 어떻게 놀리면 킹받을까"를 먼저 생각하고, 키워드를 행동·상황·장면·핀잔·과장으로 표현해라.
억지로 끼워넣지 말고, 키워드로 캐릭터를 살려라. 그대로 안 써도 됨(의미를 웃긴 표현으로 바꿔도 됨).
모든 키워드를 다 쓸 필요 없음 — 제일 놀리기 좋은 것 몇 개를 깊게 파라.
입력 안 된 새 설정(없는 외형·사실)은 절대 창작 금지. 과장은 OK, 새 사실 생성은 금지.

--------------------------------------------------

[꼭 넣고 싶은 문장]이 "(없음)"이 아니면 문장을 수정 말고 흐름 안에 자연스럽게 삽입. "(없음)"이면 무시.

--------------------------------------------------

언어: 한글=전체 한국어 / 영어=영어중심 / 섞기=한국어기본+영어는 포인트만(40% 초과 금지, 맥락없는 영어 금지).

--------------------------------------------------

친한 사이 장난 톤. 가벼운 표현(바보·멍청이·허당·덤벙이·장꾸) OK. 강한 욕설/혐오/비하(씨발·시발·병신·미친놈·미친년·개새끼·좆) 절대 금지. "약오르는데 웃긴 느낌" 유지.

--------------------------------------------------

맥락 유지: 각 줄이 이어져 하나의 장면. 뜬금/억지라임/설명체/키워드나열 금지.

★★ 절대 규칙 ★★
- 위 예시 단어(올챙이배·꼬집기·후드집업·솜뭉치·늦잠/커피·라면 등)는 작성법 예시일 뿐. [키워드]에 없으면 가사에 절대 쓰지 마라. 오직 [키워드] 소재만.
- Intro 1 / Verse 1 / Hook 1. 같은 섹션 반복 금지. 전체 12~18줄 이내.

설명 없이 아래 JSON만 응답:
{
  "title": "짧고 웃긴 노래 제목",
  "style": "Suno AI 스타일 영어 설명 (예: playful korean hiphop, funny kpop chant)",
  "lyrics": "[Intro]\\n...\\n\\n[Verse]\\n...\\n\\n[Hook]\\n..."
}`;
}

function maskProfanity(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/[씨시ㅆ][\s\-_.0-9]*[발팔밤]/g, '삐-');
  out = out.replace(/[좆좇][\s\-_.]*같?/g, '삐-');
  const words = ['존나', '존내', '개새끼', '개새기', '병신', '븅신', '지랄', '니미', 'ㅅㅂ', 'ㅈㄴ', 'ㅄ', 'ㅂㅅ', 'fuck', 'shit'];
  for (const w of words) out = out.split(w).join('삐-');
  return out;
}
function maskResult(data) {
  if (data && typeof data === 'object') {
    if (data.lyrics) data.lyrics = maskProfanity(data.lyrics);
    if (data.title) data.title = maskProfanity(data.title);
  }
  return data;
}
function extractLyricsJson(text) {
  if (!text) return null;
  let t = text.replace(/```json|```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  try { const p = JSON.parse(t); if (p.lyrics && p.title) return p; } catch {}
  return null;
}

async function tryClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { success: false, error: 'no_key' };
  const models = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  const errors = [];
  for (const model of models) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
      });
      if (r.ok) {
        const d = await r.json();
        const text = (d.content || []).map(b => b.text || '').join('');
        const p = extractLyricsJson(text);
        if (p) return { success: true, data: p };
        errors.push(`${model}: 200 bad JSON`); break;
      }
      const e = await r.text();
      errors.push(`${model}: HTTP ${r.status} ${e.slice(0, 120)}`);
      if (r.status === 404) continue;
      break;
    } catch (e) { errors.push(`${model}: ${e.message}`); }
  }
  return { success: false, error: errors.join(' | ') };
}

async function trySolar(prompt) {
  const key = process.env.SOLAR_API_KEY;
  if (!key) return { success: false, error: 'no_key' };
  const models = ['solar-pro3', 'solar-pro2'];
  const errors = [];
  for (const model of models) {
    let me = '';
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch('https://api.upstage.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
        });
        if (r.ok) {
          const d = await r.json();
          const p = extractLyricsJson(d.choices?.[0]?.message?.content || '');
          if (p) return { success: true, data: p };
          me = `${model}: 200 bad JSON`; break;
        }
        const e = await r.text();
        me = `${model}: HTTP ${r.status} ${e.slice(0, 150)}`;
        if (r.status === 429 || r.status === 503) { await new Promise(z => setTimeout(z, (a + 1) * 1000)); continue; }
        break;
      } catch (e) { me = `${model}: ${e.message}`; }
    }
    errors.push(me);
  }
  return { success: false, error: errors.join(' | ') };
}

async function tryGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { success: false, error: 'no_key' };
  const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  const errors = [];
  for (const model of models) {
    let me = '';
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1.0, maxOutputTokens: 1500, responseMimeType: 'application/json' } })
        });
        if (r.ok) {
          const d = await r.json();
          const text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          const p = extractLyricsJson(text);
          if (p) return { success: true, data: p };
          me = `${model}: 200 bad JSON`; break;
        }
        const e = await r.text();
        me = `${model}: HTTP ${r.status} ${e.slice(0, 100)}`;
        if (r.status === 503 || r.status === 429) { await new Promise(z => setTimeout(z, (a + 1) * 1000)); continue; }
        break;
      } catch (e) { me = `${model}: ${e.message}`; }
    }
    errors.push(me);
  }
  return { success: false, error: errors.join(' | ') };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (path === '/' || path === '/health') {
    return send(res, 200, {
      status: 'OK', service: 'chinolsong-proxy-node', version: '9.0',
      providers: ['claude', 'solar', 'gemini'],
      has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
      has_solar_key: !!process.env.SOLAR_API_KEY,
      has_gemini_key: !!process.env.GEMINI_API_KEY,
      has_apiframe_key: !!process.env.APIFRAME_API_KEY,
      has_portone_secret: !!process.env.PORTONE_V2_API_SECRET,
      credits_enabled: CREDITS_ENABLED,
      payments_enabled: CREDITS_ENABLED && !!process.env.PORTONE_V2_API_SECRET,
      admin_enabled: CREDITS_ENABLED,
      cost_per_song: COST_PER_SONG,
      signup_bonus: SIGNUP_BONUS
    });
  }

  // 내 크레딧 조회 (없으면 신규 보너스 지급)
  if (path === '/me') {
    if (!CREDITS_ENABLED) return send(res, 200, { enabled: false, credits: null, cost: COST_PER_SONG });
    const a = await verifyAuthFull(req);
    if (!a) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    const u = await getOrCreateUser(a.uid, a.email);
    return send(res, 200, {
      enabled: true, credits: u.credits || 0, cost: COST_PER_SONG,
      freeCredits: u.free || 0, paidCredits: u.paid || 0
    });
  }

  // 충전 상품 목록 (금액→크레딧). 프론트가 표시/결제요청에 사용.
  if (path === '/packs') {
    const packs = Object.entries(CREDIT_PACKS)
      .map(([amount, credits]) => ({ amount: Number(amount), credits, songs: Math.floor(credits / COST_PER_SONG) }))
      .sort((a, b) => a.amount - b.amount);
    return send(res, 200, { enabled: CREDITS_ENABLED && !!process.env.PORTONE_V2_API_SECRET, packs, cost: COST_PER_SONG });
  }

  // ===== 관리자 API =====
  // 관리자 로그인. body: { username, password } → { ok, token, expiresIn }
  if (path === '/admin/login' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 400, { error: 'admin_disabled', message: '서버에 Firebase 설정이 없어 관리자 기능이 비활성화 상태예요' });
    const { username, password } = await readBody(req);
    if (!username || !password) return send(res, 400, { error: 'missing_fields', message: '아이디와 비밀번호를 입력하세요' });
    const cfg = await getAdminConfig();
    if (!cfg) return send(res, 503, { error: 'not_provisioned', message: '관리자 계정이 아직 설정되지 않았어요 (ADMIN_USERNAME / ADMIN_INITIAL_PASSWORD 환경변수 필요)' });
    const okUser = (String(username) === cfg.username);
    const okPass = timingEqualHex(hashPassword(password, cfg.salt), cfg.hash);
    if (!okUser || !okPass) return send(res, 401, { error: 'bad_credentials', message: '아이디 또는 비밀번호가 올바르지 않아요' });
    return send(res, 200, { ok: true, token: issueAdminToken(cfg), expiresIn: ADMIN_TOKEN_TTL_MS, username: cfg.username });
  }

  // 회원 목록 + 크레딧 내역. (관리자 토큰 필요)
  if (path === '/admin/users') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    // Firebase Auth의 모든 가입자(구글 계정)를 기준으로, Firestore 크레딧 문서를 병합한다.
    const users = [];
    let pageToken = undefined;
    try {
      do {
        const list = await admin.auth().listUsers(1000, pageToken);
        for (const ur of list.users) {
          users.push({ uid: ur.uid, email: ur.email || null, signupAt: ur.metadata && ur.metadata.creationTime ? ur.metadata.creationTime : null });
        }
        pageToken = list.pageToken;
      } while (pageToken);
    } catch (e) {
      return send(res, 500, { error: 'list_failed', message: '회원 목록 조회 실패', detail: e.message });
    }
    // Firestore 크레딧 문서 병합 (개별 조회)
    const out = [];
    for (const u of users) {
      let p = { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
      let createdAt = null;
      try {
        const snap = await fdb.collection('users').doc(u.uid).get();
        if (snap.exists) {
          const d = snap.data();
          p = splitPools(d);
          if (d.createdAt && d.createdAt.toDate) createdAt = d.createdAt.toDate().toISOString();
        }
      } catch (e) {}
      out.push({
        uid: u.uid,
        email: u.email,
        signupAt: createdAt || u.signupAt,           // 가입 일자
        totalCredits: p.freeGranted + p.paidGranted, // 총 크레딧(누적 지급)
        availableCredits: p.free + p.paid,           // 가용 가능 크레딧(현재 잔액)
        freeCredits: p.free,                         // 무료 크레딧 보유
        paidGranted: p.paidGranted,                  // 충전 크레딧(총 충전)
        paidCredits: p.paid                          // 충전 크레딧 중 가용
      });
    }
    out.sort((a, b) => String(b.signupAt || '').localeCompare(String(a.signupAt || '')));
    return send(res, 200, { ok: true, count: out.length, cost: COST_PER_SONG, users: out });
  }

  // 회원에게 크레딧 증정(무료 풀). body: { uid, amount }  (관리자 토큰 필요)
  if (path === '/admin/grant' && req.method === 'POST') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const { uid, amount } = await readBody(req);
    const amt = Math.floor(Number(amount));
    if (!uid) return send(res, 400, { error: 'no_uid', message: '대상 회원이 없어요' });
    if (!Number.isFinite(amt) || amt <= 0) return send(res, 400, { error: 'bad_amount', message: '증정할 크레딧은 1 이상의 숫자여야 해요' });
    if (amt > 100000) return send(res, 400, { error: 'too_large', message: '한 번에 너무 큰 금액은 증정할 수 없어요' });
    try {
      const r = await grantCredits(String(uid), amt, 'admin');
      return send(res, 200, { ok: true, granted: amt, credits: r.credits, freeCredits: r.free, paidCredits: r.paid });
    } catch (e) {
      return send(res, 500, { error: 'grant_failed', message: '크레딧 증정 실패', detail: e.message });
    }
  }

  // 관리자 비밀번호 변경. body: { currentPassword, newPassword }  (관리자 토큰 필요)
  if (path === '/admin/change-password' && req.method === 'POST') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const { currentPassword, newPassword } = await readBody(req);
    if (!currentPassword || !newPassword) return send(res, 400, { error: 'missing_fields', message: '현재/새 비밀번호를 입력하세요' });
    if (String(newPassword).length < 8) return send(res, 400, { error: 'weak_password', message: '새 비밀번호는 8자 이상이어야 해요' });
    const cfg = await getAdminConfig();
    if (!cfg) return send(res, 503, { error: 'not_provisioned', message: '관리자 계정이 설정되지 않았어요' });
    if (!timingEqualHex(hashPassword(currentPassword, cfg.salt), cfg.hash)) {
      return send(res, 401, { error: 'bad_current', message: '현재 비밀번호가 올바르지 않아요' });
    }
    const salt = makeSalt();
    const next = { username: cfg.username, salt, hash: hashPassword(newPassword, salt), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    await ADMIN_DOC().set(next, { merge: true });
    // 비번이 바뀌면 서명키도 바뀌어 기존 토큰 무효 → 새 토큰 발급
    return send(res, 200, { ok: true, token: issueAdminToken(next), message: '비밀번호가 변경되었어요' });
  }

  // 결제 검증 + 크레딧 적립. body: { paymentId }
  if (path === '/verify-payment' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 400, { error: 'credits_disabled', message: '크레딧 시스템이 꺼져 있어요' });
    const uid = await verifyAuth(req);
    if (!uid) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });

    const { paymentId } = await readBody(req);
    if (!paymentId) return send(res, 400, { error: 'no_payment_id', message: '결제 정보가 없어요' });

    const v = await lookupPortonePayment(String(paymentId));
    if (!v.ok) return send(res, 502, { error: 'verify_failed', message: '결제 확인에 실패했어요', detail: v.error });

    const p = v.payment;
    if (p.status !== 'PAID') {
      return send(res, 402, { error: 'not_paid', message: '결제가 완료되지 않았어요', status: p.status });
    }

    // 결제 요청 때 심어둔 uid와 일치하는지 확인 (남의 결제 도용 차단)
    let ownerOk = true;
    try {
      const cd = p.customData ? JSON.parse(p.customData) : null;
      if (cd && cd.uid) ownerOk = (cd.uid === uid);
    } catch (e) {}
    if (!ownerOk) return send(res, 403, { error: 'owner_mismatch', message: '본인 결제가 아니에요' });

    const currency = p.currency || (p.amount && p.amount.currency);
    if (currency && currency !== 'KRW' && currency !== 'CURRENCY_KRW') {
      return send(res, 400, { error: 'bad_currency', message: '지원하지 않는 통화예요' });
    }

    const paidAmount = p.amount && (p.amount.total ?? p.amount.paid);
    const credits = CREDIT_PACKS[paidAmount];
    if (!credits) return send(res, 400, { error: 'unknown_amount', message: '알 수 없는 결제 금액이에요', amount: paidAmount });

    const result = await creditPaymentOnce(uid, String(paymentId), credits, paidAmount);
    return send(res, 200, {
      ok: true,
      credited: result.already ? 0 : credits,
      already: result.already,
      credits: result.credits,
      cost: COST_PER_SONG
    });
  }

  if (path === '/claude-test') {
    const key = process.env.ANTHROPIC_API_KEY;
    const out = { has_key: !!key, key_prefix: key ? key.slice(0, 14) : null };
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 30, messages: [{ role: 'user', content: 'ping' }] })
      });
      out.status = r.status;
      out.body = (await r.text()).slice(0, 300);
    } catch (e) { out.error = e.message; }
    return send(res, 200, out);
  }

  if (path === '/generate-lyrics' && req.method === 'POST') {
    // 크레딧 켜져 있으면: 로그인 필수 + 잔액 확인(차감은 곡 생성에서)
    if (CREDITS_ENABLED) {
      const uid = await verifyAuth(req);
      if (!uid) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
      const u = await getOrCreateUser(uid);
      if ((u.credits || 0) < COST_PER_SONG) {
        return send(res, 402, { error: 'insufficient_credits', message: '크레딧이 부족해요', credits: u.credits || 0, cost: COST_PER_SONG });
      }
    }
    const params = await readBody(req);
    if (!params.name || !params.keywords) return send(res, 400, { error: '필수 항목 누락' });
    const prompt = buildPrompt(params);

    let r = await tryClaude(prompt);
    if (r.success) { r.data._via = 'claude'; return send(res, 200, maskResult(r.data)); }
    const cErr = r.error;
    r = await trySolar(prompt);
    if (r.success) { r.data._via = 'solar'; return send(res, 200, maskResult(r.data)); }
    const sErr = r.error;
    r = await tryGemini(prompt);
    if (r.success) { r.data._via = 'gemini'; return send(res, 200, maskResult(r.data)); }
    return send(res, 503, { error: 'lyrics_failed', message: 'AI 서버가 지금 바빠요. 잠시 후 다시 시도해주세요.', debug: `claude[${cErr}] solar[${sErr}] gemini[${r.error}]` });
  }

  if (path === '/generate-song' && req.method === 'POST') {
    // 크레딧 켜져 있으면: 로그인 필수 + 트랜잭션 차감(실패 시 환불)
    let uid = null;
    if (CREDITS_ENABLED) {
      uid = await verifyAuth(req);
      if (!uid) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
      const charge = await chargeCredits(uid, COST_PER_SONG);
      if (!charge.ok) {
        return send(res, 402, { error: 'insufficient_credits', message: '크레딧이 부족해요', credits: charge.credits, cost: COST_PER_SONG });
      }
    }

    const { lyrics, title, style } = await readBody(req);
    if (!lyrics || !title || !style) {
      if (uid) await refundCredits(uid, COST_PER_SONG);
      return send(res, 400, { error: '필수 항목 누락' });
    }

    let r, text;
    try {
      r = await fetch('https://api.apiframe.ai/v2/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.APIFRAME_API_KEY },
        body: JSON.stringify({ model: 'suno', prompt: lyrics, sunoParams: { custom_mode: true, title, style, model_version: 'V5' } })
      });
      text = await r.text();
    } catch (e) {
      if (uid) await refundCredits(uid, COST_PER_SONG);
      return send(res, 502, { error: 'apiframe_unreachable', message: '노래 생성 서버 연결 실패' });
    }

    if (!r.ok) {
      // 제출 실패 → 즉시 환불
      if (uid) await refundCredits(uid, COST_PER_SONG);
      return send(res, r.status, text);
    }

    // 제출 성공 → jobId 기록(비동기 실패 시 1회 환불용)
    if (uid) {
      let jobId = null;
      try { const j = JSON.parse(text); jobId = j.jobId || j.job_id || j.id || (j.data && (j.data.jobId || j.data.job_id || j.data.id)); } catch (e) {}
      if (jobId) await recordJob(jobId, uid, COST_PER_SONG);
    }
    return send(res, r.status, text);
  }

  if (path.startsWith('/song-status/')) {
    const jobId = path.replace('/song-status/', '');
    const r = await fetch(`https://api.apiframe.ai/v2/jobs/${jobId}`, { headers: { 'X-API-Key': process.env.APIFRAME_API_KEY } });
    const text = await r.text();
    // 상태에 따라 job 정산(실패 시 환불, 성공 시 done) — CREDITS_ENABLED일 때만
    if (CREDITS_ENABLED && r.ok) {
      try {
        const d = JSON.parse(text);
        const st = (d.status || (d.data && d.data.status) || '').toUpperCase();
        if (st === 'FAILED' || st === 'ERROR') await settleJob(jobId, 'failed');
        else if (st === 'COMPLETED' || st === 'FINISHED' || st === 'SUCCESS') await settleJob(jobId, 'done');
      } catch (e) {}
    }
    return send(res, r.status, text);
  }

  return send(res, 404, { error: 'Invalid path' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('chinolsong-proxy listening on', PORT));
