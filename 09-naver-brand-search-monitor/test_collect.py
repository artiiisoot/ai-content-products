"""collect.py의 순수 로직(해시, 판정 분기, 브랜드검색 파싱)에 대한 최소 self-check.
네트워크 없이 실행: python test_collect.py
"""

import json
import shutil
import tempfile
from pathlib import Path

import re

import collect
from collect import build_hash, classify, diff_fields, parse_brand_search, _dumps, _creative_key, _resolve_status

_PC_VIEW_RE = re.compile(
    r'<div class="device-view" data-device="PC">(.*?)<div class="device-view" data-device="Mobile"', re.S
)


def _pc_views(html_text):
    """각 brand-col의 PC 탭 내용만 뽑아 합친다 — Mobile 탭은 별도 데이터라 값이 없을
    수 있고(테스트에서 Mobile 레코드를 안 만들었다면 항상 없음), PC 기준으로만 확인할
    assert에서 그걸 잘못 걸러내지 않도록 한다."""
    return "\n".join(_PC_VIEW_RE.findall(html_text))

FIXTURE = Path(__file__).parent / "fixtures" / "brand_search_sample.html"
MOBILE_FIXTURE = Path(__file__).parent / "fixtures" / "brand_search_mobile_sample.html"


def test_hash_stable():
    h1 = build_hash(b"\x89PNG-same-bytes")
    h2 = build_hash(b"\x89PNG-same-bytes")
    assert h1 == h2, "같은 캡처 이미지 바이트는 같은 해시를 만들어야 한다"


def test_hash_changes_on_diff():
    h1 = build_hash(b"\x89PNG-A")
    h2 = build_hash(b"\x89PNG-B")
    assert h1 != h2, "캡처 이미지가 다르면 해시도 달라야 한다"


def test_classify_신규_첫수집():
    assert classify(None, {"운영여부": "운영중", "콘텐츠해시": "h1"}) == "신규"


def test_classify_미운영에서_운영전환은_변경_신규아님():
    # "신규"는 수집 히스토리에 레코드가 하나도 없을 때(prev_record is None)만이다.
    # 미운영으로 있다가 다시 운영중으로 돌아온 건 과거 이력이 있으니 "변경"이어야 한다.
    prev = {"운영여부": "미운영", "콘텐츠해시": None}
    assert classify(prev, {"운영여부": "운영중", "콘텐츠해시": "h1"}) == "변경"


def test_classify_변경():
    prev = {"운영여부": "운영중", "콘텐츠해시": "h1"}
    assert classify(prev, {"운영여부": "운영중", "콘텐츠해시": "h2"}) == "변경"


def test_classify_동일():
    prev = {"운영여부": "운영중", "콘텐츠해시": "h1"}
    assert classify(prev, {"운영여부": "운영중", "콘텐츠해시": "h1"}) == "동일"


def test_classify_미운영전환_운영중에서():
    prev = {"운영여부": "운영중", "콘텐츠해시": "h1"}
    assert classify(prev, {"운영여부": "미운영", "콘텐츠해시": None}) == "미운영전환"


def test_classify_미운영전환_첫수집부터():
    assert classify(None, {"운영여부": "미운영", "콘텐츠해시": None}) == "미운영전환"


def test_classify_미운영_유지는_동일():
    prev = {"운영여부": "미운영", "콘텐츠해시": None}
    assert classify(prev, {"운영여부": "미운영", "콘텐츠해시": None}) == "동일"


def test_resolve_status_이전_날짜_기록_없으면_신규():
    # 요청: 전체 히스토리가 오늘 하루뿐이면(이전 날짜 수집 세트가 없으면) 같은 날
    # 소재가 로테이션돼서 콘텐츠가 달라져도 여전히 "신규"다 — 비교할 과거 수집분이 없다.
    assert _resolve_status("변경", "img-A", {"img-A", "img-B"}, False) == "신규"
    assert _resolve_status("변경", "img-C", {"img-A"}, False) == "신규"


def test_resolve_status_처음_보는_소재는_변경_유지():
    # 이전 날짜 기록이 있고, 이번 소재가 알려진 집합에 없으면(처음 보는 소재) "변경" 유지.
    assert _resolve_status("변경", "img-C", {"img-A", "img-B"}, True) == "변경"


def test_resolve_status_알려진_소재로_로테이션_복귀는_동일로_낮춤():
    # n개 소재 집합 기준으로 비교해서, 이미 본 적 있는 소재로 되돌아오면
    # "변경" 알림 대신 "동일"로 낮춰 상태값을 사실상 숨긴다.
    assert _resolve_status("변경", "img-A", {"img-A", "img-B"}, True) == "동일"


def test_resolve_status_신규_미운영전환_동일은_그대로():
    # 재판정은 classify()가 "변경"을 냈을 때만 개입한다 — 첫 수집(신규)이나
    # 운영 여부 전환(미운영전환), 원래 동일은 건드리면 안 된다.
    assert _resolve_status("신규", "img-A", set(), False) == "신규"
    assert _resolve_status("미운영전환", None, {"img-A"}, True) == "미운영전환"
    assert _resolve_status("동일", "img-A", {"img-A"}, True) == "동일"


