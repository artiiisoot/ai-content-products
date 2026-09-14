#!/bin/sh
# live Apps Script → 레포 src/ 동기화. clasp pull 로 원격 코드를 내려받아 로컬을 덮어쓴다.
# 최초 1회 준비: npm i -g @google/clasp && clasp login  (OAuth는 사용자만 가능)
# 수동 실행: bash sync-from-live.sh   / launchd 로 주기 실행도 가능.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

DIR="$(cd "$(dirname "$0")/.." && pwd)"   # 03-news-collector (.clasp.json 위치)
LOG="$HOME/Library/Logs/news-collector.log"
cd "$DIR" || exit 1

clasp pull >> "$LOG" 2>&1
rc=$?
echo "[$(date '+%F %T')] sync(clasp pull) exit=$rc" >> "$LOG"
exit $rc
