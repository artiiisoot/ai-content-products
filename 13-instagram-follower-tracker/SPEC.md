# SPEC — Instagram 팔로워 데일리 트래킹 (메타태그 방식, 1차)

> 작고 안정적인 1차 버전. 지정 계정들의 팔로워 수를 매일 1회 수집·누적하고 Google Sheets에서 추이를 본다.

## 목표
아래 5개 계정의 **팔로워 수(그날 시점 총수 Snapshot)** 를 매일 1회 수집, 날짜별 누적.
확인 정보: 현재 총 팔로워 / 전일 대비 증감 / 계정별 추이 그래프 / 수집 성공·실패 여부.

| company | username | profile_url |
|---------|----------|-------------|
| 라온시큐어 | raonsecure | https://www.instagram.com/raonsecure/ |
| 파수 | fasoo_ai_official | https://www.instagram.com/fasoo_ai_official/ |
| 지란지교시큐리티 | jiransecu | https://www.instagram.com/jiransecu/ |
| 알약이x알탱이 | alyac.co.kr | https://www.instagram.com/alyac.co.kr/ |
| 안랩 | ahnlab_insta | https://www.instagram.com/ahnlab_insta/ |

## 수집 방식 — og:description 메타태그 파싱
API·로그인·브라우저 자동화 없이, **공개 프로필 HTML의 `og:description` 메타태그**에서 팔로워 수를 추출한다.

예시(실제):
```html
<meta property="og:description"
 content="팔로워 613명, 팔로잉 0명, 게시물 224개 - 라온시큐어(@raonsecure)님의 Instagram 사진 및 동영상 보기">
```
- 절차: `GET profile_url` → HTML에서 `og:description` content 추출 → `팔로워 ([\d,.만천K M]+)명` 매칭 → 숫자 정규화.
- 이 값은 프로필 첫 HTML에 실려 오므로 로그인 불필요.

### 성립 전제 (STEP 1에서 실측, 가정 금지)
- 인스타는 **데이터센터 IP**(구글 Apps Script 서버 등)에 로그인 월을 띄워 메타태그를 안 줄 수 있음. **국내 일반 IP(로컬 PC)** 에선 대체로 정상.
- 따라서 **실행 위치(런타임)** 는 STEP 1 프로브 결과로 확정한다:
  - Apps Script `UrlFetchApp`로 메타태그가 오면 → **Apps Script 채택**(시트·스케줄 모두 네이티브, PC 상주 불필요).
  - 안 오면 → **로컬 Python 러너 + 시트 연동**으로 전환(국내 IP 사용).
- `Accept-Language: ko-KR`, 일반 브라우저 `User-Agent` 헤더를 붙여 한국어 메타태그를 받는다.

## 숫자 정규화 (별도 유틸 + 테스트)
`og:description`의 표기를 정수로 변환:
`"613명" → 613`, `"6,130명" → 6130`, `"1.2만명" → 12000`, `"12K" → 12000`, `"1.3M" → 1300000`.
- 정규식으로 "팔로워"와 "명" 사이 토큰만 추출 후 만/천/K/M 배수 적용.

## 저장 구조 (Google Sheets, 별도 DB 없음)
### ACCOUNTS — 계정 설정 (하드코딩 금지)
`company, username, profile_url, enabled`

### RAW_DATA — 수집 원본
`date, collected_at, company, username, followers, status, error_message`
- **Unique Key = date + username.** 같은 날 재실행해도 중복 Row 금지(있으면 갱신).
- **수집 실패 시 followers 는 빈 값(NULL), 0 저장 절대 금지.**

### status 값
`SUCCESS, LOGIN_REQUIRED, ELEMENT_NOT_FOUND, TIMEOUT, DATA_WARNING, UNKNOWN_ERROR`
- 실패가 그래프에서 "팔로워 감소"처럼 보이면 안 됨(NULL 처리).

## 증감 / 그래프
- **전일 대비 증감** = 오늘 followers − 직전 성공 기록 followers. 과거 없으면 빈 값(0 강제 금지).
- **그래프**: 계정별 팔로워 추이 선그래프(X=날짜, Y=followers, 5계정). 시트 차트로 표시.

## 이상 데이터 검증
- 전일 대비 **±30%(Config 변경 가능) 이상 급변** 시 `status = DATA_WARNING`(값은 저장하되 경고).

## 실행 시간 / 프로세스
매일 **09:00** 자동 실행: `수집 → RAW_DATA upsert → 증감 계산 → 그래프/대시보드 갱신 → LOG 기록`.

## 인증정보
- 메타태그 방식은 **토큰·로그인 불필요**가 원칙.
- 만약 로컬 IP에서도 로그인 월이 뜨는 계정이 있으면, 최후수단으로 세션 쿠키가 필요할 수 있음 → 그 경우 Script Properties/환경변수로만 관리(코드·시트 저장 금지).

## 로그
LOG 시트에 RUN_START / 계정별 결과 / RUN_COMPLETE(SUCCESS n, FAILED m).

## 테스트
- T1 계정별 수집 성공/실패
- T2 5계정 연속 실행
- T3 중복 실행 → 날짜별 계정당 1건 유지
- T4 잘못된 username → followers=0 아니라 ERROR
- T5 전일 증감 계산
- T6 숫자 정규화(613명/6,130명/1.2만명/12K/1.3M)
- T7 이상치(±30%) → DATA_WARNING

## 범위 / 원칙
- 팔로워 수 수집만. 좋아요·댓글·게시물·Reels·AI분석·관리자페이지·별도DB 없음.
- 수집/분석 분리, 계정·인증정보 하드코딩 금지, 실패값 0 금지, 날짜 중복 금지, 불필요 라이브러리 금지.
- 과거 데이터 복원 안 함 — 시작일부터 누적.

## 미해결 / 진행 전 확인
- **STEP 1 프로브 결과에 따라 런타임(Apps Script vs 로컬 Python) 확정.** 이게 전체 구조의 분기점.
