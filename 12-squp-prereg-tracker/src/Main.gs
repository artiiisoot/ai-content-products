/**
 * SQUP 사전 예약 → "2026시큐업_사전등록현황" 탭 일일 로그 (Google Apps Script)
 * ------------------------------------------------------------------
 * · SQUP 백오피스가 호출하는 내부 API(member_list)를 그대로 재사용해
 *   전날 신청 건수를 매일 오전 9시에 시트에 한 줄씩 기록한다.
 * · SQUP API는 구글 서버가 직접 호출하므로 세션·CORS 문제가 없다.
 *
 * 기록: A 기록일시 | B 기준일(신청일) | C 신규 가입 | D 누적 가입 | E 전일 대비 증가 | F 메일발송
 *   - 기준일 = 실행일 전날. 매일 09시 실행 → 전날 신청분 집계.
 *   - 같은 기준일 재실행 시 새 줄 추가 없이 해당 줄 갱신(멱등).
 *   - 메일 발송 실패(쿼터 초과, 잘못된 수신자 등)와 무관하게 시트 기록(A~E)은 항상 남는다.
 *     F열에 성공/실패 여부를 남기고, 실패 시 실행 로그(Executions)에도 기록한다.
 * 설치: setup() 1회 실행 → 매일 09:00 자동. runNow() 는 즉시 테스트.
 *  - 누락 보정: updateFor('yyyy-MM-dd') 로 특정 기준일을 다시 집계·기록.
 *  - 명단 동기화(개인정보 탭) 실패도 격리되어 집계 기록에는 영향 없음.
 *  - 매일 집계 시 API 목록에서 사라진 건(탈퇴)은 명단 탭에서 자동 제거된다.
 *
 * 보안: SQUP_AUTH_HASH는 반드시 스크립트 속성(파일 > 프로젝트 설정 > 스크립트 속성)에
 *       등록해야 한다. 소스에 하드코딩된 fallback 값을 쓰던 이전 버전은 토큰이 코드와 함께
 *       유출될 수 있어 제거했다 — 유출 이력이 있다면 SQUP 쪽에 토큰 재발급도 요청할 것.
 */

// ─────────────── 설정 ───────────────
var SHEET_ID   = '15XfBl-O4tbErVnLaN40nczkpiNj7x98ooG0DWkzH6Uw';
var SHEET_NAME = '2026시큐업_사전등록현황';
var API_URL    = 'https://squp.kr/api/api_copy.php/member_list?mode=member_list';

var AUTH_HASH = PropertiesService.getScriptProperties().getProperty('SQUP_AUTH_HASH');

var TZ = 'Asia/Seoul';
var MAX_PAGES = 50;                 // 페이징 무한루프 방어 상한
var HEADER = ['기록일시', '기준일', '신규 가입', '누적 가입', '전일 대비 증가', '메일발송'];

// 매일 기록 후 알림 메일 수신자(쉼표 구분). 매일 무조건 발송 시도.
// var NOTIFY_TO = 'hsyoun@raon.com,jspark4617@raon.com,skkim@raon.com,dyseo@raon.com,shkim0060@raon.com';
var NOTIFY_TO = 'artiiisoot@gmail.com,skkimraon@gmail.com';
// ────────────────────────────────────


function updateSqupDaily() {
  var now = new Date();
  var baseDate = new Date(now.getTime() - 86400000);
  updateFor_(Utilities.formatDate(baseDate, TZ, 'yyyy-MM-dd'), now);
}


// 트리거가 걸러진 날을 나중에 채워 넣을 때 사용. 예) updateFor('2026-08-20')
function updateFor(dateStr) {
  updateFor_(String(dateStr).slice(0, 10), new Date());
}


