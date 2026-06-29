// Local/prod backend for the Roblox Limiteds Live UI.
// Run with: node live-limiteds-server.mjs
//
// The Roblox client calls this server, not Roblox marketplace APIs directly.
// Deploy it to a public HTTPS host before using it in a published Roblox game.

const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "sales-source-fallbacks-2026-06-20-14-fixed";
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
const SNAPSHOT_SALES_CONCURRENCY = Number(process.env.SNAPSHOT_SALES_CONCURRENCY || 4);
const SNAPSHOT_SALES_BATCH_SIZE = Number(process.env.SNAPSHOT_SALES_BATCH_SIZE || 100);
const SNAPSHOT_SALES_BATCH_DELAY_MS = Number(process.env.SNAPSHOT_SALES_BATCH_DELAY_MS || 500);
const ROBLOX_RECENT_DISCOVERY_PAGES = Number(process.env.ROBLOX_RECENT_DISCOVERY_PAGES || 4);
const ROBLOX_DISCOVERY_SORT_TYPES = ["0", "1", "2", "3", "4", "5"];
const ROBLOX_RECENT_DISCOVERY_ASSET_IDS = [
  450557238,
  20011925,
  1080949,
  1098282,
  14463095,
];
const ROBLOX_RECENT_DISCOVERY_KEYWORDS = [
  "8-Bit Clockwork Shades",
  "Oozing Oscar",
  "Bunny Ears",
  "Lampshade",
  "Pinstripe Fedora",
  "Clockwork's Golden Shades",
  "Fall Fairy",
];
const ROBLOX_RECENT_SEARCH_ALIASES = new Map([
  [450557238, ["8-bit clockwork shades", "8 bit clockwork shades", "8-bit clockwork", "8 bit clockwork", "clockwork shades"]],
  [20011925, ["oozing oscar", "oscar"]],
  [1080949, ["lampshade", "lamp shade"]],
  [1098282, ["santa hat"]],
  [14463095, ["classic fedora", "roblox fedora"]],
]);

const pageCache = new Map();
const pagePrefetches = new Set();
const marketIndexCache = new Map();
const marketIndexBuilds = new Map();
const resaleCache = new Map();
const economyCache = new Map();
const catalogDetailCache = new Map();
const detailCache = new Map();
const portfolioCache = new Map();
const rolimonsSalesCache = new Map();
const latestItemSnapshotCache = new Map();
let rolimonsCache = null;
let robloxCsrfToken = "";
let lastSnapshotRunAt = 0;
let lastSnapshotAttemptAt = 0;
let snapshotRunning = false;
let memorySnapshots = [];
let rolimonsSalesBlockedUntil = 0;

function makePageCacheKey({
  marketType,
  sort,
  keyword,
  cursor,
  limit,
  minPrice,
  maxPrice,
  minRap,
  maxRap,
}) {
  return [
    marketType,
    sort,
    keyword,
    cursor || "",
    limit,
    minPrice ?? "",
    maxPrice ?? "",
    minRap ?? "",
    maxRap ?? "",
  ].join(":");
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function firstNonNegativeNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLimit(limit) {
  const requested = Number(limit) || 30;
  return ALLOWED_LIMITS.reduce((best, current) => {
    return Math.abs(current - requested) < Math.abs(best - requested) ? current : best;
  }, 30);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        headers: {
          Accept: "application/json",
          "User-Agent": "LimitedsLiveMarketViewer/1.0",
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw new Error(`Network error for ${url}: ${error.cause?.message || error.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status !== 429) {
      break;
    }

    await sleep(400 + attempt * 500);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  const text = await response.text();

  if (!text.trim()) {
    throw new Error(`Empty JSON response for ${url}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Bad JSON response for ${url}: ${error.message}`);
  }
}

async function fetchCatalogDetailsChunk(assetIds) {
  const body = JSON.stringify({
    items: assetIds.map((assetId) => ({
      itemType: "Asset",
      id: assetId,
    })),
  });
  let response;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "LimitedsLiveMarketViewer/1.0",
    };

    if (robloxCsrfToken) {
      headers["x-csrf-token"] = robloxCsrfToken;
    }

    response = await fetch(ROBLOX_CATALOG_BATCH_URL, {
      method: "POST",
      headers,
      body,
    });

    const freshToken = response.headers.get("x-csrf-token");
    if (freshToken) {
      robloxCsrfToken = freshToken;
    }

    if (response.status === 403 && freshToken) {
      continue;
    }

    if (response.status !== 429) {
      break;
    }

    await sleep(1200 + attempt * 900);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${ROBLOX_CATALOG_BATCH_URL}`);
  }

  return response.json();
}

async function fetchCatalogDetailsBatch(assetIds) {
  const result = new Map();
  const missing = [];

  for (const assetId of assetIds) {
    const cached = catalogDetailCache.get(assetId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      result.set(assetId, cached.data);
    } else if (assetId > 0) {
      missing.push(assetId);
    }
  }

  for (let index = 0; index < missing.length; index += 100) {
    const chunk = missing.slice(index, index + 100);
    let data;
    try {
      data = await fetchCatalogDetailsChunk(chunk);
    } catch (error) {
      if (result.size > 0) break;
      throw error;
    }

    const rows = Array.isArray(data.data) ? data.data : [];
    for (const row of rows) {
      const assetId = normalizeNumber(row.id);
      if (assetId > 0) {
        catalogDetailCache.set(assetId, { fetchedAt: Date.now(), data: row });
        result.set(assetId, row);
      }
    }
    if (index + 100 < missing.length) await sleep(220);
  }
  return result;
}

function buildCatalogUrl({ cursor, limit, keyword, marketType, sort }) {
  const url = new URL(ROBLOX_CATALOG_URL);
  const metricSorts = [
    "price_desc", "rap_desc", "deal_desc", "overpriced_desc",
    "bought_24h", "bought_7d", "bought_30d", "bought_1y",
    "loss_24h", "loss_7d", "loss_30d", "loss_1y", "loss_all",
    "profit_24h", "profit_7d", "profit_30d", "profit_1y", "profit_all",
  ];
  const sortType = marketType === "ugc"
    ? "2"
    : marketType === "roblox" && sort === "updated"
    ? "3"
    : sort === "price_asc" || sort === "deal_desc" ? "4" : metricSorts.includes(sort) ? "5" : "3";

  url.searchParams.set("category", "All");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("sortType", sortType);
  url.searchParams.set("limit", String(limit));

  if (marketType === "roblox") {
    url.searchParams.set("creatorTargetId", "1");
    url.searchParams.set("creatorType", "User");
  }
  if (cursor) url.searchParams.set("cursor", cursor);
  if (keyword) url.searchParams.set("keyword", keyword);

  return url;
}

function buildRobloxKeywordDiscoveryUrl(keyword, limit = 30) {
  const url = new URL(ROBLOX_CATALOG_URL);
  url.searchParams.set("category", "All");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("sortType", "0");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("creatorTargetId", "1");
  url.searchParams.set("creatorType", "User");
  url.searchParams.set("keyword", keyword);
  return url;
}

function buildRobloxDiscoveryUrl({ cursor = "", sortType = "3", limit = 30 }) {
  const url = new URL(ROBLOX_CATALOG_URL);
  url.searchParams.set("category", "All");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("sortType", String(sortType));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("creatorTargetId", "1");
  url.searchParams.set("creatorType", "User");
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

async function fetchResaleData(assetId) {
  const cached = resaleCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  try {
    const data = await fetchJson(`${ROBLOX_RESALE_URL}/${assetId}/resale-data`, { retries: 2, timeoutMs: 5000 });
    resaleCache.set(assetId, { fetchedAt: Date.now(), data });
    return data;
  } catch { return {}; }
}

async function fetchCollectibleResaleData(collectibleItemId) {
  const safeId = String(collectibleItemId || "").trim();
  if (!safeId) return {};
  const cacheKey = `collectible:${safeId}`;
  const cached = resaleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  try {
    const data = await fetchJson(`${ROBLOX_COLLECTIBLE_RESALE_URL}/${encodeURIComponent(safeId)}/resale-data`, { retries: 2, timeoutMs: 3000 });
    resaleCache.set(cacheKey, { fetchedAt: Date.now(), data });
    return data;
  } catch { return {}; }
}

async function fetchMarketplaceItemDetails(collectibleItemId) {
  const safeId = String(collectibleItemId || "").trim();
  if (!safeId) return {};
  const cacheKey = `marketplace:${safeId}`;
  const cached = catalogDetailCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  try {
    const data = await fetchJson(ROBLOX_MARKETPLACE_ITEMS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ itemIds: [safeId] }),
      retries: 2, timeoutMs: 5000,
    });
    const rows = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    const row = rows[0] || {};
    catalogDetailCache.set(cacheKey, { fetchedAt: Date.now(), data: row });
    return row;
  } catch { return {}; }
}

