#!/bin/bash
# macOS 설치: venv + 의존성 + 로직 점검. (runner 폴더 기준)
set -e
export PYTHONUTF8=1 PYTHONIOENCODING=UTF-8   # 한글 깨짐 방지
cd "$(dirname "$0")/.."

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

[ -f .env ] || cp .env.example .env
if [ ! -f service_account.json ]; then
  echo "[주의] runner/service_account.json 없음 → 구글 서비스계정 키를 넣고"
  echo "       대상 시트를 그 계정 이메일과 '편집자'로 공유하세요."
fi

.venv/bin/python track.py --test
echo "-------- 설치 완료 --------"
echo "  수집 테스트:  runner/mac/run.sh"
echo "  매일 09:00:   runner/mac/schedule.sh"