function updateFor_(yStr, now) {
  var stamp = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm');

  // 기준일이 실행 시점과 다른 해면 두 해를 함께 조회한다.
  // (1월 1일 실행 시 기준일은 전년 12월 31일이라, 올해만 조회하면 집계가 0이 된다)
  var yBase = Number(yStr.slice(0, 4));
  var yNow  = Number(Utilities.formatDate(now, TZ, 'yyyy'));
  var years = (yBase === yNow) ? [yNow] : [yBase, yNow];

  var records = fetchAll_(years);

  var newCount = 0, cum = 0;
  for (var i = 0; i < records.length; i++) {
    var d = String(records[i].wdate || '').slice(0, 10);
    if (!d) continue;
    if (d === yStr) newCount++;
    if (d <= yStr) cum++;
  }

  var sh = getSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow === 0) {
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    lastRow = 1;
  }

  // 같은 기준일 행이 이미 있으면(마지막 행이 아니어도) 그 행을 갱신한다.
  var targetRow = 0, prevCum = null;
  if (lastRow >= 2) {
    var bcol = sh.getRange(2, 2, lastRow - 1, 1).getValues();
    for (var r = 0; r < bcol.length; r++) {
      if (fmtDateCell_(bcol[r][0]) === yStr) { targetRow = r + 2; break; }
    }
  }
  if (targetRow) {
    if (targetRow >= 3) prevCum = Number(sh.getRange(targetRow - 1, 4).getValue());
  } else {
    targetRow = lastRow + 1;
    if (lastRow >= 2) prevCum = Number(sh.getRange(lastRow, 4).getValue());
  }

  var delta = (prevCum === null) ? newCount : (cum - prevCum);
  sh.getRange(targetRow, 1, 1, HEADER.length - 1)
    .setValues([[stamp, yStr, newCount, cum, delta]]);

  Logger.log('기록: 기준일 %s 신규=%s 누적=%s 전일대비=%s (row %s)', yStr, newCount, cum, delta, targetRow);

  // 명단 동기화가 실패해도 위 집계 기록(A~E)은 이미 커밋된 뒤라 영향받지 않는다.
  try {
    var added = syncMembers_(records);
    Logger.log('명단 동기화 완료: 신규 %s건', added);
  } catch (e) {
    Logger.log('명단 동기화 실패: %s', e.message);
  }
  // 백오피스에서 삭제된 건(탈퇴)을 명단에서 정리. 실패해도 집계 기록에는 영향 없음.
  try { var removed = pruneGhosts_(true, records); if (removed) Logger.log('탈퇴분 정리 완료: %s건', removed); } catch (e3) { Logger.log('탈퇴분 정리 실패: %s', e3.message); }

  // 메일 발송 실패(쿼터 초과, 잘못된 수신자 등)도 마찬가지. 결과만 F열/로그에 남긴다.
  var mailNote;
  try {
    notify_(yStr, newCount, cum, delta);
    mailNote = '발송 ' + Utilities.formatDate(now, TZ, 'HH:mm');
  } catch (e2) {
    mailNote = '실패: ' + e2.message;
    Logger.log('메일 발송 실패: %s', e2.message);
  }
  sh.getRange(targetRow, HEADER.length).setValue(mailNote);
}


function notify_(yStr, newCount, cum, delta) {
  if (!NOTIFY_TO) return;
  var sign = delta > 0 ? ('+' + delta) : String(delta);
  var subject = '[SQUP 사전등록] ' + yStr + ' 신규 ' + newCount + '건 (누적 ' + cum + ')';
  var body =
    'SQUP 사전 예약 일일 집계\n────────────────────\n' +
    '기준일(신청일): ' + yStr + '\n' +
    '신규 가입:      ' + newCount + '건\n' +
    '누적 가입:      ' + cum + '건\n' +
    '전일 대비:      ' + sign + '\n\n' +
    '시트: https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit\n\n' +
    '※ 매일 오전 자동 발송됩니다.';
  GmailApp.sendEmail(NOTIFY_TO, subject, body);
}


