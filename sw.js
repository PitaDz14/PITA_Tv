// PITA TV service worker — شبكة أولًا لصفحة الموقع حتى تصل التحديثات فورًا، وتخزين احتياطي عند انقطاع الإنترنت.
const CACHE_NAME = 'pita-tv-v2';
const SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // لا نتدخل في البث ولا في الطلبات الخارجية ولا في ملفات الروابط المتغيرة
  if (url.origin !== location.origin || /\/(streams|stream\.json)/.test(url.pathname)) return;
  event.respondWith(
    fetch(req).then(res => {
      if (res.ok && (req.mode === 'navigate' || SHELL.some(p => url.pathname.endsWith(p.replace('./', '/'))))) {
        const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
