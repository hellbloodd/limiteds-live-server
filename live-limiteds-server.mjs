// Local/prod backend for the Roblox Limiteds Live UI.
// Run with: node live-limiteds-server.mjs
//
// The Roblox client calls this server, not Roblox marketplace APIs directly.
// Deploy it to a public HTTPS host before using it in a published Roblox game.

const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "snapshot-saves-live-recent-2026-06-16-6";
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
const ACTIVE_SALES_SCAN_LIMIT = Number(process.env.ACTIVE_SALES_SCAN_LIMIT || 360);
const ROBLOX_RECENT_DISCOVERY_PAGES = Number(process.env.ROBLOX_RECENT_DISCOVERY_PAGES || 4);
const ROBLOX_RECENT_DISCOVERY_KEYWORDS = [
  "8-Bit Clockwork Shades",
  "Oozing Oscar",
  "Bunny Ears",
  "Lampshade",
  "Pinstripe Fedora",
  "Clockwork's Golden Shades",
  "Fall Fairy",
];

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
      if (result.size > 0) {
        break;
      }

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

    if (index + 100 < missing.length) {
      await sleep(220);
    }
  }

  return result;
}

function buildCatalogUrl({ cursor, limit, keyword, marketType, sort }) {
  const url = new URL(ROBLOX_CATALOG_URL);
  const metricSorts = [
    "price_desc",
    "rap_desc",
    "deal_desc",
    "overpriced_desc",
    "bought_24h",
    "bought_7d",
    "bought_30d",
    "bought_1y",
    "loss_24h",
    "loss_7d",
    "loss_30d",
    "loss_1y",
    "loss_all",
    "profit_24h",
    "profit_7d",
    "profit_30d",
    "profit_1y",
    "profit_all",
  ];
  const sortType = marketType === "ugc"
    ? "2"
    : marketType === "roblox" && sort === "updated"
    ? "3"
    : sort === "price_asc" || sort === "deal_desc" ? "4" : metricSorts.includes(sort) ? "5" : "3";

  // The public search endpoint accepts All + salesTypeFilter=2 for resale-enabled
  // catalog results. "Collectibles" is rejected by this endpoint.
  url.searchParams.set("category", "All");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("sortType", sortType);
  url.searchParams.set("limit", String(limit));

  if (marketType === "roblox") {
    url.searchParams.set("creatorTargetId", "1");
    url.searchParams.set("creatorType", "User");
  }

  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  if (keyword) {
    url.searchParams.set("keyword", keyword);
  }

  return url;
}

async function fetchResaleData(assetId) {
  const cached = resaleCache.get(assetId);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(`${ROBLOX_RESALE_URL}/${assetId}/resale-data`, {
      retries: 2,
      timeoutMs: 5000,
    });
    resaleCache.set(assetId, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return {};
  }
}

async function fetchCollectibleResaleData(collectibleItemId) {
  const safeId = String(collectibleItemId || "").trim();

  if (!safeId) {
    return {};
  }

  const cacheKey = `collectible:${safeId}`;
  const cached = resaleCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(`${ROBLOX_COLLECTIBLE_RESALE_URL}/${encodeURIComponent(safeId)}/resale-data`, {
      retries: 2,
      timeoutMs: 3000,
    });
    resaleCache.set(cacheKey, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return {};
  }
}

async function fetchMarketplaceItemDetails(collectibleItemId) {
  const safeId = String(collectibleItemId || "").trim();

  if (!safeId) {
    return {};
  }

  const cacheKey = `marketplace:${safeId}`;
  const cached = catalogDetailCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(ROBLOX_MARKETPLACE_ITEMS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ itemIds: [safeId] }),
      retries: 2,
      timeoutMs: 5000,
    });
    const rows = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    const row = rows[0] || {};
    catalogDetailCache.set(cacheKey, { fetchedAt: Date.now(), data: row });
    return row;
  } catch {
    return {};
  }
}

async function fetchMarketplaceItemDetailsBatch(collectibleItemIds) {
  const result = new Map();
  const missing = [];

  for (const id of collectibleItemIds) {
    const safeId = String(id || "").trim();

    if (!safeId) {
      continue;
    }

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
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ itemIds: chunk }),
        retries: 1,
        timeoutMs: 4000,
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
    } catch {
      // Best effort. The existing resale fallback still handles missing rows.
    }
  }

  return result;
}

async function fetchEconomyDetails(assetId) {
  const cached = economyCache.get(assetId);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(`https://economy.roblox.com/v2/assets/${assetId}/details`, {
      retries: 1,
      timeoutMs: 3000,
    });
    economyCache.set(assetId, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return {};
  }
}

function getPointVolume(point, useValueAsVolume = false) {
  const volume = Number(
    point?.salesVolume ??
      point?.volume ??
      point?.sales ??
      point?.count ??
      point?.quantity ??
      (useValueAsVolume ? point?.value : null)
  );

  return Number.isFinite(volume) && volume > 0 ? Math.round(volume) : null;
}

function normalizeHistoryPoints(points, source = "resale") {
  if (!Array.isArray(points)) {
    return [];
  }

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

  if (!Number.isFinite(time)) {
    return "";
  }

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

    if (!key || !volume) {
      continue;
    }

    volumeByDate.set(key, (volumeByDate.get(key) || 0) + volume);
  }

  const sales = priceHistory
    .map((point) => {
      const key = salesHistoryKey(point.date);
      const volume = getPointVolume(point) ?? volumeByDate.get(key);

      if (key && volume) {
        usedVolumeDates.add(key);
      }

      return {
        ...point,
        salesVolume: volume || null,
      };
    })
    .filter((point) => Number(point.value) > 0 && Number(point.salesVolume) > 0);

  if (Number.isFinite(fallback) && fallback > 0) {
    for (const point of volumeHistory) {
      const key = salesHistoryKey(point.date);

      if (!key || usedVolumeDates.has(key)) {
        continue;
      }

      const volume = getPointVolume(point, true);

      if (!volume) {
        continue;
      }

      sales.push({
        value: fallback,
        date: point.date,
        source: "volume",
        salesVolume: volume,
      });
    }
  }

  return sales
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(-5000);
}

function findHistoryBaselineValue(history, days) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  if (!days) {
    return Number(history[0]?.value) || null;
  }

  const targetTime = getPeriodStartTime(days);
  let baseline = null;
  let firstInsidePeriod = null;
  let latestTime = 0;

  for (const point of history) {
    const value = Number(point.value);
    const time = Date.parse(point.date || "");

    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time)) {
      continue;
    }

    latestTime = Math.max(latestTime, time);

    if (time <= targetTime) {
      baseline = value;
    } else if (firstInsidePeriod === null) {
      firstInsidePeriod = value;
    }
  }

  if (latestTime > 0 && latestTime < targetTime) {
    return null;
  }

  return baseline ?? firstInsidePeriod;
}

function findPeriodBaselineValue(history, days) {
  if (!days) {
    return findHistoryBaselineValue(history, null);
  }

  const targetTime = getPeriodStartTime(days);
  let firstInsidePeriod = null;

  for (const point of history) {
    const value = Number(point.value);
    const time = Date.parse(point.date || "");
    const source = String(point.source || "");

    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time)) {
      continue;
    }

    if (time >= targetTime && source !== "current") {
      firstInsidePeriod = value;
      break;
    }
  }

  return firstInsidePeriod;
}

function getStartOfTodayTime() {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now.getTime();
}

function getPeriodStartTime(days) {
  if (!days) {
    return 0;
  }

  if (Number(days) === 1) {
    return getStartOfTodayTime();
  }

  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function getPeriodEndTime(days) {
  if (Number(days) === 1) {
    return getStartOfTodayTime() + 24 * 60 * 60 * 1000;
  }

  return Date.now();
}

function clearPriceWithoutSellers(lowestPrice, availableCopies) {
  // Roblox's seller/count fields are inconsistent for classic limiteds:
  // some items return 0/null availability while still returning a real
  // lowest resale price. Treat the actual price as the source of truth.
  return firstPositiveNumber(lowestPrice);
}

function percentChange(fromValue, toValue) {
  if (!fromValue || !toValue || fromValue <= 0 || toValue <= 0) {
    return null;
  }

  return Math.round(((toValue - fromValue) / fromValue) * 10000) / 100;
}

function percentDrop(fromValue, toValue) {
  const change = percentChange(fromValue, toValue);

  if (change === null || change >= 0) {
    return null;
  }

  return Math.abs(change);
}

function percentGain(fromValue, toValue) {
  const change = percentChange(fromValue, toValue);

  if (change === null || change <= 0) {
    return null;
  }

  return change;
}

function calculateDealValue(rap, lowestPrice) {
  const safeRap = Number(rap);
  const safePrice = Number(lowestPrice);

  if (!Number.isFinite(safeRap) || !Number.isFinite(safePrice) || safeRap <= 0 || safePrice <= 0 || safePrice >= safeRap) {
    return null;
  }

  return Math.round(safeRap - safePrice);
}

function calculateDealPercent(rap, lowestPrice) {
  const dealValue = calculateDealValue(rap, lowestPrice);
  const safeRap = Number(rap);

  if (dealValue === null || !Number.isFinite(safeRap) || safeRap <= 0) {
    return null;
  }

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
  const safeRap = Number(rap);
  const safePrice = Number(lowestPrice);

  if (!Number.isFinite(safeRap) || !Number.isFinite(safePrice) || safeRap <= 0 || safePrice <= safeRap) {
    return null;
  }

  return Math.round(safePrice - safeRap);
}

function calculateOverpricedPercent(rap, lowestPrice) {
  const overpricedValue = calculateOverpricedValue(rap, lowestPrice);
  const safeRap = Number(rap);

  if (overpricedValue === null || !Number.isFinite(safeRap) || safeRap <= 0) {
    return null;
  }

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
  return {
    bought_24h: 1,
    bought_7d: 7,
    bought_30d: 30,
    bought_1y: 365,
  }[sort] ?? null;
}

function calculateActivityMetrics(points, days, currentRap = null, currentPrice = null) {
  if (!Array.isArray(points) || !days) {
    return { activityCount: null, activityScore: null, averageActivePrice: null };
  }

  const startTime = getPeriodStartTime(days);
  const endTime = Math.min(Date.now(), getPeriodEndTime(days));
  const history = points
    .map((point) => ({
      rap: Number(point.value),
      price: Number(point.lowestPrice ?? point.price ?? point.salePrice ?? (point.source === "resale" ? point.value : null)),
      time: Date.parse(point.date || ""),
    }))
    .filter((point) => Number.isFinite(point.time) && point.time <= endTime && (point.rap > 0 || point.price > 0))
    .sort((a, b) => a.time - b.time);

  const rap = Number(currentRap);
  const price = Number(currentPrice);

  if ((rap > 0 || price > 0) && endTime >= startTime) {
    history.push({
      rap: rap > 0 ? rap : null,
      price: price > 0 ? price : null,
      time: Date.now(),
    });
  }

  let baseline = null;
  const visible = [];

  for (const point of history) {
    if (point.time < startTime) {
      baseline = point;
    } else if (point.time <= endTime) {
      visible.push(point);
    }
  }

  if (visible.length === 0) {
    return { activityCount: null, activityScore: null, averageActivePrice: null };
  }

  const sequence = baseline ? [baseline, ...visible] : visible;
  let previousRap = null;
  let previousPrice = null;
  let rapChanges = 0;
  let priceChanges = 0;
  let priceTotal = 0;
  let priceCount = 0;

  for (const point of sequence) {
    if (point.price > 0) {
      priceTotal += point.price;
      priceCount += 1;
    }

    if (point.rap > 0) {
      if (previousRap !== null && point.rap !== previousRap) {
        rapChanges += 1;
      }

      previousRap = point.rap;
    }

    if (point.price > 0) {
      if (previousPrice !== null && point.price !== previousPrice) {
        priceChanges += 1;
      }

      previousPrice = point.price;
    }
  }

  const firstRap = sequence.find((point) => point.rap > 0)?.rap;
  const lastRap = [...sequence].reverse().find((point) => point.rap > 0)?.rap;
  const rapMove = Math.abs(percentChange(firstRap, lastRap) || 0);
  const activityCount = rapChanges + priceChanges;
  const activityScore = Math.round((activityCount * 100 + rapMove) * 100) / 100;

  if (activityScore <= 0) {
    return { activityCount: null, activityScore: null, averageActivePrice: null };
  }

  return {
    activityCount,
    activityScore,
    averageActivePrice: priceCount > 0 ? Math.round(priceTotal / priceCount) : null,
  };
}

function calculateSalesMetrics(points, days) {
  if (!Array.isArray(points) || !days) {
    return { salesCount: null, averageSalePrice: null };
  }

  const startTime = getPeriodStartTime(days);
  const endTime = getPeriodEndTime(days);
  let salesCount = 0;
  let totalSoldValue = 0;

  for (const point of points) {
    const value = Number(point.value);
    const time = Date.parse(point.date || "");

    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time) || time < startTime || time > endTime) {
      continue;
    }

    const volume = getPointVolume(point);

    if (!volume) {
      continue;
    }

    salesCount += volume;
    totalSoldValue += value * volume;
  }

  if (salesCount <= 0) {
    return { salesCount: null, averageSalePrice: null };
  }

  return { salesCount, averageSalePrice: Math.round(totalSoldValue / salesCount) };
}