async function fetchMarketplaceItemDetailsBatch(collectibleItemIds) {
  const result = new Map();
  const missing = [];
  for (const id of collectibleItemIds) {
    const safeId = String(id || "").trim();
    if (!safeId) continue;
    const cacheKey = `marketplace:${safeId}`;
    const cached = catalogDetailCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      result.set(safeId, cached.data);
    } else {
      missing.push(safeId);
    }
  }
  for (let index = 0; index < missing.length; index += 50) {
    const chunk = missing.slice(index, index + 50);
    try {
      const data = await fetchJson(ROBLOX_MARKETPLACE_ITEMS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ itemIds: chunk }),
        retries: 1, timeoutMs: 4000,
      });
      const rows = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
      rows.forEach((row, rowIndex) => {
        const id = String(row.collectibleItemId || row.itemId || row.id || chunk[rowIndex] || "").trim();
        if (id) {
          const cacheKey = `marketplace:${id}`;
          catalogDetailCache.set(cacheKey, { fetchedAt: Date.now(), data: row });
          result.set(id, row);
        }
      });
    } catch { }
  }
  return result;
}

async function fetchEconomyDetails(assetId) {
  const cached = economyCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  try {
    const data = await fetchJson(`https://economy.roblox.com/v2/assets/${assetId}/details`, { retries: 1, timeoutMs: 3000 });
    economyCache.set(assetId, { fetchedAt: Date.now(), data });
    return data;
  } catch { return {}; }
}

function getPointVolume(point, useValueAsVolume = false) {
  const volume = Number(
    point?.salesVolume ?? point?.volume ?? point?.sales ?? point?.count ?? point?.quantity ?? (useValueAsVolume ? point?.value : null)
  );
  return Number.isFinite(volume) && volume > 0 ? Math.round(volume) : null;
}

function normalizeHistoryPoints(points, source = "resale") {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point) => typeof point.value === "number" && point.value > 0)
    .map((point) => {
      const normalizedSource = String(point.source || source || "resale");
      return {
        value: point.value,
        date: String(point.date || ""),
        source: normalizedSource,
        salesVolume: getPointVolume(point, normalizedSource === "volume"),
      };
    })
    .filter((point) => Number.isFinite(Date.parse(point.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(-5000);
}

function salesHistoryKey(date) {
  const time = Date.parse(date || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

function buildSalesHistory(pricePoints, volumePoints = [], fallbackPrice = null) {
  const priceHistory = normalizeHistoryPoints(pricePoints);
  const volumeHistory = normalizeHistoryPoints(volumePoints, "volume");
  const fallback = Number(fallbackPrice);
  const volumeByDate = new Map();
  const usedVolumeDates = new Set();

  for (const point of volumeHistory) {
    const key = salesHistoryKey(point.date);
    const volume = getPointVolume(point, true);
    if (!key || !volume) continue;
    volumeByDate.set(key, (volumeByDate.get(key) || 0) + volume);
  }

  const sales = priceHistory.map((point) => {
    const key = salesHistoryKey(point.date);
    const volume = getPointVolume(point) ?? volumeByDate.get(key) ?? 1;
    if (key && volume) usedVolumeDates.add(key);
    return { ...point, salesVolume: volume || null };
  }).filter((point) => Number(point.value) > 0 && Number(point.salesVolume) > 0);

  if (Number.isFinite(fallback) && fallback > 0) {
    for (const point of volumeHistory) {
      const key = salesHistoryKey(point.date);
      if (!key || usedVolumeDates.has(key)) continue;
      const volume = getPointVolume(point, true);
      if (!volume) continue;
      sales.push({ value: fallback, date: point.date, source: "volume", salesVolume: volume });
    }
  }
  return sales.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-5000);
}

function findHistoryBaselineValue(history, days) {
  if (!Array.isArray(history) || history.length === 0) return null;
  if (!days) return Number(history[0]?.value) || null;
  const targetTime = getPeriodStartTime(days);
  let baseline = null, firstInsidePeriod = null, latestTime = 0;
  for (const point of history) {
    const value = Number(point.value);
    const time = Date.parse(point.date || "");
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time)) continue;
    latestTime = Math.max(latestTime, time);
    if (time <= targetTime) baseline = value;
    else if (firstInsidePeriod === null) firstInsidePeriod = value;
  }
  if (latestTime > 0 && latestTime < targetTime) return null;
  return baseline ?? firstInsidePeriod;
}

function findPeriodBaselineValue(history, days) {
  if (!days) return findHistoryBaselineValue(history, null);
  const targetTime = getPeriodStartTime(days);
  let latestBeforePeriod = null, firstInsidePeriod = null, latestTime = 0;
  for (const point of history) {
    const value = Number(point.value);
    const time = Date.parse(point.date || "");
    const source = String(point.source || "");
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time)) continue;
    latestTime = Math.max(latestTime, time);
    if (time <= targetTime && source !== "current") latestBeforePeriod = value;
    else if (time > targetTime && source !== "current" && firstInsidePeriod === null) firstInsidePeriod = value;
  }
  if (latestTime > 0 && latestTime < targetTime) return null;
  return latestBeforePeriod ?? firstInsidePeriod;
}

function getStartOfTodayTime() {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now.getTime();
}

