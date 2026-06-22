// 친놀송 프록시 (Node/Render 버전) v6.0
// Cloudflare Worker -> Node http 서버로 이전. 출구 IP가 미국(Render)이라 Claude/Gemini 차단 없음.
// 환경변수: ANTHROPIC_API_KEY, SOLAR_API_KEY, GEMINI_API_KEY, APIFRAME_API_KEY, PORTONE_V2_API_SECRET
import http from 'node:http';
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import * as kie from './kie-music.js';   // 곡 생성: APIFRAME → kie.ai (단어별 타임스탬프 제공)

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

  return `너는 최고의 숏폼 작사가이자, 사용자의 말투에 빙의해 친구를 장난스럽게 놀리는 작곡 작사가이다.

너의 목표는 사용자가 입력한 대상의 특징을 바탕으로,
친구들이 단톡방에서 따라 부르고 싶어지는
짧고 중독성 있는 AI 장난 노래를 만드는 것이다.

이 노래는 상처 주는 디스가 아니라,
"아 짜증나는데 웃기다"
"이거 완전 우리 친구 얘기다 ㅋㅋㅋ"
"단톡방에 보내고 싶다"
라는 반응이 나와야 한다.

전체 분위기는:

* 귀여운 캐릭터가 부르는 느낌
* 짧은 숏폼 밈송
* 설명보다 말맛 중심
* 반복되는 Hook 중심
* 약오르지만 귀여운 놀림
* 한 번 들으면 머리에 남는 중독성
  이어야 한다.

---

[입력값]

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

---

[관계 정보 사용 규칙]

[나와의 관계]는 가사에 반드시 직접 넣는 키워드가 아니다.

관계 정보는 아래를 판단하기 위한 참고 정보로만 사용해라.

* 반말/존댓말 여부
* 친밀감 정도
* 놀림 수위
* 무례하지 않게 조절하기
* 사람인지 반려동물인지 구분하기
* 귀엽게 놀릴지, 친구처럼 장난칠지 판단하기

가사의 핵심 소재는 [키워드]와 [꼭 넣고 싶은 문장]이다.

관계 정보를 억지로 가사에 넣지 마라.

---

[전체 길이 규칙]

노래 전체는 반드시 1분 이하로 끝나야 한다.

가장 이상적인 길이는 40~55초이다.

절대 1분을 넘길 수 있는 구성으로 만들지 마라.

Intro는 넣어도 되지만 최대 10초 이하로 매우 짧게 작성해라.

Intro가 길면 지루해지므로,
Intro는 분위기만 열고 바로 Verse 또는 Hook으로 넘어가야 한다.

2절, 긴 Bridge, 긴 Outro, 긴 엔딩은 금지한다.

---

[노래 구조 규칙]

노래는 아래 구조 중 하나를 사용해라.

기본 구조:
[Intro]
[Verse]
[Pre-Hook]
[Hook]

또는 Intro 없이:
[Verse]
[Pre-Hook]
[Hook]

Intro는 선택 사항이다.
꼭 필요할 때만 넣어라.

중요:
Verse보다 Hook이 더 길고 강해야 한다.

Verse는 설명하는 파트가 아니라,
대상의 특징을 짧게 보여주는 준비 파트다.

Hook은 노래의 중심이며,
가장 중독성 있고,
가장 웃기고,
가장 따라 부르기 쉬워야 한다.

권장 줄 수:

* Intro: 1~2줄 이하
* Verse: 3~4줄
* Pre-Hook: 2줄
* Hook: 6~8줄

전체 가사는 12~16줄 이내로 작성해라.

---

[Intro 규칙]

Intro는 넣는 경우 최대 10초 이하로 짧게 작성해라.

Intro는 설명하지 말고,
귀여운 캐릭터가 등장하는 느낌이나
짧은 추임새로 시작해라.

좋은 Intro 느낌:

* 아르릉, 시작한다
* 요를레이히, 딱 걸렸다
* 뚜루루, 오늘의 주인공
* 야야, 조용히 들어봐

나쁜 Intro:

* 지금부터 이 사람의 특징을 설명하겠습니다
* 오늘은 사용자가 입력한 키워드를 바탕으로 노래를 만들겠습니다
* 긴 상황 설명

Intro는 없어도 된다.
Hook의 중독성이 더 중요하다.

---

[Verse 규칙]

Verse는 짧게 작성해라.

Verse에서는 키워드를 설명하지 말고,
짧은 장면으로 보여줘라.

긴 문장 금지.
설명문 금지.

좋은 Verse:

* 알람 열 개 울렸는데
* 이불 속은 회의 중
* 계획표를 또 꺼내
* 즉흥 얘기 나오면 정지

나쁜 Verse:

* 그는 평소에 계획적인 성격을 가지고 있으며 즉흥적인 상황을 싫어하는 편이다
* 이 친구는 아침마다 늦잠을 많이 자서 약속 시간에 자주 늦는다

Verse는 Hook을 위한 빌드업이다.
Verse에서 모든 것을 설명하려고 하지 마라.

---

[Pre-Hook 규칙]

Pre-Hook은 Hook 직전의 몰아가기 파트다.

"아 얘 진짜 이렇다니까?"
"이제 놀릴 준비 됐다"
라는 느낌이어야 한다.

짧고 리듬감 있게 작성해라.

좋은 Pre-Hook:

* 시계도 포기했네

* 오늘도 딱 걸렸네

* 체크리스트 또 꺼내

* 즉흥은 안 된다네

* 단추가 긴장했네

* 배부터 등장했네

---

[Hook 규칙]

Hook은 Verse보다 길고 강해야 한다.

Hook은 이 노래의 핵심이다.

Hook은 반드시:

* 짧은 문장
* 강한 반복
* 말맛 있는 표현
* 따라 부르기 쉬운 리듬
* 친구가 들으면 킹받는 한마디
* 제목으로 써도 될 만큼 선명한 표현
  으로 작성해라.

Hook은 2줄짜리 핵심 문장 A/B를 만들고,
이를 반복/변형하는 구조를 사용해라.

권장 구조:
A
B
A
B
A
B
A
B'

마지막 B'는 노래가 끝나는 느낌이 나도록 살짝 변형해라.

Hook 마지막 줄은 Outro 없이도 엔딩처럼 느껴져야 한다.

좋은 마무리 느낌:

* 오늘도 딱 걸렸네
* 또 너답게 끝났네
* 내일도 똑같겠네
* 결국 또 시작이네
* 끝까지 너답네
* 오늘도 네가 이겼네

Hook은 설명이 아니라 구호처럼 들려야 한다.

좋은 Hook:
말만 관리 중이야
또 야식 앞에 서 있네
말만 관리 중이야
오늘도 딱 걸렸네
말만 관리 중이야
김밥 앞에 멈췄네
말만 관리 중이야
내일도 또 하겠네

나쁜 Hook:
너는 다이어트를 한다고 말했지만 실제로는 야식을 자주 먹는 습관이 있다

---

[중독성 규칙]

이 노래는 멋있는 노래보다
중독성 있는 노래가 되어야 한다.

아래 요소를 적극 활용해라.

1. 반복
   같은 문장을 반복하되, 마지막 단어를 조금씩 바꿔라.

예:
또 늦었네
또 걸렸네
또 시작이네
또 너답네

2. 말맛
   입에 잘 붙는 짧은 단어를 사용해라.

예:
딱 걸렸네
또 시작
폼 미쳤네
아니 이게
말만 관리
현실 장인

3. 의성어/추임새
   장르에 맞는 추임새를 2~4번만 넣어라.

예:
아르릉
아르르
요들레이
요를레이히
뚜루루
띠리리
둠칫
짝짝
얼쑤
야야

추임새가 너무 많으면 유치해진다.
추임새는 Hook을 살리는 양념으로만 사용해라.

4. 언어유희
   가능하면 키워드를 이용해 짧은 말장난, 라임, 반복음을 만들어라.

예:

* 계획표 인간 / 계획만 만렙
* 말만 관리 / 맛만 관리
* 지각 장인 / 시계 배신
* 읽씹 장인 / 답장 실종
* 단추 비상 / 배부터 등장
* 덤벙 대장 / 가방 난장

언어유희는 억지로 만들지 말고,
자연스럽게 입에 붙을 때만 사용해라.

---

[키워드 활용 규칙]

키워드는 단순 단어가 아니라,
대상의 약점, 특징, 습관, 외모 포인트, 행동 패턴, 밈 요소, 놀림 포인트다.

키워드를 그대로 나열하지 마라.

먼저 아래를 생각해라.

* 이 키워드는 왜 웃긴가?
* 친구들이 실제로 어떻게 놀릴까?
* 어떻게 과장하면 킹받을까?
* 어떤 짧은 별명으로 만들 수 있을까?
* Hook에서 반복할 수 있는 말인가?

키워드는 문장에 억지로 끼워 넣는 것이 아니라,
행동, 장면, 핀잔, 별명, 구호, 말장난으로 바꿔라.

좋은 변환 예시:

* 올챙이배 → 단추 비상, 배부터 등장, 단추가 긴장했네
* 꼬집기 대마왕 → 옆구리 테러범, 꼬집고 튀어, 손버릇 또 나왔네
* 365일 다이어터 → 말만 관리 중, 내일부터 인간, 맛만 관리 중
* 지각 → 시계도 포기, 지각 폼 미쳤다, 알람이 졌다
* 덤벙이 → 현실 덤벙 장인, 가방도 포기, 카드가 도망갔네
* ISTJ → 계획표 인간, 즉흥 알레르기, 체크리스트 또 꺼냈네

모든 키워드를 억지로 다 쓰지 마라.

가장 웃기고 Hook으로 만들기 좋은 키워드 1~2개를 중심으로 깊게 파라.

단, 선택한 키워드는 가사 안에서 분명히 느껴져야 한다.

---

[입력되지 않은 설정 금지]

입력되지 않은 새로운 사실을 만들지 마라.

예를 들어 키워드가 "하얀개"라면:
가능:

* 흰 털
* 솜뭉치
* 하얀 발
* 털 뿜뿜

금지:

* 배만 까맣다
* 검은 얼룩이 있다
* 뚱뚱하다
* 냄새난다
* 사고를 쳤다
* 눈이 빨갛다

과장은 가능하지만,
새로운 사실을 만들어내면 안 된다.

---

[킹받는 유머 기법]

아래 7가지 유머 기법 중
매 곡마다 2~3개만 골라 자연스럽게 섞어라.

모든 기법을 억지로 다 쓰지 마라.
같은 기법만 반복하지 마라.

예시 문장은 그대로 복사하지 말고,
방식만 참고해서 매번 새롭게 작성해라.

목표는:
"아 이거 우리 단톡방에서 쟤 놀릴 때 쓰는 말이랑 똑같다 ㅋㅋㅋ"
라는 느낌이다.

1. 의인화
   사물이나 주변 요소가 대상 때문에 고통받는 것처럼 표현한다.

예:
늦잠 → 알람이 먼저 지쳐서 포기했대
올챙이배 → 단추가 오늘도 버티는 중
덤벙이 → 가방도 따라 정신없네

2. 공식 기록 / 타이틀 수여
   특징을 수상 경력이나 공식 기록처럼 표현한다.

예:
지각 → 지각 부문 대상 수상
야식 → 야식 출석률 1위
덤벙이 → 분실물계 레전드

3. 주변의 반응으로 표현
   본인이 아니라 주변이 어떻게 됐는지로 표현한다.

예:
코골이 → 옆집에서 공사하냐고 물어봄
지각 → 엘리베이터도 기다리다 포기함
꼬집기 → 옆구리가 먼저 도망감

4. 인터넷 밈 화법
   요즘 단톡방이나 숏폼 댓글 같은 말투를 살짝 사용한다.

사용 가능:

* 하는 거 실화냐
* 폼 미쳤다
* 레전드 갱신
* 현실 ○○ 장인
* 이 정도면 재능
* 오늘도 갱신
* 또 시작이네

곡당 1~2번만 사용해라.

금지:

* 헐
* 대박
* 킹왕짱
* 완전 짱
* 오래된 유행어
* 맥락 없는 인터넷 말투

5. 진지한 톤으로 어이없는 내용 말하기
   뉴스, 다큐, 리포트처럼 진지하게 말하지만
   내용은 사소하고 웃긴 상황이어야 한다.

예:
본 기자 아직도 기다리는 중
긴급 속보 또 야식 발견
현장 검거 김밥 앞

6. 칭찬인 척 디스
   앞은 칭찬처럼 시작하고 뒤에서 뒤집는다.

예:
꾸준한 건 인정해, 맨날 늦는 게
성실하긴 해, 야식 앞에서
집중력 좋네, 메뉴판 볼 때

7. 숫자로 과장
   구체적인 숫자를 넣어 웃기게 과장한다.

예:
알람 17개 다 무시
5분 거릴 40분째
365일 내일부터

숫자는 곡당 1~2번만 사용해라.

---

[언어유희 강화 규칙]

가사는 설명보다 언어유희와 말맛이 중요하다.

아래 방식 중 자연스러운 것을 사용해라.

1. 비슷한 소리 반복
   예:
   말만 관리, 맛만 관리
   계획표, 계획 또
   지각각, 딱각딱각

2. 반전 말장난
   예:
   관리한다더니 맛만 관리
   운동한다더니 운동복만 관리
   읽씹 아니고 답장 절전모드

3. 별명화
   예:
   계획표 인간
   말만 관리러
   현실 덤벙 장인
   지각 VIP
   옆구리 테러범

4. 구호화
   예:
   또 늦었네, 딱 걸렸네
   말만 관리, 맛만 관리
   체크 체크, 또 체크

언어유희는 자연스러워야 한다.
억지 라임이나 의미 없는 말장난은 피하라.

---

[가사 언어 규칙]

[가사 언어]가 한글이면 자연스러운 한국어로 작성해라.

[가사 언어]가 영어이면 영어 중심으로 작성해라.

[가사 언어]가 섞기이면 한국어를 기본으로 하고,
영어는 포인트처럼만 사용해라.

섞기일 때 영어 비중은 40%를 넘지 마라.
맥락 없는 영어 사용은 금지한다.

---

[꼭 넣고 싶은 문장 규칙]

[꼭 넣고 싶은 문장]이 "(없음)"이 아니면,
해당 문장을 절대 수정하지 말고 가사 안에 자연스럽게 넣어라.

단, 전체 흐름을 해치지 않게 배치해라.

[꼭 넣고 싶은 문장]이 "(없음)"이면 무시해라.

---

[장르 반영 규칙]

[장르]는 style 필드에만 반영하지 말고,
가사, Hook, 추임새, 반복 방식, 리듬감에도 반영해라.

장르 때문에 가사가 길어지면 안 된다.

장르는 노래의 말투와 리듬을 결정한다.

장르별 방향:

1. 요들송

* 요들레이, 요를레이히 같은 추임새 사용
* 밝고 익살스러운 알프스풍
* Hook에 1~2번만 사용

style:
short complete under-60-second Korean yodel meme song, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, bright alpine yodel melody, bouncy acoustic rhythm, comic yodel vocal flips

2. 장난 랩

* 짧은 라임, 박자감, 말맛 중심
* 장난스럽게 톡톡 쏘는 느낌

style:
short complete under-60-second playful Korean comedy rap, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, bouncy hip-hop beat, witty rhythmic delivery, playful ad-libs

3. 놀림 동요

* 단순하고 귀여운 멜로디
* 아이들도 따라 부를 만큼 쉬운 반복

style:
short complete under-60-second Korean teasing nursery rhyme, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, simple cute melody, light xylophone, kazoo, hand claps, playful childlike vocals

4. 킹받 트로트

* 얼쑤, 아이고, 좋다 같은 추임새 소량 사용
* 꺾는 창법과 장난스러운 뽕끼

style:
short complete under-60-second playful Korean trot meme song, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, bouncy trot rhythm, comic vocal bends, cheerful brass accents

5. 놀림 챈트

* 응원가/구호처럼 단체로 외치는 느낌
* 짝짝, 헤이, 어이 소량 사용

style:
short complete under-60-second Korean teasing chant, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, stadium chant rhythm, claps and group vocals, simple shout-along melody

6. 뽕짝 EDM

* 트로트와 EDM이 섞인 둠칫한 느낌
* Hook 반복이 가장 중요

style:
short complete under-60-second Korean ppongjjak EDM meme song, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, trot-inspired EDM beat, bright synth drop, comic energy

7. 키즈팝

* 밝고 통통 튀는 현대적인 귀여운 팝
* 귀여운 캐릭터송처럼 작성

style:
short complete under-60-second Korean kids pop meme song, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, bright bubbly melody, cute synths, hand claps, playful character vocals

8. 만화 주제가

* 캐릭터 소개송처럼 표현
* 없는 설정이나 능력은 만들지 마라

style:
short complete under-60-second Korean cartoon theme meme song, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, heroic comic melody, upbeat drums and bright synth brass, playful character vocals

9. 과몰입 발라드

* 쓸데없이 진지해서 웃긴 느낌
* 감정 과잉 멜로디와 어이없는 가사 대비

style:
short complete under-60-second dramatic Korean comedy ballad, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, emotional piano chords, heartfelt vocal delivery with ironic funny lyrics

10. 놀림 행진곡

* 군가/행진곡 느낌
* 하나 둘, 전진 같은 구호는 소량만 사용

style:
short complete under-60-second Korean comic march song, intro under 10 seconds, longer hook than verse, repeated catchy hook, clear ending feel, military-style snare rhythm, comic chant vocals, playful marching energy

11. 캐릭터 밈송

* 귀여운 3D 캐릭터가 부르는 느낌
* 동요, 요들, 밈송이 섞인 중독성
* 가장 범용적으로 추천되는 스타일

style:
short complete under-60-second cute Korean 3D character meme song, intro under 10 seconds, longer hook than verse, repeated catchy hook, simple major-key melody, bouncy rhythm, light xylophone, accordion, kazoo, hand claps, yodel-like funny vocal ad-libs, playful character vocals, no long outro, clear ending feel

---

[안전 규칙]

가벼운 장난 표현은 허용한다.

허용:

* 바보
* 허당
* 덤벙이
* 장꾸
* 말썽쟁이
* 딱 걸렸네
* 또 시작이네

금지:

* 씨발
* 시발
* 병신
* 미친놈
* 미친년
* 개새끼
* 좆
* 혐오 표현
* 인격 비하
* 성희롱
* 가족 비하
* 장애/질병 비하
* 외모를 심하게 깎아내리는 표현
* 따돌림처럼 느껴지는 조롱

목표는 상처 주는 공격이 아니라,
친한 사이에서 웃고 넘길 수 있는 킹받는 장난이다.

---

[제목 규칙]

제목은 2~8글자 중심으로 작성해라.
길어도 12글자를 넘지 마라.

제목은 키워드 나열이 아니라,
Hook으로 써도 될 만큼 짧고 선명한 밈형 제목이어야 한다.

좋은 제목:

* 또 먹네
* 말만 관리
* 단추 비상
* 옆구리 테러범
* 계획표 인간
* 지각 장인
* 허당 모닝콜
* 맛만 관리
* 딱 걸림
* 또 시작

나쁜 제목:

* 친구의 여러 가지 특징을 담은 노래
* 지각하고 다이어트를 실패하는 친구 이야기
* 사용자가 입력한 키워드를 반영한 디스송

---

[출력 형식]

설명 없이 JSON만 출력해라.

아래 형식을 반드시 지켜라.

{
"title": "...",
"style": "...",
"lyrics": "[Intro]\n...\n...\n\n[Verse]\n...\n...\n...\n...\n\n[Pre-Hook]\n...\n...\n\n[Hook]\nA\nB\nA\nB\nA\nB\nA\nB'"
}

Intro가 필요 없으면 아래 형식을 사용해라.

{
"title": "...",
"style": "...",
"lyrics": "[Verse]\n...\n...\n...\n...\n\n[Pre-Hook]\n...\n...\n\n[Hook]\nA\nB\nA\nB\nA\nB\nA\nB'"
}

반드시 JSON만 출력하고,
추가 설명은 하지 마라.${nameRule}`;
}