function salesMetricToActivity(metric) {
  return {
    activityCount: metric.salesCount,
    activityScore: metric.salesCount,
    averageActivePrice: metric.averageSalePrice,
    salesCount: metric.salesCount,
    averageSalePrice: metric.averageSalePrice,
  };
}

function compareBoughtItems(a, b) {
  const countDiff = (Number(b?.activityCount ?? b?.salesCount) || 0) - (Number(a?.activityCount ?? a?.salesCount) || 0);
  if (countDiff !== 0) return countDiff;

  const scoreDiff = (Number(b?.activityScore) || 0) - (Number(a?.activityScore) || 0);
  if (scoreDiff !== 0) return scoreDiff;

  return (Number(b?.averageActivePrice ?? b?.averageSalePrice) || 0) - (Number(a?.averageActivePrice ?? a?.averageSalePrice) || 0);
}

async function addResaleActivityMetrics(items, days, maxItems = ACTIVE_SALES_SCAN_LIMIT) {
  const candidates = items
    .filter((item) => item.assetId > 0)
    .slice(0, maxItems);

  const enriched = await mapWithConcurrency(candidates, 24, async (item) => {
    let resale = {};
    let latestHistoryPrice = null;
    let sales = {
      salesCount: itemSnapshotSalesForDays(item, days),
      averageSalePrice: firstPositiveNumber(item.lowestPrice),
    };

    if (!sales.salesCount) {
      resale = item.collectibleItemId && item.assetId > 10_000_000_000
        ? await fetchCollectibleResaleData(item.collectibleItemId)
        : await fetchResaleData(item.assetId);
      const history = normalizeHistoryPoints(resale.priceDataPoints);
      latestHistoryPrice = [...history].reverse().find((point) => Number(point.value) > 0)?.value;
      const liveLowestPrice = clearPriceWithoutSellers(
        firstPositiveNumber(item.lowestPrice, resale.lowestResalePrice, latestHistoryPrice),
        firstNonNegativeNumber(item.availableCopies, resale.numberRemaining)
      );
      const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, liveLowestPrice);
      sales = calculateSalesMetrics(salesHistory, days);

      if (sales.salesCount && !sales.averageSalePrice) {
        sales.averageSalePrice = firstPositiveNumber(liveLowestPrice, latestHistoryPrice);
      }
    }

    if (!sales.salesCount) {
      const rolimonsSales = await fetchRolimonsItemSales(item.assetId);
      const rolimonsCount = rolimonsSalesForDays(rolimonsSales, days);

      if (rolimonsCount) {
        sales = {
          salesCount: rolimonsCount,
          averageSalePrice: firstPositiveNumber(item.lowestPrice, latestHistoryPrice),
        };
      }
    }

    const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
    const lowestPrice = clearPriceWithoutSellers(
      firstPositiveNumber(item.lowestPrice, resale.lowestResalePrice, latestHistoryPrice),
      firstNonNegativeNumber(item.availableCopies, resale.numberRemaining)
    );
    const activity = salesMetricToActivity(sales);

    return {
      ...item,
      rap,
      lowestPrice,
      activityCount: activity.activityCount,
      activityScore: activity.activityScore,
      averageActivePrice: activity.averageActivePrice,
      salesCount: activity.activityCount,
      averageSalePrice: activity.averageActivePrice,
    };
  });

  return enriched
    .filter((item) => Number(item.salesCount ?? item.activityCount) > 0)
    .sort(compareBoughtItems);
}

function snapshotStorageEnabled() {
  return SUPABASE_URL !== "" && SUPABASE_SERVICE_ROLE_KEY !== "";
}

async function supabaseRequest(path, options = {}) {
  if (!snapshotStorageEnabled()) {
    return null;
  }

  const requestUrl = `${SUPABASE_URL}/rest/v1/${path}`;
  let response;

  try {
    response = await fetch(requestUrl, {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`Supabase network error for ${requestUrl}: ${error.cause?.message || error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${response.status} for ${requestUrl}: ${text.slice(0, 180)}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  return JSON.parse(text);
}

function normalizeSnapshotRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => ({
      value: Number(row.rap),
      lowestPrice: Number(row.lowest_price) || null,
      date: String(row.saved_at || row.date || ""),
      source: "own",
    }))
    .filter((point) => point.value > 0 && Number.isFinite(Date.parse(point.date)));
}

function normalizeItemSnapshotRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const assetId = normalizeNumber(Number(row.asset_id));
      const rap = firstPositiveNumber(Number(row.rap));
      const lowestPrice = firstPositiveNumber(Number(row.lowest_price));
      const value = firstPositiveNumber(Number(row.value));
      const totalCopies = firstPositiveNumber(Number(row.total_copies));
      const availableCopies = firstNonNegativeNumber(Number(row.available_copies));

      return {
        assetId,
        collectibleItemId: String(row.collectible_item_id || ""),
        name: String(row.name || "Unknown Limited"),
        rap,
        value,
        lowestPrice,
        availableCopies,
        totalCopies,
        volume24h: firstPositiveNumber(Number(row.volume_24h)),
        volume7d: firstPositiveNumber(Number(row.volume_7d)),
        volume30d: firstPositiveNumber(Number(row.volume_30d)),
        volume1y: firstPositiveNumber(Number(row.volume_1y)),
        salesAllTime: firstPositiveNumber(Number(row.sales_all_time)),
        savedAt: String(row.saved_at || ""),
        thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
        creatorName: "Roblox",
        itemType: "Asset",
        marketType: "roblox",
      };
    })
    .filter((item) => item.assetId > 0 && item.rap > 0);
}

async function fetchLatestItemSnapshotItems() {
  const cacheKey = "latest";
  const cached = latestItemSnapshotCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.items;
  }

  if (!snapshotStorageEnabled()) {
    return [];
  }

  async function fetchItemSnapshotPage(offset, includeVolumeColumns) {
    const select = includeVolumeColumns
      ? "asset_id,collectible_item_id,name,rap,value,lowest_price,available_copies,total_copies,volume_24h,volume_7d,volume_30d,volume_1y,sales_all_time,saved_at"
      : "asset_id,collectible_item_id,name,rap,value,lowest_price,available_copies,total_copies,saved_at";

    return supabaseRequest(
      `item_snapshots?select=${select}&order=saved_at.desc&limit=1000&offset=${offset}`,
      { headers: { Prefer: "" } }
    );
  }

  try {
    const rows = [];
    let includeVolumeColumns = true;

    for (let offset = 0; offset < 50000; offset += 1000) {
      let page;

      try {
        page = await fetchItemSnapshotPage(offset, includeVolumeColumns);
      } catch (error) {
        if (!includeVolumeColumns) {
          throw error;
        }

        includeVolumeColumns = false;
        page = await fetchItemSnapshotPage(offset, includeVolumeColumns);
      }

      if (!Array.isArray(page) || page.length === 0) {
        break;
      }

      rows.push(...page);

      if (page.length < 1000) {
        break;
      }
    }

    const latestByAssetId = new Map();

    for (const item of normalizeItemSnapshotRows(rows)) {
      const current = latestByAssetId.get(item.assetId);
      const currentTime = current ? Date.parse(current.savedAt || "") : 0;
      const itemTime = Date.parse(item.savedAt || "");

      if (!current || itemTime >= currentTime) {
        latestByAssetId.set(item.assetId, item);
      }
    }

    const items = [...latestByAssetId.values()];
    latestItemSnapshotCache.set(cacheKey, { fetchedAt: Date.now(), items });
    return items;
  } catch (error) {
    console.warn(`item_snapshots read skipped: ${error.message}`);
    latestItemSnapshotCache.set(cacheKey, { fetchedAt: Date.now(), items: [] });
    return [];
  }
}

function mergeMarketItems(primaryItems, secondaryItems) {
  const byAssetId = new Map();

  for (const item of [...secondaryItems, ...primaryItems]) {
    const assetId = normalizeNumber(Number(item.assetId));

    if (assetId <= 0) {
      continue;
    }

    const existing = byAssetId.get(assetId) || {};
    const rap = firstPositiveNumber(item.rap, existing.rap);
    const lowestPrice = firstPositiveNumber(item.lowestPrice, existing.lowestPrice);

    byAssetId.set(assetId, {
      ...existing,
      ...item,
      assetId,
      rap,
      lowestPrice,
      value: firstPositiveNumber(item.value, existing.value),
      availableCopies: firstNonNegativeNumber(item.availableCopies, existing.availableCopies),
      totalCopies: firstPositiveNumber(item.totalCopies, existing.totalCopies),
      collectibleItemId: String(item.collectibleItemId || existing.collectibleItemId || ""),
      name: String(item.name || existing.name || "Unknown Limited"),
      thumbnail: item.thumbnail || existing.thumbnail || `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
      creatorName: String(item.creatorName || existing.creatorName || "Roblox"),
      marketType: "roblox",
      dealValue: calculateDealValue(rap, lowestPrice),
      dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice),
      overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
    });
  }

  return [...byAssetId.values()].filter((item) => item.assetId > 0 && item.rap > 0);
}

function dateKeyFromPoint(point) {
  const time = Date.parse(point.date || "");

  if (!Number.isFinite(time)) {
    return "";
  }

  return new Date(time).toISOString().slice(0, 10);
}

function compactHistoryByDay(points) {
  const latestPointByDay = new Map();

  for (const point of points) {
    const key = dateKeyFromPoint(point);

    if (!key) {
      continue;
    }

    const current = latestPointByDay.get(key);
    const currentTime = current ? Date.parse(current.date || "") : 0;
    const pointTime = Date.parse(point.date || "");

    if (!current || pointTime >= currentTime) {
      latestPointByDay.set(key, {
        ...point,
        date: key,
      });
    }
  }

  return [...latestPointByDay.values()]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function mergeHistoryPoints(...histories) {
  return compactHistoryByDay(histories
    .flat()
    .filter((point) => Number(point.value) > 0 && Number.isFinite(Date.parse(point.date || "")))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)))
    .slice(-1000);
}

function buildComparableRapHistory(ownHistory, currentRap) {
  const points = Array.isArray(ownHistory) ? ownHistory.slice() : [];
  const rap = Number(currentRap);

  if (Number.isFinite(rap) && rap > 0) {
    points.push({
      value: rap,
      date: new Date().toISOString(),
      source: "current",
    });
  }

  return compactHistoryByDay(points
    .filter((point) => Number(point.value) > 0 && Number.isFinite(Date.parse(point.date || "")))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)))
    .slice(-1000);
}

function buildRawComparableRapHistory(ownHistory, currentRap) {
  const points = Array.isArray(ownHistory) ? ownHistory.slice() : [];
  const rap = Number(currentRap);

  if (Number.isFinite(rap) && rap > 0) {
    points.push({
      value: rap,
      date: new Date().toISOString(),
      source: "current",
    });
  }

  return points
    .filter((point) => Number(point.value) > 0 && Number.isFinite(Date.parse(point.date || "")))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(-5000);
}

function buildRapChangeMetrics(ownHistory, currentRap) {
  const rawHistory = buildRawComparableRapHistory(ownHistory, currentRap);
  const history = rawHistory.slice(-1000);

  if (rawHistory.length < 2) {
    return {
      history,
      lossAllTime: null,
      loss24h: null,
      loss7d: null,
      loss30d: null,
      loss1y: null,
      profitAllTime: null,
      profit24h: null,
      profit7d: null,
      profit30d: null,
      profit1y: null,
      changeAllTime: null,
      change24h: null,
      change7d: null,
      change30d: null,
      change1y: null,
    };
  }

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
    history,
    lossAllTime: changeAll !== null && changeAll < 0 ? Math.abs(changeAll) : null,
    loss24h: change24h !== null && change24h < 0 ? Math.abs(change24h) : null,
    loss7d: change7d !== null && change7d < 0 ? Math.abs(change7d) : null,
    loss30d: change30d !== null && change30d < 0 ? Math.abs(change30d) : null,
    loss1y: change1y !== null && change1y < 0 ? Math.abs(change1y) : null,
    profitAllTime: changeAll !== null && changeAll > 0 ? changeAll : null,
    profit24h: change24h !== null && change24h > 0 ? change24h : null,
    profit7d: change7d !== null && change7d > 0 ? change7d : null,
    profit30d: change30d !== null && change30d > 0 ? change30d : null,
    profit1y: change1y !== null && change1y > 0 ? change1y : null,
    changeAllTime: changeAll,
    change24h,
    change7d,
    change30d,
    change1y,
  };
}

