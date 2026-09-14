/********************************************************
 * 데일리 키워드 쿼리량 모니터링
 * 기준 문서: ../SPEC.md, ../PLAN.md
 *
 * sample.jsx(통합 스크립트)의 네이버 수집 로직을 참고했지만
 * GA4 / Google Ads / 월간 키워드 모듈은 포함하지 않습니다.
 *
 * sample.jsx 리뷰에서 발견된 두 가지 함정을 여기서는 피합니다:
 * 1) "< 10" 같은 표시제한 값을 숫자로 오인식하지 않음 (parseQcCnt_)
 * 2) 응답에 요청 키워드와 정확히 일치하는 행이 없을 때 다른 행으로 대체하지 않음
 ********************************************************/

/***********************
 * 설정
 ***********************/
const SPREADSHEET_ID = "1f8Y8URD-kK-_R07Ni9WwxmexUTHjjeg_NPdYsExqFtc"; // 반드시 교체

const KEYWORD_SHEET_NAME = "키워드";
const QUERY_SHEET_NAME = "쿼리량";

const DEFAULT_KEYWORDS = [
  "라온시큐어", "라온그룹", "라온", "라온메타",
  "라온메타데미", "옴니원", "옴니원NFT", "메타데미"
];

const DAILY_HOUR = 9; // 매일 09시대 실행

// Apps Script 실행 제한(개인 계정 6분)에 걸리기 전에 스스로 멈춘다.
// 키워드가 많아서 한 번에 다 못 끝내면, 아래에서 CHAIN_RETRY_DELAY_MS 뒤 자기 자신을
// 1회성 트리거로 다시 불러 이어간다 — 평소(114개 규모)엔 한 번에 끝나서 체인이 안 걸린다.
const SOFT_TIME_LIMIT_MS = 5 * 60 * 1000;
const CHAIN_RETRY_DELAY_MS = 60 * 1000;

const NAVER_BASE_URL = "https://api.searchad.naver.com";
const NAVER_ENDPOINT = "/keywordstool";
const NAVER_API_CALL_SLEEP_MS = 250;
const NAVER_MAX_RETRY = 4;
// ⚠️ 인증키는 여기 하드코딩하지 않는다. Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성에
//    NAVER_CUSTOMER_ID / NAVER_ACCESS_LICENSE / NAVER_SECRET_KEY 로 등록할 것 (getProp_가 읽음).

/***********************
 * 시트를 열 때마다 수동 실행 메뉴 생성
 ***********************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("키워드 쿼리량")
    .addItem("지금 수집하기 (수동 실행)", "runDaily")
    .addToUi();
}

/***********************
 * 설치 (최초 1회)
 ***********************/
function setup() {
  const ss = getSpreadsheet_();
  const kwSheet = getOrCreateSheet_(ss, KEYWORD_SHEET_NAME, ["사용여부", "키워드"]);
  seedDefaultKeywords_(kwSheet);
  getOrCreateSheet_(ss, QUERY_SHEET_NAME, [
    "수집일", "키워드", "PC 검색량", "모바일 검색량", "합계 검색량",
    "표시제한여부", "오류내용", "수집시각"
  ]);
  setupDailyTrigger_();
}

function seedDefaultKeywords_(sheet) {
  if (sheet.getLastRow() >= 2) return; // 이미 데이터가 있으면 건드리지 않음
  const rows = DEFAULT_KEYWORDS.map(kw => ["Y", kw]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function setupDailyTrigger_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "runDaily") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runDaily")
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_HOUR)
    .create();
}

/***********************
 * 매일 자동 실행되는 메인 함수
 ***********************/
