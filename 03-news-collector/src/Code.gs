// P1-01. 시트 기본 구조 생성
// [정책 변경] 키워드입력 탭을 없애고 키워드관리 탭 하나에서 직접 관리한다(중복 탭 제거, 동기화 로직 불필요).
var TRACKS = ['기술', '경쟁사', '컨퍼런스'];
var SHEET_NAMES = {
  KEYWORDS: { '기술': '키워드 관리(기술)', '경쟁사': '키워드 관리(경쟁사)', '컨퍼런스': '키워드 관리(컨퍼런스)' },
  NEWS: { '기술': '뉴스 수집(기술)', '경쟁사': '뉴스 수집(경쟁사)', '컨퍼런스': '뉴스 수집(컨퍼런스)' },
  SUMMARY: '일일요약',
  CANDIDATES: '주간콘텐츠후보',
  LOG: '로그'
};
var KEYWORD_HEADERS = ['사용여부', '키워드', '기업뉴스룸 URL', '카테고리', '등록일', '비고'];
var NEWS_HEADERS = ['수집일시', '키워드', '제목', '언론사', '발행일', '링크', '기사건수', '요약생성일시', '비고'];
var SUMMARY_HEADERS = ['수집범위', '키워드', '기사건수', 'AI요약', '생성일시'];
var CANDIDATE_HEADERS = ['주차범위', '순위', '제목 후보', '관련 키워드', '선정 이유', '라온시큐어 연결 포인트'];
var LOG_HEADERS = ['실행일시', '트랙', '대상키워드수', '신규기사수', '오류수', '오류내용'];

// [정책 2026-09-04] 뉴스수집 탭 1행에 수집 기준 안내 문구를 넣는다(2행은 여백, 3행부터 실제 헤더/데이터).
// 다른 탭(키워드관리 등)은 그대로 1행 헤더.
var NEWS_COLLECTION_NOTE = '자동 수집 기준: 전일 오전 9시 ~ 금일 오전 9시 / 수동 수집 기준: 전일 자정 ~ 금일 수집 요청 시점';
var NEWS_HEADER_ROW = 3;
var NEWS_DATA_START_ROW = NEWS_HEADER_ROW + 1;

function setup() {
  ensureSheets_();
  ensureHeaders_();
  installTriggers_();
}

// 트랙별로 나뉜 시트(KEYWORDS/NEWS)와 공통 시트(SUMMARY/CANDIDATES/LOG)를
// 모두 펼쳐서 [{key, name, headers, track?}] 목록으로 반환한다.
function allSheetSpecs_() {
  var specs = [];
  function addTrack(key, namesByTrack, headers, headerRow) {
    TRACKS.forEach(function (track) {
      specs.push({ key: key, name: namesByTrack[track], headers: headers, track: track, headerRow: headerRow || 1 });
    });
  }
  function addFlat(key, name, headers) {
    specs.push({ key: key, name: name, headers: headers, headerRow: 1 });
  }
  addTrack('KEYWORDS', SHEET_NAMES.KEYWORDS, KEYWORD_HEADERS);
  addTrack('NEWS', SHEET_NAMES.NEWS, NEWS_HEADERS, NEWS_HEADER_ROW);
  addFlat('SUMMARY', SHEET_NAMES.SUMMARY, SUMMARY_HEADERS);
  addFlat('CANDIDATES', SHEET_NAMES.CANDIDATES, CANDIDATE_HEADERS);
  addFlat('LOG', SHEET_NAMES.LOG, LOG_HEADERS);
  return specs;
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  allSheetSpecs_().forEach(function (spec) {
    if (!ss.getSheetByName(spec.name)) {
      ss.insertSheet(spec.name);
    }
  });
}

function ensureHeaders_() {
  allSheetSpecs_().forEach(function (spec) {
    ensureSheetHeader_(spec.name, spec.headers, spec.headerRow);
  });
}

function ensureSheetHeader_(sheetName, headers, headerRow) {
  headerRow = headerRow || 1;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var firstRow = sheet.getRange(headerRow, 1, 1, headers.length).getValues()[0];
  var hasHeader = firstRow.some(function (v) { return v !== ''; });
  if (!hasHeader) {
    if (headerRow > 1) sheet.getRange(1, 1).setValue(NEWS_COLLECTION_NOTE);
    sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(headerRow);
  }
}

function colIndex_(headers, name) {
  var idx = headers.indexOf(name);
  if (idx === -1) throw new Error('알 수 없는 컬럼: ' + name);
  return idx + 1;
}

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('시트를 찾을 수 없습니다: ' + name);
  return sheet;
}

// Force left alignment on all sheets; full-column so future collected rows inherit.
function alignSheetsLeft() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  allSheetSpecs_().forEach(function (spec) {
    var sheet = ss.getSheetByName(spec.name);
    if (!sheet) return;
    sheet.getRange('A:' + colLetter_(sheet.getMaxColumns())).setHorizontalAlignment('left');
  });
}

// Column number (1-based) -> letter. Up to Z (26); project sheets have <9 columns.
function colLetter_(n) {
  return String.fromCharCode(64 + n);
}