function compareChangeMetric(a, b, metricKey, isLossSort) {
  const leftRaw = a[metricKey];
  const rightRaw = b[metricKey];
  const leftHasMetric = typeof leftRaw === "number" && Number.isFinite(leftRaw);
  const rightHasMetric = typeof rightRaw === "number" && Number.isFinite(rightRaw);
  const left = leftHasMetric ? leftRaw : 0;
  const right = rightHasMetric ? rightRaw : 0;

  if (leftHasMetric !== rightHasMetric) {
    return rightHasMetric ? 1 : -1;
  }

  return right - left;
}

async function fetchStoredSnapshots(assetId) {
  const safeAssetId = normalizeNumber(Number(assetId));

  if (safeAssetId <= 0) {
    return [];
  }

  if (snapshotStorageEnabled()) {
    const rows = await supabaseRequest(
      `limited_snapshots?asset_id=eq.${safeAssetId}&select=rap,lowest_price,saved_at&order=saved_at.asc&limit=5000`,
      { headers: { Prefer: "" } }
    );
    return normalizeSnapshotRows(rows);
  }

  return normalizeSnapshotRows(
    memorySnapshots.filter((row) => row.asset_id === safeAssetId)
  );
}

async function fetchStoredSnapshotsForAssets(assetIds) {
  const ids = [...new Set(assetIds.map((id) => normalizeNumber(Number(id))).filter((id) => id > 0))];
  const byAssetId = new Map(ids.map((id) => [id, []]));

  if (ids.length === 0) {
    return byAssetId;
  }

  if (snapshotStorageEnabled()) {
    for (let index = 0; index < ids.length; index += 80) {
      const chunk = ids.slice(index, index + 80);
      const rows = await supabaseRequest(
        `limited_snapshots?asset_id=in.(${chunk.join(",")})&select=asset_id,rap,lowest_price,saved_at&order=saved_at.asc&limit=20000`,
        { headers: { Prefer: "" } }
      );

      for (const row of rows || []) {
        const assetId = normalizeNumber(row.asset_id);
        const list = byAssetId.get(assetId);

        if (list) {
          list.push(...normalizeSnapshotRows([row]));
        }
      }
    }
  } else {
    for (const row of memorySnapshots) {
      const list = byAssetId.get(row.asset_id);

      if (list) {
        list.push(...normalizeSnapshotRows([row]));
      }
    }
  }

  return byAssetId;
}

async function saveSnapshotRows(rows) {
  if (rows.length === 0) {
    return 0;
  }

  if (snapshotStorageEnabled()) {
    for (let index = 0; index < rows.length; index += 500) {
      await supabaseRequest("limited_snapshots", {
        method: "POST",
        body: JSON.stringify(rows.slice(index, index + 500)),
      });
    }
  } else {
    memorySnapshots = memorySnapshots.concat(rows).slice(-100_000);
  }

  return rows.length;
}

async function saveItemSnapshotRows(rows) {
  if (rows.length === 0 || !snapshotStorageEnabled()) {
    return 0;
  }

  for (let index = 0; index < rows.length; index += 500) {
    await supabaseRequest("item_snapshots", {
      method: "POST",
      body: JSON.stringify(rows.slice(index, index + 500)),
    });
  }

  latestItemSnapshotCache.clear();
  return rows.length;
}

async function runSnapshotJob() {
  if (snapshotRunning) {
    return { ok: true, skipped: true, reason: "Snapshot already running." };
  }

  snapshotRunning = true;
  lastSnapshotAttemptAt = Date.now();

  try {
    console.log("Snapshot started.");
    let items;

    try {
      const [rolimonsItems, discoveryItems] = await Promise.all([
        fetchRolimonsItems(),
        fetchRobloxRecentDiscoveryItems().catch(() => []),
      ]);

      items = mergeMarketItems(discoveryItems, rolimonsItems);
    } catch (error) {
      throw new Error(`Rolimons snapshot fetch failed: ${error.message}`);
    }

    let pricedItems = items;

    try {
      pricedItems = await enrichRolimonsItemsWithCatalogDetails(items);
    } catch (error) {
      console.warn(`Snapshot price enrichment failed: ${error.message}`);
    }

    pricedItems = await mapWithConcurrency(pricedItems, 10, async (item) => {
      if (item.lowestPrice && item.lowestPrice > 0) {
        return item;
      }

      const resale = await fetchResaleData(item.assetId);
      const lowestPrice = firstNumber(resale.lowestResalePrice, item.lowestPrice);

      return {
        ...item,
        lowestPrice,
      };
    });

    const savedAt = new Date().toISOString();
    const itemRows = pricedItems
      .filter((item) => item.assetId > 0 && item.rap > 0)
      .map((item) => ({
        asset_id: item.assetId,
        collectible_item_id: item.collectibleItemId ? String(item.collectibleItemId) : null,
        name: item.name,
        rap: Math.round(item.rap),
        value: item.value && item.value > 0 ? Math.round(item.value) : null,
        lowest_price: item.lowestPrice && item.lowestPrice > 0 ? Math.round(item.lowestPrice) : null,
        available_copies: item.availableCopies !== null && item.availableCopies !== undefined ? Math.round(item.availableCopies) : null,
        total_copies: item.totalCopies && item.totalCopies > 0 ? Math.round(item.totalCopies) : null,
        volume_24h: item.volume24h ?? null,
        volume_7d: item.volume7d ?? null,
        volume_30d: item.volume30d ?? null,
        volume_1y: item.volume1y ?? null,
        sales_all_time: item.salesAllTime ?? null,
        saved_at: savedAt,
      }));
    const rows = itemRows.map((item) => ({
      asset_id: item.asset_id,
      name: item.name,
      rap: item.rap,
      lowest_price: item.lowest_price,
      saved_at: item.saved_at,
    }));
    let saved;

    try {
      saved = snapshotStorageEnabled()
        ? await saveItemSnapshotRows(itemRows)
        : await saveSnapshotRows(rows);
    } catch (error) {
      console.warn(`item_snapshots save skipped: ${error.message}`);
      saved = await saveSnapshotRows(rows);
    }

    lastSnapshotRunAt = Date.now();
    console.log(`Snapshot saved ${saved} rows to ${snapshotStorageEnabled() ? "supabase" : "memory"}.`);
    return {
      ok: true,
      saved,
      storedIn: snapshotStorageEnabled() ? "supabase" : "memory",
      savedAt,
    };
  } finally {
    snapshotRunning = false;
  }
}

function maybeRunSnapshotInBackground() {
  if (SNAPSHOT_INTERVAL_MS <= 0 || snapshotRunning || marketIndexBuilds.size > 0) {
    return;
  }

  if (Date.now() - lastSnapshotRunAt < SNAPSHOT_INTERVAL_MS) {
    return;
  }

  if (Date.now() - lastSnapshotAttemptAt < 5 * 60 * 1000) {
    return;
  }

  runSnapshotJob().catch((error) => {
    console.warn(`Snapshot failed: ${error.message}`);
    if (error.stack) {
      console.warn(error.stack);
    }
  });
}

function tokenizeKeyword(keyword) {
  return String(keyword || "")
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesAllKeywordTokens(item, tokens) {
  if (tokens.length === 0) {
    return true;
  }

  const haystack = `${item.name || item.itemName || ""} ${item.acronym || ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function chooseCatalogKeyword(tokens, fallback) {
  if (tokens.length === 0) {
    return fallback;
  }

  return tokens.reduce((best, token) => token.length > best.length ? token : best, tokens[0]);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

async function fetchRolimonsItems() {
  if (rolimonsCache && Date.now() - rolimonsCache.fetchedAt < ROLIMONS_CACHE_TTL_MS) {
    return rolimonsCache.items;
  }

  const data = await fetchJson(ROLIMONS_ITEM_DETAILS_URL, {
    retries: 1,
    timeoutMs: 5000,
  });
  const rawItems = data && typeof data.items === "object" ? data.items : {};
  const items = Object.entries(rawItems).map(([assetId, values]) => ({
    assetId: Number(assetId),
    name: String(values[0] || "Unknown Limited"),
    acronym: String(values[1] || ""),
    rap: Number(values[2]) > 0 ? Number(values[2]) : null,
    value: Number(values[3]) > 0 ? Number(values[3]) : null,
    lowestPrice: 0,
    availableCopies: null,
    totalCopies: null,
    thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
    creatorName: "Roblox",
    itemType: "Asset",
    marketType: "roblox",
  })).filter((item) => item.assetId > 0 && item.rap);

  rolimonsCache = {
    fetchedAt: Date.now(),
    items,
  };

  return items;
}

async function fetchRolimonsItemSales(assetId) {
  const safeAssetId = Math.floor(Number(assetId) || 0);

  if (safeAssetId <= 0 || Date.now() < rolimonsSalesBlockedUntil) {
    return {};
  }

  const cached = rolimonsSalesCache.get(safeAssetId);

  if (cached && Date.now() - cached.fetchedAt < ROLIMONS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `https://www.rolimons.com/itemsales/${safeAssetId}`;
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) {
      return {};
    }

    const html = await response.text();

    if (html.includes("Just a moment") || html.includes("challenge-platform") || html.includes("cf_chl")) {
      rolimonsSalesBlockedUntil = Date.now() + 10 * 60 * 1000;
      return {};
    }

    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    const parseNum = (value) => value ? Number(String(value).replace(/,/g, "")) : null;
    const data = {
      sales24h: parseNum(text.match(/Past Day Sales\s*([\d,]+)/)?.[1]),
      sales7d: parseNum(text.match(/Past Week Sales\s*([\d,]+)/)?.[1]),
      sales30d: parseNum(text.match(/Past Month Sales\s*([\d,]+)/)?.[1]),
      salesAllTime: parseNum(text.match(/All Tracked Sales\s*([\d,]+)/)?.[1]),
    };

    rolimonsSalesCache.set(safeAssetId, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return {};
  }
}

function rolimonsSalesForDays(sales, days) {
  if (!sales || typeof sales !== "object") {
    return null;
  }

  if (days <= 1) return firstPositiveNumber(sales.sales24h);
  if (days <= 7) return firstPositiveNumber(sales.sales7d);
  if (days <= 30) return firstPositiveNumber(sales.sales30d);
  return null;
}

function itemSnapshotSalesForDays(item, days) {
  if (!item || typeof item !== "object") {
    return null;
  }

  if (days <= 1) return firstPositiveNumber(Number(item.volume24h));
  if (days <= 7) return firstPositiveNumber(Number(item.volume7d));
  if (days <= 30) return firstPositiveNumber(Number(item.volume30d));
  return firstPositiveNumber(Number(item.volume1y));
}

async function enrichRolimonsItem(item, includeResale = false, includeDetails = true) {
  const [details, resale] = await Promise.all([
    includeDetails ? fetchEconomyDetails(item.assetId) : {},
    includeResale && item.assetId > 0 && item.assetId < 10000000000
      ? fetchResaleData(item.assetId)
      : {},
  ]);
  const collectibleDetails = details.CollectiblesItemDetails || {};
  const rap = firstPositiveNumber(
    item.rap,
    details.RecentAveragePrice,
    collectibleDetails.RecentAveragePrice,
    resale.recentAveragePrice
  );
  const rawLowestPrice = firstPositiveNumber(
    collectibleDetails.CollectibleLowestResalePrice,
    details.PriceInRobux,
    resale.lowestResalePrice,
    item.lowestPrice
  );
  const availableCopies = firstNonNegativeNumber(resale.numberRemaining, item.availableCopies);
  const lowestPrice = clearPriceWithoutSellers(rawLowestPrice, availableCopies);

  return {
    ...item,
    rap,
    lowestPrice,
    availableCopies,
    totalCopies: firstPositiveNumber(collectibleDetails.TotalQuantity, item.totalCopies),
    dealValue: calculateDealValue(rap, lowestPrice),
    dealPercent: calculateDealPercent(rap, lowestPrice),
    overpricedValue: calculateOverpricedValue(rap, lowestPrice),
    overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
  };
}

