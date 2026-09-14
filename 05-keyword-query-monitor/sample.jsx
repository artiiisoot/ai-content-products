/********************************************************
 * 라온 데이터 자동화 (통합본) - 부분 스킵도 메일 알림(옵션A) 버전
 * + NAVER errCode도 warnings로 감지하여 알림
 * + 모듈별/프로퍼티별 수동 실행 함수 복원
 *
 * ✅ 안정화 패치(2026-02-10):
 * - 트리거 환경에서도 안정적으로 동작하도록
 *   SpreadsheetApp.getActiveSpreadsheet() 사용 제거
 *   -> SpreadsheetApp.openById(SPREADSHEET_ID)로 통일
 *
 * ✅ 안정화 패치(2026-02-19):
 * - GmailApp.sendEmail -> MailApp.sendEmail 로 변경 (scope 최소화/안정화)
 * - sendAlertEmail_에서 시트 open 실패해도 메일은 발송되도록 보호
 *
 * ✅ 로그/진단 패치(2026-06-10):
 * - 실행 로그를 'run_log' 시트에 누적 저장 (flushRunLogsToSheet_)
 *   -> 메일을 안 열어도 시트에서 과거 오류 이력 조회 가능
 *   -> RUN_LOG_RETENTION_DAYS 기준으로 오래된 로그 자동 정리
 * - 메일 알림 안 오는 문제 진단 함수 추가: DIAGNOSE_ALERT_MAIL()
 * - 메일 강제 발송 테스트 함수 추가: TEST_ALERT_MAIL_FORCE()
 ********************************************************/

/***********************
 * A) 공통 설정
 ***********************/
const DAILY_HOUR = 9;         // 매일 09시대
const DAILY_MINUTE = 5;       // 09:05

// ✅ (중요) 이 스크립트가 데이터를 쓰는 "대상 스프레드시트 ID"
const SPREADSHEET_ID = "1ZlkbnBCBWs7Wirqxmhl6HE5MTrnVPXGUb0EtL3PtGDI"; // <-- 반드시 교체!

// ✅ 오류/경고 알림 메일 (Script Properties)
// - ALERT_EMAIL : 오류 알림 수신자 이메일
const ALERT_EMAIL_PROP_KEY = "ALERT_EMAIL";

// ✅ 실행 로그 시트 설정 (NEW)
const RUN_LOG_SHEET_NAME = "run_log";   // 로그 누적 시트 이름
const RUN_LOG_RETENTION_DAYS = 90;      // 이 일수보다 오래된 로그 행은 자동 삭제

function SHEETS_AUTH_TEST() {
  const id = "1ZlkbnBCBWs7Wirqxmhl6HE5MTrnVPXGUb0EtL3PtGDI";
  const ss = SpreadsheetApp.openById(id);
  Logger.log(ss.getName());
}

// ✅ 실행 로그 버퍼 (메일/시트에 포함)
let __RUN_LOGS__ = [];

// ✅ 이번 실행을 묶는 ID (run_log 시트에서 한 실행 단위로 묶어 보기 위함)
let __RUN_ID__ = "";

/***********************
 * B) 네이버 설정
 ***********************/
const NAVER_BASE_URL = "https://api.searchad.naver.com";
const NAVER_ENDPOINT = "/keywordstool";

const NAVER_KEYWORD_SHEET_NAME = "라온시큐어";
const NAVER_KEYWORD_COL = 1;        // A열
const NAVER_KEYWORD_START_ROW = 2;  // A2부터
const NAVER_LOG_SHEET_NAME = "daily_log";

const NAVER_API_CALL_SLEEP_MS = 250;
const NAVER_MAX_RETRY = 4;

// daily_log 시트에서 “수식 자동 채우기” 대상 컬럼 (I~K)
const NAVER_LOG_FORMULA_START_COL = 9;  // I
const NAVER_LOG_FORMULA_NUM_COLS  = 3;  // I,J,K

/***********************
 * C) GA4 설정
 ***********************/
const GA4_PROPERTIES = [
  { id: "421879438", name: "옴니원" },
  { id: "428215060", name: "메타데미" }, // ← 여기 끝에 쉼표 추가
  { id: "287823377", name: "라온시큐어" } // ← 이 줄 추가
];

const GA4_SHEET_NAME = "GA4_일별";
const GA4_RECENT_DAYS_TO_REFRESH = 7;
const GA4_FETCH_RANGE_DAYS = 60;

/***********************
 * D) Google Ads 설정
 ***********************/
const GADS_SHEET_NAME = "GoogleAds_All";
const GADS_RECENT_DAYS_TO_REFRESH = 7;
const GADS_INITIAL_BACKFILL_DAYS = 90;
const GOOGLE_ADS_API_VERSION = "v22";
const GADS_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

/********************************************************
 * ✅ 공통: 대상 스프레드시트 핸들 가져오기(트리거 안정화 핵심)
 ********************************************************/
function getSpreadsheet_() {
  if (!SPREADSHEET_ID || String(SPREADSHEET_ID).indexOf("여기에_") === 0) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다. 코드 상단의 SPREADSHEET_ID를 실제 시트 ID로 교체하세요.");
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/********************************************************
 * (1) 최초 1회만 실행: 매일 트리거 생성 (전체)
 ********************************************************/
function setupDailyTriggers_All() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === "runDaily_All") ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger("runDaily_All")
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_HOUR)
    .nearMinute(DAILY_MINUTE)
    .create();
}

/********************************************************
 * (2) 매일 자동 실행되는 메인 엔트리
 ********************************************************/
