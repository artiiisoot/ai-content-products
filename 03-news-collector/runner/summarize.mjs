#!/usr/bin/env node
/**
 * 사내망 로컬 러너 — AI 추론 담당 (P2-02 일일요약, P2-03 주간 콘텐츠 후보).
 *
 * 흐름: Apps Script Web App(doGet)에서 데이터 수신 → 사내 LiteLLM 게이트웨이로 추론
 *      → Web App(doPost)으로 결과 기록. 게이트웨이는 사내망에서만 도달 가능하므로
 *      이 스크립트는 반드시 사내망(VPN 포함) 안에서 실행해야 한다.
 *
 * 실행:
 *   node --env-file=.env summarize.mjs daily      # 오늘 수집분 일일요약
 *   node --env-file=.env summarize.mjs weekly      # 최근 7일 주간 콘텐츠 후보
 *   node --env-file=.env summarize.mjs check       # 시트 '지금 생성 요청' 버튼 폴링 (요청 있으면 weekly 즉시 실행)
 *   node --env-file=.env summarize.mjs backfill 2026-08-24 2026-08-31  # 과거 날짜 구간 일일요약 백필(발행일 기준)
 *   node summarize.mjs selfcheck                    # 네트워크 없이 순수 로직 점검
 *
 * 필요한 환경변수(.env 참고):
 *   WEBAPP_URL, WEBAPP_TOKEN, LITELLM_KEY  (LITELLM_URL, MODEL 은 기본값 있음)
 */

const CONFIG = {
  webappUrl: process.env.WEBAPP_URL,
  webappToken: process.env.WEBAPP_TOKEN,
  litellmUrl: process.env.LITELLM_URL || 'https://litellm.ops.raonops.com',
  litellmKey: process.env.LITELLM_KEY,
  model: process.env.MODEL || 'claude-sonnet-4-6',
};