function getPeriodStartTime(days) {
  if (!days) return 0;
  if (Number(days) === 1) return getStartOfTodayTime();
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function getPeriodEndTime(days) {
  if (Number(days) === 1) return getStartOfTodayTime() + 24 * 60 * 60 * 1000;
  return Date.now();
}

function clearPriceWithoutSellers(lowestPrice, availableCopies) {
  return firstPositiveNumber(lowestPrice);
}

function percentChange(fromValue, toValue) {
  if (!fromValue || !toValue || fromValue <= 0 || toValue <= 0) return null;
  return Math.round(((toValue - fromValue) / fromValue) * 10000) / 100;
}

function percentDrop(fromValue, toValue) {
  const change = percentChange(fromValue, toValue);
  return (change === null || change >= 0) ? null : Math.abs(change);
}

function percentGain(fromValue, toValue) {
  const change = percentChange(fromValue, toValue);
  return (change === null || change <= 0) ? null : change;
}

function calculateDealValue(rap, lowestPrice) {
  const safeRap = Number(rap), safePrice = Number(lowestPrice);
  if (!Number.isFinite(safeRap) || !Number.isFinite(safePrice) || safeRap <= 0 || safePrice <= 0 || safePrice >= safeRap) return null;
  return Math.round(safeRap - safePrice);
}

function calculateDealPercent(rap, lowestPrice) {
  const dealValue = calculateDealValue(rap, lowestPrice);
  const safeRap = Number(rap);
  if (dealValue === null || !Number.isFinite(safeRap) || safeRap <= 0) return null;
  return Math.round((dealValue / safeRap) * 10000) / 100;
}

function hasMinimumDeal(item, minimumPercent = 10) {
  const dealPercent = Number(item?.dealPercent);
  return Number.isFinite(dealPercent) && dealPercent >= minimumPercent;
}

function compareDealItems(a, b) {
  const percentDiff = (Number(b?.dealPercent) || 0) - (Number(a?.dealPercent) || 0);
  return percentDiff !== 0 ? percentDiff : (Number(b?.dealValue) || 0) - (Number(a?.dealValue) || 0);
}

function calculateOverpricedValue(rap, lowestPrice) {
  const safeRap = Number(rap), safePrice = Number(lowestPrice);
  if (!Number.isFinite(safeRap) || !Number.isFinite(safePrice) || safeRap <= 0 || safePrice <= safeRap) return null;
  return Math.round(safePrice - safeRap);
}

function calculateOverpricedPercent(rap, lowestPrice) {
  const overpricedValue = calculateOverpricedValue(rap, lowestPrice);
  const safeRap = Number(rap);
  if (overpricedValue === null || !Number.isFinite(safeRap) || safeRap <= 0) return null;
  return Math.round((overpricedValue / safeRap) * 10000) / 100;
}

function hasMinimumOverpriced(item, minimumPercent = 10) {
  const overpricedPercent = Number(item?.overpricedPercent);
  return Number.isFinite(overpricedPercent) && overpricedPercent >= minimumPercent;
}

function compareOverpricedItems(a, b) {
  const percentDiff = (Number(b?.overpricedPercent) || 0) - (Number(a?.overpricedPercent) || 0);
  return percentDiff !== 0 ? percentDiff : (Number(b?.overpricedValue) || 0) - (Number(a?.overpricedValue) || 0);
}

function getBoughtRangeDays(sort) {
  return { bought_24h: 1, bought_7d: 7, bought_30d: 30, bought_1y: 365 }[sort] ?? null;
}

function calculateActivityMetrics(points, days, currentRap = null, currentPrice = null) {
  if (!Array.isArray(points) || !days) return { activityCount: null, activityScore: null, averageActivePrice: null };
  const startTime = getPeriodStartTime(days);
  const endTime = Math.min(Date.now(), getPeriodEndTime(days));
  const history = points.map((point) => ({
    rap: Number(point.value),
    price: Number(point.lowestPrice ?? point.price ?? point.salePrice ?? (point.source === "resale" ? point.value : null)),
    time: Date.parse(point.date || ""),
  })).filter((point) => Number.isFinite(point.time) && point.time <= endTime && (point.rap > 0 || point.price > 0)).sort((a, b) => a.time - b.time);

  const rap = Number(currentRap), price = Number(currentPrice);
  if ((rap > 0 || price > 0) && endTime >= startTime) history.push({ rap: rap > 0 ? rap : null, price: price > 0 ? price : null, time: Date.now() });

  let baseline = null;
  const visible = [];
  for (const point of history) {
    if (point.time < startTime) baseline = point;
    else if (point.time <= endTime) visible.push(point);
  }
  if (visible.length === 0) return { activityCount: null, activityScore: null, averageActivePrice: null };

  const sequence = baseline ? [baseline, ...visible] : visible;
  let previousRap = null, previousPrice = null, rapChanges = 0, priceChanges = 0, priceTotal = 0, priceCount = 0;

  for (const point of sequence) {
    if (point.price > 0) { priceTotal += point.price; priceCount += 1; }
    if (point.rap > 0) {
      if (previousRap !== null && point.rap !== previousRap) rapChanges += 1;
      previousRap = point.rap;
    }
    if (point.price > 0) {
      if (previousPrice !== null && point.price !== previousPrice) priceChanges += 1;
      previousPrice = point.price;
    }
  }

  const firstRap = sequence.find((point) => point.rap > 0)?.rap;
  const lastRap = [...sequence].reverse().find((point) => point.rap > 0)?.rap;
  const rapMove = Math.abs(percentChange(firstRap, lastRap) || 0);
  const activityCount = rapChanges + priceChanges;
  const activityScore = Math.round((activityCount * 100 + rapMove) * 100) / 100;

  if (activityScore <= 0) return { activityCount: null, activityScore: null, averageActivePrice: null };
  return { activityCount, activityScore, averageActivePrice: priceCount > 0 ? Math.round(priceTotal / priceCount) : null };
}

function calculateSalesMetrics(points, days) {
  if (!Array.isArray(points) || !days) return { salesCount: null, averageSalePrice: null };
  const startTime = getPeriodStartTime(days);
  const endTime = getPeriodEndTime(days);
  let salesCount = 0, totalSoldValue = 0;
  for (const point of points) {
    const value = Number(point.value), time = Date.parse(point.date || "");
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time) || time < startTime || time > endTime) continue;
    const volume = getPointVolume(point);
    if (!volume) continue;
    salesCount += volume;
    totalSoldValue += value * volume;
  }
  if (salesCount <= 0) return { salesCount: null, averageSalePrice: null };
  return { salesCount, averageSalePrice: Math.round(totalSoldValue / salesCount) };
}

