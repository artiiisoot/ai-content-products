#!/bin/bash
# -*- coding: utf-8 -*-
# 대시보드 서버 켜기/끄기 토글. Finder에서 더블클릭으로 실행.
# 이미 떠 있으면 끄고, 꺼져 있으면 켠다.

export LANG=ko_KR.UTF-8
export LC_ALL=ko_KR.UTF-8

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || { echo "프로젝트 폴더를 찾을 수 없습니다: $DIR"; [ -t 0 ] && read -p "엔터를 누르면 창이 닫힙니다..." _; exit 1; }

PIDFILE="$DIR/.server.pid"
LOGFILE="$DIR/server.log"
PY="/usr/bin/python3"
HOST="0.0.0.0"   # 같은 네트워크의 다른 PC와 공유 (127.0.0.1로 바꾸면 이 PC 전용)
PORT="8765"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
  kill "$PID"
  rm -f "$PIDFILE"
  echo "서버를 종료했습니다 (PID $PID)."
else
  # PID 파일은 남아있는데 프로세스가 없다 = 정상 토글로 끈 게 아니라 서버가 켜진 채로
  # PC가 꺼졌다(전원 종료/강제 종료)는 흔적. macOS 알림으로 알려준다 — PC가 꺼지는
  # "그 순간"의 실시간 알림은 세션이 내려가는 중이라 불가능해서, 다음에 켤 때 알린다.
  if [ -f "$PIDFILE" ]; then
    LAST_SHUTDOWN="$(last shutdown 2>/dev/null | head -1 | awk '{for(i=3;i<=NF;i++) printf "%s ", $i}')"
    osascript -e "display notification \"지난 PC 종료(${LAST_SHUTDOWN:-시각 미상})와 함께 서버가 꺼졌었습니다. 지금 다시 시작합니다.\" with title \"브랜드검색 모니터링\" sound name \"default\"" 2>/dev/null || true
    echo "이전 PC 종료 때 서버가 함께 꺼졌던 흔적(PID 파일)을 발견 — 알림 표시 후 재시작합니다."
  fi
  rm -f "$PIDFILE"
  nohup "$PY" server.py --host "$HOST" --port "$PORT" > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1

  if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
    echo "서버를 시작했습니다."
    echo "  이 PC:   http://127.0.0.1:$PORT/dashboard/index.html"
    if [ -n "$LAN_IP" ]; then
      echo "  다른 PC: http://$LAN_IP:$PORT/dashboard/index.html"
    fi
    echo "  (같은 네트워크 누구나 접속 가능 — 인증 없음)"
  else
    echo "서버 시작에 실패했습니다. $LOGFILE 을 확인하세요."
    rm -f "$PIDFILE"
  fi
fi

echo ""
# 더블클릭(터미널)으로 실행됐을 때만 대기한다. launchd 등 비대화형 실행에서는
# 표준입력이 터미널이 아니므로([ -t 0 ]가 거짓) 곧바로 종료해 프로세스가 멈춰있지 않게 한다.
if [ -t 0 ]; then
  read -p "엔터를 누르면 창이 닫힙니다..." _
fi
