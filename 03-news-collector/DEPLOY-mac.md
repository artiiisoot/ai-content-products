# 상주 Mac 자동 실행 설정 (담당자용)

일일요약(매일 08:30)·주간후보(매월요일 09:00)·수동 요청 폴링(2분 간격)을 **상주 Mac 한 대에서 자동 실행**하기 위한 설정.
수집(매일 08:00)은 Apps Script가 구글 서버에서 자동 처리하므로 이 문서 대상이 아니다. 여기서 다루는 건 **AI 추론 러너의 스케줄링**뿐이다.

```
[구글 서버] 수집 08:00 → 시트
[상주 Mac] launchd: daily 08:30 / weekly 월 09:00 / check 2분마다 → 러너 → 시트에 요약·후보 기록
```

`check`는 시트 메뉴 `주간콘텐츠후보 → 지금 생성 요청`을 눌렀을 때 남는 요청 플래그를 폴링한다. 요청이 있으면 곧바로 `weekly`를 실행하고 플래그를 지운다 — 즉, 버튼을 누르면 최대 2분 안에 실제로 생성된다.

## ⚠️ 자동 실행은 반드시 한 대만

`daily`를 여러 PC에서 자동 실행하면 `일일요약` 탭에 **같은 요약이 중복 기록**된다 (append만 하고 중복 제거 없음 — `src/Summary.gs`의 `writeDailySummary_`). **스케줄은 이 Mac 한 대에서만** 건다.

## 왜 홈 폴더로 복사하나 (`~/news-collector-runner`)

macOS 개인정보 보호(TCC) 때문에 launchd 백그라운드 데몬은 `~/Desktop`·`~/Documents`·`~/Downloads` 안의 파일을 실행/읽기할 수 없다(`Operation not permitted`). 그래서 데몬이 쓸 러너는 **보호 대상이 아닌 홈 루트(`~/news-collector-runner`)로 복사**해 사용한다.

> 저장소(`~/Desktop/.../runner`)는 원본, `~/news-collector-runner`는 데몬용 복사본이다.
> **러너 코드나 `.env`를 고치면 복사본에도 다시 반영(아래 1번 재실행)해야 한다.**

---

## 최초 설정

### 0) 준비
- Node.js 설치 (nvm 사용 중이면 그대로 OK)
- `~/Desktop/.../runner/.env` 작성 완료 (`WEBAPP_URL`·`WEBAPP_TOKEN`·`LITELLM_KEY`)
- 사내망(VPN) 연결

### 1) 러너를 홈 폴더로 복사
```bash
cp -R ~/Desktop/myProject/Project/03-news-collector/runner ~/news-collector-runner
```

### 2) launchd 등록
```bash
cp ~/news-collector-runner/launchd/com.raon.newscollector.*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.raon.newscollector.daily.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.raon.newscollector.weekly.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.raon.newscollector.check.plist
launchctl list | grep newscollector    # daily/weekly/check 세 줄 나오면 등록 성공
```

### 3) 즉시 1회 테스트
```bash
launchctl kickstart -k gui/$(id -u)/com.raon.newscollector.daily
sleep 15 && tail -n 5 ~/Library/Logs/news-collector.log
```
`일일요약 기록 완료: N건` + `daily exit=0` 이 보이면 완료.

---

## 스케줄 변경 / 중지

시각은 plist의 `Hour`·`Minute`·`Weekday`로 정한다 (`Weekday` 0=일, 1=월 … 5=금, 6=토).

```bash
# 1) 홈 폴더 복사본의 plist 수정 후, LaunchAgents로 다시 복사
cp ~/news-collector-runner/launchd/com.raon.newscollector.daily.plist ~/Library/LaunchAgents/
# 2) 재적용
launchctl bootout   gui/$(id -u)/com.raon.newscollector.daily
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.raon.newscollector.daily.plist
```

완전 중지(자동 실행 끄기):
```bash
launchctl bootout gui/$(id -u)/com.raon.newscollector.daily
launchctl bootout gui/$(id -u)/com.raon.newscollector.weekly
launchctl bootout gui/$(id -u)/com.raon.newscollector.check
```

---

## 로그 위치

| 파일 | 내용 |
|---|---|
| `~/Library/Logs/news-collector.log` | 러너 실행 결과 (요약 건수, 종료 코드) |
| `~/Library/Logs/news-collector.launchd.log` | launchd 자체 오류 (여기 `Operation not permitted`가 있으면 경로/TCC 문제) |

## 트러블슈팅

- **launchd 로그에 `Operation not permitted`** → 러너가 아직 Desktop 등 보호 폴더에 있음. `~/news-collector-runner`로 복사했는지, plist 경로가 그쪽을 가리키는지 확인.
- **`command not found: node`** → `run.sh`가 nvm을 못 읽음. `~/.nvm`이 있는지, `run.sh`의 `NVM_DIR` 확인.
- **요약이 비어서 나옴 (`오늘 수집된 기사가 없어...`)** → 그날 신규 기사 0건. 정상. (Mac이 08:00 수집 이후~자정 사이에 켜져 있어야 daily가 당일분을 잡는다.)
- **그 외 러너 오류(게이트웨이/토큰 등)** → `runner/README.md` 트러블슈팅 참고.
- **로그에 `수동 요청 없음`이 2분마다 계속 찍힘** → 정상. `check`가 폴링만 하고 있다는 뜻이며, 요청이 없을 때의 예상 동작이다.
