# SETUP — 실행 환경 준비 (런타임 B: 로컬 Python 확정)

[SPEC.md](SPEC.md)/[PLAN.md](PLAN.md) 기준. STEP 1 프로브 결과 **구글 데이터센터 IP 는 로그인 월(메타 없는 HTTP 200)** 이 떠서 Apps Script 는 폐기, **국내 IP(로컬 PC)에서 Python 실행**으로 확정됨.

> **실행/설치/스케줄 파일은 전부 `runner/` 로 이동함.**
> - 현재 PC(macOS): [runner/mac/](runner/mac) — `setup.sh` → `run.sh` → `schedule.sh`
> - Windows: [runner/windows/README_WINDOWS.md](runner/windows/README_WINDOWS.md)
> - 개요: [runner/README.md](runner/README.md)
> 아래 내용은 배경 설명(인증·IP 제약)용. 구체 절차는 위 README 참고.

## 셋업 체크리스트
```
1. Python venv + requests, gspread, google-auth 설치
2. service_account.json 이식 (git 제외) + 대상 시트에 서비스계정 이메일 공유(편집)
3. .env 에 GOOGLE_SHEET_ID 넣기 (.env.example 복사)
4. macOS launchd(또는 OS별 스케줄러)로 매일 09:00 등록 + PC 켜둠 보장
```

## 1. 환경 / 의존성
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # requests, gspread, google-auth
```
- **스케줄러는 OS마다 다름.** 설계는 macOS `launchd`. 윈도우 "작업 스케줄러", 리눅스 `cron`.
- 그래프는 구글 시트가 그림 → matplotlib·한글 폰트 이슈 **없음**.

## 2. 구글 시트 인증 (가장 중요)
- **서비스 계정 키(`service_account.json`)** 가 있어야 시트에 쓸 수 있음. 새 PC 에 이 파일을 이식.
- **대상 시트를 서비스 계정 이메일과 편집 권한으로 공유**(1회). 공유 안 하면 권한 오류로 기록 실패.
- 키 파일은 **비밀** → `.gitignore` 로 git·공유에서 제외. 유출 시 시트 탈취 위험.
- 서비스 계정 키는 PC/IP 에 안 묶임 → 파일만 있으면 어느 PC 에서든 동작.

## 3. IP 제약 (핵심)
- 수집은 **비로그인·쿠키 없음**. 크롤러 UA(`facebookexternalhit/1.1`)로 og:description 을 받는다.
- **데이터센터 IP(클라우드·구글)에서는 로그인 월이 떠서 실패** → 반드시 국내 일반 IP(가정/사무실 회선)에서 실행.
- 국내 IP 에서도 특정 계정이 막히면 그 계정만 `status=LOGIN_REQUIRED` 로 기록되고 나머지는 정상 수집됨(값 0 저장 안 함).

## 4. 데이터 연속성
- 데이터가 **구글 시트(클라우드)** 에 있어 PC 를 옮겨도 과거 데이터·증감·그래프가 그대로 이어짐.
- 단, **같은 시트 ID** 를 가리켜야 함(`.env` 의 `GOOGLE_SHEET_ID` 동일 확인).

## 5. 실행 전제
- 스케줄러는 **PC 가 켜져 있고 로그인된 시간에만** 실행. 09:00 에 PC 가 꺼져 있으면 그날 누락.
- 사내 **방화벽/프록시가 instagram.com 또는 구글 API 를 막으면** 수집·기록 실패.

## 6. 최초 정상동작 확인
```bash
python track.py --test         # 네트워크 없이 파싱/증감/이상치 점검
python track.py --self-check   # 계정 1개 실조회 → SUCCESS, followers>0 확인
python track.py                # 5계정 수집 → RAW_DATA 탭에 계정당 1행
```

## 7. 스케줄 등록 (macOS)
`com.ig-tracker.daily.plist` 의 경로(파이썬·track.py·WorkingDirectory·로그)를 이 PC 에 맞게 수정 후:
```bash
cp com.ig-tracker.daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ig-tracker.daily.plist   # 등록
launchctl start com.ig-tracker.daily                               # 즉시 1회 테스트
tail -f tracker.log                                                # 실행 로그
launchctl unload ~/Library/LaunchAgents/com.ig-tracker.daily.plist # 해제
```
- 윈도우는 "작업 스케줄러", 리눅스는 `cron` → `0 9 * * *`.

## 8. 시트 차트 (자동)
수동 설정 필요 없음. 매 실행 시 스크립트가:
- `RAW_DATA`(long) 를 **`PIVOT` 탭**(행=date × 열=username)으로 재작성하고,
- `PIVOT` 에 차트가 없으면 **"팔로워 추이" 선차트를 1회 자동 생성**한다(행 범위 무제한 → 데이터 쌓이면 자동 확장).
