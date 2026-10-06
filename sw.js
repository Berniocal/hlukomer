const CACHE = "noise-meter-v23";
const ASSETS = [
  "./",
  "./index.html?v=23",
  "./acoustic-math.js?v=23",
  "./app.js?v=23",
  "./timed.js?v=23",
  "./calibration-profiles.js?v=23",
  "./calibration-track.js?v=23",
  "./manifest.webmanifest?v=23",
  "./testy.html",
  "./synthetic-tests.js?v=23",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async url => {
      const response = await fetch(url, { cache: "reload" });
      if (!response.ok) throw new Error(`Nepodařilo se načíst ${url}`);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(windows.map(client => client.navigate(client.url).catch(() => null)));
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const coreFile = url.origin === location.origin && (
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/testy.html") ||
    url.pathname.endsWith("/acoustic-math.js") ||
    url.pathname.endsWith("/synthetic-tests.js") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/timed.js") ||
    url.pathname.endsWith("/calibration-profiles.js") ||
    url.pathname.endsWith("/calibration-track.js") ||
    url.pathname.endsWith("/")
  );

  if (coreFile) {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
      }
      return res;
    }))
  );
});
