// Deals page: the tabs next to "Flips & snipes" (which is the page's own content). Each tab is a view of
// /api/market-deals (fair price, under recent sales, bulk) or /api/sale-movers, filtered here.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  const $m = (n) => (n == null ? "—" : "$" + Number(n).toFixed(n >= 1000 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  const fmt = (n) => (n == null ? "—" : Number(n) >= 1000 ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(Number(n).toPrecision(3)).toLocaleString());
  const PAGE = { "MM2": "/mm2", "Blade Ball": "/bladeball", "Adopt Me": "/adoptme", "Steal a Brainrot": "/stealabrainrot" };
  const GC = { "MM2": "#8b5cf6", "Blade Ball": "#22d3ee", "Adopt Me": "#e879f9", "Steal a Brainrot": "#3b82f6" };
  const TABS = ["flips", "fair", "under", "bulk", "movers"];
  const SUB = {
    flips: "Buy the cheapest listing and relist just under the next one, after the seller fee — plus live snipes.",
    fair: "Items whose cheapest listing anywhere is far under their fair price (what items of similar value cost), cross-checked with a second value site.",
    under: "Listings well under what the item actually sold for this week.",
    bulk: "Buying several of the cheapest units and reselling them at the typical sale price still pays.",
    movers: "Biggest gains and drops in average Eldorado sale price.",
  };
  const style = document.createElement("style");
  style.textContent = `
    .deal-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 16px; }
    .deal-tabs a { padding:8px 14px; border-radius:999px; font:600 13px "Manrope", sans-serif; color:var(--muted); text-decoration:none; background:rgba(20,22,50,.5); border:1px solid rgba(140,150,255,.18); }
    .deal-tabs a.on { color:#fff; border-color:rgba(139,92,246,.75); background:linear-gradient(135deg, rgba(139,92,246,.5), rgba(59,130,246,.25)); box-shadow:0 0 14px -4px rgba(139,92,246,.8); }
    .dv-ctl { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 14px; }
    .dv-ctl button { font:600 12px "Manrope", sans-serif; padding:7px 13px; border-radius:999px; background:rgba(20,22,50,.5); border:1px solid rgba(140,150,255,.2); color:var(--muted); cursor:pointer; }
    .dv-ctl button.on { color:#fff; border-color:rgba(139,92,246,.75); background:linear-gradient(135deg, rgba(139,92,246,.5), rgba(59,130,246,.25)); }
    .dv-ctl select, .dv-ctl input { padding:7px 10px; font-size:12px; }
    .dv-list { display:flex; flex-direction:column; gap:4px; padding:10px; }
    .dv-row { display:grid; grid-template-columns:24px 40px minmax(0, 1fr) auto; gap:2px 10px; align-items:center; padding:9px 8px; border-radius:12px; color:var(--text); text-decoration:none; }
    .dv-row:hover { background:rgba(139,92,246,.1); }
    .dv-row .rk { font:700 12px "JetBrains Mono", monospace; color:#6c7398; grid-row:span 2; text-align:center; }
    .dv-row img { width:40px; height:40px; object-fit:contain; border-radius:10px; background:rgba(255,255,255,.05); grid-row:span 2; }
    .dv-row .n { font-weight:800; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .dv-row .s { font-size:11.5px; color:var(--muted); line-height:1.45; }
    .dv-row .p { grid-row:span 2; text-align:right; }
    .dv-row .p b { display:block; font:700 15px "JetBrains Mono", monospace; }
    .dv-row .p span { font-size:11px; color:var(--muted); }
    .dv-row .warn { color:#fbbf24; } .dv-row .ok { color:#6ee7b7; }
    .gd { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; background:var(--gc); box-shadow:0 0 6px var(--gc); }
    .dv-cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    @media (max-width:900px) { .dv-cols { grid-template-columns:1fr; } }
    .dv-note { font-size:12px; color:var(--muted); margin:10px 2px 0; line-height:1.5; }
    .dv-col h2 { margin:6px 8px 6px; font:700 14px "Unbounded", sans-serif; }`;
  document.head.appendChild(style);

  const saved = (() => { try { return JSON.parse(localStorage.getItem("dealsTabs") || "{}"); } catch { return {}; } })();
  const st = { game: saved.game || "", minp: saved.minp ?? "1", dir: "under", period: saved.period || "24h", hideDisputed: saved.hideDisputed ?? true, q: "" };
  let deals = null, movers = {};
  const save = () => { try { localStorage.setItem("dealsTabs", JSON.stringify({ game: st.game, minp: st.minp, period: st.period, hideDisputed: st.hideDisputed })); } catch { /* private mode */ } };
  const getJson = (u) => fetch(u).then((r) => r.json()).catch(() => null);

  const controls = (extra = "") => `<div class="dv-ctl">
      <select data-k="game"><option value="">All games</option>${Object.keys(PAGE).map((g) => `<option${st.game === g ? " selected" : ""}>${g}</option>`).join("")}</select>
      <select data-k="minp">${[["0", "any price"], ["1", "$1+"], ["5", "$5+"], ["20", "$20+"], ["100", "$100+"]].map(([v, l]) => `<option value="${v}"${st.minp === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      <input data-k="q" type="search" placeholder="Search…" value="${esc(st.q)}" style="width:150px">${extra}</div>`;
  const keep = (r, price) => (!st.game || r.game === st.game) && price >= Number(st.minp) && (!st.q || r.name.toLowerCase().includes(st.q.toLowerCase()));
  const row = (r, n, href, right, sub, external = false) => `<a class="dv-row" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ""}>
      <span class="rk">${n + 1}</span><img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">
      <div class="n">${esc(r.name)}</div><div class="p">${right}</div><div class="s"><span class="gd" style="--gc:${GC[r.game]}"></span>${esc(r.game)} · ${sub}</div></a>`;
  const secondNote = (r) => (r.v2 == null ? `<span class="dim">no 2nd source</span>`
    : Math.abs(r.diff) < 15 ? `<span class="ok">✓ ${esc(r.source2)} agrees</span>`
    : `<span class="${Math.abs(r.diff) >= 50 ? "warn" : ""}">${Math.abs(r.diff) >= 50 ? "⚠ " : ""}${esc(r.source2)} ${r.diff > 0 ? "+" : ""}${r.diff}%</span>`);

  function drawFair(out) {
    const list = (st.dir === "under" ? deals.fairUnder : deals.fairOver)
      .filter((r) => keep(r, r.buy) && (st.dir !== "under" || !st.hideDisputed || (!r.suspect && !(r.diff <= -50)))).slice(0, 150);
    out.innerHTML = controls(`<span style="width:6px"></span><button data-dir="under" class="${st.dir === "under" ? "on" : ""}">🟢 Underpriced</button><button data-dir="over" class="${st.dir === "over" ? "on" : ""}">🔴 Overpriced</button>
        ${st.dir === "under" ? `<label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="hideDisputed"${st.hideDisputed ? " checked" : ""} style="width:auto;padding:0"> hide disputed / suspicious</label>` : ""}`)
      + `<section class="card dv-list">${list.map((r, n) => row(r, n, r.url,
          st.dir === "under" ? `<b class="up">save ${$m(r.save)}</b><span>${$m(r.buy)} on ${esc(r.market)} · ${r.under}% under</span>` : `<b class="down">${-r.under}% over</b><span>${$m(r.buy)} vs fair ${$m(r.fair)}</span>`,
          `fair ${$m(r.fair)} · value ${fmt(r.value)} · ${secondNote(r)}${r.suspect ? ` · <span class="warn">⚠ far too cheap — check the listing</span>` : ""}${r.sold7d ? ` · ${r.sold7d} sold 7d` : ""}`, true)).join("")
        || `<div class="empty">Nothing matches — try another game or a lower price.</div>`}</section>
      <p class="dv-note">Fair price = the item's value × what the 15 items closest in value cost per value point right now (items with 2+ listings), compared with the cheapest listing on any marketplace. “2nd source” is a second value site (game.guide, or robloxtools for Blade Ball) converted to the same scale: when it values the item 50%+ lower, the discount is marked disputed. Under 30% of fair is usually a mis-tagged item or a scam.</p>`;
  }
  function drawUnder(out) {
    const list = deals.under.filter((r) => keep(r, r.soldPrice));
    out.innerHTML = controls() + `<section class="card dv-list">${list.map((r, n) => row(r, n, r.url, `<b class="up">+${$m(r.profit)}</b><span>${$m(r.buy)} on ${esc(r.market)}</span>`,
        `${r.below}% under the typical sale ${$m(r.soldPrice)} · ${r.sold7d} sold in 7d`, true)).join("") || `<div class="empty">Nothing listed well under its recent sales right now.</div>`}</section>
      <p class="dv-note">Cheapest listing anywhere 25–70% under the item's typical (median) Eldorado sale of the last 7 days (items with 3+ sales). Profit = typical sale − ${Math.round((deals.fee || 0.1) * 100)}% fee − buy price. Sales are estimated from listings that disappear.</p>`;
  }
  function drawBulk(out) {
    const list = deals.bulk.filter((r) => keep(r, r.soldPrice));
    out.innerHTML = controls() + `<section class="card dv-list">${list.map((r, n) => row({ ...r, name: `Buy ${r.n}× ${r.name}` }, n, r.url || `${PAGE[r.game]}?item=${encodeURIComponent(r.key)}`,
        `<b class="up">+${$m(r.profit)}</b><span>${r.roi}% on ${$m(r.cost)}</span>`, `cheapest ${$m(r.cheapest)} · resell at typical ${$m(r.soldPrice)} · ${r.sold7d} sold in 7d`, true)).join("") || `<div class="empty">No bulk buy pays right now.</div>`}</section>
      <p class="dv-note">Cost of the cheapest 3, 5 or 10 units on Eldorado vs reselling them all at the typical sale price after the fee — only when the item sold at least that many times this week and the return is 15%+.</p>`;
  }
  async function drawMovers(out) {
    const p = st.period;
    movers[p] ||= await getJson(`/api/sale-movers?period=${p}`);
    const d = movers[p];
    const head = `<div class="dv-ctl">${["24h", "3d", "7d", "14d"].map((x) => `<button data-period="${x}" class="${x === p ? "on" : ""}">${x}</button>`).join("")}</div>`;
    if (!d || d.error) { out.innerHTML = head + controls() + `<div class="empty">${esc(d?.error || "Couldn't load sales.")}</div>`; return; }
    const rows = d.rows.filter((r) => keep(r, Math.max(r.avgNow, r.avgBefore)) && r.salesNow >= 3 && r.salesBefore >= 3);
    const gains = rows.filter((r) => r.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 25), drops = rows.filter((r) => r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 25);
    const list = (arr, cls) => arr.map((r, n) => row(r, n, `${PAGE[r.game]}?item=${encodeURIComponent(r.key)}`, `<b class="${cls}">${r.pct > 0 ? "+" : ""}${r.pct}%</b><span>${$m(r.avgBefore)} → ${$m(r.avgNow)}</span>`,
      `${r.salesNow} sales vs ${r.salesBefore}${r.usd ? ` · cheapest now ${$m(r.usd)}` : ""}`)).join("") || `<div class="empty">Nothing yet.</div>`;
    out.innerHTML = head + controls() + (d.enoughHistory ? "" : `<p class="dv-note" style="margin:0 0 12px">Sales have been tracked for ${d.trackedDays} days, so longer periods are still filling in.</p>`)
      + `<div class="dv-cols"><section class="card dv-list dv-col"><h2>🚀 Biggest gains</h2>${list(gains, "up")}</section><section class="card dv-list dv-col"><h2>📉 Biggest drops</h2>${list(drops, "down")}</section></div>
      <p class="dv-note">Average sale price of the period vs the one before (3+ sales in each), from estimated Eldorado sales; sales 4× away from the usual price are ignored.</p>`;
  }

  async function show() {
    const t = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "flips";
    document.querySelectorAll("#deal-tabs a").forEach((a) => a.classList.toggle("on", a.dataset.t === t));
    $("deals-sub").textContent = SUB[t];
    const flips = t === "flips";
    $("v-flips").hidden = !flips;
    document.querySelector(".hero .tiles")?.toggleAttribute("hidden", !flips);
    const out = $("v-other");
    out.hidden = flips;
    if (flips) return;
    if (t === "movers") return drawMovers(out);
    if (!deals) { out.innerHTML = `<div class="empty">Loading deals…</div>`; deals = await getJson("/api/market-deals"); }
    if (!deals) { out.innerHTML = `<div class="empty">Couldn't load deals — try again in a moment.</div>`; return; }
    ({ fair: drawFair, under: drawUnder, bulk: drawBulk })[t](out);
  }

  const start = () => {
    if (!$("deal-tabs")) return;
    const out = $("v-other");
    out.addEventListener("change", (e) => { const k = e.target.dataset.k; if (!k) return; st[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; save(); show(); });
    let typing;
    out.addEventListener("input", (e) => { if (e.target.dataset.k !== "q") return; clearTimeout(typing); typing = setTimeout(() => { st.q = e.target.value; show().then(() => { const f = out.querySelector('[data-k="q"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }); }, 200); });
    out.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.dir) { st.dir = b.dataset.dir; show(); }
      if (b.dataset.period) { st.period = b.dataset.period; save(); show(); }
    });
    addEventListener("hashchange", show);
    show();
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start); else start();
})();
