#!/usr/bin/env node
/**
 * 유행어 자동 검색 — 단독 검증 스크립트
 *
 * 가사 서버에 넣은 lookupKeywordMeanings()와 "동일한 로직"으로,
 * 키워드를 네이버에 검색해 어떤 뜻을 찾아내는지 미리 눈으로 확인한다.
 * (LLM 키 불필요. 네이버 검색 API 키만 있으면 됨.)
 *
 * 네이버 검색 API 키 발급(무료): https://developers.naver.com/apps → 검색 API 등록
 *
 * 실행:
 *   NAVER_CLIENT_ID=아이디 NAVER_CLIENT_SECRET=시크릿 node staging/slang-test.js 밤티 야르샤갈 머리숱적음
 *   (키워드를 인자로 안 주면 기본 예시로 테스트)
 */
const id = process.env.NAVER_CLIENT_ID, sec = process.env.NAVER_CLIENT_SECRET;
if (!id || !sec) {
  console.error('❌ NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 필요해요.');
  console.error('   예) NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=... node staging/slang-test.js 밤티');
  process.exit(1);
}
const kws = process.argv.slice(2).length ? process.argv.slice(2) : ['밤티', '야르샤갈', '머리숱 적음', '늦잠'];

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function naverSearch(kind, query, display) {
  const url = `https://openapi.naver.com/v1/search/${kind}.json?query=${encodeURIComponent(query)}&display=${display || 3}&sort=sim`;
  const r = await fetch(url, { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': sec } });
  if (!r.ok) { console.log(`   (검색 실패 HTTP ${r.status})`); return null; }
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : null;
}
// 서버(server.js)의 extractMeaning과 동일 로직 — 정의 문장 우선 추출
function extractMeaning(keyword, descs) {
  const joined = descs.join('  ').replace(/\s+/g, ' ').trim();
  if (!joined) return '';
  const re = new RegExp(escapeRe(keyword) + '[\\s\\S]{0,6}?(?:은|는|이란|란|이라는|뜻은|뜻이|의미는|를 뜻|를 의미|이라고)[\\s\\S]{2,70}');
  const m = joined.match(re);
  if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 110);
  return joined.slice(0, 180);
}

(async () => {
  console.log('\n🔎 유행어 자동 검색 테스트 (개선판)\n');
  for (const kw of kws) {
    const [blog, kin] = await Promise.all([naverSearch('blog', kw + ' 뜻', 3), naverSearch('kin', kw + ' 뜻', 2)]);
    const items = [...(blog || []), ...(kin || [])];
    if (!items.length) { console.log(`■ "${kw}" → 검색 결과 없음\n`); continue; }
    const blob = stripTags(items.map((it) => it.title + ' ' + it.description).join(' '));
    const isSlang = /신조어|유행어|밈|MZ|줄임말/.test(blob);
    if (!isSlang) { console.log(`■ "${kw}"  (일반 단어 — AI에 안 넘김, 평소 뜻대로 해석)\n`); continue; }
    const meaning = extractMeaning(kw, items.map((it) => stripTags(it.description)));
    console.log(`■ "${kw}"  🔥(신조어 감지)`);
    console.log(`   → AI에 전달될 뜻: ${meaning}\n`);
  }
  console.log('판단: 신조어는 "진짜 뜻"이 잡히고, 평범한 단어는 아예 제외되는지 확인하세요.');
  console.log('좋으면 → 서버(proxy/server.js)에 NAVER 키만 넣으면 가사 생성에 자동 적용됩니다.\n');
})().catch((e) => { console.error('❌ 예외:', e); process.exit(1); });
