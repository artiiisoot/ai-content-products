# 로컬 러너 (AI 추론)

일일요약(P2-02)과 주간 콘텐츠 후보(P2-03)를 생성하는 사내망 실행 스크립트.

> **누가 무엇을 보나**
> - 팀원(키워드 관리·결과 열람, 브라우저만) → [`../USAGE.md`](../USAGE.md)
> - 상주 Mac 자동 실행 설정(launchd) → [`../DEPLOY-mac.md`](../DEPLOY-mac.md)
> - 비상용으로 다른 Windows PC에서 1회 실행 → [`windows/README-Windows.md`](windows/README-Windows.md)
> - 러너 자체 실행/설정(아래 문서) → 운영자용
>
> ⚠️ 자동 실행(스케줄)은 **상주 Mac 한 대만** 해야 한다. 여러 곳에서 `daily`를 자동 실행하면 요약이 중복 기록된다.

## 왜 로컬인가
AI 추론은 사내 LiteLLM 게이트웨이(`litellm.ops.raonops.com`)로 해야 하는데, 이 주소는 **사내망에서만** 도달 가능하다. Apps Script(구글 서버)에서는 닿지 않으므로(`Address unavailable`), 추론만 사내망 로컬에서 돌리고 데이터는 Apps Script Web App을 통해 주고받는다.

```
[Apps Script] 수집(매일 8시) → 시트
     │  Web App doGet/doPost (토큰 인증)
     ▼
[로컬 러너] 시트 데이터 수신 → LiteLLM 게이트웨이 추론 → 결과를 시트에 기록
```

## 사전 준비

### 1) Apps Script Web App 배포
1. Apps Script 편집기 → **배포 > 새 배포 > 유형: 웹 앱**
2. 실행: **나**, 액세스 권한: **모든 사용자**
3. 배포 후 나오는 `.../exec` URL 복사
4. 스크립트 속성에 `WEBAPP_TOKEN` 추가(임의의 긴 난수 문자열) — 러너의 `WEBAPP_TOKEN` 과 동일하게

> Web App 은 토큰이 일치해야만 응답한다. 토큰이 곧 접근키이므로 외부에 노출 금지.

### 2) 러너 설정
```bash
cp .env.example .env
# .env 에 WEBAPP_URL, WEBAPP_TOKEN, LITELLM_KEY 채우기
```

## 실행 (사내망/VPN 연결 상태에서)
```bash
node --env-file=.env summarize.mjs daily     # 오늘 수집분 일일요약
node --env-file=.env summarize.mjs weekly     # 최근 7일 주간 콘텐츠 후보
node summarize.mjs selfcheck                   # 네트워크 없이 순수 로직 점검
```

- `daily`: 매일 수집(8시) 이후 실행. 오늘 수집 기사가 없으면 건너뜀.
- `weekly`: 주 1회 실행. 최근 7일 일일요약이 없으면 건너뜀.

## 자동화
상주 Mac에서 launchd로 예약하는 방법은 [`../DEPLOY-mac.md`](../DEPLOY-mac.md) 참고. (실행 시점에 사내망에 붙어 있어야 함)

## 트러블슈팅
- `환경변수 누락` → `.env` 값 확인, `--env-file=.env` 붙였는지 확인
- `Web App 오류(...): unauthorized` → `WEBAPP_TOKEN` 이 스크립트 속성과 다름
- `게이트웨이 오류 (401/403)` → `LITELLM_KEY` 문제
- `게이트웨이 오류` + 연결 실패 → 사내망(VPN) 미연결
- `게이트웨이 오류 (404 ... model)` → `MODEL` 값이 게이트웨이에 없는 모델명