function calculateAllSalesMetrics(points) {
  if (!Array.isArray(points)) return { salesCount: null, averageSalePrice: null };
  let salesCount = 0, totalSoldValue = 0;
  for (const point of points) {
    const value = Number(point.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const volume = getPointVolume(point);
    if (!volume) continue;
    salesCount += volume;
    totalSoldValue += value * volume;
  }
  if (salesCount <= 0) return { salesCount: null, averageSalePrice: null };
  return { salesCount, averageSalePrice: Math.round(totalSoldValue / salesCount) };
}

function salesMetricToActivity(metric) {
  return {
    activityCount: metric.salesCount, activityScore: metric.salesCount, averageActivePrice: metric.averageSalePrice,
    salesCount: metric.salesCount, averageSalePrice: metric.averageSalePrice,
    salesSource: metric.salesSource || null, salesEstimated: metric.salesEstimated === true,
  };
}

function compareBoughtItems(a, b) {
  const countDiff = (Number(b?.activityCount ?? b?.salesCount) || 0) - (Number(a?.activityCount ?? a?.salesCount) || 0);
  if (countDiff !== 0) return countDiff;
  const scoreDiff = (Number(b?.activityScore) || 0) - (Number(a?.activityScore) || 0);
  if (scoreDiff !== 0) return scoreDiff;
  return (Number(b?.averageActivePrice ?? b?.averageSalePrice) || 0) - (Number(a?.averageActivePrice ?? a?.averageSalePrice) || 0);
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function fetchRolimonsItemSales(assetId) {
  const cached = rolimonsSalesCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < ROLIMONS_CACHE_TTL_MS) return cached.data;
  
  if (Date.now() < rolimonsSalesBlockedUntil) {
    return { history: [], totalSales: 0 };
  }

  try {
    const data = await fetchJson(`${ROLIMONS_ITEM_DETAILS_URL}?itemids=${assetId}`, { timeoutMs: 3000 });
    const items = data?.items || {};
    const itemData = items[String(assetId)];
    
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
    if (error.message?.includes("429")) {
      rolimonsSalesBlockedUntil = Date.now() + 60000;
    }
    return { history: [], totalSales: 0 };
  }
}

function rolimonsSalesForDays(rolimonsData, days) {
  if (!rolimonsData?.history?.length) return null;
  const startTime = getPeriodStartTime(days);
  const count = rolimonsData.history.filter(p => Date.parse(p.date) >= startTime).length;
  return count > 0 ? count : null;
}

function itemSnapshotSalesForDays(item, days) {
  const key = days === 1 ? "volume24h" : days === 7 ? "volume7d" : days === 30 ? "volume30d" : days === 365 ? "volume1y" : null;
  if (!key) return null;
  const val = Number(item[key]);
  return Number.isFinite(val) && val > 0 ? val : null;
}

async function addResaleActivityMetrics(items, days, maxItems = ACTIVE_SALES_SCAN_LIMIT) {
  const candidates = items.filter((item) => item.assetId > 0).slice(0, maxItems);
  const ownHistoryByAssetId = await fetchStoredSnapshotsForAssets(candidates.map((item) => item.assetId));

  const enriched = await mapWithConcurrency(candidates, 24, async (item) => {
    let resale = {};
    let latestHistoryPrice = null;
    let sales = { salesCount: null, averageSalePrice: null, salesSource: null, salesEstimated: false };

    const rolimonsSales = await fetchRolimonsItemSales(item.assetId);
    const rolimonsHistory = Array.isArray(rolimonsSales.history) ? rolimonsSales.history : [];
    if (rolimonsHistory.length > 0) {
      sales = { ...calculateSalesMetrics(rolimonsHistory, days), salesSource: "rolimons", salesEstimated: false };
    }
    if (!sales.salesCount) {
      const rolimonsCount = rolimonsSalesForDays(rolimonsSales, days);
      if (rolimonsCount) sales = { salesCount: rolimonsCount, averageSalePrice: firstPositiveNumber(item.lowestPrice), salesSource: "rolimons", salesEstimated: false };
    }
    if (!sales.salesCount) {
      resale = item.collectibleItemId && item.assetId > 10_000_000_000
        ? await fetchCollectibleResaleData(item.collectibleItemId)
        : await fetchResaleData(item.assetId);
      const history = normalizeHistoryPoints(resale.priceDataPoints);
      latestHistoryPrice = [...history].reverse().find((point) => Number(point.value) > 0)?.value;
      const liveLowestPrice = clearPriceWithoutSellers(firstPositiveNumber(item.lowestPrice, resale.lowestResalePrice, latestHistoryPrice), firstNonNegativeNumber(item.availableCopies, resale.numberRemaining));
      const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, liveLowestPrice);
      sales = { ...calculateSalesMetrics(salesHistory, days), salesSource: "roblox", salesEstimated: false };
      if (sales.salesCount && !sales.averageSalePrice) sales.averageSalePrice = firstPositiveNumber(liveLowestPrice, latestHistoryPrice);
    }
    if (!sales.salesCount) {
      const ownHistory = ownHistoryByAssetId.get(item.assetId) || [];
      const estimated = calculateActivityMetrics(ownHistory, days, item.rap, item.lowestPrice);
      if (estimated.activityCount) sales = { salesCount: estimated.activityCount, averageSalePrice: firstPositiveNumber(estimated.averageActivePrice, item.lowestPrice, latestHistoryPrice), salesSource: "snapshots", salesEstimated: true };
    }
    if (!sales.salesCount) {
      const cachedCount = itemSnapshotSalesForDays(item, days);
      if (cachedCount) sales = { salesCount: cachedCount, averageSalePrice: firstPositiveNumber(item.lowestPrice, latestHistoryPrice), salesSource: "cached", salesEstimated: true };
    }
    const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
    const lowestPrice = clearPriceWithoutSellers(firstPositiveNumber(item.lowestPrice, resale.lowestResalePrice, latestHistoryPrice), firstNonNegativeNumber(item.availableCopies, resale.numberRemaining));
    const activity = salesMetricToActivity(sales);
    return { ...item, rap, lowestPrice, activityCount: activity.activityCount, activityScore: activity.activityScore, averageActivePrice: activity.averageActivePrice, salesCount: activity.activityCount, averageSalePrice: activity.averageActivePrice, salesSource: activity.salesSource, salesEstimated: activity.salesEstimated };
  });
  return enriched.sort(compareBoughtItems);
}

async function addSnapshotSalesMetrics(items) {
  const results = [];
  for (let index = 0; index < items.length; index += SNAPSHOT_SALES_BATCH_SIZE) {
    const batch = items.slice(index, index + SNAPSHOT_SALES_BATCH_SIZE);
    const enrichedBatch = await mapWithConcurrency(batch, SNAPSHOT_SALES_CONCURRENCY, async (item) => {
      if (!item || !item.assetId) return item;
      try {
        const resale = item.collectibleItemId && item.assetId > 10_000_000_000
          ? await fetchCollectibleResaleData(item.collectibleItemId)
          : await fetchResaleData(item.assetId);
        const latestHistoryPrice = [...normalizeHistoryPoints(resale.priceDataPoints)].reverse().find((point) => Number(point.value) > 0)?.value;
        const lowestPrice = firstPositiveNumber(item.lowestPrice, resale.lowestResalePrice, latestHistoryPrice);
        const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, lowestPrice);
        const sales24h = calculateSalesMetrics(salesHistory, 1);
        const sales7d = calculateSalesMetrics(salesHistory, 7);
        const sales30d = calculateSalesMetrics(salesHistory, 30);
        const sales1y = calculateSalesMetrics(salesHistory, 365);
        const salesAll = calculateAllSalesMetrics(salesHistory);
        return {
          ...item, lowestPrice: firstPositiveNumber(item.lowestPrice, resale.lowestResalePrice, latestHistoryPrice),
          rap: firstPositiveNumber(item.rap, resale.recentAveragePrice),
          volume24h: sales24h.salesCount, volume7d: sales7d.salesCount, volume30d: sales30d.salesCount, volume1y: sales1y.salesCount, salesAllTime: salesAll.salesCount,
          averageSalePrice24h: sales24h.averageSalePrice, averageSalePrice7d: sales7d.averageSalePrice, averageSalePrice30d: sales30d.averageSalePrice, averageSalePrice1y: sales1y.averageSalePrice,
        };
      } catch { return item; }
    });
    results.push(...enrichedBatch);
    console.log(`Snapshot sales enriched ${Math.min(index + batch.length, items.length)}/${items.length}.`);
    if (index + batch.length < items.length && SNAPSHOT_SALES_BATCH_DELAY_MS > 0) await sleep(SNAPSHOT_SALES_BATCH_DELAY_MS);
  }
  return results;
}

