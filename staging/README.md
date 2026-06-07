# staging — 새 업체 가사 싱크 검증 (1단계)

> ⚠️ **이 폴더는 운영 앱(diss4u.com)과 완전히 분리돼 있어요.**
> 여기서 뭘 해도 실제 사이트·서버·회원·결제엔 **영향이 전혀 없습니다.**
> 운영 코드(`/index.html`, `/proxy/server.js`)는 한 글자도 안 건드렸어요.

## 목적
새 업체(**kie.ai** 또는 **sunoapi.org**)가 주는 **단어별 타임스탬프**로
가사가 노래에 진짜로 딱딱 맞는지 **돈 거의 안 쓰고 눈으로** 확인하는 단계.

## 준비물
1. 새 업체 가입 → **API 키 발급** (kie.ai는 신규 무료 크레딧 있음)
   - kie.ai: https://kie.ai  → 키 발급
   - sunoapi.org: https://sunoapi.org → 키 발급
2. Node 18+ (이미 깔려 있으면 OK)

## 쓰는 법

### ① 검증 스크립트 실행 (곡 생성 + 타임스탬프 받기)
키는 **환경변수로만** 넣으세요. 절대 코드에 적거나 깃에 올리지 마세요.

```bash
# kie.ai 로 테스트
PROVIDER=kie KIE_API_KEY=발급받은키 node staging/kie-verify.js

# sunoapi.org 로 테스트
PROVIDER=sunoapi SUNOAPI_KEY=발급받은키 node staging/kie-verify.js
```

선택 옵션:
```bash
MODEL=V5            # V4 / V4_5 / V5
TITLE="내 디스곡"
STYLE="korean hiphop diss"
LYRICS_FILE=./my-lyrics.txt   # 내 가사로 테스트하고 싶을 때
```

성공하면 `staging/out/` 에 이렇게 생겨요:
- `song.mp3` — 생성된 노래
- `timestamps.json` — 단어별 타이밍(미리보기용으로 정규화됨)
- `timestamps-raw.json`, `generate-response.json` — 업체 원본 응답(문제 생기면 이걸 보고 알려주세요)

### ② 싱크 눈으로 확인 (preview.html)
브라우저 보안상 `file://` 로 열면 데이터 로딩이 막힐 수 있어요. 간단 서버로 여세요:

```bash
cd staging
python3 -m http.server 8080
# 또는:  npx serve .
```
그리고 브라우저에서 **http://localhost:8080/preview.html** 접속 →
재생 누르고 **단어가 노래에 맞춰 켜지는지** 확인.
살짝 밀리면 화면의 **‘오프셋 보정’** 슬라이더로 전체를 앞뒤로 맞춰볼 수 있어요.

## 판단 기준 (이 2개만 보면 됨)
- 🎧 **음질**: 지금(APIFRAME)이랑 비슷하거나 나은가?
- 🎯 **싱크**: 단어가 실제 노래랑 진짜 맞나? (오프셋 살짝 보정 정도로 맞으면 합격)

좋으면 → **2단계(복제 사이트·테스트 서버)**로 진행.
별로면 → 다른 업체로 `PROVIDER` 바꿔 한 번 더, 그래도 별로면 손해 없이 종료.

## 참고
- 응답 형식이 문서와 조금 다를 수 있어요. 그러면 스크립트가 `out/*.json` 에 원본을 남기니
  그걸 보고 필드명만 맞춰주면 됩니다.
- kie.ai / sunoapi.org 는 같은 Suno 공통 규격이라 한 스크립트로 둘 다 테스트돼요.
