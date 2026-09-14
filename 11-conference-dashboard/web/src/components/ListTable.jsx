import React, { useMemo, useState } from 'react';
import { formatSchedule, scheduleKey, formatNumber, formatCost } from '../lib/format.js';

const HIDE = ['NO'];
const WIDE = ['행사명'];
/** 기본으로 보여줄 컬럼. 나머지는 '모든 컬럼'을 켜면 나옵니다. */
const PRIMARY = ['분류', '기업', '행사명', '일정', '주최', '주관', '형태', '비용', '방문자수', '장소', '참가자 세그먼트', '주제'];
const FILTERABLE = ['분류', '형태', '기업', '주최'];
const DATE_FIELDS = ['일정'];

const NUM_FIELDS = ['방문자수', '라온 참관객', '참관객'];
const COST_FIELDS = ['비용'];

export default function ListTable({ tab, legend, sheetUrl }) {
  const [q, setQ] = useState('');
  const [fills, setFills] = useState([]);
  const [picks, setPicks] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);   // 시트에서 숨긴 행은 기본으로 제외합니다
  const [sort, setSort] = useState({ key: null, dir: 1 });

  const allHeaders = tab.headers.filter((h) => !HIDE.includes(h));
  const headers = showAll ? allHeaders : allHeaders.filter((h) => PRIMARY.includes(h));
  const dateField = DATE_FIELDS.find((f) => allHeaders.includes(f));

  const usedLegend = useMemo(() => {
    const present = new Set(tab.rows.map((r) => r._fill));
    return legend.filter((l) => present.has(l.color));
  }, [tab, legend]);
  const labelOf = (fill) => usedLegend.find((l) => l.color === fill)?.label ?? '';

  const options = useMemo(() => {
    const out = {};
    FILTERABLE.filter((f) => allHeaders.includes(f)).forEach((f) => {
      out[f] = [...new Set(tab.rows.map((r) => r[f]).filter(Boolean))].sort();
    });
    return out;
  }, [tab, allHeaders]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    let out = tab.rows.filter((r) => {
      if (!showHidden && r._hidden) return false;
      if (fills.length && !fills.includes(r._fill)) return false;
      for (const [k, v] of Object.entries(picks)) if (v && r[k] !== v) return false;
      if (!term) return true;
      return allHeaders.some((h) => String(r[h] ?? '').toLowerCase().includes(term));
    });

    const key = sort.key ?? dateField;
    const dir = sort.key ? sort.dir : -1;   // 기본은 일정 최신순
    if (key) {
      const byDate = key === dateField;
      out = [...out].sort((a, b) => {
        if (byDate) {
          const ka = scheduleKey(a[key]), kb = scheduleKey(b[key]);
          // 일정이 비었거나 '-' 인 행은 방향과 상관없이 항상 뒤로 보냅니다
          if (ka === null || kb === null) return ka === kb ? 0 : (ka === null ? 1 : -1);
          return (ka - kb) * dir;
        }
        return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'ko') * dir;
      });
    }
    return out;
  }, [tab, q, fills, picks, sort, allHeaders, dateField, showHidden]);

  const toggleFill = (color) =>
    setFills((p) => (p.includes(color) ? p.filter((c) => c !== color) : [...p, color]));
  const clickHeader = (h) =>
    setSort((s) => (s.key === h ? { key: h, dir: -s.dir } : { key: h, dir: 1 }));
  const reset = () => {
    setQ(''); setFills([]); setPicks({}); setSort({ key: null, dir: 1 }); setShowHidden(false);
  };

  const hiddenCount = tab.rows.filter((r) => r._hidden).length;
  const visibleCount = tab.rows.length - hiddenCount;
  const cellClass = (h) => [
    WIDE.includes(h) ? 'wide' : '',
    NUM_FIELDS.includes(h) ? 'num' : '',
    COST_FIELDS.includes(h) ? 'cost' : ''
  ].filter(Boolean).join(' ') || undefined;

  const filtered = q || fills.length || Object.values(picks).some(Boolean) || showHidden;

  return (
    <div className="panel">
      <div className="bar">
        <input type="search" value={q} placeholder="행사명·주최·장소 검색"
          onChange={(e) => setQ(e.target.value)} />
        {Object.entries(options).map(([field, values]) => (
          <select key={field} value={picks[field] ?? ''}
            onChange={(e) => setPicks({ ...picks, [field]: e.target.value })}>
            <option value="">{field} 전체</option>
            {values.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ))}
        {filtered && <button className="btn" onClick={reset}>초기화</button>}
        <div className="spacer" />
        {hiddenCount > 0 && (
          <button className="chip" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}
            title="시트에서 숨긴 행입니다. 기본으로는 보여주지 않습니다.">
            숨김 행 포함 <span className="hint">{hiddenCount}</span>
          </button>
        )}
        <button className="chip" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
          모든 컬럼 {showAll ? allHeaders.length : `${headers.length}/${allHeaders.length}`}
        </button>
        <span className="hint">{rows.length} / {showHidden ? tab.rows.length : visibleCount}건</span>
      </div>

      {usedLegend.length > 0 && (
        <div className="bar">
          <span className="hint">상태</span>
          {usedLegend.map((l) => (
            <button key={l.color} className="chip" aria-pressed={fills.includes(l.color)}
              onClick={() => toggleFill(l.color)}>
              <span className="dot" style={{ background: l.color }} />
              {l.label}
              <span className="hint">{tab.rows.filter((r) => r._fill === l.color).length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tw">
        <table>
          <thead>
            <tr>
              {usedLegend.length > 0 && <th style={{ minWidth: 108 }}>상태</th>}
              {headers.map((h) => (
                <th key={h} onClick={() => clickHeader(h)}>
                  {h}
                  {sort.key === h && <span className="ord">{sort.dir > 0 ? '▲' : '▼'}</span>}
                  {!sort.key && h === dateField && <span className="ord">▼</span>}
                </th>
              ))}
              <th style={{ width: 46 }}>행</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r._row}
                className={[
                  r._hidden ? 'hiddenrow' : '',
                  dateField && scheduleKey(r[dateField]) === null ? 'nodate' : ''
                ].filter(Boolean).join(' ') || undefined}
                title={dateField && scheduleKey(r[dateField]) === null ? '일정이 정해지지 않은 행사입니다' : undefined}
              >
                {usedLegend.length > 0 && (
                  <td className="st">
                    <span className="dot" style={{ background: r._fill }} />
                    <span className="stlabel">{labelOf(r._fill)}</span>
                  </td>
                )}
                {headers.map((h) => (
                  <td key={h} className={cellClass(h)} title={r[h]}>
                    {COST_FIELDS.includes(h)
                      ? formatCost(r[h]).map((line, i) => (
                          <span key={i} className={line.nego ? 'costline nego' : 'costline'}>
                            {line.text}
                          </span>
                        ))
                      : (
                        <span className={h === dateField ? 'clamp nowrap' : 'clamp'}>
                          {h === dateField ? formatSchedule(r[h])
                            : NUM_FIELDS.includes(h) ? formatNumber(r[h])
                            : r[h]}
                        </span>
                      )}
                  </td>
                ))}
                <td className="num">
                  <a className="rowlink" href={`${sheetUrl}#gid=${tab.gid}&range=A${r._row}`}
                    target="_blank" rel="noreferrer"
                    title={r._hidden ? '시트에서 숨겨진 행입니다' : ''}>
                    {r._hidden ? '🙈' : ''}{r._row}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">조건에 맞는 행이 없습니다. 검색어나 필터를 지워보세요.</div>}
      </div>

      <div className="foot">
        <span>{tab.tab}</span>
        <span>
          기본 정렬은 일정 최신순입니다. 일정이 없는 행은 맨 뒤에 둡니다.
          {hiddenCount > 0 && ` 시트에서 숨긴 ${hiddenCount}건은 제외했습니다.`}
        </span>
      </div>
    </div>
  );
}
