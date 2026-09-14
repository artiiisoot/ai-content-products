/**
 * 테스트용: shkim0060@raon.com 에게 2분 간격으로 테스트 메일 발송 + 시트 기록
 * ------------------------------------------------------------------
 * Main.gs의 updateSqupDaily 로직과는 무관한 별도 트리거/함수.
 * Apps Script 분단위 트리거는 1/5/10/15/30분만 지원해 "2분"을 직접 못 만든다.
 * 그래서 1분 트리거를 걸고, 마지막 발송 후 2분이 지났을 때만 실제로 보낸다.
 * ponytail: 정확히 2:00.000 간격은 아니고 트리거 지터만큼(수 초) 밀릴 수 있음 —
 *           초 단위 정밀도가 필요해지면 UrlFetchApp 기반 외부 스케줄러로 교체.
 * 설치: setupTestMailPing() 1회 실행. 중단: stopTestMailPing() 실행.
 */

var TEST_MAIL_TO       = 'shkim0060@raon.com';
var TEST_LOG_SHEET_NAME = '테스트메일로그';
var TEST_INTERVAL_MS    = 2 * 60 * 1000;
var TEST_LAST_SENT_KEY  = 'TEST_MAIL_LAST_SENT';
var TEST_LOG_HEADER     = ['발송시각', '수신자', '결과', '비고'];


function testMailPing() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(TEST_LAST_SENT_KEY) || 0);
  var now = Date.now();
  if (!shouldSendNow_(last, now)) return;

  var stamp = Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd HH:mm:ss');
  var result, note;
  try {
    MailApp.sendEmail(TEST_MAIL_TO, '[테스트] SQUP 알림 핑 ' + stamp, '2분 간격 테스트 메일입니다.\n발송시각: ' + stamp);
    result = '성공';
    note = '';
  } catch (e) {
    result = '실패';
    note = e.message;
  }

  props.setProperty(TEST_LAST_SENT_KEY, String(now));
  getTestLogSheet_().appendRow([stamp, TEST_MAIL_TO, result, note]);
}

function shouldSendNow_(lastMs, nowMs) {
  return (nowMs - lastMs) >= TEST_INTERVAL_MS;
}

function getTestLogSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(TEST_LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(TEST_LOG_SHEET_NAME);
    sh.getRange(1, 1, 1, TEST_LOG_HEADER.length).setValues([TEST_LOG_HEADER]).setFontWeight('bold');
  }
  return sh;
}


function setupTestMailPing() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'testMailPing') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('testMailPing').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().deleteProperty(TEST_LAST_SENT_KEY);
  Logger.log('테스트 메일 트리거 등록 완료(1분마다 체크, 2분 간격 발송).');
}

function stopTestMailPing() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'testMailPing') ScriptApp.deleteTrigger(t);
  });
  Logger.log('테스트 메일 트리거 중단.');
}


function testMailPing_selfCheck() {
  if (shouldSendNow_(1000, 1000 + TEST_INTERVAL_MS - 1)) throw new Error('간격 미달인데 발송 판정됨');
  if (!shouldSendNow_(1000, 1000 + TEST_INTERVAL_MS)) throw new Error('간격 충족했는데 미발송 판정됨');
  Logger.log('testMailPing_selfCheck 통과');
}