function runDaily() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = getSpreadsheet_();
    const tz = ss.getSpreadsheetTimeZone();

    const kwSheet = ss.getSheetByName(KEYWORD_SHEET_NAME);
    if (!kwSheet) throw new Error(`'${KEYWORD_SHEET_NAME}' 시트를 찾을 수 없습니다. setup()을 먼저 실행하세요.`);

    const querySheet = getOrCreateSheet_(ss, QUERY_SHEET_NAME, [
      "수집일", "키워드", "PC 검색량", "모바일 검색량", "합계 검색량",
      "표시제한여부", "오류내용", "수집시각"
    ]);

    const keywords = readActiveKeywords_(kwSheet);
    if (!keywords.length) return;

    const todayStr = formatDate_(new Date(), tz);
    const todayDate = new Date(todayStr + "T00:00:00");
    const existed = buildExistingKeySet_(querySheet, todayStr);
    const now = new Date();

    // ⚠️ 키워드마다 바로 그 행을 써서(끝에 몰아쓰지 않음) 실행이 타임아웃/오류로
    //    중간에 죽어도 그때까지 수집한 결과는 남는다. 재실행하면 이어서(중복 스킵) 진행된다.
    const startedAt = Date.now();
    let writtenCount = 0;
    let timedOut = false;

    for (const kw of keywords) {
      if (Date.now() - startedAt > SOFT_TIME_LIMIT_MS) {
        timedOut = true;
        break; // 남은 키워드는 아래에서 예약하는 체인 트리거가 이어서 처리한다.
      }
      if (existed.has(kw)) continue;

      const stat = fetchNaverKeywordStatWithRetry_(kw);
      const row = [
        todayDate,
        kw,
        stat.pc.value,
        stat.mo.value,
        stat.total,
        (stat.pc.isLimited || stat.mo.isLimited) ? "Y" : "",
        stat.errorMsg || "",
        now
      ];

      const targetRow = querySheet.getLastRow() + 1;
      querySheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
      querySheet.getRange(targetRow, 1, 1, 1).setNumberFormat("yyyy-mm-dd");
      querySheet.getRange(targetRow, 8, 1, 1).setNumberFormat("yyyy-mm-dd");
      writtenCount++;

      Utilities.sleep(NAVER_API_CALL_SLEEP_MS);
    }

    if (writtenCount) {
      sortSheetByDate_(querySheet, 1);
    }
    if (timedOut) {
      ScriptApp.newTrigger("runDaily").timeBased().after(CHAIN_RETRY_DELAY_MS).create();
      Logger.log(`⏱ 시간 예산(${SOFT_TIME_LIMIT_MS / 1000}초) 초과로 조기 종료. 이번 실행에 ${writtenCount}건 기록, ${CHAIN_RETRY_DELAY_MS / 1000}초 뒤 이어서 실행.`);
    }
  } finally {
    lock.releaseLock();
  }
}

function readActiveKeywords_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const uniq = [];
  const seen = new Set();

  for (const [enabled, kwRaw] of values) {
    const kw = String(kwRaw || "").trim();
    if (!kw || seen.has(kw)) continue;
    if (String(enabled).trim().toUpperCase() !== "Y") continue;
    seen.add(kw);
    uniq.push(kw);
  }
  return uniq;
}

function buildExistingKeySet_(sheet, todayStr) {
  const set = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return set;

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (const [d, kw] of values) {
    if (!d || !kw) continue;
    const dStr = d instanceof Date ? formatDate_(d, Session.getScriptTimeZone()) : String(d).slice(0, 10);
    if (dStr === todayStr) set.add(String(kw).trim());
  }
  return set;
}

/***********************
 * 네이버 검색광고 API
 ***********************/
function fetchNaverKeywordStatWithRetry_(keyword) {
  for (let attempt = 0; attempt <= NAVER_MAX_RETRY; attempt++) {
    const res = fetchNaverKeywordStat_(keyword);

    if (!res.errorMsg) return res;
    if (res.retryable && attempt < NAVER_MAX_RETRY) {
      Utilities.sleep(Math.min(8000, 800 * Math.pow(2, attempt)));
      continue;
    }
    return res;
  }
}

