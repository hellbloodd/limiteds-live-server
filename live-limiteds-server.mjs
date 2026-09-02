import http from "http";
import { URL } from "url";

// ============================================================================
// ARCHITECTURE
// ----------------------------------------------------------------------------
// Classic limiteds' RAP/Value are sourced from Rolimons' public bulk catalog
// endpoint (one request returns every tracked classic limited's RAP, Value,
// demand and trend). This is the same data Rolimons itself is built on, and
// it's what makes this reliable:
//   - ONE request covers the whole catalog (no per-item Roblox rate limiting)
//   - Every list, the item-detail popup, and portfolios all read from this
//     exact same map, so numbers can never disagree with each other
//   - New limiteds Roblox releases show up automatically as soon as Rolimons
//     picks them up, with no guessing at Roblox catalog-search parameters
//
// Roblox's own APIs are still used for what Rolimons doesn't provide:
//   - Current lowest resale price / available copies / total copies, via a
//     single batched POST to catalog.roblox.com (up to 100 ids per request)
//   - A player's owned items, for the portfolio view (unavoidable - this is
//     per-user data only Roblox has)
//   - Historical daily price points for the detail chart, as a supplement to
//     our own hourly snapshots (which only start accumulating from today)
//
// Our own hourly snapshots (Supabase) are what let 24h/7d/30d/1y RAP %
// change be reported honestly - see findPeriodBaselineValue, which reports
// "no data" rather than fabricating a change over a shorter, mislabeled
// window when we don't have real history that far back yet.
// ============================================================================

const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "rolimons-source-v3";