async function enrichRolimonsItemsWithCatalogDetails(items, includeResaleFallback = false) {
  const detailByAssetId = await fetchCatalogDetailsBatch(items.map((item) => item.assetId));

  const enriched = items.map((item) => {
    const details = detailByAssetId.get(item.assetId) || {};
    const rawLowestPrice = firstPositiveNumber(
      details.lowestResalePrice,
      details.lowestPrice,
      item.lowestPrice
    );
    const availableCopies = firstNonNegativeNumber(details.unitsAvailableForConsumption, item.availableCopies);
    const lowestPrice = clearPriceWithoutSellers(rawLowestPrice, availableCopies);
    const rap = firstPositiveNumber(
      item.rap,
      details.recentAveragePrice
    );

    return {
      ...item,
      rap,
      lowestPrice,
      availableCopies,
      totalCopies: firstPositiveNumber(details.totalQuantity, item.totalCopies),
      creatorName: String(details.creatorName || item.creatorName || "Roblox"),
      itemType: String(details.itemType || item.itemType || "Asset"),
      dealValue: calculateDealValue(rap, lowestPrice),
      dealPercent: calculateDealPercent(rap, lowestPrice),
      overpricedValue: calculateOverpricedValue(rap, lowestPrice),
      overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
    };
  });

  if (!includeResaleFallback) {
    return enriched;
  }

  return mapWithConcurrency(enriched, 10, async (item) => {
    if (item.lowestPrice && item.lowestPrice > 0) {
      return item;
    }

    const resale = await fetchResaleData(item.assetId);
    const availableCopies = firstNonNegativeNumber(resale.numberRemaining, item.availableCopies);
    const lowestPrice = clearPriceWithoutSellers(firstPositiveNumber(resale.lowestResalePrice, item.lowestPrice), availableCopies);

    return {
      ...item,
      lowestPrice,
      availableCopies,
      dealValue: calculateDealValue(item.rap, lowestPrice) ?? item.dealValue,
      dealPercent: calculateDealPercent(item.rap, lowestPrice) ?? item.dealPercent,
      overpricedValue: calculateOverpricedValue(item.rap, lowestPrice) ?? item.overpricedValue,
      overpricedPercent: calculateOverpricedPercent(item.rap, lowestPrice) ?? item.overpricedPercent,
    };
  });
}

async function addHistoryMetrics(item) {
  const resale = item.collectibleItemId
    ? await fetchCollectibleResaleData(item.collectibleItemId)
    : await fetchResaleData(item.assetId);
  const ownHistory = [
    ...(await fetchStoredSnapshots(item.assetId)),
    ...normalizeHistoryPoints(resale.priceDataPoints),
  ];
  const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
  const metrics = buildRapChangeMetrics(ownHistory, rap);
  const availableCopies = firstNonNegativeNumber(resale.numberRemaining, item.availableCopies);
  const sellerSignal = item.hasResellers ? 1 : availableCopies;
  const lowestPrice = clearPriceWithoutSellers(firstNumber(resale.lowestResalePrice, item.lowestPrice), sellerSignal);

  return {
    ...item,
    rap,
    lowestPrice,
    availableCopies,
    lossAllTime: metrics.lossAllTime,
    loss24h: metrics.loss24h,
    loss7d: metrics.loss7d,
    loss30d: metrics.loss30d,
    loss1y: metrics.loss1y,
    profitAllTime: metrics.profitAllTime,
    profit24h: metrics.profit24h,
    profit7d: metrics.profit7d,
    profit30d: metrics.profit30d,
    profit1y: metrics.profit1y,
    changeAllTime: metrics.changeAllTime,
    change24h: metrics.change24h,
    change7d: metrics.change7d,
    change30d: metrics.change30d,
    change1y: metrics.change1y,
  };
}

async function addLiveHistoryMetricsBatch(items) {
  const ownHistoryByAssetId = await fetchStoredSnapshotsForAssets(items.map((item) => item.assetId));

  return mapWithConcurrency(items, 20, async (item) => {
    const resale = item.collectibleItemId
      ? await fetchCollectibleResaleData(item.collectibleItemId)
      : item.assetId > 0
        ? await fetchResaleData(item.assetId)
        : {};
    const ownHistory = [
      ...(ownHistoryByAssetId.get(item.assetId) || []),
      ...normalizeHistoryPoints(resale.priceDataPoints),
    ];
    const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
    const metrics = buildRapChangeMetrics(ownHistory, rap);
    const availableCopies = firstNonNegativeNumber(resale.numberRemaining, item.availableCopies);
    const sellerSignal = item.hasResellers ? 1 : availableCopies;
    const lowestPrice = clearPriceWithoutSellers(firstNumber(resale.lowestResalePrice, item.lowestPrice), sellerSignal);

    return {
      ...item,
      rap,
      lowestPrice,
      availableCopies,
      lossAllTime: metrics.lossAllTime,
      loss24h: metrics.loss24h,
      loss7d: metrics.loss7d,
      loss30d: metrics.loss30d,
      loss1y: metrics.loss1y,
      profitAllTime: metrics.profitAllTime,
      profit24h: metrics.profit24h,
      profit7d: metrics.profit7d,
      profit30d: metrics.profit30d,
      profit1y: metrics.profit1y,
      changeAllTime: metrics.changeAllTime,
      change24h: metrics.change24h,
      change7d: metrics.change7d,
      change30d: metrics.change30d,
      change1y: metrics.change1y,
    };
  });
}

async function addHistoryMetricsBatch(items) {
  const ownHistoryByAssetId = await fetchStoredSnapshotsForAssets(items.map((item) => item.assetId));

  return items.map((item) => {
    const ownHistory = ownHistoryByAssetId.get(item.assetId) || [];
    const rap = firstPositiveNumber(item.rap);
    const metrics = buildRapChangeMetrics(ownHistory, rap);

    return {
      ...item,
      rap,
      lossAllTime: metrics.lossAllTime,
      loss24h: metrics.loss24h,
      loss7d: metrics.loss7d,
      loss30d: metrics.loss30d,
      loss1y: metrics.loss1y,
      profitAllTime: metrics.profitAllTime,
      profit24h: metrics.profit24h,
      profit7d: metrics.profit7d,
      profit30d: metrics.profit30d,
      profit1y: metrics.profit1y,
      changeAllTime: metrics.changeAllTime,
      change24h: metrics.change24h,
      change7d: metrics.change7d,
      change30d: metrics.change30d,
      change1y: metrics.change1y,
    };
  });
}

async function fetchRolimonsCatalogPage({
  cursor,
  limit,
  keywordTokens,
  sort,
  minPrice,
  maxPrice,
  minRap,
  maxRap,
}) {
  const offset = offsetFromCursor(cursor);
  let items = await fetchRolimonsItems();

  items = items.filter((item) => {
    if (!matchesAllKeywordTokens(item, keywordTokens)) return false;
    if (minRap !== null && (!item.rap || item.rap < minRap)) return false;
    if (maxRap !== null && (!item.rap || item.rap > maxRap)) return false;
    return true;
  });

  const metricKeyBySort = {
    loss_24h: "loss24h",
    loss_7d: "loss7d",
    loss_30d: "loss30d",
    loss_1y: "loss1y",
    loss_all: "lossAllTime",
    profit_24h: "profit24h",
    profit_7d: "profit7d",
    profit_30d: "profit30d",
    profit_1y: "profit1y",
    profit_all: "profitAllTime",
  };
  const metricKey = metricKeyBySort[sort];
  const isLossSort = String(sort).startsWith("loss_");
  const boughtRangeDays = getBoughtRangeDays(sort);

  if (sort === "rap_desc" || sort === "deal_desc" || sort === "overpriced_desc" || metricKey || boughtRangeDays) {
    items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  } else if (sort === "price_asc" || sort === "price_desc") {
    // Price sorts are handled better by Roblox catalog search, not the RAP index.
    items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  } else if (sort === "updated") {
    items.sort((a, b) => b.assetId - a.assetId);
  } else {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }

  if (sort === "price_asc" || sort === "price_desc" || sort === "deal_desc" || sort === "overpriced_desc" || boughtRangeDays || metricKey || minPrice !== null || maxPrice !== null) {
    const shouldScanAllMatches = keywordTokens.length > 0 || Boolean(metricKey) || Boolean(boughtRangeDays);
    const scanSize = shouldScanAllMatches
      || sort === "deal_desc"
      || sort === "overpriced_desc"
      ? items.length
      : Math.min(items.length, Math.max(offset + limit * 8, 240));
    const scanWindow = sort === "deal_desc" || sort === "overpriced_desc"
      ? interleaveForCoverage(items).slice(0, scanSize)
      : items.slice(0, scanSize);
    const needsLiveResalePrice = !metricKey && !boughtRangeDays && (sort === "price_asc" || sort === "price_desc" || sort === "deal_desc" || sort === "overpriced_desc");
    let enriched = metricKey
      ? scanWindow
      : boughtRangeDays
      ? scanWindow
      : needsLiveResalePrice
      ? await enrichRolimonsItemsWithCatalogDetails(scanWindow, sort !== "deal_desc" && sort !== "overpriced_desc")
      : await mapWithConcurrency(
        scanWindow,
        8,
        (item) => enrichRolimonsItem(item, false, true)
    );

    if (metricKey) {
      enriched = await addHistoryMetricsBatch(enriched);
      enriched.sort((a, b) => {
        const aValue = Number(a[metricKey]);
        const bValue = Number(b[metricKey]);

        if (Number.isFinite(aValue) && Number.isFinite(bValue) && aValue !== bValue) {
          return compareChangeMetric(a, b, metricKey, isLossSort);
        }

        return (Number(b.rap) || 0) - (Number(a.rap) || 0);
      });

      // Stored snapshots can be empty or stale. Recheck a broad candidate set
      // with the same live resale history used by the item modal before
      // filtering, otherwise metric tabs can incorrectly return 0 items.
      enriched = await addLiveHistoryMetricsBatch(interleaveForCoverage(enriched).slice(0, Math.max(limit * 12, 360)));
      enriched = enriched.filter((item) => {
        const value = Number(item[metricKey]);
        return Number.isFinite(value) && value > 0;
      });
      enriched.sort((a, b) => compareChangeMetric(a, b, metricKey, isLossSort));
    } else if (sort === "deal_desc") {
      enriched = enriched.filter((item) => hasMinimumDeal(item));
      enriched.sort(compareDealItems);
    } else if (sort === "overpriced_desc") {
      enriched = enriched.filter((item) => hasMinimumOverpriced(item));
      enriched.sort(compareOverpricedItems);
    } else if (boughtRangeDays) {
      const ownHistoryByAssetId = await fetchStoredSnapshotsForAssets(enriched.map((item) => item.assetId));
      enriched = await mapWithConcurrency(interleaveForCoverage(enriched).slice(0, Math.max(limit * 12, 360)), 20, async (item) => {
        const resale = await fetchResaleData(item.assetId);
        const ownHistory = [
          ...(ownHistoryByAssetId.get(item.assetId) || []),
          ...normalizeHistoryPoints(resale.priceDataPoints),
        ];
        const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
        const lowestPrice = clearPriceWithoutSellers(firstNumber(resale.lowestResalePrice, item.lowestPrice), resale.numberRemaining);
        const activityMetrics = calculateActivityMetrics(ownHistory, boughtRangeDays, rap, lowestPrice);

        return {
          ...item,
          rap,
          lowestPrice,
          activityCount: activityMetrics.activityCount,
          activityScore: activityMetrics.activityScore,
          averageActivePrice: activityMetrics.averageActivePrice,
          salesCount: activityMetrics.activityCount,
          averageSalePrice: activityMetrics.averageActivePrice,
          dealValue: calculateDealValue(rap, lowestPrice),
          dealPercent: calculateDealPercent(rap, lowestPrice),
          overpricedValue: calculateOverpricedValue(rap, lowestPrice),
          overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
        };
      });
      enriched = enriched.filter((item) => Number(item.activityScore) > 0);
      enriched.sort(compareBoughtItems);
    } else if (sort === "price_asc") {
      enriched = enriched.filter((item) => item.lowestPrice && item.lowestPrice > 0);
      enriched.sort((a, b) => a.lowestPrice - b.lowestPrice);
    } else if (sort === "price_desc") {
      enriched = enriched.filter((item) => item.lowestPrice && item.lowestPrice > 0);
      enriched.sort((a, b) => b.lowestPrice - a.lowestPrice);
    }

    enriched = enriched.filter((item) => {
      if (minPrice !== null && (!item.lowestPrice || item.lowestPrice < minPrice)) return false;
      if (maxPrice !== null && (!item.lowestPrice || item.lowestPrice > maxPrice)) return false;
      return true;
    });

    if (sort === "deal_desc" || sort === "overpriced_desc") {
      const visibleItems = [];
      const chunkSize = Math.max(limit * 6, 180);
      let candidateOffset = offset;

      while (candidateOffset < enriched.length && visibleItems.length < limit) {
        const chunk = enriched.slice(candidateOffset, candidateOffset + chunkSize);
        const validDeals = chunk
          .filter((item) => sort === "deal_desc" ? hasMinimumDeal(item) : hasMinimumOverpriced(item))
          .filter((item) => {
            if (minPrice !== null && (!item.lowestPrice || item.lowestPrice < minPrice)) return false;
            if (maxPrice !== null && (!item.lowestPrice || item.lowestPrice > maxPrice)) return false;
            return true;
          })
          .sort(compareDealItems);

        visibleItems.push(...validDeals);
        candidateOffset += chunk.length;
      }

      visibleItems.sort(compareDealItems);
      if (sort === "overpriced_desc") {
        visibleItems.sort(compareOverpricedItems);
      }

      return {
        items: visibleItems.slice(0, limit),
        nextPageCursor: cursorFromOffset(candidateOffset, enriched.length),
        previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - limit), enriched.length) : "",
        updatedAt: new Date().toISOString(),
      };
    }

    const pageItems = sort === "deal_desc" || sort === "overpriced_desc"
      ? enriched.slice(offset, offset + Math.max(limit * 6, 180))
      : enriched.slice(offset, offset + limit);
    let visibleItems = metricKey
      ? await enrichRolimonsItemsWithCatalogDetails(pageItems, true)
      : await mapWithConcurrency(pageItems, 8, (item) => enrichRolimonsItem(item, true));

    if (sort === "deal_desc") {
      visibleItems = visibleItems
        .filter((item) => hasMinimumDeal(item))
        .sort(compareDealItems)
        .slice(0, limit);
    } else if (sort === "overpriced_desc") {
      visibleItems = visibleItems
        .filter((item) => hasMinimumOverpriced(item))
        .sort(compareOverpricedItems)
        .slice(0, limit);
    }

    return {
      items: visibleItems,
      nextPageCursor: cursorFromOffset(offset + limit, enriched.length),
      previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - limit), enriched.length) : "",
      updatedAt: new Date().toISOString(),
    };
  }

  const pageItems = items.slice(offset, offset + limit);
  const enrichedPage = await mapWithConcurrency(pageItems, 8, (item) => enrichRolimonsItem(item, true));

  return {
    items: enrichedPage,
    nextPageCursor: cursorFromOffset(offset + limit, items.length),
    previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - limit), items.length) : "",
    updatedAt: new Date().toISOString(),
  };
}

