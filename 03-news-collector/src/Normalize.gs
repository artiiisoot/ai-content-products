// P1-05. 기사 데이터 정규화 및 중복 제거
function pad2_(n) { var s = String(n); return s.length < 2 ? '0' + s : s; } function relativeToDate_(n, unit) { var ms = unit === '일' ? n * 24 * 60 * 60 * 1000 : 0; var d = new Date(Date.now() - ms); return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()); } function normalizeDate_(raw) { if (!raw) return ''; var m = String(raw).match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/); if (!m) return ''; return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]); } function normalizeArticle_(rawArticle, keyword) { return { keyword: keyword, title: String(rawArticle.title || '').trim(), source: String(rawArticle.source || '').trim() || '기업 뉴스룸', publishedAt: normalizeDate_(rawArticle.publishedAt), link: String(rawArticle.link || '').trim() }; } function dedupeArticles_(articles) { var seen = {}; var result = []; articles.forEach(function (a) { if (!a.link || seen[a.link]) return; seen[a.link] = true; result.push(a); }); return result; }
// ---------- 동일 사안(같은 보도자료를 여러 매체가 받아쓴 기사) 묶기 ----------
// 제목만으로는 매체마다 표현이 달라 놓치는 경우가 많아, 제목 + 메타 설명(og:description 등)을
// 합친 텍스트를 2-gram(문자 단위) 집합으로 만들어 자카드 유사도로 비교한다.
function storyFingerprintText_(article) {
  var t = String(article.title || "") + " " + String(article.desc || "");
  return t
    .replace(/\[[^\]]*\]/g, " ")                 // [단독], [클릭 e종목] 같은 대괄호 태그 제거
    .replace(/\([^)]{0,20}\)/g, " ")               // (서울=뉴스1) 같은 짧은 괄호(통신사/바이라인) 제거
    .replace(/[가-힣]{2,4}\s*기자/g, " ")            // "홍길동 기자" 바이라인 제거
    .replace(/["\'“”‘’『』「」]/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]+/g, "")              // 한글/영문/숫자만 남기고 압축
    .toLowerCase();
}

function textShingles_(text) {
  var set = {};
  for (var i = 0; i < text.length - 1; i++) set[text.substr(i, 2)] = true;
  return set;
}

// 교집합 개수와 자카드 유사도를 함께 반환 (짧은 텍스트의 우연한 일치를 막기 위해 교집합 개수도 확인)
function shingleOverlap_(a, b) {
  var keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length === 0 || keysB.length === 0) return { score: 0, inter: 0 };
  var inter = 0;
  for (var i = 0; i < keysA.length; i++) if (b[keysA[i]]) inter++;
  // 매체별로 요약문 길이가 크게 달라도(짧은 한 줄 요약 vs 긴 본문 인용) 정확히 잡히도록
  // 합집합 기준 Jaccard 대신, 더 짧은 쪽 기준 포함비율(overlap coefficient)을 사용한다.
  var denom = Math.min(keysA.length, keysB.length);
  return { score: denom === 0 ? 0 : inter / denom, inter: inter };
}

var SAME_STORY_SCORE_THRESHOLD = 0.35;  // 자카드 유사도 최소값(2026-08-28: 0.4->0.35, 서로 다른 매체가 같은 사안을 재구성해 쓴 기사도 묶이도록 완화)
var SAME_STORY_MIN_OVERLAP = 6;        // 최소 공통 2-gram 개수 (짧은 텍스트 우연 일치 방지)

// [정책 2026-09-07] 연도가 다르거나(예: "2025 시큐업" vs "2026 시큐업") 행사 주제 문구가 다르면
// 문장 구조가 아무리 비슷해도(같은 보도자료 틀을 매년 재사용) 다른 사안으로 본다.
// 실측 사례: byline.network(2026년 행사, 페어몬트 앰배서더)와 venturesquare.net(2025년 행사, 코엑스)
// 기사가 정형화된 보도자료 문장 때문에 2-gram 유사도 0.67~0.74로 오탐(같은 사안 판정)됐던 걸 방지.
function extractYears_(text) {
  var m = String(text || '').match(/20\d{2}/g);
  return m ? Array.from(new Set(m)) : [];
}

