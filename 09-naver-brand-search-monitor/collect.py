#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""네이버 브랜드검색(brand_search) 모니터링 자동화 — Phase 1.

Google Apps Script 없이 로컬 Python으로 동작한다. 소재 이미지는 Playwright
헤드리스 브라우저로 브랜드검색 영역 전체(본문+서브링크+상품+하단 스트립,
브랜드 SNS 소식 제외)를 실제 화면 그대로 스크린샷 캡처한다. 설치는 SETUP.md 참고
(pip install playwright && playwright install chromium 필요 — 표준 라이브러리만으로는
CSS 레이아웃을 픽셀로 렌더링할 수 없어 이 부분만 예외적으로 외부 패키지를 쓴다).

    자동수집: python collect.py            (launchd/cron이 매일 09시 실행)
    수동수집: python collect.py --manual   (담당자가 필요할 때 직접 실행)

두 방식 모두 collect(mode)를 공유하며, 판정 로직(신규/변경/동일/미운영전환)도 동일하다.
SPEC.md / PLAN.md 참고.
"""

import argparse
import hashlib
import html
import json
import re
import sqlite3
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
KEYWORDS_PATH = BASE_DIR / "keywords.json"
DB_PATH = BASE_DIR / "data.db"
IMAGES_DIR = BASE_DIR / "images"
DASHBOARD_PATH = BASE_DIR / "dashboard" / "index.html"

KST = timezone(timedelta(hours=9))
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
MOBILE_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
)

# PC(search.naver.com)와 Mobile(m.search.naver.com)은 완전히 다른 DOM 구조를 쓴다(실측
# 확인됨: PC는 main_title/main_desc/link_button_item/product_item/light_plus_item,
# Mobile은 title/desc_wrap/premium_item뿐 — 서브링크·상품 섹션 자체가 모바일엔 없다).
# 광고주가 PC/모바일 브랜드검색을 따로 켜고 끌 수 있어(실측: 파수/소프트캠프/마크애니는
# 모바일 브랜드검색 자체가 없음) 두 디바이스를 독립적으로 수집·판정·표시한다.
DEVICES = ("PC", "Mobile")
_DEVICE_CONFIG = {
    "PC": {
        "url_base": "https://search.naver.com/search.naver?query=",
        "viewport": {"width": 1200, "height": 1000},
        "user_agent": USER_AGENT,
        "is_mobile": False,
        "locator": ".brand_search",
    },
    "Mobile": {
        "url_base": "https://m.search.naver.com/search.naver?query=",
        "viewport": {"width": 390, "height": 844},
        "user_agent": MOBILE_USER_AGENT,
        "is_mobile": True,
        "locator": ".sp_brand",
    },
}


def now_iso():
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


# ---------- P1-01. 키워드 관리 ----------

def load_keywords():
    if not KEYWORDS_PATH.exists():
        return []
    with open(KEYWORDS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return [row for row in data if row.get("사용여부") == "Y"]


# ---------- P1-02. SQLite 스키마 ----------

# 신규 컬럼(구버전 data.db를 그대로 쓰는 경우를 위한 마이그레이션 목록)
_RECORD_MIGRATION_COLUMNS = [
    ("타이틀", "TEXT"),
    ("카피", "TEXT"),
    ("서브링크", "TEXT"),  # JSON 배열 문자열 (link_button_item 텍스트 목록)
    ("상품", "TEXT"),  # JSON 배열 문자열 (product_item 이름 목록)
    ("하단스트립", "TEXT"),  # JSON 배열 문자열 (light_plus_item 텍스트 목록)
    ("변경내역", "TEXT"),  # 상태="변경"일 때 직전과 달라진 항목 라벨(쉼표 구분)
    ("소재키", "TEXT"),  # 원본 소재 이미지 식별자(_creative_key) — 같은 키워드가 광고 소재를
    # 여러 개 로테이션 노출할 때(실측: 소프트캠프) 구분하는 용도. 판정 로직엔 관여하지 않고
    # 표시 전용("소재 N개" 배지).
    # DEFAULT 'PC': 이 컬럼이 생기기 전까지의 모든 기존 레코드는 실제로 PC만 수집했으므로,
    # ALTER TABLE 시점에 기존 행도 자동으로 'PC'로 채워지게 한다(SQLite는 ADD COLUMN에
    # DEFAULT가 있으면 기존 행에도 그 값을 채운다 — 별도 백필 스크립트 불필요).
    ("디바이스", "TEXT DEFAULT 'PC'"),
    # 모바일은 검색 직후 1차 캡처 + 4초 뒤 2차 캡처, 두 장을 모두 저장해 대시보드에서
    # 스와이프로 비교해 볼 수 있게 한다(PC는 항상 1장뿐이라 이 컬럼은 NULL로 남는다).
    ("이미지경로2", "TEXT"),
]


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            수집일시 TEXT NOT NULL,
            최종확인일시 TEXT NOT NULL,
            수집방식 TEXT NOT NULL,
            키워드 TEXT NOT NULL,
            운영여부 TEXT NOT NULL,
            상태 TEXT NOT NULL,
            타이틀 TEXT,
            카피 TEXT,
            서브링크 TEXT,
            상품 TEXT,
            하단스트립 TEXT,
            이미지경로 TEXT,
            원문링크 TEXT,
            콘텐츠해시 TEXT,
            변경내역 TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            실행일시 TEXT NOT NULL,
            수집방식 TEXT NOT NULL,
            대상키워드수 INTEGER,
            신규건수 INTEGER,
            변경건수 INTEGER,
            미운영전환건수 INTEGER,
            동일건수 INTEGER,
            오류수 INTEGER,
            오류내용 TEXT
        )
        """
    )
    existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(records)")}
    for col, col_type in _RECORD_MIGRATION_COLUMNS:
        if col not in existing_cols:
            conn.execute(f"ALTER TABLE records ADD COLUMN {col} {col_type}")
    conn.commit()
    return conn


# ---------- P1-03. 크롤러 ----------
# 네이버 통합검색의 브랜드검색 영역은 <div class="brand_search ..."> 안에
# <div class="brand_block ..."> 여러 개가 순서대로 들어있는 구조다
# (direct_link_area / brand_news_area / desktop_light / light_plus_bottom_wrap / m_brand_channel).
# "브랜드 SNS 소식"은 이 중 m_brand_channel 블록(<strong class="brand_channel_title">브랜드 SNS 소식</strong>)
# 하나이며, 실제 관측된 템플릿에서는 항상 마지막 블록이라 그 시작 지점부터 잘라내면 된다.
# ponytail: 지금까지 확인된 "light" 레이아웃 1종만 커버한다. 다른 브랜드검색 템플릿(예: light 블록이
# 없는 경우)을 만나면 이 파싱 규칙에 fallback 패턴을 추가해야 한다.

BRAND_SEARCH_MARK = re.compile(r'<div[^>]+class="brand_search\b')
MOBILE_BRAND_SEARCH_MARK = re.compile(r'<section[^>]+class="sc sp_brand\b')
SNS_BLOCK_MARK = re.compile(r'<strong class="brand_channel_title">')  # PC/Mobile 공통(실측 확인됨)

# PC/Mobile은 메인 소재의 타이틀·카피 마크업만 다르고(그 외 하단스트립·이미지·direct_link
# 폴백은 클래스명이 같아 공용으로 재사용 가능 — 실측 확인됨), 그 4개만 디바이스별로 분기한다.
_MARK_RE = {"PC": BRAND_SEARCH_MARK, "Mobile": MOBILE_BRAND_SEARCH_MARK}
_TITLE_RE = {
    "PC": re.compile(r'<a class="main_title"[^>]*>(.*?)</a>', re.S),
    "Mobile": re.compile(r'<strong class="title"><a[^>]*>(.*?)</a></strong>', re.S),
}
_DESC_BLOCK_RE = {
    "PC": re.compile(r'<div class="main_desc">(.*?)</div>', re.S),
    "Mobile": re.compile(r'<div class="desc_wrap"[^>]*>(.*?)</div>', re.S),
}
_DESC_P_RE = {
    "PC": re.compile(r"<p>(.*?)</p>", re.S),
    "Mobile": re.compile(r'<p class="desc">(.*?)</p>', re.S),
}
_LINK_RE = {
    "PC": re.compile(r'<a class="main_title" href="([^"]+)"'),
    "Mobile": re.compile(r'<strong class="title"><a href="([^"]+)"'),
}


