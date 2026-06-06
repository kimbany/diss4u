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

// ===== 포인트(유료 충전) 유효기간 =====
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;   // 충전 포인트 유효기간 = 결제일로부터 1년
const EXPIRE_WARN_MS = 30 * 24 * 60 * 60 * 1000;  // 소멸 30일 전부터 안내

// 가장 최근 가사 생성 실패 원인 (관리자 진단용, /health에 노출)
let LAST_LYRICS_ERROR = null;

// 추천 코드 생성 (혼동되는 0/O/1/I 제외 8자리)
function genRefCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ===== 결제(충전) — 포트원 V2 =====
// 결제 금액(원)당 적립 크레딧. 클라가 보낸 금액이 아니라 포트원에서 조회한 실결제액으로만 매칭한다.
// 충전 패키지: { 결제금액(원): { credits: 총 적립p, base: 기본 곡 수, bonus: 보너스 곡 수 } }
const CREDIT_PACKS = {
  1000: { credits: 10,  base: 1,  bonus: 0 },   // 1곡
  4900: { credits: 60,  base: 5,  bonus: 1 },   // 5+1곡
  8900: { credits: 120, base: 10, bonus: 2 },   // 10+2곡
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

// ===== 유료 충전 포인트 lot(만료 추적) =====
// 충전 1건 = lot 1개: { credits(원래 충전량), remaining(남은량), at(충전ms), expireAt(만료ms), paymentId }
// users 문서의 paidLots 배열에 저장. paid 풀 합계 = 살아있는 lot들의 remaining 합과 일치하도록 유지한다.
function getPaidLots(data) {
  const arr = (data && Array.isArray(data.paidLots)) ? data.paidLots : [];
  return arr.map(l => ({
    credits: Number(l.credits) || 0,
    remaining: Number(l.remaining) || 0,
    at: Number(l.at) || 0,
    expireAt: Number(l.expireAt) || ((Number(l.at) || 0) + ONE_YEAR_MS),
    paymentId: l.paymentId || null
  }));
}

// 만료된 lot 제거 → 소멸 포인트량 반환. lots는 제자리 수정.
function expireLots(lots, nowMs) {
  let expired = 0;
  for (const l of lots) {
    if (l.remaining > 0 && l.expireAt <= nowMs) {
      expired += l.remaining;
      l.remaining = 0;
    }
  }
  return expired;
}

// lot 배열에서 살아있는(remaining>0) 것만, 만료 임박 순(빠른 것 먼저)으로 정렬해 반환
function liveLots(lots) {
  return lots.filter(l => l.remaining > 0).sort((a, b) => a.expireAt - b.expireAt);
}

// 환불 복원용: 아직 만료 안 됐고 일부 소진된 lot을 만료 임박 순으로
function liveLotsForRestore(lots) {
  const now = Date.now();
  return lots
    .filter(l => l.expireAt > now && l.remaining < l.credits)
    .sort((a, b) => a.expireAt - b.expireAt);
}

// paid 풀에서 amount만큼 차감 — 만료 임박 lot부터 소진. 실제 차감량 반환.
function consumeLots(lots, amount) {
  let need = amount;
  for (const l of liveLots(lots)) {
    if (need <= 0) break;
    const take = Math.min(l.remaining, need);
    l.remaining -= take;
    need -= take;
  }
  return amount - need;
}

// 만료 처리를 반영해 저장할 patch 일부. (p.paid는 lot remaining 합과 동기화)
function lotsPatch(lots) {
  // 빈(소진/만료된) lot은 버리되, 최근 기록은 유지하지 않아도 됨(creditLog에 남음)
  const kept = lots.filter(l => l.remaining > 0).map(l => ({
    credits: l.credits, remaining: l.remaining, at: l.at, expireAt: l.expireAt, paymentId: l.paymentId || null
  }));
  return { paidLots: kept };
}

// 유저 문서를 받아 만료 lot을 정리한 결과를 트랜잭션 안에서 적용.
// 반환: { p(풀), lots, expired }. 호출측이 t.set으로 저장해야 함.
function applyExpiry(data, nowMs) {
  const p = splitPools(data);
  const lots = getPaidLots(data);
  const expired = expireLots(lots, nowMs);
  if (expired > 0) {
    p.paid = Math.max(0, p.paid - expired);
  }
  // paid 풀과 lot 합계 정합성 보정 (구버전 문서: lot이 없는데 paid가 있으면 lot 하나로 마이그레이션)
  const liveSum = lots.reduce((s, l) => s + l.remaining, 0);
  if (lots.length === 0 && p.paid > 0) {
    // lot 정보가 없는 기존 충전분 → 만료일을 알 수 없으므로 '지금부터 1년'으로 부여(사용자에게 불리하지 않게)
    lots.push({ credits: p.paid, remaining: p.paid, at: nowMs, expireAt: nowMs + ONE_YEAR_MS, paymentId: null });
  } else if (liveSum !== p.paid) {
    // 불일치 시 lot 합계를 신뢰 (소멸/환불 등으로 어긋난 경우)
    p.paid = liveSum;
  }
  return { p, lots, expired };
}

// 접속 시 호출: 만료된 충전 포인트를 정리하고 결과를 저장. ({ expired, credits })
async function reconcileExpiry(uid) {
  if (!fdb || !uid) return { expired: 0 };
  const ref = fdb.collection('users').doc(uid);
  try {
    const out = await fdb.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { expired: 0, credits: 0 };
      const now = Date.now();
      const { p, lots, expired } = applyExpiry(snap.data(), now);
      if (expired > 0 || needsLotBackfill(snap.data(), lots)) {
        t.set(ref, poolPatch(p, lotsPatch(lots)), { merge: true });
      }
      return { expired, credits: p.free + p.paid };
    });
    if (out.expired > 0) await logCredit(uid, -out.expired, 'spend', 'expire');
    return out;
  } catch (e) { console.warn('reconcileExpiry fail', e.message); return { expired: 0 }; }
}

// 구버전 문서(lot 없음)인데 paid가 있어 백필이 필요한지
function needsLotBackfill(data, lotsAfter) {
  const had = (data && Array.isArray(data.paidLots)) ? data.paidLots.length : 0;
  return had === 0 && lotsAfter.length > 0;
}

// 30일 이내 소멸 예정 충전 포인트 안내. { amount, expireAt(ISO), days } | null
// 가장 먼저 만료될 lot 1건 기준으로 안내한다.
function upcomingExpiry(data, nowMs) {
  const lots = liveLots(getPaidLots(data));
  if (!lots.length) return null;
  const next = lots[0];   // 만료 임박 순 정렬되어 있음
  const remainMs = next.expireAt - nowMs;
  if (remainMs > EXPIRE_WARN_MS || remainMs < 0) return null;
  // 같은 날 만료되는 lot들 합산
  const sameDay = lots.filter(l => l.expireAt <= next.expireAt + 1000);
  const amount = sameDay.reduce((s, l) => s + l.remaining, 0);
  return {
    amount,
    expireAt: new Date(next.expireAt).toISOString(),
    days: Math.max(0, Math.ceil(remainMs / (24 * 60 * 60 * 1000)))
  };
}

// lot 목록을 사용자 표시용으로 변환 (충전 내역 + 소멸 예정일)
function paidLotsView(data, nowMs) {
  return liveLots(getPaidLots(data)).map(l => ({
    credits: l.credits,
    remaining: l.remaining,
    chargedAt: new Date(l.at).toISOString(),
    expireAt: new Date(l.expireAt).toISOString(),
    daysLeft: Math.max(0, Math.ceil((l.expireAt - nowMs) / (24 * 60 * 60 * 1000)))
  }));
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

// 사용자 화면에 '크레딧 받음' 미니 팝업을 띄우기 위한 마커.
// source: 'admin' | 'share' | 'purchase' | 'referral' (등). id로 중복 표시 방지.
async function markLastGrant(uid, amount, source, by) {
  if (!fdb || !uid || !amount) return;
  try {
    await fdb.collection('users').doc(uid).set({
      lastGrant: {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        amount,
        source: source || 'admin',
        by: by || null,
        at: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });
  } catch (e) { console.warn('lastGrant mark fail', e.message); }
}

// 충전 크레딧 소멸일(다음에 만료될 충전 건): 결제일 + 1년.
// FIFO로 가장 오래된 미소진 결제 건을 찾아 만료일을 산출.
// 입력: uid, 현재 paidCredits(잔액). 결과: ISO 문자열 또는 null.
const PAID_CREDIT_EXPIRY_DAYS = 365;
async function computeNextPaidExpiry(uid, paidBalance) {
  if (!fdb || !uid || !paidBalance || paidBalance <= 0) return null;
  try {
    const qs = await fdb.collection('payments').where('uid', '==', uid).get();
    const payments = qs.docs.map(d => {
      const x = d.data();
      const net = (Number(x.credits) || 0) - (Number(x.refundedCredits) || 0); // 환불분 제외 적립
      const ts = (x.createdAt && x.createdAt.toDate) ? x.createdAt.toDate() : null;
      const status = x.status || 'completed';
      return { net, at: ts, status };
    }).filter(p => p.at && p.net > 0 && p.status !== 'refunded');
    if (!payments.length) return null;
    payments.sort((a, b) => a.at - b.at);                  // 오래된 순
    const totalGranted = payments.reduce((s, p) => s + p.net, 0);
    let spent = Math.max(0, totalGranted - paidBalance);    // 이미 소진된 양
    for (const p of payments) {
      if (spent >= p.net) { spent -= p.net; continue; }     // 이 건은 이미 다 썼음
      const exp = new Date(p.at.getTime() + PAID_CREDIT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      return exp.toISOString();                              // 가장 먼저 만료될 건
    }
  } catch (e) { console.warn('computeNextPaidExpiry fail', e.message); }
  return null;
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
      if (paid) {
        await logCredit(payTo, REFERRAL_REWARD, 'free', 'referral');
        await markLastGrant(payTo, REFERRAL_REWARD, 'referral');
      }
    }
  } catch (e) { console.warn('onSongMade fail', e.message); }
}

// 트랜잭션으로 크레딧 차감 — 무료 먼저, 부족분은 충전에서 ({ ok, credits })
async function chargeCredits(uid, amount) {
  const ref = fdb.collection('users').doc(uid);
  const result = await fdb.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : { free: SIGNUP_BONUS, paid: 0, freeGranted: SIGNUP_BONUS, paidGranted: 0 };
    // 차감 전 만료분 정리
    const { p, lots } = applyExpiry(data, now);
    const total = p.free + p.paid;
    if (total < amount) {
      // 만료 정리 결과만이라도 저장
      t.set(ref, poolPatch(p, lotsPatch(lots)), { merge: true });
      return { ok: false, credits: total };
    }
    const takeFree = Math.min(p.free, amount);
    p.free -= takeFree;
    const takePaid = amount - takeFree;
    if (takePaid > 0) { consumeLots(lots, takePaid); p.paid -= takePaid; }
    t.set(ref, poolPatch(p, lotsPatch(lots)), { merge: true });
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
      const now = Date.now();
      const { p, lots } = applyExpiry(snap.data(), now);
      const restorePaid = Math.min(amount, Math.max(0, p.paidGranted - p.paid));
      if (restorePaid > 0) {
        p.paid += restorePaid;
        // 차감으로 줄어든 lot에 우선 되돌림 (만료 임박 순으로 원래 충전량까지 채움)
        let back = restorePaid;
        for (const l of liveLotsForRestore(lots)) {
          if (back <= 0) break;
          const room = Math.max(0, l.credits - l.remaining);
          const add = Math.min(room, back);
          l.remaining += add; back -= add;
        }
        // 되돌릴 lot이 없으면(곡 생성 환불 등) 새 lot으로 — 만료는 지금부터 1년
        if (back > 0) lots.push({ credits: back, remaining: back, at: now, expireAt: now + ONE_YEAR_MS, paymentId: 'refund' });
      }
      p.free += (amount - restorePaid);
      t.set(ref, poolPatch(p, lotsPatch(lots)), { merge: true });
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
  await markLastGrant(uid, amount, 'admin', adminUser || 'admin');
  return result;
}

// 회원 비활성화(탈퇴/차단): 같은 구글 계정으로 재로그인/재가입 불가. 남은 크레딧 소멸.
async function disableUserAccount(uid, opts) {
  const by = (opts && opts.by) || 'self';
  const ref = fdb.collection('users').doc(uid);
  let lostFree = 0, lostPaid = 0;
  try {
    const res = await fdb.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const data = snap.exists ? snap.data() : { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
      const p = splitPools(data);
      const lotsBefore = getPaidLots(data);
      const lf = p.free, lp = p.paid;
      p.free = 0; p.paid = 0;
      t.set(ref, poolPatch(p, {
        paidLots: [],
        disabled: true,
        disabledAt: admin.firestore.FieldValue.serverTimestamp(),
        disabledBy: by,
        // 관리자 복구 시 되돌려놓을 수 있도록 소멸 직전 풀/lot 스냅샷 보관 (다음 차단 때 덮어씀)
        forfeit: { free: lf, paid: lp, by, at: new Date(), lots: lotsBefore }
      }), { merge: true });
      return { lf, lp };
    });
    lostFree = res.lf; lostPaid = res.lp;
    const total = lostFree + lostPaid;
    if (total > 0) await logCredit(uid, -total, 'spend', 'withdrawal');
  } catch (e) { console.warn('disable forfeit fail', e.message); }
  // Auth 계정 비활성화 + 기존 토큰 무효화 (재로그인 차단)
  await admin.auth().updateUser(uid, { disabled: true });
  try { await admin.auth().revokeRefreshTokens(uid); } catch (e) {}
  return { forfeited: lostFree + lostPaid };
}

