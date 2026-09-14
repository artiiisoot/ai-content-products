// P1-07. 수집 결과 집계
// [정책 2026-09-08] 유사 사안으로 흡수된 기사는 새 행이 안 생겨 링크 컬럼에도 남지 않는다.
// 그대로 두면 수집 창(24시간) 안에서 매 실행마다 같은 기사가 다시 "신규"로 잡혀 계속 재흡수되고,
// 기사건수만 끝없이 부풀었다(실측: 한 행이 26건까지 누적).
// 시트 '비고' 컬럼에는 건수만 적고(일자/제목/URL은 남기지 않는다), 재흡수 판정에 필요한 링크는
// 스크립트 속성에 따로 보관한다. 수집 창을 넘긴 기록은 쓸모가 없으므로 48시간이 지나면 버린다.
var ABSORBED_LINK_PROP_PREFIX_ = 'ABSORBED_LINKS_';
var ABSORBED_LINK_TTL_MS_ = 48 * 60 * 60 * 1000;
var ABSORBED_NOTE_COLOR_ = '#d93025';
var ABSORBED_LINK_MAX_ = 300; // 속성값 9KB 상한에 걸리지 않도록 개수도 제한

function loadAbsorbedLinks_(track) {
  var raw = PropertiesService.getScriptProperties().getProperty(ABSORBED_LINK_PROP_PREFIX_ + track);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

/** link -> 기록시각(ms) 맵에서 오래된/초과분을 걷어내고 저장한다. */
function saveAbsorbedLinks_(track, map) {
  var cutoff = Date.now() - ABSORBED_LINK_TTL_MS_;
  var kept = {};
  Object.keys(map)
    .map(function (link) { return { link: link, ts: Number(map[link]) || 0 }; })
    .filter(function (e) { return e.ts >= cutoff; })
    .sort(function (a, b) { return b.ts - a.ts; })
    .slice(0, ABSORBED_LINK_MAX_)
    .forEach(function (e) { kept[e.link] = e.ts; });
  PropertiesService.getScriptProperties().setProperty(ABSORBED_LINK_PROP_PREFIX_ + track, JSON.stringify(kept));
}

function rememberAbsorbedLinks_(track, links) {
  if (!links || links.length === 0) return;
  var map = loadAbsorbedLinks_(track);
  var now = Date.now();
  links.forEach(function (link) { if (link) map[String(link).trim()] = now; });
  saveAbsorbedLinks_(track, map);
}

function findExistingLinks_(track) {
  var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
  var map = {};
  if (sheet.getLastRow() >= NEWS_DATA_START_ROW) {
    var linkCol = colIndex_(NEWS_HEADERS, '링크');
    sheet.getRange(NEWS_DATA_START_ROW, linkCol, sheet.getLastRow() - NEWS_HEADER_ROW, 1).getValues()
      .forEach(function (r) { if (r[0]) map[String(r[0]).trim()] = true; });
  }
  Object.keys(loadAbsorbedLinks_(track)).forEach(function (link) { map[link] = true; });
  return map;
}

function countArticlesByRun_(articles) {
  return articles.length;
}
// 시트가 "yyyy-MM-dd" 문자열을 자동으로 Date 타입 셀로 바꿔버리는 경우가 있어(표시 형식이 로캘에 따라
// 달라지고, 문자열로 그대로 비교하면 String(Date객체)="Tue Aug 25 2026..." 형태라 요일 알파벳순으로 뒤섞인다).
// 항상 "yyyy-MM-dd" 문자열로 정규화해서 쓰고 비교한다.
function dateKey_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || ''); }

