import { useEffect, useState } from 'react';

const read = (fallback) => window.location.hash.replace(/^#\/?/, '') || fallback;

/** 주소의 #/{id} 로 현재 페이지를 정합니다. 라우터 라이브러리 없이 뒤로가기까지 동작합니다. */
export function useHashRoute(fallback) {
  const [id, setId] = useState(() => read(fallback));

  useEffect(() => {
    const onChange = () => setId(read(fallback));
    window.addEventListener('hashchange', onChange);
    if (!window.location.hash) window.location.replace(`#/${fallback}`);
    return () => window.removeEventListener('hashchange', onChange);
  }, [fallback]);

  return [id, (next) => { window.location.hash = `#/${next}`; }];
}
