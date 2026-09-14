// P1-02. 키워드 관리
function hasNewsroom_(keywordRow) {
  return !!(
    keywordRow.newsroomUrl && String(keywordRow.newsroomUrl).trim() !== ""
  );
}
function getEnabledKeywords_(track) {
  var sheet = getSheet_(SHEET_NAMES.KEYWORDS[track]);
  if (sheet.getLastRow() < 2) return [];
  var rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, KEYWORD_HEADERS.length)
    .getValues();
  var c = {
    enabled: colIndex_(KEYWORD_HEADERS, "사용여부") - 1,
    keyword: colIndex_(KEYWORD_HEADERS, "키워드") - 1,
    newsroomUrl: colIndex_(KEYWORD_HEADERS, "기업뉴스룸 URL") - 1,
    category: colIndex_(KEYWORD_HEADERS, "카테고리") - 1,
    note: colIndex_(KEYWORD_HEADERS, "비고") - 1,
    registeredAt: colIndex_(KEYWORD_HEADERS, "등록일") - 1,
  };
  return rows
    .map(function (r, i) { return { r: r, rowIndex: i + 2 }; })
    .filter(function (x) {
      return (
        String(x.r[c.enabled]).toUpperCase() === "Y" &&
        String(x.r[c.keyword]).trim() !== ""
      );
    })
    .map(function (x) {
      return {
        rowIndex: x.rowIndex,
        keyword: x.r[c.keyword],
        newsroomUrl: x.r[c.newsroomUrl],
        category: x.r[c.category],
        note: x.r[c.note],
        registeredAt: x.r[c.registeredAt],
      };
    });
}

// [정책] 등록일을 비워둔 채로 등록된 키워드가 수집 대상에 포함되면, 그 수집을 실행한 날짜를 등록일에 채운다
// (자동/수동 수집 모두 runCollectionForTrack_를 거치므로 여기 한 곳에서 처리).
function fillMissingRegisteredDates_(track, keywords, runAt) {
  var toFill = keywords.filter(function (k) { return !k.registeredAt || String(k.registeredAt).trim() === ""; });
  if (toFill.length === 0) return;
  var sheet = getSheet_(SHEET_NAMES.KEYWORDS[track]);
  var dateCol = colIndex_(KEYWORD_HEADERS, "등록일");
  var today = Utilities.formatDate(runAt, TZ, "yyyy-MM-dd");
  toFill.forEach(function (k) { sheet.getRange(k.rowIndex, dateCol).setValue(today); });
}