function snapshotStorageEnabled() {
  return SUPABASE_URL !== "" && SUPABASE_SERVICE_ROLE_KEY !== "";
}

async function supabaseRequest(path, options = {}) {
  if (!snapshotStorageEnabled()) return null;
  const requestUrl = `${SUPABASE_URL}/rest/v1/${path}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json", Prefer: "return=minimal", ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`Supabase network error for ${requestUrl}: ${error.cause?.message || error.message}`);
  }
  if (!response.ok) { const text = await response.text(); throw new Error(`Supabase ${response.status} for ${requestUrl}: ${text.slice(0, 180)}`); }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function normalizeSnapshotRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    value: Number(row.rap), lowestPrice: Number(row.lowest_price) || null,
    date: String(row.saved_at || row.date || ""), source: "own",
  })).filter((point) => point.value > 0 && Number.isFinite(Date.parse(point.date)));
}

function normalizeItemSnapshotRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    assetId: normalizeNumber(Number(row.asset_id)), collectibleItemId: String(row.collectible_item_id || ""),
    name: String(row.name || "Unknown Limited"), rap: firstPositiveNumber(Number(row.rap)),
    value: firstPositiveNumber(Number(row.value)), lowestPrice: firstPositiveNumber(Number(row.lowest_price)),
    totalCopies: firstPositiveNumber(Number(row.total_copies)), availableCopies: firstNonNegativeNumber(Number(row.available_copies)),
    volume24h: firstPositiveNumber(Number(row.volume_24h)), volume7d: firstPositiveNumber(Number(row.volume_7d)),
    volume30d: firstPositiveNumber(Number(row.volume_30d)), volume1y: firstPositiveNumber(Number(row.volume_1y)),
    salesAllTime: firstPositiveNumber(Number(row.sales_all_time)), savedAt: String(row.saved_at || ""),
    thumbnail: `rbxthumb://type=Asset&id=${normalizeNumber(Number(row.asset_id))}&w=420&h=420`,
    creatorName: "Roblox", itemType: "Asset", marketType: "roblox",
  })).filter((item) => item.assetId > 0 && item.rap > 0);
}

async function fetchCurrentLimitedItems() {
  if (!snapshotStorageEnabled()) return [];
  const rows = [];
  const select = "asset_id,collectible_item_id,name,rap,value,lowest_price,available_copies,total_copies,volume_24h,volume_7d,volume_30d,volume_1y,sales_all_time,saved_at";
  try {
    for (let offset = 0; offset < 10000; offset += 1000) {
      const page = await supabaseRequest(`limited_items?select=${select}&order=asset_id.asc&limit=1000&offset=${offset}`, { headers: { Prefer: "" } });
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < 1000) break;
    }
  } catch (error) { console.warn(`limited_items read skipped: ${error.message}`); return []; }
  return normalizeItemSnapshotRows(rows);
}

async function fetchLatestItemSnapshotItems() {
  const cacheKey = "latest";
  const cached = latestItemSnapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.items;
  if (!snapshotStorageEnabled()) return [];
  const currentItems = await fetchCurrentLimitedItems();
  if (currentItems.length > 0) { latestItemSnapshotCache.set(cacheKey, { fetchedAt: Date.now(), items: currentItems }); return currentItems; }
  
  async function fetchItemSnapshotPage(offset, includeVolumeColumns) {
    const select = includeVolumeColumns ? "asset_id,collectible_item_id,name,rap,value,lowest_price,available_copies,total_copies,volume_24h,volume_7d,volume_30d,volume_1y,sales_all_time,saved_at" : "asset_id,collectible_item_id,name,rap,value,lowest_price,available_copies,total_copies,saved_at";
    return supabaseRequest(`item_snapshots?select=${select}&order=saved_at.desc&limit=1000&offset=${offset}`, { headers: { Prefer: "" } });
  }
  try {
    const rows = []; let includeVolumeColumns = true;
    for (let offset = 0; offset < 50000; offset += 1000) {
      let page;
      try { page = await fetchItemSnapshotPage(offset, includeVolumeColumns); } catch (error) { if (!includeVolumeColumns) throw error; includeVolumeColumns = false; page = await fetchItemSnapshotPage(offset, includeVolumeColumns); }
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page); if (page.length < 1000) break;
    }
    const latestByAssetId = new Map();
    for (const item of normalizeItemSnapshotRows(rows)) {
      const current = latestByAssetId.get(item.assetId);
      const currentTime = current ? Date.parse(current.savedAt || "") : 0;
      const itemTime = Date.parse(item.savedAt || "");
      if (!current || itemTime >= currentTime) latestByAssetId.set(item.assetId, item);
    }
    const items = [...latestByAssetId.values()];
    latestItemSnapshotCache.set(cacheKey, { fetchedAt: Date.now(), items });
    return items;
  } catch (error) { console.warn(`item_snapshots read skipped: ${error.message}`); latestItemSnapshotCache.set(cacheKey, { fetchedAt: Date.now(), items: [] }); return []; }
}