const DASHBOARD_HTML = `<title>Limiteds Live</title>
<style>
  :root {
    --bg: #0b0e14;
    --surface: #12161f;
    --surface-2: #1a2029;
    --border: #262d3a;
    --text: #e9edf4;
    --muted: #8a93a6;
    --muted-2: #5d6577;
    --accent: #d9a441;
    --accent-soft: #d9a44122;
    --green: #34c17a;
    --green-soft: #34c17a1c;
    --red: #e0576a;
    --red-soft: #e0576a1c;
    --shadow: 0 12px 32px -12px rgba(0,0,0,0.55);
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f6f4ee;
      --surface: #ffffff;
      --surface-2: #f0ede4;
      --border: #ded8c8;
      --text: #221d12;
      --muted: #6b6455;
      --muted-2: #98917f;
      --accent: #ad7d1f;
      --accent-soft: #ad7d1f18;
      --green: #1f9d5c;
      --green-soft: #1f9d5c16;
      --red: #c23f52;
      --red-soft: #c23f5216;
      --shadow: 0 12px 28px -14px rgba(60,50,20,0.25);
    }
  }
  :root[data-theme="light"] {
    --bg: #f6f4ee;
    --surface: #ffffff;
    --surface-2: #f0ede4;
    --border: #ded8c8;
    --text: #221d12;
    --muted: #6b6455;
    --muted-2: #98917f;
    --accent: #ad7d1f;
    --accent-soft: #ad7d1f18;
    --green: #1f9d5c;
    --green-soft: #1f9d5c16;
    --red: #c23f52;
    --red-soft: #c23f5216;
    --shadow: 0 12px 28px -14px rgba(60,50,20,0.25);
  }

  * { box-sizing: border-box; }
  /* Some of the classes below (.control-group, .load-more-wrap, .overlay)
     set their own \`display\`, which - at equal CSS specificity - beats the
     browser's default \`[hidden] { display: none }\` rule. Restating it here
     with !important keeps \`el.hidden = true\` working everywhere on the page. */
  [hidden] { display: none !important; }
  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    min-height: 100vh;
  }
  ::selection { background: var(--accent-soft); }

  .tabular { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }

  a { color: inherit; }

  /* ---------- Top bar ---------- */
  header.top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .top-inner {
    max-width: 1360px;
    margin: 0 auto;
    padding: 18px 28px;
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .brand-mark {
    width: 30px; height: 30px;
    border-radius: 8px;
    background: linear-gradient(155deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #ff8a3d));
    display: flex; align-items: center; justify-content: center;
    font-family: "Unbounded", sans-serif;
    font-weight: 700;
    font-size: 15px;
    color: #201404;
    flex-shrink: 0;
  }
  .brand-text {
    font-family: "Unbounded", sans-serif;
    font-weight: 600;
    font-size: 17px;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .brand-text .dim { color: var(--muted); font-weight: 500; }

  .search-wrap {
    flex: 1;
    max-width: 380px;
    position: relative;
  }
  .search-wrap input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 9px 14px 9px 34px;
    color: var(--text);
    font-size: 13.5px;
    font-family: inherit;
    outline: none;
    transition: border-color .15s ease;
  }
  .search-wrap input:focus { border-color: var(--accent); }
  .search-wrap svg {
    position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
    color: var(--muted-2);
  }

  .ticker {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }
  .ticker .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 0 3px var(--green-soft);
  }
  .ticker .dot.stale { background: var(--muted-2); box-shadow: 0 0 0 3px transparent; }
  .ticker b.tabular { color: var(--text); }

  /* ---------- Controls ---------- */
  .controls {
    max-width: 1360px;
    margin: 0 auto;
    padding: 18px 28px 4px;
    display: flex;
    align-items: flex-start;
    gap: 28px;
    flex-wrap: wrap;
  }
  .control-group {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .control-group .label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted-2);
    font-weight: 600;
  }
  .pill-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill {
    appearance: none;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all .12s ease;
    white-space: nowrap;
  }
  .pill:hover { color: var(--text); border-color: var(--muted-2); }
  .pill.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .pill.active.loss { background: var(--red-soft); border-color: var(--red); color: var(--red); }
  .pill.active.profit { background: var(--green-soft); border-color: var(--green); color: var(--green); }

  .range-row { display: flex; align-items: center; gap: 6px; }
  .range-sep { color: var(--muted-2); font-size: 12px; }
  .range-input {
    width: 76px;
    appearance: none;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
  }
  .range-input::placeholder { color: var(--muted-2); font-weight: 500; }
  .range-input:focus { outline: none; border-color: var(--accent); }
  /* Hide native number spinners so the pill shape stays clean */
  .range-input::-webkit-outer-spin-button,
  .range-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .range-input[type=number] { -moz-appearance: textfield; }

  select.period-select {
    appearance: none;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 30px 6px 12px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238a93a6' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
  }

  /* ---------- Status line ---------- */
  .status-line {
    max-width: 1360px;
    margin: 0 auto;
    padding: 14px 28px 0;
    font-size: 12.5px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status-line .count { color: var(--text); font-weight: 700; }

  /* ---------- Grid ---------- */
  main {
    max-width: 1360px;
    margin: 0 auto;
    padding: 14px 28px 60px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(212px, 1fr));
    gap: 14px;
    margin-top: 14px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    cursor: pointer;
    transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
    display: flex;
    flex-direction: column;
  }
  .card:hover {
    transform: translateY(-2px);
    border-color: var(--muted-2);
    box-shadow: var(--shadow);
  }
  .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .card-title {
    padding: 10px 12px;
    background: var(--surface-2);
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-bottom: 1px solid var(--border);
  }
  .card-thumb {
    width: 100%;
    aspect-ratio: 1;
    background:
      radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 65%),
      var(--bg);
    display: flex; align-items: center; justify-content: center;
  }
  .card-thumb img { width: 78%; height: 78%; object-fit: contain; }
  .card-stats { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
  .stat-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; }
  .stat-row .k { color: var(--muted); }
  .stat-row .v { font-weight: 700; }
  .stat-row .v.pos { color: var(--green); }
  .stat-row .v.neg { color: var(--red); }
  .stat-row.metric { border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 2px; }

  .empty-state {
    text-align: center;
    padding: 90px 20px;
    color: var(--muted);
  }
  .empty-state .glyph { font-size: 34px; margin-bottom: 10px; opacity: .5; }
  .empty-state .title { font-family: "Unbounded", sans-serif; font-size: 16px; color: var(--text); margin-bottom: 6px; }

  .load-more-wrap { display: flex; justify-content: center; margin-top: 22px; }
  .load-more {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 10px 22px;
    border-radius: 10px;
    font-family: inherit;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
  }
  .load-more:hover { border-color: var(--accent); color: var(--accent); }
  .load-more[disabled] { opacity: .5; cursor: default; }

  /* ---------- Modal ---------- */
  .overlay {
    position: fixed; inset: 0;
    background: color-mix(in srgb, black 55%, transparent);
    backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    z-index: 50;
    padding: 20px;
  }
  .overlay[hidden] { display: none; }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 18px;
    width: min(760px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow);
  }
  .modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 20px 24px 4px;
  }
  .modal-head h2 { font-family: "Unbounded", sans-serif; font-size: 19px; margin: 0; padding-right: 20px; }
  .modal-close {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--muted);
    width: 30px; height: 30px;
    border-radius: 8px;
    cursor: pointer;
    flex-shrink: 0;
    font-size: 15px;
    line-height: 1;
  }
  .modal-close:hover { color: var(--text); }
  .modal-body {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 22px;
    padding: 16px 24px 24px;
  }
  @media (max-width: 560px) {
    .modal-body { grid-template-columns: 1fr; }
  }
  .modal-thumb {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    aspect-ratio: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .modal-thumb img { width: 80%; height: 80%; object-fit: contain; }
  .modal-buy {
    display: block;
    text-align: center;
    margin-top: 12px;
    padding: 10px;
    border-radius: 10px;
    background: linear-gradient(155deg, var(--green), color-mix(in srgb, var(--green) 70%, #0a9e56));
    color: #06210f;
    font-weight: 800;
    font-size: 13px;
    text-decoration: none;
  }
  .modal-stats { display: flex; flex-direction: column; gap: 2px; }
  .modal-stat {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 7px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .modal-stat .k { color: var(--muted); }
  .modal-stat .v { font-weight: 700; }
  .modal-stat .v.pos { color: var(--green); }
  .modal-stat .v.neg { color: var(--red); }

  .chart-wrap { grid-column: 1 / -1; margin-top: 4px; }
  .chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .chart-head .range-pills { display: flex; gap: 4px; }
  .chart-head .rp {
    background: transparent; border: 1px solid var(--border); color: var(--muted);
    font-family: inherit; font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 999px; cursor: pointer;
  }
  .chart-head .rp.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .chart-box { border: 1px solid var(--border); border-radius: 12px; background: var(--bg); padding: 10px 12px; position: relative; }
  .chart-caption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .chart-tooltip {
    position: absolute; pointer-events: none; z-index: 5; transform: translate(-50%, -100%);
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 10px; font-size: 12px; line-height: 1.45; white-space: nowrap;
    box-shadow: 0 6px 18px rgba(0,0,0,.28);
  }
  .chart-tooltip .tt-date { color: var(--muted); font-size: 11px; }
  .chart-tooltip .tt-val { font-weight: 700; }
  .chart-tooltip[hidden] { display: none; }

  .skel { background: linear-gradient(90deg, var(--surface-2), var(--border), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.3s infinite; border-radius: 6px; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  @media (prefers-reduced-motion: reduce) {
    .card, .skel { animation: none !important; transition: none !important; }
  }
</style>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;600;700&family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap">

<header class="top">
  <div class="top-inner">
    <div class="brand">
      <div class="brand-mark">L</div>
      <div class="brand-text">Limiteds <span class="dim">Live</span></div>
    </div>
    <div class="search-wrap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="search" type="text" placeholder="Search limiteds…" autocomplete="off">
    </div>
    <div class="ticker">
      <span class="dot" id="live-dot"></span>
      <span id="live-text">connecting…</span>
    </div>
  </div>
</header>

<div class="controls">
  <div class="control-group" id="sort-group">
    <div class="label">Sort</div>
    <div class="pill-row" id="sort-row"></div>
  </div>
  <div class="control-group" id="period-group" hidden>
    <div class="label">Period</div>
    <select class="period-select" id="period-select"></select>
  </div>
  <div class="control-group" id="rap-range-group">
    <div class="label">RAP Range</div>
    <div class="range-row">
      <input type="number" min="0" inputmode="numeric" class="range-input" id="rap-min" placeholder="Min">
      <span class="range-sep">–</span>
      <input type="number" min="0" inputmode="numeric" class="range-input" id="rap-max" placeholder="Max">
    </div>
  </div>
  <div class="control-group" id="price-range-group">
    <div class="label">Price Range</div>
    <div class="range-row">
      <input type="number" min="0" inputmode="numeric" class="range-input" id="price-min" placeholder="Min">
      <span class="range-sep">–</span>
      <input type="number" min="0" inputmode="numeric" class="range-input" id="price-max" placeholder="Max">
    </div>
  </div>
  <div class="control-group">
    <div class="label">Min Sales / Day</div>
    <div class="range-row">
      <input type="number" min="0" inputmode="numeric" class="range-input" id="min-sales-day" placeholder="e.g. 10">
    </div>
  </div>
  <div class="control-group">
    <div class="label">RAP vs Value %</div>
    <div class="range-row">
      <input type="number" inputmode="numeric" class="range-input" id="rap-vs-value-min" placeholder="Min">
      <span class="range-sep">–</span>
      <input type="number" inputmode="numeric" class="range-input" id="rap-vs-value-max" placeholder="Max">
    </div>
  </div>
  <div class="control-group">
    <div class="label">Price vs RAP %</div>
    <div class="range-row">
      <input type="number" inputmode="numeric" class="range-input" id="price-vs-rap-min" placeholder="Min">
      <span class="range-sep">–</span>
      <input type="number" inputmode="numeric" class="range-input" id="price-vs-rap-max" placeholder="Max">
    </div>
  </div>
</div>

<div class="status-line" id="status-line">Loading catalog…</div>

<main>
  <div class="grid" id="grid"></div>
  <div class="load-more-wrap" id="load-more-wrap" hidden>
    <button class="load-more" id="load-more">Load more</button>
  </div>
</main>

<div class="overlay" id="overlay" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-head">
      <h2 id="modal-title">Item</h2>
      <button class="modal-close" id="modal-close" aria-label="Close">✕</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>

<script>
(function () {
  "use strict";

  // Same-origin: this page is served BY live-limiteds-server.mjs itself
  // (see the "/" route), so API calls are plain relative paths - no CORS,
  // no cross-origin fetch restrictions like a claude.ai-hosted page would hit.
  var API_BASE = "";
  var PAGE_LIMIT = 60;

  // ---- Sort + period configuration (mirrors the in-game client) ----
  var SORTS = [
    { key: "rap_desc", label: "Highest RAP" },
    { key: "price_asc", label: "Lowest Price" },
    { key: "price_desc", label: "Highest Price" },
    { key: "updated", label: "Recent" },
    { key: "deal_desc", label: "Best Deals" },
    { key: "overpriced_desc", label: "Overpriced" },
    { key: "overpriced_sales_desc", label: "Overpriced (Most Sales)" },
    { key: "rap_above_value_desc", label: "RAP > Value" },
    { key: "changes", label: "Changes" },
    { key: "sales", label: "Sales" },
  ];
  var PERIODS = ["1h", "24h", "7d", "30d", "1y", "all"];
  var PERIOD_LABEL = { "1h": "1h", "24h": "24h", "7d": "7d", "30d": "30d", "1y": "1y", all: "All" };

  var state = {
    minSalesPerDay: null,
    minRapVsValue: null,
    maxRapVsValue: null,
    minPriceVsRap: null,
    maxPriceVsRap: null,
    sortKey: "rap_desc",
    changeMode: "profit", // profit | loss  (used only when sortKey === "changes")
    period: "24h",
    search: "",
    searchDebounce: null,
    minRap: null,
    maxRap: null,
    minPrice: null,
    maxPrice: null,
    rangeDebounce: null,
    cursor: "",
    loading: false,
    items: [],
    detailCache: {},
  };

  var els = {
    sortGroup: document.getElementById("sort-group"),
    sortRow: document.getElementById("sort-row"),
    periodGroup: document.getElementById("period-group"),
    periodSelect: document.getElementById("period-select"),
    rapRangeGroup: document.getElementById("rap-range-group"),
    priceRangeGroup: document.getElementById("price-range-group"),
    minSalesDay: document.getElementById("min-sales-day"),
    rapVsValueMin: document.getElementById("rap-vs-value-min"),
    rapVsValueMax: document.getElementById("rap-vs-value-max"),
    priceVsRapMin: document.getElementById("price-vs-rap-min"),
    priceVsRapMax: document.getElementById("price-vs-rap-max"),
    statusLine: document.getElementById("status-line"),
    grid: document.getElementById("grid"),
    loadMoreWrap: document.getElementById("load-more-wrap"),
    loadMore: document.getElementById("load-more"),
    search: document.getElementById("search"),
    rapMin: document.getElementById("rap-min"),
    rapMax: document.getElementById("rap-max"),
    priceMin: document.getElementById("price-min"),
    priceMax: document.getElementById("price-max"),
    liveDot: document.getElementById("live-dot"),
    liveText: document.getElementById("live-text"),
    overlay: document.getElementById("overlay"),
    modalBody: document.getElementById("modal-body"),
    modalTitle: document.getElementById("modal-title"),
    modalClose: document.getElementById("modal-close"),
  };

  function fmtNum(n) {
    n = Number(n);
    if (!isFinite(n)) return "N/A";
    return Math.round(n).toLocaleString("en-US");
  }
  function fmtPercent(v) {
    v = Number(v);
    if (v === null || v === undefined || !isFinite(v)) return "N/A";
    return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
  }
  function fmtUnsignedPercent(v) {
    v = Number(v);
    if (v === null || v === undefined || !isFinite(v)) return "N/A";
    return Math.abs(v).toFixed(1) + "%";
  }
  function thumbUrl(item) {
    // The backend resolves this via Roblox's real thumbnail API and caches
    // it (item.thumbnailUrl, a hotlinkable rbxcdn.com URL) - the old trick of
    // building a URL straight from the assetId no longer works, Roblox
    // retired that endpoint. Fall back to a blank placeholder if a thumbnail
    // genuinely isn't available yet rather than showing a broken image icon.
    return item.thumbnailUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  }
  function itemUrl(assetId) {
    return "https://www.roblox.com/catalog/" + assetId;
  }

  // ---------- Remote sort key resolution ----------
  function remoteSort() {
    if (state.sortKey === "changes") return state.changeMode + "_" + state.period;
    if (state.sortKey === "sales") return "bought_" + (state.period === "all" || state.period === "1h" ? "1y" : state.period);
    if (state.sortKey === "overpriced_sales_desc") return "overpriced_sales_" + (state.period === "all" || state.period === "1h" ? "1y" : state.period);
    return state.sortKey;
  }
  function isChangeSort() { return state.sortKey === "changes"; }
  function isSalesSort() { return state.sortKey === "sales"; }
  function usesSalesPeriod() { return state.sortKey === "sales" || state.sortKey === "overpriced_sales_desc"; }

  // ---------- Rendering: controls ----------
  function renderSortRow() {
    els.sortRow.innerHTML = "";
    SORTS.forEach(function (s) {
      var btn = document.createElement("button");
      btn.className = "pill" + (state.sortKey === s.key ? " active" : "");
      btn.textContent = s.label;
      btn.addEventListener("click", function () {
        state.sortKey = s.key;
        renderSortRow();
        renderPeriodGroup();
        resetAndLoad();
      });
      els.sortRow.appendChild(btn);
    });
    if (isChangeSort()) {
      var wrap = document.createElement("div");
      wrap.className = "pill-row";
      wrap.style.marginLeft = "6px";
      ["profit", "loss"].forEach(function (mode) {
        var b = document.createElement("button");
        b.className = "pill" + (state.changeMode === mode ? " active " + mode : "");
        b.textContent = mode === "profit" ? "Profit" : "Loss";
        b.addEventListener("click", function () {
          state.changeMode = mode;
          renderSortRow();
          resetAndLoad();
        });
        wrap.appendChild(b);
      });
      els.sortRow.appendChild(wrap);
    }
  }

  function renderPeriodGroup() {
    var show = isChangeSort() || usesSalesPeriod();
    els.periodGroup.hidden = !show;
    if (!show) return;
    var periods = usesSalesPeriod() ? ["24h", "7d", "30d", "1y"] : PERIODS;
    if (usesSalesPeriod() && (state.period === "1h" || state.period === "all")) state.period = "24h";
    els.periodSelect.innerHTML = "";
    periods.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = PERIOD_LABEL[p];
      if (p === state.period) opt.selected = true;
      els.periodSelect.appendChild(opt);
    });
  }
  els.periodSelect.addEventListener("change", function () {
    state.period = els.periodSelect.value;
    resetAndLoad();
  });

  els.search.addEventListener("input", function () {
    clearTimeout(state.searchDebounce);
    var v = els.search.value;
    state.searchDebounce = setTimeout(function () {
      state.search = v.trim();
      resetAndLoad();
    }, 320);
  });

  function parseRangeInput(el) {
    var v = parseFloat(el.value);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  // Percentage comparisons (RAP vs Value, Price vs RAP) can legitimately go
  // negative (a price below RAP, a RAP below Value) - parseRangeInput's
  // v >= 0 guard exists for RAP/Price/sales-count fields where a negative
  // number is meaningless, but it would silently swallow exactly the
  // negative thresholds these two filters need to be useful.
  function parseSignedRangeInput(el) {
    var v = parseFloat(el.value);
    return Number.isFinite(v) ? v : null;
  }

  function wireRangeInput(el, stateKey, parser) {
    var parse = parser || parseRangeInput;
    el.addEventListener("input", function () {
      clearTimeout(state.rangeDebounce);
      state.rangeDebounce = setTimeout(function () {
        state[stateKey] = parse(el);
        resetAndLoad();
      }, 400);
    });
  }
  wireRangeInput(els.rapMin, "minRap");
  wireRangeInput(els.rapMax, "maxRap");
  wireRangeInput(els.priceMin, "minPrice");
  wireRangeInput(els.priceMax, "maxPrice");
  wireRangeInput(els.minSalesDay, "minSalesPerDay");
  wireRangeInput(els.rapVsValueMin, "minRapVsValue", parseSignedRangeInput);
  wireRangeInput(els.rapVsValueMax, "maxRapVsValue", parseSignedRangeInput);
  wireRangeInput(els.priceVsRapMin, "minPriceVsRap", parseSignedRangeInput);
  wireRangeInput(els.priceVsRapMax, "maxPriceVsRap", parseSignedRangeInput);

  // ---------- Data fetching ----------
  function buildUrl(path, params) {
    // Base against location.origin so this works whether API_BASE is a full
    // origin (artifact preview, testing) or "" (served same-origin in prod).
    var url = new URL(API_BASE + path, window.location.origin);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== "") url.searchParams.set(k, params[k]);
    });
    return url.toString();
  }

  function resetAndLoad() {
    state.cursor = "";
    state.items = [];
    els.grid.innerHTML = "";
    setStatus("Loading…");
    fetchPage(true);
  }

  function setLive(ok, text) {
    els.liveDot.classList.toggle("stale", !ok);
    els.liveText.textContent = text;
  }
  function setStatus(text) {
    els.statusLine.textContent = text;
  }

  function fetchPage(replace) {
    if (state.loading) return;
    state.loading = true;
    els.loadMore.textContent = "Loading…";
    els.loadMore.disabled = true;

    var url = buildUrl("/api/limiteds", {
      sort: remoteSort(),
      keyword: state.search,
      cursor: state.cursor,
      limit: PAGE_LIMIT,
      minRap: state.minRap,
      maxRap: state.maxRap,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice,
      minSalesPerDay: state.minSalesPerDay,
      minRapVsValue: state.minRapVsValue,
      maxRapVsValue: state.maxRapVsValue,
      minPriceVsRap: state.minPriceVsRap,
      maxPriceVsRap: state.maxPriceVsRap,
    });

    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      state.loading = false;
      if (!data || data.ok === false) {
        setLive(false, "backend unreachable");
        if (replace) renderEmpty("Live data unavailable — the backend may be waking up (free-tier hosting sleeps when idle). Try again in ~30s.");
        return;
      }
      setLive(true, "updated " + new Date().toLocaleTimeString());
      var newItems = data.items || [];
      state.cursor = data.nextPageCursor || "";

      var incoming = newItems;
      if (isChangeSort()) {
        incoming = incoming.filter(function (it) {
          return getChangeMetric(it) !== null;
        });
      }

      state.items = replace ? incoming : state.items.concat(incoming);
      renderGrid();

      var more = !!state.cursor;
      els.loadMoreWrap.hidden = !more || state.items.length === 0;
      els.loadMore.disabled = false;
      els.loadMore.textContent = "Load more";

      if (state.items.length === 0) {
        setStatus(isChangeSort()
          ? "No limiteds with a " + state.changeMode + " right now for this period."
          : (state.search ? "No limiteds found for \\"" + state.search + "\\"." : "No limiteds found."));
      } else {
        setStatus(state.items.length + " limiteds loaded");
      }
    }).catch(function () {
      state.loading = false;
      els.loadMore.disabled = false;
      els.loadMore.textContent = "Load more";
      setLive(false, "connection failed");
      if (replace) renderEmpty("Couldn't reach the live server. Check your connection and try again.");
    });
  }

  els.loadMore.addEventListener("click", function () { fetchPage(false); });

  function getChangeMetric(item) {
    var suffix = state.period === "all" ? "AllTime" : state.period;
    var field = (state.changeMode === "loss" ? "loss" : "profit") + suffix;
    var v = item[field];
    return (v === null || v === undefined) ? null : Number(v);
  }

  // ---------- Grid rendering ----------
  function renderEmpty(message) {
    els.grid.innerHTML = "";
    var d = document.createElement("div");
    d.className = "empty-state";
    d.style.gridColumn = "1 / -1";
    d.innerHTML = '<div class="glyph">◇</div><div class="title">Nothing here</div><div>' + message + "</div>";
    els.grid.appendChild(d);
  }

  function metricForCard(item) {
    if (isChangeSort()) {
      var v = getChangeMetric(item);
      if (v === null) return null;
      return {
        label: (state.changeMode === "loss" ? "Loss " : "Profit ") + PERIOD_LABEL[state.period],
        text: state.changeMode === "loss" ? fmtUnsignedPercent(v) : fmtPercent(v),
        cls: state.changeMode === "loss" ? "neg" : "pos",
      };
    }
    if (isSalesSort()) {
      var count = item.salesCount;
      return {
        label: "Sales " + PERIOD_LABEL[state.period],
        text: count ? fmtNum(count) + (item.averageSalePrice ? " · avg " + fmtNum(item.averageSalePrice) : "") : "No sales",
        cls: "",
      };
    }
    if (state.sortKey === "deal_desc") {
      return { label: "Deal", text: fmtPercent(item.dealPercent), cls: "pos" };
    }
    if (state.sortKey === "overpriced_desc") {
      return { label: "Overpriced", text: fmtPercent(item.overpricedPercent), cls: "neg" };
    }
    if (state.sortKey === "overpriced_sales_desc") {
      var oCount = item.salesCount;
      return {
        label: "Overpriced · Sales " + PERIOD_LABEL[state.period],
        text: fmtPercent(item.overpricedPercent) + (oCount ? " · " + fmtNum(oCount) + " sold" : " · no sales"),
        cls: "neg",
      };
    }
    if (state.sortKey === "rap_above_value_desc") {
      var rv = item.rapVsValuePercent;
      if (rv === null || rv === undefined) return { label: "RAP vs Value", text: "N/A", cls: "" };
      return { label: "RAP vs Value", text: fmtPercent(rv), cls: rv >= 0 ? "pos" : "neg" };
    }
    var c24 = item.change24h;
    if (c24 === null || c24 === undefined) return null;
    return { label: "Change 24h", text: fmtPercent(c24), cls: Number(c24) > 0 ? "pos" : (Number(c24) < 0 ? "neg" : "") };
  }

  function renderGrid() {
    els.grid.innerHTML = "";
    if (state.items.length === 0) return;
    var frag = document.createDocumentFragment();
    state.items.forEach(function (item) {
      frag.appendChild(buildCard(item));
    });
    els.grid.appendChild(frag);
  }

  function buildCard(item) {
    var card = document.createElement("div");
    card.className = "card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    var title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.name;
    card.appendChild(title);

    var thumb = document.createElement("div");
    thumb.className = "card-thumb";
    var img = document.createElement("img");
    img.loading = "lazy";
    img.alt = item.name;
    img.src = thumbUrl(item);
    thumb.appendChild(img);
    card.appendChild(thumb);

    var stats = document.createElement("div");
    stats.className = "card-stats";
    stats.appendChild(statRow("RAP", fmtNum(item.rap)));
    stats.appendChild(statRow("Price", item.lowestPrice ? fmtNum(item.lowestPrice) : "N/A"));

    var metric = metricForCard(item);
    if (metric) {
      var row = statRow(metric.label, metric.text, metric.cls);
      row.className += " metric";
      stats.appendChild(row);
    }
    card.appendChild(stats);

    card.addEventListener("click", function () { openDetails(item); });
    card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetails(item); } });

    return card;
  }

  function statRow(k, v, cls) {
    var row = document.createElement("div");
    row.className = "stat-row";
    var kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    var vEl = document.createElement("span");
    vEl.className = "v tabular" + (cls ? " " + cls : "");
    vEl.textContent = v;
    row.appendChild(kEl);
    row.appendChild(vEl);
    return row;
  }

  // ---------- Details modal ----------
  var activeChartRange = "24h";
  var activeDetailItem = null;

  function openDetails(item) {
    activeDetailItem = item;
    activeChartRange = "24h";
    els.modalTitle.textContent = item.name;
    els.overlay.hidden = false;
    renderModalSkeleton(item);

    var cacheKey = item.assetId;
    if (state.detailCache[cacheKey]) {
      applyDetailData(state.detailCache[cacheKey]);
      return;
    }

    var url = buildUrl("/api/item", { assetId: item.assetId, collectibleItemId: item.collectibleItemId || "" });
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || data.ok === false) return;
      state.detailCache[cacheKey] = data;
      if (activeDetailItem === item) applyDetailData(data);
    }).catch(function () {});
  }

  function renderModalSkeleton(item) {
    els.modalBody.innerHTML =
      '<div><div class="modal-thumb"><img src="' + thumbUrl(item) + '" alt="' + escapeHtml(item.name) + '"></div>' +
      '<a class="modal-buy" href="' + itemUrl(item.assetId) + '" target="_blank" rel="noopener">View on Roblox ↗</a></div>' +
      '<div class="modal-stats">' +
        modalStatHtml("RAP", fmtNum(item.rap)) +
        modalStatHtml("Price", item.lowestPrice ? fmtNum(item.lowestPrice) : "N/A") +
        modalStatHtml("Change (" + rangeLabel(activeChartRange) + ")", "…") +
        modalStatHtml("Sales (" + rangeLabel(activeChartRange) + ")", "…") +
        modalStatHtml("Available", "…") +
        modalStatHtml("Total copies", "…") +
        modalStatHtml("Creator", "…") +
      '</div>' +
      '<div class="chart-wrap">' +
        '<div class="chart-head"><div class="chart-caption" id="chart-caption">Loading history…</div>' +
        '<div class="range-pills" id="range-pills"></div></div>' +
        '<div class="chart-box">' +
          '<svg id="chart-svg" width="100%" height="170" viewBox="0 0 680 170" preserveAspectRatio="none"></svg>' +
          '<div class="chart-tooltip" id="chart-tooltip" hidden></div>' +
        '</div>' +
      '</div>';
    buildRangePills();
    wireChartHover();
  }

  function modalStatHtml(k, v, cls) {
    return '<div class="modal-stat"><span class="k">' + k + '</span><span class="v tabular' + (cls ? " " + cls : "") + '">' + v + "</span></div>";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var RANGES = ["1h", "24h", "7d", "1m", "1y", "all"];
  var RANGE_FIELD = { "1h": "change1h", "24h": "change24h", "7d": "change7d", "1m": "change30d", "1y": "change1y", all: "changeAllTime" };
  var RANGE_DAYS = { "1h": 1 / 24, "24h": 1, "7d": 7, "1m": 30, "1y": 365, all: null };
  function rangeLabel(r) { return r === "all" ? "All" : r; }

  // Sales count for the currently-selected range, summed straight from the
  // same salesHistory points the item carries for its whole recorded life -
  // so picking any pill from 1h up to All recomputes it instantly with no
  // extra request, the same way the RAP chart already does for Change.
  //
  // Roblox only publishes this data once per calendar day, usually with
  // about a day's delay - filtering by "since exactly N*24h ago" against the
  // real clock used to show "No sales" for almost the entire day, then a
  // sudden jump once a new day's row appeared. Counting off the data's own
  // published days instead (collapsed to one entry per day, then the most
  // recent N of them) matches what the server does and stays stable no
  // matter when today's row happens to land.
  function computeSalesForRange(data, range) {
    var history = Array.isArray(data.salesHistory) ? data.salesHistory : [];
    var days = RANGE_DAYS[range];
    var byDay = {};
    history.forEach(function (p) {
      var vol = Number(p.salesVolume) || 0;
      var t = Date.parse(p.date);
      if (!(p.value > 0) || !vol || !isFinite(t)) return;
      var k = new Date(t).toISOString().slice(0, 10);
      byDay[k] = { vol: vol, t: t };
    });
    var sortedDays = Object.keys(byDay).map(function (k) { return byDay[k]; }).sort(function (a, b) { return a.t - b.t; });
    var n = days ? Math.max(1, Math.round(days)) : sortedDays.length;
    var window = sortedDays.slice(-n);
    var count = 0;
    window.forEach(function (d) { count += d.vol; });
    return count;
  }

  function buildRangePills() {
    var wrap = document.getElementById("range-pills");
    wrap.innerHTML = "";
    RANGES.forEach(function (r) {
      var b = document.createElement("button");
      b.className = "rp" + (r === activeChartRange ? " active" : "");
      b.textContent = r === "1m" ? "1m" : (r === "all" ? "All" : r);
      b.addEventListener("click", function () {
        activeChartRange = r;
        var cached = state.detailCache[activeDetailItem.assetId];
        if (cached) applyDetailData(cached);
      });
      wrap.appendChild(b);
    });
  }

  function applyDetailData(data) {
    var statsWrap = els.modalBody.querySelector(".modal-stats");
    if (statsWrap) {
      var changeVal = data[RANGE_FIELD[activeChartRange]];
      var salesForRange = computeSalesForRange(data, activeChartRange);
      statsWrap.innerHTML =
        modalStatHtml("RAP", fmtNum(data.rap)) +
        modalStatHtml("Price", data.lowestPrice ? fmtNum(data.lowestPrice) : "N/A") +
        modalStatHtml("Change (" + rangeLabel(activeChartRange) + ")", fmtPercent(changeVal), changeCls(changeVal)) +
        modalStatHtml("Sales (" + rangeLabel(activeChartRange) + ")", salesForRange > 0 ? fmtNum(salesForRange) : "—") +
        modalStatHtml("Available", fmtNum(data.availableCopies)) +
        modalStatHtml("Total copies", fmtNum(data.totalCopies)) +
        modalStatHtml("Creator", data.creatorName || "Roblox");
    }
    // re-highlight active pill (skeleton pills persist across re-renders)
    document.querySelectorAll("#range-pills .rp").forEach(function (b, i) {
      b.classList.toggle("active", RANGES[i] === activeChartRange);
    });
    drawChart(data);
  }

  function changeCls(v) {
    v = Number(v);
    if (!isFinite(v) || v === 0) return "";
    return v > 0 ? "pos" : "neg";
  }

  // Populated by drawChart with everything the hover handler needs to find
  // the nearest point under the cursor and place a tooltip over it - null
  // whenever there's no drawable line (so hover is a no-op).
  var chartHoverState = null;

  function drawChart(data) {
    var svg = document.getElementById("chart-svg");
    var caption = document.getElementById("chart-caption");
    chartHoverState = null;
    var history = Array.isArray(data.history) ? data.history.slice() : [];
    history.sort(function (a, b) { return Date.parse(a.date) - Date.parse(b.date); });

    var days = RANGE_DAYS[activeChartRange];
    var now = Date.now();
    var startTime = days ? now - days * 86400000 : 0;
    var points = history.filter(function (p) { return Date.parse(p.date) >= startTime && p.value > 0; });
    if (points.length < 2) points = history.filter(function (p) { return p.value > 0; }).slice(-2);

    var changeField = RANGE_FIELD[activeChartRange];
    var changeVal = data[changeField];
    var latest = points.length ? points[points.length - 1].value : data.rap;

    caption.className = "chart-caption tabular";
    if (points.length >= 2) {
      caption.textContent = (activeChartRange === "all" ? "All-time" : activeChartRange) + " RAP " + fmtPercent(changeVal) + " · " + fmtNum(latest) + " now";
    } else {
      caption.textContent = "Not enough recorded history for this range yet";
    }

    svg.innerHTML = "";
    if (points.length < 2) return;

    var w = 680, h = 170, padX = 8, padY = 14;
    var values = points.map(function (p) { return p.value; });
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (min === max) { min -= 1; max += 1; }
    var times = points.map(function (p) { return Date.parse(p.date); });
    var tMin = times[0], tMax = times[times.length - 1];
    if (tMin === tMax) tMax = tMin + 1;

    function xFor(t) { return padX + ((t - tMin) / (tMax - tMin)) * (w - padX * 2); }
    function yFor(v) { return h - padY - ((v - min) / (max - min)) * (h - padY * 2); }

    var isUp = values[values.length - 1] >= values[0];
    var lineColor = isUp ? "var(--green)" : "var(--red)";
    var lineColorResolved = getComputedStyle(document.documentElement).getPropertyValue(isUp ? "--green" : "--red").trim() || (isUp ? "#34c17a" : "#e0576a");

    var linePts = points.map(function (p) { return xFor(Date.parse(p.date)).toFixed(1) + "," + yFor(p.value).toFixed(1); }).join(" ");
    var areaPts = linePts + " " + xFor(tMax).toFixed(1) + "," + (h - padY) + " " + xFor(tMin).toFixed(1) + "," + (h - padY);

    var ns = "http://www.w3.org/2000/svg";
    var gridColor = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#262d3a";
    for (var i = 0; i <= 3; i++) {
      var gy = padY + (i / 3) * (h - padY * 2);
      var gline = document.createElementNS(ns, "line");
      gline.setAttribute("x1", padX); gline.setAttribute("x2", w - padX);
      gline.setAttribute("y1", gy.toFixed(1)); gline.setAttribute("y2", gy.toFixed(1));
      gline.setAttribute("stroke", gridColor); gline.setAttribute("stroke-width", "1");
      svg.appendChild(gline);
    }

    var area = document.createElementNS(ns, "polygon");
    area.setAttribute("points", areaPts);
    area.setAttribute("fill", lineColorResolved);
    area.setAttribute("opacity", "0.12");
    svg.appendChild(area);

    var poly = document.createElementNS(ns, "polyline");
    poly.setAttribute("points", linePts);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", lineColorResolved);
    poly.setAttribute("stroke-width", "2");
    poly.setAttribute("stroke-linejoin", "round");
    poly.setAttribute("stroke-linecap", "round");
    svg.appendChild(poly);

    var lastPt = points[points.length - 1];
    var dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", xFor(Date.parse(lastPt.date)).toFixed(1));
    dot.setAttribute("cy", yFor(lastPt.value).toFixed(1));
    dot.setAttribute("r", "3.5");
    dot.setAttribute("fill", lineColorResolved);
    svg.appendChild(dot);

    // Hover overlay: a guideline + dot drawn on top, moved to whichever point
    // is nearest the cursor. Created once per render, toggled visible on
    // mousemove (see wireChartHover) rather than rebuilt every frame.
    var hoverLine = document.createElementNS(ns, "line");
    hoverLine.setAttribute("y1", padY); hoverLine.setAttribute("y2", h - padY);
    hoverLine.setAttribute("stroke", gridColor); hoverLine.setAttribute("stroke-width", "1");
    hoverLine.setAttribute("stroke-dasharray", "3,3");
    hoverLine.setAttribute("visibility", "hidden");
    svg.appendChild(hoverLine);
    var bgColorResolved = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0b0e14";
    var hoverDot = document.createElementNS(ns, "circle");
    hoverDot.setAttribute("r", "4");
    hoverDot.setAttribute("fill", lineColorResolved);
    hoverDot.setAttribute("stroke", bgColorResolved);
    hoverDot.setAttribute("stroke-width", "2");
    hoverDot.setAttribute("visibility", "hidden");
    svg.appendChild(hoverDot);

    chartHoverState = { points: points, xFor: xFor, w: w, hoverLine: hoverLine, hoverDot: hoverDot };
  }

  // Wired once per modal open (the svg element persists across pill clicks -
  // only its contents get redrawn) so hovering works immediately and keeps
  // working after switching ranges.
  function wireChartHover() {
    var svg = document.getElementById("chart-svg");
    var tooltip = document.getElementById("chart-tooltip");
    if (!svg || !tooltip) return;

    function hide() {
      tooltip.hidden = true;
      if (chartHoverState) {
        chartHoverState.hoverLine.setAttribute("visibility", "hidden");
        chartHoverState.hoverDot.setAttribute("visibility", "hidden");
      }
    }

    svg.addEventListener("mousemove", function (e) {
      if (!chartHoverState || chartHoverState.points.length < 2) return hide();
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return hide();
      var svgX = ((e.clientX - rect.left) / rect.width) * chartHoverState.w;

      // Nearest point by drawn x-position (points aren't evenly spaced in
      // time, so this is a linear scan over the plotted x values rather than
      // an index computed from a fixed step).
      var nearest = chartHoverState.points[0], nearestX = chartHoverState.xFor(Date.parse(nearest.date)), bestDist = Infinity;
      chartHoverState.points.forEach(function (p) {
        var px = chartHoverState.xFor(Date.parse(p.date));
        var dist = Math.abs(px - svgX);
        if (dist < bestDist) { bestDist = dist; nearest = p; nearestX = px; }
      });

      var cx = nearestX, cy = yForCache(nearest.value);
      chartHoverState.hoverLine.setAttribute("x1", cx.toFixed(1)); chartHoverState.hoverLine.setAttribute("x2", cx.toFixed(1));
      chartHoverState.hoverLine.setAttribute("visibility", "visible");
      chartHoverState.hoverDot.setAttribute("cx", cx.toFixed(1)); chartHoverState.hoverDot.setAttribute("cy", cy.toFixed(1));
      chartHoverState.hoverDot.setAttribute("visibility", "visible");

      var boxRect = svg.parentElement.getBoundingClientRect();
      var leftPx = (cx / chartHoverState.w) * rect.width + (rect.left - boxRect.left);
      var topPx = (cy / 170) * rect.height + (rect.top - boxRect.top);
      tooltip.style.left = leftPx + "px";
      tooltip.style.top = Math.max(0, topPx - 10) + "px";
      tooltip.innerHTML =
        '<div class="tt-date">' + formatHoverDate(nearest.date) + '</div>' +
        '<div class="tt-val tabular">' + fmtNum(nearest.value) + "</div>";
      tooltip.hidden = false;

      function yForCache(v) {
        // Re-derive the y scale from the currently-drawn points (kept in
        // sync with drawChart's own yFor via the same min/max source data).
        var values = chartHoverState.points.map(function (p) { return p.value; });
        var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
        if (min === max) { min -= 1; max += 1; }
        var padY = 14, h = 170;
        return h - padY - ((v - min) / (max - min)) * (h - padY * 2);
      }
    });

    svg.addEventListener("mouseleave", hide);
  }

  function formatHoverDate(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var d = new Date(t);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function closeModal() { els.overlay.hidden = true; activeDetailItem = null; }
  els.modalClose.addEventListener("click", closeModal);
  els.overlay.addEventListener("click", function (e) { if (e.target === els.overlay) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !els.overlay.hidden) closeModal(); });

  // ---------- Boot ----------
  renderSortRow();
  renderPeriodGroup();
  resetAndLoad();
})();
</script>
`;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300_000);
const ROLIMONS_CACHE_TTL_MS = Number(process.env.ROLIMONS_CACHE_TTL_MS || 600_000);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 60 * 60 * 1000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const ROBLOX_CATALOG_BATCH_URL = "https://catalog.roblox.com/v1/catalog/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROBLOX_COLLECTIBLE_RESALE_URL = "https://apis.roblox.com/marketplace-sales/v1/item";
const ROBLOX_INVENTORY_URL = "https://inventory.roblox.com/v1/users";
const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";
const THUMBNAIL_BUNDLES_URL = "https://thumbnails.roblox.com/v1/bundles/thumbnails";
const ALLOWED_LIMITS = [10, 28, 30];

