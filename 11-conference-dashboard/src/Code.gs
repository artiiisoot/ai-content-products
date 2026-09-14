/**
 * 기존 시트(마케팅팀 김성규)의 탭을 원장으로 통째로 복사합니다.
 * 값·서식·배경색·조건부서식·열너비까지 그대로 옮깁니다. (copyTo)
 *
 * 탭 이름은 `연도_이름` 규칙으로 통일합니다. 2027년이 추가되면
 * YEAR 만 바꿔 다시 실행하면 됩니다.
 */

var LEGACY_ID = '15visVkJ1QKJ3ZJ1YDntR_wizWw0lWSYzt3zTlJ5LMI8';
var YEAR = '2026';

/** 원본 탭을 찾는 키워드 → 원장에서 쓸 이름 */
var TABS = [
  { keyword: '라온 참가', name: '라온참가' },
  { keyword: '컨퍼런스 전체', name: '전체' },
  { keyword: '경쟁사 주최', name: '경쟁사주최' },
  { keyword: '경쟁사 참가', name: '경쟁사참가' }
];

function copyLegacyTabs() {
  var src = SpreadsheetApp.openById(LEGACY_ID);
  var dst = SpreadsheetApp.getActive();
  var log = [];

  TABS.forEach(function (t) {
    var from = findSheet_(src, t.keyword, YEAR);
    var to = YEAR + '_' + t.name;

    var existing = dst.getSheetByName(to);
    if (existing) dst.deleteSheet(existing);          // 재실행하면 최신 내용으로 갈아끼웁니다

    from.copyTo(dst).setName(to);
    log.push(to + ' ← [' + from.getName() + '] ' + from.getLastRow() + '행 × ' + from.getLastColumn() + '열');
  });

  removeBlankSheets_(dst);
  orderSheets_(dst);

  Logger.log('복사 완료\n' + log.join('\n') +
    '\n남은 탭: ' + dst.getSheets().map(function (s) { return s.getName(); }).join(' / '));
  return log;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('컨퍼런스 원장')
    .addItem(YEAR + ' 탭 복사', 'copyLegacyTabs')
    .addToUi();
}

/**
 * 키워드가 들어간 탭을 찾습니다. 같은 키워드의 탭이 여러 개면(2025·2024 등)
 * 이름에 연도가 있는 탭을 먼저 고릅니다.
 */
function findSheet_(ss, keyword, year) {
  var hits = ss.getSheets().filter(function (s) { return s.getName().indexOf(keyword) !== -1; });
  if (!hits.length) {
    throw new Error('"' + keyword + '" 탭을 찾지 못했습니다. 있는 탭: ' +
      ss.getSheets().map(function (s) { return s.getName(); }).join(' / '));
  }
  var withYear = hits.filter(function (s) { return s.getName().indexOf(year) !== -1; });
  return withYear.length ? withYear[0] : hits[0];
}

/** 내용이 없는 기본 시트(시트1 등)를 정리합니다. */
function removeBlankSheets_(ss) {
  ss.getSheets().forEach(function (sh) {
    if (sh.getLastRow() === 0 && sh.getLastColumn() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(sh);
    }
  });
}

/** 연도·이름 순으로 탭을 정렬합니다. 연도가 늘어나도 순서가 유지됩니다. */
function orderSheets_(ss) {
  var order = TABS.map(function (t) { return t.name; });
  ss.getSheets()
    .slice()
    .sort(function (a, b) {
      var pa = parse_(a.getName()), pb = parse_(b.getName());
      if (pa.year !== pb.year) return pa.year < pb.year ? -1 : 1;
      return order.indexOf(pa.name) - order.indexOf(pb.name);
    })
    .forEach(function (sh, i) {
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(i + 1);
    });
}

function parse_(sheetName) {
  var m = String(sheetName).match(/^(\d{4})_(.+)$/);
  return m ? { year: m[1], name: m[2] } : { year: '9999', name: sheetName };
}
