import http from "http";
import { URL } from "url";
 
const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "fully-fixed-v2";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300_000);
const ROLIMONS_CACHE_TTL_MS = Number(process.env.ROLIMONS_CACHE_TTL_MS || 600_000);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 60 * 60 * 1000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const SNAPSHOT_SECRET = String(process.env.SNAPSHOT_SECRET || "");
const ROBLOX_CATALOG_URL = "https://catalog.roblox.com/v1/search/items/details";
const ROBLOX_CATALOG_BATCH_URL = "https://catalog.roblox.com/v1/catalog/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROBLOX_COLLECTIBLE_RESALE_URL = "https://apis.roblox.com/marketplace-sales/v1/item";
const ROBLOX_MARKETPLACE_ITEMS_URL = "https://apis.roblox.com/marketplace-items/v1/items/details";
const ROBLOX_INVENTORY_URL = "https://inventory.roblox.com/v1/users";
const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";
const ALLOWED_LIMITS = [10, 28, 30];
const ACTIVE_SALES_SCAN_LIMIT = Number(process.env.ACTIVE_SALES_SCAN_LIMIT || 3000);
const ROBLOX_RECENT_DISCOVERY_PAGES = Number(process.env.ROBLOX_RECENT_DISCOVERY_PAGES || 4);
const ROBLOX_DISCOVERY_SORT_TYPES = ["0", "1", "2", "3", "4", "5"];
 
const pageCache = new Map();
const marketIndexCache = new Map();
const resaleCache = new Map();
const economyCache = new Map();
const catalogDetailCache = new Map();
const detailCache = new Map();
const portfolioCache = new Map();
const rolimonsSalesCache = new Map();
const latestItemSnapshotCache = new Map();
let robloxCsrfToken = "";
let lastSnapshotRunAt = 0;
let snapshotRunning = false;
let memorySnapshots = [];
let rolimonsSalesBlockedUntil = 0;
 
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
 
function buildCatalogUrl({ cursor, limit, keyword, marketType, sort }) {
  const url = new URL(ROBLOX_CATALOG_URL);
  const metricSorts = ["price_desc", "rap_desc", "deal_desc", "overpriced_desc", "bought_24h", "bought_7d", "bought_30d", "bought_1y", "loss_24h", "loss_7d", "loss_30d", "loss_1y", "loss_all", "profit_24h", "profit_7d", "profit_30d", "profit_1y", "profit_all"];
  const sortType = marketType === "ugc" ? "2" : marketType === "roblox" && sort === "updated" ? "3" : sort === "price_asc" || sort === "deal_desc" ? "4" : metricSorts.includes(sort) ? "5" : "3";
  url.searchParams.set("category", "All");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("sortType", sortType);
  url.searchParams.set("limit", String(limit));
  if (marketType === "roblox") { url.searchParams.set("creatorTargetId", "1"); url.searchParams.set("creatorType", "User"); }
  if (cursor) url.searchParams.set("cursor", cursor);
  if (keyword) url.searchParams.set("keyword", keyword);
  return url;
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
 
async function fetchEconomyDetails(assetId) {
  const c = economyCache.get(assetId);
  if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c.data;
  try {
    const d = await fetchJson(`https://economy.roblox.com/v2/assets/${assetId}/details`, { retries: 1, timeoutMs: 3000 });
    economyCache.set(assetId, { fetchedAt: Date.now(), data: d });
    return d;
  } catch { return {}; }
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
  if (!days) return history.length > 0 ? history[0].value : null;
  const target = getPeriodStartTime(days);
  let before = null, inside = null, latest = 0;
  for (const p of history) {
    const t = Date.parse(p.date);
    if (t > latest) latest = t;
    if (t <= target && p.source !== "current") before = p.value;
    else if (t > target && p.source !== "current" && inside === null) inside = p.value;
  }
  return (latest > 0 && latest < target) ? null : before ?? inside;
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
 
async function fetchRolimonsItemSales(assetId) {
  const cached = rolimonsSalesCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < ROLIMONS_CACHE_TTL_MS) return cached.data;
  if (Date.now() < rolimonsSalesBlockedUntil) return { history: [], totalSales: 0 };
  try {
    const data = await fetchJson(`${ROLIMONS_ITEM_DETAILS_URL}?itemids=${assetId}`, { timeoutMs: 3000 });
    const itemData = data?.items?.[String(assetId)];
    if (itemData) {
      const result = {
        history: (itemData.sales || []).map(s => ({
          value: s.v || s.value,
          date: new Date((s.t || s.time) * 1000).toISOString(),
          source: "rolimons",
          salesVolume: 1
        })),
        totalSales: itemData.sales_count || 0
      };
      rolimonsSalesCache.set(assetId, { fetchedAt: Date.now(), data: result });
      return result;
    }
    return { history: [], totalSales: 0 };
  } catch (error) {
    if (error.message?.includes("429")) rolimonsSalesBlockedUntil = Date.now() + 60000;
    return { history: [], totalSales: 0 };
  }
}
 
async function addResaleActivityMetrics(items, days, maxItems = ACTIVE_SALES_SCAN_LIMIT) {
  const candidates = items.filter(i => i.assetId > 0).slice(0, maxItems);
  return mapWithConcurrency(candidates, 24, async (item) => {
    let sales = { salesCount: null, averageSalePrice: null, salesSource: null, salesEstimated: false };
    const rolimonsSales = await fetchRolimonsItemSales(item.assetId);
    if (rolimonsSales.history.length > 0) {
      sales = { ...calculateSalesMetrics(rolimonsSales.history, days), salesSource: "rolimons", salesEstimated: false };
    }
    if (!sales.salesCount) {
      const resale = item.collectibleItemId && item.assetId > 10_000_000_000
        ? await fetchCollectibleResaleData(item.collectibleItemId)
        : await fetchResaleData(item.assetId);
      const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, item.lowestPrice);
      sales = { ...calculateSalesMetrics(salesHistory, days), salesSource: "roblox", salesEstimated: false };
    }
    return { ...item, salesCount: sales.salesCount, averageSalePrice: sales.averageSalePrice, salesSource: sales.salesSource, salesEstimated: sales.salesEstimated };
  }).then(r => r.sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0)));
}
 