function offsetFromCursor(cursor) {
  if (!cursor || !String(cursor).startsWith("offset:")) {
    return 0;
  }

  const offset = Number(String(cursor).slice("offset:".length));
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

function cursorFromOffset(offset, total) {
  return offset < total ? `offset:${offset}` : "";
}

function interleaveForCoverage(items, bucketCount = 12) {
  if (items.length <= bucketCount) {
    return items;
  }

  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = Math.floor((index * items.length) / bucketCount);
    const end = Math.floor(((index + 1) * items.length) / bucketCount);
    return items.slice(start, end);
  });
  const result = [];
  let row = 0;

  while (result.length < items.length) {
    let added = false;

    for (const bucket of buckets) {
      if (bucket[row]) {
        result.push(bucket[row]);
        added = true;
      }
    }

    if (!added) {
      break;
    }

    row += 1;
  }

  return result;
}

function buildItemFromCatalog(item, resale, marketType) {
  const assetId = normalizeNumber(item.id || item.assetId);
  const rawLowestPrice = firstPositiveNumber(
    item.lowestResalePrice,
    item.lowestPrice,
    item.price,
    resale.lowestResalePrice,
    item.priceStatus === "Off Sale" ? 0 : undefined
  );
  const rap = firstPositiveNumber(
    item.recentAveragePrice,
    item.rap,
    resale.recentAveragePrice
  );
  const availableCopies = firstNonNegativeNumber(
    resale.numberRemaining,
    item.unitsAvailableForConsumption
  );
  const sellerSignal = item.hasResellers ? 1 : availableCopies;
  const lowestPrice = clearPriceWithoutSellers(rawLowestPrice, sellerSignal);
  const dealValue = calculateDealValue(rap, lowestPrice);
  const dealPercent = calculateDealPercent(rap, lowestPrice);
  const overpricedValue = calculateOverpricedValue(rap, lowestPrice);
  const overpricedPercent = calculateOverpricedPercent(rap, lowestPrice);
  const totalCopies = firstPositiveNumber(
    item.totalQuantity,
    resale.assetStock
  );
  const itemType = String(item.itemType || "Asset");
  const thumbnailType = itemType === "Bundle" ? "BundleThumbnail" : "Asset";

  return {
    assetId,
    name: String(item.name || item.itemName || "Unknown Limited"),
    rap,
    lowestPrice,
    availableCopies,
    totalCopies,
    thumbnail: `rbxthumb://type=${thumbnailType}&id=${assetId}&w=420&h=420`,
    creatorName: String(item.creatorName || ""),
    itemType,
    collectibleItemId: item.collectibleItemId ? String(item.collectibleItemId) : "",
    hasResellers: Boolean(item.hasResellers),
    dealValue,
    dealPercent,
    overpricedValue,
    overpricedPercent,
    salesCount: null,
    averageSalePrice: null,
    loss24h: null,
    loss7d: null,
    loss30d: null,
    loss1y: null,
    lossAllTime: null,
    profit24h: null,
    profit7d: null,
    profit30d: null,
    profit1y: null,
    profitAllTime: null,
    change24h: null,
    change7d: null,
    change30d: null,
    change1y: null,
    changeAllTime: null,
    marketType,
  };
}

async function fetchRobloxRecentDiscoveryItems() {
  const rawByAssetId = new Map();
  const seen = new Set();

  async function addCatalogItems(catalog) {
    const rawItems = Array.isArray(catalog?.data) ? catalog.data : [];

    for (const item of rawItems) {
      const assetId = normalizeNumber(item.id || item.assetId);

      if (!assetId || seen.has(assetId)) {
        continue;
      }

      const restrictions = Array.isArray(item.itemRestrictions) ? item.itemRestrictions : [];
      const creatorName = String(item.creatorName || "");
      const isLimited = restrictions.includes("Limited") || restrictions.includes("LimitedUnique") || item.collectibleItemId;

      if (creatorName !== "Roblox" || !isLimited) {
        continue;
      }

      seen.add(assetId);
      rawByAssetId.set(assetId, item);
    }
  }

  let cursor = "";

  for (let page = 0; page < ROBLOX_RECENT_DISCOVERY_PAGES; page += 1) {
    try {
      const catalog = await fetchJson(buildCatalogUrl({
        cursor,
        limit: 30,
        keyword: "",
        marketType: "roblox",
        sort: "updated",
      }));

      await addCatalogItems(catalog);
      cursor = catalog?.nextPageCursor || "";

      if (!cursor) {
        break;
      }

      await sleep(80);
    } catch {
      break;
    }
  }

  for (const keyword of ROBLOX_RECENT_DISCOVERY_KEYWORDS) {
    try {
      const catalog = await fetchJson(buildCatalogUrl({
        cursor: "",
        limit: 30,
        keyword,
        marketType: "roblox",
        sort: "updated",
      }));
      const rawItems = Array.isArray(catalog.data) ? catalog.data : [];
      const exact = rawItems.find((item) => {
        return String(item.creatorName || "") === "Roblox"
          && String(item.name || "").toLowerCase() === keyword.toLowerCase();
      });

      if (!exact) {
        continue;
      }

      const assetId = normalizeNumber(exact.id || exact.assetId);

      if (!assetId || seen.has(assetId)) {
        continue;
      }

      seen.add(assetId);
      rawByAssetId.set(assetId, exact);
      await sleep(80);
    } catch {
      // Discovery is best-effort; the regular live catalog still loads.
    }
  }

  const rawItems = [...rawByAssetId.values()];
  const results = await mapWithConcurrency(rawItems, 8, async (rawItem) => {
    const assetId = normalizeNumber(rawItem.id || rawItem.assetId);
    const resale = rawItem.collectibleItemId
      ? await fetchCollectibleResaleData(rawItem.collectibleItemId)
      : await fetchResaleData(assetId);

    return buildItemFromCatalog(rawItem, resale, "roblox");
  });

  return results.filter((item) => item.assetId > 0 && item.rap > 0);
}

function isBuyableCollectibleItem(item) {
  return Number(item.rap) > 0 && Number(item.lowestPrice) > 0;
}

async function fetchItemDetails(assetId, marketType = "ugc", collectibleItemId = "") {
  const safeAssetId = normalizeNumber(Number(assetId));
  const safeCollectibleItemId = String(collectibleItemId || "").trim();
  const cacheKey = `${safeAssetId}:${marketType}:${safeCollectibleItemId}`;
  const cached = detailCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const resale = safeCollectibleItemId
    ? await fetchCollectibleResaleData(safeCollectibleItemId)
    : safeAssetId > 0
      ? await fetchResaleData(safeAssetId)
      : {};
  const details = safeAssetId > 0 ? await fetchEconomyDetails(safeAssetId) : {};
  const catalogDetails = marketType === "roblox" && safeAssetId > 0
    ? (await fetchCatalogDetailsBatch([safeAssetId])).get(safeAssetId) || {}
    : {};
  const marketplaceDetails = safeCollectibleItemId
    ? await fetchMarketplaceItemDetails(safeCollectibleItemId)
    : {};
  let rolimonsItem = null;

  if (marketType === "roblox" && safeAssetId > 0) {
    try {
      const rolimonsItems = await fetchRolimonsItems();
      rolimonsItem = rolimonsItems.find((item) => item.assetId === safeAssetId) || null;
    } catch {
      rolimonsItem = null;
    }
  }

  const collectibleDetails = details.CollectiblesItemDetails || {};
  const creator = details.Creator || {};
  const rawLowestPrice = firstNumber(
    marketplaceDetails.lowestPrice,
    catalogDetails.lowestResalePrice,
    catalogDetails.lowestPrice,
    collectibleDetails.CollectibleLowestResalePrice,
    details.PriceInRobux,
    resale.lowestResalePrice
  );
  const rap = firstPositiveNumber(
    rolimonsItem?.rap,
    marketplaceDetails.recentAveragePrice,
    catalogDetails.recentAveragePrice,
    details.RecentAveragePrice,
    collectibleDetails.RecentAveragePrice,
    resale.recentAveragePrice
  );

  const ownHistory = [
    ...(await fetchStoredSnapshots(safeAssetId)),
    ...normalizeHistoryPoints(resale.priceDataPoints),
  ];
  const metrics = buildRapChangeMetrics(ownHistory, rap);
  const chartHistory = metrics.history;
  const availableCopies = firstNonNegativeNumber(
    resale.numberRemaining,
    marketplaceDetails.unitsAvailableForConsumption,
    catalogDetails.unitsAvailableForConsumption
  );
  const sellerSignal = marketplaceDetails.hasResellers ? 1 : availableCopies;
  const lowestPrice = clearPriceWithoutSellers(rawLowestPrice, sellerSignal);
  const salesHistory = buildSalesHistory(resale.priceDataPoints, resale.volumeDataPoints, lowestPrice);
  const rolimonsSales = marketType === "roblox" ? await fetchRolimonsItemSales(safeAssetId) : {};
  const makeSalesActivity = (days) => {
    let sales = calculateSalesMetrics(salesHistory, days);

    if (!sales.salesCount) {
      const count = rolimonsSalesForDays(rolimonsSales, days);

      if (count) {
        sales = {
          salesCount: count,
          averageSalePrice: firstPositiveNumber(lowestPrice, rawLowestPrice),
        };
      }
    }

    return salesMetricToActivity(sales);
  };
  const activity24h = makeSalesActivity(1);
  const activity7d = makeSalesActivity(7);
  const activity30d = makeSalesActivity(30);
  const activity1y = makeSalesActivity(365);

  const data = {
    assetId: safeAssetId,
    name: String(marketplaceDetails.name || catalogDetails.name || details.Name || rolimonsItem?.name || "Unknown Limited"),
    rap,
    lowestPrice,
    availableCopies,
    totalCopies: firstPositiveNumber(marketplaceDetails.totalQuantity, catalogDetails.totalQuantity, collectibleDetails.TotalQuantity, resale.assetStock),
    creatorName: String(marketplaceDetails.creatorName || catalogDetails.creatorName || creator.Name || ""),
    thumbnail: `rbxthumb://type=Asset&id=${safeAssetId}&w=420&h=420`,
    collectibleItemId: safeCollectibleItemId,
    history: chartHistory,
    salesHistory,
    volumeHistory: normalizeHistoryPoints(resale.volumeDataPoints, "volume"),
    lossAllTime: metrics.lossAllTime,
    loss24h: metrics.loss24h,
    loss7d: metrics.loss7d,
    loss30d: metrics.loss30d,
    loss1y: metrics.loss1y,
    profitAllTime: metrics.profitAllTime,
    profit24h: metrics.profit24h,
    profit7d: metrics.profit7d,
    profit30d: metrics.profit30d,
    profit1y: metrics.profit1y,
    changeAllTime: metrics.changeAllTime,
    change24h: metrics.change24h,
    change7d: metrics.change7d,
    change30d: metrics.change30d,
    change1y: metrics.change1y,
    activity24h,
    activity7d,
    activity30d,
    activity1y,
    marketType,
  };

  detailCache.set(cacheKey, { fetchedAt: Date.now(), data });
  return data;
}

