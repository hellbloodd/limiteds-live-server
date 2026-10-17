// Agony Values service worker: makes the site installable and shows push notifications.
// Pushes arrive empty (no payload), so we ask the server what the latest alert was.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Network first; if offline, show a small notice for page loads.
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    "<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:sans-serif;background:#0b0a14;color:#eee;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h2>You're offline</h2><p>Agony Values needs a connection — try again in a moment.</p></div>",
    { headers: { "Content-Type": "text/html" } })));
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
