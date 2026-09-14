# 설치 및 실행 안내

## 0. Playwright 설치 (최초 1회)
화면 캡처(브랜드검색 영역 스크린샷)에 헤드리스 Chromium을 씁니다. `collect.py`를 실행할 Python(기본 `/usr/bin/python3`, plist 기준)에 설치하세요.
```bash
/usr/bin/python3 -m pip install --user playwright
/Users/$(whoami)/Library/Python/3.9/bin/playwright install chromium
```
Chromium 다운로드는 약 170MB, 최초 1회만 필요합니다. `python3 -c "import playwright"`가 에러 없이 실행되면 설치 확인 완료입니다.

## 1. 키워드 등록
`keywords.json`을 열어 모니터링할 브랜드를 추가합니다.

```json
[
  { "사용여부": "Y", "브랜드명": "라온시큐어", "등록일": "2026-09-02", "비고": "" }
]
```

## 2. 수동 실행 (설치 확인용)
```bash
python3 collect.py --manual
```
`data.db`, `images/`, `dashboard/index.html`이 생성되면 정상입니다.

## 2-1. 대시보드 열기 — 로컬 서버로 열어야 버튼이 동작합니다

**가장 간단한 방법**: Finder에서 `toggle-server.command`를 더블클릭합니다. 꺼져 있으면 켜고, 켜져 있으면 끄는 토글입니다. 켤 때 이 PC용 주소와(같은 네트워크가 있다면) 다른 PC용 주소를 터미널 창에 출력합니다. (최초 1회 "확인되지 않은 개발자" 경고가 뜨면 Finder에서 우클릭 → 열기로 실행하세요.)

터미널로 직접 실행하려면:
```bash
python3 server.py
```
그다음 브라우저에서 `http://127.0.0.1:8765/`를 엽니다(Ctrl+C로 서버 종료). `dashboard/index.html`을 파일로 직접 더블클릭해서 열 수도 있지만, 그러면 이미지가 안 보이고(상대경로 문제) "키워드 추가"·"지금 수동 수집 실행" 버튼도 서버 연결 실패로 동작하지 않습니다 — 조회만 필요할 때가 아니면 항상 서버를 통해 여세요.

## 2-2. 같은 네트워크의 다른 PC와 화면 공유하기
`toggle-server.command`는 기본적으로 `--host 0.0.0.0`(같은 네트워크의 다른 PC도 접속 가능)로 켭니다. 이 PC 전용으로만 쓰려면 파일 안의 `HOST="0.0.0.0"`을 `HOST="127.0.0.1"`로 바꾸세요. 터미널에서 직접 켤 때는:
```bash
python3 server.py --host 0.0.0.0
```
실행하면 이 PC의 LAN IP와 함께 접속 주소를 안내해줍니다. 다른 PC에서 그 주소(`http://<이 PC의 IP>:8765/`)로 접속하면 됩니다. 두 PC가 같은 네트워크(같은 Wi-Fi/사내망)에 있어야 합니다.
- **인증이 없습니다.** 같은 네트워크의 누구든 대시보드 열람은 물론 키워드 추가·삭제, 수동 수집 실행까지 할 수 있습니다. 신뢰하는 네트워크에서만 켜고, 다 쓰면 `toggle-server.command`를 다시 더블클릭해(또는 `Ctrl+C`로) 끄세요.
- 처음 실행 시 macOS가 "수신 연결 허용" 방화벽 팝업을 띄우면 **허용**을 눌러야 다른 PC가 접속할 수 있습니다.
- 접속이 안 되면: 두 PC가 같은 네트워크인지, macOS 방화벽(시스템 설정 → 네트워크 → 방화벽)에서 Python이 차단돼 있지 않은지 확인하세요.

## 3. 자동 실행(launchd) 등록 — 매주 월요일 오전 9시

**먼저 macOS 개인정보 보호 권한을 부여해야 합니다.** 이 프로젝트가 `~/Desktop` 아래에 있는데, launchd가 띄운 프로세스는 터미널과 달리 Desktop 폴더 접근 권한을 자동으로 물려받지 못해 `collect.py` 파일조차 열지 못하고 `Operation not permitted` 오류로 조용히 실패합니다(실측 확인됨).
1. **시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한**을 엽니다.
2. `+` 버튼을 눌러 `Cmd+Shift+G`로 `/usr/bin`으로 이동한 뒤 `python3`을 추가합니다. (`ProgramArguments`에 다른 Python 경로를 썼다면 그 경로로 추가하세요.)
3. 추가된 `python3` 항목의 토글을 켭니다.

권한을 켠 뒤에만 아래 등록이 정상 동작합니다.

```bash
cp com.raonsecure.brand-search-monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.raonsecure.brand-search-monitor.plist
```

등록 확인:
```bash
launchctl list | grep brand-search-monitor
```

즉시 1회 테스트 실행(스케줄과 무관하게 지금 실행):
```bash
launchctl start com.raonsecure.brand-search-monitor
```

## 4. 자동 실행 해제
```bash
launchctl unload ~/Library/LaunchAgents/com.raonsecure.brand-search-monitor.plist
```