def test_resolve_status_소재키_없으면_변경_유지():
    # 소재키를 못 뽑은 경우(예: 이미지URL 파싱 실패)까지 무작정 "동일"로 낮추면 안 된다.
    assert _resolve_status("변경", None, {"img-A"}, True) == "변경"


def test_has_earlier_date_record_같은날_재수집은_과거로_안_침():
    # 같은 날 여러 번 수집해서 생긴 레코드는 "과거 수집 세트"가 아니다 — 날짜가
    # 바뀌어야(어제 이전 기록이 있어야) 비교 대상이 생긴 것으로 본다.
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text("[]", encoding="utf-8")
        conn = collect.init_db()

        def _row(collected_at):
            return {
                "수집일시": collected_at, "최종확인일시": collected_at, "수집방식": "수동",
                "키워드": "소프트캠프", "운영여부": "운영중", "상태": "신규",
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "원문링크": None, "콘텐츠해시": collected_at,
                "변경내역": None, "소재키": "img-A", "디바이스": "PC",
            }

        collect.insert_record(conn, _row("2026-09-07 09:00:00"))
        collect.insert_record(conn, _row("2026-09-07 17:30:00"))  # 같은 날 재수집
        assert collect._has_earlier_date_record(conn, "소프트캠프", "PC", "2026-09-07") is False

        collect.insert_record(conn, _row("2026-09-08 09:00:00"))  # 다음 날 수집
        assert collect._has_earlier_date_record(conn, "소프트캠프", "PC", "2026-09-08") is True
        conn.close()
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_parse_brand_search_운영중():
    html_text = FIXTURE.read_text(encoding="utf-8")
    parsed = parse_brand_search(html_text)
    assert parsed["운영여부"] == "운영중"
    assert parsed["타이틀"] == "AI·데이터·보안의 체계적 실행"
    assert "성과로 이어지는" in parsed["카피"]
    assert parsed["이미지URL"].startswith("https://search.pstatic.net/")
    assert parsed["원문링크"].startswith("https://ader.naver.com/")


def test_parse_brand_search_서브링크_상품_하단스트립():
    html_text = FIXTURE.read_text(encoding="utf-8")
    parsed = parse_brand_search(html_text)
    assert parsed["서브링크"] == ["AI", "Data", "Security", "문의하기"]
    assert parsed["상품"] == ["기업형 LLM", "AI데이터 관리", "HyperDRM"]
    assert parsed["하단스트립"] == ["AI DLP", "N2SF 분류", "화면 보안", "출력물 보안", "악성메일 훈련"]


def test_parse_brand_search_브랜드_sns_소식_제외():
    html_text = FIXTURE.read_text(encoding="utf-8")
    parsed = parse_brand_search(html_text)
    assert "SNS" not in (parsed["타이틀"] or "")
    assert "KCSCON" not in (parsed["타이틀"] or "")
    assert "SNSLINK" not in (parsed["원문링크"] or "")
    assert "blogfiles.pstatic.net" not in (parsed["이미지URL"] or "")


def test_parse_brand_search_미운영():
    parsed = parse_brand_search("<html><body>브랜드검색 없음</body></html>")
    assert parsed == {"운영여부": "미운영"}


def test_parse_brand_search_mobile_운영중():
    # 실측 확인된 모바일 마크업(title/desc_wrap/premium_item)을 그대로 재현한 픽스처.
    html_text = MOBILE_FIXTURE.read_text(encoding="utf-8")
    parsed = parse_brand_search(html_text, device="Mobile")
    assert parsed["운영여부"] == "운영중"
    assert parsed["타이틀"] == "AI 보안·인증 플랫폼기업"
    assert parsed["카피"] == "라온의 기술은 / 고객의 즐거움을 향합니다."
    assert parsed["하단스트립"] == ["시큐업&해커톤", "AI 신분증"]
    assert parsed["이미지URL"].startswith("https://search.pstatic.net/")
    assert parsed["원문링크"] == "https://ader.naver.com/v1/MOBTITLE?c=mnaver.search.brand&t=0"
    # 모바일 마크업엔 서브링크(link_button_item)/상품(product_item) 섹션 자체가 없다(실측 확인됨).
    assert parsed["서브링크"] == []
    assert parsed["상품"] == []


def test_parse_brand_search_mobile_브랜드_sns_소식_제외():
    html_text = MOBILE_FIXTURE.read_text(encoding="utf-8")
    parsed = parse_brand_search(html_text, device="Mobile")
    assert "blogfiles.pstatic.net" not in (parsed["이미지URL"] or "")


