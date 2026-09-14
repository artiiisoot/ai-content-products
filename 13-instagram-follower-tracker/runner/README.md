# runner — 실행 번들

수집 본체(`track.py`)와 실행 파일. **이 폴더만 복사하면** 다른 PC에서 동작.

```
runner/
  track.py            수집 본체 (공용)
  requirements.txt    의존성 (requests, gspread, google-auth)
  accounts.csv        초기 계정 시드 (시트 '계정' 탭이 비었을 때만 사용)
  .env.example        설정 템플릿
  .env                실제 설정 (GOOGLE_SHEET_ID). 비밀 — git 제외
  service_account.json 구글 인증키. 비밀 — git 제외, 사람이 직접 넣음
  .venv/              가상환경 (OS마다 새로 생성, 복사 금지)
  mac/                ← 현재 PC(macOS) 용
  windows/            ← Windows 전용
```

## 현재 PC (macOS) — `mac/`
| 목적 | 명령 |
|------|------|
| 설치 | `bash runner/mac/setup.sh` |
| 수동 1회 수집 | **Finder 에서 `runner/mac/수동수집.command` 더블클릭** (또는 `bash runner/mac/run.sh`) |
| 수동 + 옵션 | `bash runner/mac/run.sh --dump` / `--self-check` / `--test` / `--date 2026-08-28` |
| 매일 09:00 자동 | `bash runner/mac/schedule.sh` |
| 자동 해제 | `bash runner/mac/uninstall.sh` |

## Windows — `windows/`
`windows/` 안의 `README_WINDOWS.md` 참고. 순서: `1_setup.bat` → `2_run.bat` → `3_schedule.bat`(관리자).

## 공통 규칙
- **국내 일반 IP**(가정·사무실)에서 실행. 데이터센터/VPN IP는 인스타 로그인 월로 실패.
- `service_account.json` 이 있어야 시트 기록됨 + 대상 시트를 그 계정과 "편집자"로 공유.
- `.env` 의 `GOOGLE_SHEET_ID` 가 같아야 과거 데이터·그래프가 이어짐.
- 계정 추가/삭제: 시트 '계정' 탭에서 행 편집 후 위 "수동 1회 수집" 실행 → 즉시 반영.