## 3-1. PC 로그인 시 대시보드 서버 자동 실행 + 종료 알림
`com.raonsecure.brand-search-dashboard.plist`는 로그인할 때마다 `toggle-server.command`를 1회 실행합니다(반복 스케줄 아님 — 이 스크립트는 켜짐/꺼짐 토글이라 반복 실행하면 계속 켰다 껐다 하게 됩니다). 서버가 꺼진 상태로 로그인하면 자동으로 켜집니다.

**종료 알림**: 서버가 켜진 채로 PC를 끄면(정상 토글 종료가 아니면) PID 파일 흔적이 남고, 다음 로그인 때 이를 감지해 macOS 알림("지난 PC 종료와 함께 서버가 꺼졌었습니다...")을 띄운 뒤 재시작합니다. PC가 꺼지는 "그 순간"의 실시간 알림은 세션이 내려가는 중이라 불가능해서 다음 부팅 때 알리는 방식입니다. 최초 1회 macOS가 osascript(스크립트 편집기) 알림 허용을 물으면 **허용**하세요.

별도 권한 설정은 필요 없습니다 — plist가 이미 전체 디스크 접근 권한이 있는 `/usr/bin/python3`(3번 단계에서 부여)를 책임 프로세스로 세워 그 자식으로 bash를 실행하므로, 권한이 상속됩니다. (bash를 직접 실행하면 bash에 별도 권한이 필요해 매 부팅 `Operation not permitted`로 실패합니다 — 실측 확인됨.)

등록:
```bash
cp com.raonsecure.brand-search-dashboard.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.raonsecure.brand-search-dashboard.plist
```
등록 해제:
```bash
launchctl unload ~/Library/LaunchAgents/com.raonsecure.brand-search-dashboard.plist
```
로그: `dashboard-autostart.out.log` / `dashboard-autostart.err.log` (프로젝트 폴더 내)

⚠ 기본 설정(`toggle-server.command`의 `HOST="0.0.0.0"`)대로면 로그인할 때마다 같은 네트워크에 공개된 채로 서버가 켜집니다. 이 PC 전용으로만 자동 실행하고 싶으면 `toggle-server.command`의 `HOST`를 `127.0.0.1`로 바꾸세요.

## 5. 로그 확인
- 실행 로그(신규/변경/미운영전환/동일 건수, 오류): `data.db`의 `logs` 테이블
- launchd 표준출력/에러: `launchd.out.log`, `launchd.err.log` (프로젝트 폴더 내)

## 6. 문제 해결
- **"서버에 연결할 수 없습니다" (키워드 추가/수동 수집 버튼)**: `python3 server.py`를 실행하지 않았거나, `dashboard/index.html`을 파일로 직접 열어서입니다. 터미널에서 서버를 켜고 `http://127.0.0.1:8765/`로 다시 여세요.
- **`OSError: [Errno 48] Address already in use` (server.py 실행 시)**: 8765 포트를 다른 프로세스(또는 이전에 못 끈 `server.py`)가 쓰고 있습니다. `lsof -i :8765`로 확인 후 종료하거나, `server.py`의 `PORT` 값을 바꾸세요.
- **`launchd.err.log`에 `Operation not permitted`**: 3번 단계의 전체 디스크 접근 권한을 아직 켜지 않은 경우입니다. 권한을 켠 뒤 `launchctl unload` → `launchctl load`로 다시 등록하세요(껐다 켜기만으로는 재적용되지 않을 수 있습니다).
- **`dashboard-autostart.err.log`에 `Operation not permitted`**: plist가 bash를 직접 실행하도록 바뀌었거나 `/usr/bin/python3`의 전체 디스크 접근 권한(3번 단계)이 꺼진 경우입니다. plist의 `ProgramArguments`가 `/usr/bin/python3` 경유인지, python3 권한이 켜져 있는지 확인 후 `launchctl unload` → `load`로 재등록하세요.
- **로그인 자동 시작 직후 서버가 바로 죽음**: plist에 `AbandonProcessGroup`이 빠지면 launchd가 잡 종료 시 nohup으로 띄운 서버까지 같이 정리합니다(실측 확인됨). plist에 해당 키가 `true`로 있는지 확인하세요.
- **plist 로드 후 실행이 안 됨**: `launchd.err.log` 확인. `/usr/bin/python3`가 이 Mac에 없다면 `which python3` 결과로 `ProgramArguments`의 경로를 교체 후 재등록(unload → load).
- **`ModuleNotFoundError: playwright`**: 0번 단계를 `ProgramArguments`에 지정된 것과 같은 Python으로 다시 설치하세요. `--user` 설치는 Python 버전별로 분리되어 있어, 인터프리터가 다르면 안 보입니다.
- **캡처 이미지가 계속 비거나 빈 화면**: `page.wait_for_timeout(500)`으로도 부족할 만큼 느린 네트워크일 수 있습니다. `collect.py`의 대기 시간을 늘려 보세요.
- **키워드 크롤링 실패만 반복됨**: 네이버가 요청을 차단했을 수 있습니다. `collect.py`의 `USER_AGENT` 값을 최신 브라우저 UA로 교체해 보세요.
- **경로를 다른 Mac으로 옮긴 경우**: `com.raonsecure.brand-search-monitor.plist`의 절대경로 3곳(스크립트 경로, 로그 2곳)을 새 경로로 수정해야 합니다.