// Brand-new limiteds Rolimons hasn't picked up yet. This used to be found by
// live-scanning Roblox's own "bestselling, past week" feed on every catalog
// build - slow, added yet another source of 429s, and still missed items
// that didn't spike into that particular feed. A short manually-maintained
// list is simpler and more reliable: add an { id, itemType } entry here when
// a new limited shows up, and it gets full live price/RAP/thumbnail/history
// tracking the same as everything else - it just skips the discovery scan.
// itemType is "Asset" for a normal item or "Bundle" for a limited bundle
// (Roblox's catalog-details and thumbnails APIs both need to know which).
const MANUAL_NEW_LIMITEDS = [
  { id: 87983592197138, itemType: "Asset" },   // Lord of the Buxeration
  { id: 13241836994, itemType: "Asset" },      // Verdant Crown
  { id: 15381472359, itemType: "Asset" },      // Solar System Aura
  { id: 102887469225690, itemType: "Asset" },  // Blue Inferno Skull
  { id: 17756304457, itemType: "Asset" },      // Flaming Pink Horned Helmet
  { id: 17266515535, itemType: "Asset" },      // Molten Lava Wings
  { id: 16972690019, itemType: "Asset" },      // Atomic Blue Hairdo
  { id: 1098282, itemType: "Asset" },          // Lampshade
  { id: 14524326503, itemType: "Asset" },      // Quadri-Skull Aura
  { id: 450557238, itemType: "Asset" },        // 8-Bit Clockwork Shades
  { id: 20011925, itemType: "Asset" },         // Oozing Oscar
  { id: 1080949, itemType: "Asset" },          // Bunny Ears
  { id: 128217885, itemType: "Asset" },        // Fall Fairy
  { id: 110673146052704, itemType: "Asset" },  // Clockwork's Golden Shades
  { id: 113598419875472, itemType: "Asset" },  // Helsworn Valkyrie
  { id: 16477149823, itemType: "Asset" },      // Gold Clockwork Headphones
  { id: 259144677693420, itemType: "Bundle" }, // Snowflake Eyes
];
// BUG (fixed): this used to default to 3000, and the catalog easily runs
// past that (Rolimons tracks the whole history of classic limiteds, several
// thousand items, plus whatever MANUAL_NEW_LIMITEDS appends at the very end
// of the list). scanAllSalesMetrics() below did `allItems.slice(0, maxItems)`
// with no reordering first - since rolimonsItems is a Map keyed by numeric
// assetId, JS iterates integer-keyed maps in ascending key order, so the
// slice silently kept only the OLDEST ~3000 limiteds and permanently
// excluded every newer one from ever getting sales data, including every
// single manually-added item (Molten Lava Wings, 8-Bit Royal Crown, etc,
// which are pushed onto the end of the array) - exactly the "no sales for X"
// reports. The scan itself already runs in the background (never blocks a
// request - see getSalesMetricsMap), so there's no real cost to covering the
// whole catalog; default to effectively unlimited and let the env var only
// serve as a safety valve, not a silent correctness bug.
const ACTIVE_SALES_SCAN_LIMIT = Number(process.env.ACTIVE_SALES_SCAN_LIMIT || 999999);

