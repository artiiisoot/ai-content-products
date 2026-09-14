/**
 * P2. 데이터 브릿지 Web App
 * AI 추론(일일요약/주간후보)은 사내망에서만 도달 가능한 LiteLLM 게이트웨이가 필요하나
 * Apps Script(구글 서버)에서는 게이트웨이에 도달할 수 없다. 따라서 추론은 사내망 로컬 러너가 담당하고,
 * 이 Web App은 로컬 러너가 시트를 읽고 쓰기 위한 데이터 창구 역할만 한다.
 *
 * 인증: 스크립트 속성 WEBAPP_TOKEN 과 요청의 token 파라미터가 일치해야 한다.
 * 배포: 게시 > 웹 앱으로 배포 (실행: 나, 액세스 권한: 모든 사용자). URL을 로컬 러너에 등록한다.
 */

/** 토큰 검증. 스크립트 속성 WEBAPP_TOKEN 과 요청 token 파라미터가 일치해야 통과. */
function checkToken_(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN');
  return !!expected && !!e && !!e.parameter && e.parameter.token === expected;
}

/** JSON 응답 헬퍼. */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 데이터 읽기 창구.
 *   ?token=..&action=todayNews        → { keyword: [{title,source,publishedAt}, ...], ... }
 *   ?token=..&action=recentSummaries&days=7 → [{keyword,count,summary}, ...]
 *   ?token=..&action=weekNews&days=7  → { keyword: [{title,source,publishedAt}, ...], ... } (일일요약이 아직 없을 때의 폴백용 원본 기사)
 *   ?token=..&action=newsByDate&date=yyyy-MM-dd → { keyword: [{title,source,publishedAt}, ...], ... } (특정 발행일 기사만, 과거 날짜 일일요약 백필용)
 *   ?token=..&action=weeklyCandidatesManualRequest → { requested, at } (수동 버튼으로 요청된 즉시 실행이 있는지 로컬 러너가 폴링)
 */
function doGet(e) {
  if (!checkToken_(e)) return jsonOut_({ error: 'unauthorized' });
  var action = e.parameter.action;

  if (action === 'todayNews') {
    return jsonOut_({ grouped: groupArticlesByKeyword_(getTodayNewsRows_(), newsRowColumns_()) });
  }

  if (action === 'recentSummaries') {
    var days = Number(e.parameter.days) || 7;
    return jsonOut_({ summaries: getRecentSummaries_(days) });
  }

  // [정책] 아직 하루치도 일일요약이 쌓이지 않은 주(설치 직후 등)에도 후보 생성이 막히지 않도록,
  // 일일요약이 비어 있으면 러너가 이 원본 기사로 폴백한다 - "일주일을 다 채워야만" 생성되지 않게 함.
  if (action === 'weekNews') {
    var newsDays = Number(e.parameter.days) || 7;
    return jsonOut_({ grouped: groupArticlesByKeyword_(getRecentNewsRows_(newsDays), newsRowColumns_()) });
  }

  if (action === 'newsByDate') {
    var date = String(e.parameter.date || '').trim();
    return jsonOut_({ grouped: groupArticlesByKeyword_(getNewsRowsByPublishedDate_(date), newsRowColumns_()) });
  }

  if (action === 'weeklyCandidatesManualRequest') {
    var requestedAt = PropertiesService.getScriptProperties().getProperty('WEEKLY_CANDIDATES_MANUAL_REQUESTED_AT');
    return jsonOut_({ requested: !!requestedAt, at: requestedAt || null });
  }

  return jsonOut_({ error: 'unknown action: ' + action });
}

/**
 * 추론 결과 기록 창구. 본문은 JSON.
 *   ?token=..&action=dailySummary[&date=yyyy-MM-dd]  body: [{keyword,summary,count,range}, ...] (range=기사 실제 발행일 범위, 러너가 계산; date는 range 없을 때만 쓰는 폴백)
 *   ?token=..&action=weeklyCandidates   body: [{title,keywords,reason,tieIn}, ...]
 *   ?token=..&action=ackWeeklyCandidatesManualRequest  수동 실행 요청을 처리했음을 확인(요청 플래그 삭제)
 */
function doPost(e) {
  if (!checkToken_(e)) return jsonOut_({ error: 'unauthorized' });
  var action = e.parameter.action;
  var body = JSON.parse((e.postData && e.postData.contents) || '[]');

  if (action === 'dailySummary') {
    return jsonOut_({ ok: true, written: writeDailySummary_(body, e.parameter.date) });
  }
  if (action === 'weeklyCandidates') {
    return jsonOut_({ ok: true, written: writeWeeklyCandidates_(body) });
  }
  if (action === 'ackWeeklyCandidatesManualRequest') {
    PropertiesService.getScriptProperties().deleteProperty('WEEKLY_CANDIDATES_MANUAL_REQUESTED_AT');
    return jsonOut_({ ok: true });
  }
  return jsonOut_({ error: 'unknown action: ' + action });
}