function fetchAll_(years) {
  if (!AUTH_HASH) {
    throw new Error('SQUP_AUTH_HASH가 스크립트 속성에 없습니다. 파일 > 프로젝트 설정 > 스크립트 속성에서 등록하세요.');
  }
  var list = (years && years.length) ? years : [Number(Utilities.formatDate(new Date(), TZ, 'yyyy'))];
  var seen = {}, all = [];
  for (var y = 0; y < list.length; y++) {
    var page = 1;
    while (true) {
      var payload = { page: page, perPage: 100, ra_column: '', search_text: '', ra_sort: 'DESC', s_date: '', e_date: '', ra_year: list[y] };
      var res = UrlFetchApp.fetch(API_URL, {
        method: 'post', contentType: 'application/json',
        headers: { 'X-Auth-Hash': AUTH_HASH },
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) {
        throw new Error('API 오류 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
      }
      var data = (JSON.parse(res.getContentText()) || {}).data || [];
      // 페이징 도중 신규 유입으로 같은 건이 두 페이지에 걸쳐 잡히면 집계가 부풀려지므로 idx 기준 중복 제거
      for (var i = 0; i < data.length; i++) {
        var key = data[i].idx ? ('I:' + data[i].idx) : ('P:' + list[y] + ':' + page + ':' + i);
        if (seen[key]) continue;
        seen[key] = true;
        all.push(data[i]);
      }
      if (data.length < 100) break;
      page++;
      if (page > MAX_PAGES) throw new Error('페이지 상한(' + MAX_PAGES + ') 초과 - API 응답을 확인하세요');
    }
  }
  return all;
}


function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('탭을 찾을 수 없음: ' + SHEET_NAME);
  return sh;
}

function fmtDateCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}


function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateSqupDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('updateSqupDaily').timeBased().everyDays(1).atHour(9).nearMinute(5).create();
  Logger.log('트리거 등록 완료(매일 09시대). 프로젝트 시간대가 Asia/Seoul 인지 확인.');
}

function runNow() { updateSqupDaily(); }



// ───────────── 사전등록자 명단(개인정보) 기록 ─────────────
var MEMBER_SHEET_NAME = '2026시큐업_사전등록자_명단';
var MEMBER_SHEET_LEGACY = ['사전등록자_명단'];   // 예전 탭명 → 발견 시 자동 리네임
var MEMBER_HEADER = ['번호', '이름', '휴대폰번호', '이메일', '회사명', '부서명', '직급/직책', '신청일'];

// API 응답 키(확인 완료): row, idx, name, phone, email, company, department,
// position, wdate, ip, type, year, fav_content, join_send, status ...
// 아래는 [명단 컬럼 순서 중 '번호'를 뺀 나머지]에 대응하는 API 키. 앞에서부터 값이 있는 키를 사용한다.
// '번호'는 API 값이 아니라 기록 순번으로 자동 부여된다.
var MEMBER_FIELD_MAP = [
  ['name'],                      // 이름
  ['phone', 'hp', 'mobile'],     // 휴대폰번호
  ['email'],                     // 이메일
  ['company'],                   // 회사명
  ['department', 'dept'],        // 부서명
  ['position'],                  // 직급/직책
  ['wdate', 'reg_date']          // 신청일
];

function getMemberSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(MEMBER_SHEET_NAME);
  if (!sh) {
    for (var i = 0; i < MEMBER_SHEET_LEGACY.length; i++) {
      var legacy = ss.getSheetByName(MEMBER_SHEET_LEGACY[i]);
      if (legacy) { legacy.setName(MEMBER_SHEET_NAME); sh = legacy; break; }
    }
  }
  if (!sh) sh = ss.insertSheet(MEMBER_SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, MEMBER_HEADER.length).setValues([MEMBER_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');   // 휴대폰번호: 앞자리 0 보존
    return sh;
  }
  // 구버전(번호 열 없음) 시트면 A열에 번호 열을 끼워 넣고 기존 행에 순번을 채운다.
  if (String(sh.getRange(1, 1).getValue()).trim() !== MEMBER_HEADER[0]) {
    sh.insertColumnBefore(1);
    sh.getRange(1, 1).setValue(MEMBER_HEADER[0]).setFontWeight('bold');
    var n = sh.getLastRow() - 1;
    if (n > 0) {
      var seq = [];
      for (var k = 1; k <= n; k++) seq.push([k]);
      sh.getRange(2, 1, n, 1).setValues(seq);
    }
    sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');   // 휴대폰번호: 앞자리 0 보존
    sh.autoResizeColumns(1, MEMBER_HEADER.length);
  }
  return sh;
}