// Rolimons' itemdetails array positions (community-documented convention).
const RL_NAME = 0, RL_ACRONYM = 1, RL_RAP = 2, RL_VALUE = 3, RL_DEFAULT_VALUE = 4,
  RL_DEMAND = 5, RL_TREND = 6, RL_PROJECTED = 7, RL_HYPED = 8, RL_RARE = 9;
const DEMAND_LABELS = { "-1": null, "0": "Terrible", "1": "Low", "2": "Normal", "3": "High", "4": "Amazing" };
const TREND_LABELS = { "-1": null, "0": "Lowering", "1": "Unstable", "2": "Stable", "3": "Raising", "4": "Fluctuating" };

const pageCache = new Map();
const marketIndexCache = new Map();
const resaleCache = new Map();
const catalogDetailCache = new Map();
const detailCache = new Map();
const portfolioCache = new Map();
// Sales-count-by-period is expensive (one live resale-history fetch per item,
// across the whole catalog) so it's computed once per period bucket and
// reused across every page/cursor/filter combination for CACHE_TTL_MS,
// instead of being recomputed per request like the old per-request scan was.
const salesActivityCache = new Map(); // key: days -> { fetchedAt, map: Map<assetId, salesFields> }
let robloxCsrfToken = "";
let snapshotRunning = false;
let memorySnapshots = [];
let rolimonsCatalogCache = { fetchedAt: 0, items: new Map() };

function makePageCacheKey({ marketType, sort, keyword, cursor, limit, minPrice, maxPrice, minRap, maxRap, minSalesPerDay, minRapVsValue, maxRapVsValue, minPriceVsRap, maxPriceVsRap }) {
  return [marketType, sort, keyword, cursor || "", limit, minPrice ?? "", maxPrice ?? "", minRap ?? "", maxRap ?? "",
    minSalesPerDay ?? "", minRapVsValue ?? "", maxRapVsValue ?? "", minPriceVsRap ?? "", maxPriceVsRap ?? ""].join(":");
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstPositiveNumber(...values) {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function firstNonNegativeNumber(...values) {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLimit(limit) {
  const r = Number(limit) || 30;
  return ALLOWED_LIMITS.reduce((b, c) => Math.abs(c - r) < Math.abs(b - r) ? c : b, 30);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 5000;
  let response;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, {
        method: options.method || "GET",
        body: options.body,
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "LimitedsLiveMarketViewer/1.0", ...(options.headers || {}) },
      });
    } catch (error) {
      throw new Error(`Network error for ${url}: ${error.cause?.message || error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status !== 429) break;
    await sleep(400 + attempt * 500);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  const text = await response.text();
  if (!text.trim()) throw new Error(`Empty JSON response for ${url}`);
  try { return JSON.parse(text); } catch (error) { throw new Error(`Bad JSON response for ${url}: ${error.message}`); }
}

async function fetchCatalogDetailsChunk(assetIds) {
  // Entries are normally plain assetIds (assumed itemType "Asset"), but can
  // also be { id, itemType } objects for the rare non-Asset case (a limited
  // Bundle, which Roblox's catalog-details API needs tagged differently).
  const body = JSON.stringify({
    items: assetIds.map(entry => typeof entry === "object" && entry
      ? { itemType: entry.itemType || "Asset", id: entry.id }
      : { itemType: "Asset", id: entry })
  });
  let response;
  for (let a = 0; a < 5; a++) {
    const headers = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "LimitedsLiveMarketViewer/1.0" };
    if (robloxCsrfToken) headers["x-csrf-token"] = robloxCsrfToken;
    response = await fetch(ROBLOX_CATALOG_BATCH_URL, { method: "POST", headers, body });
    const ft = response.headers.get("x-csrf-token");
    if (ft) robloxCsrfToken = ft;
    if (response.status === 403 && ft) continue;
    if (response.status !== 429) break;
    await sleep(1200 + a * 900);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${ROBLOX_CATALOG_BATCH_URL}`);
  return response.json();
}

async function fetchCatalogDetailsBatch(assetIds) {
  const result = new Map();
  const missing = [];
  for (const assetId of assetIds) {
    const c = catalogDetailCache.get(assetId);
    if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) {
      result.set(assetId, c.data);
    } else if (assetId > 0) {
      missing.push(assetId);
    }
  }
  let anyChunkSucceeded = false;
  for (let i = 0; i < missing.length; i += 100) {
    let data;
    try {
      data = await fetchCatalogDetailsChunk(missing.slice(i, i + 100));
    } catch (e) {
      // A single failed batch (rate limit, transient network error) used to
      // abort the whole loop here, silently leaving EVERY item after this
      // point in the catalog with no price/availability data at all - with
      // ~2,600 items across 26+ batches of 100, one hiccup partway through
      // wiped out prices for most of the list. Skip just this batch instead
      // and keep going, so a single bad batch costs 100 items, not the rest
      // of the catalog. Only bail out entirely if not a single batch has
      // worked yet (genuine outage, not a one-off blip).
      console.warn(`Catalog details batch ${i}-${i + 100} failed: ${e.message} - skipping this batch, continuing.`);
      if (!anyChunkSucceeded && i + 100 >= missing.length && result.size === 0) throw e;
      // Back off harder after a 429 specifically - pacing every batch at the
      // same fixed 220ms regardless of whether Roblox just rate-limited us is
      // what let a whole scan keep tripping the limiter batch after batch.
      if (i + 100 < missing.length) await sleep(e.message.includes("429") ? 1500 : 220);
      continue;
    }
    anyChunkSucceeded = true;
    for (const row of (Array.isArray(data.data) ? data.data : [])) {
      const id = normalizeNumber(row.id);
      if (id > 0) {
        catalogDetailCache.set(id, { fetchedAt: Date.now(), data: row });
        result.set(id, row);
      }
    }
    // A little more headroom between successful batches too (was 220ms) -
    // ~2,600 items in batches of 100 at this pace still finishes in well
    // under a minute, and it noticeably cuts down how often the very next
    // batch gets rate-limited.
    if (i + 100 < missing.length) await sleep(400);
  }
  return result;
}

const THUMBNAIL_URL = "https://thumbnails.roblox.com/v1/assets";
const THUMBNAIL_CACHE_TTL_MS = Number(process.env.THUMBNAIL_CACHE_TTL_MS || 24 * 60 * 60 * 1000); // thumbnails barely change
const thumbnailCache = new Map();