def _text_only(fragment):
    text = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_brand_search(html_text, device="PC"):
    mark = _MARK_RE[device].search(html_text)
    if not mark:
        return {"운영여부": "미운영"}

    # 파싱 범위는 "브랜드검색 블록 시작 ~ 브랜드 SNS 소식 블록 직전"으로 좁힌다.
    # - 시작을 블록 앞으로 두면 페이지 상단의 다른 요소가 같은 클래스명(모바일의 title 등)을
    #   쓸 때 그쪽을 먼저 잡아버릴 수 있다.
    # - 브랜드 SNS 소식(m_brand_channel)은 모니터링·비교 대상에서 제외한다.
    sns_mark = SNS_BLOCK_MARK.search(html_text, mark.start())
    scoped = html_text[mark.start(): sns_mark.start()] if sns_mark else html_text[mark.start():]

    title = None
    m = _TITLE_RE[device].search(scoped)
    if m:
        title = _text_only(m.group(1))
    if not title:
        # light 블록(메인 소재)이 없는 브랜드검색 → direct_link 슬로건으로 대체
        m = re.search(r'<span class="logo_slogan">(.*?)</span>', scoped, re.S)
        title = _text_only(m.group(1)) if m else None

    desc = None
    m = _DESC_BLOCK_RE[device].search(scoped)
    if m:
        paras = _DESC_P_RE[device].findall(m.group(1))
        desc = " / ".join(t for t in (_text_only(p) for p in paras) if t) or None

    # 서브링크(link_button_item), 상품(product_item), 하단 스트립(light_plus_item/premium_item) —
    # PC의 main_title 외 나머지 3개 영역. 각 항목의 텍스트만 목록으로 뽑는다.
    # 서브링크·상품은 모바일 마크업엔 아예 없는 영역이라(실측 확인됨) 자연히 빈 목록이 된다.
    sublinks = [
        _text_only(t) for t in re.findall(r'<a class="link_button"[^>]*>(.*?)</a>', scoped, re.S)
    ]
    products = [
        _text_only(t) for t in re.findall(r'<div class="product_name">(.*?)</div>', scoped, re.S)
    ]
    # item_text는 PC(light_plus_item)/Mobile(premium_item) 둘 다 같은 클래스명(실측 확인됨).
    strip_items = [
        _text_only(t) for t in re.findall(r'<span class="item_text">(.*?)</span>', scoped, re.S)
    ]

    image_url = None
    # 모바일은 thumb_area 안에 <img>가 바로 오지 않고 <a class="thumb">로 한 겹 감싸여
    # 있어(실측 확인됨) 그 감싸는 태그를 선택적으로 건너뛴다 — PC엔 없어도 매칭에 지장 없음.
    m = re.search(r'class="thumb_area[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*<img src="([^"]+)"', scoped, re.S)
    if not m:
        m = re.search(r'class="direct_link_thumb">\s*<img src="([^"]+)"', scoped, re.S)
    if m:
        image_url = html.unescape(m.group(1))

    link_url = None
    m = _LINK_RE[device].search(scoped)
    if not m:
        m = re.search(r'<a class="direct_link"[^>]*href="([^"]+)"', scoped)
    if m:
        link_url = html.unescape(m.group(1))

    return {
        "운영여부": "운영중",
        "타이틀": title,
        "카피": desc,
        "서브링크": sublinks,
        "상품": products,
        "하단스트립": strip_items,
        "이미지URL": image_url,
        "원문링크": link_url,
    }


# 원문링크(ader.naver.com)는 요청마다 트래킹 토큰이 바뀌어 소재 구분에 못 쓰지만,
# 이미지URL 안의 원본 CDN 경로(ditto-phinf.pstatic.net/.../파일명)는 같은 소재면
# 요청을 몇 번을 다시 해도 완전히 동일하다(실측 확인됨) — 이걸 소재 식별 키로 쓴다.
_CREATIVE_SRC_RE = re.compile(r"[?&]src=([^&]+)")


def _creative_key(image_url):
    if not image_url:
        return None
    m = _CREATIVE_SRC_RE.search(image_url)
    src = urllib.parse.unquote(m.group(1)) if m else image_url
    return src.split("ditto-phinf.pstatic.net/")[-1]


# 브랜드 SNS 소식 블록은 화면에서도 감춰서 스크린샷에 나오지 않게 한다
# (data-block-data-set="brandchannel" / class에 m_brand_channel 포함, PC/Mobile 공통).
def _hide_sns_js(selector):
    return (
        f'document.querySelectorAll(\'{selector} [class*="m_brand_channel"]\')'
        ".forEach(el => el.style.display = 'none')"
    )


def capture_brand_search_image(page, device="PC"):
    """이미 page.goto()로 로드된 page에서 브랜드검색 영역 전체
    (본문+서브링크+상품+하단 스트립, 브랜드 SNS 소식 제외)를 PNG 스크린샷
    바이트로 캡처한다. 해당 디바이스의 브랜드검색 요소가 없으면 None을 반환한다."""
    selector = _DEVICE_CONFIG[device]["locator"]
    locator = page.locator(selector).first
    if locator.count() == 0:
        return None
    page.evaluate(_hide_sns_js(selector))
    return locator.screenshot()


# ---------- P1-04. 콘텐츠 해시 + 변경 판정 ----------

def build_hash(image_bytes):
    # 브랜드검색 캡처 이미지(본문+서브링크+상품+하단 스트립 전체 영역 스크린샷)
    # 바이트를 그대로 해시한다. 텍스트 필드를 하나하나 비교하지 않고 이미지
    # 통째로 비교해 어떤 하위 요소가 바뀌어도 놓치지 않고 "변경"으로 감지된다.
    # 무엇이 바뀌었는지는 diff_fields()가 별도로 라벨링한다.
    return hashlib.sha256(image_bytes).hexdigest()


def _dumps(str_list):
    """서브링크/상품/하단스트립 목록을 DB에 저장할 JSON 문자열로 직렬화한다.
    diff_fields()도 같은 함수로 직렬화한 값을 비교하므로 포맷이 항상 일치한다."""
    return json.dumps(str_list or [], ensure_ascii=False)


_DIFF_FIELD_LABELS = [
    ("타이틀", "타이틀(main_title)"),
    ("카피", "카피(main_desc)"),
    ("서브링크", "서브링크(link_button_item)"),
    ("상품", "상품(product_item)"),
    ("하단스트립", "하단스트립(light_plus_item)"),
]


def diff_fields(prev_record, parsed):
    """직전 레코드와 이번 파싱 결과를 필드별로 비교해, 달라진 항목의 라벨 목록을 반환한다.
    prev_record가 없으면(신규) 빈 목록을 반환한다."""
    if prev_record is None:
        return []
    changed = []
    for key, label in _DIFF_FIELD_LABELS:
        prev_value = prev_record[key] if key in prev_record.keys() else None
        if key in ("서브링크", "상품", "하단스트립"):
            current_value = _dumps(parsed.get(key))
        else:
            current_value = parsed.get(key)
        if (prev_value or None) != (current_value or None):
            changed.append(label)
    return changed


def classify(prev_record, current):
    """
    prev_record: 해당 키워드의 최신 레코드(sqlite3.Row 또는 dict) 또는 None
    current: {"운영여부": "운영중"|"미운영", "콘텐츠해시": str|None}
    반환: "신규" | "변경" | "동일" | "미운영전환"

    "신규"는 그 키워드(+디바이스)의 수집 히스토리에 레코드가 하나도 없을 때(prev_record
    is None, 이번이 저장되면 히스토리에 정확히 1건만 남는 경우)만 붙는다 — 미운영으로
    있다가 다시 운영중으로 돌아온 건 "신규"가 아니라 "변경"이다(과거 이력이 이미 있으니).
    """
    if current["운영여부"] == "미운영":
        if prev_record is None or prev_record["운영여부"] != "미운영":
            return "미운영전환"
        return "동일"
    # 운영중
    if prev_record is None:
        return "신규"
    if prev_record["운영여부"] != "운영중":
        # 미운영 → 운영중 재개: 처음 수집이 아니므로 "신규"가 아니라 "변경"
        return "변경"
    if prev_record["콘텐츠해시"] != current["콘텐츠해시"]:
        return "변경"
    return "동일"


def _resolve_status(status, current_creative_key, known_creative_keys, has_earlier_date_record):
    """classify()가 낸 "변경" 판정을 두 가지 기준으로 다시 본다.

    1) 이전 날짜의 수집 기록이 아예 없으면(= 이 키워드의 전체 히스토리가 오늘 하루뿐)
       아직 "신규"다. 같은 날 여러 번 수집해서 소재가 로테이션돼도(소재 N개는 별개 축이다)
       비교할 과거 수집 세트 자체가 없으므로 "변경"이라고 부를 근거가 없다.
    2) 이전 날짜 기록이 있는데 이번 소재가 이미 관측된 적 있는 소재면(로테이션 복귀)
       "변경" 알림 대신 "동일"로 낮춰 상태값을 사실상 숨긴다 — classify()는 직전 레코드
       1건하고만 비교해서 알려진 소재로 되돌아오는 것도 매번 "변경"으로 잡기 때문
       (실측 확인됨: 소프트캠프). 처음 보는 소재일 때만 "변경"으로 알린다.

    "신규"/"미운영전환"/"동일"은 그대로 둔다(첫 수집·운영 여부 전환은 이 로직과 무관)."""
    if status != "변경":
        return status
    if not has_earlier_date_record:
        return "신규"
    if current_creative_key and current_creative_key in known_creative_keys:
        return "동일"
    return "변경"


