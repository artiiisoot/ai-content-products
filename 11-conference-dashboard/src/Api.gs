/**
 * 프론트가 호출하는 유일한 진입점.
 * 원장의 `연도_이름` 탭을 읽어 화면이 바로 쓸 수 있는 JSON으로 돌려줍니다.
 *
 * 탭 모양이 두 가지라 읽는 방법도 두 가지입니다.
 *  - 목록형 (라온참가 / 전체 / 경쟁사주최): 헤더가 한 줄, `행사명` 이 들어간 행이 헤더
 *  - 매트릭스형 (경쟁사참가): 헤더가 세 줄(형태 / 행사명 / 주최), 행이 경쟁사
 */

/** 화면에 올릴 탭 종류. 지금은 라온참가만 봅니다. 넓히려면 여기에 추가하세요. */
var VISIBLE_KINDS = ['라온참가'];

function getData() {
  var ss = SpreadsheetApp.getActive();
  var hiddenMap = hiddenRowsBySheet_(ss.getId());
  var tabs = [];

  ss.getSheets().forEach(function (sh) {
    var parsed = parseTabName_(sh.getName());
    if (!parsed) return;
    if (VISIBLE_KINDS.indexOf(parsed.name) === -1) return;
    var table = readSheet_(sh, hiddenMap[sh.getName()] || []);
    if (table) {
      table.tab = sh.getName();
      table.year = parsed.year;
      table.kind = parsed.name;
      table.gid = sh.getSheetId();
      tabs.push(table);
    }
  });

  return {
    spreadsheetUrl: ss.getUrl(),
    updatedAt: new Date().toISOString(),
    legend: readLegend_(ss),
    tabs: tabs
  };
}

/** `2026_라온참가` → { year:'2026', name:'라온참가' } */
function parseTabName_(name) {
  var m = String(name).match(/^(\d{4})_(.+)$/);
  return m ? { year: m[1], name: m[2] } : null;
}

function readSheet_(sh, hidden) {
  var range = sh.getDataRange();
  var values = range.getValues();
  var backgrounds = range.getBackgrounds();
  if (!values.length) return null;

  var headerRow = -1, divider = -1;
  for (var r = 0; r < Math.min(values.length, 8); r++) {
    var row = values[r].map(cleanText_);
    if (headerRow < 0 && row.indexOf('행사명') !== -1) headerRow = r;
    if (divider < 0 && /^구분/.test(row[0] || '')) divider = r;
  }

  if (headerRow >= 0) {
    fillMerged_(sh, values);
    return readList_(values, backgrounds, headerRow, hidden);
  }
  if (divider >= 0) return readMatrix_(values, divider, hidden);
  return null;
}

/** 세로·가로로 병합된 칸을 같은 값으로 채웁니다. 시트에서는 좌상단 셀에만 값이 있습니다. */
function fillMerged_(sh, values) {
  sh.getDataRange().getMergedRanges().forEach(function (rng) {
    var r0 = rng.getRow() - 1, c0 = rng.getColumn() - 1;
    var v = values[r0] ? values[r0][c0] : '';
    if (v === '' || v == null) return;
    for (var r = r0; r < r0 + rng.getNumRows(); r++) {
      for (var c = c0; c < c0 + rng.getNumColumns(); c++) {
        if (values[r]) values[r][c] = v;
      }
    }
  });
}

/**
 * 숨겨진 행(사람이 숨긴 행 + 필터로 가려진 행)을 탭별로 한 번에 가져옵니다.
 * isRowHiddenByUser() 를 행마다 부르면 요청이 수백 번이라 화면이 느려집니다.
 * 고급 Sheets 서비스가 막혀 있으면 숨김 정보 없이 그대로 진행합니다.
 */
function hiddenRowsBySheet_(spreadsheetId) {
  try {
    var res = Sheets.Spreadsheets.get(spreadsheetId, {
      includeGridData: true,
      fields: 'sheets(properties(title),data(rowMetadata(hiddenByUser,hiddenByFilter)))'
    });
    var map = {};
    (res.sheets || []).forEach(function (s) {
      var meta = (s.data && s.data[0] && s.data[0].rowMetadata) || [];
      map[s.properties.title] = meta.map(function (m) {
        return Boolean(m && (m.hiddenByUser || m.hiddenByFilter));
      });
    });
    return map;
  } catch (e) {
    return {};
  }
}