// Roblox's old `roblox.com/asset-thumbnail/image?assetId=` URL - what the
// website used to build <img> src directly from an assetId - is dead; it now
// just redirects to the Roblox homepage. The current API returns a JSON
// mapping to a real, hotlinkable rbxcdn.com URL per asset, batched up to 100
// ids per call like the catalog-details lookup above.
async function fetchThumbnailsBatch(assetIds) {
  const result = new Map();
  const missing = [];
  for (const assetId of assetIds) {
    const c = thumbnailCache.get(assetId);
    if (c && Date.now() - c.fetchedAt < THUMBNAIL_CACHE_TTL_MS) {
      result.set(assetId, c.url);
    } else if (assetId > 0) {
      missing.push(assetId);
    }
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const data = await fetchJson(`${THUMBNAIL_URL}?assetIds=${chunk.join(",")}&size=420x420&format=Png`, { timeoutMs: 6000, retries: 2 });
      for (const row of (Array.isArray(data.data) ? data.data : [])) {
        const id = normalizeNumber(row.targetId);
        const url = row.state === "Completed" ? String(row.imageUrl || "") : "";
        if (id > 0 && url) {
          thumbnailCache.set(id, { fetchedAt: Date.now(), url });
          result.set(id, url);
        }
      }
    } catch (e) {
      console.warn(`Thumbnail batch fetch failed: ${e.message}`);
    }
    if (i + 100 < missing.length) await sleep(150);
  }
  return result;
}

// Same idea as fetchThumbnailsBatch but for limited Bundles (a small,
// separate item type - a couple of these show up among manually-tracked new
// limiteds) - Roblox serves their thumbnails from a different endpoint keyed
// by bundleIds rather than assetIds.
async function fetchBundleThumbnailsBatch(bundleIds) {
  const result = new Map();
  const ids = bundleIds.filter(id => id > 0);
  if (!ids.length) return result;
  try {
    const data = await fetchJson(`${THUMBNAIL_BUNDLES_URL}?bundleIds=${ids.join(",")}&size=420x420&format=Png`, { timeoutMs: 6000, retries: 2 });
    for (const row of (Array.isArray(data.data) ? data.data : [])) {
      const id = normalizeNumber(row.targetId);
      const url = row.state === "Completed" ? String(row.imageUrl || "") : "";
      if (id > 0 && url) result.set(id, url);
    }
  } catch (e) {
    console.warn(`Bundle thumbnail fetch failed: ${e.message}`);
  }
  return result;
}

async function fetchResaleData(assetId) {
  const c = resaleCache.get(assetId);
  if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c.data;
  try {
    const d = await fetchJson(`${ROBLOX_RESALE_URL}/${assetId}/resale-data`, { retries: 2, timeoutMs: 5000 });
    resaleCache.set(assetId, { fetchedAt: Date.now(), data: d });
    return d;
  } catch { return {}; }
}

async function fetchCollectibleResaleData(cid) {
  const s = String(cid || "").trim();
  if (!s) return {};
  const k = `c:${s}`;
  const c = resaleCache.get(k);
  if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c.data;
  try {
    const d = await fetchJson(`${ROBLOX_COLLECTIBLE_RESALE_URL}/${encodeURIComponent(s)}/resale-data`, { retries: 2, timeoutMs: 3000 });
    resaleCache.set(k, { fetchedAt: Date.now(), data: d });
    return d;
  } catch { return {}; }
}

// Roblox has migrated resale-history data to the collectibleItemId-based API
// for most items now, regardless of assetId size (the old "assetId > 10B
// means UGC" heuristic no longer reliably predicts which API an item needs -
// newly-converted classic Limiteds can have large assetIds too). Prefer
// collectibleItemId when present, and fall back to the legacy per-assetId
// endpoint if that comes back empty or no collectibleItemId is known.
async function fetchAnyResaleData(assetId, collectibleItemId) {
  if (collectibleItemId) {
    const viaCollectible = await fetchCollectibleResaleData(collectibleItemId);
    if (viaCollectible && (viaCollectible.priceDataPoints?.length || viaCollectible.recentAveragePrice)) {
      return viaCollectible;
    }
  }
  return fetchResaleData(assetId);
}

function getPointVolume(p, useVal = false) {
  const v = Number(p?.salesVolume ?? p?.volume ?? p?.sales ?? p?.count ?? p?.quantity ?? (useVal ? p?.value : null));
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

function normalizeHistoryPoints(points, source = "resale") {
  if (!Array.isArray(points)) return [];
  return points
    .filter(p => typeof p.value === "number" && p.value > 0)
    .map(p => ({ value: p.value, date: String(p.date || ""), source: String(p.source || source || "resale"), salesVolume: getPointVolume(p) }))
    .filter(p => Number.isFinite(Date.parse(p.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(-5000);
}

function buildSalesHistory(pricePoints, volumePoints = [], fallbackPrice = null) {
  const pH = normalizeHistoryPoints(pricePoints);
  const vH = normalizeHistoryPoints(volumePoints, "volume");
  const fb = Number(fallbackPrice);
  const vByD = new Map();
  const usedD = new Set();
  for (const p of vH) {
    const k = new Date(Date.parse(p.date)).toISOString().slice(0, 10);
    const v = getPointVolume(p, true);
    if (k && v) vByD.set(k, (vByD.get(k) || 0) + v);
  }
  const sales = pH.map(p => {
    const k = new Date(Date.parse(p.date)).toISOString().slice(0, 10);
    const v = getPointVolume(p) ?? vByD.get(k) ?? 1;
    if (k && v) usedD.add(k);
    return { ...p, salesVolume: v || null };
  }).filter(p => p.value > 0 && p.salesVolume > 0);
  if (fb > 0) {
    for (const p of vH) {
      const k = new Date(Date.parse(p.date)).toISOString().slice(0, 10);
      if (!k || usedD.has(k)) continue;
      const v = getPointVolume(p, true);
      if (!v) continue;
      sales.push({ value: fb, date: p.date, source: "volume", salesVolume: v });
    }
  }
  return sales.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-5000);
}

function getStartOfTodayTime() {
  const n = new Date();
  n.setUTCHours(0, 0, 0, 0);
  return n.getTime();
}

function getPeriodStartTime(days) {
  if (!days) return 0;
  if (days === 1) return getStartOfTodayTime();
  return Date.now() - days * 86400000;
}

function getPeriodEndTime(days) {
  if (days === 1) return getStartOfTodayTime() + 86400000;
  return Date.now();
}

function findPeriodBaselineValue(history, days) {
  if (!history.length) return null;
  if (!days) return history[0].value;
  const target = getPeriodStartTime(days);
  const earliestTime = Date.parse(history[0].date);
  // If we don't have any snapshot old enough to actually represent "N days
  // ago", there is no honest baseline for this period yet - report no data
  // instead of silently comparing against a too-recent point and
  // mislabeling the timeframe.
  if (!Number.isFinite(earliestTime) || earliestTime > target) return null;
  let before = null;
  for (const p of history) {
    const t = Date.parse(p.date);
    if (t <= target && p.source !== "current") before = p.value;
    else if (t > target) break;
  }
  return before;
}

function percentChange(from, to) {
  if (!from || !to || from <= 0 || to <= 0) return null;
  return Math.round(((to - from) / from) * 10000) / 100;
}

function calculateDealValue(rap, price) {
  if (!rap || !price || rap <= 0 || price <= 0 || price >= rap) return null;
  return Math.round(rap - price);
}

function calculateDealPercent(rap, price) {
  const dv = calculateDealValue(rap, price);
  if (dv === null || rap <= 0) return null;
  return Math.round((dv / rap) * 10000) / 100;
}

function calculateOverpricedValue(rap, price) {
  if (!rap || !price || rap <= 0 || price <= rap) return null;
  return Math.round(price - rap);
}

function calculateOverpricedPercent(rap, price) {
  const ov = calculateOverpricedValue(rap, price);
  if (ov === null || rap <= 0) return null;
  return Math.round((ov / rap) * 10000) / 100;
}

function compareDealItems(a, b) {
  return ((b?.dealPercent || 0) - (a?.dealPercent || 0)) || ((b?.dealValue || 0) - (a?.dealValue || 0));
}

function compareOverpricedItems(a, b) {
  return ((b?.overpricedPercent || 0) - (a?.overpricedPercent || 0)) || ((b?.overpricedValue || 0) - (a?.overpricedValue || 0));
}

// Roblox only publishes sales/price history once per calendar day, and
// (confirmed by direct testing) with roughly a day's delay before "today"'s
// row shows up at all. A strict "since exactly N*24h ago" filter against the
// real clock intermittently lands on zero published days right as the
// calendar rolls over - showing a wrong "no sales" - and if a scan happens
// to run while the clock is mid-flip, it can straddle day boundaries in a
// way that quietly sums more days than intended. Counting off the data's own
// published days instead of the wall clock avoids both: collapse to one
// entry per calendar day (so the same day is never counted twice even if a
// point appears more than once) and take the most recently PUBLISHED `days`
// of them - stable, and never spuriously empty as long as the item has any
// recorded history at all.
function calculateSalesMetrics(points, days) {
  if (!Array.isArray(points) || !points.length || !days) return { salesCount: null, averageSalePrice: null };
  const byDay = new Map();
  for (const p of points) {
    if (!(p.value > 0)) continue;
    const vol = getPointVolume(p);
    if (!vol) continue;
    const ti = Date.parse(p.date);
    if (!Number.isFinite(ti)) continue;
    const k = new Date(ti).toISOString().slice(0, 10);
    // Later entries win on a duplicate day rather than accumulating - a
    // calendar day contributes at most once no matter how many raw points
    // reference it.
    byDay.set(k, { value: p.value, vol, ti });
  }
  const sortedDays = [...byDay.values()].sort((a, b) => a.ti - b.ti);
  const n = Math.max(1, Math.round(days));
  const window = sortedDays.slice(-n);
  let c = 0, t = 0;
  for (const d of window) { c += d.vol; t += d.value * d.vol; }
  return c <= 0 ? { salesCount: null, averageSalePrice: null } : { salesCount: c, averageSalePrice: Math.round(t / c) };
}

// BUG (fixed): this used to chop `items` into fixed-size batches and
// Promise.all() each batch before starting the next one. That means a single
// slow item (anything that falls through to the frozen legacy resale
// endpoint and has to burn its full 5s x2 retry timeout) stalled the other
// ~19 already-finished slots in its batch for the rest of that wait, instead
// of them picking up the next item immediately. Over a few-thousand-item
// scan those stalls compound badly - this is the main reason the sales scan
// was slow to finish. A rolling worker pool keeps every slot busy: as soon
// as one item finishes, that worker grabs the next one, with no batch
// boundaries for a slow item to block.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const SALES_PERIOD_DAYS = [1, 7, 30, 365]; // bought_24h / 7d / 30d / 1y
const SALES_CACHE_TTL_MS = Number(process.env.SALES_CACHE_TTL_MS || 30 * 60 * 1000);
let salesWarmupRunning = false;
// Same in-flight-dedup problem as the market index build: a cold cache plus
// concurrent visitors used to trigger multiple full ~2500-item sales scans at
// once (40-way-concurrent each), which is what made "Sort by Sales" hang
// forever under load. Every caller now shares one in-flight scan promise.
let salesScanPromise = null;

// Fetching resale history is the same live external call per item no matter
// which period you're asking about - only the local time-window filter in
// calculateSalesMetrics differs. Scanning the whole catalog ONCE and computing
// all four period buckets from that single pass (instead of a full separate
// catalog scan per period) is what makes it possible to keep every bucket
// warm without hammering Roblox's API four times as hard.
async function scanAllSalesMetrics(maxItems = ACTIVE_SALES_SCAN_LIMIT) {
  // Share one in-flight scan across every caller (cold-cache requests and the
  // proactive warm-up alike) instead of letting each start its own pass -
  // running two ~2500-item scans at once was enough on its own to trip
  // Roblox's rate limiting for the whole catalog build too.
  if (salesScanPromise) return salesScanPromise;
  salesScanPromise = (async () => {
    try {
      const allItems = await getRobloxMarketIndex();
      // If maxItems is ever set below the catalog size (env override), scan
      // the newest/highest-RAP items first rather than whatever order the
      // catalog happens to be in - assetId ascending, which used to mean the
      // OLDEST items always won the cap and every newer limited (manually
      // tracked ones especially) got silently starved of sales data.
      const candidates = allItems.filter(i => i.assetId > 0)
        .slice()
        .sort((a, b) => (b.assetId || 0) - (a.assetId || 0))
        .slice(0, maxItems);
      const maps = new Map(SALES_PERIOD_DAYS.map(d => [d, new Map()]));

      // This hits a completely different Roblox host/endpoint
      // (apis.roblox.com/marketplace-sales) than the catalog-details calls
      // that were tripping 429s, so it doesn't share that rate limit -
      // pushed back up from the very conservative 12 to get sales data ready
      // faster on a cold start, while staying well under the 40 that was
      // aggressive enough on its own to get rate-limited.
      await mapWithConcurrency(candidates, 20, async (item) => {
        const resale = await fetchAnyResaleData(item.assetId, item.collectibleItemId);
        const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, item.lowestPrice);
        for (const days of SALES_PERIOD_DAYS) {
          const sales = calculateSalesMetrics(salesHistory, days);
          maps.get(days).set(item.assetId, {
            salesCount: sales.salesCount,
            averageSalePrice: sales.averageSalePrice,
            salesSource: sales.salesCount ? "roblox" : null,
            salesEstimated: false,
          });
        }
      });

      return maps;
    } finally {
      salesScanPromise = null;
    }
  })();
  return salesScanPromise;
}

// Runs the full-catalog sales scan and refreshes every period bucket's cache
// at once. Called proactively (on startup and after each hourly snapshot) so
// a visitor's "sort by sales" request almost always hits an already-warm
// cache instead of triggering (and waiting out) a live multi-minute scan.
async function warmSalesMetrics() {
  if (salesWarmupRunning) return;
  salesWarmupRunning = true;
  try {
    console.log("Sales metrics warm-up started.");
    const maps = await scanAllSalesMetrics();
    const fetchedAt = Date.now();
    for (const [days, map] of maps) salesActivityCache.set(days, { fetchedAt, map });
    console.log(`Sales metrics warm-up done (${maps.get(1)?.size || 0} items scanned).`);
  } catch (e) {
    console.warn(`Sales metrics warm-up failed: ${e.message} - keeping previous cache.`);
  } finally {
    salesWarmupRunning = false;
  }
}

// Sales metrics require one live external fetch per item across the whole
// catalog, which is far too slow to do inline on every request (this is what
// was making "sort by sales" hang / never come back). warmSalesMetrics() is
// meant to keep this cache filled proactively.
//
// BUG (fixed): the true cold-start case (server just booted, nothing cached
// for this period yet) used to `await scanAllSalesMetrics()` right here,
// inline, blocking that visitor's actual HTTP request on a full catalog
// scan - on Render's free tier, every cold start (the service sleeps when
// idle) hit exactly this path, so the very first "Sort by Sales" or
// "Overpriced (Most Sales)" request after a wake-up would hang for minutes
// and typically time out client-side before the scan ever finished, which is
// what showed up as "sales not showing at all". There's no way to compute a
// real sales ordering without the data, so instead of blocking, kick the
// scan off in the background (same dedup as every other caller) and return
// an empty map immediately - the request still renders fast, just without
// sales figures for a few seconds, and self-corrects as soon as the
// background scan lands.
async function getSalesMetricsMap(days) {
  const cached = salesActivityCache.get(days);
  if (cached && Date.now() - cached.fetchedAt < SALES_CACHE_TTL_MS) return cached.map;
  // Stale-but-present or genuinely cold: either way, never block this
  // request on a live scan - serve what's cached (possibly nothing) and
  // let the background warm-up (deduped, so this is a no-op if one is
  // already running) fill it in for the next request.
  warmSalesMetrics().catch(() => {});
  return cached ? cached.map : new Map();
}

function buildRapChangeMetrics(ownHistory, currentRap) {
  const rawHistory = ownHistory.slice(-5000);
  if (rawHistory.length < 2) return {
    history: rawHistory, lossAllTime: null, loss1h: null, loss24h: null, loss7d: null, loss30d: null, loss1y: null,
    profitAllTime: null, profit1h: null, profit24h: null, profit7d: null, profit30d: null, profit1y: null,
    changeAllTime: null, change1h: null, change24h: null, change7d: null, change30d: null, change1y: null
  };
  const bAll = rawHistory[0].value;
  // 1h uses a true rolling window (now - 1 hour), unlike the calendar-based
  // "24h" baseline below - this is the fastest period to have honest data,
  // since it only needs one earlier hourly snapshot rather than a full day.
  const b1h = findPeriodBaselineValue(rawHistory, 1 / 24);
  const b24 = findPeriodBaselineValue(rawHistory, 1);
  const b7 = findPeriodBaselineValue(rawHistory, 7);
  const b30 = findPeriodBaselineValue(rawHistory, 30);
  const b1y = findPeriodBaselineValue(rawHistory, 365);
  const cAll = percentChange(bAll, currentRap);
  const c1h = percentChange(b1h, currentRap);
  const c24 = percentChange(b24, currentRap);
  const c7 = percentChange(b7, currentRap);
  const c30 = percentChange(b30, currentRap);
  const c1y = percentChange(b1y, currentRap);
  return {
    history: rawHistory.slice(-1000),
    lossAllTime: cAll !== null && cAll < 0 ? Math.abs(cAll) : null,
    loss1h: c1h !== null && c1h < 0 ? Math.abs(c1h) : null,
    loss24h: c24 !== null && c24 < 0 ? Math.abs(c24) : null,
    loss7d: c7 !== null && c7 < 0 ? Math.abs(c7) : null,
    loss30d: c30 !== null && c30 < 0 ? Math.abs(c30) : null,
    loss1y: c1y !== null && c1y < 0 ? Math.abs(c1y) : null,
    profitAllTime: cAll !== null && cAll > 0 ? cAll : null,
    profit1h: c1h !== null && c1h > 0 ? c1h : null,
    profit24h: c24 !== null && c24 > 0 ? c24 : null,
    profit7d: c7 !== null && c7 > 0 ? c7 : null,
    profit30d: c30 !== null && c30 > 0 ? c30 : null,
    profit1y: c1y !== null && c1y > 0 ? c1y : null,
    changeAllTime: cAll, change1h: c1h, change24h: c24, change7d: c7, change30d: c30, change1y: c1y,
  };
}

function snapshotStorageEnabled() {
  return SUPABASE_URL !== "" && SUPABASE_SERVICE_ROLE_KEY !== "";
}

async function supabaseRequest(path, options = {}) {
  if (!snapshotStorageEnabled()) return null;
  const requestUrl = `${SUPABASE_URL}/rest/v1/${path}`;
  try {
    const r = await fetch(requestUrl, {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
        ...(options.headers || {})
      }
    });
    if (!r.ok) {
      throw new Error(`Supabase ${r.status} for ${requestUrl}: ${(await r.text()).slice(0, 100)}`);
    }
    if (r.status === 204) return null;
    const t = await r.text();
    return t.trim() ? JSON.parse(t) : null;
  } catch (error) {
    throw new Error(`Supabase network error for ${requestUrl}: ${error.cause?.message || error.message}`);
  }
}

function normalizeSnapshotRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    value: Number(r.rap),
    lowestPrice: Number(r.lowest_price) || null,
    date: String(r.saved_at || ""),
    source: "own"
  })).filter(p => p.value > 0 && Number.isFinite(Date.parse(p.date)));
}