async function fetchUserCollectibles(userId) {
  const safeUserId = Math.floor(Number(userId) || 0);

  if (safeUserId <= 0) {
    throw new Error("Invalid Roblox user id.");
  }

  const owned = [];
  let cursor = "";
  let guard = 0;

  while (guard < 20) {
    guard += 1;
    const url = new URL(`${ROBLOX_INVENTORY_URL}/${safeUserId}/assets/collectibles`);
    url.searchParams.set("assetType", "All");
    url.searchParams.set("sortOrder", "Asc");
    url.searchParams.set("limit", "100");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const page = await fetchJson(url, {
      retries: 1,
      timeoutMs: 7000,
    });

    for (const raw of Array.isArray(page?.data) ? page.data : []) {
      const assetId = normalizeNumber(Number(raw.assetId || raw.id));

      if (assetId <= 0) {
        continue;
      }

      owned.push({
        assetId,
        name: String(raw.name || raw.assetName || "Unknown Limited"),
        rap: firstPositiveNumber(
          Number(raw.recentAveragePrice),
          Number(raw.recentAveragePriceRounded)
        ),
        lowestPrice: firstPositiveNumber(
          Number(raw.lowestResalePrice),
          Number(raw.price)
        ),
        thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
        itemType: "Asset",
      });
    }

    cursor = String(page?.nextPageCursor || "");

    if (!cursor) {
      break;
    }
  }

  return owned;
}

function baselineValueForHistory(history, days) {
  const baseline = findHistoryBaselineValue(history, days);
  return Number(baseline) > 0 ? Number(baseline) : null;
}

function buildPortfolioChart(items, marketType, days) {
  const filtered = items.filter((item) => item.marketType === marketType);
  const startTime = days ? getPeriodStartTime(days) : 0;
  const nowTime = Date.now();
  const timelines = [];
  const timeKeys = new Set();

  for (const item of filtered) {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const history = (Array.isArray(item.history) ? item.history : [])
      .map((point) => ({
        value: Number(point.value),
        time: Date.parse(point.date || ""),
      }))
      .filter((point) => Number.isFinite(point.value) && point.value > 0 && Number.isFinite(point.time))
      .sort((a, b) => a.time - b.time);
    const currentRap = Number(item.rap) || 0;

    if (currentRap > 0) {
      history.push({ value: currentRap, time: nowTime });
    }

    if (history.length === 0) {
      continue;
    }

    const timeline = {
      quantity,
      points: history,
    };

    timelines.push(timeline);

    const visibleStart = startTime || history[0].time;
    timeKeys.add(visibleStart);

    for (const point of history) {
      if ((!startTime || point.time >= startTime) && point.time <= nowTime) {
        timeKeys.add(point.time);
      }
    }
  }

  if (timelines.length === 0) {
    return [];
  }

  timeKeys.add(nowTime);

  const times = [...timeKeys]
    .filter((time) => Number.isFinite(time) && (!startTime || time >= startTime) && time <= nowTime)
    .sort((a, b) => a - b)
    .slice(-500);

  return times.map((time) => {
    let value = 0;

    for (const timeline of timelines) {
      let latest = null;

      for (const point of timeline.points) {
        if (point.time <= time) {
          latest = point.value;
        } else {
          break;
        }
      }

      if (latest === null) {
        latest = timeline.points[0].value;
      }

      value += latest * timeline.quantity;
    }

    return {
      date: new Date(time).toISOString(),
      value: Math.round(value),
    };
  }).filter((point) => point.value > 0);
}

function calculatePortfolioStats(items, marketType, days) {
  const filtered = items.filter((item) => item.marketType === marketType);
  let currentValue = 0;
  let baselineValue = 0;
  let baselineCount = 0;
  let bestGain = null;
  let worstLoss = null;

  for (const item of filtered) {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const rap = Number(item.rap) || 0;
    const baseline = baselineValueForHistory(item.history, days);
    const change = percentChange(baseline, rap);

    currentValue += rap * quantity;

    if (baseline) {
      baselineValue += baseline * quantity;
      baselineCount += 1;
    }

    if (typeof change === "number" && Number.isFinite(change)) {
      const scored = {
        assetId: item.assetId,
        name: item.name,
        change,
        rap,
        thumbnail: item.thumbnail,
      };

      if (bestGain === null || change > bestGain.change) {
        bestGain = scored;
      }

      if (worstLoss === null || change < worstLoss.change) {
        worstLoss = scored;
      }
    }
  }

  return {
    count: filtered.length,
    value: Math.round(currentValue),
    baselineValue: baselineCount > 0 ? Math.round(baselineValue) : null,
    change: baselineCount > 0 ? percentChange(baselineValue, currentValue) : null,
    bestGain,
    worstLoss,
  };
}

async function fetchPortfolio(userId) {
  const safeUserId = Math.floor(Number(userId) || 0);
  const cached = portfolioCache.get(safeUserId);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const [inventory, rolimonsItems] = await Promise.all([
    fetchUserCollectibles(safeUserId),
    fetchRolimonsItems().catch(() => []),
  ]);
  const rolimonsById = new Map(rolimonsItems.map((item) => [item.assetId, item]));
  const quantityByAssetId = new Map();

  for (const item of inventory) {
    const current = quantityByAssetId.get(item.assetId);

    if (current) {
      current.quantity += 1;
      current.rap = firstPositiveNumber(current.rap, item.rap);
      current.lowestPrice = firstPositiveNumber(current.lowestPrice, item.lowestPrice);
    } else {
      quantityByAssetId.set(item.assetId, { ...item, quantity: 1 });
    }
  }

  const assetIds = [...quantityByAssetId.keys()];
  const storedHistoryById = await fetchStoredSnapshotsForAssets(assetIds);
  const items = [];

  for (const item of quantityByAssetId.values()) {
    const rolimonsItem = rolimonsById.get(item.assetId);
    const marketType = rolimonsItem ? "roblox" : "ugc";
    const rap = firstPositiveNumber(
      rolimonsItem?.rap,
      item.rap
    );
    const history = buildRawComparableRapHistory(
      storedHistoryById.get(item.assetId) || [],
      rap
    );
    const metrics = buildRapChangeMetrics(history, rap);

    items.push({
      assetId: item.assetId,
      name: rolimonsItem?.name || item.name,
      marketType,
      quantity: item.quantity,
      rap,
      lowestPrice: item.lowestPrice || rolimonsItem?.lowestPrice || null,
      thumbnail: item.thumbnail,
      history: metrics.history,
      change24h: metrics.change24h,
      change7d: metrics.change7d,
      change30d: metrics.change30d,
      change6m: percentChange(baselineValueForHistory(history, 180), rap),
      change1y: metrics.change1y,
      changeAll: metrics.changeAllTime,
    });
  }

  const ranges = {
    "24h": 1,
    "7d": 7,
    "30d": 30,
    "6m": 180,
    "1y": 365,
    max: null,
  };
  const stats = {};
  const charts = {};

  for (const [range, days] of Object.entries(ranges)) {
    stats[range] = {
      ugc: calculatePortfolioStats(items, "ugc", days),
      roblox: calculatePortfolioStats(items, "roblox", days),
    };
    charts[range] = {
      ugc: buildPortfolioChart(items, "ugc", days),
      roblox: buildPortfolioChart(items, "roblox", days),
    };
  }

  const data = {
    ok: true,
    userId: safeUserId,
    items: items.sort((a, b) => (Number(b.rap) || 0) - (Number(a.rap) || 0)).slice(0, 120),
    stats,
    charts,
    updatedAt: new Date().toISOString(),
  };

  portfolioCache.set(safeUserId, { fetchedAt: Date.now(), data });
  return data;
}

function filterIndexedItems(items, { keywordTokens, minPrice, maxPrice, minRap, maxRap }) {
  return items.filter((item) => {
    if (!matchesAllKeywordTokens(item, keywordTokens)) return false;
    if (minPrice !== null && (!item.lowestPrice || item.lowestPrice < minPrice)) return false;
    if (maxPrice !== null && (!item.lowestPrice || item.lowestPrice > maxPrice)) return false;
    if (minRap !== null && (!item.rap || item.rap < minRap)) return false;
    if (maxRap !== null && (!item.rap || item.rap > maxRap)) return false;
    return true;
  });
}

async function buildRobloxMarketIndex() {
  const [rolimonsItems, snapshotItems, discoveryItems] = await Promise.all([
    fetchRolimonsItems().catch(() => []),
    fetchLatestItemSnapshotItems(),
    fetchRobloxRecentDiscoveryItems().catch(() => []),
  ]);
  const baseItems = mergeMarketItems([...snapshotItems, ...discoveryItems], rolimonsItems);
  const needsPricing = baseItems.filter((item) => !item.lowestPrice || item.lowestPrice <= 0);
  const alreadyPriced = baseItems.filter((item) => item.lowestPrice && item.lowestPrice > 0);
  let pricedItems = alreadyPriced;

  if (needsPricing.length > 0) {
    try {
      pricedItems = pricedItems.concat(await enrichRolimonsItemsWithCatalogDetails(needsPricing, false));
    } catch (error) {
      console.warn(`Roblox market live enrichment skipped: ${error.message}`);
      pricedItems = pricedItems.concat(needsPricing);
    }
  }

  return mergeMarketItems([], pricedItems)
    .map((item) => ({
      ...item,
      marketType: "roblox",
      thumbnail: item.thumbnail || `rbxthumb://type=Asset&id=${item.assetId}&w=420&h=420`,
      dealValue: calculateDealValue(item.rap, item.lowestPrice),
      dealPercent: calculateDealPercent(item.rap, item.lowestPrice),
      overpricedValue: calculateOverpricedValue(item.rap, item.lowestPrice),
      overpricedPercent: calculateOverpricedPercent(item.rap, item.lowestPrice),
    }))
    .filter((item) => item.assetId > 0 && item.rap > 0);
}

async function getRobloxMarketIndex() {
  const cacheKey = "roblox";
  const cached = marketIndexCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.items;
  }

  if (marketIndexBuilds.has(cacheKey)) {
    return marketIndexBuilds.get(cacheKey);
  }

  const buildPromise = buildRobloxMarketIndex()
    .then((items) => {
      marketIndexCache.set(cacheKey, { fetchedAt: Date.now(), items });
      return items;
    })
    .finally(() => {
      marketIndexBuilds.delete(cacheKey);
    });

  marketIndexBuilds.set(cacheKey, buildPromise);
  return buildPromise;
}

