import React, { useMemo, useState } from 'react';

/** 경쟁사 × 행사 매트릭스. 셀 내용은 발표자·부스 정보를 그대로 보여줍니다. */
export default function Matrix({ tab, sheetUrl }) {
  const [q, setQ] = useState('');
  const [onlyJoined, setOnlyJoined] = useState(false);
  const [showHidden, setShowHidden] = useState(false);   // 시트에서 숨긴 행은 기본 제외

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return tab.rows
      .filter((r) => (showHidden ? true : !r._hidden))
      .filter((r) => (onlyJoined ? r.참가건수 > 0 : true))
      .filter((r) => !term || r.경쟁사.toLowerCase().includes(term) ||
        r.cells.some((c) => c.toLowerCase().includes(term)));
  }, [tab, q, onlyJoined, showHidden]);

  const perEvent = useMemo(
    () => tab.columns.map((_, i) => tab.rows.filter((r) => r.cells[i]).length),
    [tab]
  );

  return (
    <div className="panel mx">
      <div className="bar">
        <input
          type="search"
          value={q}
          placeholder="경쟁사·발표자·주제 검색"
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="chip" aria-pressed={onlyJoined} onClick={() => setOnlyJoined(!onlyJoined)}>
          참가한 곳만
        </button>
        {tab.rows.some((r) => r._hidden) && (
          <button className="chip" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}>
            숨김 행 포함 <span className="hint">{tab.rows.filter((r) => r._hidden).length}</span>
          </button>
        )}
        <div className="spacer" />
        <span className="hint">경쟁사 {rows.length}곳 · 행사 {tab.columns.length}개</span>
      </div>

      <div className="tw">
        <table>
          <thead>
            <tr>
              <th className="co">경쟁사</th>
              {tab.columns.map((c, i) => (
                <th key={i}>
                  {c.행사명}
                  <span className="sub">{c.주최}{c.형태 ? ` · ${c.형태}` : ''} · {perEvent[i]}곳</span>
                </th>
              ))}
              <th>합계</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._row} className={r._hidden ? 'hiddenrow' : undefined}>
                <td className="co">{r.경쟁사}{r._hidden && <span className="hint"> 🙈</span>}</td>
                {r.cells.map((cell, i) => (
                  <td key={i} className="cell">
                    {cell
                      ? <span className="tag">참가</span>
                      : <span className="none">·</span>}
                    {cell && <span className="sub">{cell}</span>}
                  </td>
                ))}
                <td className="num">{r.참가건수}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">조건에 맞는 경쟁사가 없습니다.</div>}
      </div>

      <div className="foot">
        <span>{tab.tab}</span>
        <a href={`${sheetUrl}#gid=${tab.gid}`} target="_blank" rel="noreferrer">시트에서 보기</a>
      </div>
    </div>
  );
}