function fetchNaverKeywordStat_(keyword) {
  const empty = { value: "", isLimited: false };

  const customerId = getProp_("NAVER_CUSTOMER_ID");
  const accessLicense = getProp_("NAVER_ACCESS_LICENSE");
  const secretKey = getProp_("NAVER_SECRET_KEY");

  // 네이버 검색광고 API는 hintKeywords에 띄어쓰기를 허용하지 않는다.
  // 시트에는 원래 표기(공백 포함)를 그대로 두고, API로 보낼 때만 공백을 제거한다.
  const apiKeyword = keyword.replace(/\s+/g, "");
  const query = `hintKeywords=${encodeURIComponent(apiKeyword)}&showDetail=1`;
  const url = `${NAVER_BASE_URL}${NAVER_ENDPOINT}?${query}`;
  const timestamp = Date.now().toString();
  const method = "GET";
  const signature = makeNaverSignature_(timestamp, method, NAVER_ENDPOINT, secretKey);

  const resp = UrlFetchApp.fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Timestamp": timestamp,
      "X-API-KEY": accessLicense,
      "X-Customer": customerId,
      "X-Signature": signature
    },
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();

  if (code !== 200) {
    return {
      pc: empty, mo: empty, total: "",
      errorMsg: `HTTP ${code}: ${safeTrim_(text, 300)}`,
      retryable: code === 429
    };
  }

  const json = JSON.parse(text);
  const list = json.keywordList || [];
  // ⚠️ 정확히 일치하는 행만 사용. 없으면 임의 대체(list[0]) 없이 오류로 처리한다.
  // (네이버 응답도 공백 없는 형태로 오므로 apiKeyword와 비교한다.)
  const row = list.find(r => (r.relKeyword || r.keyword) === apiKeyword);

  if (!row) {
    return {
      pc: empty, mo: empty, total: "",
      errorMsg: "요청 키워드와 정확히 일치하는 결과 없음 (미색인 또는 연관검색어만 반환됨)",
      retryable: false
    };
  }

  const pc = parseQcCnt_(row.monthlyPcQcCnt);
  const mo = parseQcCnt_(row.monthlyMobileQcCnt);
  const total = (pc.isLimited || mo.isLimited || pc.value === "" || mo.value === "")
    ? ""
    : pc.value + mo.value;

  return { pc, mo, total, errorMsg: "", retryable: false };
}

function makeNaverSignature_(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  const rawSig = Utilities.computeHmacSha256Signature(message, secretKey);
  return Utilities.base64Encode(rawSig);
}

/**
 * 네이버 응답 값을 숫자/표시제한/빈값으로 구분한다.
 * - 숫자: {value: number, isLimited: false}
 * - "< 10" 같은 표시제한 값: 원문 문자열 그대로 보존, isLimited: true (10으로 반올림하지 않음)
 * - 빈값/알 수 없는 형식: value 원문 보존, isLimited: true
 */
function parseQcCnt_(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: "", isLimited: false };
  if (typeof raw === "number") return { value: raw, isLimited: false };

  const s = String(raw).trim();
  if (/^<\s*\d+/.test(s)) return { value: s, isLimited: true };

  const n = Number(s.replace(/,/g, ""));
  if (Number.isFinite(n)) return { value: n, isLimited: false };

  return { value: s, isLimited: true };
}

/***********************
 * 공통 유틸
 ***********************/
function getSpreadsheet_() {
  if (!SPREADSHEET_ID || String(SPREADSHEET_ID).indexOf("여기에_") === 0) {
    throw new Error("SPREADSHEET_ID가 설정되지 않았습니다. 코드 상단의 SPREADSHEET_ID를 실제 시트 ID로 교체하세요.");
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`스크립트 속성에 ${key}가 없습니다.`);
  return v;
}

function safeTrim_(s, n) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

function formatDate_(d, tz) {
  return Utilities.formatDate(d, tz, "yyyy-MM-dd");
}

function getOrCreateSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sortSheetByDate_(sheet, dateColumnIndex1Based) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return;
  sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
    .sort({ column: dateColumnIndex1Based, ascending: false }); // 최신 수집일이 위로
}