function runDaily_All() {
  __RUN_LOGS__ = [];
  __RUN_ID__ = newRunId_();
  log_(`✅ runDaily_All 시작: ${new Date().toISOString()}`);

  const failures = []; // {module, title, error}
  const warnings = []; // {module, title, detail}

  // NAVER
  try {
    log_("▶ NAVER 시작");
    runOnceNow_Naver__withWarnings_(warnings);
    log_("✅ NAVER 완료");
  } catch (e) {
    const err = normalizeError_(e);
    failures.push({ module: "NAVER", title: "NAVER 실행 실패", error: err });
    log_(`❌ NAVER 실패: ${err.message}`);
  }

  // GA4 (warnings 수집)
  try {
    log_("▶ GA4 시작");
    const ga4Summary = runOnceNow_GA4_All__withWarnings_(warnings);
    log_(`✅ GA4 완료 (ok=${ga4Summary.okCount}, skipped=${ga4Summary.skipCount})`);
  } catch (e) {
    const err = normalizeError_(e);
    failures.push({ module: "GA4", title: "GA4 전체 실행 실패", error: err });
    log_(`❌ GA4 실패: ${err.message}`);
  }

  // Google Ads (warnings 수집)
  try {
    log_("▶ Google Ads 시작");
    const gadsSummary = runOnceNow_GoogleAds_All__withWarnings_(warnings);
    log_(`✅ Google Ads 완료 (successCid=${gadsSummary.successCidCount}, warningCid=${gadsSummary.warningCidCount})`);
  } catch (e) {
    const err = normalizeError_(e);
    failures.push({ module: "Google Ads", title: "Google Ads 전체 실행 실패", error: err });
    log_(`❌ Google Ads 실패: ${err.message}`);
  }

  log_(`✅ runDaily_All 종료: ${new Date().toISOString()}`);

  // ✅ failures 또는 warnings 있으면 메일 발송
  if (failures.length > 0 || warnings.length > 0) {
    try {
      sendAlertEmail_(failures, warnings);
      log_("📧 오류/경고 알림 메일 발송 완료");
    } catch (mailErr) {
      const me = normalizeError_(mailErr);
      log_(`⚠️ 메일 발송 실패: ${me.message}`);
    }
  } else {
    log_("ℹ️ failures/warnings 0건 → 알림 메일 발송 조건 미충족(정상)");
  }

  // ✅ 실행 로그를 run_log 시트에 누적 (NEW)
  flushRunLogsToSheet_("runDaily_All");
}

/********************************************************
 * (3) 필요시 수동 실행 (전체 한번에)
 ********************************************************/
function runOnceNow_All() {
  runDaily_All();
}

/********************************************************
 * (4) 모듈별 “데일리처럼” 단독 실행 엔트리 (메일 알럿 포함)
 ********************************************************/
function runDaily_Naver_Only() {
  __RUN_LOGS__ = [];
  __RUN_ID__ = newRunId_();
  const failures = [];
  const warnings = [];
  log_(`✅ runDaily_Naver_Only 시작: ${new Date().toISOString()}`);
  try {
    runOnceNow_Naver__withWarnings_(warnings);
  } catch (e) {
    failures.push({ module: "NAVER", title: "NAVER 실행 실패", error: normalizeError_(e) });
  }
  log_(`✅ runDaily_Naver_Only 종료: ${new Date().toISOString()}`);
  if (failures.length || warnings.length) sendAlertEmail_(failures, warnings);
  flushRunLogsToSheet_("runDaily_Naver_Only");
}

function runDaily_GA4_Only() {
  __RUN_LOGS__ = [];
  __RUN_ID__ = newRunId_();
  const failures = [];
  const warnings = [];
  log_(`✅ runDaily_GA4_Only 시작: ${new Date().toISOString()}`);
  try {
    runOnceNow_GA4_All__withWarnings_(warnings);
  } catch (e) {
    failures.push({ module: "GA4", title: "GA4 전체 실행 실패", error: normalizeError_(e) });
  }
  log_(`✅ runDaily_GA4_Only 종료: ${new Date().toISOString()}`);
  if (failures.length || warnings.length) sendAlertEmail_(failures, warnings);
  flushRunLogsToSheet_("runDaily_GA4_Only");
}

function runDaily_GoogleAds_Only() {
  __RUN_LOGS__ = [];
  __RUN_ID__ = newRunId_();
  const failures = [];
  const warnings = [];
  log_(`✅ runDaily_GoogleAds_Only 시작: ${new Date().toISOString()}`);
  try {
    runOnceNow_GoogleAds_All__withWarnings_(warnings);
  } catch (e) {
    failures.push({ module: "Google Ads", title: "Google Ads 전체 실행 실패", error: normalizeError_(e) });
  }
  log_(`✅ runDaily_GoogleAds_Only 종료: ${new Date().toISOString()}`);
  if (failures.length || warnings.length) sendAlertEmail_(failures, warnings);
  flushRunLogsToSheet_("runDaily_GoogleAds_Only");
}

/********************************************************
 * (5) 네이버만 수동 실행 (기존 호환)
 ********************************************************/
function runOnceNow_Naver() {
  recordDailySnapshot_Naver_(); // 경고메일 없이 단순 실행
}

/********************************************************
 * (5-1) 네이버 실행 (warnings 수집 버전)
 ********************************************************/
function runOnceNow_Naver__withWarnings_(warnings) {
  recordDailySnapshot_Naver__withWarnings_(warnings);
}

/********************************************************
 * (6) GA4 실행 (warnings 수집 버전)
 ********************************************************/
function runOnceNow_GA4_All__withWarnings_(warnings) {
  const ss = getSpreadsheet_();
  const tz = ss.getSpreadsheetTimeZone();

  const sheet = getOrCreateSheet_(ss, GA4_SHEET_NAME, ["date", "active_users", "bounce_rate", "property"]);

  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date();
  start.setDate(start.getDate() - GA4_FETCH_RANGE_DAYS);

  const startDate = formatDate_(start, tz);
  const endDate = formatDate_(end, tz);

  let okCount = 0;
  let skipCount = 0;

  for (const prop of GA4_PROPERTIES) {
    try {
      const rows = fetchGa4DailyRows_(prop.id, startDate, endDate, tz);
      upsertGa4Rows_(sheet, rows, prop.name, tz);
      okCount++;
    } catch (e) {
      const err = normalizeError_(e);
      const msg = safeTrim_(err.message, 1200);
      log_(`❌ GA4 스킵: ${prop.name}(${prop.id}) -> ${safeTrim_(msg, 500)}`);

      warnings.push({
        module: "GA4",
        title: `GA4 스킵: ${prop.name}(${prop.id})`,
        detail: msg
      });

      skipCount++;
      continue;
    }
  }

  sortSheetByDate_(sheet, 1);
  return { okCount, skipCount };
}

