#!/bin/bash
# 매일 09:00 자동 수집 해제.
LABEL="com.ig-tracker.daily"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "[완료] $LABEL 해제됨"
