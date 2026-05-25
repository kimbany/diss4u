# Diss4U — 프로젝트 상태 정리 (핸드오프 문서)

> 이 문서는 새 작업 세션이 지금까지의 맥락을 그대로 이어받기 위한 정리본이다.
> 마지막 업데이트: 2026-05-25

---

## 1. 앱 개요
- **이름**: Diss4U (This Song 4 U) — AI가 친구·지인·가족·반려동물을 웃기게 "놀리는" 디스곡(가사+노래)을 만들어주는 웹앱.
- **흐름**: 대상 이름/성별/관계/놀릴 키워드/장르/언어 입력 → AI가 가사 작성 → Suno로 노래 생성 → 듣기/다운로드/공유/인스타 영상.

---

## 2. 라이브 주소
- **메인 앱(프로덕션)**: https://diss4u.com  (GitHub Pages, `kimbany/diss4u` 저장소)
- **레거시 앱**: https://kimbany.github.io/chinolsong/  (같은 코드 사본, `invedory.com`에도 연결)
- **공유 듣기 페이지**: https://diss4u.com/share.html?id=<문서ID>
- **중계 서버(프록시)**: https://chinolsong-proxy.onrender.com  (Render)
- **서버 헬스체크**: https://chinolsong-proxy.onrender.com/health

---

## 3. 저장소(Repo) 구조 — ⚠️ 중요
| 저장소 | 내용 | 연결 도메인 |
|---|---|---|
| **`kimbany/diss4u`** (신규, 이 세션이 연결됨) | `index.html`, `share.html`, `CNAME`, `logo.png`, `README` | **diss4u.com** (프론트엔드 프로덕션) |
| `kimbany/kimbany.github.io` | 멀티 프로젝트. `chinolsong/`(앱 사본), **`proxy/`(서버 코드)**, 기타 앱들 | invedory.com |

**핵심 주의사항:**
- 이 세션은 `diss4u` 저장소에 연결 → **프론트엔드(index.html, share.html)는 여기서 직접 수정·배포** 가능 (커밋하면 diss4u.com에 자동 반영).
- 그러나 **서버 코드(`proxy/server.js`)는 `kimbany/kimbany.github.io` 저장소의 `proxy/` 폴더에 있음.** diss4u 저장소엔 없음.
  - 서버를 고치려면 그 저장소가 필요하거나, `proxy/`를 diss4u 저장소로 옮기는 것을 고려.
- 프론트 코드 사본이 두 곳(diss4u / chinolsong)에 존재 → **앞으로는 `diss4u` 저장소를 정본으로** 삼고, 필요시 수동 동기화.

---

## 4. 아키텍처
```
브라우저 (diss4u.com / GitHub Pages 정적 호스팅)
 ├─ Firebase Auth (구글 로그인)
 ├─ Firebase Firestore (곡 저장 + 크레딧 잔액)
 ├─ Render 프록시 (chinolsong-proxy.onrender.com)
 │    ├─ 가사 생성: Claude → Solar → Gemini  (앞에서부터 폴백)
 │    └─ 노래 생성: Apiframe (Suno V5)
 └─ Kakao SDK (공유)
```
- **왜 Render인가**: 원래 Cloudflare Workers였으나, Cloudflare 홍콩 출구 IP가 AI API(OpenAI/Groq/Gemini/Claude)에 차단당해 미국 리전 Render로 이전함. → **서버를 다시 Cloudflare로 옮기면 안 됨** (단, Cloudflare를 'DNS 전용'으로 쓰는 건 무관/안전).

---

## 5. 서버 (proxy/server.js, Render) — v7.0
**환경변수 (Render에 설정):**
- `ANTHROPIC_API_KEY`, `SOLAR_API_KEY`, `GEMINI_API_KEY` — 가사 LLM
- `APIFRAME_API_KEY` — 노래 생성(Suno)
- `FIREBASE_SERVICE_ACCOUNT` — Firebase 서비스 계정 JSON 전체 (크레딧 시스템용) ✅ 설정 완료

