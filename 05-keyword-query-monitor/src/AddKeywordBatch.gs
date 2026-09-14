/********************************************************
 * 2026-09-02: 사용자가 전달한 키워드 후보 100개를 "키워드" 탭에 추가.
 * - 이미 키워드 탭에 있는 항목(정확히 일치)은 건너뛰고 "중복키워드" 탭에 기록.
 * - 여러 번 실행해도 같은 키워드가 중복으로 쌓이지 않음(멱등).
 * Apps Script 편집기에서 addKeywordBatch_20260902() 를 1회 실행하면 됨.
 ********************************************************/
const DUPLICATE_KEYWORD_SHEET_NAME = "중복키워드";

const KEYWORD_BATCH_20260902 = [
  "디지털 ID", "분산신원인증", "DID 인증", "블록체인 DID", "탈중앙화 신원증명",
  "자기주권신원", "디지털 신원인증", "디지털 자격증명", "전자 신원확인", "신원·자격 인증 플랫폼",
  "모바일 신분증", "모바일 주민등록증", "모바일 운전면허증", "모바일 국가보훈등록증", "모바일 장애인등록증",
  "디지털 학생증", "모바일 사원증", "디지털 증명서", "모바일 자격증", "디지털 배지",
  "FIDO 인증", "FIDO2 인증", "패스워드리스 인증", "생체인증", "지문인증",
  "얼굴인증", "간편인증", "다중인증", "MFA 인증", "비밀번호 없는 로그인",
  "제로 트러스트 보안", "제로 트러스트 인증", "통합인증 플랫폼", "통합계정관리", "계정 권한 관리",
  "접근제어 솔루션", "IAM 솔루션", "클라우드 IAM", "하이브리드 보안", "사용자 행위 분석",
  "모바일 보안", "모바일 백신", "스마트워크 보안", "MDM 솔루션", "기업용 MDM",
  "모바일 단말 관리", "업무용 스마트폰 보안", "앱 위변조 방지", "모바일 화면 캡처 방지", "모바일 키보드 보안",
  "PC 보안", "키보드 보안", "가상 키보드", "웹 방화벽", "개인 방화벽",
  "전자서명 솔루션", "구간 암호화", "인증서 관리", "PKI 솔루션", "핀테크 보안",
  "블록체인 인증", "블록체인 신원관리", "블록체인 플랫폼", "전자지갑", "디지털 지갑",
  "검증가능한 자격증명", "VC 인증", "Web3 신원인증", "NFT 인증", "개인정보 선택적 공개",
  "AI 보안", "AI 기반 모바일 백신", "딥페이크 탐지", "딥페이크 영상 탐지", "생성형 AI 보안",
  "이상행위 탐지", "보안 자동화", "양자내성암호", "PQC 보안", "양자컴퓨터 대응 보안",
  "모의해킹", "취약점 진단", "보안 취약점 분석", "침투 테스트", "화이트해커",
  "사이버 보안 교육", "해킹 실습 교육", "CTF 교육", "ISMS 컨설팅", "정보보호 컨설팅",
  "라온시큐어", "옴니원 엔터프라이즈", "옴니원 디지털아이디", "옴니원 액세스", "옴니원 배지",
  "원패스", "원가드", "터치엔 와이즈억세스", "터치엔 엠백신", "키샵비즈"
];

function addKeywordBatch_20260902() {
  const ss = getSpreadsheet_();
  const kwSheet = ss.getSheetByName(KEYWORD_SHEET_NAME);
  if (!kwSheet) throw new Error(`'${KEYWORD_SHEET_NAME}' 시트를 찾을 수 없습니다. setup()을 먼저 실행하세요.`);

  const lastRow = kwSheet.getLastRow();
  const existing = lastRow >= 2
    ? kwSheet.getRange(2, 2, lastRow - 1, 1).getValues().flat().map(v => String(v).trim()).filter(Boolean)
    : [];
  const existingSet = new Set(existing);

  const toAdd = [];
  const skipped = [];
  const seenInBatch = new Set();

  for (const raw of KEYWORD_BATCH_20260902) {
    const kw = String(raw).trim();
    if (!kw) continue;
    if (existingSet.has(kw) || seenInBatch.has(kw)) {
      skipped.push(kw);
      continue;
    }
    seenInBatch.add(kw);
    toAdd.push(["Y", kw]);
  }

  if (toAdd.length) {
    kwSheet.getRange(kwSheet.getLastRow() + 1, 1, toAdd.length, 2).setValues(toAdd);
  }

  if (skipped.length) {
    const dupSheet = getOrCreateSheet_(ss, DUPLICATE_KEYWORD_SHEET_NAME, ["기록일시", "중복키워드", "출처"]);
    const now = new Date();
    const rows = skipped.map(kw => [now, kw, "2026-09-02 키워드 100개 배치"]);
    dupSheet.getRange(dupSheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    dupSheet.getRange(2, 1, dupSheet.getLastRow() - 1, 1).setNumberFormat("yyyy-mm-dd");
  }

  Logger.log(`추가 ${toAdd.length}건, 중복 스킵 ${skipped.length}건: ${skipped.join(", ") || "(없음)"}`);
}
