// Simple cache-first service worker
const CACHE = "noise-meter-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k === CACHE) ? null : caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // cache same-origin GET
        try{
          const url = new URL(req.url);
          if (req.method === "GET" && url.origin === location.origin){
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
          }
        }catch(e){}
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
