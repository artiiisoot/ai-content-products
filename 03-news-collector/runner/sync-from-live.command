#!/bin/zsh

SCRIPT="/Users/raon/Desktop/myProject/Project/03-news-collector/runner/sync-from-live.sh"
LOG="$HOME/Library/Logs/news-collector.log"

echo "=== News Collector: live → local sync ==="
echo

bash "$SCRIPT"

echo
echo "=== 최근 로그 ==="
tail -3 "$LOG"

echo
read "?Enter를 누르면 종료합니다..."