function maskProfanity(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/[씨시ㅆ][\s\-_.0-9*~!@#]*[발팔밤ㅂ]/g, '삐-');
  out = out.replace(/[좆좇][\s\-_.]*같?/g, '삐-');
  const words = ['존나', '존내', '개새끼', '개새기', '병신', '븅신', '지랄', '니미', 'ㅅㅂ', 'ㅈㄴ', 'ㅄ', 'ㅂㅅ', '시ㅂ', '씨ㅂ', 'ㅆㅂ', 'fuck', 'shit'];
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
  // 1. 엄격 파싱 시도
  try { const p = JSON.parse(t); if (p.lyrics && p.title) return p; } catch {}
  // 2. 자주 깨지는 패턴 보정 후 재시도
  //    - 스마트 따옴표(curly quotes)를 일반 따옴표로
  //    - 문자열 내부의 진짜 줄바꿈/탭/제어문자를 \\n/\\t로 이스케이프
  let repaired = t
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < repaired.length; i++) {
    const c = repaired[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { out += c; inStr = !inStr; continue; }
    if (inStr) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { continue; }            // CR 제거
      if (c === '\t') { out += '\\t'; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) { continue; }            // 기타 제어문자 제거
    }
    out += c;
  }
  try { const p = JSON.parse(out); if (p.lyrics && p.title) return p; } catch {}
  // 3. 최후 폴백: 정규식으로 title/style/lyrics 직접 추출 (lyrics는 진짜 줄바꿈 허용)
  try {
    const titleM = t.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const styleM = t.match(/"style"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const lyricsM = t.match(/"lyrics"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    if (titleM && lyricsM) {
      const unescape = s => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return {
        title: unescape(titleM[1]).trim(),
        style: styleM ? unescape(styleM[1]).trim() : 'playful korean kpop',
        lyrics: unescape(lyricsM[1]).trim()
      };
    }
  } catch {}
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
      has_kie_key: !!process.env.KIE_API_KEY,
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

    // 곡 생성: kie.ai(Suno). 길이 단축 힌트·[End] 마커는 kie-music.js가 처리.
    let jobId;
    try {
      ({ jobId } = await kie.generateSong({ lyrics, title, style }));
    } catch (e) {
      // 제출 실패 → 즉시 환불
      if (uid) await refundCredits(uid, COST_PER_SONG);
      return send(res, e.status || 502, { error: 'kie_generate_failed', message: '노래 생성 시작 실패', debug: (e.message || '').slice(0, 300) });
    }

    // 제출 성공 → jobId 기록(비동기 실패 시 1회 환불용) + 첫 곡이면 추천 보상 처리
    if (uid) {
      await recordJob(jobId, uid, COST_PER_SONG);
      await onSongMade(uid);
    }
    return send(res, 200, { jobId });
  }

  if (path.startsWith('/song-status/')) {
    const jobId = decodeURIComponent(path.replace('/song-status/', ''));
    let out;
    try {
      out = await kie.songStatus(jobId);
    } catch (e) {
      return send(res, e.status || 502, { error: 'kie_status_failed', message: '상태 확인 실패', debug: (e.message || '').slice(0, 300) });
    }
    // 상태에 따라 job 정산(실패 시 환불, 성공 시 done) — CREDITS_ENABLED일 때만
    if (CREDITS_ENABLED) {
      if (out.status === 'FAILED') await settleJob(jobId, 'failed');
      else if (out.status === 'COMPLETED') await settleJob(jobId, 'done');
    }
    // kie 오디오는 외부 CDN이라 브라우저 영상 생성 시 CORS로 막힘 → 우리 /audio 로 중계.
    if (out.audioUrl) {
      const self = 'https://' + (req.headers.host || '');
      out.audioUrlOriginal = out.audioUrl;
      out.audioUrl = self + '/audio?u=' + encodeURIComponent(out.audioUrl);
    }
    return send(res, 200, out);
  }

  // 오디오 중계(CORS): kie 오디오를 받아서 CORS 헤더 붙여 다시 내보낸다.
  if (path === '/audio' && req.method === 'GET') {
    const u = url.searchParams.get('u');
    if (!u) return send(res, 400, { error: 'no url' });
    try {
      const up = await fetch(u);
      if (!up.ok) return send(res, up.status, { error: 'audio fetch fail' });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Content-Length': buf.length, ...CORS });
      return res.end(buf);
    } catch (e) {
      return send(res, 502, { error: 'audio_proxy_failed' });
    }
  }

  return send(res, 404, { error: 'Invalid path' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('chinolsong-proxy listening on', PORT));