function mergeMarketItems(primaryItems, secondaryItems) {
  const byAssetId = new Map();
  for (const item of [...secondaryItems, ...primaryItems]) {
    const assetId = normalizeNumber(Number(item.assetId));
    if (assetId <= 0) continue;
    const existing = byAssetId.get(assetId) || {};
    const rap = firstPositiveNumber(item.rap, existing.rap);
    const lowestPrice = firstPositiveNumber(item.lowestPrice, existing.lowestPrice);
    byAssetId.set(assetId, {
      ...existing, ...item, assetId, rap, lowestPrice,
      value: firstPositiveNumber(item.value, existing.value),
      availableCopies: firstNonNegativeNumber(item.availableCopies, existing.availableCopies),
      totalCopies: firstPositiveNumber(item.totalCopies, existing.totalCopies),
      collectibleItemId: String(item.collectibleItemId || existing.collectibleItemId || ""),
      name: String(item.name || existing.name || "Unknown Limited"),
      thumbnail: item.thumbnail || existing.thumbnail || `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
      creatorName: String(item.creatorName || existing.creatorName || "Roblox"),
      marketType: "roblox",
      dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
    });
  }
  return [...byAssetId.values()].filter((item) => item.assetId > 0 && item.rap > 0);
}

function dateKeyFromPoint(point) {
  const time = Date.parse(point.date || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

function compactHistoryByDay(points) {
  const latestPointByDay = new Map();
  for (const point of points) {
    const key = dateKeyFromPoint(point); if (!key) continue;
    const current = latestPointByDay.get(key);
    const currentTime = current ? Date.parse(current.date || "") : 0;
    const pointTime = Date.parse(point.date || "");
    if (!current || pointTime >= currentTime) latestPointByDay.set(key, { ...point, date: key });
  }
  return [...latestPointByDay.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function mergeHistoryPoints(...histories) {
  return compactHistoryByDay(histories.flat().filter((point) => Number(point.value) > 0 && Number.isFinite(Date.parse(point.date || ""))).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))).slice(-1000);
}

function buildComparableRapHistory(ownHistory, currentRap) {
  const points = Array.isArray(ownHistory) ? ownHistory.slice() : [];
  const rap = Number(currentRap);
  if (Number.isFinite(rap) && rap > 0) points.push({ value: rap, date: new Date().toISOString(), source: "current" });
  return compactHistoryByDay(points.filter((point) => Number(point.value) > 0 && Number.isFinite(Date.parse(point.date || ""))).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))).slice(-1000);
}

function buildRawComparableRapHistory(ownHistory, currentRap) {
  const points = Array.isArray(ownHistory) ? ownHistory.slice() : [];
  const rap = Number(currentRap);
  if (Number.isFinite(rap) && rap > 0) points.push({ value: rap, date: new Date().toISOString(), source: "current" });
  return points.filter((point) => Number(point.value) > 0 && Number.isFinite(Date.parse(point.date || ""))).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-5000);
}

function buildRapChangeMetrics(ownHistory, currentRap) {
  const rawHistory = buildRawComparableRapHistory(ownHistory, currentRap);
  const history = rawHistory.slice(-1000);
  if (rawHistory.length < 2) return { history, lossAllTime: null, loss24h: null, loss7d: null, loss30d: null, loss1y: null, profitAllTime: null, profit24h: null, profit7d: null, profit30d: null, profit1y: null, changeAllTime: null, change24h: null, change7d: null, change30d: null, change1y: null };
  const rap = Number(currentRap);
  const baselineAll = findHistoryBaselineValue(rawHistory, null);
  const baseline24h = findPeriodBaselineValue(rawHistory, 1);
  const baseline7d = findPeriodBaselineValue(rawHistory, 7);
  const baseline30d = findPeriodBaselineValue(rawHistory, 30);
  const baseline1y = findPeriodBaselineValue(rawHistory, 365);
  const changeAll = percentChange(baselineAll, rap);
  const change24h = percentChange(baseline24h, rap);
  const change7d = percentChange(baseline7d, rap);
  const change30d = percentChange(baseline30d, rap);
  const change1y = percentChange(baseline1y, rap);
  return {
    history, lossAllTime: changeAll !== null && changeAll < 0 ? Math.abs(changeAll) : null,
    loss24h: change24h !== null && change24h < 0 ? Math.abs(change24h) : null,
    loss7d: change7d !== null && change7d < 0 ? Math.abs(change7d) : null,
    loss30d: change30h !== null && change30h < 0 ? Math.abs(change30h) : null,
    loss1y: change1y !== null && change1y < 0 ? Math.abs(change1y) : null,
    profitAllTime: changeAll !== null && changeAll > 0 ? changeAll : null,
    profit24h: change24h !== null && change24h > 0 ? change24h : null,
    profit7d: change7d !== null && change7d > 0 ? change7d : null,
    profit30d: change30h !== null && change30h > 0 ? change30h : null,
    profit1y: change1y !== null && change1y > 0 ? change1y : null,
    changeAllTime: changeAll, change24h, change7d, change30h, change1y,
  };
}

function compareChangeMetric(a, b, metricKey, isLossSort) {
  const leftRaw = a[metricKey], rightRaw = b[metricKey];
  const leftHasMetric = typeof leftRaw === "number" && Number.isFinite(leftRaw);
  const rightHasMetric = typeof rightRaw === "number" && Number.isFinite(rightRaw);
  const left = leftHasMetric ? leftRaw : 0, right = rightHasMetric ? rightRaw : 0;
  if (leftHasMetric !== rightHasMetric) return rightHasMetric ? 1 : -1;
  return right - left;
}

async function fetchStoredSnapshots(assetId) {
  const safeAssetId = normalizeNumber(Number(assetId));
  if (safeAssetId <= 0) return [];
  if (snapshotStorageEnabled()) {
    const rows = await supabaseRequest(`limited_snapshots?asset_id=eq.${safeAssetId}&select=rap,lowest_price,saved_at&order=saved_at.asc&limit=5000`, { headers: { Prefer: "" } });
    return normalizeSnapshotRows(rows);
  }
  return normalizeSnapshotRows(memorySnapshots.filter((row) => row.asset_id === safeAssetId));
}

async function fetchStoredSnapshotsForAssets(assetIds) {
  const ids = [...new Set(assetIds.map((id) => normalizeNumber(Number(id))).filter((id) => id > 0))];
  const byAssetId = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return byAssetId;
  if (snapshotStorageEnabled()) {
    for (let index = 0; index < ids.length; index += 80) {
      const chunk = ids.slice(index, index + 80);
      const rows = await supabaseRequest(`limited_snapshots?asset_id=in.(${chunk.join(",")})&select=asset_id,rap,lowest_price,saved_at&order=saved_at.asc&limit=20000`, { headers: { Prefer: "" } });
      for (const row of rows || []) {
        const assetId = normalizeNumber(row.asset_id);
        const list = byAssetId.get(assetId);
        if (list) list.push(...normalizeSnapshotRows([row]));
      }
    }
  } else {
    for (const row of memorySnapshots) {
      const list = byAssetId.get(row.asset_id);
      if (list) list.push(...normalizeSnapshotRows([row]));
    }
  }
  return byAssetId;
}

async function saveSnapshotRows(rows) {
  if (rows.length === 0) return 0;
  if (snapshotStorageEnabled()) {
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500);
      try {
        await supabaseRequest("limited_snapshots", { method: "POST", body: JSON.stringify(chunk) });
      } catch (error) { console.warn(`Snapshot save error at ${index}: ${error.message}`); }
    }
    return rows.length;
  }
  memorySnapshots.push(...rows);
  return rows.length;
}

async function saveItemSnapshotRows(rows) {
  if (rows.length === 0) return 0;
  if (snapshotStorageEnabled()) {
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500);
      try {
        await supabaseRequest("item_snapshots", { method: "POST", body: JSON.stringify(chunk) });
      } catch (error) { console.warn(`Item snapshot save error at ${index}: ${error.message}`); }
    }
    return rows.length;
  }
  return rows.length;
}

async function upsertLimitedItemsTable(items) {
  if (items.length === 0 || !snapshotStorageEnabled()) return;
  for (let index = 0; index < items.length; index += 500) {
    const chunk = items.slice(index, index + 500);
    try {
      await supabaseRequest("limited_items?on_conflict=asset_id", { method: "POST", body: JSON.stringify(chunk) });
    } catch (error) { console.warn(`limited_items upsert skipped: ${error.message}`); }
  }
}

async function fetchRobloxCatalogPage(params) {
  const url = buildCatalogUrl(params);
  return fetchJson(url.toString(), { retries: 2, timeoutMs: 8000 });
}

async function discoverAllRobloxLimiteds() {
  const allItems = new Map();
  for (const sortType of ROBLOX_DISCOVERY_SORT_TYPES) {
    let cursor = "";
    for (let page = 0; page < ROBLOX_RECENT_DISCOVERY_PAGES; page++) {
      try {
        const data = await fetchRobloxCatalogPage({ cursor, limit: 120, sortType, marketType: "roblox" });
        const items = data.data || [];
        for (const item of items) {
          const id = normalizeNumber(item.id);
          if (id > 0) {
            allItems.set(id, {
              assetId: id, name: item.name || "Unknown", rap: firstPositiveNumber(item.price), lowestPrice: firstPositiveNumber(item.lowestPrice),
              availableCopies: firstNonNegativeNumber(item.available), totalCopies: firstPositiveNumber(item.unitsAvailable),
              collectibleItemId: String(item.collectibleItemId || ""), itemType: "Asset", marketType: "roblox", creatorName: item.creatorName || "Roblox",
            });
          }
        }
        cursor = data.nextPageCursor;
        if (!cursor) break;
      } catch (e) { break; }
      await sleep(250);
    }
  }
  return [...allItems.values()];
}

async function warmMarketIndex() {
  if (marketIndexCache.has("roblox")) return marketIndexCache.get("roblox");
  const buildKey = Date.now();
  marketIndexBuilds.set("roblox", buildKey);
  
  let items = await discoverAllRobloxLimiteds();
  const secondaryItems = await fetchLatestItemSnapshotItems();
  items = mergeMarketItems(items, secondaryItems);
  
  if (marketIndexBuilds.get("roblox") === buildKey) {
    marketIndexCache.set("roblox", items);
    console.log(`Roblox market index warmed with ${items.length} priced limiteds.`);
  }
  return items;
}

async function getSortedMarketIndex(marketType) {
  if (marketType !== "roblox") return [];
  let items = marketIndexCache.get("roblox");
  if (!items || items.length === 0) {
    items = await warmMarketIndex();
  }
  return items;
}

async function handleLimitedsRequest(req, res, parsedUrl) {
  const params = parsedUrl.searchParams;
  const marketType = params.get("type") === "roblox" ? "roblox" : "ugc";
  const sort = params.get("sort") || "updated";
  const keyword = (params.get("keyword") || "").trim();
  const cursor = (params.get("cursor") || "").trim();
  const limit = normalizeLimit(params.get("limit"));
  const minPrice = parseOptionalNumber(params.get("minPrice"));
  const maxPrice = parseOptionalNumber(params.get("maxPrice"));
  const minRap = parseOptionalNumber(params.get("minRap"));
  const maxRap = parseOptionalNumber(params.get("maxRap"));
  
  const cacheKey = makePageCacheKey({ marketType, sort, keyword, cursor, limit, minPrice, maxPrice, minRap, maxRap });
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return sendJson(res, 200, cached.data);
  }

  if (marketType === "ugc") {
    const data = await fetchRobloxCatalogPage({ cursor, limit, keyword, marketType: "ugc", sort });
    const rawItems = data.data || [];
    const items = rawItems.map(item => {
      const assetId = normalizeNumber(item.id);
      const rap = firstPositiveNumber(item.price);
      const lowestPrice = firstPositiveNumber(item.lowestPrice);
      return {
        assetId, name: item.name || "Unknown", rap, lowestPrice,
        availableCopies: firstNonNegativeNumber(item.available), totalCopies: firstPositiveNumber(item.unitsAvailable),
        collectibleItemId: String(item.collectibleItemId || ""), itemType: "Asset", marketType: "ugc",
        creatorName: item.creatorName || "UGC", thumbnail: item.itemThumbnail ? `https://thumbnails.roblox.com/v1/thumbnails?format=Png&isCircular=false&size=420x420&token=${item.itemThumbnail}` : `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
        dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
        overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
      };
    }).filter(item => item.assetId > 0 && item.rap > 0);
    
    const result = { ok: true, items, nextPageCursor: data.nextPageCursor || "", updatedAt: new Date().toISOString() };
    pageCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return sendJson(res, 200, result);
  }

  let items = await getSortedMarketIndex("roblox");
  
  if (keyword) {
    const lowerKeyword = keyword.toLowerCase();
    items = items.filter(item => item.name.toLowerCase().includes(lowerKeyword));
  }
  if (Number.isFinite(minPrice) && minPrice > 0) items = items.filter(item => !item.lowestPrice || item.lowestPrice >= minPrice);
  if (Number.isFinite(maxPrice) && maxPrice > 0) items = items.filter(item => !item.lowestPrice || item.lowestPrice <= maxPrice);
  if (Number.isFinite(minRap) && minRap > 0) items = items.filter(item => item.rap >= minRap);
  if (Number.isFinite(maxRap) && maxRap > 0) items = items.filter(item => item.rap <= maxRap);

  const metricSorts = ["price_desc", "rap_desc", "deal_desc", "overpriced_desc", "bought_24h", "bought_7d", "bought_30d", "bought_1y", "loss_24h", "loss_7d", "loss_30d", "loss_1y", "loss_all", "profit_24h", "profit_7d", "profit_30d", "profit_1y", "profit_all"];
  
  if (sort === "price_asc") {
    items.sort((a, b) => (a.lowestPrice || Infinity) - (b.lowestPrice || Infinity));
  } else if (sort === "rap_desc") {
    items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  } else if (sort === "deal_desc") {
    items.sort(compareDealItems);
  } else if (sort === "overpriced_desc") {
    items.sort(compareOverpricedItems);
  } else if (metricSorts.includes(sort)) {
    if (sort.startsWith("bought_")) {
      const days = getBoughtRangeDays(sort);
      if (days) {
        items = await addResaleActivityMetrics(items, days);
      }
    } else if (sort.startsWith("loss_") || sort.startsWith("profit_")) {
      const isLoss = sort.startsWith("loss_");
      const daysMap = { "_24h": 1, "_7d": 7, "_30d": 30, "_1y": 365, "_all": null };
      const suffix = sort.replace("loss_", "").replace("profit_", "");
      const days = daysMap[`_${suffix}`];
      
      for (const item of items) {
        const history = await fetchStoredSnapshots(item.assetId);
        const metrics = buildRapChangeMetrics(history, item.rap);
        Object.assign(item, metrics);
      }
      const metricKey = isLoss ? `loss${suffix}` : `profit${suffix}`;
      items.sort((a, b) => compareChangeMetric(a, b, metricKey, isLoss));
    }
  } else {
    items.sort((a, b) => b.assetId - a.assetId);
  }

  const startIdx = cursor ? parseInt(cursor, 10) || 0 : 0;
  const pagedItems = items.slice(startIdx, startIdx + limit);
  const nextCursor = (startIdx + limit < items.length) ? String(startIdx + limit) : "";

  const result = { ok: true, items: pagedItems, nextPageCursor: nextCursor, updatedAt: new Date().toISOString() };
  pageCache.set(cacheKey, { cachedAt: Date.now(), data: result });
  return sendJson(res, 200, result);
}