/** 같은 날짜인지 비교 (연/월/일 기준) */
function isSameDate_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 기사 배열을 키워드 기준으로 그룹핑 */
function groupArticlesByKeyword_(rows, c) {
  var grouped = {};
  rows.forEach(function (r) {
    var kw = r[c.keyword];
    if (!grouped[kw]) grouped[kw] = [];
    grouped[kw].push({ title: r[c.title], source: r[c.source], publishedAt: r[c.publishedAt] });
  });
  return grouped;
}

/** todayNews/weekNews가 공통으로 쓰는 뉴스수집 탭 컬럼 인덱스 매핑 */
function newsRowColumns_() {
  return {
    keyword: colIndex_(NEWS_HEADERS, '키워드') - 1,
    title: colIndex_(NEWS_HEADERS, '제목') - 1,
    source: colIndex_(NEWS_HEADERS, '언론사') - 1,
    publishedAt: colIndex_(NEWS_HEADERS, '발행일') - 1
  };
}

/** 뉴스수집 탭에서 오늘 수집된 기사만 반환 */
function getTodayNewsRows_() {
  var today = new Date();
  var collectedAtCol = colIndex_(NEWS_HEADERS, '수집일시') - 1;
  var rows = [];
  TRACKS.forEach(function (track) {
    var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
    if (sheet.getLastRow() < NEWS_DATA_START_ROW) return;
    var trackRows = sheet.getRange(NEWS_DATA_START_ROW, 1, sheet.getLastRow() - NEWS_HEADER_ROW, NEWS_HEADERS.length).getValues();
    trackRows.forEach(function (r) {
      if (r[collectedAtCol] instanceof Date && isSameDate_(r[collectedAtCol], today)) rows.push(r);
    });
  });
  return rows;
}

/** 뉴스수집 탭에서 발행일(문자열, yyyy-MM-dd)이 정확히 일치하는 기사만 반환 (과거 날짜 일일요약 백필용) */
function getNewsRowsByPublishedDate_(dateStr) {
  if (!dateStr) return [];
  var publishedAtCol = colIndex_(NEWS_HEADERS, '발행일') - 1;
  var rows = [];
  TRACKS.forEach(function (track) {
    var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
    if (sheet.getLastRow() < NEWS_DATA_START_ROW) return;
    var trackRows = sheet.getRange(NEWS_DATA_START_ROW, 1, sheet.getLastRow() - NEWS_HEADER_ROW, NEWS_HEADERS.length).getValues();
    trackRows.forEach(function (r) {
      // 시트가 "yyyy-MM-dd" 문자열을 날짜로 자동 인식해 Date 타입으로 바꿔버리는 경우가 있어 둘 다 처리한다.
      var raw = r[publishedAtCol];
      var cellDate = raw instanceof Date ? Utilities.formatDate(raw, TZ, 'yyyy-MM-dd') : String(raw).trim();
      if (cellDate === dateStr) rows.push(r);
    });
  });
  return rows;
}

/** 뉴스수집 탭에서 최근 N일 이내 수집된 기사를 반환 (주간 후보 생성의 "일일요약 없음" 폴백용) */
function getRecentNewsRows_(days) {
  var collectedAtCol = colIndex_(NEWS_HEADERS, '수집일시') - 1;
  var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  var rows = [];
  TRACKS.forEach(function (track) {
    var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
    if (sheet.getLastRow() < NEWS_DATA_START_ROW) return;
    var trackRows = sheet.getRange(NEWS_DATA_START_ROW, 1, sheet.getLastRow() - NEWS_HEADER_ROW, NEWS_HEADERS.length).getValues();
    trackRows.forEach(function (r) {
      if (r[collectedAtCol] instanceof Date && r[collectedAtCol].getTime() >= cutoff.getTime()) rows.push(r);
    });
  });
  return rows;
}

/** 일일요약 탭에서 최근 N일 이내 생성된 요약만 반환 */
function getRecentSummaries_(days) {
  var sheet = getSheet_(SHEET_NAMES.SUMMARY);
  if (sheet.getLastRow() < 2) return [];
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, SUMMARY_HEADERS.length).getValues();
  var c = {
    keyword: colIndex_(SUMMARY_HEADERS, '키워드') - 1,
    count: colIndex_(SUMMARY_HEADERS, '기사건수') - 1,
    summary: colIndex_(SUMMARY_HEADERS, 'AI요약') - 1,
    createdAt: colIndex_(SUMMARY_HEADERS, '생성일시') - 1
  };
  var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return rows
    .filter(function (r) { return r[c.createdAt] instanceof Date && r[c.createdAt].getTime() >= cutoff.getTime(); })
    .map(function (r) { return { keyword: r[c.keyword], count: r[c.count], summary: r[c.summary] }; });
}