function buildRapChangeMetrics(ownHistory, currentRap) {
  const rawHistory = ownHistory.slice(-5000);
  if (rawHistory.length < 2) return {
    history: rawHistory, lossAllTime: null, loss24h: null, loss7d: null, loss30d: null, loss1y: null,
    profitAllTime: null, profit24h: null, profit7d: null, profit30d: null, profit1y: null,
    changeAllTime: null, change24h: null, change7d: null, change30d: null, change1y: null
  };
  const bAll = rawHistory[0].value;
  const b24 = findPeriodBaselineValue(rawHistory, 1);
  const b7 = findPeriodBaselineValue(rawHistory, 7);
  const b30 = findPeriodBaselineValue(rawHistory, 30);
  const b1y = findPeriodBaselineValue(rawHistory, 365);
  const cAll = percentChange(bAll, currentRap);
  const c24 = percentChange(b24, currentRap);
  const c7 = percentChange(b7, currentRap);
  const c30 = percentChange(b30, currentRap);
  const c1y = percentChange(b1y, currentRap);
  return {
    history: rawHistory.slice(-1000),
    lossAllTime: cAll !== null && cAll < 0 ? Math.abs(cAll) : null,
    loss24h: c24 !== null && c24 < 0 ? Math.abs(c24) : null,
    loss7d: c7 !== null && c7 < 0 ? Math.abs(c7) : null,
    loss30d: c30 !== null && c30 < 0 ? Math.abs(c30) : null,
    loss1y: c1y !== null && c1y < 0 ? Math.abs(c1y) : null,
    profitAllTime: cAll !== null && cAll > 0 ? cAll : null,
    profit24h: c24 !== null && c24 > 0 ? c24 : null,
    profit7d: c7 !== null && c7 > 0 ? c7 : null,
    profit30d: c30 !== null && c30 > 0 ? c30 : null,
    profit1y: c1y !== null && c1y > 0 ? c1y : null,
    changeAllTime: cAll, change24h: c24, change7d: c7, change30d: c30, change1y: c1y,
  };
}
 
async function addSnapshotSalesMetrics(items) {
  console.log(`Snapshot prepared ${items.length} items for database.`);
  return items.map(item => {
    const rap = firstPositiveNumber(item.rap);
    const lowestPrice = firstPositiveNumber(item.lowestPrice);
    return {
      ...item,
      dealValue: calculateDealValue(rap, lowestPrice),
      dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice),
      overpricedPercent: calculateOverpricedPercent(rap, lowestPrice)
    };
  });
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
 
function normalizeItemSnapshotRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    assetId: normalizeNumber(r.asset_id),
    collectibleItemId: String(r.collectible_item_id || ""),
    name: String(r.name || "Unknown"),
    rap: firstPositiveNumber(r.rap),
    lowestPrice: firstPositiveNumber(r.lowest_price),
    totalCopies: firstPositiveNumber(r.total_copies),
    availableCopies: firstNonNegativeNumber(r.available_copies),
    savedAt: String(r.saved_at || ""),
    thumbnail: `rbxthumb://type=Asset&id=${normalizeNumber(r.asset_id)}&w=420&h=420`,
    creatorName: "Roblox",
    itemType: "Asset",
    marketType: "roblox"
  })).filter(i => i.assetId > 0 && i.rap > 0);
}
 
async function fetchCurrentLimitedItems() {
  if (!snapshotStorageEnabled()) return [];
  try {
    const rows = [];
    for (let o = 0; o < 10000; o += 1000) {
      const p = await supabaseRequest(
        `limited_items?select=asset_id,collectible_item_id,name,rap,value,lowest_price,available_copies,total_copies,saved_at&order=asset_id.asc&limit=1000&offset=${o}`,
        { headers: { Prefer: "" } }
      );
      if (!Array.isArray(p) || p.length === 0) break;
      rows.push(...p);
      if (p.length < 1000) break;
    }
    return normalizeItemSnapshotRows(rows);
  } catch (e) {
    console.warn(`Read skipped: ${e.message}`);
    return [];
  }
}
 
