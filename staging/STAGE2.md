# 2단계 — kie.ai 연동 복제 사이트 (로컬 테스트)

> ⚠️ 운영(diss4u.com)·운영 서버 무영향. 전부 `staging/` 안에서만 돈다.

## 구성
- `kie-music.js` — kie.ai 연동 모듈(곡 생성·폴링·타임스탬프·정규화·적응형 lead)
- `test-server.js` — 운영과 같은 라우트를 kie로 구현한 독립 프록시
  - `POST /generate-song`, `GET /song-status/:id` → kie.ai
  - `POST /generate-lyrics` → **운영 워커로 패스스루**(가사는 Claude/Solar/Gemini 그대로)
- `clone.html` — `index.html` 복제본. 기본 워커를 테스트 서버로, 영상 가사 싱크를
  **단어별 타임스탬프 기반 노래방 하이라이트**로 교체(없으면 기존 균등분배로 폴백)

## 돌려보기 (로컬)
```bash
# 1) 테스트 서버 실행 (곡 1개 생성 시 kie 크레딧 ~10 소모)
KIE_API_KEY=발급키 node staging/test-server.js     # http://localhost:3100

# 2) 복제 사이트 열기 (같은 폴더에서 정적 서버)
cd staging && python3 -m http.server 8080
#   → 브라우저: http://localhost:8080/clone.html
```
- 복제본의 워커 URL은 기본이 `http://localhost:3100`. (화면 워커 URL 칸에서 변경 가능)
- 가사 생성 → 곡 생성(kie) → 결과 화면에서 "영상 만들기" → 단어 단위 싱크 확인.

## 연동 지점(운영 이식 시)
| 운영 파일 | 위치 | 바꿀 것 |
|---|---|---|
| proxy/server.js | `/generate-song`, `/song-status/` | APIFRAME→kie (kie-music.js 로직 이식, 크레딧/Firebase 유지) |
| index.html | `pollSongStatus` resolve | `timestampedLyrics` 동봉 |
| index.html | `STATE.currentSong` | `timestampedLyrics` 저장 |
| index.html | `drawVideoFrame` 가사 블록 | `drawTimedLyrics` 분기 추가 |

## 판단 기준
- 곡 생성·재생이 운영과 동일하게 흐르는가
- 영상 가사가 단어 단위로 노래에 맞게 켜지는가(검증 단계 미리보기와 동일 체감)
- OK → 운영 proxy/server.js·index.html에 이식(별도 승인 후).
