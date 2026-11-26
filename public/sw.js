/* English Trainer 오프라인 캐시
 * - 앱 화면·스크립트·데이터는 먼저 네트워크(최신 배포)를 쓰고, 4초 안에 안 오거나 오프라인이면 저장해 둔 것으로 연다.
 * - /api/* (학습 이력 동기화·AI·받아쓰기)는 캐시하지 않는다. 오프라인일 때는 앱이 기기에 저장해 두었다가 연결되면 올린다.
 */
const CACHE = "et-v1";
const CORE = ["/", "/index.html", "/assets/app.js", "/assets/style.css", "/data/scenarios.js", "/data/drills.js", "/data/tenses.js", "/data/monologues.js", "/data/curriculum.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = req.mode === "navigate" ? "/index.html" : req;
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    if (res && res.ok && res.type === "basic") cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;   // 다른 사이트·API 는 브라우저 기본 동작
  e.respondWith(networkFirst(req));
});