// [정책 2026-09-07] 발행일 내림차순(최신일수록 위)을 항상 유지한다. 새 행을 맨 끝에 붙이지 않고
// 기존 행 전체와 합쳐 다시 정렬해 쓴다 — 시트가 커질수록 이 재기록 비용도 함께 커진다(키워드
// 개수/수집 빈도가 크게 늘면 findExistingLinks_/findExistingStories_와 마찬가지로 재검토 필요).
// 호출 순서 주의: applyStoryCountMerges_로 기존 행의 기사건수를 먼저 갱신한 뒤 이 함수를 불러야
// 한다 — 여기서 재정렬하면 그 전에 구한 rowIndex가 전부 어긋난다.
// [정책] 발행일 표기는 항상 "yyyy-MM-dd" — 시트가 자동으로 Date 타입으로 바꾸지 못하게 컬럼 서식을
// 일반 텍스트('@')로 고정한 뒤, 기존 Date 타입 값도 문자열로 정규화해서 다시 쓴다.
function appendArticles_(rows, track) {
  if (rows.length === 0) return 0;
  var newValues = rows.map(function (a) { return [a.collectedAt, a.keyword, a.title, a.source, a.publishedAt, a.link, a.count, a.summaryAt, '']; });
  var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
  var publishedCol = colIndex_(NEWS_HEADERS, '발행일') - 1;
  var collectedCol = colIndex_(NEWS_HEADERS, '수집일시') - 1;
  var lastRow = sheet.getLastRow();
  var existingValues = lastRow >= NEWS_DATA_START_ROW
    ? sheet.getRange(NEWS_DATA_START_ROW, 1, lastRow - NEWS_HEADER_ROW, NEWS_HEADERS.length).getValues()
    : [];
  var all = existingValues.concat(newValues);
  all.forEach(function (r) { r[publishedCol] = dateKey_(r[publishedCol]); });
  // 발행일이 같은 행끼리는 수집일시 내림차순(최근 수집분이 위)을 2차 정렬 기준으로 삼는다 —
  // 안 그러면 같은 발행일 안에서 수집일시가 뒤죽박죽으로 남는다(정렬 안정성만으론 보장 안 됨).
  all.sort(function (a, b) {
    var da = a[publishedCol], db = b[publishedCol];
    if (da !== db) return da > db ? -1 : 1;
    var ta = a[collectedCol] instanceof Date ? a[collectedCol].getTime() : 0;
    var tb = b[collectedCol] instanceof Date ? b[collectedCol].getTime() : 0;
    return tb - ta;
  });
  sheet.getRange(NEWS_DATA_START_ROW, publishedCol + 1, all.length, 1).setNumberFormat('@');
  // [정책 2026-09-07] 날짜 표기 통일: 수집일시·요약생성일시도 시트 로캘 기본 표기("2026. 9. 7")
  // 대신 "yyyy-MM-dd"로 고정한다. 값은 Date 그대로 둬서 위 정렬의 getTime() 비교는 그대로 동작한다.
  var summaryAtCol = colIndex_(NEWS_HEADERS, '요약생성일시');
  sheet.getRange(NEWS_DATA_START_ROW, collectedCol + 1, all.length, 1).setNumberFormat('yyyy-MM-dd');
  sheet.getRange(NEWS_DATA_START_ROW, summaryAtCol, all.length, 1).setNumberFormat('yyyy-MM-dd');
  sheet.getRange(NEWS_DATA_START_ROW, 1, all.length, NEWS_HEADERS.length).setValues(all);
  // 폰트 색은 값과 달리 행 위치에 그대로 남으므로, 재정렬 후 '비고' 컬럼 색을 값 기준으로 다시 칠한다.
  var noteCol = colIndex_(NEWS_HEADERS, '비고');
  sheet.getRange(NEWS_DATA_START_ROW, noteCol, all.length, 1).setFontColors(all.map(function (r) {
    return [String(r[noteCol - 1] || '').indexOf('흡수') >= 0 ? ABSORBED_NOTE_COLOR_ : '#000000'];
  }));
  return newValues.length;
}

/** 이미 저장된 기사들의 제목 지문(shingle)을 읽어온다. matchExistingStory_로 유사 사안 병합 판정에 쓴다. */
function findExistingStories_(track) {
  var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
  if (sheet.getLastRow() < NEWS_DATA_START_ROW) return [];
  var titleCol = colIndex_(NEWS_HEADERS, '제목') - 1;
  var countCol = colIndex_(NEWS_HEADERS, '기사건수') - 1;
  var rows = sheet.getRange(NEWS_DATA_START_ROW, 1, sheet.getLastRow() - NEWS_HEADER_ROW, NEWS_HEADERS.length).getValues();
  return rows.map(function (r, i) {
    // title은 matchExistingStory_의 연도/주제 가드(sameStoryGuard_)가 원문을 다시 봐야 해서 함께 들고 있는다.
    return { rowIndex: i + NEWS_DATA_START_ROW, title: r[titleCol], shingles: textShingles_(storyFingerprintText_({ title: r[titleCol] })), count: Number(r[countCol]) || 0 };
  });
}

/** 비고 셀("총 N건 흡수 : yyyy-MM-dd")에서 누적 건수를 읽어 add만큼 더하고, 날짜는 이번 수집 실행일로 갱신한다. */
function absorbedNoteText_(prevValue, add, runDate) {
  var m = String(prevValue || '').match(/총\s*(\d+)\s*건/);
  return '총 ' + ((m ? Number(m[1]) : 0) + add) + '건 흡수 : ' + Utilities.formatDate(runDate || new Date(), TZ, 'yyyy-MM-dd');
}

// [정책 2026-09-08] 유사 사안으로 판정돼 기존 행에 흡수된 기사는 기사건수만 +1 되고 "무엇이 흡수됐는지"가
// 전혀 남지 않아, 로그에는 신규 건수가 찍히는데 시트에는 새 행이 안 보이는 상황을 추적할 수 없었다.
// 비고 컬럼에 "총 N건 흡수 : 수집실행일(yyyy-MM-dd)"을 적는다(기사 일자/제목/URL은 남기지 않는다).
// updates: [{ rowIndex, count, absorbedCount, absorbedLinks: [...] }, ...]
function applyStoryCountMerges_(track, updates, runDate) {
  if (!updates || updates.length === 0) return;
  var sheet = getSheet_(SHEET_NAMES.NEWS[track]);
  var countCol = colIndex_(NEWS_HEADERS, '기사건수');
  var noteCol = colIndex_(NEWS_HEADERS, '비고');
  var links = [];
  updates.forEach(function (u) {
    sheet.getRange(u.rowIndex, countCol).setValue(u.count);
    if (!u.absorbedCount) return;
    var cell = sheet.getRange(u.rowIndex, noteCol);
    cell.setValue(absorbedNoteText_(cell.getValue(), u.absorbedCount, runDate));
    cell.setFontColor(ABSORBED_NOTE_COLOR_); // 흡수 발생 행은 눈에 띄게 빨간색
    links = links.concat(u.absorbedLinks || []);
  });
  // 재흡수 방지용 링크는 시트가 아니라 스크립트 속성에 보관한다.
  rememberAbsorbedLinks_(track, links);
}

