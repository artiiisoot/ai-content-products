import React from 'react';
import { ROUTES } from './routes.js';

/** 대시보드 껍데기 — 좌측 페이지 목록 + 상단 바 + 본문(children) */
export default function Shell({ routeId, onNavigate, year, years, onYear, right, children }) {
  const route = ROUTES.find((r) => r.id === routeId) || ROUTES[0];

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <b>컨퍼런스 대시보드</b>
          <span>{year}</span>
        </div>

        <nav className="nav">
          {ROUTES.map((r) => (
            <button
              key={r.id}
              aria-current={r.id === route.id}
              onClick={() => onNavigate(r.id)}
              title={r.desc}
            >
              {r.label}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <span>원장: 컨퍼런스 운영 원장</span>
          <span>시트를 고치면 새로고침으로 반영됩니다</span>
        </div>
      </aside>

      <main className="main">
        <div className="top">
          <div>
            <h1>{route.label}</h1>
            <p>{route.desc}</p>
          </div>
          <div className="actions">
            {years.length > 1 && (
              <select value={year} onChange={(e) => onYear(e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y}년</option>)}
              </select>
            )}
            {right}
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
