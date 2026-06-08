# 다음 세션 인수인계 — kie.ai 가사 싱크 검증 (1단계)

사용자가 **방법 1**(환경 네트워크 열고 Claude가 직접 검증 실행)을 선택했음.

## 배경
- 운영 앱: diss4u.com (GitHub Pages) + Render 프록시(chinolsong-proxy). 현재 곡 생성 = APIFRAME.
- 문제: 영상 가사 싱크가 "전혀 안 맞음". 원인 = Suno가 줄별 타임스탬프를 안 줘서 균등 분배 추측 중.
- 해결책: **타임스탬프를 주는 업체(kie.ai/sunoapi.org)로 교체**. 그 전에 1단계로 품질 검증.
- 이전 세션의 작업 환경은 외부 네트워크 차단(403)이라 kie.ai 호출 불가였음 → 사용자가 환경 Network access를 Full(또는 Custom: api.kie.ai, *.kie.ai)로 바꾸고 새 세션 시작하기로 함.

## 이 세션에서 할 일
1. 네트워크 열렸는지 확인:
   `node -e "fetch('https://api.kie.ai/api/v1/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.message))"`
   - 401/403(키 없음) 정도면 연결 OK. ERR(타임아웃/차단)이면 아직 막힘 → 사용자에게 환경설정 재확인 요청.
2. 사용자에게 **kie.ai API 키**를 받는다(채팅으로). 민감정보이므로 검증 후 재발급 가능함을 안내.
3. 검증 실행:
   `PROVIDER=kie KIE_API_KEY=<키> node staging/kie-verify.js`
4. 산출물 `staging/out/preview-standalone.html` 을 **SendUserFile 로 사용자에게 전달**(음원 내장, 더블클릭으로 싱크 확인 가능). `song.mp3` 도 함께 보내도 됨.
5. 추가로 timestamps.json 으로 정렬 품질(단어 수, 신뢰도, 처음 몇 단어 타이밍)을 요약 보고.

## 판단 기준
- 🎧 음질이 APIFRAME만큼 되나?  🎯 단어가 실제 노래에 맞나(오프셋 약간 보정 수준이면 합격)?
- 합격 → 2단계(복제 사이트 + 테스트 Render 서버에 kie.ai 연동)로 진행.
- 불합격 → `PROVIDER=sunoapi SUNOAPI_KEY=<키>` 로 재시도, 그래도 별로면 종료(운영 무영향).

## 주의
- 운영 코드(`/index.html`, `/proxy/server.js`)는 **절대 건드리지 말 것**. 모든 작업은 `staging/` 안에서.
- 키는 환경변수로만. 코드/깃에 절대 커밋 금지(.gitignore에 out/, *.mp3, .env 등록됨).
- 작업 브랜치: `claude/festive-cannon-4Rxgi`.
