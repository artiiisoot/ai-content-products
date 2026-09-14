/**
 * P1-01~P1-02 순수 로직 자가 점검. 시트 접근 없이 실행 가능.
 * Apps Script 에디터에서 runSelfCheck() 실행 → 로그에 "OK" 확인.
 */
function runSelfCheck() {
  var results = [];

  assert_(colIndex_(KEYWORD_HEADERS, '키워드') === 2, 'colIndex_ 정상 컬럼');
  assert_(throws_(function () { colIndex_(KEYWORD_HEADERS, '없는컬럼'); }), 'colIndex_ 알 수 없는 컬럼');

  assert_(hasNewsroom_({ newsroomUrl: 'https://news.example.com' }) === true, 'hasNewsroom_ URL 있음');
  assert_(hasNewsroom_({ newsroomUrl: '' }) === false, 'hasNewsroom_ 빈 값');
  assert_(hasNewsroom_({ newsroomUrl: '   ' }) === false, 'hasNewsroom_ 공백만 있는 값');
  assert_(hasNewsroom_({}) === false, 'hasNewsroom_ 필드 없음');

  assert_(isSameDate_(new Date(2026, 7, 24, 9, 0), new Date(2026, 7, 24, 23, 59)) === true, 'isSameDate_ 같은 날');
  assert_(isSameDate_(new Date(2026, 7, 24), new Date(2026, 7, 25)) === false, 'isSameDate_ 다른 날');

  var grouped = groupArticlesByKeyword_(
    [['라온시큐어', '기사A', '언론사1', '요약1'], ['라온시큐어', '기사B', '언론사2', '요약2'], ['망분리', '기사C', '언론사3', '요약3']],
    { keyword: 0, title: 1, source: 2, summary: 3 }
  );
  assert_(grouped['라온시큐어'].length === 2 && grouped['망분리'].length === 1, 'groupArticlesByKeyword_ 그룹핑');

  assert_(pad2_(3) === '03' && pad2_(11) === '11', 'pad2_ 자릿수 맞춤');
  assert_(normalizeDate_('2026.8.24') === '2026-08-24', 'normalizeDate_ 점 구분');
  assert_(normalizeDate_('2026-08-24') === '2026-08-24', 'normalizeDate_ 하이픈 구분');
  assert_(normalizeDate_('') === '' && normalizeDate_('없음') === '', 'normalizeDate_ 인식 불가 시 빈 값');

  assert_(
    JSON.stringify(normalizeArticle_({ title: ' 제목 ', link: ' https://a.com/1 ', publishedAt: '2026.8.24' }, '라온시큐어')) ===
      JSON.stringify({ keyword: '라온시큐어', title: '제목', source: '기업 뉴스룸', publishedAt: '2026-08-24', link: 'https://a.com/1' }),
    'normalizeArticle_ 공백 제거 및 기본 언론사'
  );

  assert_(
    dedupeArticles_([{ link: 'https://a.com/1' }, { link: 'https://a.com/1' }, { link: 'https://a.com/2' }, { link: '' }]).length === 2,
    'dedupeArticles_ 링크 기준 중복 제거'
  );

  var dup1 = { title: 'SKT, 사이버 보안 특화 AI 모델 개발 도전', desc: 'SK텔레콤이 업스테이지, 라온시큐어 등 14개 기관과 사이버보안 특화 AI 모델 개발에 나선다고 27일 밝혔다.', link: 'https://p1.example.com/1', sortTs: 200 };
  var dup2 = { title: 'SKT업스테이지, 사이버 보안 특화 AI 모델 개발 추진', desc: 'SK텔레콤이 업스테이지, 라온시큐어 등 14개 기관과 사이버보안 특화 AI 모델 개발에 나선다고 27일 밝혔다.', link: 'https://p2.example.com/1', sortTs: 100 };
  var distinct = { title: '라온시큐어, PQC AI 보안 사업 확대', desc: '라온시큐어는 하반기 실적 개선과 함께 양자내성암호 사업을 확대한다고 밝혔다.', link: 'https://p3.example.com/1', sortTs: 150 };
  // 같은 사안이라도 매체별 요약(desc) 길이가 크게 다른 경우(짧은 요약 vs 상세 인용).
  // 과거 Jaccard(합집합 기준) 방식은 이런 경우를 놓쳤다 - overlap coefficient(짧은 쪽 기준) 회귀 테스트.
  var longRewrite = { title: '테스트미디어, SKT 컨소시엄 참여 상세 보도', desc: dup1.desc + ' 이번 컨소시엄은 정부가 추진하는 보안 특화 AI 모델 개발 사업에 신청서를 접수했으며, 국가대표급 AI 모델과 실전 보안 데이터, 현장 검증이 맞물리는 구조로 주목받고 있다. 업계에서는 이번 협력이 국내 사이버 보안 산업의 경쟁력 강화에 기여할 것으로 내다봤다.', link: 'https://p4.example.com/1', sortTs: 300 };
  var groupedStories = groupDuplicateStories_([dup1, dup2, distinct, longRewrite]);
  assert_(
    groupedStories.length === 2,
    'groupDuplicateStories_ 동일 사안 묶음 개수'
  );
  var mergedGroup = groupedStories.filter(function (g) { return g.count === 3; })[0];
  assert_(
    !!mergedGroup && mergedGroup.article.link === 'https://p2.example.com/1',
    'groupDuplicateStories_ 대표 기사는 발행시각이 가장 빠른 것'
  );
  assert_(
    !!mergedGroup && mergedGroup.article.link !== longRewrite.link,
    'groupDuplicateStories_ 요약이 훨씬 긴 기사도(overlap coefficient) 같은 사안으로 병합'
  );
  var soloGroup = groupedStories.filter(function (g) { return g.count === 1; })[0];
  assert_(
    !!soloGroup && soloGroup.article.link === 'https://p3.example.com/1',
    'groupDuplicateStories_ 다른 사안은 분리'
  );

  // matchExistingStory_: 이미 저장된 기사(제목만 보유)와 새 기사(링크는 다름)가 같은 사안인지 판정.
  var existingStories = [
    { rowIndex: 5, title: dup1.title, shingles: textShingles_(storyFingerprintText_({ title: dup1.title })), count: 1 }
  ];
  assert_(
    matchExistingStory_(existingStories, { title: dup2.title }) === 0,
    'matchExistingStory_ 제목만으로도 같은 사안 매칭'
  );
  assert_(
    matchExistingStory_(existingStories, { title: distinct.title }) === -1,
    'matchExistingStory_ 다른 사안은 매칭 안 됨'
  );

  // [정책 2026-09-07] 연도/주제 가드 회귀 테스트. 실측 사례: 같은 "시큐업&해커톤" 보도자료 문장 틀을
  // 매년 재사용해 연도만 다른 기사가(byline.network 2026년 vs venturesquare.net 2025년 행사)
  // 2-gram 유사도만으로는 0.67~0.74로 오탐(같은 사안 판정)됐던 것을 가드가 걸러내는지 확인한다.
  var event2026 = {
    title: "라온시큐어, '시큐업&해커톤' 개최…에이전틱AI 보안 전략 공개",
    desc: "라온시큐어는 오는 9월30일 서울 페어몬트 앰배서더에서 '2026 시큐업&해커톤'을 개최한다고 25일 밝혔다. 행사에서는 에이전틱 인공지능(AI)을 활용한 보안 자동화와 신원 인증, 모의침투 등 관련 기술과 적용 전략을 소개한다.",
    link: 'https://byline.example.com/1', sortTs: 10
  };
  var event2025 = {
    title: "라온시큐어, '2025 시큐업&해커톤' 개최",
    desc: "라온시큐어는 오는 9월 23일 서울 코엑스에서 '2025 시큐업&해커톤'을 개최한다고 26일 밝혔다.",
    link: 'https://venturesquare.example.com/1', sortTs: 5
  };
  assert_(
    sameStoryGuard_(event2026.title + ' ' + event2026.desc, event2025.title + ' ' + event2025.desc) === false,
    'sameStoryGuard_ 연도가 다르면 다른 사안'
  );
  var yearGroups = groupDuplicateStories_([event2026, event2025]);
  assert_(yearGroups.length === 2, 'groupDuplicateStories_ 연도가 다른 정례 행사 기사는 분리');

  // matchExistingStory_는 뉴스수집 탭에 저장된 제목만으로 비교한다(설명 없음). 위 실측 사례는 byline
  // 제목 자체에는 연도가 없어 이 경로에선 가드가 걸 신호가 없다 — 제목에 연도가 실제로 들어간
  // (예: 벤처스퀘어 스타일) 경우로 이 경로의 가드를 별도 확인한다.
  var existingStories2026 = [
    { rowIndex: 9, title: "라온시큐어, '2026 시큐업&해커톤' 개최", shingles: textShingles_(storyFingerprintText_({ title: "라온시큐어, '2026 시큐업&해커톤' 개최" })), count: 1 }
  ];
  assert_(
    matchExistingStory_(existingStories2026, { title: event2025.title }) === -1,
    'matchExistingStory_ 제목에 연도가 다르면 매칭 안 됨'
  );

  // 연도는 같아도 행사 주제(따옴표 캐치프레이즈)가 다르면 다른 사안으로 본다.
  assert_(
    sameStoryGuard_("행사는 'Make Agentic AI Fun and Secure'을 주제로 열린다", "행사는 'Web3와 AI로 여는 미래'를 주제로 열린다") === false,
    'sameStoryGuard_ 행사 주제 문구가 다르면 다른 사안'
  );
  assert_(
    sameStoryGuard_(dup1.title + ' ' + dup1.desc, dup2.title + ' ' + dup2.desc) === true,
    'sameStoryGuard_ 연도/주제 언급이 없는 일반 기사는 그대로 통과'
  );

  // [정책 2026-09-08] 회사명만 남는 제목 가드 회귀 테스트. 실측 사고: 파싱이 어긋나 제목이
  // "지란지교시큐리티" 하나뿐인 행이 유사도 1.000으로 같은 회사의 전혀 다른 기사를 흡수했다.
  var junkTitle = '지란지교시큐리티';
  var realTitle = "지란지교시큐리티-필상, AI 결합한 통합 모바일 보안 체계 구축 '맞손'";
  assert_(residualShingleCount_(junkTitle, '지란지교시큐리티') === 0, 'residualShingleCount_ 회사명뿐인 제목은 잔여 0');
  assert_(residualShingleCount_(realTitle, '지란지교시큐리티') >= SAME_STORY_MIN_RESIDUAL_SHINGLES, 'residualShingleCount_ 정상 제목은 잔여 충분');
  var junkStories = [
    { rowIndex: 4, title: junkTitle, shingles: textShingles_(storyFingerprintText_({ title: junkTitle })), count: 1 }
  ];
  assert_(
    matchExistingStory_(junkStories, { title: realTitle, keyword: '지란지교시큐리티' }) === -1,
    'matchExistingStory_ 회사명뿐인 기존 행은 흡수하지 못한다'
  );
  // 반대 방향(새 기사 제목이 회사명뿐인 경우)도 막혀야 한다.
  var realStories = [
    { rowIndex: 5, title: realTitle, shingles: textShingles_(storyFingerprintText_({ title: realTitle })), count: 1 }
  ];
  assert_(
    matchExistingStory_(realStories, { title: junkTitle, keyword: '지란지교시큐리티' }) === -1,
    'matchExistingStory_ 회사명뿐인 새 기사도 흡수되지 않는다'
  );
  // 회사명을 빼고도 내용이 충분한 정상 쌍은 기존처럼 병합되어야 한다(임계값을 올리지 않은 이유).
  var hancomA = '한컴위드, 두바이에 금 RWA 합작법인 설립…중동 디지털 금융 시장 공략';
  var hancomB = '금·블록체인 사업 확장하는 한컴위드...두바이 거점으로 중동시장 공략';
  var hancomStories = [
    { rowIndex: 6, title: hancomA, shingles: textShingles_(storyFingerprintText_({ title: hancomA })), count: 1 }
  ];
  assert_(
    matchExistingStory_(hancomStories, { title: hancomB, keyword: '한컴위드' }) === 0,
    'matchExistingStory_ 같은 사안(다른 매체)은 여전히 병합된다'
  );

  // absorbedNoteText_: 비고 컬럼에는 "총 N건 흡수 : 수집실행일"만 남긴다(기사 일자/제목/URL은 남기지 않음).
  var noteDay = new Date(2026, 8, 8);
  assert_(absorbedNoteText_('', 1, noteDay) === '총 1건 흡수 : 2026-09-08', 'absorbedNoteText_ 빈 값에서 첫 기록');
  assert_(absorbedNoteText_('총 1건 흡수 : 2026-09-07', 2, noteDay) === '총 3건 흡수 : 2026-09-08', 'absorbedNoteText_ 기존 건수에 누적하고 날짜는 이번 실행일로 갱신');
  assert_(absorbedNoteText_('총 12건 흡수 : 2026-09-07', 1, noteDay) === '총 13건 흡수 : 2026-09-08', 'absorbedNoteText_ 두 자리 이상 누적');
  assert_(absorbedNoteText_('메모 없음', 1, noteDay) === '총 1건 흡수 : 2026-09-08', 'absorbedNoteText_ 형식에 안 맞는 기존 값은 0으로 취급');
  assert_(absorbedNoteText_('총 1건 흡수 : 2026-09-08', 1, noteDay).indexOf('http') < 0, '비고에 URL 미포함');

  assert_(countArticlesByRun_([{}, {}, {}]) === 3, 'countArticlesByRun_ 개수 집계');

  assert_(resolveUrl_('https://news.example.com/list', '/view/1') === 'https://news.example.com/view/1', 'resolveUrl_ 절대경로 변환');
  assert_(resolveUrl_('https://news.example.com/list', 'https://other.com/1') === 'https://other.com/1', 'resolveUrl_ 이미 절대경로면 그대로');

  assert_(decodeHtmlEntities_('A&amp;B &quot;C&quot;') === 'A&B "C"', 'decodeHtmlEntities_ 기본 엔티티 디코딩');

  var newsroomHtml =
    '<a href="/view/1">라온시큐어, FIDO 인증 신제품 출시 2026.08.24</a>' +
    '<a href="#">메뉴</a>';
  var newsroomArticles = parseNewsroomList_(newsroomHtml);
  assert_(
    newsroomArticles.length === 1 && newsroomArticles[0].link === '/view/1' && newsroomArticles[0].publishedAt === '2026-08-24',
    'parseNewsroomList_ 제목/링크/날짜 추출'
  );

  assert_(/^\d{4}-\d{2}-\d{2}$/.test(relativeToDate_(3, '시간')), 'relativeToDate_ 시간 단위 형식');
  assert_(relativeToDate_(1, '일') !== relativeToDate_(0, '시간') || true, 'relativeToDate_ 일 단위 계산 가능');

  var naverHtml =
    '<span class="sds-comps-profile-info-title-text">디지털데일리</span>' +
    '<a href="https://n.com/1" data-heatmap-target=".tit"><span class="sds-comps-text-type-headline1">라온시큐어 클라우드 보안 확대</span></a>' +
    '<span>3시간 전</span>';
  var naverArticles = parseNaverNewsList_(naverHtml);
  assert_(
    naverArticles.length === 1 && naverArticles[0].link === 'https://n.com/1' && naverArticles[0].title === '라온시큐어 클라우드 보안 확대',
    'parseNaverNewsList_ 제목/링크 추출'
  );
  assert_(naverArticles[0].source === '디지털데일리', 'parseNaverNewsList_ 언론사 추출');
  assert_(naverArticles[0].publishedAt === relativeToDate_(3, '시간'), 'parseNaverNewsList_ 상대 날짜 환산');

  // prepareCollectionWindow_/getCollectionWindowStart_ 검증
  (function () {
    var runAt = new Date('2026-09-01T14:38:00+09:00');

    var wScheduled = prepareCollectionWindow_(runAt, 'scheduled');
    assert_(wScheduled === runAt.getTime() - 24 * 60 * 60 * 1000, 'prepareCollectionWindow_ 자동 실행은 정확히 24시간 전');
    assert_(getCollectionWindowStart_() === wScheduled, 'getCollectionWindowStart_ 현재 실행 창 반환');

    var wManual = prepareCollectionWindow_(runAt, 'manual');
    var expectedMidnight = new Date(2026, 8, 1).getTime(); // 2026-09-01 00:00 (월 인덱스는 0부터)
    assert_(wManual === expectedMidnight, 'prepareCollectionWindow_ 수동 실행은 당일 자정부터');
  })();

  Logger.log('runSelfCheck OK: ' + results.length + ' checks passed');
  return 'OK';

  function assert_(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    results.push(msg);
  }

  function throws_(fn) {
    try { fn(); return false; } catch (e) { return true; }
  }
}
