#!/bin/bash
# 매일 09:00 자동 수집을 launchd 에 등록(현재 경로 기준으로 plist 생성 → 설치 → 로드).
set -e
RUNNER="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ig-tracker.daily"
PLIST="$RUNNER/mac/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONUTF8</key><string>1</string>
        <key>PYTHONIOENCODING</key><string>UTF-8</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>$RUNNER/.venv/bin/python</string>
        <string>$RUNNER/track.py</string>
    </array>
    <key>WorkingDirectory</key><string>$RUNNER</string>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>$RUNNER/tracker.log</string>
    <key>StandardErrorPath</key><string>$RUNNER/tracker.err.log</string>
</dict>
</plist>
EOF

cp "$PLIST" "$DEST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "[완료] 매일 09:00 등록됨: $LABEL"
echo "  즉시 1회:  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  해제:      runner/mac/uninstall.sh"
