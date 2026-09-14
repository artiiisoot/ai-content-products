import React from 'react';

/** 제목 + 본문 + 바닥글을 가진 카드 */
export default function Panel({ title, action, footer, children }) {
  return (
    <div className="panel">
      {(title || action) && (
        <div className="panel-h">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
      {footer && <div className="foot"><span>{footer}</span></div>}
    </div>
  );
}