/********************************************************
 * (6-1) GA4 프로퍼티별 단독 실행 함수
 ********************************************************/
function runOnceNow_GA4_Omnione() {
  runOnceNow_GA4_Single_("421879438", "옴니원");
}

function runOnceNow_GA4_Metademy() {
  runOnceNow_GA4_Single_("428215060", "메타데미");
}

function runOnceNow_GA4_Single_(propertyId, propertyName) {
  const ss = getSpreadsheet_();
  const tz = ss.getSpreadsheetTimeZone();
  const sheet = getOrCreateSheet_(ss, GA4_SHEET_NAME, ["date", "active_users", "bounce_rate", "property"]);

  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date();
  start.setDate(start.getDate() - GA4_FETCH_RANGE_DAYS);

  const startDate = formatDate_(start, tz);
  const endDate = formatDate_(end, tz);

  const rows = fetchGa4DailyRows_(propertyId, startDate, endDate, tz);
  upsertGa4Rows_(sheet, rows, propertyName, tz);
  sortSheetByDate_(sheet, 1);
}

/********************************************************
 * (7) Google Ads 실행 (warnings 수집 + 최근7일 안전교체)
 ********************************************************/
function runOnceNow_GoogleAds_All__withWarnings_(warnings) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  let successCidCount = 0;
  let warningCidCount = 0;

  try {
    const ss = getSpreadsheet_();
    const tz = ss.getSpreadsheetTimeZone();

    const sheet = getOrCreateSheet_(ss, GADS_SHEET_NAME, [
      "계정",
      "일",
      "캠페인 유형",
      "캠페인",
      "광고그룹",
      "기기",
      "노출수",
      "클릭수",
      "통화 코드",
      "비용"
    ]);

    const today = new Date();

    const overwriteStart = new Date(today);
    overwriteStart.setDate(overwriteStart.getDate() - (GADS_RECENT_DAYS_TO_REFRESH - 1));

    const overwriteStartStr = formatDate_(overwriteStart, tz);
    const overwriteEndStr = formatDate_(today, tz);
    const dayBeforeOverwriteStartStr = formatDate_(addDays_(overwriteStart, -1), tz);

    const customerIds = getGoogleAdsCustomerIds_();
    if (!customerIds.length) throw new Error("GADS_CUSTOMER_IDS가 비어있습니다.");

    // 위험 작업 전에 토큰 확인
    getGoogleAdsAccessToken_();

    // 1) 누적 구간 적재
    const lastDateStr = getMaxDateInSheet_Gads_(sheet, tz);

    if (lastDateStr) {
      if (compareDateStr_(lastDateStr, dayBeforeOverwriteStartStr) < 0) {
        const appendStartStr = formatDate_(addDays_(parseDateStr_(lastDateStr), 1), tz);
        const appendEndStr = dayBeforeOverwriteStartStr;

        const appendAll = [];
        for (const cid of customerIds) {
          try {
            const rows = fetchGoogleAdsRows_(cid, appendStartStr, appendEndStr);
            rows.forEach(r => appendAll.push([cid, ...r]));
          } catch (e) {
            const err = normalizeError_(e);
            const msg = safeTrim_(err.message, 1500);

            warnings.push({
              module: "Google Ads",
              title: `Google Ads 누적구간 스킵: cid=${cid}`,
              detail: msg
            });
            log_(`⚠️ Google Ads 누적구간 스킵: cid=${cid} -> ${safeTrim_(msg, 600)}`);
            warningCidCount++;
            continue;
          }
        }
        appendRows_(sheet, appendAll);
      }
    } else {
      // 최초 백필
      const backfillStart = addDays_(today, -GADS_INITIAL_BACKFILL_DAYS);
      const backfillStartStr = formatDate_(backfillStart, tz);
      const backfillEndStr = dayBeforeOverwriteStartStr;

      if (compareDateStr_(backfillStartStr, backfillEndStr) <= 0) {
        const backfillAll = [];
        for (const cid of customerIds) {
          try {
            const rows = fetchGoogleAdsRows_(cid, backfillStartStr, backfillEndStr);
            rows.forEach(r => backfillAll.push([cid, ...r]));
          } catch (e) {
            const err = normalizeError_(e);
            const msg = safeTrim_(err.message, 1500);

            warnings.push({
              module: "Google Ads",
              title: `Google Ads 백필 스킵: cid=${cid}`,
              detail: msg
            });
            log_(`⚠️ Google Ads 백필 스킵: cid=${cid} -> ${safeTrim_(msg, 600)}`);
            warningCidCount++;
            continue;
          }
        }
        appendRows_(sheet, backfillAll);
      }
    }

    // 2) 최근 7일 새 데이터 수집 → 성공했을 때만 교체
    const overwriteAll = [];

    for (const cid of customerIds) {
      try {
        const rows = fetchGoogleAdsRows_(cid, overwriteStartStr, overwriteEndStr);
        rows.forEach(r => overwriteAll.push([cid, ...r]));
        successCidCount++;
      } catch (e) {
        const err = normalizeError_(e);
        const msg = safeTrim_(err.message, 1500);

        warnings.push({
          module: "Google Ads",
          title: `Google Ads 최근7일 수집 실패: cid=${cid}`,
          detail: msg
        });
        log_(`⚠️ Google Ads 최근7일 수집 실패: cid=${cid} -> ${safeTrim_(msg, 600)}`);
        warningCidCount++;
        continue;
      }
    }

    if (successCidCount > 0 && overwriteAll.length > 0) {
      deleteRowsByDateRange_Gads_(sheet, overwriteStartStr, overwriteEndStr, tz);
      appendRows_(sheet, overwriteAll);
      log_(`✅ Google Ads 최근7일 교체 완료: 성공계정=${successCidCount}, rows=${overwriteAll.length}`);
    } else {
      const msg = `최근7일 수집 성공계정=0 또는 rows=0 → 교체 스킵(기존 데이터 유지). start=${overwriteStartStr}, end=${overwriteEndStr}`;
      warnings.push({
        module: "Google Ads",
        title: "Google Ads 최근7일 교체 스킵",
        detail: msg
      });
      log_(`⚠️ ${msg}`);
    }

    // 3) 정렬 + 포맷
    sortSheet_Gads_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 2, lastRow - 1, 1).setNumberFormat("yyyy-mm-dd");
    }

    return { successCidCount, warningCidCount };

  } finally {
    lock.releaseLock();
  }
}