def test_parse_brand_search_mobile_미운영():
    # PC 마크업(brand_search)만 있고 모바일 마크업(sc sp_brand)은 없는 경우 —
    # 실측 확인된 실제 상황(파수/소프트캠프/마크애니는 모바일 브랜드검색이 아예 없음).
    pc_only_html = FIXTURE.read_text(encoding="utf-8")
    assert parse_brand_search(pc_only_html, device="PC")["운영여부"] == "운영중"
    assert parse_brand_search(pc_only_html, device="Mobile") == {"운영여부": "미운영"}


def test_diff_fields_신규는_빈목록():
    assert diff_fields(None, {"타이틀": "A"}) == []


def test_diff_fields_타이틀만_바뀜():
    prev = {
        "타이틀": "A", "카피": "c", "서브링크": _dumps(["x"]),
        "상품": _dumps(["y"]), "하단스트립": _dumps(["z"]),
    }
    current = {"타이틀": "B", "카피": "c", "서브링크": ["x"], "상품": ["y"], "하단스트립": ["z"]}
    changed = diff_fields(prev, current)
    assert changed == ["타이틀(main_title)"]


def test_diff_fields_상품_목록_바뀜():
    prev = {
        "타이틀": "A", "카피": "c", "서브링크": _dumps(["x"]),
        "상품": _dumps(["y1", "y2"]), "하단스트립": _dumps(["z"]),
    }
    current = {"타이틀": "A", "카피": "c", "서브링크": ["x"], "상품": ["y1", "y3"], "하단스트립": ["z"]}
    changed = diff_fields(prev, current)
    assert changed == ["상품(product_item)"]


def test_diff_fields_전부_동일하면_빈목록():
    prev = {
        "타이틀": "A", "카피": "c", "서브링크": _dumps(["x"]),
        "상품": _dumps(["y"]), "하단스트립": _dumps(["z"]),
    }
    current = {"타이틀": "A", "카피": "c", "서브링크": ["x"], "상품": ["y"], "하단스트립": ["z"]}
    assert diff_fields(prev, current) == []


