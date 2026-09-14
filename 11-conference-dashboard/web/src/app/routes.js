import Home from '../pages/Home.jsx';
import ConferenceList from '../pages/ConferenceList.jsx';

/**
 * 대시보드의 하위 페이지 목록.
 * 페이지를 추가하려면 pages/ 에 컴포넌트를 만들고 여기에 한 줄 넣으면 됩니다.
 * 주소는 #/{id} 로 잡힙니다.
 */
export const ROUTES = [
  {
    id: 'home',
    label: '홈',
    desc: '참가 현황 요약',
    source: '라온참가',        // 요약에 쓰는 원장 탭 종류
    element: Home
  },
  {
    id: 'conferences',
    label: '컨퍼런스 조회',
    desc: '참가·검토 중인 행사 목록',
    kind: '라온참가',          // 이 페이지가 쓰는 원장 탭 종류
    element: ConferenceList
  }
];

export const DEFAULT_ROUTE = ROUTES[0].id;
