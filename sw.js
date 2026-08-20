/* ============================================================
   서비스 워커 — 앱 껍데기를 캐시해서 오프라인에서도 열리게 합니다.
   일정 데이터 자체는 구글 API 응답이라 캐시하지 않고,
   앱이 localStorage 에 넣어둔 마지막 상태를 보여줍니다.
   ============================================================ */

const CACHE = 'planner-v55';
const SHELL = [
  './',
  './index.html',
  './app.css?v=55',
  './app.js?v=55',
  './config.js?v=55',
  './korean-calendar.js?v=55',
  './diary.js?v=55',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 구글 API·로그인 요청은 절대 캐시하지 않습니다
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  /* 첫 페이지(index.html)는 ?v= 를 붙일 수 없는 유일한 파일이라,
     브라우저 캐시까지 건너뛰고 항상 새로 받아옵니다.
     이게 없으면 새 탭을 추가해도 폰에서는 예전 화면이 계속 나옵니다. */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'reload' })
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // 앱 파일: 네트워크 우선, 실패하면 캐시 (배포 후 갱신이 바로 반영되도록)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
