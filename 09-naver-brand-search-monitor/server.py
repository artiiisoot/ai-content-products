#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""로컬 대시보드 서버 — 대시보드 화면의 "키워드 추가"/"지금 수동 수집 실행" 버튼이
정말로 동작하게 한다 (지금까지는 클립보드 복사만 해줬다).

Python 표준 라이브러리(http.server)만 사용한다. 실행 중엔 대시보드를
파일로 직접 여는 대신 이 서버를 거쳐 열어야 두 버튼이 동작한다.

    python3 server.py                 → 이 PC에서만 접속 가능 (기본값, 안전)
    python3 server.py --host 0.0.0.0  → 같은 네트워크의 다른 PC도 접속 가능

같은 네트워크에 공유할 땐 인증이 전혀 없다는 점 주의: 그 네트워크의 누구든
대시보드 열람은 물론 키워드 추가/삭제, 수동 수집 실행까지 할 수 있다.
신뢰하는 네트워크(사무실 내부망 등)에서만 --host 0.0.0.0을 쓸 것.

collect.py(크롤링·판정·저장·정적 대시보드 생성)는 그대로 두고, 이 서버는
그 위에 "브라우저 버튼 → 실제 동작" 얇은 창구만 얹는다.
"""

import argparse
import json
import socket
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import collect

DEFAULT_PORT = 8765


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(collect.BASE_DIR), **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/dashboard/index.html")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/keywords":
            return self._add_keyword()
        if self.path == "/api/keywords/delete":
            return self._delete_keyword()
        if self.path == "/api/collect":
            return self._run_collect()
        self._send_json(404, {"ok": False, "error": "not found"})

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    @staticmethod
    def _load_keywords_raw():
        if not collect.KEYWORDS_PATH.exists():
            return []
        return json.loads(collect.KEYWORDS_PATH.read_text(encoding="utf-8"))

    @staticmethod
    def _save_keywords_raw(rows):
        collect.KEYWORDS_PATH.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _rebuild_dashboard(self):
        # 키워드 목록이 바뀐 직후 상단 배지/컬럼 수가 바로 반영되도록 즉시 재생성
        conn = collect.init_db()
        collect.build_dashboard(conn)
        conn.close()

    def _add_keyword(self):
        try:
            data = self._read_json_body()
            keyword = (data.get("브랜드명") or "").strip()
            if not keyword:
                return self._send_json(400, {"ok": False, "error": "키워드를 입력하세요"})

            existing = self._load_keywords_raw()
            if any(row.get("브랜드명") == keyword for row in existing):
                return self._send_json(409, {"ok": False, "error": f"'{keyword}'는 이미 등록돼 있습니다"})

            existing.append(
                {
                    "사용여부": "Y",
                    "브랜드명": keyword,
                    "등록일": collect.datetime.now(collect.KST).strftime("%Y-%m-%d"),
                    "비고": "",
                }
            )
            self._save_keywords_raw(existing)
            self._rebuild_dashboard()
            return self._send_json(200, {"ok": True})
        except Exception as e:  # noqa: BLE001 — API 응답으로 에러를 그대로 알려주면 되므로 넓게 잡는다
            return self._send_json(500, {"ok": False, "error": str(e)})

    def _delete_keyword(self):
        try:
            data = self._read_json_body()
            keyword = (data.get("브랜드명") or "").strip()
            if not keyword:
                return self._send_json(400, {"ok": False, "error": "삭제할 키워드가 없습니다"})

            existing = self._load_keywords_raw()
            remaining = [row for row in existing if row.get("브랜드명") != keyword]
            if len(remaining) == len(existing):
                return self._send_json(404, {"ok": False, "error": f"'{keyword}'를 찾을 수 없습니다"})

            self._save_keywords_raw(remaining)
            self._rebuild_dashboard()
            return self._send_json(200, {"ok": True})
        except Exception as e:  # noqa: BLE001
            return self._send_json(500, {"ok": False, "error": str(e)})

    def _run_collect(self):
        try:
            result = collect.collect("수동")
            return self._send_json(
                200, {"ok": True, "counts": result["counts"], "errors": result["errors"]}
            )
        except Exception as e:  # noqa: BLE001
            return self._send_json(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[server] {self.address_string()} {fmt % args}")


def _lan_ip():
    """다른 PC가 접속할 이 PC의 LAN IP를 추정한다 (실제 패킷은 안 보냄)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description="로컬 대시보드 서버")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="바인딩 주소. 기본은 이 PC에서만 접속 가능. 같은 네트워크의 다른 PC와 공유하려면 0.0.0.0",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)

    if args.host in ("0.0.0.0", "::"):
        lan_ip = _lan_ip() or "<이 PC의 LAN IP>"
        print("⚠ 같은 네트워크의 누구든 접속·키워드 추가/삭제·수동 수집 실행이 가능합니다 (인증 없음). 신뢰하는 네트워크에서만 쓰세요.")
        print(f"이 PC: http://127.0.0.1:{args.port}/dashboard/index.html")
        print(f"다른 PC: http://{lan_ip}:{args.port}/dashboard/index.html")
    else:
        print(f"http://{args.host}:{args.port}/dashboard/index.html 에서 확인하세요")
    print("(Ctrl+C로 종료)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
