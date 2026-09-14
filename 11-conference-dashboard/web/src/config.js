/** 배포 설정. clientId 는 구글 클라우드 콘솔에서 발급받아 넣습니다. */
export const CONFIG = {
  // OAuth 2.0 클라이언트 ID (웹 애플리케이션). 예: '1234-abcd.apps.googleusercontent.com'
  clientId: (import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || '',

  // 컨퍼런스 운영 원장
  spreadsheetId: '1pKz_RvXf4ZJ784m9LXAiYvKxOWPsi1fWp8g7Sa8O5rU',

  // 화면에 올릴 탭 종류. '연도_이름' 에서 이름 부분
  visibleKinds: ['라온참가'],

  // 시트 읽기 전용 권한만 요청합니다
  scope: 'https://www.googleapis.com/auth/spreadsheets.readonly'
};

export const sheetUrl = (gid) =>
  `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/edit${gid != null ? `#gid=${gid}` : ''}`;
