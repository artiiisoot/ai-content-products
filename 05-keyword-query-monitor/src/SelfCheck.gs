/**
 * 순수 로직 자가 점검. 시트/네트워크 접근 없이 실행 가능.
 * Apps Script 에디터에서 runSelfCheck() 실행 → 로그에 "OK" 확인.
 */
function runSelfCheck() {
  var results = [];

  // parseQcCnt_: 숫자는 그대로, "< 10"은 숫자로 둔갑시키지 않고 표시제한으로 표시
  var n = parseQcCnt_(1234);
  assert_(n.value === 1234 && n.isLimited === false, 'parseQcCnt_ 숫자');

  var limited = parseQcCnt_("< 10");
  assert_(limited.value === "< 10" && limited.isLimited === true, 'parseQcCnt_ 표시제한 값 보존(10으로 변환 금지)');

  var empty = parseQcCnt_("");
  assert_(empty.value === "" && empty.isLimited === false, 'parseQcCnt_ 빈값');

  var strNum = parseQcCnt_("2,500");
  assert_(strNum.value === 2500 && strNum.isLimited === false, 'parseQcCnt_ 콤마 포함 문자열 숫자');

  var unknown = parseQcCnt_("-");
  assert_(unknown.value === "-" && unknown.isLimited === true, 'parseQcCnt_ 알 수 없는 형식은 원문 보존');

  Logger.log('runSelfCheck OK: ' + results.length + ' checks passed');
  return 'OK';

  function assert_(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    results.push(msg);
  }
}
