/* 油电账本 · Service Worker
   目标：装到桌面后断网也能打开、能记录；接口请求永不缓存。
   策略：网络优先 + 缓存兜底。
   以前是「缓存优先」，结果服务器上已经是新版、手机上还是旧版
   （用户改了 vehicles.js、index.html，手机上却看不出变化），所以改成现在这样。 */
const CACHE = 'er-shell-v53';
const SHELL = [
  './',
  './index.html',
  './guide.js',
  './vehicles.js',
  './supabase-sync.js',
  './vendor/chart-lite.js',
  './vendor/xlsx-lite.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域请求（Supabase 接口）交给浏览器自己处理，不进缓存
  if (url.origin !== self.location.origin) return;
  // 接口：永远走网络，绝不缓存（同步必须拿到最新数据）
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航 + 静态资源：网络优先，取不到才用缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (req.mode === 'navigate') {
            return caches.match('./index.html').then((r) => r || caches.match('./'));
          }
          return Response.error();
        })
      )
  );
});
