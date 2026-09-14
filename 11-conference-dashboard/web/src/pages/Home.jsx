import React, { useMemo } from 'react';
import { useLedger } from '../app/LedgerContext.jsx';
import { scheduleKey } from '../lib/format.js';
import StatTiles from '../components/StatTiles.jsx';
import EventList from '../components/EventList.jsx';
import Panel from '../components/Panel.jsx';

const todayKey = () => {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

const MoreLink = <a className="more" href="#/conferences">전체 보기 →</a>;

/** 홈 — 컨퍼런스 조회의 요약본. 상세는 조회 페이지에서 봅니다. */
export default function Home({ route }) {
  const { data, year } = useLedger();
  const tab = data.tabs.find((t) => t.year === year && t.kind === route.source) ||
              data.tabs.find((t) => t.kind === route.source);

  const view = useMemo(() => summarize(tab, data.legend), [tab, data.legend]);

  if (!view) {
    return <Panel><div className="empty">{year}_{route.source} 탭을 찾지 못했습니다.</div></Panel>;
  }

  return (
    <div className="home">
      <StatTiles
        total={view.rows.length}
        totalSub={`${year}년 · 숨김 행 제외`}
        counts={view.counts}
      />

      <div className="grid2">
        <Panel title="다가오는 행사" action={MoreLink} footer={`가까운 순 ${view.upcoming.length}건`}>
          <EventList rows={view.upcoming} dateField={view.dateField} legend={data.legend}
            empty="예정된 행사가 없습니다." />
        </Panel>

        <Panel title="최근 종료" action={MoreLink} footer="결과보고서 확인용">
          <EventList rows={view.past} dateField={view.dateField} legend={data.legend}
            empty="지난 행사가 없습니다." />
        </Panel>
      </div>

      {view.undated > 0 && (
        <p className="hint">일정이 정해지지 않은 행사 {view.undated}건은 목록에서 확인할 수 있습니다.</p>
      )}
    </div>
  );
}

/** 탭 하나를 홈에 필요한 형태로 줄입니다. (숨김 행 제외) */
function summarize(tab, legend) {
  if (!tab) return null;
  const rows = tab.rows.filter((r) => !r._hidden);
  const dateField = tab.headers.includes('일정') ? '일정' : null;
  const today = todayKey();

  const dated = rows
    .map((r) => ({ ...r, _key: dateField ? scheduleKey(r[dateField]) : null }))
    .filter((r) => r._key !== null);

  return {
    rows,
    dateField,
    upcoming: dated.filter((r) => r._key >= today).sort((a, b) => a._key - b._key).slice(0, 5),
    past: dated.filter((r) => r._key < today).sort((a, b) => b._key - a._key).slice(0, 3),
    undated: rows.length - dated.length,
    counts: legend
      .map((l) => ({ ...l, n: rows.filter((r) => r._fill === l.color).length }))
      .filter((l) => l.n > 0)
  };
}