async function fetchStoredSnapshots(assetId) {
  if (!snapshotStorageEnabled()) return normalizeSnapshotRows(memorySnapshots.filter(r => r.asset_id === assetId));
  try {
    return normalizeSnapshotRows(await supabaseRequest(
      `limited_snapshots?asset_id=eq.${assetId}&select=rap,lowest_price,saved_at&order=saved_at.asc&limit=5000`,
      { headers: { Prefer: "" } }
    ));
  } catch { return []; }
}

// One bulk-fetched, cached (assetId -> history[]) map for the whole catalog,
// used by the Changes/Loss/Profit sorts. Those sorts need EVERY item's
// history to rank the whole catalog - calling fetchStoredSnapshots() per
// item (one Supabase round trip each) for ~2,500+ items serialized into
// minutes-long requests that just hung forever client-side. A handful of
// paginated bulk queries plus a short cache fixes that.
let snapshotsByAssetCache = { fetchedAt: 0, map: new Map() };
async function fetchAllStoredSnapshotsGrouped() {
  if (!snapshotStorageEnabled()) {
    const map = new Map();
    for (const r of memorySnapshots) {
      const id = Number(r.asset_id);
      if (!(id > 0)) continue;
      const arr = map.get(id) || [];
      arr.push({ value: Number(r.rap), lowestPrice: Number(r.lowest_price) || null, date: String(r.saved_at || ""), source: "own" });
      map.set(id, arr);
    }
    return map;
  }
  if (Date.now() - snapshotsByAssetCache.fetchedAt < CACHE_TTL_MS && snapshotsByAssetCache.map.size > 0) {
    return snapshotsByAssetCache.map;
  }
  try {
    const map = new Map();
    const pageSize = 1000;
    for (let page = 0, offset = 0; page < 500; page++, offset += pageSize) {
      const rows = await supabaseRequest(
        `limited_snapshots?select=asset_id,rap,lowest_price,saved_at&order=saved_at.asc&limit=${pageSize}&offset=${offset}`,
        { headers: { Prefer: "" } }
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        const id = Number(r.asset_id);
        const value = Number(r.rap);
        const date = String(r.saved_at || "");
        if (id > 0 && value > 0 && Number.isFinite(Date.parse(date))) {
          const arr = map.get(id) || [];
          arr.push({ value, lowestPrice: Number(r.lowest_price) || null, date, source: "own" });
          map.set(id, arr);
        }
      }
      if (rows.length < pageSize) break;
    }
    if (map.size > 0) snapshotsByAssetCache = { fetchedAt: Date.now(), map };
    return snapshotsByAssetCache.map;
  } catch (e) {
    console.warn(`Bulk snapshot fetch failed: ${e.message} - keeping previous cache (${snapshotsByAssetCache.map.size} items).`);
    return snapshotsByAssetCache.map;
  }
}

async function saveSnapshotRows(rows) {
  if (!rows.length || !snapshotStorageEnabled()) return;
  memorySnapshots.push(...rows);
  for (let i = 0; i < rows.length; i += 500) {
    try {
      await supabaseRequest("limited_snapshots", { method: "POST", body: JSON.stringify(rows.slice(i, i + 500)) });
    } catch (e) {
      console.warn(`Save err: ${e.message}`);
    }
  }
}

async function upsertLimitedItemsTable(items) {
  if (!items.length || !snapshotStorageEnabled()) return;
  for (let i = 0; i < items.length; i += 500) {
    try {
      // Note: items intentionally omit first_seen_at - on_conflict merge only
      // touches columns present in the payload, so a fresh row gets the
      // column's own default (now()) while an existing row's first_seen_at
      // is left untouched. That gives every item a true "first tracked by
      // us" timestamp, which is what the "Recent" sort is built on.
      await supabaseRequest("limited_items?on_conflict=asset_id", {
        method: "POST",
        body: JSON.stringify(items.slice(i, i + 500)),
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" }
      });
    } catch (e) {
      console.warn(`Upsert skipped: ${e.message}`);
    }
  }
}

// Cached (asset_id -> first_seen_at ms) used to power the "Recent" sort.
// Raw Roblox assetId order is not a reliable proxy for "recently became a
// limited" - Roblox's ID space is shared across everything it creates, so a
// years-old item can have a far larger ID than a limited from last week
// (e.g. a 2024 "Innovation Awards" item vs. a brand-new classic limited).
// first_seen_at instead reflects when OUR snapshot pipeline first saw the
// item, which correctly floats genuinely new discoveries to the top.
let firstSeenCache = { fetchedAt: 0, map: new Map() };
async function fetchFirstSeenMap() {
  if (!snapshotStorageEnabled()) return firstSeenCache.map;
  if (Date.now() - firstSeenCache.fetchedAt < CACHE_TTL_MS && firstSeenCache.map.size > 0) return firstSeenCache.map;
  try {
    const rows = await supabaseRequest("limited_items?select=asset_id,first_seen_at&limit=20000", { headers: { Prefer: "" } });
    const map = new Map();
    for (const row of (rows || [])) {
      const id = Number(row.asset_id);
      const ts = Date.parse(row.first_seen_at);
      if (id > 0 && Number.isFinite(ts)) map.set(id, ts);
    }
    if (map.size > 0) firstSeenCache = { fetchedAt: Date.now(), map };
    return firstSeenCache.map;
  } catch (e) {
    console.warn(`first_seen_at fetch failed: ${e.message}`);
    return firstSeenCache.map;
  }
}

// ----------------------------------------------------------------------------
// Rolimons: the single source of truth for classic-limiteds RAP/Value/demand.
// ----------------------------------------------------------------------------
async function fetchRolimonsCatalog() {
  if (rolimonsCatalogCache.items.size > 0 && Date.now() - rolimonsCatalogCache.fetchedAt < ROLIMONS_CACHE_TTL_MS) {
    return rolimonsCatalogCache.items;
  }
  try {
    const data = await fetchJson(ROLIMONS_ITEM_DETAILS_URL, { timeoutMs: 15000, retries: 2 });
    const items = new Map();
    for (const [idStr, arr] of Object.entries(data.items || {})) {
      const id = Number(idStr);
      if (id <= 0 || !Array.isArray(arr)) continue;
      const rawRap = Number(arr[RL_RAP]);
      const rlValue = Number(arr[RL_VALUE]);
      // A missing/zero RAP (-1 or 0) means Rolimons hasn't accumulated resale
      // history for this item yet - very common for brand-new limiteds - not
      // that it isn't a real classic limited. Skipping those used to drop a
      // large chunk of the catalog (new items especially); fall back to
      // Rolimons' "Value" figure instead of excluding the item entirely.
      const rap = Number.isFinite(rawRap) && rawRap > 0
        ? rawRap
        : (Number.isFinite(rlValue) && rlValue > 0 ? rlValue : null);
      const demand = arr[RL_DEMAND] ?? -1;
      const trend = arr[RL_TREND] ?? -1;
      items.set(id, {
        assetId: id,
        name: String(arr[RL_NAME] || "Unknown"),
        acronym: String(arr[RL_ACRONYM] || ""),
        rap,
        value: Number.isFinite(rlValue) && rlValue > 0 ? rlValue : null,
        demand: Number(demand),
        demandLabel: DEMAND_LABELS[String(demand)] ?? null,
        trend: Number(trend),
        trendLabel: TREND_LABELS[String(trend)] ?? null,
        projected: arr[RL_PROJECTED] === 1,
        hyped: arr[RL_HYPED] === 1,
        rare: arr[RL_RARE] === 1,
      });
    }
    if (items.size > 0) {
      rolimonsCatalogCache = { fetchedAt: Date.now(), items };
      console.log(`Rolimons catalog refreshed: ${items.size} classic limiteds.`);
    } else {
      console.warn("Rolimons catalog fetch returned 0 items - keeping previous cache.");
    }
    return rolimonsCatalogCache.items;
  } catch (e) {
    console.warn(`Rolimons catalog fetch failed: ${e.message} - keeping previous cache (${rolimonsCatalogCache.items.size} items).`);
    return rolimonsCatalogCache.items;
  }
}

