/* Cloudflare static shell SW — network-first, additive, zero-risk to dynamic routes */
// 4.82: SHELL 补上 /styles-2.css(主页面第二个样式表,之前漏了 → 首次离线访问缺样式)。
// 注意改此列表要同步递增 CACHE 版本号,否则旧缓存不会刷新。
const CACHE = 'cfw-shell-v2';
const SHELL = [
  '/',
  '/styles.css',
  '/styles-2.css',
  '/manifest.json',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Never intercept dynamic/back-end routes — keeps API/sync/images/config live.
function isBypassed(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/sync') ||
    url.pathname.startsWith('/img/') ||
    url.pathname === '/config.js'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url)) return;

  // SPA navigations: try network, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // Static assets: network-first, cache the fresh copy, fall back to cache offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