function pickField_(rec, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = rec[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function memberRow_(rec) {
  var row = [''];   // [0] 번호 - 기록 시 순번으로 채움
  for (var i = 0; i < MEMBER_FIELD_MAP.length; i++) row.push(pickField_(rec, MEMBER_FIELD_MAP[i]));
  row[7] = String(row[7]).slice(0, 10);
  return row;
}

function memberKey_(row) {
  var email = String(row[3]).toLowerCase();
  var hp = String(row[2]).replace(/[^0-9]/g, '');
  // 숫자 서식으로 앞자리 0이 날아간 기존 시트 값 보정(중복 추가 방지)
  if (hp.length === 10 && hp.charAt(0) !== '0') hp = '0' + hp;
  if (email) return 'E:' + email;
  if (hp) return 'P:' + hp;
  return 'N:' + row[1] + '|' + row[7];
}

// 명단 탭에 신규 신청자만 아래로 추가한다. 반환: 추가 건수
function syncMembers_(records) {
  var sh = getMemberSheet_();
  var lastRow = sh.getLastRow();
  var seen = {};
  if (lastRow >= 2) {
    var old = sh.getRange(2, 1, lastRow - 1, MEMBER_HEADER.length).getValues();
    for (var i = 0; i < old.length; i++) {
      var o = old[i].map(function (v) { return v instanceof Date ? fmtDateCell_(v) : String(v).trim(); });
      seen[memberKey_(o)] = true;
    }
  }
  var items = [], skipped = 0;
  for (var j = 0; j < records.length; j++) {
    var rec = records[j];
    var row = memberRow_(rec);
    if (!row[1] && !row[2] && !row[3]) { skipped++; continue; }   // 이름/휴대폰/이메일이 모두 빈 건
    var k = memberKey_(row);
    if (seen[k]) continue;
    seen[k] = true;
    // 정렬용 원본 신청일시(날짜만 자르기 전 값)와 API 일련번호를 함께 보관
    items.push({ row: row, ts: pickField_(rec, MEMBER_FIELD_MAP[6]), idx: Number(rec.idx) || 0 });
  }
  // 신청이 빠른 사람부터 위, 가장 최근 등록자가 맨 아래로 오도록 오름차순 정렬
  items.sort(function (a, b) {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.idx - b.idx;
  });
  var rows = [];
  for (var s = 0; s < items.length; s++) rows.push(items[s].row);
  var startNo = Math.max(0, sh.getLastRow() - 1);
  for (var t = 0; t < rows.length; t++) rows[t][0] = startNo + t + 1;
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, MEMBER_HEADER.length).setValues(rows);
    sh.autoResizeColumns(1, MEMBER_HEADER.length);
  }
  Logger.log('명단 신규 추가: %s건 (누적 %s건, 필수값 누락으로 제외 %s건)', rows.length, sh.getLastRow() - 1, skipped);
  return rows.length;
}

// 1회 실행용: API 응답의 실제 키 이름 확인 (MEMBER_FIELD_MAP 정리에 사용)
function logMemberKeys() {
  var recs = fetchAll_();
  if (!recs.length) { Logger.log('데이터 없음'); return; }
  Logger.log('키 목록: %s', Object.keys(recs[0]).join(', '));
  Logger.log('첫 행 매핑 결과: %s', JSON.stringify(memberRow_(recs[0])));
}

// 메일 발송 없이 명단만 즉시 동기화 (수동 실행용)
function syncMembersNow() {
  var n = syncMembers_(fetchAll_());
  Logger.log('명단 동기화 완료: 신규 %s건', n);
}

// 명단 전체를 API 기준으로 다시 쓰기 (신청일시 오름차순 + 번호 재부여).
// 주의: 시트에 손으로 적어둔 내용이 있으면 사라지므로 필요할 때만 실행.
function rebuildMembers() {
  var sh = getMemberSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) sh.getRange(2, 1, lastRow - 1, MEMBER_HEADER.length).clearContent();
  SpreadsheetApp.flush();   // getLastRow 캐시 반영
  var n = syncMembers_(fetchAll_());
  Logger.log('명단 재정렬 완료: %s건', n);
}


