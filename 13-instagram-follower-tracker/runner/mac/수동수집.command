#!/bin/bash
# Finder 에서 더블클릭하면 1회 수집. (macOS)
export PYTHONUTF8=1 PYTHONIOENCODING=UTF-8   # 한글 깨짐 방지
cd "$(dirname "$0")/.."
.venv/bin/python track.py
echo
echo "== 끝났습니다. 이 창은 닫아도 됩니다. =="
read -n 1 -s
