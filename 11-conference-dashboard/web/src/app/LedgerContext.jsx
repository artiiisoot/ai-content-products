import React, { createContext, useContext } from 'react';

/** 원장 데이터를 하위 페이지에 내려줍니다. 페이지마다 다시 불러오지 않습니다. */
const Ctx = createContext(null);

export const LedgerProvider = ({ value, children }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;

export function useLedger() {
  const value = useContext(Ctx);
  if (!value) throw new Error('LedgerProvider 안에서만 쓸 수 있습니다');
  return value;
}