**엔드포인트:**
- `GET /health` — 상태/키 보유 여부/`credits_enabled` 확인
- `GET /me` — 로그인 유저 크레딧 잔액 조회 (없으면 신규 보너스 지급하며 생성)
- `POST /generate-lyrics` — 토큰검증+잔액확인(차감X) 후 가사 생성
- `POST /generate-song` — 토큰검증 + **트랜잭션 차감** 후 Apiframe 제출. 제출 실패 시 즉시 환불, jobId 기록
- `GET /song-status/:jobId` — 상태 폴링. FAILED면 환불(중복방지), 완료면 done 마킹
- `GET /claude-test` — 디버그

**크레딧 로직:**
- **1곡 = 10포인트**, **신규가입 보너스 = 20포인트(2곡)**
- `firebase-admin`으로 ID 토큰 검증 → 위조 차단
- Firestore `users/{uid}.credits` 트랜잭션 차감, 실패 시 환불
- `jobs/{jobId}` 문서로 비동기 실패 시 1회만 환불(중복 방지)
- `FIREBASE_SERVICE_ACCOUNT` 미설정 시 **레거시(무제한) 모드** → 안전장치
- 현재 상태: **활성화됨** (`/health`에서 `credits_enabled: true` 확인됨)

---

## 6. Firebase
- **프로젝트 ID**: `chinolsong`
- **프론트 config**(공개키, `index.html`에 그대로 — 정상):
  - apiKey: `AIzaSyAD2galkT_bYbtmOG6TSVIBdlLtByVbXZU`
  - authDomain: `chinolsong.firebaseapp.com`
  - projectId: `chinolsong`
- **Authentication**: 구글 로그인.
  - 승인된 도메인: `localhost`, `chinolsong.firebaseapp.com`, `diss4u.com`(추가됨 ✅). `www.diss4u.com`도 추가 권장. `invedory.com`/`kimbany.github.io`는 그대로 둠(삭제 금지).
- **Firestore 컬렉션**:
  - `songs/{id}` — 생성된 곡 (uid 기준)
  - `users/{uid}.credits` — 크레딧 잔액 (**서버 admin만 쓰기**)
  - `jobs/{jobId}` — 환불 추적 (클라 접근 차단)
- **보안 규칙** (게시 완료):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /songs/{id} {
      allow read: if true;
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.uid == request.auth.uid;
    }
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false;
    }
    match /jobs/{id} { allow read, write: if false; }
  }
}
```

---

## 7. 카카오
- **JS 키**(공개, `index.html`에 그대로): `16969f6e49aa409a9ebebe6af1a88554`
- 카카오 디벨로퍼스 → 플랫폼(Web) 사이트 도메인에 `https://diss4u.com` 추가 필요 (확인 요망)

---

## 8. 도메인 / DNS / SSL
- **diss4u.com** — Cafe24에서 구매, Cafe24 네임서버 사용.
- **DNS (Cafe24 → GitHub Pages)**:
  - A레코드: `diss4u.com → 185.199.108.153`
    - ⚠️ Cafe24는 루트 도메인 A레코드를 **1개만** 허용 → 1개만 설정(GitHub Pages는 1개로도 정상 동작). 나머지 IP(109/110/111.153)는 추가 불가했고 불필요.
  - www CNAME → `kimbany.github.io` (선택, 미확인)
- **GitHub Pages**: `diss4u` 저장소 → Settings → Pages → Source `main`/root, Custom domain `diss4u.com`, **DNS Check 통과 ✅**, Enforce HTTPS 체크(진행/완료).
- **SSL**: GitHub Pages 무료 자동(Let's Encrypt). Cafe24 유료 SSL 옵션은 **구매 안 함**(불필요).

---

## 9. 가격 / 수익 모델 (확정값)
- **단건 가격: 1곡 = ₩990** (확정)
- 크레딧 팩(예정): 예) ₩4,900=6곡, ₩9,900=15곡 — 단건은 990, 팩으로 할인
- **곡당 변동원가 ≈ ₩170** (가사 LLM ~₩20 + Apiframe/Suno ~₩150)
- **고정비 ≈ ₩11,000/월** (Render $7 + 도메인 ~₩1,500). Firebase 무료 한도 내.
- **과세: 간이과세자.** 연매출 4,800만 미만이면 **부가세 면제** (월 4,000곡 미만이면 해당).
- **곡당 순이익 ≈ ₩810**, **손익분기 ≈ 월 14곡**.
- **포인트 경제**: 1곡=10p, 신규 20p, (광고 보상은 짜게: 광고 3회=1p 권장), 친구 공유→가입 시 포인트.
- **광고**: 보조 수단 (원가 못 메움; 보상형 ₩10~15/시청). 나중에.

