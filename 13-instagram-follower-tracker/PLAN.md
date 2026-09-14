# PLAN — Instagram 팔로워 데일리 트래킹 (메타태그 방식, 1차)

## 핵심 분기: STEP 1이 런타임을 결정한다 → **B 확정 (2026-08-28)**
`og:description` 메타태그를 **어디서 GET 하면 잘 오는지**를 실측함:
- 로컬 국내 IP + 크롤러 UA(`facebookexternalhit/1.1`) → **OK** (팔로워 613명 등 5계정).
- Apps Script(구글 데이터센터 IP), 동일 UA → **5계정 모두 HTTP 200 인데 메타 없음**(로그인 월).
- **결론: 경로 A(Apps Script) 폐기, 경로 B(로컬 Python) 채택.** 구현은 `track.py`.

| 경로 | 조건 | 스택 | 스케줄 | 장점 |
|------|------|------|--------|------|
| **A. Apps Script** | 구글 서버 IP에서도 메타태그가 옴 | Apps Script(`UrlFetchApp`) | 시간 트리거 | PC 상주·서비스계정 불필요, 워크스페이스 idiom(01/03/12) 일치 |
| **B. 로컬 Python** | 구글 IP는 막히고 국내 IP만 됨 | Python `requests` + `gspread` | launchd/cron | 국내 IP로 안정 수집 |

> ponytail: 되는 쪽 하나만 만든다. A가 되면 A로 끝(가장 단순). 안 되면 B.

## STEP별 진행 (각 STEP 종료 시: 완료내용/파일/테스트/남은문제/다음단계 보고)

### STEP 1 — 메타태그 수집 가능성 프로브
- (A안 테스트) Apps Script에서 `UrlFetchApp.fetch(url, {headers:{'User-Agent':..., 'Accept-Language':'ko-KR'}})` → `og:description` 존재/파싱 확인.
- (B안 테스트) 로컬에서 `curl`/`requests`로 동일 확인.
- 5계정 각각 결과:
  ```
  raonsecure → OK (팔로워 613명)
  jiransecu  → LOGIN_REQUIRED (메타태그 없음)
  ...
  ```
- **완료 기준: 런타임(A/B) 확정.** 이후 STEP은 확정된 런타임으로 진행.

### STEP 2 — 프로젝트 골격
- (A) `src/*.gs` 바인딩 프로젝트 / (B) `src/*.py` 단일 스크립트.
- ACCOUNTS 시트(또는 accounts.csv) + RAW_DATA 시트 헤더 생성.
- 완료 기준: 시트 5계정 설정 로드 확인.

### STEP 3 — 수집기 + 정규화
- `fetchFollowers(username)`: GET → og:description 추출 → `normalizeFollower()`.
- `normalizeFollower(text)`: 613명/6,130명/1.2만명/12K/1.3M → 정수. 순수 함수 + 테스트.
- 실패 시 followers=NULL + status(LOGIN_REQUIRED/ELEMENT_NOT_FOUND/TIMEOUT).
- 완료 기준: T1, T4, T6 통과.

### STEP 4 — 시트 저장 (upsert)
- `upsertRaw(date, username, ...)`: date+username 있으면 갱신, 없으면 추가.
- 완료 기준: T2, T3 통과(중복 실행해도 계정당 1건).

### STEP 5 — 증감 + 이상치
- 직전 성공 기록 대비 daily_change 계산(과거 없으면 빈 값).
- ±30%(Config) 초과 시 DATA_WARNING.
- 완료 기준: T5, T7 통과.

### STEP 6 — 그래프 / 대시보드
- 계정별 팔로워 추이 선그래프(피벗 범위 → 5라인). 상단 카드형 현재값+증감.
- 완료 기준: 시트에 차트 렌더 확인.

### STEP 7 — 스케줄
- (A) 09:00 시간 트리거 + onOpen 수동실행 메뉴 / (B) launchd·cron 09:00.
- 완료 기준: 자동 1회 실행으로 RAW_DATA 누적 확인.

### STEP 8 — 전체 테스트 + README
- T1~T7 실행 요약. README에 설치·운영·트러블슈팅(로그인 월 대응 포함).

## 주요 함수
| 함수 | 역할 |
|------|------|
| `readAccounts()` | 계정 설정 로드 |
| `fetchFollowers(username)` | GET → og:description → 팔로워 정수 |
| `normalizeFollower(text)` | 표기 → 정수 (유틸, 테스트) |
| `upsertRaw(...)` | date+username upsert |
| `computeDelta()` | 전일 대비 증감 + 이상치 판정 |
| `updateChart()` | 팔로워 추이 그래프 |
| `runCollection()` | 전체 파이프라인 |

## 리스크 & 대응
| 리스크 | 대응 |
|--------|------|
| 구글 IP에서 로그인 월 | 경로 B(로컬 Python 국내 IP) |
| 국내 IP도 일부 계정 차단 | 해당 계정만 status=LOGIN_REQUIRED, 최후수단 세션 쿠키(시크릿 관리) |
| 메타태그 문구/구조 변경 | 파싱 함수 1곳만 수정(격리) |
| 레이트리밋 | 하루 1회·5계정·요청 간 지연 |

## 정리 작업
- 이전 API/Playwright 방향 산출물 폐기: `track.py`(현 버전 재작성 예정), `com.ig-tracker.daily.plist`, `requirements.txt`는 경로 확정 후 정리.

## 완료(전체) 기준
매일 09:00 자동 실행 → RAW_DATA에 계정당 1건(실패는 NULL+status) 누적 → 증감·추이 그래프 갱신 → LOG 기록. T1~T7 통과.