function mergeMarketItems(primary, secondary) {
  const byId = new Map();
  for (const item of [...secondary, ...primary]) {
    const id = normalizeNumber(item.assetId);
    if (id <= 0) continue;
    const ex = byId.get(id) || {};
    const rap = firstPositiveNumber(item.rap, ex.rap);
    const price = firstPositiveNumber(item.lowestPrice, ex.lowestPrice);
    byId.set(id, {
      ...ex, ...item, assetId: id, rap, lowestPrice: price,
      value: firstPositiveNumber(item.value, ex.value),
      availableCopies: firstNonNegativeNumber(item.availableCopies, ex.availableCopies),
      totalCopies: firstPositiveNumber(item.totalCopies, ex.totalCopies),
      collectibleItemId: String(item.collectibleItemId || ex.collectibleItemId || ""),
      name: String(item.name || ex.name || "Unknown"),
      thumbnail: item.thumbnail || ex.thumbnail || `rbxthumb://type=Asset&id=${id}&w=420&h=420`,
      creatorName: String(item.creatorName || ex.creatorName || "Roblox"),
      marketType: "roblox",
      dealValue: calculateDealValue(rap, price),
      dealPercent: calculateDealPercent(rap, price),
      overpricedValue: calculateOverpricedValue(rap, price),
      overpricedPercent: calculateOverpricedPercent(rap, price)
    });
  }
  return [...byId.values()].filter(i => i.assetId > 0 && i.rap > 0);
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
 
async function fetchStoredSnapshotsForAssets(assetIds) {
  const ids = [...new Set(assetIds)];
  const byId = new Map(ids.map(id => [id, []]));
  
  if (!snapshotStorageEnabled()) {
    for (const r of memorySnapshots) {
      const l = byId.get(r.asset_id);
      if (l) l.push(...normalizeSnapshotRows([r]));
    }
    return byId;
  }
  
  for (let i = 0; i < ids.length; i += 80) {
    try {
      const chunkIds = ids.slice(i, i + 80);
      const rows = await supabaseRequest(
        `limited_snapshots?asset_id=in.(${chunkIds.join(",")})&select=asset_id,rap,lowest_price,saved_at&order=saved_at.asc&limit=20000`,
        { headers: { Prefer: "" } }
      ) || [];
      
      for (const r of rows) {
        const l = byId.get(r.asset_id);
        if (l) l.push(...normalizeSnapshotRows([r]));
      }
    } catch (e) {
      // Continue on error
    }
  }
  return byId;
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
 
async function discoverAllRobloxLimiteds() {
  const all = new Map();
  for (const sortType of ROBLOX_DISCOVERY_SORT_TYPES) {
    let cursor = "";
    for (let p = 0; p < ROBLOX_RECENT_DISCOVERY_PAGES; p++) {
      try {
        const url = new URL(ROBLOX_CATALOG_URL);
        url.searchParams.set("category", "All");
        url.searchParams.set("salesTypeFilter", "2");
        url.searchParams.set("sortType", sortType);
        url.searchParams.set("limit", "120");
        url.searchParams.set("creatorTargetId", "1");
        url.searchParams.set("creatorType", "User");
        if (cursor) url.searchParams.set("cursor", cursor);
        const data = await fetchJson(url.toString(), { retries: 2, timeoutMs: 8000 });
        for (const item of (data.data || [])) {
          const id = normalizeNumber(item.id);
          if (id > 0) all.set(id, {
            assetId: id, name: item.name || "Unknown", rap: firstPositiveNumber(item.price),
            lowestPrice: firstPositiveNumber(item.lowestPrice), availableCopies: firstNonNegativeNumber(item.available),
            totalCopies: firstPositiveNumber(item.unitsAvailable), collectibleItemId: String(item.collectibleItemId || ""),
            itemType: "Asset", marketType: "roblox", creatorName: item.creatorName || "Roblox"
          });
        }
        cursor = data.nextPageCursor;
        if (!cursor) break;
      } catch { break; }
      await sleep(250);
    }
  }
  return [...all.values()];
}
 
async function warmMarketIndex() {
  let items = await discoverAllRobloxLimiteds();
  items = mergeMarketItems(items, await fetchCurrentLimitedItems());
  if (items.length > 0) {
    marketIndexCache.set("roblox", { items, cachedAt: Date.now() });
  }
  console.log(`Roblox market index warmed with ${items.length} priced limiteds.`);
  return items;
}
 
async function getRobloxMarketIndex() {
  // The hourly runSnapshot() job keeps this cache fresh in the background.
  // Only fall back to a live (slow) on-demand scan if nothing has been
  // cached yet at all - e.g. right after a fresh deploy/restart, before
  // the first snapshot has completed. This avoids blocking a visitor's
  // request on a multi-second Roblox catalog scan every few minutes.
  const cached = marketIndexCache.get("roblox");
  if (cached && cached.items.length > 0) {
    return cached.items;
  }
  return warmMarketIndex();
}
 
async function handleLimitedsRequest(req, res, parsedUrl) {
  const p = parsedUrl.searchParams;
  const marketType = p.get("type") === "roblox" ? "roblox" : "ugc";
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
 
  if (marketType === "ugc") {
    const url = new URL(ROBLOX_CATALOG_URL);
    url.searchParams.set("category", "All");
    url.searchParams.set("salesTypeFilter", "2");
    url.searchParams.set("sortType", "2");
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    if (keyword) url.searchParams.set("keyword", keyword);
    const data = await fetchJson(url.toString());
    const items = (data.data || []).map(i => {
      const id = normalizeNumber(i.id), rap = firstPositiveNumber(i.price), lp = firstPositiveNumber(i.lowestPrice);
      return {
        assetId: id, name: i.name, rap, lowestPrice: lp, availableCopies: firstNonNegativeNumber(i.available),
        totalCopies: firstPositiveNumber(i.unitsAvailable), collectibleItemId: String(i.collectibleItemId || ""),
        itemType: "Asset", marketType: "ugc", creatorName: i.creatorName || "UGC",
        dealValue: calculateDealValue(rap, lp), dealPercent: calculateDealPercent(rap, lp),
        overpricedValue: calculateOverpricedValue(rap, lp), overpricedPercent: calculateOverpricedPercent(rap, lp)
      };
    }).filter(i => i.assetId > 0 && i.rap > 0);
    const result = { ok: true, items, nextPageCursor: data.nextPageCursor || "", updatedAt: new Date().toISOString() };
    pageCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return sendJson(res, 200, result);
  }
 
  let items = await getRobloxMarketIndex();
  if (keyword) { const lk = keyword.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(lk)); }
  if (minPrice > 0) items = items.filter(i => !i.lowestPrice || i.lowestPrice >= minPrice);
  if (maxPrice > 0) items = items.filter(i => !i.lowestPrice || i.lowestPrice <= maxPrice);
  if (minRap > 0) items = items.filter(i => i.rap >= minRap);
  if (maxRap > 0) items = items.filter(i => i.rap <= maxRap);
 
  if (sort === "price_asc") items.sort((a, b) => (a.lowestPrice || Infinity) - (b.lowestPrice || Infinity));
  else if (sort === "rap_desc") items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  else if (sort === "deal_desc") items.sort(compareDealItems);
  else if (sort === "overpriced_desc") items.sort(compareOverpricedItems);
  else if (sort.startsWith("bought_")) {
    const days = { bought_24h: 1, bought_7d: 7, bought_30d: 30, bought_1y: 365 }[sort];
    if (days) items = await addResaleActivityMetrics(items, days);
  } else if (sort.startsWith("loss_") || sort.startsWith("profit_")) {
    const isLoss = sort.startsWith("loss_");
    const suffix = sort.replace("loss_", "").replace("profit_", "");
    const days = { "_24h": 1, "_7d": 7, "_30d": 30, "_1y": 365, "_all": null }[`_${suffix}`];
    for (const item of items) {
      const history = await fetchStoredSnapshots(item.assetId);
      Object.assign(item, buildRapChangeMetrics(history, item.rap));
    }
    items.sort((a, b) => {
      const l = a[isLoss ? `loss${suffix}` : `profit${suffix}`] || 0;
      const r = b[isLoss ? `loss${suffix}` : `profit${suffix}`] || 0;
      return r - l;
    });
  } else items.sort((a, b) => b.assetId - a.assetId);
 
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
    const [catalogDetails, economyDetails, resaleDetails] = await Promise.all([
      fetchCatalogDetailsBatch([assetId]).then(m => m.get(assetId) || {}),
      fetchEconomyDetails(assetId),
      collectibleItemId && assetId > 10_000_000_000 ? fetchCollectibleResaleData(collectibleItemId) : fetchResaleData(assetId)
    ]);
    const rap = firstPositiveNumber(catalogDetails.price, economyDetails.Rap, resaleDetails.recentAveragePrice);
    const lowestPrice = firstPositiveNumber(catalogDetails.lowestPrice, resaleDetails.lowestResalePrice);
    let item = {
      assetId, name: catalogDetails.name || economyDetails.Name || "Unknown", rap, lowestPrice,
      availableCopies: firstNonNegativeNumber(catalogDetails.available, resaleDetails.numberRemaining),
      totalCopies: firstPositiveNumber(catalogDetails.unitsAvailable, economyDetails.Sales),
      collectibleItemId: String(catalogDetails.collectibleItemId || collectibleItemId),
      itemType: catalogDetails.itemType || "Asset", marketType: "roblox",
      creatorName: catalogDetails.creatorName || economyDetails.Creator?.Name || "Unknown",
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
    const catalogDetails = await fetchCatalogDetailsBatch(assetIds);
    
    const items = await Promise.all(rawItems.map(async (raw) => {
      const assetId = normalizeNumber(raw.assetId);
      const details = catalogDetails.get(assetId) || {};
      const rap = firstPositiveNumber(raw.recentAveragePrice, details.price);
      const lowestPrice = firstPositiveNumber(raw.price, details.lowestPrice);
      const ownHistory = await fetchStoredSnapshots(assetId);
      return {
        assetId, name: details.name || raw.name || "Unknown", rap, lowestPrice,
        quantity: raw.owned || 1, collectibleItemId: String(raw.collectibleItemId || details.collectibleItemId || ""),
        marketType: assetId > 10_000_000_000 ? "ugc" : "roblox",
        ...buildRapChangeMetrics(ownHistory, rap)
      };
    }));
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
    let items = await discoverAllRobloxLimiteds();
    items = mergeMarketItems(items, await fetchCurrentLimitedItems());
    items = await addSnapshotSalesMetrics(items);
    await saveSnapshotRows(items.map(i => ({ asset_id: i.assetId, rap: i.rap, lowest_price: i.lowestPrice || null, saved_at: new Date().toISOString() })));
    await upsertLimitedItemsTable(items.map(i => ({
      asset_id: i.assetId, collectible_item_id: i.collectibleItemId, name: i.name, rap: i.rap, value: i.rap,
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