/** Claude 응답이 ```json 코드펜스로 감싸져 있어도 순수 JSON으로 파싱한다. */
function parseClaudeJson(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function buildDailySummaryPrompt(grouped) {
  const blocks = Object.keys(grouped).map((keyword) => {
    const lines = grouped[keyword]
      .map((a) => `- ${a.title} (${a.source})`)
      .join('\n');
    return `[${keyword}]\n${lines}`;
  }).join('\n\n');
  return '아래는 키워드별로 수집된 보안 업계 뉴스 기사 목록입니다. 이 정보를 바탕으로 각 키워드별 주요 동향을 2~4줄로 요약해주세요.\n\n' +
    blocks +
    '\n\n반드시 아래 JSON 배열 형식으로만 응답하세요. 다른 설명이나 마크다운 코드블록 없이 순수 JSON만 출력하세요:\n' +
    '[{"keyword": "키워드명", "summary": "요약 내용"}, ...]';
}

function buildWeeklyCandidatePrompt(summaries) {
  const blocks = summaries.map((s) => `[${s.keyword}] (기사 ${s.count}건)\n${s.summary}`).join('\n\n');
  return '당신은 보안·인증 기업 "라온시큐어"의 브랜드 마케터입니다. ' +
    '라온시큐어는 FIDO/패스키, Zero Trust, DID(분산신원), PQC(양자내성암호), Agentic AI 기반 인증 등을 다루는 기업이고, ' +
    '자사 블로그에 주간 단위로 "보안 인증 업계 브리핑" 콘텐츠를 발행하려 합니다.\n\n' +
    '아래는 최근 1주일간 키워드별로 요약된 보안 업계 뉴스입니다:\n\n' +
    blocks +
    '\n\n이 내용을 바탕으로 라온시큐어 블로그에 소개할 만한 콘텐츠 주제 후보 5~7개를 선정해주세요. ' +
    '단순 뉴스 재탕이 아니라 라온시큐어의 관점(자사 제품/기술과의 연결점)에서 의미 있는 주제를 우선하세요.\n\n' +
    '반드시 아래 JSON 배열 형식으로만 응답하세요. 다른 설명이나 마크다운 코드블록 없이 순수 JSON만 출력하세요:\n' +
    '[{"title": "블로그 제목 후보", "keywords": "관련 키워드(쉼표구분)", "reason": "선정 이유", "tieIn": "라온시큐어 연결 포인트"}, ...]';
}

/**
 * 주간 후보 폴백: 일일요약이 없을 때 이번주 수집 기사(키워드별 그룹)를
 * weekly 프롬프트가 기대하는 {keyword, count, summary} 형태로 변환한다.
 * summary 자리에는 제목들을 이어붙여 AI가 동향을 뽑을 재료로 삼는다.
 */
function weekNewsToSummaries(grouped) {
  return Object.keys(grouped || {}).map((kw) => ({
    keyword: kw,
    count: grouped[kw].length,
    summary: grouped[kw].map((a) => a.title).join('; '),
  }));
}

function requireConfig(keys) {
  const missing = keys.filter((k) => !CONFIG[k]);
  if (missing.length) throw new Error('환경변수 누락: ' + missing.join(', ') + ' (.env 확인)');
}

/** Web App doGet 호출. */
async function bridgeGet(action, extra = {}) {
  const url = new URL(CONFIG.webappUrl);
  url.searchParams.set('token', CONFIG.webappToken);
  url.searchParams.set('action', action);
  Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();
  if (data.error) throw new Error('Web App 오류(' + action + '): ' + data.error);
  return data;
}

/** Web App doPost 호출. extra는 쿼리 파라미터로 붙는다(예: date=yyyy-MM-dd 백필용). */
async function bridgePost(action, body, extra = {}) {
  const url = new URL(CONFIG.webappUrl);
  url.searchParams.set('token', CONFIG.webappToken);
  url.searchParams.set('action', action);
  Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  const data = await res.json();
  if (data.error) throw new Error('Web App 오류(' + action + '): ' + data.error);
  return data;
}

/** 사내 LiteLLM 게이트웨이(OpenAI 호환)로 추론. 응답을 JSON으로 파싱해 반환. */
async function callGateway(prompt, maxTokens) {
  const res = await fetch(CONFIG.litellmUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CONFIG.litellmKey },
    body: JSON.stringify({
      model: CONFIG.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`게이트웨이 오류 (${res.status}): ${text}`);
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('게이트웨이 응답에서 텍스트를 찾지 못했습니다: ' + text);
  return parseClaudeJson(content);
}

// [정책] 수집범위는 "언제 생성했는지"(생성일시 컬럼이 이미 담당)가 아니라 "실제 보도자료 발행일"을
// 반영해야 한다. 수집 창(자동 24시간 전~지금)에는 어제~오늘 기사가 섞여 들어올 수 있는데,
// [정책 2026-09-07] 범위로 표기하지 않고 그 중 가장 이른(앞) 날짜 하나만 표기한다.
function rangeFromArticles_(articles) {
  const dates = (articles || []).map((a) => a.publishedAt).filter(Boolean).sort();
  return dates.length ? dates[0] : '';
}

async function runDaily() {
  requireConfig(['webappUrl', 'webappToken', 'litellmKey']);
  const { grouped } = await bridgeGet('todayNews');
  const keywords = Object.keys(grouped || {});
  if (keywords.length === 0) {
    console.log('오늘 수집된 기사가 없어 일일요약을 건너뜁니다.');
    return;
  }
  const summaries = await callGateway(buildDailySummaryPrompt(grouped), 4000);
  const items = summaries.map((s) => {
    const articles = grouped[s.keyword] || [];
    return { keyword: s.keyword, summary: s.summary, count: articles.length, range: rangeFromArticles_(articles) };
  });
  const { written } = await bridgePost('dailySummary', items);
  console.log(`일일요약 기록 완료: ${written}건`);
}

async function runWeekly() {
  requireConfig(['webappUrl', 'webappToken', 'litellmKey']);
  // 1순위: 이번주 일일요약. 없거나 일부만 있어도 막히지 않도록,
  // 비어 있으면 이번주 수집 기사(뉴스수집)만으로 후보를 추출한다.
  let { summaries } = await bridgeGet('recentSummaries', { days: 7 });
  if (!summaries || summaries.length === 0) {
    const { grouped } = await bridgeGet('weekNews', { days: 7 });
    summaries = weekNewsToSummaries(grouped);
    if (summaries.length) console.log(`일일요약이 없어 이번주 수집 기사 ${summaries.length}개 키워드로 후보를 추출합니다.`);
  }
  if (!summaries.length) {
    console.log('이번주 일일요약도 수집 기사도 없어 주간 후보 생성을 건너뜁니다.');
    return;
  }
  const candidates = await callGateway(buildWeeklyCandidatePrompt(summaries), 6000);
  const { written } = await bridgePost('weeklyCandidates', candidates);
  console.log(`주간 콘텐츠 후보 기록 완료: ${written}건`);
}

/**
 * 시트의 "주간콘텐츠후보 → 지금 생성 요청" 버튼이 남긴 플래그를 확인해,
 * 요청이 있으면 즉시 runWeekly()를 실행하고 플래그를 지운다(ack).
 * launchd StartInterval로 주기 실행(예: 2분)해 버튼 클릭 후 다음 폴링 때 처리되게 한다.
 */
async function runCheck() {
  requireConfig(['webappUrl', 'webappToken']);
  const { requested } = await bridgeGet('weeklyCandidatesManualRequest');
  if (!requested) {
    console.log('수동 요청 없음');
    return;
  }
  console.log('수동 요청 감지 - 주간 콘텐츠 후보를 즉시 생성합니다.');
  await runWeekly();
  await bridgePost('ackWeeklyCandidatesManualRequest', {});
  console.log('수동 요청 처리 완료');
}

/** 하루치 발행일(dateStr, yyyy-MM-dd) 기사만 모아 그날짜로 일일요약을 기록한다. */
async function runBackfillDay(dateStr) {
  const { grouped } = await bridgeGet('newsByDate', { date: dateStr });
  const keywords = Object.keys(grouped || {});
  if (keywords.length === 0) {
    console.log(`${dateStr}: 수집된 기사 없음, 건너뜀`);
    return;
  }
  const summaries = await callGateway(buildDailySummaryPrompt(grouped), 4000);
  const items = summaries.map((s) => {
    const articles = grouped[s.keyword] || [];
    return { keyword: s.keyword, summary: s.summary, count: articles.length, range: rangeFromArticles_(articles) || dateStr };
  });
  const { written } = await bridgePost('dailySummary', items, { date: dateStr });
  console.log(`${dateStr} 일일요약 기록 완료: ${written}건`);
}

/** Date를 로컬 기준 yyyy-MM-dd로 포맷. toISOString()은 UTC로 변환돼 KST 자정 근처에서 날짜가 하루 밀린다. */
function fmtLocalDate_(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** startStr~endStr(포함, yyyy-MM-dd) 구간을 하루씩 순회하며 일일요약을 백필한다. */
async function runBackfill(startStr, endStr) {
  requireConfig(['webappUrl', 'webappToken', 'litellmKey']);
  if (!startStr || !endStr) throw new Error('사용법: backfill <시작일 yyyy-MM-dd> <종료일 yyyy-MM-dd>');
  const d = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (d.getTime() <= end.getTime()) {
    const ds = fmtLocalDate_(d);
    // 하루치 처리 중 오류(게이트웨이 응답 파싱 실패 등)가 나도 나머지 날짜는 이어서 처리한다 —
    // 안 그러면 구간 중 하루만 실패해도 그 뒤 날짜 전부가 백필 안 된 채로 남는다.
    try {
      await runBackfillDay(ds);
    } catch (e) {
      console.error(`${ds}: 실패 - ${String(e.message || e)}`);
    }
    d.setDate(d.getDate() + 1);
  }
}

/** 네트워크 없이 순수 로직만 점검. */
function selfCheck() {
  const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };

  assert(JSON.stringify(parseClaudeJson('```json\n[{"a":1}]\n```')) === '[{"a":1}]', 'parseClaudeJson 코드펜스 제거');
  assert(JSON.stringify(parseClaudeJson('[{"a":1}]')) === '[{"a":1}]', 'parseClaudeJson 순수 JSON');

  const dp = buildDailySummaryPrompt({ 라온시큐어: [{ title: '제목A', source: '언론사1', summary: '요약1' }] });
  assert(dp.includes('[라온시큐어]') && dp.includes('제목A') && dp.includes('언론사1'), 'daily 프롬프트 구성');

  const wp = buildWeeklyCandidatePrompt([{ keyword: '라온시큐어', count: 3, summary: '동향요약' }]);
  assert(wp.includes('라온시큐어') && wp.includes('기사 3건') && wp.includes('동향요약'), 'weekly 프롬프트 구성');

  const fb = weekNewsToSummaries({ 라온시큐어: [{ title: 'T1', source: 'S' }, { title: 'T2', source: 'S' }] });
  assert(fb.length === 1 && fb[0].count === 2 && fb[0].summary === 'T1; T2', 'weekly 폴백(일일요약 없음) 변환');

  assert(rangeFromArticles_([{ publishedAt: '2026-09-07' }, { publishedAt: '2026-09-06' }]) === '2026-09-06', 'rangeFromArticles_ 가장 이른 날짜만 표기');
  assert(rangeFromArticles_([{ publishedAt: '2026-09-07' }, { publishedAt: '2026-09-07' }]) === '2026-09-07', 'rangeFromArticles_ 발행일 범위(같은 날)');
  assert(rangeFromArticles_([]) === '', 'rangeFromArticles_ 빈 배열');

  console.log('selfcheck OK');
}

const cmd = process.argv[2];
const actions = {
  daily: runDaily,
  weekly: runWeekly,
  check: runCheck,
  backfill: () => runBackfill(process.argv[3], process.argv[4]),
  selfcheck: async () => selfCheck(),
};
if (!actions[cmd]) {
  console.error('사용법: node summarize.mjs <daily|weekly|check|backfill <시작일> <종료일>|selfcheck>');
  process.exit(1);
}
actions[cmd]().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
