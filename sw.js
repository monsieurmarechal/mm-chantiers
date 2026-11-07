// Service worker : met en cache l'interface (pas les données).
const CACHE = "mm-chantiers-v2";
const ASSETS = [
  "./", "./index.html", "./css/app.css", "./manifest.webmanifest",
  "./js/app.js", "./js/core.js", "./js/config.js", "./js/geo.js", "./js/missions.js", "./js/hr.js", "./js/admin.js",
  "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Réseau d'abord pour les fichiers de l'app (mises à jour immédiates), cache en secours.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache : revalidation systématique auprès du serveur (mises à jour immédiates)
    fetch(e.request, { cache: "no-cache" }).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