// [정책] 수집범위는 "언제 요약을 생성했는지"가 아니라 "그 요약에 포함된 기사들의 실제 발행일"을
// 반영한다(생성 시각은 별도로 생성일시 컬럼에 이미 기록됨). 러너가 각 키워드의 기사 발행일에서
// 직접 계산한 s.range(단일 날짜 또는 "시작 ~ 끝")를 그대로 쓰고, 옛 러너 호환 등으로 range가
// 없을 때만 dateOverride(백필 날짜) 또는 오늘 날짜로 대체한다.
// [정책 2026-09-07] 수집범위 내림차순(최근일수록 위)을 유지한다 — 뉴스수집 탭의 발행일 정렬과 같은 정책.
// 범위는 "yyyy-MM-dd" 단일 날짜이거나 "yyyy-MM-dd ~ yyyy-MM-dd" 구간이라, 앞 10자(시작일)만 정렬 키로 쓴다.
// 시트가 단일 날짜 문자열을 Date 타입으로 자동 변환해버리는 경우가 있어(뉴스수집 탭과 동일 문제),
// 컬럼 서식을 텍스트('@')로 고정하고 기존 Date 값도 문자열로 정규화한다.
function summaryRangeKey_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || ''); }

/** 로컬 러너가 만든 일일요약을 일일요약 탭에 기록. 기록 건수 반환. */
function writeDailySummary_(items, dateOverride) {
  if (!items || items.length === 0) return 0;
  var now = new Date();
  var fallbackRange = String(dateOverride || '').trim() || Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd');
  var newRows = items.map(function (s) {
    return [String(s.range || '').trim() || fallbackRange, s.keyword, s.count || 0, s.summary, now];
  });
  var sheet = getSheet_(SHEET_NAMES.SUMMARY);
  var lastRow = sheet.getLastRow();
  var existingRows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, SUMMARY_HEADERS.length).getValues() : [];
  var all = existingRows.concat(newRows);
  all.forEach(function (r) { r[0] = summaryRangeKey_(r[0]); });
  all.sort(function (a, b) {
    var da = a[0].slice(0, 10), db = b[0].slice(0, 10);
    return da < db ? 1 : da > db ? -1 : 0;
  });
  sheet.getRange(2, 1, all.length, 1).setNumberFormat('@');
  sheet.getRange(2, 1, all.length, SUMMARY_HEADERS.length).setValues(all);
  // [정책 2026-09-07] 날짜 표기 통일: 생성일시도 시트 로캘 기본 표기("2026. 9. 7") 대신
  // "yyyy-MM-dd"로 고정한다. 값 자체는 Date 그대로 둬서 getRecentSummaries_의 getTime()
  // 비교(정렬/필터)는 그대로 동작한다.
  var createdAtCol = colIndex_(SUMMARY_HEADERS, '생성일시');
  sheet.getRange(2, createdAtCol, all.length, 1).setNumberFormat('yyyy-MM-dd');
  return newRows.length;
}

// [정책 2026-09-07] 주차범위는 실행 시각 기준 "지금부터 7일 전"이 아니라, 가장 최근에 끝난
// 월요일~일요일 한 주로 고정한다(예: 월요일 아침에 실행하면 지난주 월~일). 실행 요일에 상관없이
// 항상 달력상 완결된 한 주를 가리키게 하기 위해서다.
function writeWeeklyCandidates_(items) {
  if (!items || items.length === 0) return 0;
  var tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  var p = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd').split('-');
  var todayLocal = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var daysSinceMonday = (todayLocal.getDay() + 6) % 7; // 월요일=0, 일요일=6
  var thisMonday = new Date(todayLocal.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  var start = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000); // 지난주 월요일
  var end = new Date(thisMonday.getTime() - 1 * 24 * 60 * 60 * 1000); // 지난주 일요일
  // [정책 2026-09-07] 날짜 표기 통일: 주차범위도 다른 시트(발행일/수집범위/등록일)와 같은
  // "yyyy-MM-dd" 형식을 쓴다("8월 31일" 같은 한글 표기 대신).
  var weekLabel = Utilities.formatDate(start, tz, 'yyyy-MM-dd') + ' ~ ' + Utilities.formatDate(end, tz, 'yyyy-MM-dd');
  var newRows = items.map(function (c, i) {
    return [weekLabel, i + 1, c.title, c.keywords, c.reason, c.tieIn];
  });
  var sheet = getSheet_(SHEET_NAMES.CANDIDATES);
  var lastRow = sheet.getLastRow();
  var existingRows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, CANDIDATE_HEADERS.length).getValues() : [];
  var all = existingRows.concat(newRows);
  // [정책 2026-09-07] 주차범위 내림차순(최근 주가 위)을 유지한다 — 일일요약/뉴스수집 탭과 같은 정책.
  // 같은 주차 안에서는 순위(1~7) 오름차순을 그대로 지킨다.
  all.forEach(function (r) { r[0] = String(r[0] || ''); });
  all.sort(function (a, b) {
    var wa = a[0].slice(0, 10), wb = b[0].slice(0, 10);
    if (wa !== wb) return wa < wb ? 1 : -1;
    return Number(a[1]) - Number(b[1]);
  });
  sheet.getRange(2, 1, all.length, 1).setNumberFormat('@');
  sheet.getRange(2, 1, all.length, CANDIDATE_HEADERS.length).setValues(all);
  return newRows.length;
}
