// Agony Values service worker: makes the site installable and shows push notifications.
// Pushes arrive empty (no payload), so we ask the server what the latest alert was.
// Offline-ready: pages and the theme files open instantly from the last copy and update in the
// background; public data is fetched fresh (3.5 s limit) and falls back to the last copy when offline
// or slow. Private (owner) requests are never stored.
const CACHE = "av-v2";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const OFFLINE = () => new Response(
  "<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:sans-serif;background:#05060f;color:#eee;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h2>You're offline</h2><p>Open this page once while online and it will work offline next time.</p></div>",
  { headers: { "Content-Type": "text/html" } });

async function put(req, res) {
  if (res && res.ok && res.type !== "opaqueredirect") { const c = await caches.open(CACHE); await c.put(req, res.clone()); }
  return res;
}
// cached copy right away, refreshed in the background
async function staleWhileRevalidate(e) {
  const cached = await caches.match(e.request);
  const fresh = fetch(e.request).then((r) => put(e.request, r)).catch(() => null);
  if (cached) { e.waitUntil(fresh); return cached; }
  return (await fresh) || (e.request.mode === "navigate" ? OFFLINE() : Response.error());
}
// fresh data if it arrives within 3.5 s, otherwise the last copy (and the fresh one is stored when it lands)
async function networkFirst(e) {
  const fresh = fetch(e.request).then((r) => put(e.request, r));
  e.waitUntil(fresh.catch(() => {}));
  const slow = new Promise((res) => setTimeout(res, 3500, "slow"));
  try {
    const r = await Promise.race([fresh, slow]);
    if (r !== "slow") return r;
    return (await caches.match(e.request)) || (await fresh);
  } catch {
    return (await caches.match(e.request)) || new Response(JSON.stringify({ error: "You're offline and this wasn't saved yet." }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || req.headers.get("x-owner-key")) return; // private / changing requests: straight to the network
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/push") || url.pathname === "/api/status" || url.searchParams.has("fresh")) return;
    if (url.pathname.startsWith("/api/")) return e.respondWith(networkFirst(e));
    if (req.mode === "navigate" || /\.(css|js|png|webmanifest)$/.test(url.pathname)) return e.respondWith(staleWhileRevalidate(e));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(staleWhileRevalidate(e));
});

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let n = { title: "Agony Values", body: "New alert — open the app.", url: "/flips" };
    try { n = { ...n, ...(await (await fetch("/api/push/latest", { cache: "no-store" })).json()) }; } catch { /* show the generic one */ }
    // Android shows "image" as a big picture under the text (like a Discord embed) and the item as the icon.
    await self.registration.showNotification(n.title, {
      body: n.body, icon: n.image || "/icons/icon-192.png", image: n.image || undefined, badge: "/icons/badge-96.png",
      tag: n.tag || `av-${n.at || Date.now()}`, data: { url: n.url || "/flips" }, requireInteraction: Boolean(n.image),
      actions: n.url && n.url.startsWith("http") ? [{ action: "buy", title: "🛒 Buy on Eldorado" }, { action: "flips", title: "💸 Flip Finder" }] : [],
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.action === "flips" ? "/flips" : e.notification.data?.url || "/flips";
  e.waitUntil((async () => {
    if (new URL(url, self.location.origin).origin !== self.location.origin) return self.clients.openWindow(url); // e.g. the Eldorado listing
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins[0]) { await wins[0].focus(); return wins[0].navigate ? wins[0].navigate(url) : null; }
    return self.clients.openWindow(url);
  })());
});
