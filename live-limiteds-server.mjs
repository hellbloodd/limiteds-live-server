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
const ROBLOX_SEARCH_URL = "https://catalog.roblox.com/v1/search/items/details";
// How many pages (30 items each) of Roblox's own "Bestselling, Past Week"
// feed to scan per snapshot for brand-new classic limiteds that Rolimons
// hasn't added to its tracked list yet. A newly-converted Limited item
// reliably spikes into weekly bestsellers within hours, so this catches new
// items fast without scanning (or rate-limiting against) the whole catalog.
const NEW_LIMITED_DISCOVERY_PAGES = Number(process.env.NEW_LIMITED_DISCOVERY_PAGES || 100);
const ALLOWED_LIMITS = [10, 28, 30];
const ACTIVE_SALES_SCAN_LIMIT = Number(process.env.ACTIVE_SALES_SCAN_LIMIT || 3000);

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

function makePageCacheKey({ marketType, sort, keyword, cursor, limit, minPrice, maxPrice, minRap, maxRap }) {
  return [marketType, sort, keyword, cursor || "", limit, minPrice ?? "", maxPrice ?? "", minRap ?? "", maxRap ?? ""].join(":");
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
  const body = JSON.stringify({ items: assetIds.map(id => ({ itemType: "Asset", id })) });
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
  for (let i = 0; i < missing.length; i += 100) {
    let data;
    try {
      data = await fetchCatalogDetailsChunk(missing.slice(i, i + 100));
    } catch (e) {
      if (result.size > 0) break;
      throw e;
    }
    for (const row of (Array.isArray(data.data) ? data.data : [])) {
      const id = normalizeNumber(row.id);
      if (id > 0) {
        catalogDetailCache.set(id, { fetchedAt: Date.now(), data: row });
        result.set(id, row);
      }
    }
    if (i + 100 < missing.length) await sleep(220);
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

function calculateSalesMetrics(points, days) {
  if (!Array.isArray(points) || !days) return { salesCount: null, averageSalePrice: null };
  const s = getPeriodStartTime(days), e = getPeriodEndTime(days);
  let c = 0, t = 0;
  for (const p of points) {
    const v = p.value, ti = Date.parse(p.date);
    if (!v || v <= 0 || !Number.isFinite(ti) || ti < s || ti > e) continue;
    const vol = getPointVolume(p);
    if (!vol) continue;
    c += vol;
    t += v * vol;
  }
  return c <= 0 ? { salesCount: null, averageSalePrice: null } : { salesCount: c, averageSalePrice: Math.round(t / c) };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

// Builds { assetId -> salesCount/averageSalePrice } for one period bucket by
// scanning live Roblox resale history per item. This used to also try a
// Rolimons "single item" sales call first (`itemapi/itemdetails?itemids=`),
// but that endpoint ignores the itemids filter entirely and just returns the
// full bulk catalog with no per-item sales data - it never found anything,
// so every item fell through to this same Roblox lookup anyway while paying
// for a wasted, rate-limit-prone network round trip first. Removed.
async function buildSalesMetricsMap(days, maxItems = ACTIVE_SALES_SCAN_LIMIT) {
  const allItems = await getRobloxMarketIndex();
  const candidates = allItems.filter(i => i.assetId > 0).slice(0, maxItems);
  const entries = await mapWithConcurrency(candidates, 40, async (item) => {
    const resale = await fetchAnyResaleData(item.assetId, item.collectibleItemId);
    const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, item.lowestPrice);
    const sales = calculateSalesMetrics(salesHistory, days);
    return [item.assetId, {
      salesCount: sales.salesCount,
      averageSalePrice: sales.averageSalePrice,
      salesSource: sales.salesCount ? "roblox" : null,
      salesEstimated: false,
    }];
  });
  return new Map(entries);
}

// Sales metrics require one live external fetch per item across the whole
// catalog, which is far too slow to redo on every request (this is what was
// making "sort by sales" hang / never come back). Compute it once per period
// bucket and cache the result for CACHE_TTL_MS, independent of the current
// page's cursor/keyword/price filters, so every page of the same sort reuses
// the same computed map instead of re-scanning the whole catalog per page.
async function getSalesMetricsMap(days) {
  const cached = salesActivityCache.get(days);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.map;
  try {
    const map = await buildSalesMetricsMap(days);
    salesActivityCache.set(days, { fetchedAt: Date.now(), map });
    return map;
  } catch (e) {
    console.warn(`Sales metrics scan failed: ${e.message} - keeping previous cache (${cached?.map.size || 0} items).`);
    return cached?.map || new Map();
  }
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
// converts it to a Limited - in the meantime, scan a bounded slice of
// Roblox's own "Bestselling, Past Week" feed (filtered to real classic
// Limiteds, not UGC Collectibles) to catch brand-new items immediately.
async function discoverNewRobloxLimiteds(knownAssetIds) {
  const discovered = [];
  let cursor = "";
  for (let page = 0; page < NEW_LIMITED_DISCOVERY_PAGES; page++) {
    const url = new URL(ROBLOX_SEARCH_URL);
    url.searchParams.set("category", "All");
    url.searchParams.set("salesTypeFilter", "2");
    url.searchParams.set("sortType", "2");
    url.searchParams.set("sortAggregation", "3");
    url.searchParams.set("limit", "30");
    if (cursor) url.searchParams.set("cursor", cursor);
    let data;
    try {
      data = await fetchJson(url.toString(), { timeoutMs: 8000, retries: 1 });
    } catch (e) {
      console.warn(`New-limited discovery stopped early at page ${page}: ${e.message}`);
      break;
    }
    for (const row of (data.data || [])) {
      const id = normalizeNumber(row.id);
      if (id <= 0 || knownAssetIds.has(id)) continue;
      // Only real classic Limiteds - "Collectible" restriction is the newer
      // UGC-limited category, which stays excluded per classic-only scope.
      if (!(row.itemRestrictions || []).includes("Limited")) continue;
      discovered.push(row);
    }
    cursor = data.nextPageCursor || "";
    if (!cursor) break;
    await sleep(150);
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

  const items = [];
  for (const [id, base] of rolimonsItems) {
    const details = priceDetails.get(id) || {};
    const lowestPrice = firstPositiveNumber(details.lowestPrice, details.price);
    items.push({
      ...base,
      lowestPrice,
      availableCopies: firstNonNegativeNumber(details.available),
      totalCopies: firstPositiveNumber(details.unitsAvailable),
      collectibleItemId: String(details.collectibleItemId || ""),
      itemType: "Asset",
      marketType: "roblox",
      creatorName: details.creatorName || "Roblox",
      thumbnail: `rbxthumb://type=Asset&id=${id}&w=420&h=420`,
      dealValue: calculateDealValue(base.rap, lowestPrice),
      dealPercent: calculateDealPercent(base.rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(base.rap, lowestPrice),
      overpricedPercent: calculateOverpricedPercent(base.rap, lowestPrice),
    });
  }

  try {
    const newlyLimited = await discoverNewRobloxLimiteds(rolimonsItems);
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
        itemType: "Asset", marketType: "roblox", creatorName: row.creatorName || "Roblox",
        thumbnail: `rbxthumb://type=Asset&id=${id}&w=420&h=420`,
        dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
        overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
      });
    }
    if (newlyLimited.length > 0) {
      console.log(`Discovered ${newlyLimited.length} newly-limited item(s) not yet tracked by Rolimons.`);
    }
  } catch (e) {
    console.warn(`New-limited discovery failed: ${e.message}`);
  }

  return items;
}

async function warmMarketIndex() {
  const items = await buildClassicLimitedsCatalog();
  if (items.length > 0) {
    marketIndexCache.set("roblox", { items, cachedAt: Date.now() });
  }
  console.log(`Roblox market index warmed with ${items.length} priced limiteds.`);
  return items;
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

  const cacheKey = makePageCacheKey({ marketType, sort, keyword, cursor, limit, minPrice, maxPrice, minRap, maxRap });
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

  let items = await getRobloxMarketIndex();
  if (keyword) { const lk = keyword.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(lk)); }
  if (minPrice > 0) items = items.filter(i => !i.lowestPrice || i.lowestPrice >= minPrice);
  if (maxPrice > 0) items = items.filter(i => !i.lowestPrice || i.lowestPrice <= maxPrice);
  if (minRap > 0) items = items.filter(i => i.rap >= minRap);
  if (maxRap > 0) items = items.filter(i => i.rap <= maxRap);

  if (sort === "price_asc") items.sort((a, b) => (a.lowestPrice || Infinity) - (b.lowestPrice || Infinity));
  else if (sort === "rap_desc") items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  else if (sort === "value_desc") items.sort((a, b) => (b.value || 0) - (a.value || 0));
  else if (sort === "deal_desc") items.sort(compareDealItems);
  else if (sort === "overpriced_desc") items.sort(compareOverpricedItems);
  else if (sort.startsWith("bought_")) {
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
    // "Recent" - order by when OUR pipeline first saw the item, not raw
    // assetId (Roblox's ID space is global and unrelated to Limited status -
    // a years-old item can have a far larger ID than a brand-new limited).
    const firstSeen = await fetchFirstSeenMap();
    items.sort((a, b) => (firstSeen.get(b.assetId) || 0) - (firstSeen.get(a.assetId) || 0));
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
    const rolimonsItems = await fetchRolimonsCatalog();
    const rolimonsItem = rolimonsItems.get(assetId);

    const [catalogDetails, resaleDetails] = await Promise.all([
      fetchCatalogDetailsBatch([assetId]).then(m => m.get(assetId) || {}),
      fetchAnyResaleData(assetId, collectibleItemId)
    ]);

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
      availableCopies: firstNonNegativeNumber(catalogDetails.available, resaleDetails.numberRemaining),
      totalCopies: firstPositiveNumber(catalogDetails.unitsAvailable),
      collectibleItemId: String(catalogDetails.collectibleItemId || collectibleItemId),
      itemType: catalogDetails.itemType || "Asset", marketType: "roblox",
      creatorName: catalogDetails.creatorName || "Roblox",
      thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
      dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice)
    };

    const ownHistory = await fetchStoredSnapshots(assetId);
    const resaleHistory = normalizeHistoryPoints(resaleDetails.priceDataPoints);
    const combinedHistory = [...ownHistory, ...resaleHistory].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-5000);
    Object.assign(item, buildRapChangeMetrics(combinedHistory, rap), { history: combinedHistory });
    const salesHistory = buildSalesHistory(resaleDetails.priceDataPoints, resaleDetails.volumeDataPoints, lowestPrice);
    Object.assign(item, calculateSalesMetrics(salesHistory, 1), {
      volume24h: calculateSalesMetrics(salesHistory, 1).salesCount,
      volume7d: calculateSalesMetrics(salesHistory, 7).salesCount
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
    await saveSnapshotRows(items.map(i => ({ asset_id: i.assetId, rap: i.rap, lowest_price: i.lowestPrice || null, saved_at: new Date().toISOString() })));
    await upsertLimitedItemsTable(items.map(i => ({
      asset_id: i.assetId, collectible_item_id: i.collectibleItemId, name: i.name, rap: i.rap, value: i.value,
      lowest_price: i.lowestPrice || null, available_copies: i.availableCopies || 0, total_copies: i.totalCopies || 0,
      saved_at: new Date().toISOString()
    })));
    if (items.length > 0) {
      marketIndexCache.set("roblox", { items, cachedAt: Date.now() });
      pageCache.clear();
    }
    console.log(`Snapshot saved ${items.length} rows to supabase.`);
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
    if (parsedUrl.pathname === "/ping" || parsedUrl.pathname === "/") return sendJson(res, 200, { status: "awake", version: SERVER_VERSION });
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
