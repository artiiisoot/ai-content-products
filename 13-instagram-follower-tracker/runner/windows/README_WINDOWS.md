# Windows 실행 (runner/windows/)

`runner/` 폴더를 통째로 윈도우 PC에 복사 (`.venv/` 는 제외 — OS 호환 안 됨).
아래 bat 들은 `runner/windows/` 안에서 실행되고 `runner/` 를 대상으로 동작한다.

## 이관 체크리스트
```
[ ] 1. runner 폴더 통째 복사  (.venv 제외)
[ ] 2. runner\service_account.json 넣기 + 대상 구글시트를 그 계정과 "편집자" 공유
[ ] 3. runner\windows\1_setup.bat  더블클릭
       → Python 없으면 자동설치 + venv·의존성·.env·로직점검
       (Python 자동설치가 돌면 창 닫고 1_setup.bat 한 번 더)
[ ] 4. runner\windows\2_run.bat  더블클릭  → 1회 수집 테스트 (시트 확인)
[ ] 5. runner\windows\3_schedule.bat  우클릭 → 관리자 권한 실행 → 매일 09:00 등록
```

## 파일
| 파일 | 역할 |
|------|------|
| `1_setup.bat` | Python 자동설치 + `runner\.venv` + 의존성 + `.env` + 로직 점검 |
| `2_run.bat` | 수동 1회 수집(그래프 갱신). `2_run.bat --dump` 처럼 인자 전달 |
| `3_schedule.bat` | 매일 09:00 자동 수집 등록 (**관리자 권한**) — 무인 `_silent.bat` 호출 |
| `_silent.bat` | 스케줄러 전용 무인 실행. 직접 실행 안 함 |

## 스케줄 관리 (cmd)
| 목적 | 명령 |
|------|------|
| 등록 확인 | `schtasks /query /tn "IG Follower Tracker"` |
| 즉시 1회 | `schtasks /run /tn "IG Follower Tracker"` |
| 해제 | `schtasks /delete /tn "IG Follower Tracker" /f` |

- 09:00 에 PC 가 켜져 있고 로그인돼 있어야 실행. 꺼져 있으면 그날 누락
  (`taskschd.msc` → 해당 작업 → 설정 → "예약 시작을 놓친 경우 즉시 실행" 체크).

## 트러블슈팅
| 증상 | 조치 |
|------|------|
| `'python' is not recognized` | 자동설치 후 PATH 미반영 → 창 닫고 `1_setup.bat` 재실행 |
| `FileNotFoundError: service_account.json` | 키 파일을 `runner\` 에 배치 |
| `KeyError: 'GOOGLE_SHEET_ID'` | `runner\.env` 의 `GOOGLE_SHEET_ID` 확인 |
| `APIError 403 / PermissionDenied` | 시트를 서비스계정 이메일과 "편집자" 공유 |
| 모든 계정 `LOGIN_REQUIRED` | 데이터센터/VPN IP → 국내 일반 회선에서 실행 |
