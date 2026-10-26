// Shared by every page: registers the service worker (installable app + notifications) and adds
// window.avEnableAlerts() for the "Phone alerts" button.
(() => {
  // phones: the menu scrolls sideways - start with the current page's tab in view
  addEventListener("DOMContentLoaded", () => document.querySelector(".tabs .tab.active")?.scrollIntoView({ inline: "center", block: "nearest" }));
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

// ---------- Favourites (★) ----------
// Synced through the site when the owner key is set (phone + PC share them), else kept in this browser.
(() => {
  const ownerKey = () => { try { return localStorage.getItem("ownerKey") || ""; } catch { return ""; } };
  const local = () => { try { return JSON.parse(localStorage.getItem("favs") || "[]"); } catch { return []; } };
  let list = local();
  window.avFavs = new Set(list.map((f) => `${f.game}|${f.key}`));
  const persist = async () => {
    try { localStorage.setItem("favs", JSON.stringify(list)); } catch { /* ignore */ }
    if (ownerKey()) await fetch("/api/favourites", { method: "POST", headers: { "Content-Type": "application/json", "x-owner-key": ownerKey() }, body: JSON.stringify({ favourites: list }) }).catch(() => {});
  };
  window.avFavsReady = (async () => {
    if (!ownerKey()) return list;
    try {
      const r = await fetch("/api/favourites", { headers: { "x-owner-key": ownerKey() } });
      if (r.ok) {
        const remote = (await r.json()).favourites || [];
        const merged = [...remote, ...list.filter((f) => !remote.some((x) => x.game === f.game && x.key === f.key))];
        if (merged.length !== remote.length) { list = merged; persist(); } else list = remote;
        window.avFavs = new Set(list.map((f) => `${f.game}|${f.key}`));
      }
    } catch { /* offline */ }
    return list;
  })();
  window.avToggleFav = async (id, item) => {
    if (window.avFavs.has(id)) { list = list.filter((f) => `${f.game}|${f.key}` !== id); window.avFavs.delete(id); }
    else { list.push({ game: item.game, key: String(item.key), name: item.name, image: item.image || "", at: Date.now() }); window.avFavs.add(id); }
    await persist();
    return window.avFavs.has(id);
  };
  window.avFavList = () => list;
})();

// ---------- Global search (🔍 in the header, or press "/") ----------
(() => {
  const PAGE = { "MM2": "/mm2", "Blade Ball": "/bladeball", "Adopt Me": "/adoptme", "Steal a Brainrot": "/stealabrainrot" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = `
    .gs-btn { margin-left:auto; display:inline-flex; align-items:center; gap:6px; padding:7px 12px; border-radius:999px; border:1px solid var(--border, #2a2a3a); background:var(--surface, #12121c); color:var(--muted, #9aa); font:600 13px Manrope, sans-serif; cursor:pointer; }
    .gs-btn:hover { color:var(--text, #fff); border-color:var(--accent, #a78bfa); }
    .gs-btn kbd { font:700 10px "JetBrains Mono", monospace; border:1px solid var(--border, #333); border-radius:5px; padding:1px 5px; }
    .gs-wrap { position:fixed; inset:0; z-index:9999; background:#05040acc; backdrop-filter:blur(6px); display:flex; justify-content:center; align-items:flex-start; padding:10vh 16px 16px; }
    .gs-box { width:min(620px, 100%); background:var(--surface, #12121c); border:1px solid var(--border, #2a2a3a); border-radius:18px; box-shadow:0 30px 80px -30px #000; overflow:hidden; }
    .gs-box input { width:100%; box-sizing:border-box; border:none; outline:none; padding:16px 18px; font:600 16px Manrope, sans-serif; background:transparent; color:var(--text, #fff); border-bottom:1px solid var(--border, #2a2a3a); }
    .gs-res { max-height:60vh; overflow:auto; }
    .gs-res a { display:grid; grid-template-columns:40px 1fr auto; gap:12px; align-items:center; padding:9px 16px; color:var(--text, #fff); text-decoration:none; }
    .gs-res a:hover, .gs-res a.sel { background:var(--surface-2, #1b1b28); }
    .gs-res img { width:40px; height:40px; object-fit:contain; border-radius:8px; background:var(--surface-2, #1b1b28); }
    .gs-res .g { font-size:11px; color:var(--muted, #9aa); }
    .gs-res .p { font:700 13px "JetBrains Mono", monospace; }
    .gs-empty { padding:16px; color:var(--muted, #9aa); font-size:13px; }
    @media (max-width:640px) { .gs-btn span { display:none; } .gs-btn kbd { display:none; } }`;
  function open() {
    if (document.querySelector(".gs-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "gs-wrap";
    wrap.innerHTML = `<div class="gs-box" role="dialog" aria-label="Search items"><input type="search" placeholder="Search any item — MM2, Blade Ball, Adopt Me, Steal a Brainrot…" autocomplete="off"><div class="gs-res"><div class="gs-empty">Type at least 2 letters.</div></div></div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector("input"), res = wrap.querySelector(".gs-res");
    let timer, sel = -1;
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    input.addEventListener("keydown", (e) => {
      const links = [...res.querySelectorAll("a")];
      if (e.key === "Escape") close();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, Math.min(links.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))); links.forEach((l, n) => l.classList.toggle("sel", n === sel)); }
      if (e.key === "Enter" && links[Math.max(sel, 0)]) location.href = links[Math.max(sel, 0)].href;
    });
    input.addEventListener("input", () => {
      clearTimeout(timer); sel = -1;
      const q = input.value.trim();
      if (q.length < 2) { res.innerHTML = `<div class="gs-empty">Type at least 2 letters.</div>`; return; }
      timer = setTimeout(async () => {
        const { items } = await fetch(`/api/item-search?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ items: [] }));
        res.innerHTML = items.length ? items.map((i) => `<a href="${PAGE[i.game]}?item=${encodeURIComponent(i.key)}"><img src="${esc(i.image)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">
          <div><div>${esc(i.name)}${window.avFavs?.has(`${i.game}|${i.key}`) ? " ★" : ""}</div><div class="g">${esc(i.game)}${i.value ? ` · value ${Number(i.value).toLocaleString()}` : ""}</div></div>
          <div class="p">${i.usd ? "$" + Number(i.usd).toFixed(2) : ""}</div></a>`).join("") : `<div class="gs-empty">No item matches “${esc(q)}”.</div>`;
      }, 120);
    });
    input.focus();
  }
  window.avOpenSearch = open;
  addEventListener("DOMContentLoaded", () => {
    const top = document.querySelector("header .top");
    if (!top) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const b = document.createElement("button");
    b.className = "gs-btn"; b.type = "button"; b.innerHTML = `🔍 <span>Search items</span> <kbd>/</kbd>`;
    b.addEventListener("click", open);
    top.appendChild(b);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) { e.preventDefault(); open(); }
  });
})();

