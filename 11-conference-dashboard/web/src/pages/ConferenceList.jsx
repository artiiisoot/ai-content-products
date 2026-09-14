import React from 'react';
import { useLedger } from '../app/LedgerContext.jsx';
import { sheetUrl } from '../config.js';
import ListTable from '../components/ListTable.jsx';
import Matrix from '../components/Matrix.jsx';

/** 원장의 '라온참가' 탭을 목록으로 보여주는 페이지 */
export default function ConferenceList({ route }) {
  const { data, year } = useLedger();
  const tab = data.tabs.find((t) => t.year === year && t.kind === route.kind) ||
              data.tabs.find((t) => t.kind === route.kind);

  if (!tab) {
    return (
      <div className="panel">
        <div className="empty">
          <b>{year}_{route.kind}</b> 탭을 찾지 못했습니다.
          시트에 <code>연도_이름</code> 형식의 탭이 있어야 합니다.
        </div>
      </div>
    );
  }

  return tab.type === 'matrix'
    ? <Matrix tab={tab} sheetUrl={sheetUrl()} />
    : <ListTable tab={tab} legend={data.legend} sheetUrl={sheetUrl()} />;
}