// 회원 복구(잘못 차단 해제): 계정 재활성화 + 차단 시 소멸된 크레딧 자동 복원.
async function restoreUserAccount(uid) {
  const ref = fdb.collection('users').doc(uid);
  let returnedFree = 0, returnedPaid = 0;
  try {
    const res = await fdb.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const data = snap.exists ? snap.data() : {};
      const p = snap.exists ? splitPools(data) : { free: 0, paid: 0, freeGranted: 0, paidGranted: 0 };
      const f = data.forfeit;
      let rf = 0, rp = 0;
      let lots = getPaidLots(data);
      if (f) {
        rf = Number(f.free) || 0; rp = Number(f.paid) || 0;
        p.free += rf; p.paid += rp;
        // 차단 시 보관한 lot을 복원하되, 이미 만료된 것은 제외
        if (Array.isArray(f.lots) && f.lots.length) {
          const now = Date.now();
          const restored = f.lots
            .map(l => ({ credits: Number(l.credits) || 0, remaining: Number(l.remaining) || 0, at: Number(l.at) || 0, expireAt: Number(l.expireAt) || ((Number(l.at) || 0) + ONE_YEAR_MS), paymentId: l.paymentId || null }))
            .filter(l => l.remaining > 0 && l.expireAt > now);
          lots = lots.concat(restored);
          // 복원된 lot 합과 p.paid 정합성 맞춤
          const liveSum = lots.reduce((s, l) => s + l.remaining, 0);
          p.paid = liveSum;
          rp = restored.reduce((s, l) => s + l.remaining, 0);
        }
      }
      t.set(ref, poolPatch(p, {
        ...lotsPatch(lots),
        disabled: false,
        restoredAt: admin.firestore.FieldValue.serverTimestamp(),
        forfeit: admin.firestore.FieldValue.delete()
      }), { merge: true });
      return { rf, rp };
    });
    returnedFree = res.rf; returnedPaid = res.rp;
    const total = returnedFree + returnedPaid;
    if (total > 0) {
      await logCredit(uid, total, 'refund', 'restore');
      await markLastGrant(uid, total, 'restore', 'admin');
    }
  } catch (e) { console.warn('restore credits fail', e.message); }
  await admin.auth().updateUser(uid, { disabled: false });
  return { ok: true, restoredFree: returnedFree, restoredPaid: returnedPaid, restored: returnedFree + returnedPaid };
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
    const now = Date.now();
    const data = usnap.exists ? usnap.data() : {};
    // 충전 전에 만료분부터 정리
    const { p, lots } = applyExpiry(data, now);
    p.paid += credits;
    p.paidGranted += credits;
    // 새 충전 lot 추가 (결제 시점부터 1년 유효)
    lots.push({ credits, remaining: credits, at: now, expireAt: now + ONE_YEAR_MS, paymentId });
    const next = p.free + p.paid;
    t.set(uref, poolPatch(p, lotsPatch(lots)), { merge: true });
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

// ===== 쿠팡 파트너스 (골드박스 특가 배너) =====
// 환경변수: COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY
// 골드박스는 하루 단위로 갱신되므로 서버 캐시(30분)로 API 호출을 최소화한다.
const COUPANG_CACHE = { data: null, at: 0 };
const COUPANG_CACHE_TTL = 30 * 60 * 1000;