/** 목록형: 한 줄 헤더 + 행마다 한 건. 배경색은 행사명 셀 기준으로 함께 돌려줍니다. */
function readList_(values, backgrounds, headerRow, hidden) {
  var headers = values[headerRow].map(cleanText_);
  var nameCol = headers.indexOf('행사명');
  var rows = [];

  for (var r = headerRow + 1; r < values.length; r++) {
    var name = cleanText_(values[r][nameCol]);
    if (!name) continue;
    // 시트 하단 범례 행은 행사명 칸에만 글자가 있습니다. 데이터가 아니므로 건너뜁니다.
    if (onlyCellFilled_(values[r], nameCol)) continue;

    var item = {
      _row: r + 1,
      _fill: String(backgrounds[r][nameCol] || '').toLowerCase(),
      _hidden: Boolean(hidden && hidden[r])
    };
    headers.forEach(function (h, c) {
      if (!h) return;
      var v = values[r][c];
      item[h] = (v instanceof Date) ? formatDate_(v) : cleanText_(v);
    });
    rows.push(item);
  }
  return { type: 'list', headers: headers.filter(String), rows: rows };
}

/** 매트릭스형: 3줄 헤더(형태 / 행사명 / 주최) + 경쟁사 행 */
function readMatrix_(values, headerRow, hidden) {
  var formRow = values[headerRow] || [];
  var nameRow = values[headerRow + 1] || [];
  var hostRow = values[headerRow + 2] || [];

  var columns = [], form = '';
  for (var c = 1; c < nameRow.length; c++) {
    if (cleanText_(formRow[c])) form = cleanText_(formRow[c]);
    var name = cleanText_(nameRow[c]);
    if (!name || /합계/.test(name)) continue;
    columns.push({ col: c, 행사명: name, 주최: cleanText_(hostRow[c]), 형태: form });
  }

  var rows = [];
  for (var r = headerRow + 3; r < values.length; r++) {
    var company = cleanText_(values[r][0]);
    if (!company) continue;
    var cells = columns.map(function (col) { return cleanText_(values[r][col.col]); });
    rows.push({
      _row: r + 1, _hidden: Boolean(hidden && hidden[r]),
      경쟁사: company, cells: cells, 참가건수: cells.filter(String).length
    });
  }
  return { type: 'matrix', columns: columns, rows: rows };
}

/**
 * 상태 범례를 시트에서 직접 읽습니다. (라온참가 탭 하단의 색+문구)
 * 색 정의가 바뀌어도 코드를 고칠 필요가 없습니다.
 */
function readLegend_(ss) {
  var sheet = null;
  ss.getSheets().forEach(function (sh) {
    if (!sheet && /_라온참가$/.test(sh.getName())) sheet = sh;
  });
  if (!sheet) return [];

  var last = sheet.getLastRow();
  var from = Math.max(last - 20, 1);
  var values = sheet.getRange(from, 1, last - from + 1, 5).getValues();
  var backgrounds = sheet.getRange(from, 1, last - from + 1, 5).getBackgrounds();

  var out = [];
  for (var r = 0; r < values.length; r++) {
    // 범례 행은 셀 하나에만 글자가 있습니다. 데이터 행은 여러 칸이 차 있어 이 조건에서 걸러집니다.
    var filled = [];
    for (var c = 0; c < values[r].length; c++) {
      if (cleanText_(values[r][c])) filled.push(c);
    }
    if (filled.length !== 1) continue;

    var col = filled[0];
    var text = cleanText_(values[r][col]);
    var bg = String(backgrounds[r][col] || '').toLowerCase();
    if (!bg || bg === '#ffffff' || bg === '#000000' || text.length > 24) continue;
    if (!out.some(function (x) { return x.color === bg; })) out.push({ color: bg, label: text });
  }
  return out;
}

/** 그 행에서 값이 들어 있는 칸이 지정한 칸 하나뿐인지 */
function onlyCellFilled_(row, col) {
  for (var c = 0; c < row.length; c++) {
    if (c !== col && cleanText_(row[c])) return false;
  }
  return true;
}

function cleanText_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function formatDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
