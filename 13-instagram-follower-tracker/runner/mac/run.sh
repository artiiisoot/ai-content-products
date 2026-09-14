#!/bin/bash
# 수동 1회 수집(그래프 갱신). 인자 그대로 전달: run.sh --dump / --self-check / --test
set -e
export PYTHONUTF8=1 PYTHONIOENCODING=UTF-8   # 한글 깨짐 방지
cd "$(dirname "$0")/.."
exec .venv/bin/python track.py "$@"
