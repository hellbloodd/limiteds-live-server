// Shared by every page: registers the service worker (installable app + notifications) and adds
// window.avEnableAlerts() for the "Phone alerts" button.
(() => {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});

  const toKey = (b64) => {
    const s = atob((b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  // Returns a message for the user.
  window.avEnableAlerts = async () => {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) return "On iPhone: tap Share → Add to Home Screen, open Agony Values from the home screen, then tap this again.";
    if (!("PushManager" in window) || !("Notification" in window)) return "This browser can't do notifications.";
    let key = ""; try { key = localStorage.getItem("ownerKey") || ""; } catch { /* private mode */ }
    if (!key) { key = prompt("Phone alerts are for the owner — enter your OWNER_KEY:") || ""; try { localStorage.setItem("ownerKey", key); } catch { /* ignore */ } }
    if (!key) return "Alerts need your owner key.";
    if ((await Notification.requestPermission()) !== "granted") return "Notifications are blocked — allow them in the browser/app settings.";
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch("/api/push/key")).json();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
    const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json", "x-owner-key": key }, body: JSON.stringify(sub) });
    if (r.status === 401) return "Wrong owner key.";
    if (!r.ok) return "Couldn't turn alerts on — try again.";
    await fetch("/api/push/test", { method: "POST", headers: { "x-owner-key": key } });
    return "Phone alerts are on ✓ — a test notification is on its way.";
  };
})();