---

## 10. 결제 (다음 작업) — 포트원(PortOne)
- **선택한 결제사: 포트원(PortOne, 구 아임포트)** — 한 번 연동으로 **토스페이먼츠(카드) + 카카오페이** 동시 지원. 페이플은 백업 옵션.
- **순서**: 크레딧 토대(완료) → 포트원 충전 연동.
- **할 일**:
  1. 포트원 가맹점 가입 + 키 발급 (사용자가 직접; **테스트 키로 먼저 개발** 가능)
  2. 충전 UI (₩990=10p 등 팩)
  3. 결제창 → 결제 성공 시 **서버가 포트원 API로 검증 후 크레딧 적립** (서버 신규 엔드포인트 필요)
- **참고**: 사업자=개인사업자 보유. 신규 영세라 카드/카카오페이 수수료 ~1% 미만(영세 우대).

---

## 11. 완성된 기능
- 노래 생성(가사+곡), 입력 폼(이름/성별/관계/키워드/꼭넣을문장/장르/언어)
- 욕설 마스킹(서버 `maskProfanity`)
- 구글 로그인, 내 곡 리스트(Firestore), 곡 불러오기/삭제
- 카카오 공유, MP3 다운로드, 가사 복사
- 공유 듣기 페이지(`share.html`)
- **인스타용 영상 만들기**: Canvas + MediaRecorder. 오디오 주파수 반응 비주얼라이저(원형 바) + 가사 줄단위 표시 + **중앙 로고(logo.png) 비트 반응(둠칫둠칫)**. 공유시트/저장. 540×960 세로.
- **크레딧 시스템**: 헤더 잔액 뱃지(💎), 곡 생성 시 차감, 부족 시 안내.

---

## 12. 진행 중 / TODO
1. **`logo.png`를 diss4u 저장소 루트에 업로드** (인스타 영상 중앙 로고용). 없으면 마이크로 폴백.
2. 카카오 플랫폼에 `diss4u.com` 도메인 추가 확인
3. www CNAME / Enforce HTTPS 마무리 확인
4. **포트원 결제(충전) 연동** (위 10번)
5. 크레딧 팩 가격 최종 확정
6. **인스타 영상 가사 싱크 UX 재구상** — 현재는 곡 길이÷가사줄수로 균등 분배(진짜 비트 싱크 아님). 개선안: ① Apiframe 응답에 타임스탬프 있는지 확인 → 있으면 진짜 싱크, ② 없으면 비트 감지로 줄 넘김. (사용자가 "UI/UX 다른 방식으로 재구상" 원함)
7. 광고 (나중에)

---

## 13. 키/시크릿 위치 요약
- **진짜 시크릿** (절대 프론트 노출 금지): Claude/Apiframe/Solar/Gemini 키, Firebase 서비스 계정 → **Render 환경변수에만.**
- **공개 키** (노출돼도 됨): Firebase 프론트 config, Kakao JS 키 → `index.html`에 그대로. (보안은 Firestore 규칙이 담당)

---

## 14. 프론트 ↔ 서버 연결 메모
- `index.html`의 `DEFAULT_WORKER_URL = 'https://chinolsong-proxy.onrender.com'`
- 요청 시 헤더: `X-User-Id`(레거시) + `Authorization: Bearer <Firebase idToken>`(크레딧용)
- 개발자 설정(URL에 `?dev=1`)으로 Worker 주소 변경 가능(localStorage).
- ⚠️ Render 무료/유료: 현재 **$7 유료**(상시 가동). 무료면 콜드스타트로 첫 요청 ~30초 지연.