// ---------- liquid glass effects: light follows the pointer, panels rise in, neon orbs ----------
(() => {
  const GLASS = ".panel, .tile, .card, .tbl, .dc, .tile-link, .fc, .side, .verdict, .snipes, .chart-panel, .controls, .tiles4 > div, .c-stats > div";
  addEventListener("pointermove", (e) => {
    const el = e.target.closest?.(GLASS);
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, { passive: true });
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const io = !reduce && "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }), { rootMargin: "0px 0px -6% 0px" }) : null;
  let n = 0;
  const reveal = (root = document) => {
    if (!io) return;
    root.querySelectorAll?.(`${GLASS}, .hero, h2`).forEach((el) => {
      if (el.classList.contains("reveal") || el.closest("dialog, #grid, .tbl, .feed, .bars")) return; // long lists: no per-item animation
      el.classList.add("reveal"); el.style.transitionDelay = `${Math.min(n++ % 12, 11) * 45}ms`;
      io.observe(el);
    });
  };
  addEventListener("DOMContentLoaded", () => {
    for (const c of ["a", "b"]) { const o = document.createElement("div"); o.className = `neon-orb ${c}`; document.body.prepend(o); }
    reveal();
    // content drawn later (lists, cards) animates in too
    new MutationObserver((ms) => { n = 0; ms.forEach((m) => { if (m.target.closest?.("#grid, .tbl")) return; m.addedNodes.forEach((x) => x.nodeType === 1 && (x.matches?.(GLASS) ? reveal(x.parentNode) : reveal(x))); }); })
      .observe(document.body, { childList: true, subtree: true });
  });
})();


// ---------- install the app + offline notice ----------
(() => {
  let deferred = null;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  const dismissed = (() => { try { return localStorage.getItem("installDismissed") === "1"; } catch { return false; } })();
  const addButton = () => {
    if (standalone || dismissed || document.getElementById("install-btn")) return;
    const top = document.querySelector("header .top"); if (!top) return;
    const b = document.createElement("button");
    b.id = "install-btn"; b.type = "button"; b.textContent = "📲 Install app";
    b.style.cssText = "margin-left:8px;padding:7px 12px;border-radius:999px;border:1px solid rgba(139,92,246,.5);background:linear-gradient(135deg,rgba(139,92,246,.35),rgba(34,211,238,.18));color:#fff;font:600 12px Manrope,sans-serif;cursor:pointer;box-shadow:0 0 16px -6px rgba(139,92,246,.9);white-space:nowrap";
    b.onclick = async () => {
      if (deferred) { deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; if (r?.outcome === "accepted") b.remove(); return; }
      if (ios) alert("To install: tap the Share button (square with an arrow) at the bottom of Safari, then \"Add to Home Screen\".");
    };
    b.oncontextmenu = (e) => { e.preventDefault(); try { localStorage.setItem("installDismissed", "1"); } catch { /* ignore */ } b.remove(); };
    b.title = "Install Agony Values as an app (right-click / long-press to hide this button)";
    top.appendChild(b);
  };
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; if (document.readyState !== "loading") addButton(); else addEventListener("DOMContentLoaded", addButton); });
  addEventListener("appinstalled", () => document.getElementById("install-btn")?.remove());
  if (ios && !standalone) addEventListener("DOMContentLoaded", addButton);

  // small pill while offline: the page is showing its last saved data
  const pill = () => {
    let el = document.getElementById("offline-pill");
    if (navigator.onLine) { el?.remove(); return; }
    if (el) return;
    el = document.createElement("div");
    el.id = "offline-pill"; el.textContent = "Offline — showing the last saved data";
    el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50;padding:8px 14px;border-radius:999px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.5);color:#fde68a;font:600 12px Manrope,sans-serif;backdrop-filter:blur(10px)";
    document.body.appendChild(el);
  };
  addEventListener("online", pill); addEventListener("offline", pill); addEventListener("DOMContentLoaded", pill);
})();


