/** 원장 데이터를 손볼 때 쓰는 일회성 작업 모음. 실행 후 결과가 로그에 남습니다. */

function fixGukbangSchedule() {
  var changed = setValueByEvent_('2026_라온참가', '국방보안컨퍼런스', '일정', '-');
  Logger.log(changed.length ? '변경: ' + changed.join(' / ') : '해당 행사를 찾지 못했습니다');
  return changed;
}

/** 탭에서 행사명이 일치하는 행을 찾아 지정한 컬럼 값을 바꿉니다. */
function setValueByEvent_(tabName, eventName, header, value) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sh) throw new Error(tabName + ' 탭이 없습니다');

  var values = sh.getDataRange().getValues();
  var headerRow = -1;
  for (var r = 0; r < Math.min(values.length, 8) && headerRow < 0; r++) {
    if (values[r].map(String).indexOf('행사명') !== -1) headerRow = r;
  }
  if (headerRow < 0) throw new Error('헤더(행사명)를 찾지 못했습니다');

  var headers = values[headerRow].map(function (v) { return String(v).replace(/\s+/g, ' ').trim(); });
  var nameCol = headers.indexOf('행사명');
  var targetCol = headers.indexOf(header);
  if (targetCol < 0) throw new Error(header + ' 컬럼이 없습니다');

  var changed = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    if (String(values[i][nameCol]).trim() !== eventName) continue;
    var before = values[i][targetCol];
    sh.getRange(i + 1, targetCol + 1).setValue(value);
    changed.push(eventName + ' ' + (i + 1) + '행 ' + header + ': [' + before + '] → [' + value + ']');
  }
  return changed;
}