function sortIndexedItems(items, sort) {
  const sorted = items.slice();

  if (sort === "price_asc") {
    return sorted.filter((item) => item.lowestPrice > 0).sort((a, b) => a.lowestPrice - b.lowestPrice);
  }

  if (sort === "price_desc") {
    return sorted.filter((item) => item.lowestPrice > 0).sort((a, b) => b.lowestPrice - a.lowestPrice);
  }

  if (sort === "rap_desc") {
    return sorted.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  }

  if (sort === "deal_desc") {
    return sorted.filter((item) => hasMinimumDeal(item)).sort(compareDealItems);
  }

  if (sort === "overpriced_desc") {
    return sorted.filter((item) => hasMinimumOverpriced(item)).sort(compareOverpricedItems);
  }

  if (sort === "updated") {
    return sorted.sort((a, b) => b.assetId - a.assetId);
  }

  return sorted.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchFastRobloxIndexPage({
  cursor = "",
  limit = 30,
  keywordTokens = [],
  sort = "updated",
  minPrice = null,
  maxPrice = null,
  minRap = null,
  maxRap = null,
}) {
  const offset = offsetFromCursor(cursor);
  const metricKeyBySort = {
    loss_24h: "loss24h",
    loss_7d: "loss7d",
    loss_30d: "loss30d",
    loss_1y: "loss1y",
    loss_all: "lossAllTime",
    profit_24h: "profit24h",
    profit_7d: "profit7d",
    profit_30d: "profit30d",
    profit_1y: "profit1y",
    profit_all: "profitAllTime",
  };
  const metricKey = metricKeyBySort[sort];
  const boughtRangeDays = getBoughtRangeDays(sort);

  if (boughtRangeDays) {
    let activeItems = await getRobloxMarketIndex();
    activeItems = activeItems.filter((item) => {
      if (!matchesAllKeywordTokens(item, keywordTokens)) return false;
      if (minRap !== null && (!item.rap || item.rap < minRap)) return false;
      if (maxRap !== null && (!item.rap || item.rap > maxRap)) return false;
      return true;
    });
    activeItems = await addResaleActivityMetrics(activeItems, boughtRangeDays);
    activeItems = activeItems.filter((item) => {
      if (minPrice !== null && (!item.lowestPrice || item.lowestPrice < minPrice)) return false;
      if (maxPrice !== null && (!item.lowestPrice || item.lowestPrice > maxPrice)) return false;
      return true;
    });

    return {
      items: activeItems.slice(offset, offset + limit),
      nextPageCursor: cursorFromOffset(offset + limit, activeItems.length),
      previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - limit), activeItems.length) : "",
      updatedAt: new Date().toISOString(),
    };
  }

  let items = await getRobloxMarketIndex();
  items = filterIndexedItems(items, { keywordTokens, minPrice, maxPrice, minRap, maxRap });

  if (metricKey) {
    items = await addHistoryMetricsBatch(items);
    // Stored snapshots may be sparse for profit/loss sorts; re-check a broad
    // candidate set with live resale history (same approach as Rolimon path).
    const candidatePool = interleaveForCoverage(items).slice(0, Math.max(limit * 12, 360));
    items = await addLiveHistoryMetricsBatch(candidatePool);
    items = items
      .filter((item) => Number(item[metricKey]) > 0)
      .sort((a, b) => compareChangeMetric(a, b, metricKey, String(sort).startsWith("loss_")));
  } else {
    items = sortIndexedItems(items, sort);
  }

  return {
    items: items.slice(offset, offset + limit),
    nextPageCursor: cursorFromOffset(offset + limit, items.length),
    previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - limit), items.length) : "",
    updatedAt: new Date().toISOString(),
  };
}

async function fetchCatalogPage({
  cursor = "",
  limit = 30,
  keyword = "",
  marketType = "ugc",
  sort = "updated",
  minPrice = null,
  maxPrice = null,
  minRap = null,
  maxRap = null,
  prefetchNext = true,
}) {
  const safeLimit = normalizeLimit(limit);
  const safeKeyword = String(keyword || "").slice(0, 80);
  const keywordTokens = tokenizeKeyword(safeKeyword);
  const catalogKeyword = chooseCatalogKeyword(keywordTokens, safeKeyword);
  const safeMarketType = marketType === "roblox" ? "roblox" : "ugc";
  const safeSort = [
    "price_asc",
    "price_desc",
    "rap_desc",
    "deal_desc",
    "overpriced_desc",
    "bought_24h",
    "bought_7d",
    "bought_30d",
    "bought_1y",
    "loss_24h",
    "loss_7d",
    "loss_30d",
    "loss_1y",
    "loss_all",
    "profit_24h",
    "profit_7d",
    "profit_30d",
    "profit_1y",
    "profit_all",
    "updated",
  ].includes(sort) ? sort : "updated";
  const safeMinPrice = parseOptionalNumber(minPrice);
  const safeMaxPrice = parseOptionalNumber(maxPrice);
  const safeMinRap = parseOptionalNumber(minRap);
  const safeMaxRap = parseOptionalNumber(maxRap);
  const cacheKey = makePageCacheKey({
    marketType: safeMarketType,
    sort: safeSort,
    keyword: safeKeyword,
    cursor,
    limit: safeLimit,
    minPrice: safeMinPrice,
    maxPrice: safeMaxPrice,
    minRap: safeMinRap,
    maxRap: safeMaxRap,
  });
  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    if (prefetchNext && cached.data?.nextPageCursor) {
      prefetchCatalogPage({
        cursor: cached.data.nextPageCursor,
        limit: safeLimit,
        keyword: safeKeyword,
        marketType: safeMarketType,
        sort: safeSort,
        minPrice: safeMinPrice,
        maxPrice: safeMaxPrice,
        minRap: safeMinRap,
        maxRap: safeMaxRap,
      });
    }
    return cached.data;
  }

  let nextPageCursor = cursor;
  let previousPageCursor = "";
  let collectedItems = [];

  const isMetricSort = [
    "rap_desc",
    "deal_desc",
    "overpriced_desc",
    "bought_24h",
    "bought_7d",
    "bought_30d",
    "bought_1y",
    "loss_24h",
    "loss_7d",
    "loss_30d",
    "loss_1y",
    "loss_all",
    "profit_24h",
    "profit_7d",
    "profit_30d",
    "profit_1y",
    "profit_all",
  ].includes(safeSort);
  const needsMetricScan = isMetricSort
    || safeMinRap !== null
    || safeMaxRap !== null;
  const hasRangeFilter = safeMinPrice !== null
    || safeMaxPrice !== null
    || safeMinRap !== null
    || safeMaxRap !== null;
  const isChangeSort = safeSort.startsWith("loss_") || safeSort.startsWith("profit_");
  const isBoughtSort = safeSort.startsWith("bought_");
  const isRobloxPriceSort = safeMarketType === "roblox"
    && (safeSort === "price_asc" || safeSort === "price_desc");
  const isRobloxDealSort = safeMarketType === "roblox" && (safeSort === "deal_desc" || safeSort === "overpriced_desc");
  const isRobloxRecent = safeMarketType === "roblox" && safeSort === "updated";
  const shouldScanFullWindow = needsMetricScan || hasRangeFilter || keywordTokens.length > 0 || safeMarketType === "ugc" || isRobloxRecent;
  const isUgcHeavyScan = safeMarketType === "ugc" && (
    isChangeSort
    || isBoughtSort
    || safeSort === "deal_desc"
    || safeSort === "overpriced_desc"
    || hasRangeFilter
  );
  const maxPages = isRobloxPriceSort || isRobloxDealSort
    ? 40
    : safeMarketType === "ugc" ? (isUgcHeavyScan ? 8 : 3) : keywordTokens.length > 0 ? 4 : needsMetricScan || hasRangeFilter ? 5 : 2;
  const targetCandidateCount = isUgcHeavyScan
    ? safeLimit * 5
    : isRobloxRecent
      ? safeLimit * 2
      : safeLimit;

  const shouldUseClassicIndex = safeMarketType === "roblox"
    && (
      keywordTokens.length > 0
      || safeSort === "updated"
      || safeSort === "price_asc"
      || safeSort === "price_desc"
      || safeSort === "rap_desc"
      || safeSort === "deal_desc"
      || safeSort === "overpriced_desc"
      || safeSort.startsWith("bought_")
      || safeSort.startsWith("loss_")
      || safeSort.startsWith("profit_")
    );

  if (shouldUseClassicIndex) {
    let data;

    try {
      data = await fetchFastRobloxIndexPage({
        cursor,
        limit: safeLimit,
        keywordTokens,
        sort: safeSort,
        minPrice: safeMinPrice,
        maxPrice: safeMaxPrice,
        minRap: safeMinRap,
        maxRap: safeMaxRap,
      });
    } catch {
      data = await fetchRolimonsCatalogPage({
        cursor,
        limit: safeLimit,
        keywordTokens,
        sort: safeSort,
        minPrice: safeMinPrice,
        maxPrice: safeMaxPrice,
        minRap: safeMinRap,
        maxRap: safeMaxRap,
      });
    }

    pageCache.set(cacheKey, { fetchedAt: Date.now(), data });
    if (prefetchNext && data.nextPageCursor) {
      prefetchCatalogPage({
        cursor: data.nextPageCursor,
        limit: safeLimit,
        keyword: safeKeyword,
        marketType: safeMarketType,
        sort: safeSort,
        minPrice: safeMinPrice,
        maxPrice: safeMaxPrice,
        minRap: safeMinRap,
        maxRap: safeMaxRap,
      });
    }
    return data;
  }

  let classicItemByAssetId = null;

  if (safeMarketType === "roblox") {
    try {
      const rolimonsItems = await fetchRolimonsItems();
      classicItemByAssetId = new Map(rolimonsItems.map((item) => [item.assetId, item]));
    } catch {
      classicItemByAssetId = null;
    }
  }

  try {
    for (let page = 0; page < maxPages && (shouldScanFullWindow ? collectedItems.length < targetCandidateCount : collectedItems.length < safeLimit); page += 1) {
      const catalog = await fetchJson(buildCatalogUrl({
        cursor: page === 0 ? cursor : nextPageCursor,
        limit: safeLimit,
        keyword: catalogKeyword,
        marketType: safeMarketType,
        sort: safeSort,
      }));

      const rawItems = Array.isArray(catalog.data) ? catalog.data : [];

      if (!previousPageCursor) {
        previousPageCursor = catalog.previousPageCursor || "";
      }

      nextPageCursor = catalog.nextPageCursor || "";

      const matchingItems = rawItems.filter((item) => {
          if (!matchesAllKeywordTokens(item, keywordTokens)) {
            return false;
          }

          if (safeMarketType === "ugc") {
            return item.creatorTargetId !== 1 || item.creatorName !== "Roblox";
          }

          const assetId = normalizeNumber(item.id || item.assetId);

          if (classicItemByAssetId && safeSort !== "updated") {
            return classicItemByAssetId.has(assetId);
          }

          return item.creatorTargetId === 1 && item.creatorName === "Roblox";
      });
      const marketplaceDetailsById = safeMarketType === "ugc"
        ? await fetchMarketplaceItemDetailsBatch(matchingItems.map((item) => item.collectibleItemId).filter(Boolean))
        : new Map();

      const pageItems = (await mapWithConcurrency(matchingItems, safeMarketType === "ugc" ? 20 : 8, async (item) => {
        const assetId = normalizeNumber(item.id || item.assetId);
        const marketplaceDetails = item.collectibleItemId
          ? marketplaceDetailsById.get(String(item.collectibleItemId)) || {}
          : {};
        const mergedItem = { ...item, ...marketplaceDetails };
        const shouldFetchResaleData = assetId > 0 && (
          safeMarketType === "roblox" || Boolean(item.collectibleItemId)
        );
        const resale = shouldFetchResaleData
          ? item.collectibleItemId && assetId > 10_000_000_000
            ? await fetchCollectibleResaleData(item.collectibleItemId)
            : await fetchResaleData(assetId)
          : {};
        const builtItem = buildItemFromCatalog(mergedItem, resale, safeMarketType);
        const classicItem = classicItemByAssetId?.get(assetId);

        if (classicItem) {
          builtItem.rap = builtItem.rap || classicItem.rap;
          builtItem.name = builtItem.name || classicItem.name;
        }

        if (safeMarketType !== "ugc" || isBuyableCollectibleItem(builtItem)) {
          return builtItem;
        }

        return null;
      })).filter(Boolean);

      collectedItems = collectedItems.concat(
        pageItems.filter((item) => item.assetId > 0)
      );

      if (!nextPageCursor) {
        break;
      }
    }
  } catch (error) {
    if (safeMarketType === "roblox") {
      const data = await fetchRolimonsCatalogPage({
        cursor,
        limit: safeLimit,
        keywordTokens,
        sort: safeSort,
        minPrice: safeMinPrice,
        maxPrice: safeMaxPrice,
        minRap: safeMinRap,
        maxRap: safeMaxRap,
      });

      pageCache.set(cacheKey, { fetchedAt: Date.now(), data });
      return data;
    }

    throw error;
  }

  if (isChangeSort) {
    collectedItems = await addLiveHistoryMetricsBatch(collectedItems);
  }

  if (isBoughtSort) {
    const boughtRangeDays = getBoughtRangeDays(safeSort);
    const ownHistoryByAssetId = await fetchStoredSnapshotsForAssets(collectedItems.map((item) => item.assetId));

    collectedItems = await mapWithConcurrency(collectedItems, 20, async (item) => {
      const resale = item.collectibleItemId && (safeMarketType === "ugc" || item.assetId > 10_000_000_000)
        ? await fetchCollectibleResaleData(item.collectibleItemId)
        : await fetchResaleData(item.assetId);
      const ownHistory = [
        ...(ownHistoryByAssetId.get(item.assetId) || []),
        ...normalizeHistoryPoints(resale.priceDataPoints),
      ];
      const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
      const lowestPrice = clearPriceWithoutSellers(firstNumber(resale.lowestResalePrice, item.lowestPrice), resale.numberRemaining);
      const activityMetrics = calculateActivityMetrics(ownHistory, boughtRangeDays, rap, lowestPrice);

      return {
        ...item,
        rap,
        lowestPrice,
        activityCount: activityMetrics.activityCount,
        activityScore: activityMetrics.activityScore,
        averageActivePrice: activityMetrics.averageActivePrice,
        salesCount: activityMetrics.activityCount,
        averageSalePrice: activityMetrics.averageActivePrice,
        dealValue: calculateDealValue(rap, lowestPrice),
        dealPercent: calculateDealPercent(rap, lowestPrice),
        overpricedValue: calculateOverpricedValue(rap, lowestPrice),
        overpricedPercent: calculateOverpricedPercent(rap, lowestPrice),
      };
    });
  }

  collectedItems = collectedItems.filter((item) => {
    if (safeMarketType === "ugc" && !isBuyableCollectibleItem(item)) return false;
    if (safeMinPrice !== null && (!item.lowestPrice || item.lowestPrice < safeMinPrice)) return false;
    if (safeMaxPrice !== null && (!item.lowestPrice || item.lowestPrice > safeMaxPrice)) return false;
    if (safeMinRap !== null && (!item.rap || item.rap < safeMinRap)) return false;
    if (safeMaxRap !== null && (!item.rap || item.rap > safeMaxRap)) return false;
    return true;
  });

  if (safeSort === "price_asc") {
    collectedItems = collectedItems.filter((item) => item.lowestPrice && item.lowestPrice > 0);
    collectedItems.sort((a, b) => a.lowestPrice - b.lowestPrice);
  } else if (safeSort === "price_desc") {
    collectedItems = collectedItems.filter((item) => item.lowestPrice && item.lowestPrice > 0);
    collectedItems.sort((a, b) => b.lowestPrice - a.lowestPrice);
  } else if (safeSort === "rap_desc") {
    collectedItems = collectedItems.filter((item) => item.rap && item.rap > 0);
    collectedItems.sort((a, b) => b.rap - a.rap);
  } else if (safeSort === "deal_desc") {
    collectedItems = collectedItems.filter((item) => hasMinimumDeal(item));
    collectedItems.sort(compareDealItems);
  } else if (safeSort === "overpriced_desc") {
    collectedItems = collectedItems.filter((item) => hasMinimumOverpriced(item));
    collectedItems.sort(compareOverpricedItems);
  } else if (isBoughtSort) {
    collectedItems = collectedItems.filter((item) => Number(item.salesCount) > 0);
    collectedItems.sort(compareBoughtItems);
  } else {
    const metricKeyBySort = {
      loss_24h: "loss24h",
      loss_7d: "loss7d",
      loss_30d: "loss30d",
      loss_1y: "loss1y",
      loss_all: "lossAllTime",
      profit_24h: "profit24h",
      profit_7d: "profit7d",
      profit_30d: "profit30d",
      profit_1y: "profit1y",
      profit_all: "profitAllTime",
    };
    const metricKey = metricKeyBySort[safeSort];
    const isLossSort = String(safeSort).startsWith("loss_");

    if (metricKey) {
      collectedItems = collectedItems.filter((item) => {
        const value = Number(item[metricKey]);
        return Number.isFinite(value) && value > 0;
      });
      collectedItems.sort((a, b) => compareChangeMetric(a, b, metricKey, isLossSort));
    }
  }

  if (isRobloxRecent && collectedItems.length > safeLimit) {
    collectedItems = interleaveForCoverage(collectedItems, 2);
  }

  if (isRobloxRecent && !safeKeyword) {
    const discoveryItems = await fetchRobloxRecentDiscoveryItems();
    const seenAssetIds = new Set();
    collectedItems = [...discoveryItems, ...collectedItems].filter((item) => {
      if (!item.assetId || seenAssetIds.has(item.assetId)) {
        return false;
      }

      seenAssetIds.add(item.assetId);
      return true;
    });
  }

  if (collectedItems.length === 0 && hasRangeFilter && !isMetricSort && safeSort !== "updated" && safeSort !== "price_desc") {
    return fetchCatalogPage({
      cursor,
      limit,
      keyword,
      marketType,
      sort: "price_desc",
      minPrice,
      maxPrice,
      minRap,
      maxRap,
    });
  }

  if (collectedItems.length === 0 && safeMarketType === "roblox") {
    const data = await fetchRolimonsCatalogPage({
      cursor,
      limit: safeLimit,
      keywordTokens,
      sort: safeSort,
      minPrice: safeMinPrice,
      maxPrice: safeMaxPrice,
      minRap: safeMinRap,
      maxRap: safeMaxRap,
    });

    pageCache.set(cacheKey, { fetchedAt: Date.now(), data });
    return data;
  }

  const data = {
    items: collectedItems.slice(0, safeLimit),
    nextPageCursor,
    previousPageCursor,
    updatedAt: new Date().toISOString(),
  };

  pageCache.set(cacheKey, { fetchedAt: Date.now(), data });
  if (prefetchNext && data.nextPageCursor) {
    prefetchCatalogPage({
      cursor: data.nextPageCursor,
      limit: safeLimit,
      keyword: safeKeyword,
      marketType: safeMarketType,
      sort: safeSort,
      minPrice: safeMinPrice,
      maxPrice: safeMaxPrice,
      minRap: safeMinRap,
      maxRap: safeMaxRap,
    });
  }
  return data;
}

