#!/bin/sh
# launchd 래퍼 — nvm 로드 후 러너 실행, 결과를 로그에 남긴다.
# 사용: run.sh <daily|weekly>
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/news-collector.log"
cd "$DIR" || exit 1

node --env-file=.env summarize.mjs "$1" >> "$LOG" 2>&1
rc=$?
echo "[$(date '+%F %T')] $1 exit=$rc" >> "$LOG"
exit $rc