/********************************************************
 *  B) 네이버 구현 (warnings 반영)
 ********************************************************/
function recordDailySnapshot_Naver__withWarnings_(warnings) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = getSpreadsheet_();
    const tz = ss.getSpreadsheetTimeZone();

    const kwSheet = ss.getSheetByName(NAVER_KEYWORD_SHEET_NAME);
    if (!kwSheet) throw new Error(`'${NAVER_KEYWORD_SHEET_NAME}' 시트를 찾을 수 없습니다.`);

    const logSheet = getOrCreateSheet_(
      ss,
      NAVER_LOG_SHEET_NAME,
      ["date", "keyword", "pc_monthly", "mo_monthly", "total", "err_code", "err_msg", "updated_at"]
    );

    const keywords = readKeywords_(kwSheet, NAVER_KEYWORD_START_ROW, NAVER_KEYWORD_COL);
    if (!keywords.length) return;

    const todayStr = formatDate_(new Date(), tz);
    const todayDate = new Date(todayStr + "T00:00:00");

    const existed = buildExistingKeySet_(logSheet, todayStr, 1, 2);

    const rowsToAppend = [];
    const nowIso = new Date().toISOString();

    let naverErrCount = 0;

    for (const kw of keywords) {
      const key = `${todayStr}||${kw}`;
      if (existed.has(key)) continue;

      const stat = fetchNaverKeywordStatWithRetry_(kw);

      if (stat.errCode) {
        naverErrCount++;
        warnings.push({
          module: "NAVER",
          title: `NAVER 키워드 조회 실패: ${kw}`,
          detail: `errCode=${stat.errCode}, errMsg=${safeTrim_(stat.errMsg || "", 800)}`
        });
        log_(`⚠️ NAVER 키워드 오류: ${kw} (code=${stat.errCode})`);
      }

      rowsToAppend.push([
        todayDate,
        kw,
        stat.pc,
        stat.mo,
        stat.total,
        stat.errCode || "",
        stat.errMsg || "",
        stat.updatedAt || nowIso
      ]);

      Utilities.sleep(NAVER_API_CALL_SLEEP_MS);
    }

    if (rowsToAppend.length) {
      logSheet.getRange(logSheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length)
        .setValues(rowsToAppend);

      logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 1).setNumberFormat("yyyy-mm-dd");
    }

    sortSheetByDate_(logSheet, 1);
    ensureNaverLogFormulas_(logSheet);

    if (naverErrCount > 0) {
      log_(`⚠️ NAVER 경고: errCode 발생 ${naverErrCount}건`);
    }

  } finally {
    lock.releaseLock();
  }
}

// 기존 단순 실행용(호환)
function recordDailySnapshot_Naver_() {
  const dummyWarnings = [];
  recordDailySnapshot_Naver__withWarnings_(dummyWarnings);
}

function ensureNaverLogFormulas_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const needCols = NAVER_LOG_FORMULA_START_COL + NAVER_LOG_FORMULA_NUM_COLS - 1;
  const curCols = sheet.getLastColumn();
  if (curCols < needCols) {
    sheet.insertColumnsAfter(curCols, needCols - curCols);
  }

  const baseRange = sheet.getRange(2, NAVER_LOG_FORMULA_START_COL, 1, NAVER_LOG_FORMULA_NUM_COLS);
  const baseFormulasR1C1 = baseRange.getFormulasR1C1()[0];

  const hasAnyFormula = baseFormulasR1C1.some(f => f && String(f).trim());
  if (!hasAnyFormula) return;

  const targetRange = sheet.getRange(2, NAVER_LOG_FORMULA_START_COL, lastRow - 1, NAVER_LOG_FORMULA_NUM_COLS);

  const fill = [];
  for (let r = 0; r < lastRow - 1; r++) fill.push(baseFormulasR1C1);
  targetRange.setFormulasR1C1(fill);
}

function fetchNaverKeywordStatWithRetry_(keyword) {
  for (let attempt = 0; attempt <= NAVER_MAX_RETRY; attempt++) {
    const res = fetchNaverKeywordStatOnce_(keyword);

    if (!res.errCode) return res;

    if (res.errCode === 429 && attempt < NAVER_MAX_RETRY) {
      const backoff = Math.min(8000, 800 * Math.pow(2, attempt));
      Utilities.sleep(backoff);
      continue;
    }

    return res;
  }

  return {
    pc: "",
    mo: "",
    total: "",
    updatedAt: new Date().toISOString(),
    errCode: 429,
    errMsg: "Too Many Requests (max retry exceeded)"
  };
}