async function handleItemDetailsRequest(req, res, parsedUrl) {
  const params = parsedUrl.searchParams;
  const assetId = normalizeNumber(Number(params.get("assetId")));
  const marketType = params.get("type") === "roblox" ? "roblox" : "ugc";
  const collectibleItemId = (params.get("collectibleItemId") || "").trim();

  if (assetId <= 0) return sendJson(res, 400, { ok: false, error: "Missing assetId" });

  const cacheKey = `details:${assetId}:${collectibleItemId}`;
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

  let item = { assetId, name: "Unknown", rap: 0, lowestPrice: 0, marketType, collectibleItemId };
  
  try {
    const [catalogDetails, economyDetails, resaleDetails] = await Promise.all([
      fetchCatalogDetailsBatch([assetId]).then(m => m.get(assetId) || {}),
      fetchEconomyDetails(assetId),
      collectibleItemId && assetId > 10_000_000_000 ? fetchCollectibleResaleData(collectibleItemId) : fetchResaleData(assetId),
    ]);

    const rap = firstPositiveNumber(catalogDetails.price, economyDetails.Rap, resaleDetails.recentAveragePrice);
    const lowestPrice = clearPriceWithoutSellers(firstPositiveNumber(catalogDetails.lowestPrice, resaleDetails.lowestResalePrice), firstNonNegativeNumber(catalogDetails.available, resaleDetails.numberRemaining));
    
    item = {
      assetId, name: catalogDetails.name || economyDetails.Name || "Unknown", rap, lowestPrice,
      availableCopies: firstNonNegativeNumber(catalogDetails.available, resaleDetails.numberRemaining),
      totalCopies: firstPositiveNumber(catalogDetails.unitsAvailable, economyDetails.Sales),
      collectibleItemId: String(catalogDetails.collectibleItemId || collectibleItemId),
      itemType: catalogDetails.itemType || "Asset", marketType, creatorName: catalogDetails.creatorName || economyDetails.Creator?.Name || "Unknown",
      thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
      dealValue: calculateDealValue(rap, lowestPrice), dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice), overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
    };

    const ownHistory = await fetchStoredSnapshots(assetId);
    const resaleHistory = normalizeHistoryPoints(resaleDetails.priceDataPoints);
    const combinedHistory = mergeHistoryPoints(ownHistory, resaleHistory);
    const changeMetrics = buildRapChangeMetrics(combinedHistory, rap);
    
    const salesHistory = buildSalesHistory(resaleDetails.priceDataPoints, resaleDetails.volumeDataPoints, lowestPrice);
    const sales24h = calculateSalesMetrics(salesHistory, 1);
    const sales7d = calculateSalesMetrics(salesHistory, 7);
    const sales30d = calculateSalesMetrics(salesHistory, 30);

    Object.assign(item, changeMetrics, {
      history: combinedHistory,
      salesCount: sales24h.salesCount || sales7d.salesCount, averageSalePrice: sales24h.averageSalePrice || sales7d.averageSalePrice,
      volume24h: sales24h.salesCount, volume7d: sales7d.salesCount, volume30d: sales30d.salesCount,
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: "Failed to load item details" });
  }

  detailCache.set(cacheKey, { cachedAt: Date.now(), data: item });
  return sendJson(res, 200, item);
}

