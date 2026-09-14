# 필수 규칙

진행 과정 및 결과 보고를 반드시 한글로 표기합니다.

# 서비스 기획 워크스페이스

여러 서비스 기획을 각각 독립된 폴더로 관리합니다.

## 기획 목록

| 폴더 | 기획명 | 상태 |
|---|---|---|
| `02-figma-brand-guard` | Figma 연동 CI/BI 버전 관리 및 검수 자동화 | SPEC 초안 |
| `03-news-collector` | 키워드 기반 국내 뉴스·보도자료 자동 수집 | SPEC 초안 |
| `04-business-card-collector` | 명함 사진/설문 데이터 수집 및 통합 정리 | SPEC 초안 |
| `05-keyword-query-monitor` | 데일리 키워드 쿼리량 모니터링 | SPEC/PLAN 초안 |
| `06-banner-photo-corrector` | 현수막 배경 인물사진 보정 자동화 | SPEC 초안 |
| `07-blog-automation` | AI 오피스 연동 블로그 콘텐츠 자동화 (Word 작성 → 네이버 비공개 등록) | SPEC 초안 |
| `08-homepage-change-tracker` | 홈페이지 변경사항 트래킹 자동화 (자사 검수 / 타사 동향파악) | SPEC 초안 |
| `09-naver-brand-search-monitor` | 네이버 브랜드검색 노출·소재 변경 모니터링 자동화 | SPEC 초안 |
| `10-mou-banner-generator` | MOU 현수막 디자인(Canva) 제작·추출 자동화 | SPEC 초안 |
| `13-instagram-follower-tracker` | 경쟁사 인스타그램 팔로워 데일리 추적·추세 그래프 | SPEC 초안 |

## 폴더 규칙

- 기획 폴더명: `NN-english-slug` (예: `02-something-new`)
- 각 폴더 필수 문서
  - `SPEC.md` — 무엇을 만드는가 (요구사항, 범위, 데이터 구조)
  - `PLAN.md` — 어떻게 만드는가 (개발 단위, 순서, 완료 기준)
- 구현 코드는 해당 기획 폴더 안에 둡니다. (예: `01-conference-collector/src/`)
- 기획 간 파일은 서로 참조하지 않습니다. 각 폴더는 독립적으로 완결됩니다.

## 새 기획 시작하기

1. 다음 번호로 폴더 생성 (`02-...`)
2. 중복 번호로 폴더가 생성되면 다음 번호로 밀기
3. `SPEC.md` 작성 — 목적, 사용자, 기능 범위, 데이터 구조, 제외 범위
4. `PLAN.md` 작성 — Phase 구분, 개발 단위, 주요 함수, 완료 기준
5. 위 기획 목록 표에 한 줄 추가
6. 반드시 Google Apps Script Webhook 기능을 따를 필요 없음
# ai-content-products
# ai-content-products