function fetchNaverKeywordStatOnce_(keyword) {
  if (!keyword) return { pc: "", mo: "", total: "", updatedAt: new Date().toISOString() };

  const cache = CacheService.getScriptCache();
  const cacheKey = `NAVER_KWSTAT::${keyword}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    const obj = JSON.parse(cached);
    return { ...obj, updatedAt: new Date().toISOString() };
  }

  const customerId = getProp_("NAVER_CUSTOMER_ID");
  const accessLicense = getProp_("NAVER_ACCESS_LICENSE");
  const secretKey = getProp_("NAVER_SECRET_KEY");

  const query = `hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;
  const url = `${NAVER_BASE_URL}${NAVER_ENDPOINT}?${query}`;

  const method = "GET";
  const timestamp = Date.now().toString();
  const signature = makeNaverSignature_(timestamp, method, NAVER_ENDPOINT, secretKey);

  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": timestamp,
    "X-API-KEY": accessLicense,
    "X-Customer": customerId,
    "X-Signature": signature
  };

  const resp = UrlFetchApp.fetch(url, {
    method,
    headers,
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();

  if (code !== 200) {
    return {
      pc: "",
      mo: "",
      total: "",
      updatedAt: new Date().toISOString(),
      errCode: code,
      errMsg: safeTrim_(text, 200)
    };
  }

  const json = JSON.parse(text);
  const list = json.keywordList || json || [];
  const row = list.find(r => (r.relKeyword || r.keyword) === keyword) || list[0];

  if (!row) {
    return {
      pc: "",
      mo: "",
      total: "",
      updatedAt: new Date().toISOString(),
      errCode: 204,
      errMsg: "No keyword row"
    };
  }

  const pc = toNumber_(row.monthlyPcQcCnt ?? row.monthlyPcCnt ?? row.pcCnt);
  const mo = toNumber_(row.monthlyMobileQcCnt ?? row.monthlyMobileCnt ?? row.mobileCnt);
  const total = (pc || 0) + (mo || 0);

  const out = { pc, mo, total };
  cache.put(cacheKey, JSON.stringify(out), 600);

  return { ...out, updatedAt: new Date().toISOString() };
}

function makeNaverSignature_(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  const rawSig = Utilities.computeHmacSha256Signature(message, secretKey);
  return Utilities.base64Encode(rawSig);
}

/********************************************************
 *  C) GA4 구현 (UrlFetch)
 ********************************************************/
function fetchGa4DailyRows_(propertyId, startDate, endDate, tz) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${String(propertyId)}:runReport`;
  const token = ScriptApp.getOAuthToken();

  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "activeUsers" }, { name: "bounceRate" }]
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code !== 200) {
    throw new Error(`GA4 API Error ${code}: ${text}`);
  }

  const json = JSON.parse(text);
  const rows = json.rows || [];

  return rows.map(r => {
    const yyyymmdd = String(r.dimensionValues[0].value || "");
    const dateStr = formatGa4Date_(yyyymmdd);
    const dateObj = new Date(dateStr + "T00:00:00");

    const activeUsers = Number(r.metricValues[0].value);
    const bounceRate = Number(r.metricValues[1].value);

    return [dateObj, activeUsers, bounceRate];
  });
}

function upsertGa4Rows_(sheet, rows, propName, tz) {
  if (!rows || !rows.length) return;

  const lastRow = sheet.getLastRow();
  const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 4).getValues() : [];

  const map = new Map();
  for (const r of existing) {
    const d = r[0];
    const dStr = d instanceof Date ? formatDate_(d, tz) : String(d).slice(0, 10);
    const key = `${dStr}||${r[3]}`;
    map.set(key, r);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - GA4_RECENT_DAYS_TO_REFRESH);

  for (const r of rows) {
    const dObj = r[0];
    const dStr = formatDate_(dObj, tz);
    const key = `${dStr}||${propName}`;

    if (dObj >= cutoff || !map.has(key)) {
      map.set(key, [dObj, r[1], r[2], propName]);
    }
  }

  const output = Array.from(map.values());
  if (output.length) {
    sheet.getRange(2, 1, output.length, 4).setValues(output);
    sheet.getRange(2, 1, output.length, 1).setNumberFormat("yyyy-mm-dd");
    sheet.getRange(2, 3, output.length, 1).setNumberFormat("0.00%");
  }
}

/********************************************************
 *  D) Google Ads 구현 (REST/GAQL)
 ********************************************************/
function fetchGoogleAdsRows_(customerId, startDateStr, endDateStr) {
  const accessToken = getGoogleAdsAccessToken_();
  const url = `${GADS_API_BASE}/customers/${customerId}/googleAds:searchStream`;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": getProp_("GADS_DEVELOPER_TOKEN"),
    "Content-Type": "application/json"
  };

  const loginCustomerId = getPropOptional_("GADS_LOGIN_CUSTOMER_ID");
  if (loginCustomerId) headers["login-customer-id"] = String(loginCustomerId).trim();

  const gaqlAdGroup = `
    SELECT
      segments.date,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.name,
      ad_group.name,
      segments.device,
      metrics.impressions,
      metrics.clicks,
      customer.currency_code,
      metrics.cost_micros
    FROM ad_group
    WHERE segments.date BETWEEN '${startDateStr}' AND '${endDateStr}'
  `;

  const rows = [];
  rows.push(...fetchGoogleAdsSearchStream_(url, headers, gaqlAdGroup, null));

  const gaqlPmax = `
    SELECT
      segments.date,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.name,
      segments.device,
      metrics.impressions,
      metrics.clicks,
      customer.currency_code,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${startDateStr}' AND '${endDateStr}'
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
  `;
  rows.push(...fetchGoogleAdsSearchStream_(url, headers, gaqlPmax, "(none)"));

  return rows;
}

function fetchGoogleAdsSearchStream_(url, headers, gaql, forceAdGroupName) {
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    headers,
    payload: JSON.stringify({ query: gaql.trim() }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`[Google Ads API Error] HTTP ${code}: ${safeTrim_(body, 800)}`);
  }

  const chunks = JSON.parse(body);
  const out = [];

  for (const chunk of chunks) {
    const results = (chunk && chunk.results) ? chunk.results : [];
    for (const r of results) {
      const dateStr = r.segments?.date || "";
      const channelType = r.campaign?.advertisingChannelType || "";
      const channelSubType = r.campaign?.advertisingChannelSubType || "";
      const campaignType = buildCampaignType_(channelType, channelSubType);

      const campaignName = r.campaign?.name || "";
      const adGroupName = (forceAdGroupName !== null && forceAdGroupName !== undefined)
        ? String(forceAdGroupName)
        : (r.adGroup?.name || "");

      const device = r.segments?.device || "";

      const impressions = safeInt_(r.metrics?.impressions);
      const clicks = safeInt_(r.metrics?.clicks);
      const currencyCode = r.customer?.currencyCode || "";

      const costMicros = safeFloat_(r.metrics?.costMicros);
      const cost = costMicros / 1000000;

      out.push([
        dateStr,
        campaignType,
        campaignName,
        adGroupName,
        device,
        impressions,
        clicks,
        currencyCode,
        cost
      ]);
    }
  }

  return out;
}

function getGoogleAdsAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("GADS_ACCESS_TOKEN");
  if (cached) return cached;

  const payload = {
    client_id: getProp_("GADS_OAUTH_CLIENT_ID"),
    client_secret: getProp_("GADS_OAUTH_CLIENT_SECRET"),
    refresh_token: getProp_("GADS_OAUTH_REFRESH_TOKEN"),
    grant_type: "refresh_token"
  };

  const res = UrlFetchApp.fetch(GADS_TOKEN_ENDPOINT, {
    method: "post",
    payload,
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code < 200 || code >= 300) {
    if (body && String(body).indexOf("invalid_grant") >= 0) {
      clearGoogleAdsTokenCache_();
      throw new Error(
        `[OAuth Token Error] invalid_grant (refresh_token 만료/취소/불일치)\n` +
        `- Script Properties의 GADS_OAUTH_REFRESH_TOKEN 재발급 후 교체 필요\n` +
        `원문: ${safeTrim_(body, 500)}`
      );
    }
    throw new Error(`[OAuth Token Error] HTTP ${code}: ${safeTrim_(body, 500)}`);
  }

  const json = JSON.parse(body);
  const token = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);

  cache.put("GADS_ACCESS_TOKEN", token, Math.max(60, expiresIn - 60));
  return token;
}

function clearGoogleAdsTokenCache_() {
  try { CacheService.getScriptCache().remove("GADS_ACCESS_TOKEN"); } catch (e) {}
}

function getGoogleAdsCustomerIds_() {
  const raw = getProp_("GADS_CUSTOMER_IDS");
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

function buildCampaignType_(channelType, channelSubType) {
  if (channelSubType && channelSubType !== "UNSPECIFIED") return `${channelType} (${channelSubType})`;
  return channelType;
}

function getMaxDateInSheet_Gads_(sheet, tz) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return "";

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  let max = "";

  for (const v of values) {
    const s = (v instanceof Date) ? formatDate_(v, tz) : String(v || "").slice(0, 10).trim();
    if (!s) continue;
    if (!max || compareDateStr_(s, max) > 0) max = s;
  }
  return max;
}

function deleteRowsByDateRange_Gads_(sheet, startDateStr, endDateStr, tz) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const dates = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  const rowsToDelete = [];

  for (let i = 0; i < dates.length; i++) {
    const rowIndex = i + 2;
    const s = (dates[i] instanceof Date) ? formatDate_(dates[i], tz) : String(dates[i] || "").slice(0, 10).trim();
    if (!s) continue;

    if (compareDateStr_(s, startDateStr) >= 0 && compareDateStr_(s, endDateStr) <= 0) {
      rowsToDelete.push(rowIndex);
    }
  }

  rowsToDelete.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
}

function sortSheet_Gads_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 2) return;

  sheet.getRange(2, 1, lastRow - 1, lastCol).sort([
    { column: 2, ascending: true },
    { column: 1, ascending: true },
    { column: 4, ascending: true },
    { column: 5, ascending: true },
    { column: 6, ascending: true }
  ]);
}

/********************************************************
 *  E) 메일 알림 유틸 (failures + warnings)
 ********************************************************/
function sendAlertEmail_(failures, warnings) {
  const to = getAlertEmail_();
  if (!to) {
    log_("⚠️ ALERT_EMAIL 미설정 및 사용자 이메일 조회 불가 → 메일 발송 스킵");
    return;
  }

  // ✅ 시트 open이 실패해도 메일은 보내기 (권한 꼬임 시에도 알림 유지)
  let ssName = "(Spreadsheet open failed)";
  let ssUrl = "(Spreadsheet open failed)";
  try {
    const ss = getSpreadsheet_();
    ssName = ss.getName();
    ssUrl = ss.getUrl();
  } catch (e) {}

  const projectUrl = `https://script.google.com/home/projects/${ScriptApp.getScriptId()}/edit`;

  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const subject = `[라온 자동화 알림] ${Utilities.formatDate(now, tz, "yyyy-MM-dd HH:mm:ss")} (fail=${failures.length}, warn=${warnings.length})`;

  const lines = [];
  lines.push(`자동화 실행 중 이슈가 감지되었습니다. (fail=${failures.length}, warn=${warnings.length})`);
  lines.push(``);
  lines.push(`- 시트: ${ssName}`);
  lines.push(`- 시트 URL: ${ssUrl}`);
  lines.push(`- 스크립트: ${projectUrl}`);
  lines.push(`- 실행 시각: ${now.toISOString()}`);
  lines.push(``);

  if (failures.length) {
    lines.push(`==============================`);
    lines.push(`[FAILURES] (전체 작업 중단/치명)`);
    lines.push(`==============================`);
    failures.forEach((f, idx) => {
      lines.push(`${idx + 1}) [${f.module}] ${f.title}`);
      lines.push(`   - message: ${safeTrim_(f.error.message, 3000)}`);
      if (f.error.stack) {
        lines.push(`   - stack:`);
        lines.push(indent_(safeTrim_(f.error.stack, 6000), "     "));
      }
      lines.push(``);
    });
  }

  if (warnings.length) {
    lines.push(`==============================`);
    lines.push(`[WARNINGS] (부분 스킵/부분 실패)`);
    lines.push(`==============================`);
    warnings.forEach((w, idx) => {
      lines.push(`${idx + 1}) [${w.module}] ${w.title}`);
      lines.push(`   - detail: ${safeTrim_(w.detail, 4000)}`);
      lines.push(``);
    });
  }

  lines.push(`==============================`);
  lines.push(`[RUN LOGS] (최근 ${Math.min(__RUN_LOGS__.length, 300)}줄)`);
  lines.push(`==============================`);
  const logTail = __RUN_LOGS__.slice(-300);
  lines.push(logTail.join("\n"));

  // ✅ GmailApp -> MailApp (manifest의 script.send_mail과 정합)
  MailApp.sendEmail(to, subject, lines.join("\n"));
}

