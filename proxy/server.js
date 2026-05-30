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
const COST_PER_SONG = 10;     // 곡 1개 = 10포인트
const SIGNUP_BONUS = 20;      // 신규가입 보너스 = 20포인트(2곡)
const REFERRAL_REWARD = 10;   // 추천 보상 = 10포인트(1곡). 피추천인이 첫 곡을 만들면 추천인에게 지급
const REFERRAL_MAX = 100;     // 추천 보상 누적 상한(어뷰징 방지)
const SHARE_REWARD = 2;       // 인스타 등 공유 보상 = 2포인트. 곡 1개당 1회만 지급(어뷰징 방지)

// 추천 코드 생성 (혼동되는 0/O/1/I 제외 8자리)
function genRefCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ===== 결제(충전) — 포트원 V2 =====
// 결제 금액(원)당 적립 크레딧. 클라가 보낸 금액이 아니라 포트원에서 조회한 실결제액으로만 매칭한다.
const CREDIT_PACKS = {
  1000: 10,   // 1곡
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

// 유저 문서 조회 (없으면 신규 보너스 지급하며 생성). 추천 코드도 함께 보장한다.
async function getOrCreateUser(uid, email) {
  const ref = fdb.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const refCode = genRefCode();
    const p = { free: SIGNUP_BONUS, paid: 0, freeGranted: SIGNUP_BONUS, paidGranted: 0 };
    await ref.set(poolPatch(p, {
      email: email || null,
      refCode,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
    await logCredit(uid, SIGNUP_BONUS, 'free', 'signup');
    return { credits: SIGNUP_BONUS, refCode, ...p };
  }
  const data = snap.data();
  const p = splitPools(data);
  // 분리 필드/이메일/추천코드 백필 (구버전 문서 보정)
  const patch = {};
  if (typeof data.freeCredits !== 'number' || typeof data.paidCredits !== 'number') {
    Object.assign(patch, poolPatch(p));
  }
  if (email && data.email !== email) patch.email = email;
  if (!data.refCode) patch.refCode = genRefCode();
  if (Object.keys(patch).length) { try { await ref.set(patch, { merge: true }); } catch (e) {} }
  return { ...data, ...p, credits: p.free + p.paid, refCode: data.refCode || patch.refCode || null };
}

// 크레딧 적립 내역(원장) 1건 기록. type: 'free' | 'paid', reason: signup|purchase|referral|share|admin
async function logCredit(uid, amount, type, reason) {
  if (!fdb || !uid || !amount) return;
  try {
    await fdb.collection('creditLog').add({
      uid, amount, type: type || 'free', reason: reason || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.warn('logCredit fail', e.message); }
}

// 곡 생성 성공 시: songsMade 증가 + (첫 곡 & 추천 귀속됐으면) 추천인 보상 지급(무료 풀)
async function onSongMade(uid) {
  if (!fdb || !uid) return;
  const uref = fdb.collection('users').doc(uid);
  let payTo = null;
  try {
    await fdb.runTransaction(async (t) => {
      const snap = await t.get(uref);
      const d = snap.exists ? snap.data() : {};
      const songsMade = d.songsMade || 0;
      const patch = { songsMade: songsMade + 1 };
      // 첫 곡이고, 추천인이 귀속돼 있고, 아직 보상 지급 전이면 추천인에게 보상 예약
      if (songsMade === 0 && d.referredBy && !d.referralRewarded) {
        patch.referralRewarded = true;
        payTo = d.referredBy;
      }
      t.set(uref, patch, { merge: true });
    });
    if (payTo && payTo !== uid) {
      const rref = fdb.collection('users').doc(payTo);
      const paid = await fdb.runTransaction(async (t) => {
        const rsnap = await t.get(rref);
        if (!rsnap.exists) return false;
        const rd = rsnap.data();
        const cnt = rd.referralCount || 0;
        if (cnt >= REFERRAL_MAX) return false; // 누적 상한 초과 시 보상 없음
        const p = splitPools(rd);
        p.free += REFERRAL_REWARD;
        p.freeGranted += REFERRAL_REWARD;
        t.set(rref, poolPatch(p, { referralCount: cnt + 1 }), { merge: true });
        return true;
      });
      if (paid) await logCredit(payTo, REFERRAL_REWARD, 'free', 'referral');
    }
  } catch (e) { console.warn('onSongMade fail', e.message); }
}

// 트랜잭션으로 크레딧 차감 — 무료 먼저, 부족분은 충전에서 ({ ok, credits })
async function chargeCredits(uid, amount) {
  const ref = fdb.collection('users').doc(uid);
  const result = await fdb.runTransaction(async (t) => {
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
  if (result.ok) await logCredit(uid, -amount, 'spend', 'song');  // 사용 내역 기록
  return result;
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
    await logCredit(uid, amount, 'refund', 'refund');  // 환불 내역 기록
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
  await logCredit(uid, amount, 'free', 'admin');
  return result;
}

// 회원 비활성화(탈퇴/차단): 같은 구글 계정으로 재로그인/재가입 불가. 남은 크레딧 소멸.
async function disableUserAccount(uid, opts) {
  const by = (opts && opts.by) || 'self';
  const ref = fdb.collection('users').doc(uid);
  let lost = 0;
  try {
    lost = await fdb.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const p = snap.exists ? splitPools(snap.data()) : { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
      const total = p.free + p.paid;
      p.free = 0; p.paid = 0;
      t.set(ref, poolPatch(p, {
        disabled: true,
        disabledAt: admin.firestore.FieldValue.serverTimestamp(),
        disabledBy: by
      }), { merge: true });
      return total;
    });
    if (lost > 0) await logCredit(uid, -lost, 'spend', 'withdrawal'); // 소멸 기록
  } catch (e) { console.warn('disable forfeit fail', e.message); }
  // Auth 계정 비활성화 + 기존 토큰 무효화 (재로그인 차단)
  await admin.auth().updateUser(uid, { disabled: true });
  try { await admin.auth().revokeRefreshTokens(uid); } catch (e) {}
  return { forfeited: lost };
}

// 회원 복구(잘못 차단 해제): 계정 재활성화. 소멸된 크레딧은 복원하지 않음.
async function restoreUserAccount(uid) {
  await admin.auth().updateUser(uid, { disabled: false });
  try {
    await fdb.collection('users').doc(uid).set({
      disabled: false,
      restoredAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) { console.warn('restore doc fail', e.message); }
  return { ok: true };
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

// 포트원 V2 결제 취소(환불). amount 생략 시 전액 취소.
async function cancelPortonePayment(paymentId, amount, reason) {
  const secret = process.env.PORTONE_V2_API_SECRET;
  if (!secret) return { ok: false, error: 'portone_not_configured' };
  const body = { reason: reason || '고객 환불 요청' };
  if (amount && amount > 0) body.amount = amount;
  try {
    const r = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `PortOne ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `portone_http_${r.status}`, detail: text.slice(0, 300) };
    return { ok: true, data: text ? JSON.parse(text) : {} };
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
  let refunded = null;  // { uid, amount } — 환불 발생 시
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
        refunded = { uid: j.uid, amount };
      } else {
        t.update(ref, { status: 'done' });
      }
    });
    if (refunded && refunded.amount) await logCredit(refunded.uid, refunded.amount, 'refund', 'refund');
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
  const { name, relationship, keywords, genre, lang, gender, mustInclude, useNameInLyrics } = params;
  const genderText = { male: '남자', female: '여자', pet: '반려동물' }[gender] || '미지정';
  const langText = { ko: '한글', en: '영어', mix: '섞기' }[lang] || '한글';
  const fixed = (mustInclude && mustInclude.trim()) ? mustInclude.trim() : '(없음)';
  const rel = (relationship && relationship.trim()) ? relationship.trim() : '친구';
  // useNameInLyrics가 false로 명시되면 이름은 제목에만 쓰고 가사 본문에는 절대 못 쓰게 함
  const nameRule = (useNameInLyrics === false)
    ? `\n\n[이름 사용 규칙]\n이름(${name})은 제목(title)에만 사용할 수 있고, 가사(lyrics) 본문에는 절대 쓰지 마라.\n가사에서는 "너", "쟤", "걔" 같은 지시어로만 가리켜라.\n`
    : '';

  return `너는 최고의 숏폼 작사가이고 사용자에 빙의한 작곡 작사가이다

이 가사의 목적은:
친구·지인·반려동물 등을 가볍게 놀리고, 약올리고, 킹받게 만드는 재미있는 노래를 만드는 것이다.

핵심은:

* 실제 친구를 놀리는 느낌
* 듣자마자 대상이 떠오르는 캐릭터성
* 약오르는데 웃긴 느낌
* 밈처럼 중독되는 Hook
* 자연스럽게 이어지는 상황극
* 너무 심하지 않고 귀엽게 킹받는 분위기
* 40~50초 안에 끝나는 짧은 숏폼 노래

이다.

---

가사에서 가장 중요한 것은:

1. 문장 간 자연스러운 연결
2. 하나의 상황(scene)이 이어지는 흐름
3. 키워드로 대상의 캐릭터를 살리는 것
4. 실제 친구를 놀리는 현실감
5. "킹받는 포인트"를 제대로 살리는 것
6. 짧고 강하게 끝나는 숏폼 구조

이다.

절대:

* 키워드 나열
* 설명문처럼 쓰기
* 의미 없는 라임
* 뜬금없는 감정 변화
* 맥락 없는 영어
* AI가 멋대로 만든 설정 추가
* 1분 이상으로 길어질 수 있는 긴 구성

을 하지 마라.

---

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
${nameRule}
---

[나와의 관계] 사용 규칙

[나와의 관계]는 가사에 직접 넣는 키워드가 아니다.

[나와의 관계]는 대상과의 거리감, 말투, 존댓말/반말, 놀림 수위, 친밀감, 표현 방식을 결정하기 위한 참고 정보다.

가사 안에 관계명을 억지로 넣지 마라.

예를 들어 [나와의 관계]가 "친구"라고 해서
"내 친구야" 같은 표현을 반드시 넣을 필요는 없다.

[나와의 관계]가 "오빠", "언니", "형", "누나", "선배", "후배", "반려동물"이어도
그 단어를 가사에 직접 넣는 것이 목적이 아니다.

관계 정보는 오직:

* 말투 선택
* 놀림 수위 조절
* 존댓말/반말 판단
* 친밀감 표현
* 무례함 방지
* 대상이 사람인지 반려동물인지 구분

을 위해 사용해라.

키워드와 꼭 넣고 싶은 문장만 가사의 핵심 소재로 사용하고,
관계 정보는 가사의 톤과 분위기를 조절하는 용도로만 사용해라.

---

가사는 대상과의 관계를 이해하고
그 관계에 맞는 말투와 분위기로 작성해라.

예시:

* 친구 → 편하고 장난스러운 느낌
* 형/오빠 → 친근하게 놀리는 느낌
* 언니/누나 → 친밀한 장난 느낌
* 선배/윗사람 → 너무 무례하지 않게 장난스럽게
* 후배 → 귀엽게 놀리는 느낌
* 반려동물 → 귀엽고 애정 표현 중심

관계와 어울리지 않는 말투는 사용하지 마라.

---

[제목 생성 규칙]

노래 제목은 친구를 놀리는 앱에 어울리게
짧고 웃기고 킹받게 작성해라.

제목은 단순히 키워드를 나열하는 것이 아니라,
대상의 특징을 한 번에 떠올릴 수 있는
"놀리는 별명" 또는 "킹받는 한마디"처럼 작성해라.

제목의 목표는:

* 듣자마자 웃긴 느낌
* 대상이 바로 떠오르는 느낌
* 친구들이 단톡방에서 놀릴 때 쓸 법한 느낌
* 숏폼에서 기억에 남는 느낌

이다.

제목은 2~8글자 정도로 짧게 작성하는 것을 우선한다.
길어도 12글자를 넘지 마라.

제목에 모든 키워드를 억지로 넣지 마라.
가장 웃긴 키워드 1~2개만 골라서 제목화해라.

제목은 아래 스타일 중 하나로 작성해라:

1. 별명형:
   대상의 특징을 별명처럼 만든 제목

2. 한마디형:
   친구가 약올리듯 던지는 말

3. 밈형:
   반복해서 부르고 싶은 짧은 제목

4. 반전형:
   말은 멀쩡한데 은근히 킹받는 제목

나쁜 제목 예시:

* "덤벙이 야근러 다이어터 힘순찐"
* "올챙이배 꼬집기 대마왕"
* "하얀개 귀여운 강아지 밥먹기"

왜 나쁜가:

* 키워드를 그대로 나열함
* 제목이 길고 재미없음
* 놀리는 포인트가 약함

좋은 제목 예시:

* "또 먹네"
* "김밥천국 VIP"
* "단추 비상"
* "옆구리 테러범"
* "하얀 솜뭉치"
* "내일부터 다이어트"
* "꼬집고 튀어"
* "지각 장인"
* "허당 모닝콜"
* "말만 관리 중"

제목은 공격적이면 안 된다.
강한 욕설, 혐오 표현, 인격 비하는 금지한다.

제목은 귀엽게 약오르고,
친구가 보면 “아 뭐야 ㅋㅋ” 할 정도로 작성해라.

---

[노래 길이 및 구조 규칙]

가사는 반드시 40~50초 안에 끝나는 짧은 숏폼 노래로 작성해라.

절대 1분 이상으로 길어질 수 있는 구조로 쓰지 마라.

인트로는 작성하지 마라.
아웃트로도 작성하지 마라.
2절, 브릿지, 긴 엔딩도 작성하지 마라.

구성은 아래 3개 파트만 사용해라.

* Verse
* Pre-Hook
* Hook

각 파트의 줄 수는 반드시 아래 제한을 지켜라.

[Verse]
4~6줄만 작성한다.
대상의 특징과 상황을 바로 보여준다.
처음부터 바로 놀림 포인트가 드러나야 한다.
키워드를 단순히 넣지 말고,
대상이 실제로 어떤 사람인지 장면으로 보여줘라.

[Pre-Hook]
2줄만 작성한다.
Hook으로 넘어가기 전에 놀림 포인트를 한 번 더 몰아간다.
“아 얘 진짜 이렇다니까?” 하는 느낌을 만든다.

[Hook]
4줄만 작성한다.
가장 킹받는 별명이나 문장을 짧고 중독성 있게 반복한다.
키워드를 그대로 반복하지 말고,
놀리는 별명, 반복되는 행동, 친구들이 맨날 하는 놀림 말투로 변형해라.

전체 가사는 최대 12줄을 넘지 마라.

각 줄은 짧게 작성해라.
한 줄은 12~18자 정도의 짧은 한국어 문장으로 작성하는 것을 우선한다.

너무 긴 문장, 설명이 많은 문장, 랩처럼 길게 늘어지는 문장은 금지한다.

Hook은 반복해도 되지만, 같은 문장을 과하게 반복하지 마라.
Hook은 반드시 4줄 안에서 끝내라.

전체 흐름은:
상황 제시 → 놀림 강화 → 짧고 중독성 있는 Hook

으로 끝나야 한다.

마지막 Hook의 마지막 줄이 자연스러운 마무리 역할을 해야 한다.

---

[짧은 가사 작성 규칙]

40~50초 노래를 위해 다음을 반드시 지켜라.

* 전체 10~12줄 이내
* Intro 금지
* Outro 금지
* Bridge 금지
* 2절 금지
* 긴 설명 금지
* 긴 문장 금지
* 같은 Hook 과도한 반복 금지
* 의미 없는 추임새로 길이 늘리기 금지

가사는 짧고 강하게 작성해라.
한 번 듣고 바로 기억나는 숏폼 밈송처럼 작성해라.

---

★ 가장 중요 ★

[키워드]는 단순 단어가 아니다.

키워드는 대상의:

* 약점
* 특징
* 습관
* 외모 포인트
* 행동 패턴
* 밈 요소
* 놀림 포인트
* 킹받는 요소

를 의미한다.

핵심은:
"이 특징을 어떻게 놀리면 킹받을까?"
를 생각하는 것이다.

---

키워드를 문장 안에 억지로 끼워넣지 마라.

대신:

* 왜 웃긴지
* 왜 놀림거리인지
* 친구들이 실제로 어떻게 놀릴지
* 어떻게 과장하면 킹받을지

를 먼저 생각한 뒤 가사를 작성해라.

---

각 키워드마다 이렇게 생각해라:

1. 이 특징의 뭐가 웃긴가?
2. 친구들이 실제로 어떻게 놀릴까?
3. 어떤 상황으로 과장하면 웃길까?
4. 어떤 핀잔을 주면 킹받을까?
5. 어떻게 말해야 놀림 느낌이 살아날까?

그 결과를 가사로 작성해라.

---

키워드는 반드시:

* 행동
* 상황
* 장면
* 핀잔
* 놀림
* 과장

형태로 표현해라.

핵심은:
"키워드를 포함하는 것"이 아니라
"키워드로 캐릭터를 살리는 것"이다.

---

키워드를 그대로 사용하지 않아도 된다.

키워드의 의미를 활용해서
더 자연스럽고 웃긴 표현으로 바꿔도 된다.

예시:

* "올챙이배"
  → "앉으면 배부터 책상 도착"
  → "후드집업 단추 또 위험해"
  → "배가 먼저 코너 돌더라"

* "꼬집기 대마왕"
  → "지나갈 때마다 옆구리 테러"
  → "또 꼬집고 혼자 도망감"
  → "손버릇 진짜 유치하다"

* "하얀개"
  → "솜뭉치처럼 굴러다님"
  → "흰 털 날려서 집 점령함"

---

절대 입력되지 않은 새로운 설정이나 특징을
임의로 추가하지 마라.

사용자가 제공한:

* 대상 이름
* 성별
* 관계
* 키워드
* 꼭 넣고 싶은 문장

안에서만 캐릭터를 구성해라.

키워드를 과장하거나 놀릴 수는 있지만,
없는 외형이나 설정을 새롭게 만들면 안 된다.

예:

* "하얀개"
  → 흰 털, 솜뭉치 느낌, 순둥한 느낌 표현 가능

하지만:

* "배만 새까맣다"
* "검은 얼룩이 있다"
* "눈이 빨갛다"
* "사고를 쳤다"
* "뚱뚱하다"
* "냄새난다"

처럼 입력되지 않은 특징은 추가 금지.

웃기기 위해 새로운 설정을 창작하지 마라.

핵심은:
"없는 설정 추가"가 아니라
"입력된 특징을 더 웃기고 킹받게 살리는 것"이다.

과장은 가능하지만,
새로운 사실 생성은 금지한다.

---

나쁜 예 (키워드 억지 삽입):

"아침부터 올챙이배 잡고
야 일어나 꼬집기 대마왕"

왜 나쁜가:

* 상황 연결 없음
* 실제 놀리는 느낌 없음
* 키워드만 기계적으로 넣음

---

좋은 예 (실제 놀리는 느낌):

"후드집업 맨날 배만 빵빵하고
앉자마자 단추 또 비명 지르네
옆 지나가면 또 사람 꼬집고
혼자 웃으면서 도망가기 바빠"

왜 좋은가:

* 캐릭터가 보임
* 행동이 상상됨
* 실제 친구 놀리는 느낌
* 장면이 이어짐
* 킹받는 포인트가 살아있음

---

가사는 설명문이 아니다.

친구들끼리 놀리는 상황극,
단톡방 놀림,
학교/회사에서 장난치는 느낌으로 작성해라.

듣는 사람이:
"아 저 사람 진짜 저럴 것 같아 ㅋㅋ"
라고 느껴야 한다.

---

모든 키워드를 억지로 다 사용하지 마라.

제일 놀리기 좋은 키워드 몇 개를 중심으로
깊고 웃기게 파는 게 더 중요하다.

단, 선택한 키워드는 반드시 맥락 안에서 자연스럽게 활용해라.

---

[꼭 넣고 싶은 문장]이 "(없음)"이 아니면:

* 문장을 절대 수정하지 마라
* 문장을 자연스럽게 가사 흐름 안에 삽입해라
* 앞뒤 문장과 연결되게 작성해라
* 전체 12줄 제한 안에서 자연스럽게 포함해라

"(없음)"이면 무시해라.

---

가사 언어 규칙:

* 한글:
  전체를 자연스러운 한국어로 작성

* 영어:
  전체를 영어 중심으로 작성

* 섞기:
  한국어를 기본으로 작성하고,
  영어는 포인트처럼만 사용해라.

영어 비중은 전체 가사의 40%를 넘지 마라.

절대 영어 위주의 가사가 되면 안 된다.

한국인이 실제 듣는 KPOP 느낌처럼
자연스럽게 섞어라.

맥락 없는 영어 문장 절대 금지.

---

가사는 친한 사이에서
장난스럽게 약올리는 분위기로 작성해라.

가벼운 장난 표현은 허용한다.

허용 예시:

* 바보
* 멍청이
* 허당
* 덤벙이
* 장꾸

하지만 아래 표현은 절대 금지:

* 씨발
* 시발
* 씨바
* 병신
* 미친놈
* 미친년
* 개새끼
* 좆

혐오 표현,
인격 비하,
과한 공격성,
기분 나쁜 조롱은 금지한다.

분위기는:
"약오르는데 웃긴 느낌"
을 유지해라.

---

핵심은 "맥락 유지"다.

각 줄은 이전 줄과 연결되어야 하며,
하나의 장면(scene)이 이어지는 느낌이어야 한다.

절대:

* 뜬금없는 표현
* 의미 없는 비유
* 갑작스러운 감정 변화
* 맥락 없는 영어
* 설명체 문장
* 키워드 나열
* 억지 라임

을 사용하지 마라.

---

좋은 예:

"맨날 늦잠 자더니 또 지각이야
커피 들고 뛰는 모습 뻔하잖아"

"후드집업 맨날 배만 빵빵하고
옆 지나가면 또 꼬집고 도망가"

---

나쁜 예:

"맨날 늦잠 자더니 또 지각이야
Moonlight dancing in my galaxy fire"

"올챙이배 꼬집기 대마왕
너는 나의 superstar"

---

[Hook 작성 규칙]

Hook에서도 키워드를 단순 반복하지 마라.

대신:

* 놀리는 별명
* 반복되는 행동
* 친구들이 맨날 하는 놀림 말투
* 대상이 들으면 킹받을 한마디

처럼 변형해서 사용해라.

Hook은 "키워드 반복"보다
"킹받는 별명화"가 더 중요하다.

Hook은 짧아야 한다.
Hook은 반드시 4줄 이내로 끝내라.

나쁜 Hook 예시:
"야근러 다이어터 힘순찐이
야근러 다이어터 힘순찐이
일하고 먹방하고 또 힘순찐이
야근러 다이어터 힘순찐이"

좋은 Hook 예시:
"말만 관리 중이야
또 야식 앞에 서 있네
내일부터 다이어터
오늘도 실패했네"

---

[style 작성 규칙]

style 필드는 Suno AI에 넘기는 **영어 음악 스타일** 설명이다.
반드시 아래 (1) + (2)를 모두 포함해서 작성하라.

(1) 공통 필수 키워드 — 어떤 장르든 항상 포함
* short 45-second song
* no intro, no outro, no bridge
* catchy hook
* playful comedy lyrics

(2) [장르]에 해당하는 음악 스타일 키워드 — 아래 매핑에서 [장르]에 맞는 줄 하나만 골라 그대로 사용

* 힙합 → korean hiphop, boom bap, punchy 808, hip hop hook, rhythmic flow
* 랩 → korean rap, fast aggressive flow, hard 808 beat, minimal melody, pure rap delivery
* 발라드 → korean ballad, slow tempo, piano, soft emotional vocal, mellow strings
* 트로트 → korean trot, accordion, ppongjjak rhythm, retro 80s vibe, bouncy bass
* K-pop → upbeat korean pop, bright synth, catchy melodic hook, polished kpop production
* 락 → korean rock, distorted electric guitar, energetic drum kit, punchy band sound
* 동요 → korean kids song, cute simple melody, glockenspiel, playful childlike vocal
* 로파이 → lofi hiphop, chill beat, mellow piano, vinyl crackle, dreamy
* 요들송 → alpine yodel, swiss folk, yodeling chorus, accordion, bavarian polka feel
* 쌈바 → brazilian samba, surdo drum, pandeiro, fast carnival groove, festive horns

[장르]가 위 매핑에 없으면 그 장르를 가장 잘 표현하는 영어 키워드 3~5개를 직접 골라 사용해라.

규칙:
* [장르]와 무관한 키워드를 절대 섞지 마라.
  예) [장르]=트로트인데 "kpop synth" 넣지 마라.
  예) [장르]=요들송인데 "808 beat" 넣지 마라.
* (1) 공통 키워드와 (2) 장르 키워드를 자연스럽게 한 문장으로 이어 써라.

예시:
* [장르]=트로트 → "short 45-second korean trot, accordion, ppongjjak rhythm, retro 80s vibe, bouncy bass, no intro, no outro, no bridge, catchy hook, playful comedy lyrics"
* [장르]=요들송 → "short 45-second alpine yodel, swiss folk, yodeling chorus, accordion, bavarian polka feel, no intro, no outro, no bridge, catchy hook, playful comedy lyrics"
* [장르]=쌈바 → "short 45-second brazilian samba, surdo drum, pandeiro, fast carnival groove, festive horns, no intro, no outro, no bridge, catchy hook, playful comedy lyrics"
* [장르]=랩 → "short 45-second korean rap, fast aggressive flow, hard 808 beat, minimal melody, pure rap delivery, no intro, no outro, no bridge, catchy hook, playful comedy lyrics"

---

[가사 톤 — 장르별 참고]

가사 내용·놀림 포인트는 똑같이 살리되, 장르에 따라 줄의 호흡과 추임새를 살짝 맞춰라.

* 힙합/랩 → 짧게 끊어치는 플로우, 라임 가볍게
* 발라드 → 줄을 부드럽게 흘리는 느낌
* 트로트 → "얼쑤", "지화자" 같은 추임새 1~2개 허용
* 동요 → 짧은 반복, 의성어/의태어 가능
* 로파이 → 잔잔하고 단조롭게, 한숨 같은 느낌
* 요들송 → "요들레이히후" 같은 추임새 1줄 허용
* 쌈바 → 흥겹게 외치는 느낌, "올레" 같은 추임새 가능
* 락 → 짧고 강하게 내지르는 느낌
* K-pop → 캐치한 멜로딕 라인, 영어 포인트 OK

추임새는 **1줄 이하**로 가볍게 쓰고, 가사 전체 흐름을 망치면 안 된다.

---

출력 규칙:

* 실제 노래 가사처럼 자연스럽게 작성
* 너무 시적이거나 난해하게 쓰지 마라
* 듣자마자 상황이 이해되게 작성해라
* 대상 캐릭터가 선명하게 떠오르게 작성해라
* Hook은 짧고 중독성 있게 작성해라
* 감정 흐름이 중간에 끊기지 않게 작성해라
* 키워드 삽입보다 캐릭터 표현을 우선시해라
* 전체 가사는 10~12줄 이내로 작성해라
* 설명 없이 JSON만 출력해라

---

아래 JSON 형식으로만 응답해라.
설명 문장은 절대 쓰지 마라.

{
"title": "2~8글자 중심의 짧고 킹받는 노래 제목. 키워드 나열 금지. 놀리는 별명이나 한마디처럼 작성",
"style": "short 45-second + (위 [style 작성 규칙]의 [장르] 매핑 키워드) + no intro, no outro, no bridge, catchy hook, playful comedy lyrics",
"lyrics": "[Verse]\n...\n...\n...\n...\n\n[Pre-Hook]\n...\n...\n\n[Hook]\n...\n...\n...\n..."
}
`;
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
      signup_bonus: SIGNUP_BONUS,
      referral_reward: REFERRAL_REWARD,
      share_reward: SHARE_REWARD
    });
  }

  // 카카오 로그인: { code, redirectUri } 또는 { accessToken } → Firebase Custom Token 발급
  // code면 REST API 키로 access token 교환 후, /v2/user/me 검증, uid="kakao_<id>" 로 토큰 발급.
  if (path === '/auth/kakao' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 400, { error: 'auth_disabled', message: '인증 시스템이 비활성 상태예요' });
    const body = await readBody(req);
    let accessToken = body.accessToken;

    // code → access_token 교환
    if (!accessToken && body.code) {
      const restKey = process.env.KAKAO_REST_API_KEY;
      if (!restKey) return send(res, 500, { error: 'kakao_not_configured', message: '서버에 KAKAO_REST_API_KEY가 설정되지 않았어요' });
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: restKey,
        redirect_uri: String(body.redirectUri || ''),
        code: String(body.code)
      });
      if (process.env.KAKAO_CLIENT_SECRET) form.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
      try {
        const tr = await fetch('https://kauth.kakao.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
          body: form.toString()
        });
        const tt = await tr.text();
        if (!tr.ok) return send(res, 401, { error: 'code_exchange_fail', message: '카카오 인증코드 교환 실패', detail: tt.slice(0, 300) });
        const tj = JSON.parse(tt);
        accessToken = tj.access_token;
      } catch (e) {
        return send(res, 502, { error: 'kakao_token_unreachable', message: '카카오 토큰 교환 서버 연결 실패', detail: e.message });
      }
    }

    if (!accessToken) return send(res, 400, { error: 'no_token', message: '카카오 액세스 토큰이 없어요' });
    let kakaoUser;
    try {
      const r = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { 'Authorization': 'Bearer ' + accessToken }
      });
      const text = await r.text();
      if (!r.ok) return send(res, 401, { error: 'kakao_verify_fail', message: '카카오 인증에 실패했어요', detail: text.slice(0, 200) });
      kakaoUser = JSON.parse(text);
    } catch (e) {
      return send(res, 502, { error: 'kakao_unreachable', message: '카카오 서버 연결 실패', detail: e.message });
    }
    const kakaoId = kakaoUser && kakaoUser.id;
    if (!kakaoId) return send(res, 401, { error: 'no_id', message: '카카오 사용자 식별 실패' });
    const acc = kakaoUser.kakao_account || {};
    const profile = acc.profile || {};
    const email = acc.email || null;
    const nickname = profile.nickname || null;
    const photo = profile.profile_image_url || profile.thumbnail_image_url || null;
    const uid = 'kakao_' + kakaoId;

    // Firebase 사용자 레코드에 email/displayName 반영(있을 때만). 충돌은 무시하고 진행.
    try {
      await admin.auth().updateUser(uid, {
        email: email || undefined,
        displayName: nickname || undefined,
        photoURL: photo || undefined,
        emailVerified: email ? true : undefined
      });
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        try {
          await admin.auth().createUser({
            uid, email: email || undefined, displayName: nickname || undefined,
            photoURL: photo || undefined, emailVerified: !!email
          });
        } catch (e2) { /* email 충돌 등 — 그래도 custom token은 발급 */ }
      }
    }

    try {
      const customToken = await admin.auth().createCustomToken(uid, { provider: 'kakao' });
      if (email) { try { await getOrCreateUser(uid, email); } catch (e) {} }
      return send(res, 200, { ok: true, token: customToken, uid, email, nickname });
    } catch (e) {
      return send(res, 500, { error: 'token_fail', message: '토큰 발급 실패', detail: e.message });
    }
  }

  // 내 크레딧 조회 (없으면 신규 보너스 지급). 추천 코드 / 광고 잔여 횟수도 함께 반환.
  if (path === '/me') {
    if (!CREDITS_ENABLED) return send(res, 200, { enabled: false, credits: null, cost: COST_PER_SONG });
    const a = await verifyAuthFull(req);
    if (!a) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    const u = await getOrCreateUser(a.uid, a.email);
    return send(res, 200, {
      enabled: true,
      credits: u.credits || 0,
      cost: COST_PER_SONG,
      freeCredits: u.free || 0,
      paidCredits: u.paid || 0,
      refCode: u.refCode || null,
      shareReward: SHARE_REWARD
    });
  }

  // 크레딧 적립 내역 + 현재 잔액(무료/유료). 날짜 내림차순.
  if (path === '/credit-history') {
    if (!CREDITS_ENABLED) return send(res, 200, { enabled: false, items: [] });
    const a = await verifyAuthFull(req);
    if (!a) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    const u = await getOrCreateUser(a.uid, a.email);
    let items = [];
    try {
      // 복합 색인 회피: uid 단일 조건으로 가져와 메모리에서 정렬
      const snap = await fdb.collection('creditLog').where('uid', '==', a.uid).limit(300).get();
      items = snap.docs.map(d => {
        const x = d.data();
        return {
          amount: x.amount || 0,
          type: x.type || 'free',
          reason: x.reason || null,
          at: (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate().toISOString() : null
        };
      });
    } catch (e) { console.warn('credit-history fail', e.message); }
    // 원장이 비어있는 기존 유저: 가입 보너스 1건만 합성해서 보여줌
    if (items.length === 0) {
      const at = (u.createdAt && u.createdAt.toDate) ? u.createdAt.toDate().toISOString() : null;
      items.push({ amount: SIGNUP_BONUS, type: 'free', reason: 'signup', at });
    }
    items.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
    return send(res, 200, {
      enabled: true,
      credits: u.credits || 0,
      freeCredits: u.free || 0,
      paidCredits: u.paid || 0,
      items
    });
  }

  // 추천 귀속: body { ref }. 신규(첫 곡 만들기 전) 유저만 1회 귀속. 보상은 첫 곡 생성 시 지급.
  if (path === '/claim-referral' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 200, { ok: false, reason: 'disabled' });
    const uid = await verifyAuth(req);
    if (!uid) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    const { ref } = await readBody(req);
    if (!ref || typeof ref !== 'string') return send(res, 200, { ok: false, reason: 'no_ref' });

    const uref = fdb.collection('users').doc(uid);
    const u = await getOrCreateUser(uid);
    // 이미 귀속됐거나 / 이미 곡을 만든 유저 / 본인 코드면 무시
    if (u.referredBy) return send(res, 200, { ok: false, reason: 'already' });
    if ((u.songsMade || 0) > 0) return send(res, 200, { ok: false, reason: 'not_new' });
    if (u.refCode === ref) return send(res, 200, { ok: false, reason: 'self' });

    const q = await fdb.collection('users').where('refCode', '==', ref).limit(1).get();
    if (q.empty) return send(res, 200, { ok: false, reason: 'invalid' });
    const referrerUid = q.docs[0].id;
    if (referrerUid === uid) return send(res, 200, { ok: false, reason: 'self' });

    await uref.set({ referredBy: referrerUid }, { merge: true });
    return send(res, 200, { ok: true });
  }

  // 공유 보상: 내가 만든 곡 1개당 1회만 +SHARE_REWARD(무료 풀). body { songId }
  // 곡 생성에 이미 COST_PER_SONG(10)를 썼으므로, 곡당 2p 환급은 farming으로 이득을 못 봄 → 어뷰징 안전.
  if (path === '/share-reward' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 400, { error: 'credits_disabled', message: '크레딧 시스템이 꺼져 있어요' });
    const uid = await verifyAuth(req);
    if (!uid) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    const { songId } = await readBody(req);
    if (!songId || typeof songId !== 'string') return send(res, 400, { error: 'no_song', message: '곡 정보가 없어요' });
    await getOrCreateUser(uid); // 문서/풀 보장

    const sref = fdb.collection('shareRewards').doc(songId);   // 곡당 1회 지급 마커
    const songRef = fdb.collection('songs').doc(songId);
    const uref = fdb.collection('users').doc(uid);
    try {
      const result = await fdb.runTransaction(async (t) => {
        const ssnap = await t.get(sref);       // 모든 read 먼저
        const songSnap = await t.get(songRef);
        const usnap = await t.get(uref);
        if (!songSnap.exists) return { ok: false, code: 404, reason: 'no_song', message: '곡을 찾을 수 없어요' };
        if ((songSnap.data() || {}).uid !== uid) return { ok: false, code: 403, reason: 'not_owner', message: '본인이 만든 곡만 보상받을 수 있어요' };
        const cur = usnap.exists ? splitPools(usnap.data()) : { free: SIGNUP_BONUS, paid: 0, freeGranted: SIGNUP_BONUS, paidGranted: 0 };
        if (ssnap.exists) return { ok: false, code: 200, reason: 'already', message: '이미 이 곡으로 보상받았어요', credits: cur.free + cur.paid };
        cur.free += SHARE_REWARD;
        cur.freeGranted += SHARE_REWARD;
        t.set(uref, poolPatch(cur), { merge: true });
        t.set(sref, { uid, songId, reward: SHARE_REWARD, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        return { ok: true, credits: cur.free + cur.paid, credited: SHARE_REWARD };
      });
      if (!result.ok) {
        return send(res, result.code || 400, { error: result.reason, message: result.message, credits: result.credits });
      }
      await logCredit(uid, SHARE_REWARD, 'free', 'share');
      return send(res, 200, { ok: true, credits: result.credits, credited: SHARE_REWARD });
    } catch (e) {
      return send(res, 500, { error: 'share_reward_fail', message: '잠시 후 다시 시도해주세요' });
    }
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
          users.push({ uid: ur.uid, email: ur.email || null, signupAt: ur.metadata && ur.metadata.creationTime ? ur.metadata.creationTime : null, disabled: !!ur.disabled });
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
        disabled: u.disabled,                        // 차단(탈퇴) 여부
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

  // [관리자] 특정 회원의 결제 내역 (uid 기준)
  if (path === '/admin/payments') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const uid = url.searchParams.get('uid');
    if (!uid) return send(res, 400, { error: 'no_uid', message: '회원 정보가 없어요' });
    const qs = await fdb.collection('payments').where('uid', '==', uid).get();
    const payments = qs.docs.map(d => {
      const x = d.data();
      return {
        paymentId: x.paymentId || d.id,
        amount: x.amount || 0,
        credits: x.credits || 0,
        status: x.status || 'completed',
        refundedAmount: x.refundedAmount || 0,
        refundedCredits: x.refundedCredits || 0,
        createdAt: (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate().toISOString() : null
      };
    });
    payments.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return send(res, 200, { ok: true, payments });
  }

  // [관리자] 날짜별 매출 (KST 기준). query: date=YYYY-MM-DD
  // [관리자] 매출 (KST 기준). query: date=YYYY-MM-DD (단일일) 또는 from=YYYY-MM-DD&to=YYYY-MM-DD (기간, 양끝 포함)
  if (path === '/admin/sales') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const singleDate = url.searchParams.get('date');
    let from = url.searchParams.get('from');
    let to = url.searchParams.get('to');
    if (singleDate) { from = to = singleDate; }
    if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
      return send(res, 400, { error: 'bad_date', message: '날짜 형식이 YYYY-MM-DD가 아니에요 (date 또는 from/to 필요)' });
    }
    if (from > to) { const t = from; from = to; to = t; } // 뒤집힘 보정
    const start = new Date(from + 'T00:00:00+09:00');
    const end = new Date(new Date(to + 'T00:00:00+09:00').getTime() + 24 * 60 * 60 * 1000);
    let rows = [];
    try {
      const qs = await fdb.collection('payments').where('createdAt', '>=', start).where('createdAt', '<', end).get();
      qs.forEach(d => {
        const x = d.data();
        rows.push({
          paymentId: x.paymentId || d.id,
          uid: x.uid || null,
          amount: x.amount || 0,
          credits: x.credits || 0,
          status: x.status || 'completed',
          refundedAmount: x.refundedAmount || 0,
          createdAt: (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate().toISOString() : null
        });
      });
    } catch (e) {
      return send(res, 500, { error: 'sales_fail', message: '매출 조회 실패', detail: e.message });
    }
    // uid → email 매핑 (Firestore users.email)
    const uids = [...new Set(rows.map(r => r.uid).filter(Boolean))];
    const emailMap = {};
    await Promise.all(uids.map(async u => {
      try {
        const s = await fdb.collection('users').doc(u).get();
        if (s.exists) emailMap[u] = s.data().email || null;
      } catch (e) {}
    }));
    rows = rows.map(r => ({ ...r, email: emailMap[r.uid] || null }))
               .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let gross = 0, refunded = 0;
    for (const r of rows) { gross += r.amount; refunded += r.refundedAmount || 0; }
    return send(res, 200, { ok: true, from, to, count: rows.length, gross, refunded, net: gross - refunded, payments: rows });
  }

  // [관리자] 자동 환불: 포트원 취소(부분/전액) + 유료 크레딧 차감 + 기록
  if (path === '/refund-payment' && req.method === 'POST') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const { paymentId, amount, reason } = await readBody(req);
    if (!paymentId) return send(res, 400, { error: 'no_payment_id', message: '결제 정보가 없어요' });

    const pref = fdb.collection('payments').doc(String(paymentId));
    const psnap = await pref.get();
    if (!psnap.exists) return send(res, 404, { error: 'payment_not_found', message: '결제 기록이 없어요' });
    const pd = psnap.data();
    const originalAmount = pd.amount || 0;
    const originalCredits = pd.credits || 0;
    const alreadyAmount = pd.refundedAmount || 0;
    const remaining = originalAmount - alreadyAmount;
    if (remaining <= 0) return send(res, 400, { error: 'already_refunded', message: '이미 전액 환불된 결제예요' });

    let refundAmount = (typeof amount === 'number' && amount > 0) ? Math.floor(amount) : remaining;
    if (refundAmount > remaining) {
      return send(res, 400, { error: 'amount_exceeds', message: `환불 가능액(${remaining}원)을 초과했어요`, remaining });
    }
    const creditsToDeduct = originalAmount > 0 ? Math.round(originalCredits * refundAmount / originalAmount) : 0;

    // 1) 포트원 취소 (외부 처리 먼저)
    const c = await cancelPortonePayment(String(paymentId), refundAmount, reason);
    if (!c.ok) return send(res, 502, { error: 'cancel_failed', message: '포트원 취소에 실패했어요', detail: c.error, raw: c.detail });

    // 2) 유료 풀에서 차감 + 환불내역 기록
    try {
      const result = await fdb.runTransaction(async (t) => {
        const uref = fdb.collection('users').doc(pd.uid);
        const us = await t.get(uref);
        const ps = await t.get(pref);
        const p = us.exists ? splitPools(us.data()) : { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
        const deducted = Math.min(creditsToDeduct, p.paid);
        p.paid -= deducted;
        p.paidGranted = Math.max(p.paid, p.paidGranted - deducted);
        const newRefundedAmount = (ps.data().refundedAmount || 0) + refundAmount;
        const newRefundedCredits = (ps.data().refundedCredits || 0) + deducted;
        t.set(uref, poolPatch(p), { merge: true });
        t.set(pref, {
          refundedAmount: newRefundedAmount,
          refundedCredits: newRefundedCredits,
          status: newRefundedAmount >= originalAmount ? 'refunded' : 'partial_refunded',
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
          refundReason: reason || ''
        }, { merge: true });
        return { credits: p.free + p.paid, deducted, fullyRefunded: newRefundedAmount >= originalAmount };
      });
      return send(res, 200, { ok: true, refundAmount, deductedCredits: result.deducted, credits: result.credits, fullyRefunded: result.fullyRefunded });
    } catch (e) {
      return send(res, 200, { ok: true, warning: '포트원 환불은 됐지만 크레딧 차감 기록에 실패했어요. Firebase에서 수동 확인이 필요해요.', refundAmount, detail: e.message });
    }
  }

  // [공개] 곡 신고 접수. body: { songId, reason }  (공유받은 누구나 신고 가능)
  if (path === '/report-song' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 400, { error: 'disabled', message: '잠시 후 다시 시도해주세요' });
    const { songId, reason } = await readBody(req);
    if (!songId || typeof songId !== 'string') return send(res, 400, { error: 'no_song', message: '곡 정보가 없어요' });
    const songRef = fdb.collection('songs').doc(songId);
    const snap = await songRef.get();
    if (!snap.exists) return send(res, 404, { error: 'no_song', message: '곡을 찾을 수 없어요' });
    const sd = snap.data();
    const reasonText = (typeof reason === 'string' ? reason : '').slice(0, 500);
    try {
      await fdb.collection('reports').add({
        songId, ownerUid: sd.uid || null, songTitle: sd.title || '',
        reason: reasonText, status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await songRef.set({
        reportCount: admin.firestore.FieldValue.increment(1),
        lastReportedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      return send(res, 500, { error: 'report_fail', message: '신고 접수에 실패했어요' });
    }
    return send(res, 200, { ok: true });
  }

  // 회원 탈퇴: 본인 계정/데이터 삭제(내가 만든 곡 + 유저 문서 + 인증 계정).
  // 결제 기록(payments)은 전자상거래법상 보존 의무가 있어 삭제하지 않는다.
  // 회원 탈퇴(본인). 계정 비활성화 → 같은 구글 계정 재가입 불가. 남은 크레딧 소멸.
  if (path === '/delete-account' && req.method === 'POST') {
    if (!CREDITS_ENABLED) return send(res, 400, { error: 'disabled', message: '잠시 후 다시 시도해주세요' });
    const uid = await verifyAuth(req);
    if (!uid) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    try {
      const r = await disableUserAccount(uid, { by: 'self' });
      return send(res, 200, { ok: true, forfeited: r.forfeited });
    } catch (e) {
      console.warn('withdraw fail', e.message);
      return send(res, 500, { error: 'delete_fail', message: '탈퇴 처리에 실패했어요. 잠시 후 다시 시도해주세요' });
    }
  }

  // [관리자] 회원 차단(탈퇴 처리). body: { uid }. 재가입 불가 + 남은 크레딧 소멸.
  if (path === '/admin/ban' && req.method === 'POST') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const { uid } = await readBody(req);
    if (!uid) return send(res, 400, { error: 'no_uid', message: '대상 회원이 없어요' });
    try {
      const r = await disableUserAccount(String(uid), { by: 'admin' });
      return send(res, 200, { ok: true, forfeited: r.forfeited });
    } catch (e) {
      return send(res, 500, { error: 'ban_failed', message: '회원 차단 처리 실패', detail: e.message });
    }
  }

  // [관리자] 회원 복구(차단 해제). body: { uid }. 계정 재활성화(크레딧은 복원하지 않음).
  if (path === '/admin/restore' && req.method === 'POST') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const { uid } = await readBody(req);
    if (!uid) return send(res, 400, { error: 'no_uid', message: '대상 회원이 없어요' });
    try {
      await restoreUserAccount(String(uid));
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { error: 'restore_failed', message: '회원 복구 처리 실패', detail: e.message });
    }
  }

  // [관리자] 특정 회원의 크레딧 내역(원장). query: uid
  if (path === '/admin/credit-history') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const uid = url.searchParams.get('uid');
    if (!uid) return send(res, 400, { error: 'no_uid', message: '대상 회원이 없어요' });
    let items = [];
    try {
      const snap = await fdb.collection('creditLog').where('uid', '==', uid).limit(300).get();
      items = snap.docs.map(d => {
        const x = d.data();
        return {
          amount: x.amount || 0,
          type: x.type || 'free',
          reason: x.reason || null,
          at: (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate().toISOString() : null
        };
      });
    } catch (e) { console.warn('admin credit-history fail', e.message); }
    items.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
    let credits = 0, free = 0, paid = 0;
    try {
      const usnap = await fdb.collection('users').doc(uid).get();
      if (usnap.exists) { const p = splitPools(usnap.data()); free = p.free; paid = p.paid; credits = p.free + p.paid; }
    } catch (e) {}
    return send(res, 200, { ok: true, credits, freeCredits: free, paidCredits: paid, items });
  }

  // [관리자] 특정 회원이 만든 곡 목록
  if (path === '/admin/songs') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const uid = url.searchParams.get('uid');
    if (!uid) return send(res, 400, { error: 'no_uid', message: '회원 정보가 없어요' });
    const qs = await fdb.collection('songs').where('uid', '==', uid).get();
    const songs = qs.docs.map(d => {
      const x = d.data();
      return {
        id: d.id, title: x.title || '', genre: x.genre || '', name: x.name || '',
        blocked: !!x.blocked, reportCount: x.reportCount || 0, hasAudio: !!x.audioUrl,
        createdAt: (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate().toISOString() : null
      };
    });
    songs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return send(res, 200, { ok: true, songs });
  }

  // [관리자] 대기중 신고 목록
  if (path === '/admin/reports') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const qs = await fdb.collection('reports').where('status', '==', 'pending').get();
    const reports = qs.docs.map(d => {
      const x = d.data();
      return {
        id: d.id, songId: x.songId, ownerUid: x.ownerUid || null,
        songTitle: x.songTitle || '', reason: x.reason || '',
        createdAt: (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate().toISOString() : null
      };
    });
    reports.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return send(res, 200, { ok: true, reports });
  }

  // [관리자] 곡 차단/해제. body: { songId, blocked }  (차단 시 해당 곡 대기 신고는 처리완료 처리)
  if (path === '/admin/block-song' && req.method === 'POST') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const { songId, blocked } = await readBody(req);
    if (!songId) return send(res, 400, { error: 'no_song', message: '곡 정보가 없어요' });
    const songRef = fdb.collection('songs').doc(String(songId));
    const snap = await songRef.get();
    if (!snap.exists) return send(res, 404, { error: 'no_song', message: '곡을 찾을 수 없어요' });
    await songRef.set({
      blocked: !!blocked,
      blockedAt: blocked ? admin.firestore.FieldValue.serverTimestamp() : null
    }, { merge: true });
    // 해당 곡의 대기중 신고를 처리완료로 마킹
    try {
      const rq = await fdb.collection('reports').where('songId', '==', String(songId)).get();
      const batch = fdb.batch();
      let n = 0;
      rq.docs.forEach(d => {
        if ((d.data().status || 'pending') === 'pending') {
          batch.update(d.ref, { status: 'resolved', resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
          n++;
        }
      });
      if (n) await batch.commit();
    } catch (e) {}
    return send(res, 200, { ok: true, blocked: !!blocked });
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
    // 페이팔 등은 즉시 승인되지 않고 '승인 대기' 상태가 있을 수 있다 → 적립 보류, 클라가 나중에 재확인
    if (p.status === 'PENDING' || p.status === 'READY' || p.status === 'PAY_PENDING') {
      return send(res, 202, { error: 'pending', message: '결제 승인 대기 중이에요. 승인되면 적립돼요.', status: p.status });
    }
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
    if (!result.already) await logCredit(uid, credits, 'paid', 'purchase');
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

    // 노래 길이 단축 힌트: Suno가 더 짧게 만들도록 style/lyrics에 보조 마커 추가
    const SHORT_HINT = ', short song around 45 seconds, no long intro or outro, fade out at end';
    const finalStyle = /short|seconds|outro|fade/i.test(style) ? style : (style + SHORT_HINT);
    const finalLyrics = /\[End\]\s*$/i.test(lyrics.trim()) ? lyrics : (lyrics.trim() + '\n\n[End]');

    let r, text;
    try {
      r = await fetch('https://api.apiframe.ai/v2/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.APIFRAME_API_KEY },
        body: JSON.stringify({ model: 'suno', prompt: finalLyrics, sunoParams: { custom_mode: true, title, style: finalStyle, model_version: 'V5' } })
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

    // 제출 성공 → jobId 기록(비동기 실패 시 1회 환불용) + 첫 곡이면 추천 보상 처리
    if (uid) {
      let jobId = null;
      try { const j = JSON.parse(text); jobId = j.jobId || j.job_id || j.id || (j.data && (j.data.jobId || j.data.job_id || j.data.id)); } catch (e) {}
      if (jobId) await recordJob(jobId, uid, COST_PER_SONG);
      await onSongMade(uid);
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
