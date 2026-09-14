import { CONFIG } from '../config.js';
import { signIn, getToken, signOut, getExpiry } from './auth.js';
import { fetchLedger } from './sheets.js';
import { SAMPLE } from './sample.js';

export const isConfigured = () => Boolean(CONFIG.clientId);

/** 로그인 후 시트를 읽습니다. 클라이언트 ID 설정 전에는 샘플 데이터로 화면만 확인합니다. */
export async function loadData() {
  if (!isConfigured()) {
    return { ...SAMPLE, tabs: SAMPLE.tabs.filter((t) => CONFIG.visibleKinds.includes(t.kind)) };
  }
  if (!getToken()) await signIn();
  return fetchLedger();
}

export { signOut, getToken, getExpiry };