// 쿠팡 오픈API HMAC(CEA) 서명 헤더 생성
function coupangAuthHeader(method, fullPath) {
  const accessKey = process.env.COUPANG_ACCESS_KEY;
  const secretKey = process.env.COUPANG_SECRET_KEY;
  const [path, query = ''] = fullPath.split('?');
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  // GMT 기준 yyMMdd'T'HHmmss'Z'
  const datetime = String(now.getUTCFullYear()).slice(2) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
  const message = datetime + method + path + query;
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

// 골드박스(오늘의 특가) 상품 목록 조회 (캐시 우선)
async function fetchCoupangGoldbox() {
  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
    return { ok: false, error: 'coupang_not_configured' };
  }
  if (COUPANG_CACHE.data && Date.now() - COUPANG_CACHE.at < COUPANG_CACHE_TTL) {
    return { ok: true, products: COUPANG_CACHE.data, cached: true };
  }
  const apiPath = '/v2/providers/affiliate_open_api/apis/openapi/v1/products/goldbox';
  try {
    const r = await fetch('https://api-gateway.coupang.com' + apiPath, {
      headers: { 'Authorization': coupangAuthHeader('GET', apiPath), 'Content-Type': 'application/json' }
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `coupang_http_${r.status}`, detail: text.slice(0, 200) };
    const j = JSON.parse(text);
    const items = (j.data || []).map(p => ({
      id: p.productId,
      name: p.productName,
      price: p.productPrice,
      image: p.productImage,
      url: p.productUrl,
    })).filter(p => p.url && p.image);
    if (items.length) { COUPANG_CACHE.data = items; COUPANG_CACHE.at = Date.now(); }
    return { ok: true, products: items };
  } catch (e) {
    return { ok: false, error: 'coupang_unreachable', detail: e.message };
  }
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
  const { name, relationship, keywords, genre: genreRaw, lang, gender, mustInclude, useNameInLyrics } = params;
  // 프런트에서 영어 코드로 넘어오는 장르를 프롬프트의 [장르별 작성 가이드] 섹션명과 정확히 매칭되는 한국어로 변환
  const GENRE_MAP = {
    hiphop: '힙합', rap: '장난 랩', ballad: '과몰입 발라드', trot: '킹받 트로트',
    ppongjjak: '뽕짝 EDM', kpop: 'K-pop', rock: '락', kids: '놀림 동요',
    lofi: '로파이', yodel: '요들송', samba: '쌈바', bollywood: '발리우드'
  };
  const genre = GENRE_MAP[genreRaw] || genreRaw;
  // 장르별 Suno style 키워드(영어) — AI 추측에 맡기지 않고 코드가 직접 주입한다.
  // 각 키워드는 리듬·악기·창법·BPM·분위기를 구체적으로 담아 "장르 맛"을 강제한다.
  const GENRE_STYLE = {
    hiphop: 'Korean boom-bap hip hop, punchy 808 bass, crisp trap hi-hats, head-nodding groove, confident rap-sung flow, vinyl scratch accents',
    rap: 'playful Korean comedy rap, bouncy old-school hip hop beat, witty fast rhythmic delivery, clappy snare, cartoonish punchlines',
    ballad: 'dramatic Korean comedy ballad, emotional grand piano, lush strings, heartfelt powerful vocal with ironic over-serious tone, slow build',
    trot: 'classic Korean trot, accordion and electric organ, ppongjjak two-beat rhythm, exaggerated vocal bends and kkeokgi, retro showy mood',
    ppongjjak: 'Korean techno-trot ppongjjak, 145 BPM high energy, fast oom-pah polka bass, retro synthesizer stabs, cheesy saxophone and accordion riffs, exaggerated trot vocal bends, relentless four-on-the-floor beat',
    kpop: 'bright modern K-pop, polished synth-pop production, punchy electronic drums, catchy melodic hook, layered idol-style vocals, sparkly pop energy',
    rock: 'energetic Korean pop-rock, distorted electric guitars, driving live drums, punchy bass, anthemic shout-along chorus, rebellious fun mood',
    kids: 'cute Korean kids nursery song, simple bouncy melody, xylophone glockenspiel and hand claps, innocent childlike vocals, playful sing-song rhythm',
    lofi: 'chill Korean lo-fi hip hop, dusty mellow piano, soft boom-bap drums, vinyl crackle, lazy laid-back half-sung vocals, cozy sarcastic mood',
    yodel: 'fast upbeat comic Alpine yodel polka, 165 BPM, energetic accordion and cowbell, fast bouncy oom-pah polka beat, lively galloping rhythm, bright playful yodel vocal flips, cheeky high-energy mood',
    samba: 'festive Brazilian samba, lively surdo and pandeiro percussion, fast carnival groove, bright brass horns, energetic call-and-response vocals',
    bollywood: 'energetic Bollywood dance number, tabla and dhol percussion, sitar riffs and lush Indian strings, dramatic cinematic melody, group chorus chanting, festive wedding-party mood'
  };
  const genreStyle = GENRE_STYLE[genreRaw] || 'upbeat playful Korean pop, catchy melodic hook, bright energetic mood';
  const genderText = { male: '남자', female: '여자', pet: '반려동물' }[gender] || '미지정';
  const langText = { ko: '한글', en: '영어', mix: '섞기' }[lang] || '한글';
  // 꼭 넣고 싶은 문장: 콤마(,) 또는 줄바꿈으로 여러 문장 구분 → 각 문장을 그대로 보존
  const mustList = (mustInclude && mustInclude.trim())
    ? mustInclude.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    : [];
  const fixed = mustList.length
    ? mustList.map(s => `"${s}"`).join('\n')   // 각 문장을 따옴표로 감싸 줄바꿈으로 나열
    : '(없음)';
  const fixedCount = mustList.length;
  const rel = (relationship && relationship.trim()) ? relationship.trim() : '친구';
  // useNameInLyrics가 false로 명시되면 이름은 제목에만 쓰고 가사 본문에는 절대 못 쓰게 함
  const nameRule = (useNameInLyrics === false)
    ? `\n\n[이름 사용 규칙]\n이름(${name})은 제목(title)에만 사용할 수 있고, 가사(lyrics) 본문에는 절대 쓰지 마라.\n가사에서는 "너", "쟤", "걔" 같은 지시어로만 가리켜라.\n`
    : '';

  return `너는 최고의 숏폼 작사가이고 사용자에 빙의한 작곡 작사가이다.

═══════════════════════════════
★ 절대 최우선 원칙 (이것부터 지켜라) ★
═══════════════════════════════

이 노래에서 가장 중요한 두 가지는 "문맥"과 "킹받음"이다.
아래 규칙은 그 어떤 규칙보다 우선한다.

1. 문맥(말이 되는 흐름)이 최우선이다.
   - 모든 줄은 앞뒤가 자연스럽게 이어져야 한다.
   - "냉장고 문이 울었다" 같은 뜬금없고 의미 불명한 줄은 절대 금지.
   - 한 곡은 하나의 상황(장면)이 이어지는 짧은 이야기여야 한다.
   - 멋져 보이려고 의미 없는 비유를 넣지 마라. 말이 되는 게 먼저다.
   ★ 라임(운율)을 맞추려고 뜻 없는 단어를 끼워넣지 마라.
     라임과 뜻이 충돌하면 "라임을 포기하고" 뜻을 지켜라. 뜻이 깨진 라임은 0점이다.
     - 나쁜 예: "맨날 쉽고 못 말린 바보 짓이야" → '쉽고'가 왜 들어갔나? 뜻이 안 통한다.
       좋은 예: "맨날 똑같은 못 말리는 바보 짓이야" (뜻이 자연스럽게 이어짐)

2. 입력된 [키워드]를 "뜻 그대로" 정확히 해석해서 전부 자연스럽게 녹여야 한다.
   - 키워드 하나에만 치중하고 나머지를 버리면 안 된다.
   - 단, 키워드를 욱여넣어 문맥을 깨면 안 된다. 자연스럽게 연결해라.
   ★ 키워드의 진짜 의미를 멋대로 바꾸거나 엉뚱한 행동을 지어내지 마라.
     - 나쁜 예: "강아지 스토커" → "강아지 따라다니면서 꼬집고" (왜 꼬집나? 스토커는 '집착해서 졸졸 따라다니는' 사람이다. '꼬집기'는 지어낸 엉뚱한 행동)
       좋은 예: "강아지 뒤만 졸졸 하루 종일 따라다녀" / "개가 어디 가나 그림자처럼 붙어있네"
     - "집순이"=집에만 있는 사람, "욕쟁이"=말이 거친 사람 → 키워드가 가리키는 그 사람의 실제 모습만 그려라. 없는 행동을 만들지 마라.

3. 욕설·비속어는 절대 쓰지 마라.
   - "욕쟁이", "입이 거칠다" 같은 키워드가 들어와도
     실제 욕설(씨발, 존나, 지랄 등)을 가사에 쓰면 안 된다.
   - 대신 "또 욕 나오겠네", "입만 열면 거칠어", "말이 곱지가 않아"
     처럼 욕하는 상황 자체를 귀엽게 묘사해라.
   - 욕설을 쓰면 자동 필터가 "삐-"로 가려서 문맥이 깨진다. 그러니 처음부터 쓰지 마라.

4. 완성 후 스스로 검토해라:
   - 모든 줄이 말이 되는가? 뜬금없는 줄은 없는가?
   - 입력 키워드가 다 들어갔는가?
   - 듣는 사람이 "아 쟤 딱 이래 ㅋㅋ" 하고 웃을 만한가?
   하나라도 아니면 다시 써라.

═══════════════════════════════

이 가사의 목적은:
친구·지인·반려동물 등을 가볍게 놀리고, 약올리고, 킹받게 만드는 재미있는 노래를 만드는 것이다.

너는 사용자가 직접 친구를 놀리는 상황에 빙의해서,
사용자의 말투와 감정으로 노래를 만들어야 한다.

핵심은:

* 실제 친구를 놀리는 느낌
* 듣자마자 대상이 떠오르는 캐릭터성
* 약오르는데 웃긴 느낌
* 밈처럼 중독되는 Hook
* 자연스럽게 이어지는 상황극
* 너무 심하지 않고 귀엽게 킹받는 분위기
* 40~50초 안에 끝나는 짧은 숏폼 노래
* Hook이 가장 기억에 남는 구조
* 1절만으로도 완성된 한 곡처럼 들리는 구성
* 선택된 장르의 리듬, 멜로디, 추임새, 창법이 살아나는 것

이다.

---

가사에서 가장 중요한 것은:

1. 문장 간 자연스러운 연결
2. 하나의 상황(scene)이 이어지는 흐름
3. 키워드로 대상의 캐릭터를 살리는 것
4. 실제 친구를 놀리는 현실감
5. "킹받는 포인트"를 제대로 살리는 것
6. 짧고 강하게 끝나는 숏폼 구조
7. 따라 부르기 쉬운 반복 Hook
8. 선택된 장르의 특징을 가사와 style에 반영하는 것
9. 짧지만 중간에 끊기지 않고 완결감 있게 끝나는 것

이다.

절대:

* 키워드 나열
* 설명문처럼 쓰기
* 의미 없는 라임
* 뜬금없는 감정 변화
* 맥락 없는 영어
* AI가 멋대로 만든 설정 추가
* 1분 이상으로 길어질 수 있는 긴 구성
* 장르명을 style에만 쓰고 실제 가사에는 반영하지 않는 것
* 노래가 중간에 끊긴 것처럼 끝나는 것

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

[꼭 넣고 싶은 문장] (아래 ${fixedCount}개 문장, 각각 따옴표로 구분됨)
${fixed}

[가사 언어]
${langText}

[장르]
${genre}

[이 장르의 style 키워드 — style 필드에 반드시 그대로 포함할 것]
${genreStyle}
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

좋은 제목 예시 (★ 그대로 복사 금지, 느낌만 참고하고 매번 새로 만들 것):

* "지각 장인" (습관형)
* "옆구리 테러범" (행동형)
* "하얀 솜뭉치" (반려동물형)
* "허당 모닝콜" (성격형)
* "폰과 결혼함" (중독형)
* "코골이 공사장" (소리형)
* "네비도 포기함" (길치형)
* "양말 행방불명" (덤벙형)

제목은 공격적이면 안 된다.
강한 욕설, 혐오 표현, 인격 비하는 금지한다.

제목은 귀엽게 약오르고,
친구가 보면 “아 뭐야 ㅋㅋ” 할 정도로 작성해라.

---

[노래 길이 및 구조 규칙]

가사는 반드시 40~50초 안에 끝나는 짧은 숏폼 노래로 작성해라.

하지만 짧다고 해서 중간에 끊긴 느낌이면 안 된다.
반드시 "1절짜리 완성된 한 곡"처럼 들려야 한다.

절대 1분 이상으로 길어질 수 있는 구조로 쓰지 마라.

인트로는 작성하지 마라.
아웃트로도 작성하지 마라.
2절, 브릿지, 긴 엔딩도 작성하지 마라.

구성은 아래 파트를 사용해라.

* Verse
* Pre-Hook
* Hook
* Hook (한 번 더 반복)

전체 구조는 반드시 아래 흐름을 따른다.

1. Verse:
   대상의 특징과 상황을 바로 보여준다.

2. Pre-Hook:
   놀림 포인트를 Hook으로 터뜨리기 직전까지 몰아간다.

3. Hook (1차):
   가장 킹받는 핵심 문장을 반복해서 곡의 하이라이트를 만든다.

4. Hook (2차 반복):
   같은 Hook을 한 번 더 반복해서 곡을 충분히 길고 중독성 있게 만든다.
   마지막 줄은 노래가 끝났다는 느낌이 나도록 짧고 강하게 마무리한다.

즉, Hook을 두 번 반복하고, 두 번째 Hook의 마지막 줄이 엔딩 역할을 해야 한다.
(Hook을 한 번만 쓰면 노래가 20~25초로 너무 짧게 끝난다.
Hook을 두 번 반복해야 40~50초 분량이 나온다.)

---

[Verse]

4줄만 작성한다.

Verse는 설명이 아니라 장면이어야 한다.
처음부터 바로 대상의 특징이나 행동이 드러나야 한다.

Verse 안에서 최소 1~2개의 키워드가 자연스럽게 장면으로 표현되어야 한다.

Verse의 역할:

* 대상이 어떤 사람인지 보여주기
* 놀림 포인트를 처음부터 드러내기
* Hook에서 터질 별명이나 문장을 준비하기

Verse는 완결된 상황의 시작처럼 들려야 한다.
뜬금없는 한 줄 모음처럼 쓰지 마라.

---

[Pre-Hook]

2줄만 작성한다.

Pre-Hook은 Hook으로 넘어가기 위한 빌드업이다.

Pre-Hook의 역할:

* Verse에서 보여준 특징을 한 번 더 콕 집기
* "아 얘 진짜 이렇다니까?" 하는 느낌 만들기
* Hook에서 반복될 핵심 별명이나 한마디를 기대하게 만들기

Pre-Hook은 Hook과 반드시 연결되어야 한다.

Pre-Hook이 끝나면 자연스럽게 Hook이 터져야 한다.

---

[Hook]

Hook은 이 노래에서 가장 중요한 파트이며,
가장 강하고 중독성 있게 작성해야 한다.

Hook은 핵심 문장 A, B 두 줄을 만든 뒤,
그 Hook 블록(A/B/A/B)을 두 번 반복해서 총 8줄로 작성해라.

Hook 1차 (4줄):
1줄: 핵심 Hook 문장 A
2줄: 핵심 Hook 문장 B
3줄: 핵심 Hook 문장 A 반복
4줄: 핵심 Hook 문장 B 반복

Hook 2차 (4줄, 같은 Hook을 한 번 더):
5줄: 핵심 Hook 문장 A
6줄: 핵심 Hook 문장 B
7줄: 핵심 Hook 문장 A
8줄: 핵심 Hook 문장 B를 살짝 변형한 마무리형 문장 (B')

즉 전체 Hook 구조는: A / B / A / B / A / B / A / B'

마지막 8줄째(B')는 노래가 끝나는 느낌이 나도록
B를 아주 살짝 변형해서 "딱 끝났다"는 마무리감을 줘야 한다.

예:
A: 폰만 보면 좀비야
B: 밥 먹을 때도 화면 보네
A: 폰만 보면 좀비야
B: 밥 먹을 때도 화면 보네
A: 폰만 보면 좀비야
B: 밥 먹을 때도 화면 보네
A: 폰만 보면 좀비야
B': 배터리가 먼저 잠드네

(위 예시 문장을 그대로 쓰지 마라. 매 곡마다 그 곡의 내용에 맞는 새로운 문장을 만들어라.)

Hook을 두 번 반복하는 이유:
Hook이 한 번만 나오면 노래가 20~25초로 너무 짧게 끝난다.
같은 Hook을 두 번 반복해야 후렴이 귀에 박히고 40~50초 분량이 나온다.
Hook 2차는 새로운 내용을 만들지 말고, 1차 Hook과 똑같이 반복해라.
(마지막 줄 B'만 마무리용으로 살짝 바꾼다.)

---

[Hook 강조 규칙]

Hook은 Verse보다 더 강해야 한다.

Hook은 단순히 키워드를 반복하는 것이 아니라,
대상을 놀리는 가장 킹받는 별명, 행동, 말투를
짧고 중독성 있는 2줄로 압축해야 한다.

Hook은 다음 조건을 반드시 만족해야 한다.

* 가장 기억에 남아야 한다
* 따라 부르기 쉬워야 한다
* 짧고 리듬감 있어야 한다
* 2번 반복해도 어색하지 않아야 한다
* 대상이 들으면 바로 킹받아야 한다
* 친구들이 따라 부르기 쉬워야 한다
* 제목으로 써도 될 만큼 선명해야 한다
* 키워드 나열이 아니라 별명화되어 있어야 한다
* 선택된 장르의 추임새, 리듬감, 반복 방식이 자연스럽게 반영되어 있어야 한다
* 곡의 마지막 줄이 엔딩처럼 느껴져야 한다

Hook 문장 A와 B는 서로 연결되어야 한다.

A는 놀리는 별명이나 핵심 상황,
B는 그걸 더 약오르게 만드는 한마디로 작성해라.

나쁜 Hook 예시:
"야근러 다이어터 힘순찐이
야근러 다이어터 힘순찐이
일하고 먹방하고 또 힘순찐이
야근러 다이어터 힘순찐이"

왜 나쁜가:

* 키워드를 그대로 반복함
* 중독성보다 나열 느낌이 강함
* 놀리는 포인트가 약함
* 마지막 줄에 마무리감이 없음

좋은 Hook 예시 (★ 그대로 복사 절대 금지, 구조만 참고):
"길치 인증 또 했네
네비도 두 손 들었네
길치 인증 또 했네
약속 장소만 세 번째네"

좋은 Hook 예시 (★ 그대로 복사 절대 금지, 구조만 참고):
"꼬집고 튀어
또 혼자 웃어
꼬집고 튀어
손버릇 평생 가겠어"

좋은 Hook 예시 (★ 그대로 복사 절대 금지, 구조만 참고):
"코 고는 소리 봐
옆집서 민원 왔어
코 고는 소리 봐
벽지가 다 떨어졌어"

(주의: 위 예시들의 문장을 그대로 가져다 쓰지 마라.
구조와 느낌만 참고하고, 문장은 매 곡의 키워드로 새로 만들어라.
사용자 키워드가 예시와 비슷한 주제(다이어트, 지각 등)여도
예시 문장을 가져오지 말고 반드시 새로 지어라.)

---

[완결감 규칙]

이 노래는 1절만 있는 짧은 노래지만,
끝났을 때 중간에 끊긴 느낌이 나면 안 된다.

마지막 Hook의 마지막 줄은 반드시:

* 결론처럼 들리거나
* 한 방 먹이는 말처럼 들리거나
* 친구들이 따라 부르며 끝낼 수 있는 문장이어야 한다.

마지막 줄에는 여운을 남기는 말보다
짧고 확실한 마무리 멘트를 사용해라.

★★ 마무리 문장 복사 금지 규칙 ★★

"오늘도 딱 걸렸네", "또 걸렸네" 같은 문장을 마무리로 쓰지 마라.
이 문장들은 이미 너무 많이 사용되어 금지한다.

마무리 문장은 매 곡마다 그 곡의 놀림 내용에서 직접 만들어내라.

마무리 문장을 만드는 방법 (유형만 참고, 문장은 새로 만들 것):

* 결론형: 그 사람의 특징이 결국 어떻게 됐는지 한 줄로 정리
  (예: 다이어트 놀림이면 → "냉장고만 또 채워졌네")
* 한 방형: 가장 약오르는 핀잔을 마지막에 던지기
  (예: 지각 놀림이면 → "회사가 너를 포기했대")
* 미래형: 내일도/평생 똑같을 거라고 못 박기
  (예: 폰 중독 놀림이면 → "베터리가 먼저 죽겠다")
* 항복형: 못 말린다고 인정해버리기
  (예: 먹보 놀림이면 → "그래 많이 먹어라")
* 별명 확정형: Hook의 별명을 마지막에 도장 찍듯 확정
  (예: → "네 이름은 이제 김지각")

핵심: 마무리 문장에는 반드시 그 곡의 키워드/놀림 내용이 들어가야 한다.
어떤 곡에나 갖다 붙일 수 있는 범용 마무리 문장은 금지한다.

나쁜 마무리 예 (감성적으로 흐려짐):

* 계속 그렇게 흘러가
* 언젠가는 알게 될 거야
* 이 밤이 지나가면
* 우리 추억 속으로

왜 나쁜가:

* 노래가 끝나는 느낌보다 감성적으로 흐려짐
* 장난 노래의 한 방이 약함
* 숏폼 디스송 분위기와 맞지 않음

---

[길이 제한 규칙]

전체 가사는 14줄로 작성한다.

구성은 반드시:

* Verse 4줄
* Pre-Hook 2줄
* Hook 1차 4줄
* Hook 2차 4줄 (1차와 동일, 마지막 줄만 마무리형)

총 14줄이다.

각 줄은 짧게 작성해라.
한 줄은 10~16자 정도의 짧은 한국어 문장으로 작성하는 것을 우선한다.

너무 긴 문장, 설명이 많은 문장, 랩처럼 길게 늘어지는 문장은 금지한다.

의미 없는 추임새로 길이를 늘리지 마라.
Verse를 길게 늘려 길이를 채우지 마라. 길이는 Hook 반복으로 채운다.

전체 흐름은:
장면 제시 → 놀림 빌드업 → Hook 폭발 → Hook 반복 → 마지막 줄로 완결

이어야 한다.

---

[짧은 가사 작성 규칙]

40~50초 노래를 위해 다음을 반드시 지켜라.

* 전체 14줄 (Verse 4 + Pre-Hook 2 + Hook 4 + Hook 반복 4)
* Verse 4줄
* Pre-Hook 2줄
* Hook 4줄 + Hook 반복 4줄 (같은 Hook을 두 번)
* Intro 금지
* Outro 금지
* Bridge 금지
* 2절 금지 (Verse는 1개만)
* 긴 설명 금지
* 긴 문장 금지
* Hook은 두 번 반복하되, 그 외 파트는 반복 금지
* 의미 없는 추임새로 길이 늘리기 금지

가사는 짧고 강하게 작성해라.
한 번 듣고 바로 기억나는 숏폼 밈송처럼 작성해라.

---

★★★ 가장 중요: 키워드 밈화 규칙 ★★★

[키워드]는 가사에 그대로 넣는 단어가 아니다.
[키워드]는 "이 사람을 어떻게 놀리면 가장 웃기고 킹받을까?"를 알려주는 재료다.

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

가사의 최종 목표는:
"사용자가 입력한 키워드를 모두 넣었다"가 아니다.

가사의 최종 목표는:
"그 사람을 아는 친구들이 들었을 때 바로 웃고,
단톡방에서 따라 부르고 싶어지는 밈송이 나왔다"이다.

목표 반응:
"아 이거 우리 단톡방에서 쟤 놀릴 때 쓰는 말이랑 똑같다 ㅋㅋㅋ"

---

[키워드 변환 순서]

각 키워드는 반드시 아래 순서로 변환해서 사용해라.

1. 키워드의 의미를 파악한다.
2. 그 키워드가 왜 놀림 포인트인지 찾는다. (뭐가 웃긴가?)
3. 친구들이 단톡방에서 실제로 놀릴 법한 말투로 바꾼다.
4. 짧고 중독성 있는 밈식 표현으로 압축한다.
5. Verse에서는 장면으로 보여준다.
6. Hook에서는 별명이나 한마디로 반복한다.

절대 키워드를 그대로 가사에 복사하지 마라.
키워드가 들어오면 그 단어를 그대로 쓰는 게 아니라,
그 의미를 살린 새로운 표현으로 바꿔 써라.
(예: "코골이" → "옆집 공사 소리" / "길치" → "네비도 포기한 사람"
위 변환 예시도 그대로 쓰지 말고 매번 새로 만들어라.)

---

[유머 기법 7가지]

키워드를 변환할 때 아래 기법 중 매 곡마다 2~3개를 골라 자연스럽게 섞어라.
모든 기법을 억지로 다 쓰지 마라.
매 곡마다 같은 기법만 반복하지 마라.

★ 아래 모든 예시 문장은 방식 설명용이다.
★ 절대 그대로 복사하지 말고, 매번 입력된 키워드에 맞게 새로 만들어라.

---

기법 1. 의인화

사물이나 주변 요소가 대상 때문에 고통받거나 반응하는 것처럼 표현해라.
대상의 습관을 직접 말하지 않고, 주변 사물이 대신 증언하는 느낌을 만든다.

방식 예:
* 늦잠 → 알람이 지쳐서 포기함
* 올챙이배 → 단추가 매일 긴장함
* 먹보 → 냉장고가 너만 보면 떨고 있음
* 코골이 → 베개가 퇴사하고 싶어 함
* 폰 중독 → 배터리가 살려달라고 빎

좋은 예 (복사 금지, 방식만 참고):
"알람이 먼저 지쳐서 꺼졌대"
"단추가 오늘도 버티는 중"
"가방도 너 따라 정신없네"

주의: 사물이 반응하는 설정은 가능하지만,
입력되지 않은 새로운 외형이나 사실을 만들면 안 된다.

---

기법 2. 공식 기록 / 타이틀 수여

대상의 특징을 마치 공식 수상 경력, 대회 기록, 칭호처럼 표현해라.
놀림 포인트를 과장해서 "이 정도면 인정해야 하는 캐릭터"처럼 만든다.

방식 예:
* 지각 → 지각 부문 대상
* 야식 → 야식 출석률 1위
* 다이어터 → 내일부터 부문 장기 집권
* 덤벙이 → 분실물계 레전드

좋은 예 (복사 금지, 방식만 참고):
"지각 부문 대상 수상"
"야식 출석률 1위"
"덤벙계 공식 대표"

주의: 너무 길고 설명적인 문장으로 만들지 마라.
짧고 제목처럼 기억나는 표현이 좋다.

---

기법 3. 주변의 반응으로 표현

대상 본인을 직접 놀리기보다,
주변 사람들이나 주변 환경이 어떻게 반응하는지로 웃기게 표현해라.
장면이 살아나고 놀림이 더 자연스러워진다.

방식 예:
* 코골이 → 옆집에서 공사하냐고 함
* 지각 → 엘리베이터도 포기함
* 발냄새 → 양말이 스스로 빨래통에 들어감
* 목소리 큼 → 옆 동네까지 다 들림

좋은 예 (복사 금지, 방식만 참고):
"옆집이 공사냐고 물어봐"
"엘베도 너 기다리다 지쳐"
"옆구리 먼저 도망가네"

주의: 주변 반응은 과장해도 되지만,
새로운 사건이나 피해 사실을 심각하게 만들지 마라.

---

기법 4. 인터넷 밈 화법

요즘 숏폼 댓글이나 단톡방에서 친구들이 장난칠 때 쓰는 말투를 살짝 반영해라.
단, 억지로 유행어를 많이 넣지 마라. 곡당 1~2번만 자연스럽게 사용해라.

사용 가능한 느낌:
* "~하는 거 실화냐"
* "폼 미쳤다"
* "레전드 갱신"
* "현실 ○○ 장인"
* "이 정도면 재능"
* "~그 자체"
* "또 시작이네"

금지 (오히려 안 웃기다):
* "헐", "대박", "킹왕짱", "완전 짱"
* 오래된 유행어
* 어색한 인터넷 말투
* 맥락 없는 밈 표현

좋은 예 (복사 금지, 방식만 참고):
"지각 폼 미쳤다"
"현실 덤벙 장인"
"하는 거 실화냐"

주의: 밈 표현은 양념이다.
밈만 많고 상황이 없으면 가사가 유치해진다.

---

기법 5. 진지한 톤으로 어이없는 내용 말하기

뉴스, 다큐, 시상식, 리포트처럼 진지하게 말하지만,
내용은 말도 안 되게 사소하고 웃긴 상황으로 작성해라.
과몰입해서 말할수록 더 킹받는다.

방식 예:
* 늦잠 → 기자가 3시간째 기다림
* 다이어트 실패 → 긴급 속보처럼 말함
* 야식 → 현장 검거처럼 표현

좋은 예 (복사 금지, 방식만 참고):
"본 기자 아직도 기다리는 중"
"긴급 속보 또 야식 발견"
"현장 검거 김밥 앞"

주의: 너무 길게 쓰면 설명문이 된다.
짧고 리듬감 있게 써라.

---

기법 6. 칭찬인 척 디스

앞부분은 칭찬처럼 시작하고, 뒷부분에서 놀림 포인트로 뒤집어라.
공격적이지 않으면서도 은근히 킹받게 만든다.

방식 예:
* 꾸준함 칭찬 → 맨날 늦는 걸 꾸준히 함
* 성실함 칭찬 → 야식 출석은 성실함
* 집중력 칭찬 → 메뉴판 볼 때만 집중함
* 재능 칭찬 → 잃어버리는 재능 있음

좋은 예 (복사 금지, 방식만 참고):
"꾸준한 건 인정해, 맨날 늦는 게"
"집중력 좋네, 메뉴판 볼 때"
"재능은 있어, 자꾸 잃어버려"

주의: 칭찬처럼 시작해도 마지막은 귀엽고 장난스럽게 끝내라.
진짜 상처 주는 비하로 가면 안 된다.

---

기법 7. 숫자로 과장

구체적인 숫자를 넣어 과장하면 더 웃기고 기억에 남는다.
숫자는 현실감과 어이없음을 동시에 만든다.

방식 예:
* 알람 17개 무시
* 5분 거리 40분 걸림
* 커피 3잔 들고도 졸림
* 카드 찾는 데 10분

좋은 예 (복사 금지, 방식만 참고):
"알람 17개 다 무시"
"5분 거릴 40분째"
"커피 3잔도 못 깨워"

주의: 숫자는 웃기게 과장하는 용도다.
너무 많이 넣으면 계산표처럼 보이니 곡당 1~2번만 사용해라.

---

[유머 기법 선택 기준]

키워드 유형에 따라 어울리는 기법을 골라라.

* 외모/특징 키워드 → 의인화, 숫자 과장, 칭찬인 척 디스
* 습관 키워드 → 타이틀 수여, 주변 반응, 밈 화법
* 행동 키워드 → 상황 장면, 진지한 톤, 주변 반응
* 반복되는 성격 키워드 → 타이틀 수여, Hook 별명화, 숫자 과장
* 반려동물 키워드 → 의인화, 주변 반응, 귀여운 밈화

파트별 배치:

* Verse → 장면 + 유머 기법을 섞어서 캐릭터를 보여준다
* Pre-Hook → 놀림을 한 번 더 몰아간다
* Hook → 가장 웃긴 표현 1개를 짧은 별명/한마디로 압축한다

같은 기법을 Verse, Pre-Hook, Hook에서 계속 반복하지 마라.

---

[Hook 밈화 규칙]

Hook은 가사에서 가장 밈처럼 들려야 한다.

Hook에는 위 유머 기법 중 가장 강한 표현 1개를 골라
2줄짜리 밈 문장으로 압축해라.

Hook은 반드시:

* 별명처럼 짧아야 한다
* 단톡방에서 놀릴 때 바로 쓸 수 있어야 한다
* 따라 부르면 더 킹받아야 한다
* 반복해도 웃겨야 한다
* 제목으로 써도 될 만큼 선명해야 한다

나쁜 Hook (키워드 나열):
"덤벙이 야근러 다이어터
덤벙이 야근러 다이어터"

좋은 Hook의 구조 (문장은 매 곡 새로 만들 것):
A줄 = 키워드에서 나온 별명/핵심 상황
B줄 = 그걸 더 약오르게 만드는 한마디
→ A/B를 반복하되, 마지막 B는 그 곡의 키워드 내용으로 마무리

---

[안전한 킹받음 규칙]

가사는 단순히 귀엽거나 예쁘게 쓰는 것이 아니라,
대상이 들으면 살짝 긁히고 킹받을 정도로 작성해라.

하지만 기분 나쁜 공격이나 괴롭힘처럼 느껴지면 안 된다.

목표 반응 (이런 반응이 나와야 성공):

* "아 뭐야 ㅋㅋㅋ"
* "야 그만해 ㅋㅋ"
* "아니 이걸 노래로 만들었네"
* "킹받는데 웃기네"
* "괜히 찔리네"

절대 안 되는 것:

* 인격 공격
* 심한 외모 비하
* 혐오 표현
* 성희롱
* 가족 비하
* 장애/질병 비하
* 심한 욕설
* 따돌림처럼 느껴지는 조롱

목표는:
"상처 주는 디스"가 아니라
"아 짜증나는데 웃긴 노래"다.

---

[입력 정보 밖 설정 창작 금지]

절대 입력되지 않은 새로운 설정이나 특징을 임의로 추가하지 마라.

사용자가 제공한:

* 대상 이름
* 성별
* 관계
* 키워드
* 꼭 넣고 싶은 문장

안에서만 캐릭터를 구성해라.

키워드를 과장하거나 비틀 수는 있지만,
없는 외형이나 사실을 새로 만들면 안 된다.

예:

* "하얀개" → 흰 털, 솜뭉치 느낌, 순둥한 느낌 표현 가능

하지만:

* "배만 새까맣다"
* "눈이 빨갛다"
* "사고를 쳤다"
* "뚱뚱하다"
* "냄새난다"

처럼 입력되지 않은 특징은 추가 금지.

핵심은:
"없는 설정 추가"가 아니라
"입력된 특징을 더 웃기고 킹받게 살리는 것"이다.

---

[좋은 예 / 나쁜 예]

나쁜 예 (키워드 억지 삽입):

"아침부터 올챙이배 잡고
야 일어나 꼬집기 대마왕"

왜 나쁜가:

* 상황 연결 없음
* 실제 놀리는 느낌 없음
* 키워드만 기계적으로 넣음
* 왜 웃긴지 드러나지 않음

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

[키워드 배분 규칙 — 매우 중요]

사용자가 입력한 키워드는 빠짐없이 모두 가사에 반영해야 한다.
키워드 하나에만 치중하고 나머지를 버리면 안 된다.

사용자는 그 사람의 여러 특징을 알려준 것이다.
한 가지 특징만 노래하면 "그 사람"이 아니라 "다이어트 노래"가 되어버린다.

키워드 배분 방법:

1. 입력된 키워드 중 가장 웃긴 것 1개를 "메인 키워드"로 정한다.
   → 메인 키워드는 Hook과 제목에 사용한다.

2. 나머지 키워드들은 전부 Verse(4줄)와 Pre-Hook(2줄)에 배분한다.
   → Verse 한 줄에 키워드 1개씩 장면으로 녹여라.
   → 키워드가 4개면: Verse 4줄에 서로 다른 키워드의 장면이 나와야 한다.

3. 여러 키워드를 한 줄에 자연스럽게 합칠 수 있으면 합쳐도 된다.
   (예: "덤벙이" + "지각" → "허둥대다 또 늦었네")

배분 예시 (키워드 4개가 들어온 경우):

* Verse 1줄 → 키워드 A의 장면
* Verse 2줄 → 키워드 B의 장면
* Verse 3줄 → 키워드 C의 장면
* Verse 4줄 → 키워드 D의 장면 (또는 A 보강)
* Pre-Hook → 메인 키워드로 몰아가기
* Hook → 메인 키워드의 별명/한마디

이렇게 하면 짧은 노래 안에서도
"아 이거 완전 걔네" 하고 모든 특징이 다 들리게 된다.

검증: 가사를 다 쓴 후, 입력된 키워드 중
가사에 반영 안 된 키워드가 있는지 확인해라.
하나라도 빠졌으면 Verse를 수정해서 넣어라.

단, 모든 키워드는 맥락 안에서 자연스럽게 활용해라.
키워드를 넣으려고 뜬금없는 줄을 만들면 안 된다.

---

[키워드 처리 금지 사항]

* 키워드를 그대로 나열하기
* 키워드만 이어 붙여 제목처럼 만들기
* 입력된 키워드 중 일부를 무시하고 한 키워드에만 치중하기
* 왜 웃긴지 드러나지 않는 문장 쓰기
* 맥락 없이 유행어만 넣기
* 없는 설정을 새로 만들어서 웃기려 하기
* 심한 욕설이나 인격 비하로 웃기려 하기
* 가사보다 설명문처럼 쓰기
* 프롬프트의 예시 문장을 그대로 복사하기

---

★★ [꼭 넣고 싶은 문장] 처리 규칙 — 반드시 지켜라 ★★

[꼭 넣고 싶은 문장]이 "(없음)"이 아니면:

* 거기 적힌 문장들은 사용자가 노래에 꼭 넣고 싶어 직접 쓴 문장이다.
* 각 문장은 따옴표("")로 구분되어 있다. 여러 개일 수 있다.
* 제시된 문장을 "하나도 빠짐없이 전부" 가사에 넣어야 한다.
* 각 문장은 글자 그대로(원문 그대로) 가사의 한 줄로 사용해라.
  - 단어를 바꾸거나, 줄이거나, 풀어쓰거나, 의역하지 마라.
  - 예: 사용자가 "입만 열면 분위기 박살"이라 썼으면
    가사에 정확히 "입만 열면 분위기 박살"이 한 줄로 들어가야 한다.
* 단, 자연스러운 노래를 위해 문장 끝에 "~네", "~지", "야" 같은
  조사/어미를 아주 살짝 붙이는 것은 허용한다. (핵심 단어는 그대로 유지)
* 이 문장들은 주로 Verse나 Pre-Hook에 배치하고,
  가장 임팩트 있는 문장 하나는 Hook에 써도 좋다.
* 키워드와 이 문장들이 자연스럽게 이어지도록 앞뒤 줄을 구성해라.
* 전체 14줄 구조(Verse 4 + Pre-Hook 2 + Hook 8) 안에서,
  이 문장들이 우선적으로 들어갈 자리를 확보해라.
  (문장 개수가 많으면 Verse/Pre-Hook을 이 문장들 위주로 채워라.)

다 쓴 후 확인해라: 제시된 문장이 전부 가사에 들어갔는가?
하나라도 빠졌으면 반드시 넣어서 다시 작성해라.

"(없음)"이면 이 규칙은 무시해라.

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

[장르 반영 규칙]

[장르]는 단순히 style 필드에만 적는 정보가 아니다.

가사, Hook, 리듬감, 추임새, 반복 방식, 멜로디 분위기, 코드 진행 느낌에 모두 반영해야 한다.

선택된 [장르]의 특징이 노래에서 분명히 느껴져야 한다.

단, 장르를 살리기 위해 가사의 맥락을 깨거나,
입력되지 않은 설정을 새로 만들면 안 된다.

장르 표현은:

* 추임새
* 리듬감
* Hook 반복 방식
* 가사 어미
* 멜로디 분위기 설명
* style 필드의 음악적 설명

으로 자연스럽게 반영해라.

장르 표현 때문에 전체 가사가 10줄을 넘으면 안 된다.

---

[장르별 작성 가이드]

1. 요들송

특징:

* 밝고 익살스러운 산골/알프스풍 느낌
* 빠르고 신나는 업템포 폴카 리듬 (느릿한 왈츠가 아니라 빠르게 통통 튀는 느낌)
* “요들레이”, “요를레이히”, “요델리요” 같은 요들 추임새 사용
* 음이 빠르게 꺾이고 튀는 느낌
* 장난스럽고 약오르는 반복 Hook에 잘 어울림

가사 반영:

* 빠른 템포에 맞게 가사 줄을 짧고 경쾌하게 끊어 써라.
* ★ 요들송은 요들 추임새가 매력의 핵심이다.
  Hook에는 "요를레이히", "요들레이", "요들레이힛" 같은 요들 추임새를
  반드시 1~2번 (괄호)로 넣어서 요들송 느낌을 살려라.
  Verse에도 한 번쯤 넣으면 더 좋다 (필수는 아님).
* 추임새는 매 곡 똑같이 쓰지 말고 조금씩 변형해라
  (요를레이히 / 요들레이 / 요들레이힛 / 요레이요 등).
* 단, 추임새는 (괄호)로 가사 줄 끝에 붙여라. 절대 추임새만으로 한 줄을 채우지 마라.
* 너무 많이 넣어서 가사 본문이 안 들리면 안 된다. Hook에 1~2번이면 충분.
* 놀리는 문장과 추임새가 자연스럽게 이어져야 한다.

요들 Hook 예시 (구조만 참고, 문장은 매 곡 새로):
"또 집에만 있네 (요를레이히)
밖은 구경도 안 해
또 집에만 있네 (요를레이히)
나갈 생각이 없네"

style 예:
"fast upbeat Korean yodel polka, 165 BPM, energetic accordion and cowbell, fast bouncy oom-pah polka beat, lively galloping rhythm, bright playful yodel vocal flips, no intro, no outro, no bridge, repeated strong hook, clear ending feel, cheeky high-energy mood"

---

2. 장난 랩

특징:

* 말맛, 박자감, 라임이 중요
* 디스는 세지 않게, 장난스럽게
* 짧은 문장을 빠르게 치는 느낌
* 친구 놀리는 핀잔과 말장난에 적합

가사 반영:

* Verse에서 짧은 라임을 살려라.
* Hook은 따라 하기 쉬운 구호처럼 만들어라.
* 욕설 없이 장난 디스 느낌만 살려라.

좋은 Hook 예 (★ 그대로 복사 절대 금지, 구조만 참고):
"지각 폼 미쳤다"
"버스도 포기했다"
"지각 폼 미쳤다"
"내일도 뻔하잖아"

style 예:
"short complete 45-second playful Korean comedy rap, no intro, no outro, no bridge, repeated strong hook, clear ending feel, bouncy hip-hop beat, witty rhythmic delivery"

---

3. 놀림 동요

특징:

* 단순하고 귀여운 멜로디
* 어린이 노래처럼 쉬운 반복
* 순한데 은근히 킹받는 느낌
* 짧고 명확한 문장이 좋음

가사 반영:

* 문장을 아주 쉽게 써라.
* Hook은 동요처럼 반복감 있게 작성해라.
* 너무 복잡한 비유나 긴 문장 금지.

좋은 Hook 예 (구조만 참고, 문장은 매 곡 새로 만들 것):
"또 또 늦었네"
"가방 메고 뛰네"
"또 또 늦었네"
"신발도 거꾸로 신었네"

style 예:
"short complete 45-second Korean nursery rhyme, no intro, no outro, no bridge, repeated strong hook, clear ending feel, simple cute melody, light xylophone and clap rhythm"

---

4. 킹받 트로트

특징:

* 과장된 감정
* 꺾는 창법 느낌
* “아이고”, “어머나”, “얼쑤”, “좋다” 같은 추임새 가능
* 웃기고 능청스러운 핀잔에 적합

가사 반영:

* 문장 끝을 능청스럽게, 꺾기 좋게 처리해라.
* 트로트식 감탄사는 (괄호)로 넣어도 된다. 필수는 아니다.
* 넣는다면 매번 다른 표현을 만들어라. 매 곡 똑같은 추임새 금지.
* 너무 진지한 이별 트로트처럼 가지 마라.
* 트로트 느낌은 추임새보다 style(꺾기 창법/리듬)로 살리는 게 우선이다.

style 예:
"short complete 45-second playful Korean trot, no intro, no outro, no bridge, repeated strong hook, clear ending feel, bouncy trot rhythm, comic vocal bends, cheerful brass accents"

---

5. 놀림 챈트

특징:

* 응원가, 구호, 단체 외침 느낌
* 매우 반복적이고 직관적
* 친구들이 같이 외치기 좋음
* Hook이 가장 중요

가사 반영:

* Hook을 구호처럼 만들어라.
* 짧은 단어 반복을 활용해라.
* 응원 추임새는 (괄호)로 넣어도 된다. 필수는 아니다.
* 넣는다면 매번 다른 표현을 만들어라. 매 곡 똑같은 추임새 금지.
* 단, 길이 늘리기용 무의미한 추임새는 금지.

좋은 Hook 예 (★ 그대로 복사 절대 금지, 구조만 참고):
"또 잃어버렸대!"
"이번엔 차 키래!"
"또 잃어버렸대!"
"찾으면 가방 안이래!"

style 예:
"short complete 45-second Korean chant, no intro, no outro, no bridge, repeated strong hook, clear ending feel, stadium chant rhythm, claps and group vocals"

---

6. 뽕짝 EDM

특징:

* 트로트 + 빠른 전자 비트 (이박사 스타일 테크노 뽕짝)
* "쿵짝 쿵짝" 4박자 오움파(oom-pah) 베이스가 쉬지 않고 깔림
* 촌스러운 레트로 신디사이저 + 색소폰 + 아코디언
* 빠르고(140~150 BPM) 정신없이 신나는 느낌
* 트로트 꺾기 창법 + 과장된 흥
* 반복 Hook과 드롭 느낌이 중요
* 약간 과장되고 킹받는 에너지

가사 반영:

* Hook은 짧고 강하게 반복해라.
* 가사 어미를 "~네", "~야", "~지" 처럼 트로트 꺾기 좋게 써라.
* 리듬성 추임새는 (괄호)로 넣어도 된다. 필수는 아니다.
* 넣는다면 매번 다른 표현을 만들어라. 매 곡 똑같은 추임새 금지.
* 너무 추임새만 많아지면 안 된다.
* 뽕짝 느낌은 추임새보다 style(비트/악기)로 살리는 게 우선이다.

★ 뽕짝 style 작성 특별 규칙 ★

"ppongjjak"이라는 단어만으로는 음악 AI가 뽕짝을 이해하지 못한다.
반드시 아래 키워드를 모두 조합해서 구체적으로 작성해라:

* Korean techno-trot
* fast oom-pah polka bass (쿵짝쿵짝 베이스)
* 145 BPM high energy
* retro synthesizer stabs
* cheesy saxophone and accordion riffs
* vintage Korean cabaret disco
* exaggerated trot vocal bends (꺾기)
* relentless four-on-the-floor beat

style 예:
"short complete 45-second Korean techno-trot ppongjjak, 145 BPM high energy, fast oom-pah polka bass, retro synthesizer stabs, cheesy saxophone and accordion riffs, vintage Korean cabaret disco, exaggerated trot vocal bends, relentless four-on-the-floor beat, no intro, no outro, no bridge, repeated strong hook, clear ending feel, comic energy"

---

7. 키즈팝

특징:

* 동요보다 조금 더 현대적인 귀여운 팝
* 밝고 통통 튀는 멜로디
* 쉬운 단어와 반복 Hook
* 귀엽지만 은근 킹받는 분위기

가사 반영:

* Hook은 귀엽고 짧게 반복해라.
* 너무 유치하지만은 않게, 숏폼 팝 느낌을 살려라.
* 밝고 통통 튀는 리듬을 상상하며 써라.

좋은 Hook 예 (구조만 참고, 문장은 매 곡 새로 만들 것):
"꼬집고 튀어"
"또 혼자 웃어"
"꼬집고 튀어"
"유치원생도 안 그래"

style 예:
"short complete 45-second Korean kids pop, no intro, no outro, no bridge, repeated strong hook, clear ending feel, bright bubbly melody, cute synths and claps"

---

8. 만화 주제가

특징:

* 캐릭터 소개송 느낌
* 과장된 히어로/악당 테마처럼 웃기게 표현
* 대상의 특징을 캐릭터 능력처럼 부풀리기 좋음
* 밝고 에너지 있는 멜로디

가사 반영:

* 키워드를 캐릭터 능력처럼 표현해라.
* 단, 없는 설정을 새로 만들지 마라.
* Hook은 주제가처럼 힘 있고 반복감 있게 작성해라.

좋은 Hook 예 (구조만 참고, 문장은 매 곡 새로 만들 것):
"옆구리 테러 등장"
"꼬집고 바로 도망"
"옆구리 테러 등장"
"이 마을의 빌런이다"

style 예:
"short complete 45-second Korean cartoon theme song, no intro, no outro, no bridge, repeated strong hook, clear ending feel, heroic comic melody, upbeat drums and bright synth brass"

---

9. 과몰입 발라드

특징:

* 쓸데없이 진지해서 웃긴 느낌
* 감정 과잉, 슬픈 멜로디, 진심처럼 부르는 놀림
* 내용은 장난인데 분위기는 발라드라서 킹받음

가사 반영:

* 너무 슬픈 사랑노래처럼 가지 마라.
* 대상의 웃긴 특징을 진지하게 노래해서 반전 웃음을 만들어라.
* Hook은 짧고 감정적으로 반복해라.

좋은 Hook 예 (구조만 참고, 문장은 매 곡 새로 만들 것):
"내일부터 한다던 너"
"오늘도 김밥 앞에"
"내일부터 한다던 너"
"김밥은 죄가 없잖아"

style 예:
"short complete 45-second dramatic Korean comedy ballad, no intro, no outro, no bridge, repeated strong hook, clear ending feel, emotional piano chords, heartfelt vocal delivery with ironic lyrics"

---

10. 놀림 행진곡

특징:

* 군가/행진곡처럼 당당하고 박력 있는 느낌
* 친구의 습관을 엄청 진지하게 외치면 웃김
* 구호형 Hook에 좋음
* 박자감이 또렷해야 함

가사 반영:

* 짧고 힘 있는 문장을 사용해라.
* Hook은 구호처럼 반복해라.
* 행진 추임새는 (괄호)로 넣어도 된다. 필수는 아니다.
* 넣는다면 매번 다른 표현을 만들어라. 매 곡 똑같은 추임새 금지.

style 예:
"short complete 45-second Korean march song, no intro, no outro, no bridge, repeated strong hook, clear ending feel, military-style snare rhythm, comic chant vocals"

---

11. 발리우드

특징:

* 인도 영화 OST처럼 화려하고 드라마틱한 느낌
* 타블라(tabla) 리듬 + 시타르(sitar) 멜로디 + 화려한 스트링
* 신나는 군무 장면이 떠오르는 댄스 비트
* 과장된 감정 표현과 극적인 멜로디
* 단체로 따라 부르는 후렴이 잘 어울림
* 놀림 포인트를 영화 주인공 서사처럼 과장하면 웃김

가사 반영:

* 대상의 특징을 발리우드 영화 주인공처럼 거창하게 묘사해라.
* Hook은 단체 군무 후렴처럼 흥겹고 따라 부르기 쉽게 작성해라.
* 가사는 한국어로 쓰되, 리듬감을 살려 들썩이는 느낌으로 써라.
* 인도풍 추임새는 (괄호)로 넣어도 된다. 필수는 아니다.
* 넣는다면 매번 다른 표현을 만들어라. 매 곡 똑같은 추임새 금지.
* 너무 추임새만 많아지면 안 된다.
* 발리우드 느낌은 추임새보다 style(타블라/시타르/떼창)로 살리는 게 우선이다.

★ 발리우드 style 작성 특별 규칙 ★

"bollywood"라는 단어 하나만으로는 부족하다.
반드시 아래 키워드를 모두 조합해서 구체적으로 작성해라:

* Bollywood dance number
* energetic tabla and dhol percussion (타블라/돌 타악기)
* sitar riffs and lush Indian strings (시타르 + 스트링)
* dramatic cinematic melody
* group chorus chanting (단체 떼창 후렴)
* festive Indian wedding party energy
* playful Hindi-film masala vibe

style 예:
"short complete 45-second Bollywood dance number with Korean lyrics, energetic tabla and dhol percussion, sitar riffs and lush Indian strings, dramatic cinematic melody, group chorus chanting, festive Indian wedding party energy, playful Hindi-film masala vibe, no intro, no outro, no bridge, repeated strong hook, clear ending feel, comic energy"

---

12. 힙합

특징:

* 자신감 넘치는 디스랩 느낌 (세게 까는 게 아니라 장난스럽게)
* 묵직한 808 베이스 + 또박또박한 비트
* 고개 까딱이는 그루브, 라임 살린 플로우
* 펀치라인(한 방 먹이는 줄)이 잘 어울림

가사 반영:

* Verse는 라임을 살려 또박또박 끊어 쳐라.
* Hook은 따라 외치기 쉬운 짧은 구호로.
* 한 방 먹이는 펀치라인을 Hook이나 Verse 끝에 배치해라.

---

13. K-pop

특징:

* 밝고 세련된 아이돌 팝
* 캐치한 멜로디 훅, 영어 포인트 한두 개 OK
* 반짝이는 신스, 댄스 비트
* 후렴이 화려하고 중독적

가사 반영:

* Hook을 가장 멜로딕하고 캐치하게 만들어라.
* 영어 포인트 단어를 1~2개 정도 섞어도 좋다 (과하지 않게).
* 밝고 통통 튀는 에너지를 유지해라.

---

14. 락

특징:

* 신나고 반항적인 밴드 사운드
* 일렉기타 + 드럼 + 베이스, 떼창 후렴
* 시원하게 내지르는 느낌
* 답답한 상황을 외쳐서 푸는 맛

가사 반영:

* Hook은 다 같이 떼창하듯 시원하게 외치는 줄로.
* Verse는 점점 고조되게 써라.
* 짧고 강한 문장으로 내지르는 느낌을 살려라.

---

15. 로파이

특징:

* 잔잔하고 나른한 lo-fi 비트
* 먼지 낀 피아노, 빈티지한 분위기
* 힘 빼고 시크하게 읊조리는 느낌
* 무심하게 툭 던지는 디스가 더 웃김

가사 반영:

* 힘주지 말고 무심하게 읊조리듯 써라.
* 과장보다 담담하게 팩트로 놀리는 게 이 장르의 맛이다.
* Hook도 나른하게, 조용히 반복되는 느낌으로.

---

16. 쌈바

특징:

* 흥겨운 브라질 카니발 리듬
* 빠른 타악기(수르두/판데이루), 밝은 브라스
* 다 같이 외치는 콜앤리스폰스
* 신나서 몸이 들썩이는 분위기

가사 반영:

* Hook은 다 같이 외치고 받는 느낌으로.
* 흥겹고 들썩이는 짧은 문장 위주로.
* 추임새는 (괄호)로 소량만, 매번 다르게.

---

★★ 추임새 표기 절대 규칙 ★★

추임새("요를레이히", "얼쑤", "지화자", "올레", "둠칫", "짝짝", "헤이", "하나 둘" 등)는
절대 **별도 줄**로 쓰지 마라.
반드시 본 가사 줄 끝에 **(괄호)** 로 붙여라.

이유: 별도 줄로 쓰면 Suno가 "후렴은 추임새만 부르는 것"으로 잘못 알아듣고
본 가사를 노래로 안 부른다. (괄호) 표기는 Suno가 백보컬·애드립으로 처리해서
메인 보컬은 본 가사를 또렷이 부른다.

나쁜 예 (가사가 안 불림):
[Hook]
요를레이히
배 나왔네
요를레이히
이 냄새는 뭐니

좋은 예 (가사가 또렷이 불림):
[Hook]
배 나왔네 (요를레이히)
이 냄새는 뭐니 (요를레이히)
배 나왔네 (요를레이히)
단추가 도망가네 (요를레이)

같은 규칙이 요들송("요를레이히"), 킹받 트로트("얼쑤", "아이고"), 놀림 챈트("짝짝", "헤이"),
뽕짝 EDM("둠칫"), 놀림 행진곡("하나 둘"), 발리우드("아이야이야"), 모든 장르에 적용된다.
괄호 안 추임새는 줄당 1개만, 짧게 써라.

Hook의 모든 줄은 반드시 의미 있는 한국어 가사여야 한다.
추임새만으로 줄을 채우는 것은 절대 금지.

★★ 추임새 사용 여부/다양성 규칙 ★★

추임새는 **필수가 아니다.** 매 곡마다 넣을 필요 없다.

위 가이드와 예시에 나온 추임새("요를레이히", "쿵짝", "니나노", "아이야이야", "발레발레" 등)는
**표기 방법을 보여주기 위한 예시일 뿐**이다.
절대 매번 그 단어를 그대로 복사해서 쓰지 마라.

추임새 사용 원칙:

1. 추임새 없이 가사만으로 충분히 좋으면 → 추임새를 아예 넣지 마라.
   추임새 없는 곡이 더 깔끔하고 좋은 경우가 많다.

2. 추임새를 넣기로 했다면 → 그 곡의 가사 내용, 분위기, 놀림 포인트에 어울리는
   추임새를 매번 새로 만들어라.
   예시 단어를 그대로 쓰는 것보다, 가사와 연결되는 추임새가 훨씬 좋다.
   (예: 먹는 걸 놀리는 곡이면 "냠냠", "꿀꺽" / 지각을 놀리는 곡이면 "헐레벌떡" 같은 식)

3. 같은 장르라도 곡마다 추임새가 달라야 한다.
   요들송이라고 매번 "요를레이히"만 쓰면 모든 곡이 똑같이 들린다.

4. 추임새를 넣더라도 곡 전체에서 1~2번이면 충분하다.
   모든 줄에 붙이지 마라.

핵심: 추임새는 양념이다. 매번 똑같은 양념을 치면 새로운 노래가 아니다.

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

나쁜 예:

"맨날 늦잠 자더니 또 지각이야
Moonlight dancing in my galaxy fire"

"올챙이배 꼬집기 대마왕
너는 나의 superstar"

---

[좋은 구조 예시]

[Verse]
알람 다섯 개 꺼놓고
양말 한 짝 또 찾고
커피 들고 뛰어나와
엘베 앞에서 숨차네

[Pre-Hook]
맨날 오늘은 안 늦는대
근데 시계는 못 속이네

[Hook]
지각 장인 또 등장
가방 메고 뛰어와
지각 장인 또 등장
가방 메고 뛰어와
지각 장인 또 등장
가방 메고 뛰어와
지각 장인 또 등장
시계가 너를 포기했네

왜 좋은가:

* Verse에서 장면이 보임
* Pre-Hook이 Hook으로 자연스럽게 이어짐
* Hook이 두 번 반복되면서 귀에 박히고 곡이 충분히 길어짐
* 마지막 줄만 바꿔서 노래의 마무리처럼 느껴짐
* 1절 + Hook 반복으로 40~50초 완성곡처럼 끝난다
* (위 문장은 예시다. 그대로 복사하지 말고 매 곡 새로 만들어라.)

---

[style 작성 규칙]

style 필드는 Suno AI에 넘기는 영어 음악 스타일 설명이다.
선택된 장르의 음악적 맛(악기·리듬·창법·분위기)이 또렷하게 드러나야 한다.

style은 반드시 아래 두 부분을 합쳐서 작성해라.

(1) 위 [이 장르의 style 키워드]에 주어진 영어 키워드를 그대로 가져온다.
    → 이 키워드가 그 장르의 핵심 악기·리듬·창법이다. 절대 빼거나 바꾸지 마라.

(2) 거기에 아래 공통 키워드를 덧붙인다:
    "short complete 45-second song, no intro, no outro, no bridge,
     strong hook played twice, clear ending feel, playful comic mood"

즉 style = (1)장르 키워드 + (2)공통 키워드 를 한 문장으로 이어 쓴 것이다.

★ 다른 장르의 악기/키워드를 섞지 마라.
  예) [장르]=트로트인데 "kpop synth" 넣지 마라.
  예) [장르]=요들송인데 "808 trap beat" 넣지 마라.

나쁜 style 예 (장르 특징 없음, 뭉뚱그림):
"short 45-second playful Korean comedy pop"

좋은 style 예 (장르 키워드 + 공통 키워드 결합):
"Korean boom-bap hip hop, punchy 808 bass, crisp trap hi-hats, head-nodding groove, confident rap-sung flow, short complete 45-second song, no intro, no outro, no bridge, strong hook played twice, clear ending feel, playful comic mood"

---

출력 규칙:

* 실제 노래 가사처럼 자연스럽게 작성
* 너무 시적이거나 난해하게 쓰지 마라
* 듣자마자 상황이 이해되게 작성해라
* 대상 캐릭터가 선명하게 떠오르게 작성해라
* Hook은 Verse보다 강하게 작성해라
* Hook은 짧고 중독성 있게 작성해라
* Hook은 반드시 두 번 반복한다 (A/B/A/B 를 2번 = 총 8줄, 마지막 줄만 B')
* 마지막 Hook의 마지막 줄은 노래의 엔딩처럼 느껴지게 작성해라
* 선택된 장르의 특징이 가사와 style에 모두 느껴지게 작성해라
* 감정 흐름이 중간에 끊기지 않게 작성해라
* 키워드 삽입보다 캐릭터 표현을 우선시해라
* 전체 가사는 14줄로 작성해라 (Verse 4 + Pre-Hook 2 + Hook 4 + Hook 반복 4)
* [Hook] 태그는 한 번만 쓰고 그 아래 8줄을 모두 넣어라
* 설명 없이 JSON만 출력해라

---

아래 JSON 형식으로만 응답해라.
설명 문장은 절대 쓰지 마라.
lyrics의 [Hook]은 8줄(A/B/A/B/A/B/A/B')이다. 반드시 8줄을 채워라.

{
"title": "2~8글자 중심의 짧고 킹받는 노래 제목. 키워드 나열 금지. 놀리는 별명이나 한마디처럼 작성",
"style": "선택된 장르의 특징이 반영된 영어 Suno AI 스타일 설명. short complete 45-second song, no intro, no outro, no bridge, repeated strong hook played twice, clear ending feel, genre-specific rhythm, instruments, vocal style, melody feel 포함",
"lyrics": "[Verse]\n...\n...\n...\n...\n\n[Pre-Hook]\n...\n...\n\n[Hook]\nA\nB\nA\nB\nA\nB\nA\nB'"
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
  const models = ['claude-opus-4-8', 'claude-sonnet-4-6'];
  const errors = [];
  for (const model of models) {
    let me = '';
    // 429/503/529(과부하)는 1~2초 backoff 후 1회 재시도
    for (let a = 0; a < 2; a++) {
      try {
        // ⚠️ thinking은 켜지 않는다.
        // 가사는 "짧은 창작 + JSON 한 덩어리" 출력 작업인데, adaptive thinking을 켜면
        // 모델이 생각(thinking)에 max_tokens를 다 써버려 정작 가사 JSON(text 블록)이
        // 안 나오는 "200 bad JSON"이 발생한다(실측 확인됨).
        // Opus 4.8은 thinking 없이도 충분히 똑똑하므로, 프롬프트의 자체검토 지시(4번 규칙)에
        // 맡기고 바로 JSON을 쓰게 한다 → 품질 유지 + JSON 안정 + 속도 향상.
        const body = { model, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] };
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body)
        });
        if (r.ok) {
          const d = await r.json();
          const text = (d.content || []).map(b => b.text || '').join('');
          const p = extractLyricsJson(text);
          if (p) return { success: true, data: p };
          me = `${model}: 200 bad JSON`; break;
        }
        const e = await r.text();
        me = `${model}: HTTP ${r.status} ${e.slice(0, 120)}`;
        if (r.status === 429 || r.status === 503 || r.status === 529) { await new Promise(z => setTimeout(z, (a + 1) * 1000)); continue; }
        if (r.status === 404) break;   // 모델명 문제 → 다음 모델로
        break;
      } catch (e) { me = `${model}: ${e.message}`; }
    }
    errors.push(me);
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
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 2000 })
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
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1.0, maxOutputTokens: 2000, responseMimeType: 'application/json' } })
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
      has_coupang_keys: !!(process.env.COUPANG_ACCESS_KEY && process.env.COUPANG_SECRET_KEY),
      credits_enabled: CREDITS_ENABLED,
      payments_enabled: CREDITS_ENABLED && !!process.env.PORTONE_V2_API_SECRET,
      admin_enabled: CREDITS_ENABLED,
      cost_per_song: COST_PER_SONG,
      signup_bonus: SIGNUP_BONUS,
      referral_reward: REFERRAL_REWARD,
      share_reward: SHARE_REWARD,
      last_lyrics_error: LAST_LYRICS_ERROR   // 가장 최근 가사 생성 실패 원인(진단용)
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
    await getOrCreateUser(a.uid, a.email);
    // 접속 시 만료된 충전 포인트 정리 (lazy expiry)
    await reconcileExpiry(a.uid);
    // 정리 후 최신 상태 다시 읽기
    const u = await getOrCreateUser(a.uid, a.email);
    // 다가오는 소멸 예정 안내 (30일 이내 만료될 lot 합산)
    const warn = upcomingExpiry(u, Date.now());
    return send(res, 200, {
      enabled: true,
      credits: u.credits || 0,
      cost: COST_PER_SONG,
      freeCredits: u.free || 0,
      paidCredits: u.paid || 0,
      refCode: u.refCode || null,
      shareReward: SHARE_REWARD,
      expiringSoon: warn        // { amount, expireAt(ISO), days } | null
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

  // 충전(유료) 포인트 내역 + 소멸 예정일. 접속 시 만료분 정리 후 살아있는 충전 lot을 반환.
  if (path === '/paid-lots') {
    if (!CREDITS_ENABLED) return send(res, 200, { enabled: false, lots: [] });
    const a = await verifyAuthFull(req);
    if (!a) return send(res, 401, { error: 'auth_required', message: '로그인이 필요해요' });
    await getOrCreateUser(a.uid, a.email);
    await reconcileExpiry(a.uid);
    const snap = await fdb.collection('users').doc(a.uid).get();
    const data = snap.exists ? snap.data() : {};
    const now = Date.now();
    const lots = paidLotsView(data, now)
      .sort((x, y) => String(y.chargedAt).localeCompare(String(x.chargedAt)));  // 최신 충전 먼저
    return send(res, 200, {
      enabled: true,
      paidCredits: (splitPools(data).paid) || 0,
      lots,
      expiringSoon: upcomingExpiry(data, now)
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
      await markLastGrant(uid, SHARE_REWARD, 'share');
      return send(res, 200, { ok: true, credits: result.credits, credited: SHARE_REWARD });
    } catch (e) {
      return send(res, 500, { error: 'share_reward_fail', message: '잠시 후 다시 시도해주세요' });
    }
  }

  // 쿠팡 파트너스 골드박스 특가 상품 (배너용, 30분 캐시)
  if (path === '/coupang-goldbox') {
    const result = await fetchCoupangGoldbox();
    if (!result.ok) return send(res, 200, { ok: false, products: [], error: result.error });
    // 배너에는 최대 10개만 보내서 응답 크기 절약
    return send(res, 200, { ok: true, products: result.products.slice(0, 10) });
  }

  // 충전 상품 목록 (금액→크레딧). 프론트가 표시/결제요청에 사용.
  if (path === '/packs') {
    const packs = Object.entries(CREDIT_PACKS)
      .map(([amount, p]) => ({
        amount: Number(amount),
        credits: p.credits,
        base: p.base,
        bonus: p.bonus,
        songs: p.base + p.bonus
      }))
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
          const meta = ur.metadata || {};
          const lastSignIn = meta.lastSignInTime || null;
          const lastRefresh = meta.lastRefreshTime || null;
          // 마지막 접속 = 가장 최근(토큰 갱신 시각이 보통 더 최신)
          const lastAccessAt = [lastSignIn, lastRefresh].filter(Boolean).sort().pop() || null;
          users.push({
            uid: ur.uid,
            email: ur.email || null,
            signupAt: meta.creationTime || null,
            lastAccessAt,
            disabled: !!ur.disabled
          });
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
      const paidExpiryAt = await computeNextPaidExpiry(u.uid, p.paid);
      out.push({
        uid: u.uid,
        email: u.email,
        disabled: u.disabled,                        // 차단(탈퇴) 여부
        signupAt: createdAt || u.signupAt,           // 가입 일자
        lastAccessAt: u.lastAccessAt,                // 마지막 접속(토큰 갱신/로그인 중 최근)
        totalCredits: p.freeGranted + p.paidGranted, // 총 크레딧(누적 지급)
        availableCredits: p.free + p.paid,           // 가용 가능 크레딧(현재 잔액)
        freeCredits: p.free,                         // 무료 크레딧 보유
        paidGranted: p.paidGranted,                  // 충전 크레딧(총 충전)
        paidCredits: p.paid,                         // 충전 크레딧 중 가용
        paidExpiryAt                                  // 다음에 소멸될 충전 건 만료일(ISO) | null
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

  // [관리자] 통계 (KST 기준). query: date 또는 from/to. 장르·키워드 집계.
  if (path === '/admin/stats') {
    if (!(await verifyAdmin(req))) return send(res, 401, { error: 'admin_auth_required', message: '관리자 인증이 필요해요' });
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const singleDate = url.searchParams.get('date');
    let from = url.searchParams.get('from');
    let to = url.searchParams.get('to');
    if (singleDate) { from = to = singleDate; }
    if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
      return send(res, 400, { error: 'bad_date', message: '날짜 형식이 YYYY-MM-DD가 아니에요 (date 또는 from/to 필요)' });
    }
    if (from > to) { const t = from; from = to; to = t; }
    const start = new Date(from + 'T00:00:00+09:00');
    const end = new Date(new Date(to + 'T00:00:00+09:00').getTime() + 24 * 60 * 60 * 1000);
    const genreMap = {};
    const kwMap = {};
    let count = 0, uniqueUsers = new Set();
    try {
      const qs = await fdb.collection('songs').where('createdAt', '>=', start).where('createdAt', '<', end).get();
      qs.forEach(d => {
        const x = d.data();
        count++;
        if (x.uid) uniqueUsers.add(x.uid);
        const g = x.genre || 'unknown';
        genreMap[g] = (genreMap[g] || 0) + 1;
        const raw = String(x.keywords || '');
        if (raw) {
          const tokens = raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length >= 2);
          for (const k of tokens) kwMap[k] = (kwMap[k] || 0) + 1;
        }
      });
    } catch (e) {
      return send(res, 500, { error: 'stats_fail', message: '통계 조회 실패', detail: e.message });
    }
    const genres = Object.entries(genreMap).map(([genre, c]) => ({ genre, count: c })).sort((a, b) => b.count - a.count);
    const keywords = Object.entries(kwMap).map(([keyword, c]) => ({ keyword, count: c })).sort((a, b) => b.count - a.count).slice(0, 30);
    return send(res, 200, { ok: true, from, to, count, uniqueUsers: uniqueUsers.size, genres, keywords });
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
      const r = await restoreUserAccount(String(uid));
      return send(res, 200, { ok: true, restored: r.restored, restoredFree: r.restoredFree, restoredPaid: r.restoredPaid });
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
    const pack = CREDIT_PACKS[paidAmount];
    if (!pack) return send(res, 400, { error: 'unknown_amount', message: '알 수 없는 결제 금액이에요', amount: paidAmount });
    const credits = pack.credits;

    const result = await creditPaymentOnce(uid, String(paymentId), credits, paidAmount);
    if (!result.already) {
      await logCredit(uid, credits, 'paid', 'purchase');
      await markLastGrant(uid, credits, 'purchase');
    }
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
    // 보안: 에러 문자열에 API 키 값이 섞여 들어올 수 있다(예: 키 칸에 curl 명령을 통째로
    // 붙여넣은 경우). LAST_LYRICS_ERROR는 공개 /health에 노출되므로 키 패턴을 반드시 가린다.
    const debug = `claude[${cErr}] solar[${sErr}] gemini[${r.error}]`
      .replace(/\b(up_[A-Za-z0-9]+|sk-[A-Za-z0-9_\-]+|AIza[A-Za-z0-9_\-]+)/g, '***')
      .replace(/Bearer\s+\S+/gi, 'Bearer ***');
    LAST_LYRICS_ERROR = { at: new Date().toISOString(), debug };
    console.error('❌ 가사 생성 전체 실패:', debug);
    // 실패 원인을 한국어로 분류해 사용자에게 힌트 제공
    let hint = 'AI 서버가 지금 바빠요. 잠시 후 다시 시도해주세요.';
    // 주의: 그냥 "invalid"로 매칭하면 Solar의 "invalid header value"(키 값 오타) 같은
    // 비-인증 에러까지 "인증 오류"로 오진된다. 진짜 인증 신호만 좁게 매칭한다.
    if (/\b401\b|\b403\b|authentication|invalid x-api-key|invalid api key|permission_error/i.test(debug)) {
      hint = 'AI 인증 오류예요(API 키 문제). 관리자 확인이 필요해요.';
    } else if (/credit|quota|billing|insufficient|402|payment/i.test(debug)) {
      hint = 'AI 사용량(크레딧)이 소진된 것 같아요. 관리자 확인이 필요해요.';
    } else if (/429|rate.?limit|overload|529|503/i.test(debug)) {
      hint = 'AI 서버가 잠시 몰렸어요. 10~20초 후 다시 시도해주세요.';
    } else if (/bad JSON/i.test(debug)) {
      hint = '가사 형식 처리에 실패했어요. 한 번 더 시도해주세요.';
    }
    return send(res, 503, { error: 'lyrics_failed', message: hint, debug });
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
