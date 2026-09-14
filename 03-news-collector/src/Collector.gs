// P1-03. 기업 뉴스룸 수집기, P1-04. 네이버 뉴스 검색 수집기
// [정책] 수집 대상은 "금일(Asia/Seoul) 발행된 뉴스/보도기사"로 한정한다.

var TZ = "Asia/Seoul";
var NAVER_MAX = 15;            // 네이버 검색 결과에서 검토할 후보 최대 건수
var DETAIL_FETCH_LIMIT = 10;   // 키워드당 기사 페이지를 직접 열어 발행일을 확인하는 최대 건수 (실행시간 보호용)
var MIN_KEYWORD_MENTIONS = 2;  // 본문에서 키워드가 이 횟수 미만으로만 등장하면(단순 언급) 수집 대상에서 제외

// [정책] 수집 시작 시각은 실행 방식에 따라 고정된 규칙으로 정한다(이전 실행 시각을 기억할 필요 없음).
//   - 자동(스케줄) 실행: "정확히 24시간 전 ~ 지금" (예: 9/2 09:00 실행 → 9/1 09:00~9/2 09:00)
//   - 수동(버튼) 실행: "오늘 00:00(자정) ~ 버튼 클릭 시각"
var COLLECTION_WINDOW_START_MS_ = null;

// 이번 실행에서 쓸 수집 시작 시각을 모드에 따라 확정한다.
// runCollection_()/runNowForTrack_() 맨 앞에서 실행 1회당 한 번만 호출해야 한다(키워드마다 호출하면 창이 계속 좁아짐).
function prepareCollectionWindow_(runAt, mode) {
  COLLECTION_WINDOW_START_MS_ = mode === 'manual' ? localMidnight_(runAt) : (runAt.getTime() - 24 * 60 * 60 * 1000);
  return COLLECTION_WINDOW_START_MS_;
}

// runAt이 속한 날짜의 00:00(Asia/Seoul) 시각(ms).
function localMidnight_(runAt) {
  var p = Utilities.formatDate(runAt, TZ, 'yyyy-MM-dd').split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
}

// 현재 실행의 수집 시작 시각(ms). prepareCollectionWindow_ 없이 호출된 경우(예: 단발 테스트)를 대비해
// 안전하게 24시간 전으로 기본값을 둔다.
function getCollectionWindowStart_() {
  if (COLLECTION_WINDOW_START_MS_ != null) return COLLECTION_WINDOW_START_MS_;
  return Date.now() - 24 * 60 * 60 * 1000;
}

// ---------- 공통 유틸 ----------
var FETCH_HEADERS_ = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
function fetchHtml_(url) { try { var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: FETCH_HEADERS_ }); if (res.getResponseCode() !== 200) return ''; return res.getContentText(); } catch (e) { return ''; } }

// 여러 URL을 UrlFetchApp.fetchAll로 동시에 가져온다(순차 fetch보다 훨씬 빠름 — 키워드가 많을 때 타임아웃 방지용).
// 응답 순서는 urls 순서와 같다. 실패한 URL은 빈 문자열로 채운다.
function fetchHtmlBatch_(urls) {
  if (urls.length === 0) return [];
  var requests = urls.map(function (url) {
    return { url: url, muteHttpExceptions: true, followRedirects: true, headers: FETCH_HEADERS_ };
  });
  try {
    return UrlFetchApp.fetchAll(requests).map(function (res) {
      try { return res.getResponseCode() === 200 ? res.getContentText() : ''; } catch (e) { return ''; }
    });
  } catch (e) {
    return urls.map(function () { return ''; });
  }
}

