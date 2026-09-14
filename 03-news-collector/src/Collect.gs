// P1-09. 실행 로그와 오류 처리, 수집 오케스트레이션
function safeCollectKeyword_(keywordRow, runAt, track) {
  try {
    var raw = hasNewsroom_(keywordRow) ? collectFromNewsroom_(keywordRow, track) : [];
    if (raw.length === 0) raw = collectFromNaver_(keywordRow.keyword, track);

    var uniqueByLink = dedupeArticles_(raw);
    var grouped = groupDuplicateStories_(uniqueByLink);

    var normalized = grouped.map(function (g) {
      var a = normalizeArticle_(g.article, keywordRow.keyword);
      a.count = g.count;
      return a;
    });

    // [정책 2026-09-04] 중복 링크 검사(읽기) ~ 시트 기록(쓰기) 사이에 다른 실행(예: 수동 클릭이 겹치거나
    // 자동 실행과 겹침)이 끼어들면 서로 상대의 방금 쓴 행을 못 보고 같은 기사를 두 번 쌓는 경합이 생긴다
    // (실제 사고: 18초 간격의 두 실행이 같은 링크를 각자 "신규"로 판단해 중복 행 생성).
    // 읽기~쓰기 구간을 스크립트 락으로 감싸 한 번에 한 실행만 처리하게 한다.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var rows;
    try {
      var existingLinks = findExistingLinks_(track);
      // 링크가 완전히 같은 기사는 건너뛴다(패스) — 자동/수동 수집 범위가 겹쳐도 이미 저장된 기사는 다시 안 쌓임.
      var fresh = normalized.filter(function (a) { return a.link && !existingLinks[a.link]; });
      rows = fresh.map(function (a) { return { collectedAt: runAt, keyword: a.keyword, title: a.title, source: a.source, publishedAt: a.publishedAt, link: a.link, count: a.count, summaryAt: runAt }; });

      // 링크는 다르지만 이미 저장된 기사와 같은 사안이면 새 행을 만들지 않고 기존 행의 기사건수에 누적한다.
      var existingStories = findExistingStories_(track);
      var toAppend = [];
      var countMerges = {}; // rowIndex -> { count: 누적 기사건수, absorbedCount: 흡수 건수, absorbedLinks: [링크...] }
      rows.forEach(function (a) {
        var matchIdx = matchExistingStory_(existingStories, a);
        if (matchIdx >= 0) {
          var es = existingStories[matchIdx];
          es.count += a.count;
          if (!countMerges[es.rowIndex]) countMerges[es.rowIndex] = { count: es.count, absorbedCount: 0, absorbedLinks: [] };
          countMerges[es.rowIndex].count = es.count;
          // 몇 건이 흡수됐는지는 비고에, 재흡수 방지용 링크는 스크립트 속성에 각각 기록된다.
          countMerges[es.rowIndex].absorbedCount += 1;
          if (a.link) countMerges[es.rowIndex].absorbedLinks.push(a.link);
        } else {
          toAppend.push(a);
        }
      });
      // 순서 중요: appendArticles_가 발행일 기준으로 전체 행을 재정렬하므로, 그 전에 먼저
      // 기존 행(재정렬 전 rowIndex 기준)의 기사건수를 갱신해야 한다.
      applyStoryCountMerges_(track, Object.keys(countMerges).map(function (rowIndex) {
        return { rowIndex: Number(rowIndex), count: countMerges[rowIndex].count, absorbedCount: countMerges[rowIndex].absorbedCount, absorbedLinks: countMerges[rowIndex].absorbedLinks };
      }), runAt);
      appendArticles_(toAppend, track);
    } finally {
      lock.releaseLock();
    }

    return { count: rows.length, error: null };
  } catch (e) {
    return { count: 0, error: String(e) };
  }
}
function appendRunLog_(result) {
  var sheet = getSheet_(SHEET_NAMES.LOG);
  var row = sheet.getLastRow() + 1;
  sheet.appendRow([result.runAt, result.track, result.keywordCount, result.newArticleCount, result.errorCount, result.errorMessages.join(' | ')]);
  // [정책 2026-09-07] 날짜 표기 통일: 실행일시도 시트 로캘 기본 표기("2026. 9. 1 오후 2:28:57")
  // 대신 "yyyy-MM-dd"로 고정한다.
  sheet.getRange(row, 1).setNumberFormat('yyyy-MM-dd');
}
// timeBudgetMs를 주면(자동 실행 전용) 그 시간 안에서만 키워드를 처리하고 나머지는 다음 실행으로 미룬다.
// 매번 같은 앞쪽 키워드만 처리되지 않도록, 스크립트 속성에 커서를 저장해 다음 실행은 이어지는 키워드부터 순환한다.
function runCollectionForTrack_(track, runAt, timeBudgetMs) {
  var keywords = getEnabledKeywords_(track);
  fillMissingRegisteredDates_(track, keywords, runAt); // 등록일 비어있던 키워드는 이번 수집 실행일로 채움

  var ordered = keywords;
  var startIndex = 0;
  if (timeBudgetMs) {
    startIndex = Number(PropertiesService.getScriptProperties().getProperty('COLLECTION_CURSOR_' + track)) || 0;
    if (startIndex >= keywords.length) startIndex = 0;
    ordered = keywords.slice(startIndex).concat(keywords.slice(0, startIndex));
  }

  var startedAt = Date.now();
  var newArticleCount = 0;
  var errorMessages = [];
  var processedCount = 0;
  for (var i = 0; i < ordered.length; i++) {
    if (timeBudgetMs && Date.now() - startedAt > timeBudgetMs) {
      errorMessages.push('[' + track + '] 시간 제한으로 ' + (ordered.length - i) + '개 키워드는 다음 자동 실행 때 이어서 처리');
      break;
    }
    var r = safeCollectKeyword_(ordered[i], runAt, track);
    newArticleCount += r.count;
    processedCount++;
    if (r.error) errorMessages.push('[' + track + '] ' + ordered[i].keyword + ': ' + r.error);
  }
  if (timeBudgetMs) {
    var nextIndex = (startIndex + processedCount) % keywords.length;
    PropertiesService.getScriptProperties().setProperty('COLLECTION_CURSOR_' + track, String(nextIndex));
  }

  return { keywordCount: processedCount, newArticleCount: newArticleCount, errorMessages: errorMessages };
}

// [정책 2026-09-04] Apps Script 시간 기반 트리거는 6분을 넘기면 강제 종료된다(2026-09-04 collectScheduled 타임아웃 사고).
// 5분(트리거 제한보다 짧게)을 예산으로 두고, 넘으면 안전하게 끊는다 — 자세한 내용은 runCollectionForTrack_ 주석 참고.
var SCHEDULED_TIME_BUDGET_MS_ = 5 * 60 * 1000;
function runCollectionScheduledForTrack_(track) {
  var runAt = new Date();
  prepareCollectionWindow_(runAt, 'scheduled'); // 자동 실행: 정확히 24시간 전 ~ 지금
  var r = runCollectionForTrack_(track, runAt, SCHEDULED_TIME_BUDGET_MS_);
  appendRunLog_({ runAt: runAt, track: track, keywordCount: r.keywordCount, newArticleCount: r.newArticleCount, errorCount: r.errorMessages.length, errorMessages: r.errorMessages });
  return r;
}