// ---------- navigation: one grouped menu for every page ----------
// Desktop: a sectioned sidebar. Phones/tablets: a bottom tab bar (Home, Values, Deals, Search, Menu)
// with a slide-up sheet. Built here so every page has the same, up-to-date menu.
(() => {
  const NAV = [
    ["Overview", [["/", "🏠", "Home"], ["/favourites", "★", "Favourites"], ["/status", "🟢", "Status"]]],
    ["Values", [["/mm2", "🔪", "MM2", "mm2"], ["/bladeball", "⚔️", "Blade Ball", "bladeball"], ["/adoptme", "🐉", "Adopt Me", "adoptme"], ["/stealabrainrot", "🧠", "Steal a Brainrot", "stealabrainrot"]]],
    ["Market", [["/flips", "💸", "Flip Finder"], ["/movers", "📈", "Movers & deals"], ["/gaps", "📊", "Value gaps"], ["/compare", "🆚", "Compare"], ["/currency", "💱", "Currency"]]],
    ["Events", [["/seasons", "🎃", "Seasons"], ["/calendar", "📅", "Calendar"]]],
    ["My trading", [["/trade", "⚖️", "Trade calculator"], ["/alerts", "🔔", "Price alerts"], ["/watch", "🏷️", "My listings"], ["/profits", "📒", "Profits"], ["/portfolio", "💼", "Portfolio"]]],
  ];
  const here = location.pathname.replace(/\/$/, "") || "/";
  const isOn = (href) => (href === "/" ? here === "/" : here === href);
  const e = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  const build = () => {
    const nav = document.querySelector("nav.tabs");
    if (nav) nav.innerHTML = NAV.map(([sec, links]) => `<div class="nav-sec"><div class="nav-h">${e(sec)}</div>${links.map(([href, ic, label, tab]) =>
      `<a class="tab${isOn(href) ? " active" : ""}" href="${href}"${tab ? ` data-tab="${tab}"` : ""}><span class="ni">${ic}</span>${e(label)}</a>`).join("")}</div>`).join("");
    if (document.querySelector(".av-bottom")) return;
    const valuesOn = ["/mm2", "/bladeball", "/adoptme", "/stealabrainrot"].includes(here), dealsOn = ["/flips", "/movers", "/gaps"].includes(here);
    const bar = document.createElement("nav");
    bar.className = "av-bottom"; bar.setAttribute("aria-label", "Main");
    bar.innerHTML = `<a href="/" class="${here === "/" ? "on" : ""}"><span class="bi">🏠</span>Home</a>
      <button type="button" data-sheet="Values" class="${valuesOn ? "on" : ""}"><span class="bi">💎</span>Values</button>
      <a href="/movers" class="${dealsOn ? "on" : ""}"><span class="bi">🔥</span>Deals</a>
      <button type="button" data-search><span class="bi">🔍</span>Search</button>
      <button type="button" data-sheet="all" class="${!valuesOn && !dealsOn && here !== "/" ? "on" : ""}"><span class="bi">☰</span>Menu</button>`;
    const sheet = document.createElement("div");
    sheet.className = "av-sheet";
    const fill = (only) => { sheet.innerHTML = `<div class="sh"><div class="grab"></div>${NAV.filter(([sec]) => only === "all" || sec === only).map(([sec, links]) =>
      `<h4>${e(sec)}</h4><div class="gridm">${links.map(([href, ic, label]) => `<a href="${href}" class="${isOn(href) ? "on" : ""}"><span class="ni">${ic}</span>${e(label)}</a>`).join("")}</div>`).join("")}</div>`; };
    bar.addEventListener("click", (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-search")) { window.avOpenSearch?.(); return; }
      fill(b.dataset.sheet); sheet.classList.add("open");
    });
    sheet.addEventListener("click", (ev) => { if (ev.target === sheet || ev.target.closest("a")) sheet.classList.remove("open"); });
    addEventListener("keydown", (ev) => { if (ev.key === "Escape") sheet.classList.remove("open"); });
    document.body.append(bar, sheet);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", build); else build();
})();
