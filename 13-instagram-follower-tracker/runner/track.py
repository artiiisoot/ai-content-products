#!/usr/bin/env python3
"""인스타그램 팔로워 데일리 트래킹 → Google Sheets (메타태그 방식, 1차).

수집: 공개 프로필 HTML 의 og:description 메타태그에서 "팔로워 N명" 추출.
      데이터센터 IP 는 로그인 월이 뜨므로 반드시 국내 IP(로컬 PC)에서 실행한다.

사용법:
    python track.py                # 5계정 수집 → '로그' 탭 upsert
    python track.py --self-check   # 계정 1개 실조회로 수집 동작 확인(네트워크 필요)
    python track.py --test         # 네트워크 없이 파싱/증감/이상치 자체 점검
    python track.py --date 2026-08-28   # 날짜 지정(검증용)
"""
import csv
import os
import re
import sys
import time
import html
import random
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))

# 확인된 사실: 국내 IP + 링크프리뷰 크롤러 UA 로 요청하면 og:description 이 온다.
UA_BOT = "facebookexternalhit/1.1"
WARN_PCT = float(os.environ.get("WARN_PCT", "0.30"))  # ±30% 초과 급변 → DATA_WARNING

RAW_HEADER = ["수집일시", "기업명", "계정명", "팔로우", "오류내용"]  # 날짜=수집일시 앞 10자

ACC_HEADER = ["기업명", "계정명", "계정 url", "수집 상태"]
WS_LOG, WS_ACCOUNTS, WS_STATUS = "로그", "계정", "수집 현황"  # 시트 탭명(구: RAW_DATA/ACCOUNTS/PIVOT)
PIVOT_TOP = 20  # 수집 현황 표 시작 행. 1~19행은 차트 자리(그래프 바로 아래에서 데이터 수집)
FOLLOW_RE = re.compile(r"팔로워\s*([\d.,]+(?:만|천|[KkMm])?)\s*명")
EN_RE = re.compile(r"([\d.,]+[KkMm]?)\s+Followers", re.I)