// Rolimons only adds an item to its tracked list some time after Roblox
// converts it to a Limited - fetches live catalog-details + thumbnails for
// the manually-maintained MANUAL_NEW_LIMITEDS list (see its definition)
// so those items get tracked immediately instead of waiting on Rolimons.
async function fetchManualNewLimiteds(knownAssetIds) {
  const pending = MANUAL_NEW_LIMITEDS.filter(m => m.id > 0 && !knownAssetIds.has(m.id));
  if (!pending.length) return [];

  let data;
  try {
    data = await fetchCatalogDetailsChunk(pending.map(m => ({ id: m.id, itemType: m.itemType })));
  } catch (e) {
    console.warn(`Manual new-limiteds catalog lookup failed: ${e.message}`);
    return [];
  }

  const rows = Array.isArray(data.data) ? data.data : [];
  const rowsById = new Map(rows.map(r => [normalizeNumber(r.id), r]));
  const assetIds = pending.filter(m => m.itemType !== "Bundle").map(m => m.id);
  const bundleIds = pending.filter(m => m.itemType === "Bundle").map(m => m.id);
  const [assetThumbs, bundleThumbs] = await Promise.all([
    assetIds.length ? fetchThumbnailsBatch(assetIds) : new Map(),
    bundleIds.length ? fetchBundleThumbnailsBatch(bundleIds) : new Map(),
  ]);

  const discovered = [];
  for (const m of pending) {
    const row = rowsById.get(m.id);
    if (!row) continue;
    if (!(row.itemRestrictions || []).includes("Limited")) continue;
    row.__isBundle = m.itemType === "Bundle";
    row.__thumbnailUrl = (m.itemType === "Bundle" ? bundleThumbs : assetThumbs).get(m.id) || "";
    discovered.push(row);
  }
  return discovered;
}

// Builds the full classic-limiteds catalog: Rolimons for RAP/Value/demand
// (the whole catalog, one request), Roblox's batched catalog-details for
// current lowest price / availability (fast: ~1 request per 100 items),
// plus a bounded Roblox-side scan to catch brand-new limiteds Rolimons
// hasn't picked up yet.
async function buildClassicLimitedsCatalog() {
  const rolimonsItems = await fetchRolimonsCatalog();
  if (rolimonsItems.size === 0) return [];

  const assetIds = [...rolimonsItems.keys()];
  const priceDetails = await fetchCatalogDetailsBatch(assetIds);
  // `thumbnail` (rbxthumb://) below only renders inside Roblox itself (Studio
  ///the game client) - a browser can't load that protocol at all, which is
  // why the website showed no images. `thumbnailUrl` is the real hotlinkable
  // rbxcdn.com URL the website's <img> tags actually need.
  const thumbnails = await fetchThumbnailsBatch(assetIds);

  const items = [];
  for (const [id, base] of rolimonsItems) {
    const details = priceDetails.get(id) || {};
    const lowestPrice = firstPositiveNumber(details.lowestPrice, details.price);
    items.push({
      ...base,
      lowestPrice,
      // Roblox's actual field names here are unitsAvailableForConsumption /
      // totalQuantity - this was reading .available / .unitsAvailable, which
      // don't exist on the response at all, so Available and Total copies
      // silently showed 0 for every single item.
      availableCopies: firstNonNegativeNumber(details.unitsAvailableForConsumption),
      totalCopies: firstPositiveNumber(details.totalQuantity),
      collectibleItemId: String(details.collectibleItemId || ""),
      itemType: "Asset",
      marketType: "roblox",
      creatorName: details.creatorName || "Roblox",
      thumbnail: `rbxthumb://type=Asset&id=${id}&w=420&h=420`,
      thumbnailUrl: thumbnails.get(id) || "",
      dealValue: calculateDealValue(base.rap, lowestPrice),
      dealPercent: calculateDealPercent(base.rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(base.rap, lowestPrice),
      overpricedPercent: calculateOverpricedPercent(base.rap, lowestPrice),
    });
  }

  try {
    const newlyLimited = await fetchManualNewLimiteds(rolimonsItems);
    for (const row of newlyLimited) {
      const id = normalizeNumber(row.id);
      const resale = await fetchAnyResaleData(id, row.collectibleItemId);
      const lowestPrice = firstPositiveNumber(row.lowestPrice, row.price);
      // A brand-new limited may have zero resale history yet (nobody has
      // resold a copy), which used to mean recentAveragePrice was unavailable
      // and the item got dropped entirely - exactly the "new ones missing"
      // case. Fall back to its current listed price as a stand-in RAP rather
      // than excluding it; only skip if we truly have no number at all.
      const rap = firstPositiveNumber(resale.recentAveragePrice, row.price, lowestPrice);
      if (!(rap > 0)) continue;
      items.push({
        assetId: id, name: row.name || "Unknown", acronym: "", rap,
        value: null, demand: -1, demandLabel: null, trend: -1, trendLabel: null,
        projected: false, hyped: false, rare: false,
        lowestPrice,
        availableCopies: firstNonNegativeNumber(row.unitsAvailableForConsumption),
        totalCopies: firstPositiveNumber(row.totalQuantity),
        collectibleItemId: String(row.collectibleItemId || ""),
        itemType: row.__isBundle ? "Bundle" : "Asset", marketType: "roblox", creatorName: row.creatorName || "Roblox",
        thumbnail: `rbxthumb://type=Asset&id=${id}&w=420&h=420`,
        thumbnailUrl: row.__thumbnailUrl || "",
        dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
        overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
      });
    }
    if (newlyLimited.length > 0) {
      console.log(`Added ${newlyLimited.length} manually-tracked new limited(s) not yet on Rolimons.`);
    }
  } catch (e) {
    console.warn(`Manual new-limiteds lookup failed: ${e.message}`);
  }

  return items;
}

// In-flight build lock: right after a fresh deploy, several requests can land
// before the cache is warm and each used to kick off its OWN full catalog
// build (a full pass of Roblox catalog-detail batches) at the same time - the
// direct cause of the mass 429 storms seen in production. Every caller that
// arrives while a build is already running now awaits that SAME promise
// instead of starting a duplicate one.
let marketIndexBuildPromise = null;

async function warmMarketIndex() {
  if (marketIndexBuildPromise) return marketIndexBuildPromise;
  marketIndexBuildPromise = (async () => {
    try {
      const items = await buildClassicLimitedsCatalog();
      if (items.length > 0) {
        marketIndexCache.set("roblox", { items, cachedAt: Date.now() });
      }
      console.log(`Roblox market index warmed with ${items.length} priced limiteds.`);
      return items;
    } finally {
      marketIndexBuildPromise = null;
    }
  })();
  return marketIndexBuildPromise;
}

async function getRobloxMarketIndex() {
  // The hourly runSnapshot() job keeps this cache fresh in the background.
  // Only fall back to a live (slow-ish) on-demand build if nothing has been
  // cached yet at all - e.g. right after a fresh deploy/restart, before the
  // first snapshot has completed. This avoids blocking a visitor's request
  // on a live catalog build every few minutes.
  const cached = marketIndexCache.get("roblox");
  if (cached && cached.items.length > 0) {
    return cached.items;
  }
  return warmMarketIndex();
}

async function handleLimitedsRequest(req, res, parsedUrl) {
  const p = parsedUrl.searchParams;
  // Classic Roblox limiteds only - UGC limiteds (a separate, newer Roblox
  // marketplace category that Rolimons doesn't track) are not supported.
  const marketType = "roblox";
  const sort = p.get("sort") || "updated";
  const keyword = (p.get("keyword") || "").trim();
  const cursor = (p.get("cursor") || "").trim();
  const limit = normalizeLimit(p.get("limit"));
  const minPrice = parseOptionalNumber(p.get("minPrice"));
  const maxPrice = parseOptionalNumber(p.get("maxPrice"));
  const minRap = parseOptionalNumber(p.get("minRap"));
  const maxRap = parseOptionalNumber(p.get("maxRap"));
  const minSalesPerDay = parseOptionalNumber(p.get("minSalesPerDay"));
  // Signed - "below RAP"/"below Value" are meaningful, legitimate thresholds
  // (e.g. maxPriceVsRap: -20 -> only items priced at least 20% under RAP),
  // so these two intentionally allow negative values where minPrice/minRap
  // above don't.
  const minRapVsValue = parseOptionalNumber(p.get("minRapVsValue"));
  const maxRapVsValue = parseOptionalNumber(p.get("maxRapVsValue"));
  const minPriceVsRap = parseOptionalNumber(p.get("minPriceVsRap"));
  const maxPriceVsRap = parseOptionalNumber(p.get("maxPriceVsRap"));

  const cacheKey = makePageCacheKey({
    marketType, sort, keyword, cursor, limit, minPrice, maxPrice, minRap, maxRap,
    minSalesPerDay, minRapVsValue, maxRapVsValue, minPriceVsRap, maxPriceVsRap,
  });
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

  let items = await getRobloxMarketIndex();
  // Hide items with no purchasable price at all - the user only wants
  // limiteds that actually show a price, not off-sale/no-price items.
  items = items.filter(i => i.lowestPrice > 0);
  if (keyword) { const lk = keyword.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(lk)); }
  if (minPrice > 0) items = items.filter(i => !i.lowestPrice || i.lowestPrice >= minPrice);
  if (maxPrice > 0) items = items.filter(i => !i.lowestPrice || i.lowestPrice <= maxPrice);
  if (minRap > 0) items = items.filter(i => i.rap >= minRap);
  if (maxRap > 0) items = items.filter(i => i.rap <= maxRap);

  // Both are already-known, static-per-item Rolimons figures (no live sales
  // fetch needed) - computed for every item up front so any sort can display
  // them and the two range filters below can apply regardless of sort.
  // rapVsValuePercent: RAP is Rolimons' own "Recent Average Price" - what the
  // item ACTUALLY sells for on Roblox lately. Value is Rolimons' separate,
  // more conservative estimate. When RAP is meaningfully above Value, the
  // item is trading for more than Rolimons' own value figure suggests - a
  // real demand signal Value alone misses (e.g. RAP 30,123 vs Value 35,000
  // is trading BELOW value, not a deal on this measure - the reverse case,
  // RAP above Value, is the "good deal" signal being surfaced here).
  // priceVsRapPercent: how far the current asking price sits from RAP -
  // positive means priced above what it actually sells for (overpriced),
  // negative means priced below it (a bargain vs. its own trading history).
  for (const item of items) {
    item.rapVsValuePercent = (item.value > 0 && item.rap > 0)
      ? Math.round(((item.rap - item.value) / item.value) * 10000) / 100
      : null;
    item.priceVsRapPercent = (item.rap > 0 && item.lowestPrice > 0)
      ? Math.round(((item.lowestPrice - item.rap) / item.rap) * 10000) / 100
      : null;
  }
  if (minRapVsValue !== null) items = items.filter(i => i.rapVsValuePercent !== null && i.rapVsValuePercent >= minRapVsValue);
  if (maxRapVsValue !== null) items = items.filter(i => i.rapVsValuePercent !== null && i.rapVsValuePercent <= maxRapVsValue);
  if (minPriceVsRap !== null) items = items.filter(i => i.priceVsRapPercent !== null && i.priceVsRapPercent >= minPriceVsRap);
  if (maxPriceVsRap !== null) items = items.filter(i => i.priceVsRapPercent !== null && i.priceVsRapPercent <= maxPriceVsRap);

  if (minSalesPerDay !== null && minSalesPerDay > 0) {
    // A week's average smooths out the noise a single slow/busy day would
    // introduce into a hard cutoff like this.
    const salesMap7 = await getSalesMetricsMap(7);
    items = items.filter(i => {
      const s = salesMap7.get(i.assetId);
      const perDay = s?.salesCount != null ? s.salesCount / 7 : 0;
      i.salesPerDay = Math.round(perDay * 10) / 10;
      return perDay >= minSalesPerDay;
    });
  }

  if (sort === "price_asc") items.sort((a, b) => (a.lowestPrice || Infinity) - (b.lowestPrice || Infinity));
  else if (sort === "rap_desc") items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  else if (sort === "value_desc") items.sort((a, b) => (b.value || 0) - (a.value || 0));
  else if (sort === "deal_desc") items.sort(compareDealItems);
  else if (sort === "overpriced_desc") items.sort(compareOverpricedItems);
  else if (sort === "rap_above_value_desc") {
    // Items with no rapVsValuePercent (missing RAP or Value) have nothing to
    // rank here - push them to the very end instead of tying them with a
    // legitimate 0%.
    items.sort((a, b) => {
      const av = a.rapVsValuePercent, bv = b.rapVsValuePercent;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }
  else if (sort.startsWith("overpriced_sales_")) {
    // "Overpriced (Most Sales)" - surfaces overpriced limiteds that are
    // actually moving, not just theoretically overpriced with no buyers.
    // Most sales first, overpriced% as the tiebreak among equal sales counts.
    const days = { overpriced_sales_24h: 1, overpriced_sales_7d: 7, overpriced_sales_30d: 30, overpriced_sales_1y: 365 }[sort];
    if (days) {
      const salesMap = await getSalesMetricsMap(days);
      for (const item of items) {
        const s = salesMap.get(item.assetId);
        if (s) Object.assign(item, s);
      }
      items.sort((a, b) => ((b.salesCount || 0) - (a.salesCount || 0)) || ((b.overpricedPercent || 0) - (a.overpricedPercent || 0)));
    } else {
      items.sort(compareOverpricedItems);
    }
  } else if (sort.startsWith("bought_")) {
    const days = { bought_24h: 1, bought_7d: 7, bought_30d: 30, bought_1y: 365 }[sort];
    if (days) {
      const salesMap = await getSalesMetricsMap(days);
      for (const item of items) {
        const s = salesMap.get(item.assetId);
        if (s) Object.assign(item, s);
      }
      items.sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0));
    }
  } else if (sort.startsWith("loss_") || sort.startsWith("profit_")) {
    const isLoss = sort.startsWith("loss_");
    const suffix = sort.replace("loss_", "").replace("profit_", "");
    const days = { "_1h": 1 / 24, "_24h": 1, "_7d": 7, "_30d": 30, "_1y": 365, "_all": null }[`_${suffix}`];
    const fieldSuffix = suffix === "all" ? "AllTime" : suffix;
    const snapshotsByAsset = await fetchAllStoredSnapshotsGrouped();
    for (const item of items) {
      const history = snapshotsByAsset.get(item.assetId) || [];
      Object.assign(item, buildRapChangeMetrics(history, item.rap));
    }
    items.sort((a, b) => {
      const l = a[isLoss ? `loss${fieldSuffix}` : `profit${fieldSuffix}`] || 0;
      const r = b[isLoss ? `loss${fieldSuffix}` : `profit${fieldSuffix}`] || 0;
      return r - l;
    });
  } else {
    // "Recent" = newest limiteds added to Roblox itself, not when our own
    // pipeline happened to first scan them. Our own first-seen timestamps
    // are all clustered around whenever this tracker itself started running,
    // so they don't reflect the item's real age on Roblox at all. Roblox
    // assigns asset IDs sequentially as items are created, so a higher
    // assetId reliably means the item appeared on Roblox more recently -
    // that's the correct, always-available signal for "newest".
    items.sort((a, b) => (b.assetId || 0) - (a.assetId || 0));
  }

  const startIdx = cursor ? parseInt(cursor, 10) || 0 : 0;
  const pagedItems = items.slice(startIdx, startIdx + limit);
  const nextCursor = (startIdx + limit < items.length) ? String(startIdx + limit) : "";
  const result = { ok: true, items: pagedItems, nextPageCursor: nextCursor, updatedAt: new Date().toISOString() };
  pageCache.set(cacheKey, { cachedAt: Date.now(), data: result });
  return sendJson(res, 200, result);
}

