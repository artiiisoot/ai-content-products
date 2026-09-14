import React from 'react';

/** 요약 타일. 첫 칸은 총계, 나머지는 시트 범례(색+문구) 기준 건수 */
export default function StatTiles({ total, totalLabel = '전체', totalSub, counts = [] }) {
  return (
    <div className="strip">
      <div className="cell">
        <span className="k">{totalLabel}</span>
        <span className="v">{total}<small>건</small></span>
        {totalSub && <span className="sub">{totalSub}</span>}
      </div>
      {counts.map((c) => (
        <div className="cell" key={c.color}>
          <span className="k"><span className="dot" style={{ background: c.color }} /> {c.label}</span>
          <span className="v">{c.n}<small>건</small></span>
        </div>
      ))}
    </div>
  );
}