# ---------- env ----------
def load_env():
    """.env 를 최소 파싱해 os.environ 에 채운다(신규 의존성 회피)."""
    path = os.path.join(HERE, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _read_csv_accounts():
    """accounts.csv(name,username) → [(company, username)]. ACCOUNTS 시트 시드용."""
    with open(os.path.join(HERE, "accounts.csv"), encoding="utf-8") as f:
        return [(r["name"], r["username"]) for r in csv.DictReader(f)]


# ---------- 파싱 (순수 함수, 테스트) ----------
def normalize_followers(token):
    """'613' '6,130' '1.2만' '12K' '1.3M' → int. 파싱 불가 시 ValueError."""
    t = token.strip().replace(",", "")
    mult = 1
    if t and t[-1] in "만천KkMm":
        mult = {"만": 10000, "천": 1000, "K": 1000, "k": 1000,
                "M": 1000000, "m": 1000000}[t[-1]]
        t = t[:-1]
    return int(round(float(t) * mult))


def extract_followers(page_html):
    """HTML → (followers|None, reason). reason: ok / no_meta / no_follower_token."""
    m = re.search(r'<meta property="og:description" content="([^"]*)"', page_html)
    if not m:
        return None, "no_meta"
    desc = html.unescape(m.group(1))
    fm = FOLLOW_RE.search(desc) or EN_RE.search(desc)
    if not fm:
        return None, "no_follower_token"
    try:
        return normalize_followers(fm.group(1)), "ok"
    except ValueError:
        return None, "no_follower_token"


# ---------- 증감 / 이상치 (순수 함수, 테스트) ----------
def is_anomaly(prev, cur, pct=WARN_PCT):
    """직전 성공값 대비 ±pct 초과 급변이면 True. 과거 없으면 False."""
    return prev is not None and prev > 0 and abs(cur - prev) > prev * pct


# ---------- 수집 ----------
def fetch_followers(username):
    """GET → og:description → 팔로워 정수. dict(followers,status,error)."""
    import requests
    url = f"https://www.instagram.com/{username}/"
    try:
        r = requests.get(url, headers={"User-Agent": UA_BOT,
                                        "Accept-Language": "ko-KR,ko;q=0.9"},
                         timeout=20)
    except requests.Timeout:
        return {"followers": None, "status": "TIMEOUT", "error": "timeout"}
    except Exception as e:
        return {"followers": None, "status": "UNKNOWN_ERROR", "error": str(e)[:200]}
    if r.status_code != 200:
        return {"followers": None, "status": "UNKNOWN_ERROR",
                "error": f"HTTP {r.status_code}"}
    followers, why = extract_followers(r.text)
    if followers is None:
        status = ("LOGIN_REQUIRED" if why == "no_meta" and "login" in r.text.lower()
                  else "ELEMENT_NOT_FOUND")
        return {"followers": None, "status": status, "error": why}
    return {"followers": followers, "status": "SUCCESS", "error": ""}


# ---------- Google Sheets ----------
def open_book():
    import gspread
    from google.oauth2.service_account import Credentials
    key = os.path.join(HERE, os.environ.get("GOOGLE_SERVICE_ACCOUNT",
                                             "service_account.json"))
    creds = Credentials.from_service_account_file(
        key, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    return gspread.authorize(creds).open_by_key(os.environ["GOOGLE_SHEET_ID"])


def _sheet(sh, name, header):
    import gspread
    try:
        ws = sh.worksheet(name)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(name, rows=1000, cols=len(header))
    if ws.row_values(1) != header:
        ws.update(range_name="A1", values=[header])
    return ws


def _rawrows(ws):
    """'로그' 데이터행 → dict 리스트. 짧은 행(뒤 빈칸 잘림) 패딩."""
    return [dict(zip(RAW_HEADER, v + [""] * len(RAW_HEADER)))
            for v in ws.get_all_values()[1:]]


def _d10(v):
    """수집일시 앞 10자(YYYY-MM-DD)."""
    return str(v)[:10]


def load_accounts(sh):
    """계정 탭에서 전 계정 로드. 비어 있으면 accounts.csv 로 시드."""
    ws = _sheet(sh, WS_ACCOUNTS, ACC_HEADER)
    rows = ws.get_all_records()
    if not rows:
        seed = [[c, u, f"https://www.instagram.com/{u}/", ""]
                for c, u in _read_csv_accounts()]
        ws.update(range_name="A2", values=seed, value_input_option="USER_ENTERED")
        rows = ws.get_all_records()
    return [(r["기업명"], r["계정명"]) for r in rows if str(r["계정명"]).strip()]


def mark_status(sh, results):
    """계정 탭 '수집 상태' 열에 마지막 수집 결과 기록: 성공 Y / 실패 N (계정명 매칭)."""
    ws = _sheet(sh, WS_ACCOUNTS, ACC_HEADER)
    users = [r["계정명"] for r in ws.get_all_records()]
    ok = {u for _, u, res in results if res["status"] in ("SUCCESS", "DATA_WARNING")}
    col = [["Y" if u in ok else "N"] for u in users]
    if col:
        ws.update(range_name=f"D2:D{len(col) + 1}", values=col,
                  value_input_option="USER_ENTERED")


def last_success(rows, username, today):
    """해당 계정명의 today 이전 최근 성공(팔로우 값 있음) 팔로워값(int). 없으면 None."""
    hits = [r for r in rows
            if r["계정명"] == username and _d10(r["수집일시"]) < today
            and str(r["팔로우"]).strip() != ""]
    if not hits:
        return None
    return int(max(hits, key=lambda r: r["수집일시"])["팔로우"])


def push(sh, collected_at, results):
    """results: [(company, username, fetch_dict)] → '로그' upsert(날짜+계정명).
    팔로우 값이 있으면 성공. 오류내용 = 실패 사유 또는 급변 경고."""
    date = _d10(collected_at)
    ws = _sheet(sh, WS_LOG, RAW_HEADER)
    rows = _rawrows(ws)
    for company, username, res in results:
        followers, err = res["followers"], res["error"]
        note = err
        if followers is not None:
            prev = last_success(rows, username, date)
            if is_anomaly(prev, followers):
                note = f"급변 경고: 전일 {prev} → {followers}"
        row = [collected_at, company, username,
               "" if followers is None else followers, note]
        idx = next((i for i, r in enumerate(rows)
                    if _d10(r["수집일시"]) == date and r["계정명"] == username), None)
        if idx is None:
            ws.append_row(row, value_input_option="USER_ENTERED")
            rows.append(dict(zip(RAW_HEADER, map(str, row))))
        else:
            ws.update(range_name=f"A{idx + 2}", values=[row],
                      value_input_option="USER_ENTERED")
        print(f"  [{'OK' if followers is not None else 'FAIL'}] {username}: "
              f"팔로우={followers} {note}")


# ---------- 그래프 (PIVOT 탭 + 선차트) ----------
def rebuild_pivot(sh, raw_rows, accounts):
    """'로그'(long) → '수집 현황'(날짜행 × 계정열) 재작성. (ws, 계정수) 반환.
    열은 '계정' 탭에 현재 있는 계정만(삭제된 계정은 그래프/표에서 빠짐).
    표는 PIVOT_TOP 행부터, 최신 날짜가 맨 위."""
    users = [u for _, u in accounts]
    comp = {u: c for c, u in accounts}
    val = {(_d10(r["수집일시"]), r["계정명"]): r["팔로우"] for r in raw_rows
           if r["계정명"] in comp and str(r["수집일시"]).strip()
           and str(r["팔로우"]).strip() != ""}
    dates = sorted({d for d, _ in val}, reverse=True)
    header = ["수집일시"] + [comp.get(u, u) for u in users]
    table = [header] + [[d] + [val.get((d, u), "") for u in users] for d in dates]
    ws = _sheet(sh, WS_STATUS, header)
    ws.clear()
    ws.resize(rows=len(table) + PIVOT_TOP + 200, cols=len(header) + 4)
    ws.update(range_name=f"A{PIVOT_TOP}", values=table, value_input_option="USER_ENTERED")
    return ws, len(users)


def rebuild_chart(sh, pivot_ws, n_users):
    """수집 현황 차트를 매 실행마다 새로 그림 → 계정 추가·삭제가 그래프에 즉시 반영.
    A1 에 고정 배치, 데이터는 PIVOT_TOP 행부터."""
    pid = pivot_ws.id
    reqs = [{"deleteEmbeddedObject": {"objectId": c["chartId"]}}
            for s in sh.fetch_sheet_metadata().get("sheets", [])
            if s["properties"]["sheetId"] == pid
            for c in s.get("charts", [])]
    if n_users:
        rng = lambda c0, c1: {"sources": [{"sheetId": pid, "startRowIndex": PIVOT_TOP - 1,
                                           "startColumnIndex": c0, "endColumnIndex": c1}]}
        # pointStyle: 데이터가 하루치뿐인 계정(방금 추가)도 점으로 보이게
        series = [{"series": {"sourceRange": rng(c, c + 1)}, "targetAxis": "LEFT_AXIS",
                   "pointStyle": {"size": 5, "shape": "CIRCLE"}}
                  for c in range(1, n_users + 1)]
        reqs.append({"addChart": {"chart": {
            "spec": {"title": "팔로워 추이", "basicChart": {
                "chartType": "LINE", "legendPosition": "RIGHT_LEGEND", "headerCount": 1,
                "axis": [{"position": "BOTTOM_AXIS", "title": "수집일시"},
                         {"position": "LEFT_AXIS", "title": "팔로워"}],
                "domains": [{"domain": {"sourceRange": rng(0, 1)}}],
                "series": series}},
            "position": {"overlayPosition": {"anchorCell": {
                "sheetId": pid, "rowIndex": 0, "columnIndex": 0}}}}}})
    if reqs:
        sh.batch_update({"requests": reqs})


def update_dashboard(sh, accounts):
    raw = _rawrows(_sheet(sh, WS_LOG, RAW_HEADER))
    ws, n = rebuild_pivot(sh, raw, accounts)
    rebuild_chart(sh, ws, n)


# ---------- 실행 ----------
def run(date):
    print(f"수집 시작: {date}")
    sh = open_book()
    accounts = load_accounts(sh)
    collected_at = f"{date} {datetime.datetime.now():%H:%M:%S}"  # 날짜=인자 date 로 고정
    results = []
    for company, username in accounts:
        res = fetch_followers(username)
        results.append((company, username, res))
        time.sleep(random.uniform(2, 5))  # 레이트리밋 회피
    push(sh, collected_at, results)
    mark_status(sh, results)
    update_dashboard(sh, accounts)
    ok = sum(1 for _, _, r in results if r["followers"] is not None)
    print(f"완료: SUCCESS {ok} / FAILED {len(results) - ok}  (PIVOT/차트 갱신)")


def self_check():
    """계정 1개 실조회 → 성공/양수 확인(네트워크 필요)."""
    _, username = _read_csv_accounts()[0]
    res = fetch_followers(username)
    assert res["status"] == "SUCCESS", f"{username} 수집 실패: {res}"
    assert res["followers"] > 0, "followers 가 0"
    print(f"OK: {username} → {res}")


def run_tests():
    """네트워크 없이 파싱/이상치 점검 (T4·T6·T7)."""
    # T6 숫자 정규화
    assert normalize_followers("613") == 613
    assert normalize_followers("6,130") == 6130
    assert normalize_followers("1.2만") == 12000
    assert normalize_followers("12K") == 12000
    assert normalize_followers("1.3M") == 1300000
    # T6 메타태그 실물에서 추출 (HTML 엔티티 포함)
    real = ('<meta property="og:description" content="팔로워 613명, 팔로잉 0명, '
            '게시물 224개 - 라온시큐어(@raonsecure)님의 Instagram 사진 및 동영상 보기">')
    assert extract_followers(real) == (613, "ok")
    assert extract_followers('<meta property="og:description" content="123K Followers">') \
        == (123000, "ok")
    # T4 로그인 월(메타 없음) → 0 아님, None
    assert extract_followers("<html>login required</html>") == (None, "no_meta")
    # T7 이상치(±30%)
    assert is_anomaly(100, 131) is True       # +31%
    assert is_anomaly(100, 129) is False      # +29%
    assert is_anomaly(100, 69) is True        # -31%
    assert is_anomaly(None, 100) is False     # 과거 없음
    # last_success: 최근 성공값 선택, 실패행(팔로우 빈칸)/당일행 제외
    rows = [
        {"계정명": "a", "수집일시": "2026-08-26 09:00:00", "팔로우": "100"},
        {"계정명": "a", "수집일시": "2026-08-27 09:00:00", "팔로우": ""},
        {"계정명": "a", "수집일시": "2026-08-28 09:00:00", "팔로우": "200"},
    ]
    assert last_success(rows, "a", "2026-08-28") == 100  # 당일 제외 → 26일값
    print("OK: T4/T6/T7 + last_success 통과")


if __name__ == "__main__":
    load_env()
    args = sys.argv[1:]
    if "--test" in args:
        run_tests()
    elif "--dump" in args:
        sh = open_book()
        for name in (WS_LOG, WS_STATUS):
            print(f"===== {name} =====")
            for row in sh.worksheet(name).get_all_values():
                print(row)
    elif "--self-check" in args:
        self_check()
    else:
        date = datetime.date.today().isoformat()
        if "--date" in args:
            date = args[args.index("--date") + 1]
        run(date)
