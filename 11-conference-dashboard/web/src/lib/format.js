/** 화면 표기 규칙 모음. 시트 원문은 건드리지 않고 보여줄 때만 손봅니다. */

const pad2 = (n) => String(n).padStart(2, '0');
const day = (paren) => {
  const t = String(paren || '').replace(/[()\s]/g, '');
  return t ? `(${t})` : '';
};

const SCHEDULE_RE = new RegExp(
  '(20\\d{2})\\s*\\.\\s*(\\d{1,2})\\s*\\.\\s*(\\d{1,2})\\s*(\\([^)]*\\))?' +
  '(?:\\s*[~\\-–—]\\s*(?:(20\\d{2})\\s*\\.\\s*)?(?:(\\d{1,2})\\s*\\.\\s*)?(\\d{1,2})\\s*(\\([^)]*\\))?)?'
);

/**
 * 일정: 물결 앞뒤로만 공백, 나머지는 붙여 씁니다. 시간은 버립니다.
 *   '2026. 06. 02(화) ~ 03(수)'   → '2026.06.02(화) ~ 03(수)'
 *   '2026. 10. 30(금)~11. 01(일)' → '2026.10.30(금) ~ 11.01(일)'
 * 날짜를 못 읽으면('-', '미정') 원문 그대로 둡니다.
 */
export function formatSchedule(raw) {
  const text = String(raw ?? '').replace(/\d{1,2}\s*:\s*\d{2}/g, ' ');
  const m = text.match(SCHEDULE_RE);
  if (!m) return String(raw ?? '');

  const start = `${m[1]}.${pad2(m[2])}.${pad2(m[3])}${day(m[4])}`;
  if (!m[7]) return start;

  const end = (m[5] ? `${m[5]}.` : '') + (m[6] ? `${pad2(m[6])}.` : '') + pad2(m[7]) + day(m[8]);
  return `${start} ~ ${end}`;
}

/** 일정에서 정렬용 숫자를 뽑습니다. 날짜가 없으면 null. */
export function scheduleKey(raw) {
  const m = String(raw ?? '').match(/(20\d{2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

/** 숫자: 세 자리마다 쉼표. '25805' → '25,805' */
export function formatNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const digits = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return text;      // 숫자가 아니면 원문 유지
  return Number(digits).toLocaleString('ko-KR');
}

const PRICE_RE = /\d[\d,]*\s*(?:만원|억원|원|달러|USD|\$)/g;
const NEGO_RE = /(?:->|→|=>)\s*(?:할인가\s*)?(\d[\d,]*\s*(?:만원|억원|원|달러|USD|\$))/;
const FREE_RE = /무료|무상|초청/;
const COST_LABEL = '조립 부스';

function tidyPrice(text) {
  return String(text).replace(/\s+/g, '').replace(/(\d[\d,]*)/, (n) => formatNumber(n));
}

/**
 * 비용: 라벨을 '조립 부스'로 통일합니다. 줄 배열로 돌려주고, 네고된 줄은 nego 로 표시합니다.
 *   '세션 800만원 ->600만원으로 네고'  → [{800만원}, {600만원 (네고), nego}]
 *   '조립 864만원 업그레이드 1260만원' → [{864만원}]
 *   '-', '확인 불가'                  → [{원문}]
 */
export function formatCost(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const hits = text.match(PRICE_RE);
  const nego = text.match(NEGO_RE);
  const line = (price, isNego) => ({
    text: `${COST_LABEL} : ${tidyPrice(price)}${isNego ? ' (네고)' : ''}`,
    nego: Boolean(isNego)
  });

  if (nego) {
    const base = hits && hits[0];
    const negoLine = line(nego[1], true);
    return base && tidyPrice(base) !== tidyPrice(nego[1])
      ? [line(base, false), negoLine]
      : [negoLine];
  }

  if (hits && hits.length) return [line(hits[0], false)];
  if (FREE_RE.test(text)) return [{ text: `${COST_LABEL} : 무료`, nego: false }];
  return [{ text: text, nego: false }];
}