async function handleItemDetailsRequest(req, res, parsedUrl) {
  const p = parsedUrl.searchParams;
  const assetId = normalizeNumber(Number(p.get("assetId")));
  const collectibleItemId = (p.get("collectibleItemId") || "").trim();
  if (assetId <= 0) return sendJson(res, 400, { ok: false, error: "Missing assetId" });

  const cacheKey = `details:${assetId}:${collectibleItemId}`;
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

  try {
    // rolimonsItems, catalogDetails and ownHistory don't depend on each
    // other - they used to run one after another (three sequential
    // round-trips, one of them to Supabase) purely because they were written
    // top to bottom. Only resaleDetails genuinely has to wait, since it
    // needs catalogDetails.collectibleItemId first. Running the independent
    // three in parallel is a straightforward win for how long the item modal
    // takes to open, especially on a cache-cold hit.
    const [rolimonsItems, catalogDetails, ownHistory] = await Promise.all([
      fetchRolimonsCatalog(),
      fetchCatalogDetailsBatch([assetId]).then(m => m.get(assetId) || {}),
      fetchStoredSnapshots(assetId),
    ]);
    const rolimonsItem = rolimonsItems.get(assetId);

    // catalogDetails is fetched fresh (cache or a live single-item lookup)
    // every time this endpoint is hit, so its collectibleItemId is reliable
    // even for an item whose bulk catalog-build batch got 429'd earlier and
    // never cached one. The URL's own collectibleItemId param (whatever the
    // list page happened to have when the card was built) used to be used
    // instead and ignored this fresher value entirely - for any item that
    // fell through the bulk build with a blank id, this silently sent every
    // detail request down the legacy per-assetId resale endpoint, which
    // Roblox has left frozen since Jan 2025 - exactly why "7d" and longer
    // ranges kept coming back as "not enough history" for a lot of items
    // that actually have plenty. Prefer the fresh id; the query param is
    // only a fallback for the rare case the live lookup itself comes back
    // empty too.
    const resaleDetails = await fetchAnyResaleData(assetId, catalogDetails.collectibleItemId || collectibleItemId);

    // Same RAP/Value source as the catalog list, so a given item's numbers
    // can never disagree between the list and its own detail popup. Live
    // Roblox data is only used as a last resort for items Rolimons doesn't
    // track (very rare for classic limiteds).
    const rap = firstPositiveNumber(rolimonsItem?.rap, resaleDetails.recentAveragePrice, catalogDetails.price);
    const lowestPrice = firstPositiveNumber(catalogDetails.lowestPrice, resaleDetails.lowestResalePrice);

    let item = {
      assetId,
      name: rolimonsItem?.name || catalogDetails.name || "Unknown",
      rap,
      value: rolimonsItem?.value ?? null,
      demand: rolimonsItem?.demand ?? null,
      demandLabel: rolimonsItem?.demandLabel ?? null,
      trend: rolimonsItem?.trend ?? null,
      trendLabel: rolimonsItem?.trendLabel ?? null,
      projected: rolimonsItem?.projected ?? false,
      hyped: rolimonsItem?.hyped ?? false,
      rare: rolimonsItem?.rare ?? false,
      lowestPrice,
      availableCopies: firstNonNegativeNumber(catalogDetails.unitsAvailableForConsumption, resaleDetails.numberRemaining),
      totalCopies: firstPositiveNumber(catalogDetails.totalQuantity),
      collectibleItemId: String(catalogDetails.collectibleItemId || collectibleItemId),
      itemType: catalogDetails.itemType || "Asset", marketType: "roblox",
      creatorName: catalogDetails.creatorName || "Roblox",
      thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
      dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice)
    };

    // resaleDetails.priceDataPoints is Roblox's OWN historical record for this
    // item - typically stretching back over its whole resale life, not just
    // the (short, recent) window our own hourly snapshots have accumulated.
    // ownHistory is merged in on top only to fill in anything more recent
    // than Roblox's own last-updated point; it's never the primary source.
    const resaleHistory = normalizeHistoryPoints(resaleDetails.priceDataPoints);
    const combinedHistory = [...ownHistory, ...resaleHistory].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-5000);
    Object.assign(item, buildRapChangeMetrics(combinedHistory, rap), { history: combinedHistory });

    // Same idea for sales: buildSalesHistory is already built from Roblox's
    // full price+volume history (not just what we've personally observed),
    // so totalQuantitySold/averagePrice below cover the item's whole
    // recorded trading history, the way Rolimons' own chart does - not just
    // a short recent window.
    const salesHistory = buildSalesHistory(resaleDetails.priceDataPoints, resaleDetails.volumeDataPoints, lowestPrice);
    const totalQuantitySold = salesHistory.reduce((sum, p) => sum + (p.salesVolume || 0), 0);
    Object.assign(item, calculateSalesMetrics(salesHistory, 1), {
      volume24h: calculateSalesMetrics(salesHistory, 1).salesCount,
      volume7d: calculateSalesMetrics(salesHistory, 7).salesCount,
      totalQuantitySold: totalQuantitySold > 0 ? totalQuantitySold : null,
      originalPrice: firstPositiveNumber(resaleDetails.originalPrice) || null,
      salesHistory,
    });
    detailCache.set(cacheKey, { cachedAt: Date.now(), data: item });
    return sendJson(res, 200, item);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: "Failed to load item details" });
  }
}

async function handlePortfolioRequest(req, res, parsedUrl) {
  const userId = parsedUrl.searchParams.get("userId");
  if (!userId) return sendJson(res, 400, { ok: false, error: "Missing userId" });

  const cacheKey = `portfolio:${userId}`;
  const cached = portfolioCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

  try {
    const data = await fetchJson(`${ROBLOX_INVENTORY_URL}/${userId}/assets/collectibles?limit=100&sortOrder=Asc`, { retries: 2, timeoutMs: 5000 });
    const rawItems = data.data || [];
    if (!rawItems.length) return sendJson(res, 200, { ok: true, items: [], stats: {}, charts: {} });

    const assetIds = rawItems.map(i => normalizeNumber(i.assetId)).filter(id => id > 0);
    const [catalogDetails, rolimonsItems] = await Promise.all([
      fetchCatalogDetailsBatch(assetIds),
      fetchRolimonsCatalog()
    ]);

    const items = (await Promise.all(rawItems.map(async (raw) => {
      const assetId = normalizeNumber(raw.assetId);
      const rolimonsItem = rolimonsItems.get(assetId);
      // Classic Roblox limiteds only. Rolimons is the primary check, but a
      // brand-new Limited Rolimons hasn't tracked yet still carries a real
      // recentAveragePrice from Roblox's own inventory endpoint, so accept
      // that too rather than hiding a player's genuinely-owned new limited.
      if (!rolimonsItem && !(raw.recentAveragePrice > 0)) return null;
      const details = catalogDetails.get(assetId) || {};
      // Same RAP/Value source as the catalog list and item details, so a
      // player's portfolio always agrees with what those views show.
      const rap = firstPositiveNumber(rolimonsItem?.rap, raw.recentAveragePrice, details.price);
      const lowestPrice = firstPositiveNumber(raw.price, details.lowestPrice);
      const ownHistory = await fetchStoredSnapshots(assetId);
      return {
        assetId, name: rolimonsItem?.name || details.name || raw.name || "Unknown", rap,
        value: rolimonsItem?.value ?? null, lowestPrice,
        quantity: raw.owned || 1, collectibleItemId: String(raw.collectibleItemId || details.collectibleItemId || ""),
        marketType: "roblox",
        ...buildRapChangeMetrics(ownHistory, rap)
      };
    }))).filter(Boolean);
    const result = { ok: true, items };
    portfolioCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: "Failed to fetch Roblox inventory" });
  }
}

async function runSnapshot() {
  if (snapshotRunning) return;
  snapshotRunning = true;
  console.log("Snapshot started.");
  try {
    const items = await buildClassicLimitedsCatalog();
    if (items.length > 0) {
      // Publish the fresh catalog - and kick off the sales warm-up against it
      // - as soon as it's built, rather than waiting for the Supabase writes
      // below to finish first. Those writes are just persistence for our own
      // history; they don't need to block "sort by sales" from becoming
      // available, and previously they did, adding several extra seconds to
      // every cold start before sales data showed up at all.
      marketIndexCache.set("roblox", { items, cachedAt: Date.now() });
      pageCache.clear();
      warmSalesMetrics().catch(e => console.error(`Sales warm-up error: ${e.message}`));
    }
    // `rap` is a NOT NULL column in both tables. A handful of items (very
    // rare, brand-new/untraded ones) still come back with no rap at all even
    // after the Rolimons value fallback - previously those null values were
    // sent to Supabase anyway, which rejects the WHOLE batch of 500 they
    // happened to land in (a single bad row poisons the other ~499 good
    // ones). Filter them out before saving instead of letting that happen.
    const withRap = items.filter(i => i.rap > 0);
    await saveSnapshotRows(withRap.map(i => ({ asset_id: i.assetId, rap: i.rap, lowest_price: i.lowestPrice || null, saved_at: new Date().toISOString() })));
    await upsertLimitedItemsTable(withRap.map(i => ({
      asset_id: i.assetId, collectible_item_id: i.collectibleItemId, name: i.name, rap: i.rap, value: i.value,
      lowest_price: i.lowestPrice || null, available_copies: i.availableCopies || 0, total_copies: i.totalCopies || 0,
      saved_at: new Date().toISOString()
    })));
    console.log(`Snapshot saved ${withRap.length}/${items.length} rows to supabase.`);
  } catch (e) {
    console.error(`Snapshot failed: ${e.message}`);
  } finally {
    snapshotRunning = false;
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  try {
    if (parsedUrl.pathname === "/ping") return sendJson(res, 200, { status: "awake", version: SERVER_VERSION });
    if (parsedUrl.pathname === "/" || parsedUrl.pathname === "/app") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(DASHBOARD_HTML);
    }
    if (parsedUrl.pathname === "/api/limiteds") return await handleLimitedsRequest(req, res, parsedUrl);
    if (parsedUrl.pathname === "/api/item") return await handleItemDetailsRequest(req, res, parsedUrl);
    if (parsedUrl.pathname === "/api/portfolio") return await handlePortfolioRequest(req, res, parsedUrl);
    if (parsedUrl.pathname === "/api/trigger-snapshot" && req.method === "POST") {
      runSnapshot().catch(e => console.error(e.message));
      return sendJson(res, 200, { ok: true, message: "Snapshot triggered" });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`Unhandled error: ${error.message}`);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

async function startServer() {
  console.log("Waiting for Render network to be ready...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  server.listen(PORT, () => console.log(`Limiteds Live server ${SERVER_VERSION} running on http://localhost:${PORT}`));
}

startServer();
if (snapshotStorageEnabled()) {
  setTimeout(() => runSnapshot().catch(e => console.error(e.message)), 10000);
  setInterval(() => runSnapshot().catch(e => console.error(e.message)), SNAPSHOT_INTERVAL_MS);
  console.log(`Recurring snapshots scheduled every ${Math.round(SNAPSHOT_INTERVAL_MS / 60000)} minute(s).`);
}
