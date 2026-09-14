import { CONFIG } from '../config.js';

/**
 * 구글 로그인(GIS). 액세스 토큰을 sessionStorage 에 둡니다.
 * - 탭을 닫으면 사라지고, 다른 탭/창과 공유되지 않습니다.
 * - 만료 시각을 함께 저장해 만료된 토큰은 쓰지 않습니다.
 * - 구글이 주는 토큰 수명은 보통 1시간입니다. MAX_AGE 는 우리가 두는 상한선입니다.
 */
const STORE_KEY = 'conference-viewer-token';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;   // 2시간 상한
const SKEW_MS = 60 * 1000;               // 만료 1분 전에는 만료로 취급

let client = null;

function read() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    if (!saved?.token || !saved?.expiresAt) return null;
    if (Date.now() > saved.expiresAt - SKEW_MS) { sessionStorage.removeItem(STORE_KEY); return null; }
    return saved;
  } catch {
    return null;
  }
}

function write(token, expiresInSec) {
  const life = Math.min((Number(expiresInSec) || 3600) * 1000, MAX_AGE_MS);
  const saved = { token, expiresAt: Date.now() + life };
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* 저장 못 해도 동작은 합니다 */ }
  return saved;
}

const gisReady = () =>
  new Promise((resolve, reject) => {
    const ready = () => window.google?.accounts?.oauth2;
    if (ready()) return resolve();
    let waited = 0;
    const timer = setInterval(() => {
      if (ready()) { clearInterval(timer); resolve(); }
      else if ((waited += 100) > 10000) { clearInterval(timer); reject(new Error('구글 로그인 스크립트를 불러오지 못했습니다')); }
    }, 100);
  });

/** 팝업은 반드시 사용자의 클릭에서 시작해야 합니다. 무음(prompt=none)은 브라우저가 막습니다. */
export async function signIn() {
  if (!CONFIG.clientId) throw new Error('OAuth 클라이언트 ID가 없습니다 (web/.env 의 VITE_GOOGLE_CLIENT_ID)');
  await gisReady();

  return new Promise((resolve, reject) => {
    client = client || window.google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.clientId,
      scope: CONFIG.scope,
      callback: (res) => {
        if (res.error) return reject(new Error(res.error_description || res.error));
        resolve(write(res.access_token, res.expires_in).token);
      },
      error_callback: (err) => reject(new Error(err?.message || '로그인이 취소되었습니다'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function getToken() {
  return read()?.token || null;
}

/** 세션 만료 시각 (없으면 null) */
export function getExpiry() {
  const saved = read();
  return saved ? new Date(saved.expiresAt) : null;
}

export function signOut() {
  const token = getToken();
  if (token) window.google?.accounts?.oauth2?.revoke(token, () => {});
  sessionStorage.removeItem(STORE_KEY);
}
