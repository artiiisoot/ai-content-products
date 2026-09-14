// P1-08. 자동 실행 트리거와 수동 실행 메뉴
// [정책 변경 2026-09-04] 트랙별 키워드 수가 늘면서(경쟁사 39개 등) 3트랙을 한 트리거 안에서 순서대로 처리하면
// Apps Script 시간 기반 트리거의 6분 실행 제한을 넘겨 타임아웃 → 그날 자동수집 전체가 무산되는 사고가 있었다.
// 트랙마다 트리거를 분리해 각자 독립된 6분 예산을 갖게 한다(하나가 오래 걸려도 다른 트랙엔 영향 없음).
var SCHEDULED_TRIGGER_FNS_ = ['collectScheduledTech', 'collectScheduledCompetitor', 'collectScheduledConference'];
function removeExistingTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (SCHEDULED_TRIGGER_FNS_.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
}
function installTriggers_() {
  removeExistingTriggers_();
  ScriptApp.newTrigger('collectScheduledTech').timeBased().atHour(7).everyDays(1).create();
  ScriptApp.newTrigger('collectScheduledCompetitor').timeBased().atHour(8).everyDays(1).create();
  ScriptApp.newTrigger('collectScheduledConference').timeBased().atHour(9).everyDays(1).create();
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('뉴스 수집')
    .addItem('기술 수집 실행', 'runNowTech')
    .addItem('경쟁사 수집 실행', 'runNowCompetitor')
    .addItem('컨퍼런스 수집 실행', 'runNowConference')
    .addToUi();
  // [정책] 시트 메뉴에서 "주간콘텐츠후보" 버튼은 뺀다(오탐 클릭 방지 등). 기능 자체(수동 요청/자동 생성)는 그대로 유지 —
  // requestWeeklyCandidatesNow()는 필요 시 Apps Script 에디터에서 직접 실행 가능.
}

/**
 * 주간콘텐츠후보를 지금 생성해달라는 요청 플래그를 남긴다.
 * 실제 AI 추론은 사내망 로컬 러너가 처리하므로, 이 함수는 Apps Script 안에서 결과를 만들어내지 않는다.
 * 로컬 러너의 `check` 명령이 doGet(action=weeklyCandidatesManualRequest)로 이 요청을 2분마다 폴링해 확인하고,
 * 감지되면 즉시 weekly를 실행한 뒤 doPost(action=ackWeeklyCandidatesManualRequest)로 플래그를 지운다.
 * (로컬 러너의 check 폴링이 돌고 있지 않다면 이 버튼은 요청 기록만 남기고, 평소처럼 다음 월요일 자동 실행 때 처리된다.)
 */
function requestWeeklyCandidatesNow() {
  var now = new Date();
  PropertiesService.getScriptProperties().setProperty('WEEKLY_CANDIDATES_MANUAL_REQUESTED_AT', now.toISOString());
  SpreadsheetApp.getUi().alert(
    '주간콘텐츠후보 수동 생성을 요청했습니다.\n\n' +
    '실제 AI 추론은 사내망 로컬 러너가 처리하기 때문에, 이 버튼은 "지금 실행해 달라"는 요청 표시만 남깁니다.\n' +
    '로컬 러너가 정상 동작 중이면 최대 2분 안에 자동으로 생성되며, 러너가 꺼져 있다면 다음 월요일 자동 실행 때 함께 처리됩니다.'
  );
} function runNowForTrack_(track) {
  var runAt = new Date();
  prepareCollectionWindow_(runAt, 'manual'); // 수동 실행: 오늘 00:00 ~ 버튼 클릭 시각
  var r = runCollectionForTrack_(track, runAt);
  appendRunLog_({ runAt: runAt, track: track, keywordCount: r.keywordCount, newArticleCount: r.newArticleCount, errorCount: r.errorMessages.length, errorMessages: r.errorMessages });
  SpreadsheetApp.getUi().alert('[' + track + '] 수집 완료: 키워드 ' + r.keywordCount + '건, 신규 기사 ' + r.newArticleCount + '건, 오류 ' + r.errorMessages.length + '건');
}
function runNowTech() { runNowForTrack_('기술'); }
function runNowCompetitor() { runNowForTrack_('경쟁사'); }
function runNowConference() { runNowForTrack_('컨퍼런스'); }

function collectScheduledTech() { runCollectionScheduledForTrack_('기술'); }
function collectScheduledCompetitor() { runCollectionScheduledForTrack_('경쟁사'); }
function collectScheduledConference() { runCollectionScheduledForTrack_('컨퍼런스'); }