function prefetchCatalogPage(params) {
  const safeLimit = normalizeLimit(params.limit);
  const safeKeyword = String(params.keyword || "").slice(0, 80);
  const safeMarketType = params.marketType === "roblox" ? "roblox" : "ugc";
  const safeSort = String(params.sort || "updated");
  const safeMinPrice = parseOptionalNumber(params.minPrice);
  const safeMaxPrice = parseOptionalNumber(params.maxPrice);
  const safeMinRap = parseOptionalNumber(params.minRap);
  const safeMaxRap = parseOptionalNumber(params.maxRap);
  const cacheKey = makePageCacheKey({
    marketType: safeMarketType,
    sort: safeSort,
    keyword: safeKeyword,
    cursor: params.cursor || "",
    limit: safeLimit,
    minPrice: safeMinPrice,
    maxPrice: safeMaxPrice,
    minRap: safeMinRap,
    maxRap: safeMaxRap,
  });

  if (!params.cursor || pagePrefetches.has(cacheKey)) {
    return;
  }

  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return;
  }

  pagePrefetches.add(cacheKey);

  fetchCatalogPage({
    ...params,
    limit: safeLimit,
    prefetchNext: false,
  })
    .catch(() => {})
    .finally(() => {
      pagePrefetches.delete(cacheKey);
    });
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  maybeRunSnapshotInBackground();

  const debugPaths = new Set(["/api/debug", "/api/debug/", "/debug", "/debug/"]);

  if (url.pathname === "/health" || url.pathname === "/health/" || debugPaths.has(url.pathname)) {
    const includeCounts = debugPaths.has(url.pathname) || url.searchParams.get("debug") === "1";
    let counts = undefined;

    if (includeCounts) {
      const [rolimonsItems, snapshotItems, marketItems] = await Promise.all([
        fetchRolimonsItems().catch(() => []),
        fetchLatestItemSnapshotItems().catch(() => []),
        getRobloxMarketIndex().catch(() => []),
      ]);

      counts = {
        rolimonsItems: rolimonsItems.length,
        itemSnapshots: snapshotItems.length,
        mergedMarketItems: marketItems.length,
      };
    }

    sendJson(res, 200, {
      ok: true,
      version: SERVER_VERSION,
      counts,
      snapshots: {
        enabled: snapshotStorageEnabled(),
        running: snapshotRunning,
        lastRunAt: lastSnapshotRunAt ? new Date(lastSnapshotRunAt).toISOString() : "",
        lastAttemptAt: lastSnapshotAttemptAt ? new Date(lastSnapshotAttemptAt).toISOString() : "",
        storedIn: snapshotStorageEnabled() ? "supabase" : "memory",
      },
    });
    return;
  }

  if (url.pathname === "/api/snapshot") {
    if (SNAPSHOT_SECRET && url.searchParams.get("secret") !== SNAPSHOT_SECRET) {
      sendJson(res, 403, { error: "Bad snapshot secret." });
      return;
    }

    try {
      const data = await runSnapshotJob();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 500, {
        error: "Could not save limited snapshots.",
        detail: error.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/limiteds") {
    try {
      const data = await fetchCatalogPage({
        cursor: url.searchParams.get("cursor") || "",
        limit: url.searchParams.get("limit") || "30",
        keyword: url.searchParams.get("keyword") || "",
        marketType: url.searchParams.get("type") || "ugc",
        sort: url.searchParams.get("sort") || "updated",
        minPrice: url.searchParams.get("minPrice"),
        maxPrice: url.searchParams.get("maxPrice"),
        minRap: url.searchParams.get("minRap"),
        maxRap: url.searchParams.get("maxRap"),
      });

      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: "Could not load Roblox limiteds right now.",
        detail: error.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/item") {
    try {
      const data = await fetchItemDetails(
        url.searchParams.get("assetId") || "0",
        url.searchParams.get("type") || "ugc",
        url.searchParams.get("collectibleItemId") || ""
      );

      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: "Could not load item details right now.",
        detail: error.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/portfolio") {
    try {
      const data = await fetchPortfolio(url.searchParams.get("userId") || "0");
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: "Could not load portfolio right now. Make sure the player's inventory is public.",
        detail: error.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/export") {
    const exportType = url.searchParams.get("type") || "portfolio";
    const userId = url.searchParams.get("userId") || "0";

    try {
      let text = "";

      if (exportType === "portfolio") {
        const data = await fetchPortfolio(userId);
        const lines = [];
        lines.push(`Portfolio Export — User ${userId}`);
        lines.push(`Updated: ${data.updatedAt || "unknown"}`);
        lines.push("");
        lines.push("--- Roblox Limiteds ---");
        lines.push("Name,RAP,Price,Qty,Change 24h,Change 7d,Change 30d,Change 1y,Change All");
        for (const item of (data.items || [])) {
          if (item.marketType !== "roblox") continue;
          lines.push([
            `"${(item.name || "").replace(/"/g, '""')}"`,
            item.rap ?? "",
            item.lowestPrice ?? "",
            item.quantity ?? 1,
            item.change24h != null ? item.change24h.toFixed(1) + "%" : "",
            item.change7d != null ? item.change7d.toFixed(1) + "%" : "",
            item.change30d != null ? item.change30d.toFixed(1) + "%" : "",
            item.change1y != null ? item.change1y.toFixed(1) + "%" : "",
            item.changeAll != null ? item.changeAll.toFixed(1) + "%" : "",
          ].join(","));
        }
        lines.push("");
        lines.push("--- Limited UGC ---");
        lines.push("Name,RAP,Price,Qty,Change 24h,Change 7d,Change 30d,Change 1y,Change All");
        for (const item of (data.items || [])) {
          if (item.marketType !== "ugc") continue;
          lines.push([
            `"${(item.name || "").replace(/"/g, '""')}"`,
            item.rap ?? "",
            item.lowestPrice ?? "",
            item.quantity ?? 1,
            item.change24h != null ? item.change24h.toFixed(1) + "%" : "",
            item.change7d != null ? item.change7d.toFixed(1) + "%" : "",
            item.change30d != null ? item.change30d.toFixed(1) + "%" : "",
            item.change1y != null ? item.change1y.toFixed(1) + "%" : "",
            item.changeAll != null ? item.changeAll.toFixed(1) + "%" : "",
          ].join(","));
        }
        text = lines.join("\r\n");
      }

      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportType}-export.csv"`,
      });
      res.end(text);
    } catch (error) {
      sendJson(res, 502, {
        error: "Could not export data.",
        detail: error.message,
      });
    }

    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const { createServer } = await import("node:http");

createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: "Server error", detail: error.message });
  });
}).listen(PORT, () => {
  console.log(`Limiteds Live server ${SERVER_VERSION} running on http://localhost:${PORT}`);
  getRobloxMarketIndex()
    .then((items) => {
      console.log(`Roblox market index warmed with ${items.length} priced limiteds.`);
    })
    .catch((error) => {
      console.warn(`Roblox market index warmup failed: ${error.message}`);
    });
});
