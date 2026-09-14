#!/bin/sh
# Apps Script 에디터 편집용 디버그 Chrome 실행.
# 최신 Chrome은 기본 프로필에서 --remote-debugging-port를 거부하므로 별도 프로필(~/chrome-debug)로 띄운다.
# 사용: bash launch-debug-chrome.sh  → webSocketDebuggerUrl JSON이 뜨면 성공.
PROFILE="$HOME/chrome-debug"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# 최초 1회만 기존 프로필 복사(로그인 상태 유지). 이미 있으면 건너뜀.
[ -d "$PROFILE" ] || cp -R "$HOME/Library/Application Support/Google/Chrome" "$PROFILE"

killall "Google Chrome" 2>/dev/null
sleep 1
"$CHROME" --remote-debugging-port=9222 --user-data-dir="$PROFILE" >/dev/null 2>&1 &
sleep 5
curl -s http://127.0.0.1:9222/json/version && echo "  <- 성공"