function getAlertEmail_() {
  const prop = PropertiesService.getScriptProperties().getProperty(ALERT_EMAIL_PROP_KEY);
  if (prop && String(prop).trim()) return String(prop).trim();

  try {
    const e = Session.getEffectiveUser().getEmail();
    if (e && String(e).trim()) return String(e).trim();
  } catch (e) {}

  return "";
}

function normalizeError_(e) {
  if (!e) return { message: "Unknown error", stack: "" };
  if (typeof e === "string") return { message: e, stack: "" };
  const msg = e.message ? String(e.message) : String(e);
  const stack = e.stack ? String(e.stack) : "";
  return { message: msg, stack };
}

function indent_(text, prefix) {
  return String(text).split("\n").map(line => prefix + line).join("\n");
}

function log_(msg) {
  const s = `[${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")}] ${msg}`;
  __RUN_LOGS__.push(s);
  Logger.log(s);
}

/********************************************************
 *  E-2) 실행 로그 시트 누적 (NEW)
 *  - 매 실행 끝에 __RUN_LOGS__를 run_log 시트에 append
 *  - 컬럼: [logged_at, run_id, entry_func, level, message]
 *  - level은 메시지의 ❌/⚠️/📧/▶/✅ 이모지로 자동 판정
 ********************************************************/
