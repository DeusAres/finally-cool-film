// Offline: the app opens without a network (an iPhone reloading the page offline used to get an error page).
// - install: the whole deployed app is cached (PRECACHE: the page, every script as the pages request it (stamped ?v=<id>), the
//   wasm engine, the film data), written in by scripts/stamp-version.sh at deploy; a new deploy is a new worker and a new cache;
// - the page itself: network first (online it is always the latest, as before), the cached one when the network fails;
// - scripts, wasm, data, fonts: the exact URL from the cache, else the network (and kept); offline, any cached version of it;
// - version.txt (app.js checkUpdate): never cached, so an update is still noticed online and simply fails offline.
const VERSION = '__BUILD_ID__';
const PRECACHE = /*__PRECACHE__*/[];
const CACHE = `fcf-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fcf-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => {
  if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.endsWith('/version.txt')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => keep(req, res))
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))
    .catch(() => caches.match(req, { ignoreSearch: true }).then((old) => old || Response.error()))));
});
