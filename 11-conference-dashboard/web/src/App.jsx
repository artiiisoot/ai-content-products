import React, { useEffect, useMemo, useState } from 'react';
import { loadData, signOut, isConfigured, getToken, getExpiry } from './data/ledger.js';
import { sheetUrl } from './config.js';
import { ROUTES, DEFAULT_ROUTE } from './app/routes.js';
import { useHashRoute } from './app/useHashRoute.js';
import { LedgerProvider } from './app/LedgerContext.jsx';
import Shell from './app/Shell.jsx';

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(true);
  const [year, setYear] = useState(null);
  const [routeId, navigate] = useHashRoute(DEFAULT_ROUTE);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await loadData());
    } catch (e) {
      if (e?.needLogin) { signOut(); setData(null); }
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // 팝업은 클릭에서만 열 수 있어 자동 로그인은 하지 않습니다.
  // 세션에 살아 있는 토큰이 있으면 새로고침해도 바로 불러옵니다.
  useEffect(() => {
    if (!isConfigured() || getToken()) load();
    else setBusy(false);
  }, []);

  const years = useMemo(() => [...new Set((data?.tabs ?? []).map((t) => t.year))].sort(), [data]);
  const activeYear = year ?? years[years.length - 1] ?? null;
  const route = ROUTES.find((r) => r.id === routeId) || ROUTES[0];
  const expiry = data ? getExpiry() : null;

  if (!data) {
    return (
      <div className="gate">
        <h1>컨퍼런스 대시보드</h1>
        {busy && <p className="hint">불러오는 중…</p>}
        {!busy && (
          <>
            <p className="hint">
              {error
                ? `불러오지 못했습니다. ${error}`
                : '구글 계정으로 로그인하면 원장 시트를 읽어옵니다. 시트를 볼 수 있는 계정만 조회됩니다.'}
            </p>
            <button className="btn primary" onClick={load}>구글 계정으로 로그인</button>
            {!isConfigured() && (
              <p className="hint">
                OAuth 클라이언트 ID가 없습니다. <code>web/.env</code> 의 <code>VITE_GOOGLE_CLIENT_ID</code> 를 채우면 실제 시트를 읽습니다.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  const Page = route.element;

  return (
    <LedgerProvider value={{ data, year: activeYear, reload: load, busy }}>
      <Shell
        routeId={route.id}
        onNavigate={navigate}
        year={activeYear}
        years={years}
        onYear={setYear}
        right={
          <>
            <span className="hint">
              {expiry && `세션 ${expiry.getHours()}:${String(expiry.getMinutes()).padStart(2, '0')}까지`}
              {busy && ' · 읽는 중…'}
            </span>
            <button className="btn" onClick={load}>새로고침</button>
            <a className="btn" href={sheetUrl()} target="_blank" rel="noreferrer">시트 열기</a>
            {getToken() && <button className="btn" onClick={() => { signOut(); setData(null); }}>로그아웃</button>}
          </>
        }
      >
        <Page route={route} />
      </Shell>
    </LedgerProvider>
  );
}