# ---------- P1-05. 캡처 이미지 저장 ----------

def save_screenshot(image_bytes, keyword, collected_at, device="PC", suffix=""):
    safe_keyword = re.sub(r"[^\w가-힣-]", "_", keyword)
    safe_ts = re.sub(r"[^\d]", "", collected_at)
    # PC/Mobile을 하위 폴더로 분리 — 같은 키워드를 같은 실행에서 둘 다 수집하면
    # collected_at(초 단위)이 겹칠 수 있어 파일명 충돌을 막는다.
    folder = IMAGES_DIR / safe_keyword / device
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{safe_ts}{suffix}.png"  # Playwright locator.screenshot() 기본 포맷
    dest.write_bytes(image_bytes)
    return str(dest.relative_to(BASE_DIR))


# ---------- P1-06. 레코드 저장 (자동/수동 공통) ----------

def get_latest_record(conn, keyword, device="PC"):
    cur = conn.execute(
        "SELECT * FROM records WHERE 키워드 = ? AND 디바이스 = ? ORDER BY 수집일시 DESC, id DESC LIMIT 1",
        (keyword, device),
    )
    return cur.fetchone()


def insert_record(conn, record):
    conn.execute(
        """
        INSERT INTO records
            (수집일시, 최종확인일시, 수집방식, 키워드, 운영여부, 상태,
             타이틀, 카피, 서브링크, 상품, 하단스트립, 이미지경로, 원문링크, 콘텐츠해시, 변경내역, 소재키, 디바이스, 이미지경로2)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["수집일시"],
            record["최종확인일시"],
            record["수집방식"],
            record["키워드"],
            record["운영여부"],
            record["상태"],
            record.get("타이틀"),
            record.get("카피"),
            record.get("서브링크"),
            record.get("상품"),
            record.get("하단스트립"),
            record.get("이미지경로"),
            record.get("원문링크"),
            record.get("콘텐츠해시"),
            record.get("변경내역"),
            record.get("소재키"),
            record.get("디바이스", "PC"),
            record.get("이미지경로2"),
        ),
    )
    conn.commit()


def touch_last_checked(conn, record_id, checked_at):
    conn.execute(
        "UPDATE records SET 최종확인일시 = ? WHERE id = ?", (checked_at, record_id)
    )
    conn.commit()


# ---------- P1-08. 로그 기록 ----------

def write_log(conn, summary):
    conn.execute(
        """
        INSERT INTO logs
            (실행일시, 수집방식, 대상키워드수, 신규건수, 변경건수, 미운영전환건수, 동일건수, 오류수, 오류내용)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            summary["실행일시"],
            summary["수집방식"],
            summary["대상키워드수"],
            summary["신규건수"],
            summary["변경건수"],
            summary["미운영전환건수"],
            summary["동일건수"],
            summary["오류수"],
            summary["오류내용"],
        ),
    )
    conn.commit()


# ---------- P1-09. 대시보드 정적 HTML 생성 ----------

STATUS_LABEL = {
    "신규": ("badge-new", "신규"),
    "변경": ("badge-changed", "변경"),
    "동일": ("badge-same", "변경사항 없음"),
    "미운영전환": ("badge-off", "미운영"),
}

DEVICE_VIEW_TEMPLATE = """
  <div class="thumb-cell">{img}</div>
  <div class="body-cell">
    <div class="row"><span class="badge {badge_class}">{badge_text}</span><span class="keyword">{keyword}</span><span class="row-arrow"></span></div>
    {change_note}
    <div class="fields" hidden>
    <div class="field">
      <span class="field-label">타이틀 <code>{title_class}</code></span>
      <div class="field-value">{title}</div>
    </div>
    <div class="field">
      <span class="field-label">카피 <code>{desc_class}</code></span>
      <div class="field-value">{copy}</div>
    </div>
    <div class="field">
      <span class="field-label">서브링크 <code>{sublinks_class}</code></span>
      <div class="field-value">{sublinks}</div>
    </div>
    <div class="field">
      <span class="field-label">상품 <code>{products_class}</code></span>
      <div class="field-value">{products}</div>
    </div>
    <div class="field">
      <span class="field-label">하단스트립 <code>{strip_class}</code></span>
      <div class="field-value">{strip}</div>
    </div>
    </div>
    <p class="meta">수집일시: {collected_at} · 최종확인: {checked_at}</p>
    {link}
  </div>
"""

DEVICE_VIEW_EMPTY_TEMPLATE = """
  <div class="thumb-cell"><span class="none">-</span></div>
  <div class="body-cell">
    <div class="row"><span class="keyword">{keyword}</span></div>
    <p class="meta">이 수집 세트엔 새 기록 없음</p>
  </div>
"""

# PC/Mobile은 필드 <code> 힌트(클래스명)가 다르다 — 실측 확인된 실제 마크업 기준.
# 서브링크·상품은 모바일 마크업에 그 영역 자체가 없다.
_DEVICE_FIELD_CLASS = {
    "PC": {"title": "main_title", "desc": "main_desc", "sublinks": "link_button_item", "products": "product_item", "strip": "light_plus_item"},
    "Mobile": {"title": "title", "desc": "desc_wrap", "sublinks": "(모바일 없음)", "products": "(모바일 없음)", "strip": "premium_item"},
}

BRAND_COL_TEMPLATE = """
<div class="brand-col">
  <div class="device-switch">
    <button type="button" class="device-btn active" data-device="PC">PC</button>
    <button type="button" class="device-btn" data-device="Mobile">Mobile</button>
  </div>
  <div class="device-view" data-device="PC">{pc_view}</div>
  <div class="device-view" data-device="Mobile" hidden>{mobile_view}</div>
</div>
"""

DAY_SECTION_TEMPLATE = """
<details class="day-section"{open_attr}>
  <summary class="day-title">
    <span class="day-title-arrow"></span>
    <span class="day-title-date">{date}</span>
    <span class="day-title-sub">수집</span>
    <span class="day-title-count">{updated_count}/{n_cols} 브랜드 갱신</span>
  </summary>
  <div class="brand-columns" style="grid-template-columns: repeat({grid_cols}, 1fr);">
{columns}
  </div>
</details>
"""