function flushRunLogsToSheet_(entryFuncName) {
  try {
    if (!__RUN_LOGS__ || __RUN_LOGS__.length === 0) return;

    const ss = getSpreadsheet_();
    const sheet = getOrCreateSheet_(
      ss,
      RUN_LOG_SHEET_NAME,
      ["logged_at", "run_id", "entry_func", "level", "message"]
    );

    const now = new Date();
    const runId = __RUN_ID__ || newRunId_();

    const rows = __RUN_LOGS__.map(line => {
      const level = detectLogLevel_(line);
      return [now, runId, String(entryFuncName || ""), level, String(line)];
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    // logged_at 컬럼 날짜시간 포맷
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    }

    // 오래된 로그 자동 정리
    cleanupOldRunLogs_(sheet);

  } catch (e) {
    // 로그 시트 기록 실패는 본 작업에 영향 주지 않도록 무시(콘솔에만 남김)
    Logger.log("⚠️ flushRunLogsToSheet_ 실패: " + (e && e.message ? e.message : e));
  }
}

function detectLogLevel_(line) {
  const s = String(line || "");
  if (s.indexOf("❌") >= 0) return "ERROR";
  if (s.indexOf("⚠️") >= 0) return "WARN";
  return "INFO";
}

function cleanupOldRunLogs_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RUN_LOG_RETENTION_DAYS);

  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const rowsToDelete = [];

  for (let i = 0; i < dates.length; i++) {
    const rowIndex = i + 2;
    const v = dates[i];
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) continue;
    if (d < cutoff) rowsToDelete.push(rowIndex);
  }

  rowsToDelete.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
}

function newRunId_() {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(), tz, "yyyyMMdd_HHmmss") + "_" + Math.floor(Math.random() * 1000);
}

/********************************************************
 *  E-3) 메일 알림 진단 (NEW)
 *  - 메일이 안 오는 원인을 한 번에 점검
 *  - 결과는 Logger + run_log 시트에 모두 남김
 ********************************************************/
function DIAGNOSE_ALERT_MAIL() {
  __RUN_LOGS__ = [];
  __RUN_ID__ = newRunId_();

  log_("===== 메일 알림 진단 시작 =====");

  // 1) ALERT_EMAIL 프로퍼티
  let propEmail = "";
  try {
    propEmail = PropertiesService.getScriptProperties().getProperty(ALERT_EMAIL_PROP_KEY) || "";
  } catch (e) {
    log_(`❌ Script Properties 조회 실패: ${normalizeError_(e).message}`);
  }
  log_(`1) ALERT_EMAIL(Script Property) = "${propEmail}" ${propEmail ? "" : "→ ⚠️ 비어있음"}`);

  // 2) effectiveUser / activeUser 이메일
  let effEmail = "";
  let actEmail = "";
  try { effEmail = Session.getEffectiveUser().getEmail() || ""; } catch (e) {}
  try { actEmail = Session.getActiveUser().getEmail() || ""; } catch (e) {}
  log_(`2) effectiveUser email = "${effEmail}" / activeUser email = "${actEmail}"`);
  log_(`   ※ 트리거 환경에서는 위 두 값이 빈 문자열로 잡힐 수 있음 → 이 경우 ALERT_EMAIL 필수`);

  // 3) 최종 수신자(to)
  const to = getAlertEmail_();
  if (to) {
    log_(`3) 최종 수신자(to) = "${to}" → ✅ 수신자 확보됨`);
  } else {
    log_(`3) 최종 수신자(to) = (빈 값) → ❌ 수신자 없음 → 메일이 무조건 스킵됨`);
    log_(`   해결: Script Properties에 ALERT_EMAIL 키로 본인 이메일을 등록하세요.`);
  }

  // 4) MailApp 남은 일일 쿼터
  let quota = -1;
  try {
    quota = MailApp.getRemainingDailyQuota();
    log_(`4) MailApp 남은 일일 쿼터 = ${quota} ${quota <= 0 ? "→ ❌ 쿼터 소진(메일 발송 불가)" : "→ ✅ 발송 가능"}`);
  } catch (e) {
    log_(`4) ❌ MailApp 쿼터 조회 실패: ${normalizeError_(e).message} (권한 미승인 가능성)`);
  }

  // 5) 트리거 점검 (runDaily_All 시간 기반 트리거 존재 여부)
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const dailyAll = triggers.filter(t => t.getHandlerFunction() === "runDaily_All");
    if (dailyAll.length > 0) {
      log_(`5) runDaily_All 트리거 = ${dailyAll.length}개 존재 → ✅ 자동 실행 설정됨`);
    } else {
      log_(`5) runDaily_All 트리거 = 0개 → ⚠️ 자동 실행 트리거 없음 (setupDailyTriggers_All 실행 필요)`);
    }
    log_(`   전체 트리거 ${triggers.length}개: ${triggers.map(t => t.getHandlerFunction()).join(", ") || "(없음)"}`);
  } catch (e) {
    log_(`5) ❌ 트리거 조회 실패: ${normalizeError_(e).message}`);
  }

  // 6) 스프레드시트 접근 점검
  try {
    const ss = getSpreadsheet_();
    log_(`6) 스프레드시트 접근 = ✅ "${ss.getName()}"`);
  } catch (e) {
    log_(`6) ❌ 스프레드시트 접근 실패: ${normalizeError_(e).message}`);
  }

  log_("===== 메일 알림 진단 종료 =====");

  // 진단 결과를 run_log 시트에도 남김
  flushRunLogsToSheet_("DIAGNOSE_ALERT_MAIL");

  // 실행 로그 확인 안내 (편집기 실행 로그에도 그대로 출력됨)
  Logger.log("진단 결과는 Apps Script '실행 로그' 또는 스프레드시트 'run_log' 시트에서 확인하세요.");
}