def test_dashboard_count_ignores_deleted_keywords():
    # 회귀 테스트: 대시보드의 "N/M 브랜드 갱신" 배지가 keywords.json에서 이미
    # 삭제된 브랜드의 과거 레코드까지 세어 부풀려지던 버그(실측으로 발견됨).
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        # 현재 등록된 키워드는 A, B 두 개뿐(삭제된 키워드 X는 keywords.json에 없음)
        collect.KEYWORDS_PATH.write_text(
            json.dumps(
                [
                    {"사용여부": "Y", "브랜드명": "A", "등록일": "2026-01-01", "비고": ""},
                    {"사용여부": "Y", "브랜드명": "B", "등록일": "2026-01-01", "비고": ""},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        conn = collect.init_db()
        checked_at = "2026-01-01 09:00:00"
        # A: 오늘 레코드 있음 / B: 없음(대기중) / X: 오늘 레코드 있지만 더 이상 등록 안 됨
        for kw in ("A", "X"):
            collect.insert_record(
                conn,
                {
                    "수집일시": checked_at, "최종확인일시": checked_at, "수집방식": "수동",
                    "키워드": kw, "운영여부": "운영중", "상태": "신규",
                    "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]",
                    "하단스트립": "[]", "이미지경로": None, "원문링크": None,
                    "콘텐츠해시": "h", "변경내역": None,
                },
            )
        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        assert "1/2 브랜드 갱신" in html_text, "현재 등록된 2개 중 A만 갱신됐어야 한다(X는 삭제된 키워드라 제외)"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_dashboard_carries_forward_unchanged_keyword():
    # 회귀 테스트: 오늘 수집이 정상 실행됐지만 콘텐츠가 안 바뀐(동일 판정) 브랜드가
    # "이 수집 세트엔 새 기록 없음"으로 잘못 표시되던 버그(실측으로 발견됨). 동일
    # 판정이면 새 레코드 없이 최종확인일시만 갱신되므로, 그 날짜 세트가 생기려면
    # (다른 키워드의 변경 등으로) 그날 레코드가 하나라도 있어야 한다 — 여기선 B를
    # 그 역할로 둔다.
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps(
                [
                    {"사용여부": "Y", "브랜드명": "라온시큐어", "등록일": "2026-01-01", "비고": ""},
                    {"사용여부": "Y", "브랜드명": "B", "등록일": "2026-01-01", "비고": ""},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        conn = collect.init_db()

        def _row(kw, collected_at, checked_at, status="신규"):
            return {
                "수집일시": collected_at, "최종확인일시": checked_at, "수집방식": "수동",
                "키워드": kw, "운영여부": "운영중", "상태": status,
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]",
                "하단스트립": "[]", "이미지경로": None, "원문링크": None,
                "콘텐츠해시": "h", "변경내역": None,
            }

        # 라온시큐어: 9/2에 최초(신규) 수집 이후 그대로. B: 9/4에 새 레코드(변경) —
        # 이 변경 덕에 9/4 세트 자체는 생긴다.
        collect.insert_record(conn, _row("라온시큐어", "2026-09-02 13:06:59", "2026-09-02 13:06:59"))
        collect.insert_record(conn, _row("B", "2026-09-04 09:31:02", "2026-09-04 09:31:02", status="변경"))
        # 9/4 수집 실행 시 라온시큐어는 동일 판정 → 새 레코드 없이 최종확인일시만 touch.
        prev = collect.get_latest_record(conn, "라온시큐어")
        collect.touch_last_checked(conn, prev["id"], "2026-09-04 09:31:04")

        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        # 9/4(최신, 맨 처음 나오는) 세트만 본다 — B가 존재하기 전인 9/2 세트에서
        # B가 "새 기록 없음"으로 나오는 건 정상이라 전체 문서 기준으로 부재를 단정하면 안 된다.
        latest_section = html_text.split('<details class="day-section"')[1]
        # PC 탭 기준으로만 본다 — 이 테스트는 Mobile 레코드를 아예 안 만들었으니
        # Mobile 탭은 항상 "새 기록 없음"이라 그건 정상이다(별개 관심사).
        latest_section_pc = _pc_views(latest_section)
        assert "이 수집 세트엔 새 기록 없음" not in latest_section_pc, "동일 판정도 이전 레코드를 이어서 보여줘야 한다"
        assert "변경사항 없음" in latest_section_pc, "이어받은 칸은 '동일' 배지로 표시돼야 한다(B는 '변경' 배지)"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_dashboard_shows_all_same_run():
    # 회귀 테스트: 실행은 됐지만(logs에 기록) 대상 전부 "동일"이라 새 레코드가 하나도
    # 안 생긴 날짜는 그 날짜 세트 자체가 대시보드에 안 보이던 버그(실측으로 발견됨:
    # 9/7 09:00 자동수집이 8건 모두 동일이었는데 대시보드에 9/7이 통째로 빠짐).
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps(
                [{"사용여부": "Y", "브랜드명": "라온시큐어", "등록일": "2026-01-01", "비고": ""}],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        conn = collect.init_db()
        collect.insert_record(
            conn,
            {
                "수집일시": "2026-09-02 13:06:59", "최종확인일시": "2026-09-02 13:06:59",
                "수집방식": "수동", "키워드": "라온시큐어", "운영여부": "운영중", "상태": "신규",
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]",
                "하단스트립": "[]", "이미지경로": None, "원문링크": None,
                "콘텐츠해시": "h", "변경내역": None,
            },
        )
        prev = collect.get_latest_record(conn, "라온시큐어")
        # 9/7 자동수집: 유일한 키워드가 동일 판정 → 새 레코드 없이 최종확인일시만 touch.
        collect.touch_last_checked(conn, prev["id"], "2026-09-07 09:00:05")
        collect.write_log(
            conn,
            {
                "실행일시": "2026-09-07 09:00:05", "수집방식": "자동", "대상키워드수": 1,
                "신규건수": 0, "변경건수": 0, "미운영전환건수": 0, "동일건수": 1,
                "오류수": 0, "오류내용": "",
            },
        )

        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        assert "2026-09-07" in html_text, "실행 기록(logs)이 있으면 새 레코드가 없어도 그 날짜 세트가 보여야 한다"
        # PC 탭 기준 — 이 테스트는 Mobile 레코드를 안 만들었으니 Mobile 탭이 항상
        # "새 기록 없음"인 건 정상이다(별개 관심사).
        assert "이 수집 세트엔 새 기록 없음" not in _pc_views(html_text), "동일 판정이면 이전 레코드를 이어서 보여줘야 한다"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_creative_key_실측_URL():
    # 실측: 원문링크(ader.naver.com)는 요청마다 바뀌지만 이미지URL 속 ditto-phinf.pstatic.net
    # 경로는 같은 소재면 동일하다 — 그 경로를 소재 키로 뽑아낸다.
    url_a = (
        "https://search.pstatic.net/common/?src=https%3A%2F%2Fditto-phinf.pstatic.net"
        "%2F20260605_291%2F1780647416917QK2jN_JPEG%2F6a2285f879c1843c0c6e5b16.jpg"
        "&type=o&size=472x472&ttype=input&autoRotate=true"
    )
    url_a_again = url_a  # 다른 요청에서도 같은 소재면 완전히 동일한 문자열로 온다
    url_b = (
        "https://search.pstatic.net/common/?src=https%3A%2F%2Fditto-phinf.pstatic.net"
        "%2F20260602_154%2F1780367979848eMwIu_PNG%2F6a1e426bf3bfa68b22812e24.png"
        "&type=o&size=472x472&ttype=input&autoRotate=true"
    )
    assert _creative_key(url_a) == _creative_key(url_a_again)
    assert _creative_key(url_a) != _creative_key(url_b)
    assert _creative_key(None) is None


def test_keyword_status_shows_creative_count_only_when_multiple():
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps(
                [
                    {"사용여부": "Y", "브랜드명": "브랜드A", "등록일": "2026-01-01", "비고": ""},
                    {"사용여부": "Y", "브랜드명": "브랜드B", "등록일": "2026-01-01", "비고": ""},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        conn = collect.init_db()

        def _row(kw, collected_at, creative_key, status="신규"):
            return {
                "수집일시": collected_at, "최종확인일시": collected_at, "수집방식": "수동",
                "키워드": kw, "운영여부": "운영중", "상태": status,
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]",
                "하단스트립": "[]", "이미지경로": None, "원문링크": None,
                "콘텐츠해시": collected_at, "변경내역": None, "소재키": creative_key,
            }

        collect.insert_record(conn, _row("브랜드A", "2026-09-02 09:00:00", "img-A"))
        collect.insert_record(conn, _row("브랜드A", "2026-09-03 09:00:00", "img-B", status="변경"))
        collect.insert_record(conn, _row("브랜드B", "2026-09-02 09:00:00", "img-C"))

        html_text = collect._keyword_status_html(conn, ["브랜드A", "브랜드B"])
        assert "소재 2개" in html_text, "소재키가 2종이면 배지에 '소재 N개'가 붙어야 한다"
        assert html_text.count("소재") == 1, "소재키가 1종뿐인 키워드엔 배지가 붙으면 안 된다"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_brand_col_renders_both_devices_with_toggle():
    # PC/Mobile을 하나의 brand-col 안에 같이 렌더링하고 버튼으로 전환하게 하는 기능의
    # 회귀 테스트. 브랜드A: PC/Mobile 둘 다 데이터 있음. 브랜드B: PC만 있음(모바일
    # 브랜드검색이 아예 없는 실제 사례 — 파수/소프트캠프/마크애니 실측과 동일한 상황).
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps(
                [
                    {"사용여부": "Y", "브랜드명": "브랜드A", "등록일": "2026-01-01", "비고": ""},
                    {"사용여부": "Y", "브랜드명": "브랜드B", "등록일": "2026-01-01", "비고": ""},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        conn = collect.init_db()

        def _row(kw, device, title):
            return {
                "수집일시": "2026-09-02 09:00:00", "최종확인일시": "2026-09-02 09:00:00",
                "수집방식": "수동", "키워드": kw, "운영여부": "운영중", "상태": "신규",
                "타이틀": title, "카피": None, "서브링크": "[]", "상품": "[]",
                "하단스트립": "[]", "이미지경로": None, "원문링크": None,
                "콘텐츠해시": f"{kw}-{device}", "변경내역": None, "디바이스": device,
            }

        collect.insert_record(conn, _row("브랜드A", "PC", "PC 타이틀"))
        collect.insert_record(conn, _row("브랜드A", "Mobile", "모바일 타이틀"))
        collect.insert_record(conn, _row("브랜드B", "PC", "B는 PC뿐"))
        # 브랜드B는 Mobile 레코드를 아예 안 만든다 — 모바일 브랜드검색이 없는 경우.

        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        assert 'data-device="PC">PC</button>' in html_text, "PC 전환 버튼이 있어야 한다"
        assert 'data-device="Mobile">Mobile</button>' in html_text, "Mobile 전환 버튼이 있어야 한다"
        assert html_text.count('<div class="device-view" data-device="Mobile"') >= 2, "브랜드마다 Mobile 탭 컨테이너가 있어야 한다"

        # 브랜드A: PC/Mobile 각 탭에 서로 다른 타이틀이 들어가 있어야 한다.
        assert "PC 타이틀" in html_text
        assert "모바일 타이틀" in html_text

        # 브랜드B: Mobile 탭엔 데이터가 없으니 그 탭만 "새 기록 없음"이어야 한다(PC 탭은 있음).
        # keyword_order(keywords.json 등록 순서)대로 브랜드A, 브랜드B 순이라 두 번째가 브랜드B.
        pc_views = _PC_VIEW_RE.findall(html_text)
        assert len(pc_views) == 2
        assert "B는 PC뿐" in pc_views[1]
        assert "이 수집 세트엔 새 기록 없음" not in pc_views[1]
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_device_view_swiper_for_two_mobile_shots():
    # 회귀 테스트: 모바일은 검색 직후 1차 + 3초 뒤 2차, 총 2장을 캡처해 이미지경로/
    # 이미지경로2에 각각 저장한다(_process_keyword). 대시보드는 두 장 다 있으면 스와이프
    # 트랙으로, 한 장뿐이면(PC는 항상 이 경우) 기존처럼 단일 <img>로 렌더링해야 한다.
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text("[]", encoding="utf-8")
        conn = collect.init_db()

        collect.insert_record(
            conn,
            {
                "수집일시": "2026-09-07 09:00:00", "최종확인일시": "2026-09-07 09:00:00",
                "수집방식": "수동", "키워드": "라온시큐어", "운영여부": "운영중", "상태": "신규",
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": "images/라온시큐어/Mobile/1.png", "이미지경로2": "images/라온시큐어/Mobile/1_2.png",
                "원문링크": None, "콘텐츠해시": "h", "변경내역": None, "디바이스": "Mobile",
            },
        )
        collect.insert_record(
            conn,
            {
                "수집일시": "2026-09-07 09:00:00", "최종확인일시": "2026-09-07 09:00:00",
                "수집방식": "수동", "키워드": "라온시큐어", "운영여부": "운영중", "상태": "신규",
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": "images/라온시큐어/PC/1.png", "이미지경로2": None,
                "원문링크": None, "콘텐츠해시": "h", "변경내역": None, "디바이스": "PC",
            },
        )

        mobile_r = collect.get_latest_record(conn, "라온시큐어", "Mobile")
        pc_r = collect.get_latest_record(conn, "라온시큐어", "PC")
        conn.close()

        mobile_html = collect._render_device_view("라온시큐어", mobile_r, "Mobile")
        assert '<div class="swiper">' in mobile_html, "2장이면 스와이프 트랙으로 렌더링돼야 한다"
        assert mobile_html.count("<img") == 2, "슬라이드 2장이 다 있어야 한다"
        assert "swiper-prev" in mobile_html and "swiper-next" in mobile_html, "좌우 화살표가 있어야 한다"
        # 2차(4초 후, 안정된 프레임)가 1순위 — 트랙의 첫 슬라이드여야 한다.
        first_img_pos = mobile_html.index("<img")
        first_img_tag = mobile_html[first_img_pos: mobile_html.index(">", first_img_pos)]
        assert "1_2.png" in first_img_tag, "2차 캡처가 첫 슬라이드로 와야 한다"

        pc_html = collect._render_device_view("라온시큐어", pc_r, "PC")
        assert '<div class="swiper">' not in pc_html, "1장뿐이면(PC) 기존처럼 단일 img여야 한다"
        assert pc_html.count("<img") == 1
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_device_view_second_shot_only():
    # 회귀 테스트: 모바일 1차 캡처만 실패하고(광고 블록 지연 렌더링) 2차만 성공하면
    # 이미지경로=NULL, 이미지경로2=경로가 된다. 이때 "이미지경로가 있을 때만" 그리면
    # 저장된 2차 캡처가 화면에서 통째로 사라졌다(검토 중 발견).
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text("[]", encoding="utf-8")
        conn = collect.init_db()
        collect.insert_record(
            conn,
            {
                "수집일시": "2026-09-07 09:00:00", "최종확인일시": "2026-09-07 09:00:00",
                "수집방식": "수동", "키워드": "라온시큐어", "운영여부": "운영중", "상태": "신규",
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "이미지경로2": "images/라온시큐어/Mobile/1_2.png",
                "원문링크": None, "콘텐츠해시": "h", "변경내역": None, "디바이스": "Mobile",
            },
        )
        r = collect.get_latest_record(conn, "라온시큐어", "Mobile")
        conn.close()

        view = collect._render_device_view("라온시큐어", r, "Mobile")
        assert "이미지 없음" not in view, "2차 캡처만 있어도 그 이미지를 보여줘야 한다"
        assert view.count("<img") == 1, "한 장뿐이니 스와이프 없이 단일 이미지여야 한다"
        assert "1_2.png" in view
        assert '<div class="swiper">' not in view
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_parse_scope_starts_at_brand_block():
    # 회귀 테스트: 파싱 범위가 문서 처음부터면, 브랜드검색 블록보다 앞에 있는(=광고와
    # 무관한) 같은 클래스명 요소를 먼저 잡아버린다. 특히 모바일의 title/desc는 흔한
    # 클래스명이라 위험하다 — 범위는 브랜드검색 블록 시작점부터여야 한다.
    mobile_block = MOBILE_FIXTURE.read_text(encoding="utf-8")
    noise = (
        '<div class="other_section">'
        '<strong class="title"><a href="https://example.com/noise">광고 아닌 제목</a></strong>'
        '<div class="desc_wrap"><p class="desc">광고 아닌 설명</p></div>'
        '<span class="item_text">광고 아닌 항목</span>'
        "</div>"
    )
    parsed = parse_brand_search(noise + mobile_block, device="Mobile")
    assert parsed["타이틀"] == "AI 보안·인증 플랫폼기업", "블록 앞쪽 노이즈를 잡으면 안 된다"
    assert "광고 아닌" not in (parsed["카피"] or "")
    assert "광고 아닌 항목" not in parsed["하단스트립"]


def test_creative_records_ordered_by_first_seen_with_latest_content():
    # _creative_records: 번호는 처음 관측된 순서(1번=가장 오래된 소재), 각 번호의 내용은
    # 그 소재가 가장 최근 관측됐을 때의 것(타이틀 등)이어야 한다.
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text("[]", encoding="utf-8")
        conn = collect.init_db()

        def _row(collected_at, key, title, status="변경"):
            return {
                "수집일시": collected_at, "최종확인일시": collected_at, "수집방식": "수동",
                "키워드": "소프트캠프", "운영여부": "운영중", "상태": status,
                "타이틀": title, "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "원문링크": None, "콘텐츠해시": title, "변경내역": None,
                "소재키": key, "디바이스": "PC",
            }

        # 관측 순서: A(계정관리) → B(RBI) → A(계정관리, 타이틀 살짝 바뀜, 같은 소재키) → B(RBI)
        collect.insert_record(conn, _row("2026-09-02 09:00:00", "img-A", "계정관리", status="신규"))
        collect.insert_record(conn, _row("2026-09-03 09:00:00", "img-B", "RBI"))
        collect.insert_record(conn, _row("2026-09-04 09:00:00", "img-A", "계정관리(최신)"))
        collect.insert_record(conn, _row("2026-09-05 09:00:00", "img-B", "RBI(최신)"))

        records = collect._creative_records(conn, "소프트캠프", "PC")
        conn.close()

        assert len(records) == 2, "소재는 2종(img-A, img-B)이어야 한다"
        assert records[0]["소재키"] == "img-A", "1번은 먼저 관측된 소재여야 한다"
        assert records[0]["타이틀"] == "계정관리(최신)", "1번의 내용은 그 소재의 가장 최근 관측이어야 한다"
        assert records[1]["소재키"] == "img-B"
        assert records[1]["타이틀"] == "RBI(최신)"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_creative_switch_buttons_and_panels():
    # brand-col 하단에 소재 전환 버튼([1][2])이 있고, 각 번호를 누르면 그 소재의
    # 화면(타이틀 등)이 보여야 한다. 소재가 1개뿐인 키워드엔 버튼이 없어야 한다.
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps(
                [
                    {"사용여부": "Y", "브랜드명": "소프트캠프", "등록일": "2026-01-01", "비고": ""},
                    {"사용여부": "Y", "브랜드명": "라온시큐어", "등록일": "2026-01-01", "비고": ""},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        conn = collect.init_db()

        def _row(kw, collected_at, key, title, status="변경"):
            return {
                "수집일시": collected_at, "최종확인일시": collected_at, "수집방식": "수동",
                "키워드": kw, "운영여부": "운영중", "상태": status,
                "타이틀": title, "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "원문링크": None, "콘텐츠해시": title, "변경내역": None,
                "소재키": key, "디바이스": "PC",
            }

        collect.insert_record(conn, _row("소프트캠프", "2026-09-02 09:00:00", "img-A", "계정관리", status="신규"))
        collect.insert_record(conn, _row("소프트캠프", "2026-09-03 09:00:00", "img-B", "RBI"))
        collect.insert_record(conn, _row("라온시큐어", "2026-09-02 09:00:00", "img-C", "안정소재", status="신규"))

        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        # 날짜 세트가 2개(9/2, 9/3)라 최신(9/3, 맨 처음 나오는) 세트만 본다 —
        # keyword_order(keywords.json 등록 순서)대로 소프트캠프, 라온시큐어 순.
        latest_section = html_text.split('<details class="day-section"')[1]
        pc_views = _PC_VIEW_RE.findall(latest_section)
        assert len(pc_views) == 2
        soft_view, raon_view = pc_views

        assert '<div class="creative-switch">' in soft_view, "소재 2개인 소프트캠프엔 전환 버튼이 있어야 한다"
        assert 'data-creative="1"' in soft_view and 'data-creative="2"' in soft_view
        assert "계정관리" in soft_view and "RBI" in soft_view, "각 소재 패널의 내용이 다 있어야 한다"

        # 회귀 확인: "오늘자 콘텐츠"가 항상 보이고 그 아래 패널이 추가로 붙는 게
        # 아니라, 소재별 패널 중 하나만(오늘 실제 관측된 소재 = RBI/img-B) 보여야 한다.
        panels = re.findall(r'<div class="creative-panel" data-creative="(\d)"( hidden)?>', soft_view)
        assert len(panels) == 2, "패널은 정확히 2개(소재 개수만큼)여야 한다"
        visible = [n for n, hidden in panels if not hidden]
        assert visible == ["2"], "오늘 실제 소재(RBI, 처음 관측 순서상 2번)만 보여야 한다"

        assert '<div class="creative-switch">' not in raon_view, "소재 1개뿐인 라온시큐어엔 전환 버튼이 없어야 한다"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_creative_panels_skipped_when_today_is_off():
    # 엣지 케이스: 과거엔 소재를 2개 로테이션했지만 오늘은 미운영(소재키 없음)이면,
    # 소재 패널로 바꾸지 말고 "오늘 미운영"이라는 사실을 그대로 보여줘야 한다
    # (과거 로테이션 이력 때문에 오늘의 실제 상태가 가려지면 안 된다).
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps([{"사용여부": "Y", "브랜드명": "소프트캠프", "등록일": "2026-01-01", "비고": ""}], ensure_ascii=False),
            encoding="utf-8",
        )
        conn = collect.init_db()

        def _row(collected_at, key, title, status, 운영여부="운영중"):
            return {
                "수집일시": collected_at, "최종확인일시": collected_at, "수집방식": "수동",
                "키워드": "소프트캠프", "운영여부": 운영여부, "상태": status,
                "타이틀": title, "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "원문링크": None, "콘텐츠해시": title, "변경내역": None,
                "소재키": key, "디바이스": "PC",
            }

        collect.insert_record(conn, _row("2026-09-02 09:00:00", "img-A", "계정관리", "신규"))
        collect.insert_record(conn, _row("2026-09-03 09:00:00", "img-B", "RBI", "변경"))
        # 오늘(9/4)은 미운영으로 전환 — 소재키 없음.
        collect.insert_record(conn, _row("2026-09-04 09:00:00", None, None, "미운영전환", 운영여부="미운영"))

        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        latest_section = html_text.split('<details class="day-section"')[1]
        pc_view = _PC_VIEW_RE.findall(latest_section)[0]

        assert '<div class="creative-switch">' not in pc_view, "오늘 미운영이면 소재 전환 버튼 대신 오늘자 상태를 그대로 보여줘야 한다"
        assert "미운영" in pc_view
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_grid_cols_fixed_at_six_even_with_one_keyword():
    # 회귀 테스트: 키워드가 6개보다 적어도(극단적으로 1개여도) brand-col의 가로 너비가
    # "6열일 때"와 항상 같아야 한다 — 그리드 열 트랙 자체를 항상 6으로 고정한다
    # (요청 전: min(n_cols, 6)이라 키워드 1개면 카드가 줄 전체로 늘어나던 문제).
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps([{"사용여부": "Y", "브랜드명": "라온시큐어", "등록일": "2026-01-01", "비고": ""}], ensure_ascii=False),
            encoding="utf-8",
        )
        conn = collect.init_db()
        collect.insert_record(
            conn,
            {
                "수집일시": "2026-09-07 09:00:00", "최종확인일시": "2026-09-07 09:00:00",
                "수집방식": "수동", "키워드": "라온시큐어", "운영여부": "운영중", "상태": "신규",
                "타이틀": "t", "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "원문링크": None, "콘텐츠해시": "h", "변경내역": None, "디바이스": "PC",
            },
        )
        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        assert "grid-template-columns: repeat(6, 1fr);" in html_text, "키워드 1개여도 6열 트랙을 그대로 써야 한다"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_row_badge_before_keyword_and_fields_collapsed_by_default():
    # 요청: row 안에서 badge가 keyword보다 먼저 오고(순서 교체), field 요소들은
    # 기본적으로 접혀 있어야(hidden) 한다 — row(배지+키워드)만 기본 노출.
    tmp_dir = Path(tempfile.mkdtemp())
    orig = (collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH)
    collect.DB_PATH = tmp_dir / "data.db"
    collect.KEYWORDS_PATH = tmp_dir / "keywords.json"
    collect.IMAGES_DIR = tmp_dir / "images"
    collect.DASHBOARD_PATH = tmp_dir / "dashboard" / "index.html"
    try:
        collect.KEYWORDS_PATH.write_text(
            json.dumps([{"사용여부": "Y", "브랜드명": "라온시큐어", "등록일": "2026-01-01", "비고": ""}], ensure_ascii=False),
            encoding="utf-8",
        )
        conn = collect.init_db()
        collect.insert_record(
            conn,
            {
                "수집일시": "2026-09-07 09:00:00", "최종확인일시": "2026-09-07 09:00:00",
                "수집방식": "수동", "키워드": "라온시큐어", "운영여부": "운영중", "상태": "신규",
                "타이틀": "타이틀본문", "카피": None, "서브링크": "[]", "상품": "[]", "하단스트립": "[]",
                "이미지경로": None, "원문링크": None, "콘텐츠해시": "h", "변경내역": None, "디바이스": "PC",
            },
        )
        collect.build_dashboard(conn)
        conn.close()

        html_text = collect.DASHBOARD_PATH.read_text(encoding="utf-8")
        row_html = html_text[html_text.index('<div class="row">'): html_text.index("</div>", html_text.index('<div class="row">')) + 6]
        assert row_html.index('class="badge') < row_html.index('class="keyword'), "row 안에서 badge가 keyword보다 먼저 와야 한다"

        fields_pos = html_text.index('<div class="fields"')
        assert "hidden" in html_text[fields_pos: fields_pos + 40], "field들은 기본으로 접혀(hidden) 있어야 한다"
        assert "타이틀본문" in html_text, "접혀 있어도 내용 자체는 그대로 렌더링돼야 한다(펼치면 보임)"
    finally:
        collect.DB_PATH, collect.KEYWORDS_PATH, collect.IMAGES_DIR, collect.DASHBOARD_PATH = orig
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"OK  {t.__name__}")
    print(f"\n{len(tests)}개 통과")