function resolveUrl_(baseUrl, link) { if (!link) return ''; if (/^https?:\/\//i.test(link)) return link; var m = String(baseUrl).match(/^(https?:\/\/[^\/]+)/i); var origin = m ? m[1] : ''; return link.charAt(0) === '/' ? origin + link : origin + '/' + link; }

function decodeHtmlEntities_(text) { return String(text || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

function todayStr_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function shiftDate_(ymd, days) {
  var p = String(ymd).split("-");
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
}

// ISO/타임스탬프 문자열을 한국시간 기준 yyyy-MM-dd 로 변환
function isoToKstDate_(raw) {
  var s = String(raw || "").trim();
  if (!s) return "";
  var d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
}

// ---------- 뉴스/보도기사 판별 ----------
// 목록 페이지의 메뉴·카테고리·유틸 링크를 걸러내기 위한 텍스트 패턴
var NON_ARTICLE_TEXT_RE = /(로그인|회원가입|더보기|전체보기|목록|이전|다음|검색|메뉴|채용|인재|투자정보|오시는\s?길|개인정보|이용약관|사이트맵|고객지원|문의하기|다운로드|바로가기|공지사항|이벤트|뉴스레터|구독|home|menu|login|sign\s?in|search|more|list|prev|next|top)/i;

// 기사 상세 페이지로 보이는 링크만 통과
function looksLikeArticleLink_(link) {
  var s = String(link || "").trim();
  if (!s) return false;
  if (/^(#|javascript:|mailto:|tel:)/i.test(s)) return false;
  if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|hwp|docx?|xlsx?|pptx?)($|[?#])/i.test(s)) return false;

  var path = s.replace(/^https?:\/\/[^\/]+/i, "").split("#")[0];
  var qi = path.indexOf("?");
  var query = qi >= 0 ? path.slice(qi) : "";
  var segs = path.split("?")[0].split("/").filter(function (x) { return x; });
  if (segs.length === 0 && !query) return false;

  if (/[?&][A-Za-z_]*(idx|no|seq|id|sn|num)\d*=\d{2,}/i.test(query)) return true;
  if (/^\d{3,}$/.test(segs[segs.length - 1] || "")) return true;

  var ART = /^(view|read|detail|article|articles|news|newsroom|press|press-release|board|post|posts|story|content|contents)$/i;
  for (var i = 0; i < segs.length - 1; i++) {
    if (ART.test(segs[i])) return true;
  }

  var last = segs[segs.length - 1] || "";
  if ((last.match(/-/g) || []).length >= 2) return true;

  return false;
}

// 기사 페이지의 발행일 메타데이터와 본문 내 키워드 언급 횟수를 함께 읽는다.
function fetchArticleMeta_(link, keyword) {
  return parseArticleMeta_(fetchHtml_(link), keyword);
}

// fetchArticleMeta_에서 fetch 부분만 떼어낸 순수 파싱 함수 — 이미 받아온 html을 넘기면 된다.
// keepTodayOnly_가 fetchHtmlBatch_로 여러 페이지를 한번에 받아온 뒤 이 함수로 각각 파싱한다.
function parseArticleMeta_(html, keyword) {
  if (!html) return { date: "", ts: null, desc: "", mentions: 0 };
  var head = html.substring(0, 40000);

  var descMatch = head.match(/<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:description["']/i)
    || head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  var desc = descMatch ? decodeHtmlEntities_(descMatch[1]).trim() : "";

  // 본문에 키워드가 몇 번 등장하는지 확인 (제목의 "주인공"이 아니어도, 본문에서 여러 번 다뤄지면 수집 대상)
  var mentions = 0;
  if (keyword) {
    var kw = String(keyword).trim();
    if (kw) {
      var bodyText = decodeHtmlEntities_(
        html.substring(0, 200000)
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
      );
      var idx = 0;
      while (true) {
        idx = bodyText.indexOf(kw, idx);
        if (idx === -1) break;
        mentions++;
        idx += kw.length;
      }
    }
  }

  var metaPatterns = [
    /<meta[^>]+(?:property|name)=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']article:published_time["']/i,
    /<meta[^>]+(?:name|property)=["'](?:date|pubdate|publishdate|publish_date|sailthru\.date|dc\.date|dable:published_time)["'][^>]+content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["']/i
  ];
  for (var i = 0; i < metaPatterns.length; i++) {
    var m = head.match(metaPatterns[i]);
    if (m && m[1]) {
      var d = isoToKstDate_(m[1]) || normalizeDate_(m[1]);
      if (d) {
        var parsed = new Date(m[1]);
        var ts = isNaN(parsed.getTime()) ? null : parsed.getTime();
        return { date: d, ts: ts, desc: desc, mentions: mentions };
      }
    }
  }

  var labeled = html.match(/(?:기사입력|입력|등록일?|발행일?|송고|작성일?)[^0-9]{0,12}(20\d{2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
  if (labeled) {
    var date = labeled[1] + "-" + pad2_(labeled[2]) + "-" + pad2_(labeled[3]);
    var ts2 = new Date(Number(labeled[1]), Number(labeled[2]) - 1, Number(labeled[3])).getTime();
    return { date: date, ts: ts2, desc: desc, mentions: mentions };
  }

  return { date: "", ts: null, desc: desc, mentions: mentions };
}

// 금일 발행분만 남긴다. 그 중 어떤 기사를 "이 키워드 관련"으로 볼지는 트랙마다 다르다:
//   - 경쟁사: 제목에 키워드가 그대로 들어간 기사만 (본문에 스쳐 지나가듯 언급된 기사 제외)
//   - 그 외: 본문에서 키워드가 MIN_KEYWORD_MENTIONS회 이상 등장하는 기사 (제목의 "주인공"이 아니어도 수집)
// [성능] 상세 페이지를 하나씩 순차로 열면 키워드 수가 많을 때(예: 경쟁사 39개) Apps Script 트리거의
// 6분 실행 제한을 넘기기 쉽다. fetchHtmlBatch_로 최대 DETAIL_FETCH_LIMIT개를 한 번에 병렬로 가져와
// 총 대기시간을 "가장 느린 응답 1개" 수준으로 줄인다(순차 합산이 아님).
function keepTodayOnly_(articles, keyword, track) {
  var today = todayStr_();
  var yesterday = shiftDate_(today, -1);
  var windowStart = getCollectionWindowStart_();
  var seen = {};
  var candidates = [];
  for (var i = 0; i < articles.length; i++) {
    var a = articles[i];
    if (!a || !a.link || seen[a.link]) continue;
    seen[a.link] = true;

    var listed = normalizeDate_(a.publishedAt);
    if (listed && listed !== today && listed !== yesterday) continue;

    if (candidates.length >= DETAIL_FETCH_LIMIT) continue;
    candidates.push(a);
  }
  if (candidates.length === 0) return [];

  var htmls = fetchHtmlBatch_(candidates.map(function (a) { return a.link; }));
  var result = [];
  candidates.forEach(function (a, i) {
    var meta = parseArticleMeta_(htmls[i], keyword);
    // "오늘 날짜"가 아니라 수집 창(자동: 24시간 전, 수동: 당일 자정) 시작 시각 이후 발행인지로 판정한다.
    if (!meta.ts || meta.ts < windowStart) return;
    if (track === '경쟁사') {
      if (String(a.title || '').indexOf(keyword) === -1) return;
    } else if (meta.mentions < MIN_KEYWORD_MENTIONS) {
      return;
    }

    a.publishedAt = meta.date;
    a.sortTs = meta.ts;
    a.desc = meta.desc;
    result.push(a);
  });
  return result;
}

// ---------- 기업 뉴스룸 ----------
function parseNewsroomList_(html) {
  if (!html) return [];
  var articles = [];
  var re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var link = decodeHtmlEntities_(m[1]);
    if (!looksLikeArticleLink_(link)) continue;
    var text = decodeHtmlEntities_(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (text.length < 10) continue;
    if (NON_ARTICLE_TEXT_RE.test(text)) continue;

    var context = html.substr(Math.max(0, m.index - 150), 500);
    var dm = context.match(/(20\d{2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);

    var title = text.replace(/\s*(20\d{2})[.\-\/]\s*\d{1,2}[.\-\/]\s*\d{1,2}\.?\s*$/, "").trim();
    if (title.length < 6) title = text;

    articles.push({
      title: title,
      link: link,
      publishedAt: dm ? (dm[1] + "-" + pad2_(dm[2]) + "-" + pad2_(dm[3])) : "",
      source: ""
    });
  }
  return articles;
}

function collectFromNewsroom_(keywordRow, track) {
  var html = fetchHtml_(keywordRow.newsroomUrl);
  if (!html) return [];
  var list = parseNewsroomList_(html).map(function (a) {
    return {
      title: a.title,
      link: resolveUrl_(keywordRow.newsroomUrl, a.link),
      publishedAt: a.publishedAt,
      source: a.source || "기업 뉴스룸"
    };
  });
  return keepTodayOnly_(list, keywordRow.keyword, track);
}

// ---------- 네이버 뉴스 검색 ----------
var PRESS_BY_DOMAIN = {
  'biz.chosun.com': '조선비즈', 'chosun.com': '조선일보', 'dealsite.co.kr': '딜사이트',
  'newspim.com': '뉴스핌', 'news1.kr': '뉴스1', 'newsis.com': '뉴시스',
  'zdnet.co.kr': '지디넷코리아', 'newsworks.co.kr': '뉴스웍스', 'fnnews.com': '파이낸셜뉴스',
  'mt.co.kr': '머니투데이', 'etnews.com': '전자신문', 'edaily.co.kr': '이데일리',
  'sedaily.com': '서울경제', 'boannews.com': '보안뉴스', 'bloter.net': '블로터',
  'dailysecu.com': '데일리시큐', 'yna.co.kr': '연합뉴스', 'mk.co.kr': '매일경제',
  'hankyung.com': '한국경제', 'dt.co.kr': '디지털타임스', 'ddaily.co.kr': '디지털데일리'
};

function pressFromLink_(link) {
  var m = String(link).match(/^https?:\/\/([^\/]+)/);
  if (!m) return '';
  var host = m[1].replace(/^www\./, '');
  return PRESS_BY_DOMAIN[host] || host;
}

// 네이버 검색 결과에서 언론사명 노출 위치를 수집
function collectPressSpans_(html) {
  var list = [];
  var re = /<span[^>]+class=["'][^"']*sds-comps-profile-info-title-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var name = decodeHtmlEntities_(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (name) list.push({ idx: m.index, value: name });
  }
  return list;
}

// 해당 위치 "앞쪽"에서 가장 가까운 값 선택.
// 네이버 검색 결과는 [언론사명 -> 기사 제목] 순서라, 제목 앵커 바로 앞의 언론사명이 그 기사의 것이다.
// (앞뒤 구분 없이 최단거리로 고르면 다음 기사의 언론사명을 가져와 한 칸씩 밀린다)
function precedingValue_(items, pos) {
  var best = "";
  var bestIdx = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].idx < pos && items[i].idx > bestIdx) { bestIdx = items[i].idx; best = items[i].value; }
  }
  return best;
}

function parseNaverNewsList_(html) {
  if (!html) return [];
  var dates = [];
  var mm;
  var relRe = /(\d+)\s?(일|시간|분)\s?전/g;
  while ((mm = relRe.exec(html)) !== null) {
    dates.push({ idx: mm.index, value: relativeToDate_(Number(mm[1]), mm[2]) });
  }
  var absRe = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./g;
  while ((mm = absRe.exec(html)) !== null) {
    dates.push({ idx: mm.index, value: mm[1] + '-' + pad2_(mm[2]) + '-' + pad2_(mm[3]) });
  }
  var presses = collectPressSpans_(html);
  var articles = [];
  var re = /<a[^>]*href="([^"]+)"[^>]*data-heatmap-target="\.tit"[^>]*>(?:<span[^>]*sds-comps-text-type-(?:headline1|body2)[^>]*>)([\s\S]*?)<\/span>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var link = decodeHtmlEntities_(m[1]);
    if (link.indexOf('search.naver.com') !== -1 || link.charAt(0) === '?') continue;
    var title = decodeHtmlEntities_(m[2].replace(/<[^>]+>/g, ''));
    var anchorEnd = re.lastIndex;
    var best = '', bestDist = Infinity;
    for (var i = 0; i < dates.length; i++) {
      var dist = Math.abs(dates[i].idx - anchorEnd);
      if (dist < bestDist) { bestDist = dist; best = dates[i].value; }
    }
    articles.push({ title: title, link: link, source: (precedingValue_(presses, m.index) || pressFromLink_(link)), publishedAt: best });
  }
  return articles;
}

// 오늘 날짜로 기간을 고정하고 최신순으로 검색
function naverSearchUrl_(keyword) {
  // "오늘 날짜"만 검색하면 전날 발행되어 수집되어야 할 기사가 네이버 검색 결과 자체에서 걸러진다.
  // Collector.gs의 수집 창(자동: 24시간 전, 수동: 당일 자정) 시작일 ~ 오늘로 검색 기간을 넓힌다.
  var windowStartMs = getCollectionWindowStart_();
  var windowStartDate = new Date(windowStartMs);
  var dot = Utilities.formatDate(new Date(), TZ, "yyyy.MM.dd");
  var dsDot = Utilities.formatDate(windowStartDate, TZ, "yyyy.MM.dd");
  var num = Utilities.formatDate(new Date(), TZ, "yyyyMMdd");
  var dsNum = Utilities.formatDate(windowStartDate, TZ, "yyyyMMdd");
  var nso = "so:dd,p:from" + dsNum + "to" + num + ",a:all";
  return "https://search.naver.com/search.naver"
    + "?where=news&sm=tab_opt&query=" + encodeURIComponent(keyword)
    + "&sort=1&photo=0&field=0&pd=3"
    + "&ds=" + dsDot + "&de=" + dot
    + "&nso=" + encodeURIComponent(nso);
}

function collectFromNaver_(keyword, track) {
  var html = fetchHtml_(naverSearchUrl_(keyword));
  var list = parseNaverNewsList_(html).slice(0, NAVER_MAX).map(function (a) {
    // 목록에 표시된 날짜는 위치 추정이라 신뢰하지 않는다. 판정은 기사 페이지에서만.
    a.publishedAt = "";
    return a;
  });
  return keepTodayOnly_(list, keyword, track);
}

/**
 * 과거 날짜 백필 전용: 검색 기간을 하루(dateStr, yyyy-MM-dd)로 좁혀서 네이버를 검색한다.
 * 평소처럼 "수집 창 시작~오늘"로 넓게 검색하면 최근 며칠치 기사만으로 후보 목록(NAVER_MAX)이 차버려
 * 지난주처럼 더 과거인 날짜의 기사는 결과에 아예 안 나온다. 하루씩 나눠 검색해 이를 피한다.
 */
function naverSearchUrlForDate_(keyword, dateStr) {
  // ds=de(같은 날)로 주면 네이버 쪽에서 범위가 0으로 취급돼 결과가 비는 경우가 있어,
  // de를 다음날로 잡아 [00:00, 다음날 00:00) 하루 범위를 확보한다.
  var p = String(dateStr).split('-');
  var start = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  var dsDot = Utilities.formatDate(start, TZ, "yyyy.MM.dd");
  var deDot = Utilities.formatDate(end, TZ, "yyyy.MM.dd");
  var dsNum = Utilities.formatDate(start, TZ, "yyyyMMdd");
  var deNum = Utilities.formatDate(end, TZ, "yyyyMMdd");
  var nso = "so:dd,p:from" + dsNum + "to" + deNum + ",a:all";
  return "https://search.naver.com/search.naver"
    + "?where=news&sm=tab_opt&query=" + encodeURIComponent(keyword)
    + "&sort=1&photo=0&field=0&pd=3"
    + "&ds=" + dsDot + "&de=" + deDot
    + "&nso=" + encodeURIComponent(nso);
}

function collectFromNaverForDate_(keyword, dateStr, track) {
  var html = fetchHtml_(naverSearchUrlForDate_(keyword, dateStr));
  var list = parseNaverNewsList_(html).slice(0, NAVER_MAX).map(function (a) {
    a.publishedAt = "";
    return a;
  });
  return keepTodayOnly_(list, keyword, track);
}