// ───────── 탈퇴/삭제분 정리 ─────────
// API 목록에 더 이상 없는 행(= 백오피스에서 삭제된 건)을 명단 탭에서 제거한다.
// 먼저 pruneGhostsDryRun() 으로 대상만 확인한 뒤 pruneGhostMembers() 로 실제 제거.
function pruneGhostsDryRun() { pruneGhosts_(false); }
function pruneGhostMembers() { pruneGhosts_(true); }

function pruneGhosts_(apply, records) {
  var recs = (records && records.length) ? records : fetchAll_();
  if (!recs.length) throw new Error('API 응답 0건 - 안전을 위해 중단');

  var live = {};
  for (var i = 0; i < recs.length; i++) live[memberKey_(memberRow_(recs[i]))] = true;
  var years = {}; for (var q = 0; q < recs.length; q++) years[String(pickField_(recs[q], MEMBER_FIELD_MAP[6])).slice(0, 4)] = true;

  var sh = getMemberSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('명단이 비어 있음'); return; }

  var vals = sh.getRange(2, 1, lastRow - 1, MEMBER_HEADER.length).getValues();
  var ghosts = [];
  for (var r = 0; r < vals.length; r++) {
    var row = vals[r].map(function (v) { return v instanceof Date ? fmtDateCell_(v) : String(v).trim(); });
    if (!years[String(row[7]).slice(0, 4)]) continue; // 이번에 조회한 연도만 대조
    if (!live[memberKey_(row)]) ghosts.push({ sheetRow: r + 2, data: row });
  }

  Logger.log('명단 %s건 / API %s건 / 제거 대상 %s건', vals.length, recs.length, ghosts.length);
  for (var g = 0; g < ghosts.length; g++) Logger.log('  대상 %s행: %s', ghosts[g].sheetRow, JSON.stringify(ghosts[g].data));
  if (!ghosts.length) return;
  if (ghosts.length > recs.length * 0.3) throw new Error('제거 대상이 API 건수의 30% 초과 - 오탐 의심으로 중단');
  if (!apply) { Logger.log('DRY RUN - 실제로 지우지 않았습니다.'); return; }

  // 아래에서 위로 지워야 행 번호가 밀리지 않는다
  for (var d = ghosts.length - 1; d >= 0; d--) sh.deleteRow(ghosts[d].sheetRow);

  // 번호(A열) 재부여
  var n = sh.getLastRow() - 1;
  if (n > 0) {
    var seq = [];
    for (var k = 1; k <= n; k++) seq.push([k]);
    sh.getRange(2, 1, n, 1).setValues(seq);
  }
  Logger.log('완료: %s건 제거, 현재 명단 %s건', ghosts.length, n);
}


// ───────── 수식 인젝션 점검 (읽기 전용) ─────────
// 명단 시트에 "실제 수식"으로 저장된 셀이 있는지 점검한다. 값은 건드리지 않는다.
// getFormulas()는 일반 텍스트/숫자 셀은 빈 문자열을, 진짜 수식 셀만 '='로 시작하는 문자열을 반환한다.
function auditFormulaInjection() {
  var sh = getMemberSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('명단이 비어 있음'); return; }

  var formulas = sh.getRange(2, 1, lastRow - 1, MEMBER_HEADER.length).getFormulas();
  var hits = [];
  for (var r = 0; r < formulas.length; r++) {
    for (var c = 0; c < formulas[r].length; c++) {
      if (formulas[r][c]) hits.push({ row: r + 2, col: MEMBER_HEADER[c], formula: formulas[r][c] });
    }
  }

  Logger.log('점검 완료: %s행 중 실제 수식 셀 %s개', formulas.length, hits.length);
  for (var i = 0; i < hits.length; i++) {
    Logger.log('  %s행 [%s]: %s', hits[i].row, hits[i].col, hits[i].formula);
  }
}