// 행사 주제/캐치프레이즈처럼 따옴표로 감싼 문구를 추출한다(예: 'Make Agentic AI Fun and Secure').
function extractQuotedPhrases_(text) {
  var m = String(text || '').match(/['"“”‘’『』「」]([^'"“”‘’『』「」]{4,40})['"“”‘’『』「」]/g) || [];
  return m
    .map(function (s) { return s.replace(/['"“”‘’『』「」]/g, '').replace(/[^가-힣a-zA-Z0-9]+/g, '').toLowerCase(); })
    .filter(function (s) { return s.length >= 4; });
}

// 두 원문(제목[+설명]) 사이에 연도/주제 불일치가 있으면 false(다른 사안)를 반환한다.
// 둘 다 신호가 없으면(연도/따옴표 문구 언급이 없으면) 통과시켜, 기존 2-gram 판정에 맡긴다.
function sameStoryGuard_(textA, textB) {
  var yearsA = extractYears_(textA), yearsB = extractYears_(textB);
  if (yearsA.length && yearsB.length && !yearsA.some(function (y) { return yearsB.indexOf(y) >= 0; })) return false;

  var themesA = extractQuotedPhrases_(textA), themesB = extractQuotedPhrases_(textB);
  if (themesA.length && themesB.length) {
    var themeMatches = themesA.some(function (ta) {
      return themesB.some(function (tb) { return shingleOverlap_(textShingles_(ta), textShingles_(tb)).score >= SAME_STORY_SCORE_THRESHOLD; });
    });
    if (!themeMatches) return false;
  }
  return true;
}

// 같은 사안을 하나로 묶는다. 그룹 대표 기사는 발행시각(sortTs)이 가장 빠른 것을 선택하고,
// sortTs를 모두 모르면 배열상 먼저 수집된 기사를 대표로 유지한다.
// 반환값: [{ article: 대표기사, count: 그룹에 묶인 기사 수 }, ...]
function groupDuplicateStories_(articles) {
  var groups = []; // { shingles, rawTexts: [원문...], members: [article...] }
  articles.forEach(function (a) {
    var raw = String(a.title || '') + ' ' + String(a.desc || '');
    var sh = textShingles_(storyFingerprintText_(a));
    var bestIdx = -1, bestScore = 0;
    for (var i = 0; i < groups.length; i++) {
      var ov = shingleOverlap_(sh, groups[i].shingles);
      if (ov.score >= SAME_STORY_SCORE_THRESHOLD && ov.inter >= SAME_STORY_MIN_OVERLAP && ov.score > bestScore) {
        var guardOk = groups[i].rawTexts.some(function (rt) { return sameStoryGuard_(raw, rt); });
        if (guardOk) { bestScore = ov.score; bestIdx = i; }
      }
    }
    if (bestIdx >= 0) {
      groups[bestIdx].members.push(a);
      groups[bestIdx].rawTexts.push(raw);
      // 그룹에 새 멤버가 들어올 때마다 지문(shingle 집합)을 합쳐 누적한다.
      // (예: A-B가 유사해 먼저 묶인 뒤, C는 A와는 약하지만 B와는 강하게 겹치는 경우까지 놓치지 않기 위함)
      var gsh = groups[bestIdx].shingles;
      Object.keys(sh).forEach(function (k) { gsh[k] = true; });
    } else {
      groups.push({ shingles: sh, rawTexts: [raw], members: [a] });
    }
  });
  return groups.map(function (g) {
    var rep = g.members[0];
    for (var i = 1; i < g.members.length; i++) {
      var cand = g.members[i];
      if (typeof cand.sortTs === "number" && (typeof rep.sortTs !== "number" || cand.sortTs < rep.sortTs)) {
        rep = cand;
      }
    }
    return { article: rep, count: g.members.length };
  });
}

// [정책] 자동수집(24시간 전~지금)과 수동수집(당일 자정~클릭 시각) 범위가 겹치 때, 링크는 다르지만
// 이미 저장된 기사와 같은 사안이면 새 행을 또 만들지 않고 기존 행에 병합한다(기사건수만 누적).
// 뉴스수집 탭에는 본문 요약을 저장하지 않으므로(요약 컬럼 제거) 제목만으로 비교한다 — 그룹핑(제목+요약)보다는 덜 정밀하다.
// existingStories: [{ shingles, ... }, ...]. 일치하는 항목이 없으면 -1을 반환한다.
// [정책 2026-09-08] 경쟁사 트랙은 "제목에 키워드가 그대로 들어간 기사"만 남기므로 살아남은 제목이
// 전부 "회사명, ~~~" 꼴이다. 그래서 제목에서 회사명을 빼고 남는 내용이 거의 없는 행(예: 파싱이 어긋나
// 제목이 "지란지교시큐리티" 하나뿐인 행)은 회사명만으로 아무 기사에나 붙어버린다(실측 유사도 1.000).
// 잔여 지문이 이 값보다 적은 제목은 아예 매칭 후보에서 뺀다.
// (임계값 자체를 올리는 방식은 검토했다가 접었다 — 실측상 정상 병합 건까지 같이 죽는다.)
var SAME_STORY_MIN_RESIDUAL_SHINGLES = 6;

/** 제목에서 키워드(회사명)를 걷어낸 뒤 남는 2-gram 개수. */
function residualShingleCount_(title, keyword) {
  var t = String(title || '');
  if (keyword) t = t.split(keyword).join(' ');
  return Object.keys(textShingles_(storyFingerprintText_({ title: t }))).length;
}

function matchExistingStory_(existingStories, article) {
  if (residualShingleCount_(article.title, article.keyword) < SAME_STORY_MIN_RESIDUAL_SHINGLES) return -1;
  var sh = textShingles_(storyFingerprintText_({ title: article.title }));
  var bestIdx = -1, bestScore = 0;
  existingStories.forEach(function (es, i) {
    if (residualShingleCount_(es.title, article.keyword) < SAME_STORY_MIN_RESIDUAL_SHINGLES) return;
    var ov = shingleOverlap_(sh, es.shingles);
    if (ov.score >= SAME_STORY_SCORE_THRESHOLD && ov.inter >= SAME_STORY_MIN_OVERLAP && ov.score > bestScore) {
      if (sameStoryGuard_(article.title, es.title)) {
        bestScore = ov.score;
        bestIdx = i;
      }
    }
  });
  return bestIdx;
}