/********************************************************
 *  E-4) 메일 강제 발송 테스트 (NEW)
 *  - 가짜 failures/warnings 를 만들어 실제 발송 경로 그대로 테스트
 *  - 메일이 오면: 발송 경로 정상 / 평소 안 온 건 "오류가 없어서" 였을 확률 높음
 *  - 메일이 안 오면: 수신자/권한/쿼터 문제 → DIAGNOSE_ALERT_MAIL() 결과 확인
 ********************************************************/
function TEST_ALERT_MAIL_FORCE() {
  __RUN_LOGS__ = [];
  __RUN_ID__ = newRunId_();

  log_("✅ TEST_ALERT_MAIL_FORCE 시작 (강제 알림 발송 테스트)");

  const to = getAlertEmail_();
  if (!to) {
    log_("❌ 수신자(to) 없음 → 메일 발송 불가. Script Properties의 ALERT_EMAIL을 먼저 설정하세요.");
    flushRunLogsToSheet_("TEST_ALERT_MAIL_FORCE");
    return;
  }
  log_(`수신자(to) = "${to}"`);

  const fakeFailures = [{
    module: "TEST",
    title: "강제 발송 테스트 - FAILURE 샘플",
    error: { message: "이 메일이 도착하면 메일 발송 경로는 정상입니다.", stack: "" }
  }];

  const fakeWarnings = [{
    module: "TEST",
    title: "강제 발송 테스트 - WARNING 샘플",
    detail: "warnings 경로도 정상적으로 메일에 포함됩니다."
  }];

  try {
    sendAlertEmail_(fakeFailures, fakeWarnings);
    log_("📧 테스트 메일 발송 호출 완료 → 수신함을 확인하세요.");
  } catch (e) {
    log_(`❌ 테스트 메일 발송 실패: ${normalizeError_(e).message}`);
  }

  flushRunLogsToSheet_("TEST_ALERT_MAIL_FORCE");
}

/********************************************************
 *  F) 공통 유틸 (원본 그대로)
 ********************************************************/
function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`스크립트 속성에 ${key}가 없습니다.`);
  return v;
}

function getPropOptional_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? String(v).trim() : "";
}

function toNumber_(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return v;
  const s = String(v).replace(/[^\d.]/g, "");
  return s ? Number(s) : "";
}

function safeTrim_(s, n) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

function formatDate_(d, tz) {
  return Utilities.formatDate(d, tz, "yyyy-MM-dd");
}

function formatGa4Date_(yyyymmdd) {
  const s = String(yyyymmdd || "");
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function readKeywords_(sheet, startRow, col) {
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];

  const values = sheet.getRange(startRow, col, lastRow - startRow + 1, 1)
    .getValues()
    .map(r => (r[0] ?? "").toString().trim());

  const uniq = [];
  const seen = new Set();
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    uniq.push(v);
  }
  return uniq;
}

function getOrCreateSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else {
    const existingHeader = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    const isHeaderEmpty = existingHeader.every(v => !v);
    if (isHeaderEmpty) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function buildExistingKeySet_(sheet, dateStr, dateColIndex1Based, keywordColIndex1Based) {
  const set = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return set;

  const numCols = Math.max(dateColIndex1Based, keywordColIndex1Based);
  const vals = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  for (const r of vals) {
    const d = r[dateColIndex1Based - 1];
    const k = r[keywordColIndex1Based - 1];
    if (!d || !k) continue;

    const dStr = d instanceof Date
      ? Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd")
      : String(d).slice(0, 10);

    const kStr = String(k).trim();
    if (dStr === dateStr) set.add(`${dateStr}||${kStr}`);
  }
  return set;
}

function sortSheetByDate_(sheet, dateColumnIndex1Based) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return;
  sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
    .sort({ column: dateColumnIndex1Based, ascending: true });
}

function addDays_(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDateStr_(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function compareDateStr_(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function appendRows_(sheet, rows) {
  if (!rows || rows.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function safeInt_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function safeFloat_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function TEST_SEND_MAIL_NOW() {
  const to = PropertiesService.getScriptProperties().getProperty("ALERT_EMAIL") || "";
  if (!to) {
    Logger.log("❌ ALERT_EMAIL 미설정 → 발송 스킵. Script Properties에 ALERT_EMAIL을 먼저 등록하세요.");
    return;
  }
  MailApp.sendEmail(to, "[TEST] MailApp 발송 테스트", "이 메일이 오면 MailApp은 정상입니다.\n\n시간: " + new Date().toISOString());
  Logger.log("sent to=" + to);
}