PAGE_TEMPLATE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>네이버 브랜드검색 모니터링</title>
<style>
  body {{ font-family: -apple-system, sans-serif; background:#f5f5f5; margin:0; padding:24px; }}
  .container {{ max-width:1920px; margin:0 auto; }}
  h1 {{ font-size:18px; margin:0 0 20px; }}
  .day-section {{ margin-bottom:4px; border-left:4px solid #e0e0e0; border-radius:0 10px 10px 0; transition:border-color .15s ease; }}
  .day-section[open] {{ border-left-color:#3b4a9e; }}
  /* 날짜 섹션을 <details>/<summary>로 접고 펼친다 — 최신 날짜만 기본으로 펼쳐지고
     (build_dashboard에서 첫 섹션에만 open 속성을 붙임), 과거 날짜는 접힌 채로 시작한다. */
  .day-title {{
    display:flex; align-items:center; gap:10px;
    margin:0; padding:14px 18px; border-radius:0 10px 10px 0;
    background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.08);
    cursor:pointer; list-style:none; user-select:none;
    transition:background .12s ease;
  }}
  .day-title::-webkit-details-marker {{ display:none; }}
  .day-title:hover {{ background:#f7f8fc; }}
  .day-title-arrow {{
    display:inline-flex; align-items:center; justify-content:center;
    width:22px; height:22px; border-radius:50%; flex-shrink:0;
    background:#eef0fb; color:#3b4a9e; font-size:12px;
    transition:transform .15s ease;
  }}
  .day-title-arrow::before {{ content:'▶'; }}
  .day-section[open] > .day-title .day-title-arrow {{ transform:rotate(90deg); }}
  .day-title-date {{ font-size:16px; font-weight:700; color:#222; }}
  .day-title-sub {{ font-size:12px; color:#999; font-weight:400; }}
  .day-title-count {{
    margin-left:auto; font-size:12px; font-weight:600; color:#3b4a9e;
    background:#eef0fb; border-radius:1000px; padding:4px 10px; flex-shrink:0;
  }}
  .day-section .brand-columns {{ margin-top:16px; padding:0 18px 4px; }}
  /* 브랜드 개수만큼 컬럼을 나눈다 (지금은 3개 → 3분할). 브랜드 컬럼 안에서는
     thumb-cell을 위, body-cell을 아래로 세로(column) 정렬한다.
     align-items 기본값(stretch)을 그대로 둬서 같은 행의 brand-col 높이가 전부 맞춰지게 한다. */
  .brand-columns {{ display:grid; gap:16px; }}
  .brand-col {{ display:flex; flex-direction:column; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.12); }}
  /* brand-col 안에서 PC/Mobile 수집 결과를 전환하는 버튼(실측: 광고주가 PC/모바일
     브랜드검색을 따로 켜고 끌 수 있어 둘의 내용이 다르다 — 소프트캠프/파수/마크애니는
     모바일 브랜드검색 자체가 없음). */
  .device-switch {{ display:flex; gap:4px; padding:16px; }}
  .device-btn {{ font-size:12px; padding:4px 10px; border:none; border-radius:1000px; background:#eee; color:#666; cursor:pointer; }}
  .device-btn.active {{ background:#333; color:#fff; }}
  .device-view {{ display:flex; flex-direction:column; flex:1; }}
  .device-view[hidden] {{ display:none; }}
  /* device-view 하단의 소재 전환 버튼([1][2]...) — 소재가 2개 이상일 때만(실측: 소프트캠프
     PC). 버튼을 누르면 별도 블록이 추가되는 게 아니라 device-view 자리(이미지+필드
     전체)가 그 소재의 화면으로 바로 바뀐다 — creative-panel이 그 자리를 채우는
     실제 콘텐츠이고, creative-switch는 항상 하단에 고정된 채 어느 패널이 보일지만 정한다. */
  .creative-switch {{ display:flex; flex-wrap:wrap; gap:4px; padding:16px; border-top:2px solid #eee; margin-top:auto; }}
  .creative-btn {{ font-size:12px; padding:4px 10px; border:none; border-radius:1000px; background:#eee; color:#666; cursor:pointer; }}
  .creative-btn.active {{ background:#333; color:#fff; }}
  .creative-panel {{ display:flex; flex-direction:column; }}
  .creative-panel[hidden] {{ display:none; }}
  /* 캡처 이미지마다 실제 비율이 달라 높이가 제각각이므로 썸네일 높이를 고정한다.
     object-fit:contain이라 잘리지 않고 비율 그대로 축소돼 여백(레터박스)이 생길 수 있다. */
  .thumb-cell {{ background:#eee; aspect-ratio: 1 / 1; overflow:hidden; flex-shrink:0; }}
  .thumb-cell img {{ width:100%; height:100%; object-fit:contain; display:block; cursor:zoom-in; }}
  .thumb-cell .none {{ display:flex; height:100%; align-items:center; justify-content:center; color:#999; font-size:14px; }}
  /* 모바일 2장 캡처(검색 직후/4초 후) 스와이프 — 네이티브 scroll-snap이라 터치 스와이프가
     그냥 된다. 좌우 화살표는 마우스로 볼 때(스크롤 제스처 없이) 넘기기 편하라고 곁들인다. */
  .swiper {{ position:relative; width:100%; height:100%; }}
  .swiper-track {{ display:flex; width:100%; height:100%; overflow-x:auto; scroll-snap-type:x mandatory; scrollbar-width:none; }}
  .swiper-track::-webkit-scrollbar {{ display:none; }}
  .swiper-track img {{ flex:0 0 100%; scroll-snap-align:start; }}
  .swiper-nav {{ position:absolute; top:50%; transform:translateY(-50%); width:24px; height:24px; border:none; border-radius:1000px; background:rgba(0,0,0,.4); color:#fff; font-size:14px; line-height:1; cursor:pointer; }}
  .swiper-prev {{ left:4px; }}
  .swiper-next {{ right:4px; }}
  /* thumb-cell 클릭 시 이미지 확대(라이트박스). 네이티브 <dialog>로 배경 dim/포커스 트랩을 공짜로 얻는다. */
  .lightbox {{ border:none; padding:0; background:transparent; max-width:92vw; max-height:92vh; }}
  .lightbox::backdrop {{ background:rgba(0,0,0,.8); }}
  .lightbox img {{ display:block; max-width:92vw; max-height:92vh; object-fit:contain; cursor:zoom-out; }}
  /* 모바일 2장(스와이프) 카드를 확대할 때도 그대로 스와이프할 수 있게 라이트박스 안에
     같은 .swiper 구조를 하나 더 둔다(.swiper-nav 클릭 처리는 기존 로직을 그대로 재사용).
     1장뿐인 카드는 기존처럼 #lightbox-img 단일 이미지 경로를 그대로 쓴다. */
  .lightbox-swiper {{ width:92vw; height:92vh; }}
  .lightbox-swiper[hidden] {{ display:none; }}
  .lightbox-swiper .swiper-track img {{ width:100%; height:100%; max-width:none; max-height:none; object-fit:contain; cursor:zoom-out; }}
  .body-cell {{ padding:16px; }}
  /* row(배지+키워드)를 누르면 그 아래 field들이 펼쳐지는 아코디언 트리거 — 기본은
     접힘(.fields[hidden]). 화살표는 day-section 아코디언과 같은 시각 언어를 쓴다. */
  .row {{ display:flex; flex-direction:column; align-items:flex-start; gap:4px; margin-bottom:6px; position:relative; padding-right:24px; cursor:pointer; }}
  .row-arrow {{ position:absolute; top:0; right:0; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; color:#999; font-size:12px; transition:transform .15s ease; }}
  .row-arrow::before {{ content:'▶'; }}
  .row.expanded .row-arrow {{ transform:rotate(90deg); }}
  .keyword {{ font-weight:600; font-size:14px; }}
  .badge {{ font-size:12px; padding:2px 8px; border-radius:1000px; color:#fff; flex-shrink:0; }}
  .badge-new {{ background:#2f7d32; }}
  .badge-changed {{ background:#e08e0b; }}
  .badge-same {{ background:#9aa0a6; }}
  .badge-off {{ background:#c0392b; }}
  .meta {{ font-size:12px; color:#888; margin:6px 0; }}
  a.link {{ font-size:12px; }}
  .change-note {{ font-size:12px; color:#a3540a; background:#fff3e0; border-radius:6px; padding:6px 10px; margin:0 0 8px; }}
  /* 필드: 라벨을 위, 값을 아래로 세로 정렬 + 필드 사이 간격을 넉넉히 */
  .field {{ display:flex; flex-direction:column; gap:4px; margin-bottom:16px; font-size:14px; }}
  .field-label {{ color:#888; font-size:12px; }}
  .field-label code {{ display:none; }}
  .field-empty {{ color:#bbb; }}
  .pill {{ display:inline-block; background:#eef2ff; color:#3b4a9e; font-size:12px; padding:2px 8px; border-radius:1000px; margin:0 4px 4px 0; }}

  /* 상단 바: 운영 중인 키워드 표시 + 새 키워드 입력 + 수동 수집 */
  .topbar {{ display:flex; flex-direction:column; align-items:flex-start; gap:16px; margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid #ddd; }}
  /* kw-status-group: 라벨(위) / 배지 묶음(아래)을 세로(column)로 정렬 */
  .kw-status-group {{ display:flex; flex-direction:column; align-items:flex-start; gap:8px; }}
  .kw-status-group-label {{ font-size:12px; color:#888; }}
  /* kw-status 배지들은 한 묶음으로 가로(row) 정렬 */
  .kw-status-row {{ display:flex; flex-direction:row; flex-wrap:wrap; gap:8px; }}
  .kw-status {{ display:inline-flex; align-items:center; gap:6px; font-size:12px; background:#fff; border-radius:1000px; padding:6px 12px; box-shadow:0 1px 2px rgba(0,0,0,.08); }}
  .kw-status .dot {{ width:8px; height:8px; border-radius:50%; flex-shrink:0; }}
  .kw-status-on .dot {{ background:#2f7d32; }}
  .kw-status-off .dot {{ background:#c0392b; }}
  .kw-status-pending .dot {{ background:#999; }}
  .kw-status em {{ font-style:normal; color:#888; }}
  .kw-delete {{ margin-left:2px; border:none; background:transparent; color:#bbb; font-size:14px; line-height:1; cursor:pointer; padding:0 2px; }}
  .kw-delete:hover {{ color:#c0392b; }}
  .kw-add, .manual-collect {{ display:flex; flex-direction:row; flex-wrap:nowrap; gap:6px; align-items:center; }}
  .kw-add input {{ font-size:14px; padding:8px 10px; border:1px solid #ccc; border-radius:6px; min-width:160px; }}
  .kw-add button, .manual-collect button {{ font-size:12px; padding:8px 12px; border:none; border-radius:6px; background:#333; color:#fff; cursor:pointer; }}
  .kw-add button:disabled, .manual-collect button:disabled {{ background:#999; cursor:default; }}
  .kw-add-status, .manual-collect-status {{ font-size:12px; color:#2f7d32; min-width:180px; }}
  .kw-add-status.error, .manual-collect-status.error {{ color:#c0392b; }}

  /* 화면 전환 탭 */
  .tabs {{ display:flex; gap:8px; margin-bottom:20px; }}
  .tab-btn {{ font-size:14px; padding:10px 18px; border:none; border-radius:6px; background:#e5e5e5; color:#555; cursor:pointer; }}
  .tab-btn.active {{ background:#333; color:#fff; }}

  /* 로그 히스토리 표 (수집 실행 이력 — 시간순 표 형태가 자연스러운 데이터라 table 사용) */
  .logs-table {{ width:100%; border-collapse:collapse; background:#fff; font-size:12px; }}
  .logs-table th, .logs-table td {{ border:1px solid #eee; padding:8px 10px; text-align:left; }}
  .logs-table th {{ background:#f0f0f0; font-size:12px; color:#666; }}
</style>
</head>
<body>
<div class="container">
<h1>네이버 브랜드검색 모니터링 ({generated_at} 기준)</h1>

<div class="topbar">
  <div class="kw-status-group">
    <span class="kw-status-group-label">운영 중인 키워드</span>
    <div class="kw-status-row">{keyword_status}</div>
  </div>
  <div class="kw-add">
    <input type="text" id="new-kw-input" placeholder="새 키워드 입력">
    <button type="button" id="kw-add-btn" onclick="addKeyword()">키워드 추가</button>
    <span id="kw-add-status" class="kw-add-status"></span>
  </div>
  <div class="manual-collect">
    <button type="button" id="manual-collect-btn" onclick="runManualCollect()">지금 수동 수집 실행</button>
    <span id="manual-collect-status" class="manual-collect-status"></span>
  </div>
</div>

<div class="tabs">
  <button type="button" class="tab-btn active" data-view="dashboard" onclick="showView('dashboard')">대시보드</button>
  <button type="button" class="tab-btn" data-view="logs" onclick="showView('logs')">로그 히스토리</button>
</div>

<div id="view-dashboard">
{sections}
</div>
<div id="view-logs" hidden>
{logs_table}
</div>
</div>

<dialog id="lightbox" class="lightbox">
  <img id="lightbox-img" src="" alt="">
  <div class="swiper lightbox-swiper" id="lightbox-swiper" hidden>
    <div class="swiper-track" id="lightbox-track"></div>
    <button type="button" class="swiper-nav swiper-prev" aria-label="이전 이미지">‹</button>
    <button type="button" class="swiper-nav swiper-next" aria-label="다음 이미지">›</button>
  </div>
</dialog>

<script>
function showView(name) {{
  document.getElementById('view-dashboard').hidden = (name !== 'dashboard');
  document.getElementById('view-logs').hidden = (name !== 'logs');
  document.querySelectorAll('.tab-btn').forEach(function(b) {{
    b.classList.toggle('active', b.dataset.view === name);
  }});
}}

function setStatus(el, text, isError) {{
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}}

function postJson(url, body) {{
  return fetch(url, {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify(body || {{}}),
  }}).then(function(res) {{
    return res.json().then(function(data) {{ return {{ok: res.ok, data: data}}; }});
  }});
}}

function addKeyword() {{
  var input = document.getElementById('new-kw-input');
  var btn = document.getElementById('kw-add-btn');
  var status = document.getElementById('kw-add-status');
  var kw = input.value.trim();
  if (!kw) {{ setStatus(status, '키워드를 입력하세요', true); return; }}

  btn.disabled = true;
  setStatus(status, '추가하는 중...', false);
  postJson('/api/keywords', {{'브랜드명': kw}}).then(function(r) {{
    if (r.ok && r.data.ok) {{
      setStatus(status, '추가됨 — 새로고침합니다...', false);
      location.reload();
    }} else {{
      setStatus(status, '실패: ' + (r.data.error || '알 수 없는 오류'), true);
      btn.disabled = false;
    }}
  }}).catch(function() {{
    setStatus(status, '서버에 연결할 수 없습니다. python3 server.py를 먼저 실행하세요.', true);
    btn.disabled = false;
  }});
}}

function runManualCollect() {{
  var btn = document.getElementById('manual-collect-btn');
  var status = document.getElementById('manual-collect-status');
  btn.disabled = true;
  setStatus(status, '수집 중... (키워드마다 몇 초씩 걸립니다)', false);
  postJson('/api/collect', {{}}).then(function(r) {{
    if (r.ok && r.data.ok) {{
      setStatus(status, '완료: ' + JSON.stringify(r.data.counts) + ' — 새로고침합니다...', false);
      location.reload();
    }} else {{
      setStatus(status, '실패: ' + (r.data.error || '알 수 없는 오류'), true);
      btn.disabled = false;
    }}
  }}).catch(function() {{
    setStatus(status, '서버에 연결할 수 없습니다. python3 server.py를 먼저 실행하세요.', true);
    btn.disabled = false;
  }});
}}

document.addEventListener('click', function(e) {{
  var btn = e.target.closest('.swiper-nav');
  if (!btn) return;
  var track = btn.closest('.swiper').querySelector('.swiper-track');
  var dir = btn.classList.contains('swiper-next') ? 1 : -1;
  track.scrollBy({{left: dir * track.clientWidth, behavior: 'auto'}});
}});

document.addEventListener('click', function(e) {{
  var img = e.target.closest('.thumb-cell img');
  if (!img) return;
  var lightbox = document.getElementById('lightbox');
  var singleImg = document.getElementById('lightbox-img');
  var swiperBox = document.getElementById('lightbox-swiper');
  var track = img.closest('.swiper-track');
  if (track) {{
    // 카드 쪽이 스와이프(모바일 2장)면 라이트박스도 같은 슬라이드 순서로 스와이프되게 한다.
    var slideImgs = track.querySelectorAll('img');
    var idx = Array.prototype.indexOf.call(slideImgs, img);
    document.getElementById('lightbox-track').innerHTML = Array.prototype.map.call(
      slideImgs, function(s) {{ return '<img src="' + s.src + '" alt="' + s.alt + '">'; }}
    ).join('');
    singleImg.hidden = true;
    swiperBox.hidden = false;
    lightbox.showModal();
    // 클릭한 슬라이드부터 보여준다(showModal 이후라야 clientWidth가 실제 값으로 잡힌다).
    swiperBox.querySelector('.swiper-track').scrollLeft = idx * swiperBox.clientWidth;
  }} else {{
    singleImg.src = img.src;
    singleImg.hidden = false;
    swiperBox.hidden = true;
    lightbox.showModal();
  }}
}});

document.getElementById('lightbox').addEventListener('click', function(e) {{
  // 이미지(단일/스와이프 슬라이드) 클릭, 화살표 클릭은 닫지 않고, 그 밖(배경) 클릭만 닫는다.
  if (e.target.closest('#lightbox-img, .lightbox-swiper img, .swiper-nav')) return;
  this.close();
}});
document.getElementById('lightbox-img').addEventListener('click', function() {{
  this.closest('dialog').close(); // 이미지 클릭으로도 닫기(zoom-out 커서와 짝)
}});
document.addEventListener('click', function(e) {{
  var img = e.target.closest('.lightbox-swiper img');
  if (img) img.closest('dialog').close(); // 스와이프 슬라이드 클릭으로도 닫기
}});

document.addEventListener('click', function(e) {{
  var btn = e.target.closest('.device-btn');
  if (!btn) return;
  var col = btn.closest('.brand-col');
  var device = btn.dataset.device;
  col.querySelectorAll('.device-btn').forEach(function(b) {{ b.classList.toggle('active', b === btn); }});
  col.querySelectorAll('.device-view').forEach(function(v) {{ v.hidden = (v.dataset.device !== device); }});
}});

document.addEventListener('click', function(e) {{
  var row = e.target.closest('.row');
  if (!row) return;
  var bodyCell = row.closest('.body-cell');
  var fields = bodyCell && bodyCell.querySelector('.fields');
  if (!fields) return; // 필드가 없는 row(예: "새 기록 없음" 빈 칸)는 아코디언 대상이 아님
  fields.hidden = !fields.hidden;
  row.classList.toggle('expanded', !fields.hidden);
}});

document.addEventListener('click', function(e) {{
  var btn = e.target.closest('.creative-btn');
  if (!btn) return;
  var view = btn.closest('.device-view'); // PC/Mobile 탭마다 소재 목록이 독립이라 이 범위로 제한
  var n = btn.dataset.creative;
  view.querySelectorAll('.creative-btn').forEach(function(b) {{ b.classList.toggle('active', b === btn); }});
  view.querySelectorAll('.creative-panel').forEach(function(p) {{ p.hidden = (p.dataset.creative !== n); }});
}});

document.addEventListener('click', function(e) {{
  var btn = e.target.closest('.kw-delete');
  if (!btn) return;
  var kw = btn.dataset.kw;
  if (!confirm(kw + ' 키워드를 삭제할까요?\\n(수집 기록은 남고, 대시보드 컬럼만 사라집니다)')) return;

  btn.disabled = true;
  postJson('/api/keywords/delete', {{'브랜드명': kw}}).then(function(r) {{
    if (r.ok && r.data.ok) {{
      location.reload();
    }} else {{
      alert('삭제 실패: ' + (r.data.error || '알 수 없는 오류'));
      btn.disabled = false;
    }}
  }}).catch(function() {{
    alert('서버에 연결할 수 없습니다. python3 server.py를 먼저 실행하세요.');
    btn.disabled = false;
  }});
}});
</script>
</body>
</html>
"""


def _text_field_html(value):
    return html.escape(value) if value else '<span class="field-empty">-</span>'


def _pill_field_html(json_text):
    values = json.loads(json_text) if json_text else []
    if not values:
        return '<span class="field-empty">-</span>'
    return "".join(f'<span class="pill">{html.escape(v)}</span>' for v in values)


def _fill_device_view(r, keyword_label, badge_class, badge_text, change_note, device):
    """레코드 하나(r)로 DEVICE_VIEW_TEMPLATE을 채운다 — "오늘자 상태" 렌더링과
    소재별 전환 패널 렌더링이 이 로직을 공유한다."""
    # 있는 캡처만 모은다 — 모바일 2장(검색 직후/4초 후) 중 1차만 실패하는 경우가 있어
    # (광고 블록 지연 렌더링) "이미지경로가 있을 때만"으로 판단하면 저장된 2차 캡처가
    # 화면에서 통째로 사라진다. 2차(4초 후, 안정된 프레임)를 1순위로 먼저 보여준다 —
    # 실측 확인됨: 1차(검색 직후)는 같은 소재인데도 로딩 타이밍에 따라 해시가 흔들리는
    # 반면 2차는 항상 안정적이다.
    image_paths = [p for p in (r["이미지경로2"], r["이미지경로"]) if p]
    alt = html.escape(r["키워드"])
    if len(image_paths) > 1:
        # 스와이프로 넘겨볼 수 있게 트랙에 나란히 둔다.
        slides = "".join(f'<img src="../{html.escape(p)}" alt="{alt} 소재">' for p in image_paths)
        img = (
            f'<div class="swiper"><div class="swiper-track">{slides}</div>'
            f'<button type="button" class="swiper-nav swiper-prev" aria-label="이전 이미지">‹</button>'
            f'<button type="button" class="swiper-nav swiper-next" aria-label="다음 이미지">›</button></div>'
        )
    elif image_paths:
        img = f'<img src="../{html.escape(image_paths[0])}" alt="{alt} 소재">'
    else:
        img = '<span class="none">이미지 없음</span>'
    link = (
        f'<a class="link" href="{html.escape(r["원문링크"])}" target="_blank">원문 보기</a>'
        if r["원문링크"]
        else ""
    )
    field_class = _DEVICE_FIELD_CLASS[device]
    return DEVICE_VIEW_TEMPLATE.format(
        img=img,
        keyword=html.escape(keyword_label),
        badge_class=badge_class,
        badge_text=badge_text,
        change_note=change_note,
        title=_text_field_html(r["타이틀"]),
        title_class=field_class["title"],
        copy=_text_field_html(r["카피"]),
        desc_class=field_class["desc"],
        sublinks=_pill_field_html(r["서브링크"]),
        sublinks_class=field_class["sublinks"],
        products=_pill_field_html(r["상품"]),
        products_class=field_class["products"],
        strip=_pill_field_html(r["하단스트립"]),
        strip_class=field_class["strip"],
        collected_at=r["수집일시"],
        checked_at=r["최종확인일시"],
        link=link,
    )


def _render_creative_panels(keyword, keyword_label, r, carried, records, device):
    """소재가 2개 이상이면(로테이션 광고, 실측: 소프트캠프 PC) device-view 자체를
    소재별 패널로 구성한다 — 버튼([1][2]...)을 누르면 별도 블록이 추가되는 게 아니라
    그 자리(이미지+필드 전체)가 그대로 바뀐다. 번호는 처음 관측된 순서(1번=가장 오래된
    소재). r(오늘 이 날짜 세트의 실제 상태)와 같은 소재인 번호는 그 자리에 r을 그대로
    써서 carried/최종확인일시 등 "오늘자" 정보를 잃지 않는다 — 나머지 번호는 각자
    가장 최근 관측 시점 스냅샷이다."""
    current_key = r["소재키"]
    default_n = next((i for i, rec in enumerate(records, start=1) if rec["소재키"] == current_key), 1)

    buttons = []
    panels = []
    for i, rec in enumerate(records, start=1):
        is_current = rec["소재키"] == current_key
        active = i == default_n
        buttons.append(
            f'<button type="button" class="creative-btn{" active" if active else ""}" '
            f'data-creative="{i}">{i}</button>'
        )
        if is_current:
            row = r
            if carried:
                badge_class, badge_text = STATUS_LABEL["동일"]
            else:
                badge_class, badge_text = STATUS_LABEL.get(r["상태"], ("badge-same", r["상태"]))
            change_note = (
                f'<p class="change-note">바뀐 부분: {html.escape(r["변경내역"])}</p>'
                if not carried and r["상태"] == "변경" and r["변경내역"]
                else ""
            )
        else:
            row = rec
            badge_class, badge_text = STATUS_LABEL.get(rec["상태"], ("badge-same", rec["상태"]))
            change_note = ""
        content = _fill_device_view(row, keyword_label, badge_class, badge_text, change_note, device)
        hidden_attr = "" if active else " hidden"
        panels.append(f'<div class="creative-panel" data-creative="{i}"{hidden_attr}>{content}</div>')
    return f'{"".join(panels)}<div class="creative-switch">{"".join(buttons)}</div>'


def _render_device_view(keyword, r, device, carried=False, creative_count=0, creative_records=None):
    """brand-col 안의 PC 또는 Mobile 탭 한 쪽 내용. carried=True: 그 날짜에 새로 만들어진
    레코드가 아니라, 콘텐츠가 그대로라(동일 판정) 새 레코드 없이 이전 레코드를 그대로
    이어 보여주는 경우 — 저장된 당시 상태(예: 예전 '신규') 대신 '동일'로 표시한다
    (실측으로 혼동 발견됨). creative_count>1이면(로테이션 광고, 실측: 소프트캠프 PC)
    키워드명 옆에 "/ 소재 N개"를 붙이고, 하단 [1][2]... 버튼으로 소재별 화면을
    device-view 자리에서 바로 바꿔 볼 수 있게 한다."""
    keyword_label = f"{keyword} / 소재 {creative_count}개" if creative_count > 1 else keyword
    if r is None:
        return DEVICE_VIEW_EMPTY_TEMPLATE.format(keyword=html.escape(keyword_label))

    # 소재 전환 패널은 r이 실제 소재를 갖고 있을 때만 의미가 있다(운영중이라 소재키가
    # 있을 때). 오늘이 미운영이면(소재키 없음) 오늘자 상태를 그대로 보여준다 — 과거
    # 로테이션 이력이 있었더라도 "오늘 미운영"이라는 사실을 가리면 안 된다.
    if creative_count > 1 and creative_records and r["소재키"]:
        return _render_creative_panels(keyword, keyword_label, r, carried, creative_records, device)

    if carried:
        badge_class, badge_text = STATUS_LABEL["동일"]
    else:
        badge_class, badge_text = STATUS_LABEL.get(r["상태"], ("badge-same", r["상태"]))
    change_note = (
        f'<p class="change-note">바뀐 부분: {html.escape(r["변경내역"])}</p>'
        if not carried and r["상태"] == "변경" and r["변경내역"]
        else ""
    )
    return _fill_device_view(r, keyword_label, badge_class, badge_text, change_note, device)


def _render_brand_col(keyword, device_states):
    """device_states: {"PC": (r, carried, creative_count, creative_records), "Mobile": (...)}.
    한 브랜드의 PC/Mobile 뷰를 하나의 brand-col 안에 같이 렌더링하고, 버튼으로 전환할 수 있게 한다."""
    r, carried, creative_count, creative_records = device_states["PC"]
    pc_view = _render_device_view(keyword, r, "PC", carried, creative_count, creative_records)
    r, carried, creative_count, creative_records = device_states["Mobile"]
    mobile_view = _render_device_view(keyword, r, "Mobile", carried, creative_count, creative_records)
    return BRAND_COL_TEMPLATE.format(pc_view=pc_view, mobile_view=mobile_view)


KEYWORD_STATUS_LABEL = {
    "운영중": ("on", "운영중"),
    "미운영": ("off", "미운영"),
}


def _creative_count(conn, keyword, device="PC"):
    """이 키워드(+디바이스)에서 지금까지 관측된 서로 다른 소재(광고 크리에이티브) 개수.
    소재가 여러 개면(실측: 소프트캠프 PC) 로테이션 노출 중이라는 뜻 — 판정 로직은
    그대로 두고 "소재 N개" 배지로 표시만 해준다."""
    row = conn.execute(
        "SELECT COUNT(DISTINCT 소재키) AS n FROM records WHERE 키워드 = ? AND 디바이스 = ? AND 소재키 IS NOT NULL",
        (keyword, device),
    ).fetchone()
    return row["n"] if row else 0


def _has_earlier_date_record(conn, keyword, device, date):
    """이 키워드(+디바이스)에 주어진 날짜(YYYY-MM-DD)보다 앞선 날짜의 수집 기록이 있는지.
    "신규"인지 아닌지를 가르는 기준 — 비교할 과거 수집 세트가 있어야 "변경"을 말할 수 있다.
    같은 날 여러 번 수집해서 생긴 레코드는 과거 기록으로 치지 않는다(수집일시 < 그 날 00:00)."""
    row = conn.execute(
        "SELECT 1 FROM records WHERE 키워드 = ? AND 디바이스 = ? AND 수집일시 < ? LIMIT 1",
        (keyword, device, date),
    ).fetchone()
    return row is not None


def _known_creative_keys(conn, keyword, device="PC"):
    """이 키워드(+디바이스)에서 지금까지 관측된 소재키 집합. _resolve_status가 "이번
    소재가 처음 보는 건지"를 판단하는 데 쓴다(수집 파이프라인 전용 — 대시보드 렌더링엔
    안 쓰임, 그건 _creative_count/_creative_records가 담당)."""
    rows = conn.execute(
        "SELECT DISTINCT 소재키 FROM records WHERE 키워드 = ? AND 디바이스 = ? AND 소재키 IS NOT NULL",
        (keyword, device),
    ).fetchall()
    return {r["소재키"] for r in rows}


def _creative_records(conn, keyword, device="PC"):
    """이 키워드(+디바이스)에서 지금까지 관측된 소재(광고 크리에이티브)별 대표 레코드
    목록을 처음 관측된 순서로 반환한다(1번=가장 먼저 나온 소재). 각 소재의 내용은 그
    소재가 가장 최근에 관측됐을 때의 레코드(타이틀·카피·이미지 등 최신 상태)로 채운다."""
    rows = conn.execute(
        "SELECT * FROM records WHERE 키워드 = ? AND 디바이스 = ? AND 소재키 IS NOT NULL ORDER BY id ASC",
        (keyword, device),
    ).fetchall()
    latest_by_key = {}
    order = []
    for r in rows:
        key = r["소재키"]
        if key not in latest_by_key:
            order.append(key)
        latest_by_key[key] = r  # 계속 덮어써서 마지막(=그 소재의 가장 최근 관측)이 남는다
    return [latest_by_key[k] for k in order]


def _keyword_status_html(conn, keyword_order):
    if not keyword_order:
        return '<span class="field-empty">등록된 키워드 없음 (keywords.json)</span>'
    badges = []
    for kw in keyword_order:
        r = get_latest_record(conn, kw)
        if r is None:
            status_class, label = "pending", "대기중"
        else:
            status_class, label = KEYWORD_STATUS_LABEL.get(r["운영여부"], ("pending", r["운영여부"]))
        creative_count = _creative_count(conn, kw)
        if creative_count > 1:
            label = f"{label} · 소재 {creative_count}개"
        esc_kw = html.escape(kw)
        badges.append(
            f'<span class="kw-status kw-status-{status_class}">'
            f'<span class="dot"></span>{esc_kw} <em>{html.escape(label)}</em>'
            f'<button type="button" class="kw-delete" data-kw="{esc_kw}" title="{esc_kw} 삭제">×</button>'
            f'</span>'
        )
    return "".join(badges)


def _logs_table_html(conn):
    log_rows = conn.execute("SELECT * FROM logs ORDER BY id DESC").fetchall()
    if not log_rows:
        return '<p class="meta">아직 실행 로그가 없습니다.</p>'
    trs = []
    for lg in log_rows:
        trs.append(
            "<tr>"
            f"<td>{html.escape(lg['실행일시'])}</td>"
            f"<td>{html.escape(lg['수집방식'])}</td>"
            f"<td>{lg['대상키워드수']}</td>"
            f"<td>{lg['신규건수']}</td>"
            f"<td>{lg['변경건수']}</td>"
            f"<td>{lg['미운영전환건수']}</td>"
            f"<td>{lg['동일건수']}</td>"
            f"<td>{lg['오류수']}</td>"
            f"<td>{html.escape(lg['오류내용'] or '')}</td>"
            "</tr>"
        )
    return (
        '<table class="logs-table"><thead><tr>'
        "<th>실행일시</th><th>방식</th><th>대상</th><th>신규</th><th>변경</th>"
        "<th>미운영전환</th><th>동일</th><th>오류수</th><th>오류내용</th>"
        f"</tr></thead><tbody>{''.join(trs)}</tbody></table>"
    )


def build_dashboard(conn):
    db_rows = conn.execute(
        "SELECT * FROM records ORDER BY 수집일시 DESC, id DESC"
    ).fetchall()

    # 수집일시의 날짜 단위로 묶는다 — 하루에 수집이 일어날 때마다(신규/변경/미운영전환)
    # 한 세트. 날짜 안에서는 (키워드, 디바이스)별로 가장 최근(=그 날의 대표) 레코드 1건만 쓴다.
    by_date = {}  # date -> {(키워드, 디바이스): row}
    for r in db_rows:
        date = r["수집일시"][:10]
        by_date.setdefault(date, {}).setdefault((r["키워드"], r["디바이스"] or "PC"), r)  # 최신순 정렬돼있으니 첫 값이 그 날짜의 대표

    # 실행은 됐지만(logs에 기록 있음) 대상 전부 "동일"이라 새 레코드가 하나도 안 생긴
    # 날짜는 위 루프만으로는 세트 자체가 안 잡힌다(실측으로 발견: 9/7 09:00 자동수집이
    # 8건 모두 동일이라 대시보드에 그 날짜가 통째로 안 보임). logs의 실행일도 합쳐서
    # 날짜 세트를 만든다 — by_date에 없는 날짜는 빈 dict(전부 이어붙이기 대상)가 된다.
    log_dates = {row["실행일시"][:10] for row in conn.execute("SELECT 실행일시 FROM logs")}
    date_order = sorted(set(by_date) | log_dates, reverse=True)  # 최신 날짜가 먼저 오는 순서
    for date in date_order:
        by_date.setdefault(date, {})

    # 컬럼 수 = 현재 등록된(사용여부 Y) 브랜드 개수. keywords.json 등록 순서를 그대로 따른다.
    keyword_order = [row["브랜드명"] for row in load_keywords()]
    n_cols = max(len(keyword_order), 1)
    # 그리드 열 트랙은 브랜드 개수와 무관하게 항상 6열 고정이다 — 키워드가 6개보다
    # 적어도 brand-col 하나의 가로 너비가 "6열일 때"와 항상 같게 유지되고(실측 요청:
    # 1개만 있을 때 카드가 줄 전체로 늘어나는 문제), 6개보다 많으면 같은 6열 트랙을
    # 계속 써서 다음 줄로 넘어간다(줄이 바뀌어도 열 너비가 안 흔들린다). "N/M 브랜드
    # 갱신" 배지의 M(n_cols)은 실제 총 브랜드 수 그대로 유지 — grid_cols는 레이아웃 전용.
    grid_cols = 6
    # 브랜드 카드의 키워드명 옆에도 "/ 소재 N개"를 붙이기 위해 한 번만 미리 계산해둔다
    # (day-section마다, 심지어 carried 이어붙이기까지 매번 DB를 다시 세면 낭비라서).
    creative_counts = {
        (kw, device): _creative_count(conn, kw, device) for kw in keyword_order for device in DEVICES
    }
    # 소재가 2개 이상인 (키워드, 디바이스)만 대표 레코드 목록을 미리 조회해둔다 —
    # 카드 하단의 [1][2]... 전환 버튼용. 대부분은 소재 1개(또는 0개)라 조회를 아낀다.
    creative_records = {
        key: _creative_records(conn, key[0], key[1])
        for key, count in creative_counts.items()
        if count > 1
    }

    # 그 날짜에 직접 수집된 레코드가 없는 (브랜드, 디바이스)는(=동일 판정이라 새 레코드가
    # 안 생김) "새 기록 없음"이 아니라, 그 날짜 이전 최신 레코드를 이어서 보여준다
    # (실측으로 발견: 방금 수집이 정상 실행돼도 콘텐츠가 안 바뀌면 새 레코드가 없어
    # 빈 칸으로 보이던 문제).
    def _record_as_of(keyword, device, date):
        for r in db_rows:
            if r["키워드"] == keyword and (r["디바이스"] or "PC") == device and r["수집일시"][:10] <= date:
                return r
        return None

    sections = []
    for i, date in enumerate(date_order):
        columns = []
        for kw in keyword_order:
            device_states = {}
            for device in DEVICES:
                r = by_date[date].get((kw, device))
                carried = r is None
                if carried:
                    r = _record_as_of(kw, device, date)
                device_states[device] = (
                    r, carried, creative_counts[(kw, device)], creative_records.get((kw, device)),
                )
            columns.append(_render_brand_col(kw, device_states))
        # 최신 수집(맨 처음 나오는 날짜)만 펼친 채로 시작하고, 과거 수집은 접어 둔다.
        open_attr = " open" if i == 0 else ""
        sections.append(
            DAY_SECTION_TEMPLATE.format(
                date=date,
                n_cols=n_cols,
                grid_cols=grid_cols,
                columns="\n".join(columns),
                open_attr=open_attr,
                # 그 날짜에 실제로 새 레코드가 있던(PC/Mobile 어느 한쪽이라도) "현재 등록된"
                # 브랜드 수만 센다. by_date[date]에는 이후 keywords.json에서 삭제된 브랜드의
                # 과거 레코드도 섞여 있을 수 있어, 그대로 세면 화면에 보이는 컬럼 수와
                # 안 맞을 수 있다(실측으로 발견됨).
                updated_count=sum(
                    1 for kw in keyword_order if any((kw, device) in by_date[date] for device in DEVICES)
                ),
            )
        )

    page = PAGE_TEMPLATE.format(
        generated_at=now_iso(),
        keyword_status=_keyword_status_html(conn, keyword_order),
        sections="\n".join(sections),
        logs_table=_logs_table_html(conn),
    )
    DASHBOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    DASHBOARD_PATH.write_text(page, encoding="utf-8")


# ---------- P1-07. 자동/수동 실행 진입점 ----------

def _process_keyword(page, conn, mode, keyword, device="PC"):
    """키워드 1개(+디바이스 1개) 처리: 로드 → 텍스트 파싱 → (운영중이면) 스크린샷 캡처 →
    판정 → 저장. 반환: 판정 상태("신규"/"변경"/"동일"/"미운영전환"). 실패 시 예외를 그대로
    던진다(호출부에서 키워드×디바이스 단위로 잡아 나머지 처리를 막지 않는다)."""
    cfg = _DEVICE_CONFIG[device]
    url = cfg["url_base"] + urllib.parse.quote(keyword)
    page.goto(url, wait_until="load", timeout=20000)
    html_text = page.content()
    parsed = parse_brand_search(html_text, device=device)

    screenshot_bytes = None
    screenshot_bytes_2 = None
    if parsed["운영여부"] == "운영중":
        if device == "Mobile":
            # 모바일은 검색 직후 1차 캡처(로딩/캐러셀 초기 프레임) + 4초 뒤 2차 캡처
            # (안정된 프레임) — 두 장 다 남겨 대시보드에서 스와이프로 비교해 볼 수 있게 한다.
            screenshot_bytes = capture_brand_search_image(page, device=device)
            page.wait_for_timeout(4000)
            screenshot_bytes_2 = capture_brand_search_image(page, device=device)
            if screenshot_bytes is None and screenshot_bytes_2 is None:
                raise RuntimeError(f"브랜드검색 텍스트는 감지됐으나 스크린샷 캡처 실패({cfg['locator']} 요소 없음)")
        else:
            page.wait_for_timeout(500)  # 소재 이미지 디코딩 여유
            screenshot_bytes = capture_brand_search_image(page, device=device)
            if screenshot_bytes is None:
                raise RuntimeError(f"브랜드검색 텍스트는 감지됐으나 스크린샷 캡처 실패({cfg['locator']} 요소 없음)")

    checked_at = now_iso()
    # 콘텐츠해시는 확보된 캡처를 전부 이어붙여 계산한다 — 모바일은 두 장 중 하나만
    # 바뀌어도 "변경"으로 잡히게 하기 위함(PC는 원래대로 캡처 1장 기준과 동일하다).
    _hash_bytes = (screenshot_bytes or b"") + (screenshot_bytes_2 or b"")
    current_hash = build_hash(_hash_bytes) if _hash_bytes else None

    prev = get_latest_record(conn, keyword, device)
    status = classify(prev, {"운영여부": parsed["운영여부"], "콘텐츠해시": current_hash})

    if status == "동일":
        if prev is not None:
            touch_last_checked(conn, prev["id"], checked_at)
        return status

    # 재판정: (1) 이전 날짜 수집분이 없으면 아직 "신규", (2) 이전 날짜 수집분이 있는데
    # 이번 소재가 이미 관측된 적 있는 소재면 "동일"로 낮춘다. 둘 다 이번 관측을 저장하기
    # "전" 시점의 히스토리 기준이라 "처음 보는 날짜/소재인지"를 정확히 가른다.
    current_creative_key = _creative_key(parsed.get("이미지URL"))
    resolved_status = _resolve_status(
        status,
        current_creative_key,
        _known_creative_keys(conn, keyword, device),
        _has_earlier_date_record(conn, keyword, device, checked_at[:10]),
    )

    image_path = None
    image_path_2 = None
    if status in ("신규", "변경"):
        if screenshot_bytes:
            image_path = save_screenshot(screenshot_bytes, keyword, checked_at, device)
        if screenshot_bytes_2:
            image_path_2 = save_screenshot(screenshot_bytes_2, keyword, checked_at, device, suffix="_2")

    change_note = None
    if resolved_status == "변경":
        changed_labels = diff_fields(prev, parsed)
        # 캡처 이미지 해시는 다른데 텍스트 필드 4종이 전부 같을 수도 있다
        # (예: 상품 썸네일 이미지만 교체). 그럴 때도 "변경"임은 알 수 있게 한다.
        change_note = ", ".join(changed_labels) if changed_labels else "세부 항목은 동일 (이미지·레이아웃 차이로 추정)"

    insert_record(
        conn,
        {
            "수집일시": checked_at,
            "최종확인일시": checked_at,
            "수집방식": mode,
            "키워드": keyword,
            "운영여부": parsed["운영여부"],
            "상태": resolved_status,
            "타이틀": parsed.get("타이틀"),
            "카피": parsed.get("카피"),
            "서브링크": _dumps(parsed.get("서브링크")),
            "상품": _dumps(parsed.get("상품")),
            "하단스트립": _dumps(parsed.get("하단스트립")),
            "이미지경로": image_path,
            "이미지경로2": image_path_2,
            "원문링크": parsed.get("원문링크"),
            "콘텐츠해시": current_hash,
            "변경내역": change_note,
            "소재키": current_creative_key,
            "디바이스": device,
        },
    )
    return resolved_status


def collect(mode):
    """mode: '자동' | '수동'"""
    conn = init_db()
    keywords = load_keywords()
    run_started = now_iso()
    counts = {"신규": 0, "변경": 0, "미운영전환": 0, "동일": 0}
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        # PC/Mobile은 user_agent·is_mobile이 페이지 생성 시점에 고정돼 하나의 page로
        # 겸용할 수 없어, 디바이스별로 page를 하나씩 만들어 모든 키워드에서 재사용한다.
        pages = {
            device: browser.new_page(
                viewport=cfg["viewport"], user_agent=cfg["user_agent"], is_mobile=cfg["is_mobile"]
            )
            for device, cfg in _DEVICE_CONFIG.items()
        }
        for row in keywords:
            keyword = row["브랜드명"]
            for device in DEVICES:
                try:
                    status = _process_keyword(pages[device], conn, mode, keyword, device)
                    counts[status] += 1
                except Exception as e:  # 키워드×디바이스 1개 실패가 전체를 막지 않게
                    errors.append(f"{keyword}[{device}]: {e}")
        browser.close()

    write_log(
        conn,
        {
            "실행일시": run_started,
            "수집방식": mode,
            "대상키워드수": len(keywords),
            "신규건수": counts["신규"],
            "변경건수": counts["변경"],
            "미운영전환건수": counts["미운영전환"],
            "동일건수": counts["동일"],
            "오류수": len(errors),
            "오류내용": "; ".join(errors),
        },
    )
    build_dashboard(conn)
    conn.close()
    return {"counts": counts, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description="네이버 브랜드검색 모니터링 수집기")
    parser.add_argument(
        "--manual", action="store_true", help="수동수집 (당일 자정~실행 시점 관측용 라벨)"
    )
    args = parser.parse_args()
    mode = "수동" if args.manual else "자동"
    result = collect(mode)
    print(f"[{mode}수집 완료] {result['counts']}, 오류 {len(result['errors'])}건")
    for err in result["errors"]:
        print(f"  - {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