async function handlePortfolioRequest(req, res, parsedUrl) {
  const params = parsedUrl.searchParams;
  const userId = params.get("userId");
  if (!userId) return sendJson(res, 400, { ok: false, error: "Missing userId" });

  const cacheKey = `portfolio:${userId}`;
  const cached = portfolioCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

  try {
    const data = await fetchJson(`${ROBLOX_INVENTORY_URL}/${userId}/assets/collectibles?limit=100&sortOrder=Asc`, { retries: 2, timeoutMs: 5000 });
    const rawItems = data.data || [];
    if (rawItems.length === 0) return sendJson(res, 200, { ok: true, items: [], stats: {}, charts: {} });

    const assetIds = rawItems.map(i => normalizeNumber(i.assetId)).filter(id => id > 0);
    const catalogDetails = await fetchCatalogDetailsBatch(assetIds);
    
    const items = await Promise.all(rawItems.map(async (raw) => {
      const assetId = normalizeNumber(raw.assetId);
      const details = catalogDetails.get(assetId) || {};
      const rap = firstPositiveNumber(raw.recentAveragePrice, details.price);
      const lowestPrice = firstPositiveNumber(raw.price, details.lowestPrice);
      
      const ownHistory = await fetchStoredSnapshots(assetId);
      const changeMetrics = buildRapChangeMetrics(ownHistory, rap);

      return {
        assetId, name: details.name || raw.name || "Unknown", rap, lowestPrice,
        quantity: raw.owned || 1, collectibleItemId: String(raw.collectibleItemId || details.collectibleItemId || ""),
        marketType: assetId > 10_000_000_000 ? "ugc" : "roblox",
        ...changeMetrics,
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
  lastSnapshotAttemptAt = Date.now();
  console.log("Snapshot started.");

  try {
    let items = await discoverAllRobloxLimiteds();
    const secondaryItems = await fetchLatestItemSnapshotItems();
    items = mergeMarketItems(items, secondaryItems);
    
    items = await addSnapshotSalesMetrics(items);
    
    const snapshotRows = items.map(item => ({ asset_id: item.assetId, rap: item.rap, lowest_price: item.lowestPrice || null, saved_at: new Date().toISOString() }));
    await saveSnapshotRows(snapshotRows);

    const itemRows = items.map(item => ({
      asset_id: item.assetId, collectible_item_id: item.collectibleItemId, name: item.name,
      rap: item.rap, value: item.rap, lowest_price: item.lowestPrice || null,
      available_copies: item.availableCopies || 0, total_copies: item.totalCopies || 0,
      volume_24h: item.volume24h || 0, volume_7d: item.volume7d || 0, volume_30d: item.volume30h || 0,
      volume_1y: item.volume1y || 0, sales_all_time: item.salesAllTime || 0, saved_at: new Date().toISOString(),
    }));
    await saveItemSnapshotRows(itemRows);
    await upsertLimitedItemsTable(itemRows);
    
    console.log(`Snapshot saved ${items.length} rows to supabase.`);
    lastSnapshotRunAt = Date.now();
  } catch (error) {
    console.error(`Snapshot failed: ${error.message}`);
  } finally {
    snapshotRunning = false;
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  try {
    // NEW PING ROUTE TO KEEP RENDER AWAKE
    if (pathname === "/ping" || pathname === "/") {
      return sendJson(res, 200, { status: "awake", version: SERVER_VERSION });
    }

    if (pathname === "/api/limiteds") return await handleLimitedsRequest(req, res, parsedUrl);
    if (pathname === "/api/item") return await handleItemDetailsRequest(req, res, parsedUrl);
    if (pathname === "/api/portfolio") return await handlePortfolioRequest(req, res, parsedUrl);
    
    if (pathname === "/api/trigger-snapshot" && method === "POST") {
      const secret = parsedUrl.searchParams.get("secret");
      if (SNAPSHOT_SECRET !== "" && secret !== SNAPSHOT_SECRET) return sendJson(res, 403, { error: "Invalid secret" });
      runSnapshot().catch(err => console.error("Snapshot trigger error:", err.message));
      return sendJson(res, 200, { ok: true, message: "Snapshot triggered" });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`Unhandled error for ${pathname}: ${error.message}`);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

// FIX FOR RENDER DNS ISSUE: Wait 5 seconds for network to connect before starting
import http from "http";
import { URL } from "url";

async function startServer() {
  console.log("Waiting for Render network to be ready...");
  await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
  
  server.listen(PORT, () => {
    console.log(`Limiteds Live server ${SERVER_VERSION} running on http://localhost:${PORT}`);
  });
}

startServer();

// Auto-run snapshot on startup if Supabase is connected
if (snapshotStorageEnabled()) {
  setTimeout(() => runSnapshot().catch(e => console.error(e.message)), 10000); // Run 10 seconds after boot
}
