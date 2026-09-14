import React from 'react';
import { formatSchedule, formatCost } from '../lib/format.js';

/** 행사 요약 줄 목록. 홈처럼 좁은 자리에서 몇 건만 보여줄 때 씁니다. */
export default function EventList({ rows, dateField, legend = [], empty = '표시할 행사가 없습니다.' }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  const label = (fill) => legend.find((l) => l.color === fill)?.label ?? '';

  return (
    <div className="rows">
      {rows.map((r) => (
        <div className="row" key={r._row}>
          <span className="dot" style={{ background: r._fill }} title={label(r._fill)} />
          <div className="grow">
            <b>{r['행사명']}</b>
            <div className="meta">
              {dateField && formatSchedule(r[dateField])}
              {r['장소'] && ` · ${r['장소']}`}
              {r['주최'] && ` · ${r['주최']}`}
            </div>
          </div>
          <span className="cost">{formatCost(r['비용'])[0]?.text}</span>
        </div>
      ))}
    </div>
  );
}
