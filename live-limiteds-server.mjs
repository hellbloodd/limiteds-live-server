// live-limiteds-server.mjs
// Roblox Limiteds Live backend with live RAP + improved profit/loss.
// Run with: node live-limiteds-server.mjs

const { createServer } = await import("node:http");

const PORT = Number(process.env.PORT || 8787);

const SERVER_VERSION = "live-rap-complete-2026-06-10";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
const ROLIMONS_CACHE_TTL_MS = Number(process.env.ROLIMONS_CACHE_TTL_MS || 120_000);

const ROBLOX_CATALOG_URL = "https://catalog.roblox.com/v1/search/items/details";
const ROBLOX_CATALOG_BATCH_URL = "https://catalog.roblox.com/v1/catalog/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROBLOX_ECONOMY_DETAILS_URL = "https://economy.roblox.com/v2/assets";
const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";

const ALLOWED_LIMITS = [10, 28, 30];

const resaleCache = new Map();
const economyCache = new Map();
const catalogBatchCache = new Map();
const pageCache = new Map();
const itemCache = new Map();

let rolimonsCache = null;
let robloxCsrfToken = "";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeLimit(value) {
  const requested = Number(value) || 30;

  return ALLOWED_LIMITS.reduce((best, current) => {
    return Math.abs(current - requested) < Math.abs(best - requested)
      ? current
      : best;
  }, 30);
}

function offsetFromCursor(cursor) {
  const text = String(cursor || "");

  if (!text.startsWith("offset:")) {
    return 0;
  }

  const offset = Number(text.slice("offset:".length));
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

function cursorFromOffset(offset, total) {
  return offset < total ? `offset:${offset}` : "";
}

function safeSort(sort) {
  const allowed = new Set([
    "updated",
    "price_asc",
    "price_desc",
    "rap_desc",
    "deal_desc",
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
  ]);

  return allowed.has(sort) ? sort : "updated";
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 8000;
  let response;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "LimitedsLiveMarketViewer/2.0",
          ...(options.headers || {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status !== 429) {
      break;
    }

    await sleep(600 + attempt * 700);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchResaleData(assetId) {
  assetId = Number(assetId);

  if (!assetId || assetId <= 0) {
    return {};
  }

  const cached = resaleCache.get(assetId);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(`${ROBLOX_RESALE_URL}/${assetId}/resale-data`, {
      retries: 2,
      timeoutMs: 6000,
    });

    resaleCache.set(assetId, {
      fetchedAt: Date.now(),
      data,
    });

    return data;
  } catch {
    return {};
  }
}

async function fetchEconomyDetails(assetId) {
  assetId = Number(assetId);

  if (!assetId || assetId <= 0) {
    return {};
  }

  const cached = economyCache.get(assetId);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(`${ROBLOX_ECONOMY_DETAILS_URL}/${assetId}/details`, {
      retries: 1,
      timeoutMs: 5000,
    });

    economyCache.set(assetId, {
      fetchedAt: Date.now(),
      data,
    });

    return data;
  } catch {
    return {};
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
      "User-Agent": "LimitedsLiveMarketViewer/2.0",
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
    throw new Error(`${response.status} ${response.statusText} for catalog batch`);
  }

  return response.json();
}

async function fetchCatalogDetailsBatch(assetIds) {
  const result = new Map();
  const missing = [];

  for (const assetId of assetIds) {
    const id = Number(assetId);
    const cached = catalogBatchCache.get(id);

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      result.set(id, cached.data);
    } else if (id > 0) {
      missing.push(id);
    }
  }

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);

    try {
      const data = await fetchCatalogDetailsChunk(chunk);
      const rows = Array.isArray(data.data) ? data.data : [];

      for (const row of rows) {
        const assetId = normalizeNumber(row.id);

        if (assetId > 0) {
          catalogBatchCache.set(assetId, {
            fetchedAt: Date.now(),
            data: row,
          });

          result.set(assetId, row);
        }
      }
    } catch {
      break;
    }

    await sleep(200);
  }

  return result;
}

async function fetchRolimonsItems() {
  if (rolimonsCache && Date.now() - rolimonsCache.fetchedAt < ROLIMONS_CACHE_TTL_MS) {
    return rolimonsCache.items;
  }

  const data = await fetchJson(ROLIMONS_ITEM_DETAILS_URL, {
    retries: 1,
    timeoutMs: 7000,
  });

  const rawItems = data && typeof data.items === "object" ? data.items : {};

  const items = Object.entries(rawItems)
    .map(([assetId, values]) => ({
      assetId: Number(assetId),
      name: String(values[0] || "Unknown Limited"),
      acronym: String(values[1] || ""),
      rolimonsRap: Number(values[2]) > 0 ? Number(values[2]) : null,
      value: Number(values[3]) > 0 ? Number(values[3]) : null,
      lowestPrice: 0,
      creatorName: "Roblox",
      itemType: "Asset",
      marketType: "roblox",
      thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
    }))
    .filter((item) => item.assetId > 0);

  rolimonsCache = {
    fetchedAt: Date.now(),
    items,
  };

  return items;
}

function normalizeHistoryPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .map((point) => ({
      value: Number(point.value),
      date: String(point.date || ""),
    }))
    .filter((point) => point.value > 0 && Number.isFinite(Date.parse(point.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function addLivePoint(history, currentRap) {
  if (!currentRap || currentRap <= 0) {
    return history;
  }

  return history.concat({
    value: Math.round(currentRap),
    date: new Date().toISOString(),
  });
}

function percentChange(fromValue, toValue) {
  if (!fromValue || !toValue || fromValue <= 0 || toValue <= 0) {
    return null;
  }

  return Math.round(((toValue - fromValue) / fromValue) * 10000) / 100;
}

function splitProfitLoss(change) {
  if (change === null || change === undefined) {
    return { profit: null, loss: null };
  }

  if (change > 0) {
    return { profit: change, loss: null };
  }

  if (change < 0) {
    return { profit: null, loss: Math.abs(change) };
  }

  return { profit: null, loss: null };
}

function findBaseline(history, days) {
  const points = normalizeHistoryPoints(history);

  if (points.length === 0) {
    return null;
  }

  if (!days) {
    return points[0].value;
  }

  const now = Date.now();
  const target = now - days * 24 * 60 * 60 * 1000;
  const maxAge = Math.max(2, days * 1.5) * 24 * 60 * 60 * 1000;

  let best = null;

  for (const point of points) {
    const time = Date.parse(point.date);

    if (time <= target) {
      best = {
        value: point.value,
        time,
      };
    } else {
      break;
    }
  }

  if (!best) {
    return null;
  }

  if (Math.abs(best.time - target) > maxAge) {
    return null;
  }

  return best.value;
}

function calculateProfitLoss(history, currentRap) {
  const liveHistory = addLivePoint(normalizeHistoryPoints(history), currentRap);

  const baseline24h = findBaseline(liveHistory, 1);
  const baseline7d = findBaseline(liveHistory, 7);
  const baseline30d = findBaseline(liveHistory, 30);
  const baseline1y = findBaseline(liveHistory, 365);
  const baselineAll = findBaseline(liveHistory, null);

  const change24h = percentChange(baseline24h, currentRap);
  const change7d = percentChange(baseline7d, currentRap);
  const change30d = percentChange(baseline30d, currentRap);
  const change1y = percentChange(baseline1y, currentRap);
  const changeAll = percentChange(baselineAll, currentRap);

  const p24h = splitProfitLoss(change24h);
  const p7d = splitProfitLoss(change7d);
  const p30d = splitProfitLoss(change30d);
  const p1y = splitProfitLoss(change1y);
  const pAll = splitProfitLoss(changeAll);

  return {
    change24h,
    change7d,
    change30d,
    change1y,
    changeAll,

    profit24h: p24h.profit,
    profit7d: p7d.profit,
    profit30d: p30d.profit,
    profit1y: p1y.profit,
    profitAllTime: pAll.profit,

    loss24h: p24h.loss,
    loss7d: p7d.loss,
    loss30d: p30d.loss,
    loss1y: p1y.loss,
    lossAllTime: pAll.loss,

    history: liveHistory.slice(-1000),
  };
}

async function enrichClassicLimited(item) {
  const [resale, economy] = await Promise.all([
    fetchResaleData(item.assetId),
    fetchEconomyDetails(item.assetId),
  ]);

  const collectible = economy.CollectiblesItemDetails || {};

  const liveRap = firstPositiveNumber(
    resale.recentAveragePrice,
    economy.RecentAveragePrice,
    collectible.RecentAveragePrice,
    item.rolimonsRap
  );

  const lowestPrice = firstNumber(
    resale.lowestResalePrice,
    collectible.CollectibleLowestResalePrice,
    economy.PriceInRobux,
    item.lowestPrice
  );

  const history = normalizeHistoryPoints(resale.priceDataPoints);
  const metrics = calculateProfitLoss(history, liveRap);

  const dealPercent =
    liveRap && lowestPrice > 0 && lowestPrice < liveRap
      ? Math.round(((liveRap - lowestPrice) / liveRap) * 10000) / 100
      : null;

  return {
    assetId: item.assetId,
    name: item.name,
    acronym: item.acronym || "",
    rap: liveRap,
    rolimonsRap: item.rolimonsRap,
    lowestPrice,
    availableCopies: firstNonNegativeNumber(resale.numberRemaining, item.availableCopies),
    totalCopies: firstPositiveNumber(collectible.TotalQuantity, resale.assetStock, item.totalCopies),
    thumbnail: item.thumbnail || `rbxthumb://type=Asset&id=${item.assetId}&w=420&h=420`,
    creatorName: item.creatorName || "Roblox",
    itemType: item.itemType || "Asset",
    marketType: "roblox",
    dealPercent,
    ...metrics,
  };
}

function buildCatalogUrl({ cursor, limit, keyword, marketType, sort }) {
  const url = new URL(ROBLOX_CATALOG_URL);

  const metricSorts = new Set([
    "price_desc",
    "rap_desc",
    "deal_desc",
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
  ]);

  const sortType =
    sort === "price_asc" || sort === "deal_desc"
      ? "4"
      : metricSorts.has(sort)
        ? "5"
        : "3";

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

function tokenizeKeyword(keyword) {
  return String(keyword || "")
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesKeyword(item, tokens) {
  if (tokens.length === 0) {
    return true;
  }

  const text = `${item.name || item.itemName || ""} ${item.acronym || ""}`.toLowerCase();
  return tokens.every((token) => text.includes(token));
}

function chooseKeyword(tokens, fallback) {
  if (tokens.length === 0) {
    return fallback;
  }

  return tokens.reduce((best, token) => {
    return token.length > best.length ? token : best;
  }, tokens[0]);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function sortItems(items, sort) {
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

  if (sort === "price_asc") {
    items = items.filter((item) => item.lowestPrice > 0);
    items.sort((a, b) => a.lowestPrice - b.lowestPrice);
  } else if (sort === "price_desc") {
    items = items.filter((item) => item.lowestPrice > 0);
    items.sort((a, b) => b.lowestPrice - a.lowestPrice);
  } else if (sort === "rap_desc") {
    items = items.filter((item) => item.rap > 0);
    items.sort((a, b) => b.rap - a.rap);
  } else if (sort === "deal_desc") {
    items = items.filter((item) => item.dealPercent > 0);
    items.sort((a, b) => b.dealPercent - a.dealPercent);
  } else if (metricKeyBySort[sort]) {
    const key = metricKeyBySort[sort];
    items = items.filter((item) => item[key] > 0);
    items.sort((a, b) => b[key] - a[key]);
  } else {
    items.sort((a, b) => b.assetId - a.assetId);
  }

  return items;
}

function filterItems(items, filters) {
  return items.filter((item) => {
    if (filters.minPrice !== null && (!item.lowestPrice || item.lowestPrice < filters.minPrice)) return false;
    if (filters.maxPrice !== null && (!item.lowestPrice || item.lowestPrice > filters.maxPrice)) return false;
    if (filters.minRap !== null && (!item.rap || item.rap < filters.minRap)) return false;
    if (filters.maxRap !== null && (!item.rap || item.rap > filters.maxRap)) return false;
    return true;
  });
}

async function fetchClassicLimitedsPage({
  cursor,
  limit,
  keyword,
  sort,
  minPrice,
  maxPrice,
  minRap,
  maxRap,
}) {
  const offset = offsetFromCursor(cursor);
  const tokens = tokenizeKeyword(keyword);

  let items = await fetchRolimonsItems();

  items = items.filter((item) => matchesKeyword(item, tokens));

  if (minRap !== null) {
    items = items.filter((item) => item.rolimonsRap && item.rolimonsRap >= minRap);
  }

  if (maxRap !== null) {
    items = items.filter((item) => item.rolimonsRap && item.rolimonsRap <= maxRap);
  }

  if (sort === "updated") {
    items.sort((a, b) => b.assetId - a.assetId);
  } else {
    items.sort((a, b) => (b.rolimonsRap || 0) - (a.rolimonsRap || 0));
  }

  const needsBigScan =
    sort !== "updated" ||
    minPrice !== null ||
    maxPrice !== null ||
    keyword.trim() !== "";

  const scanSize = needsBigScan
    ? Math.min(items.length, Math.max(offset + limit * 8, 240))
    : Math.min(items.length, offset + limit);

  const scanWindow = items.slice(0, scanSize);

  const enriched = await mapWithConcurrency(scanWindow, 8, enrichClassicLimited);

  let filtered = filterItems(enriched, {
    minPrice,
    maxPrice,
    minRap,
    maxRap,
  });

  filtered = sortItems(filtered, sort);

  const pageItems = filtered.slice(offset, offset + limit);

  return {
    items: pageItems,
    nextPageCursor: cursorFromOffset(offset + limit, filtered.length),
    previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - limit), filtered.length) : "",
    updatedAt: new Date().toISOString(),
  };
}

function buildUgcItemFromCatalog(item, resale) {
  const assetId = normalizeNumber(item.id || item.assetId);
  const itemType = String(item.itemType || "Asset");
  const thumbnailType = itemType === "Bundle" ? "BundleThumbnail" : "Asset";

  const rap = firstPositiveNumber(
    resale.recentAveragePrice,
    item.recentAveragePrice,
    item.rap
  );

  const lowestPrice = firstNumber(
    item.lowestResalePrice,
    item.lowestPrice,
    item.price,
    resale.lowestResalePrice
  );

  const history = normalizeHistoryPoints(resale.priceDataPoints);
  const metrics = calculateProfitLoss(history, rap);

  const dealPercent =
    rap && lowestPrice > 0 && lowestPrice < rap
      ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
      : null;

  return {
    assetId,
    name: String(item.name || item.itemName || "Unknown Limited"),
    rap,
    lowestPrice,
    availableCopies: firstNonNegativeNumber(
      item.unitsAvailableForConsumption,
      resale.numberRemaining
    ),
    totalCopies: firstPositiveNumber(item.totalQuantity, resale.assetStock),
    thumbnail: `rbxthumb://type=${thumbnailType}&id=${assetId}&w=420&h=420`,
    creatorName: String(item.creatorName || ""),
    itemType,
    marketType: "ugc",
    dealPercent,
    ...metrics,
  };
}

async function fetchUgcLimitedsPage({
  cursor,
  limit,
  keyword,
  sort,
  minPrice,
  maxPrice,
  minRap,
  maxRap,
}) {
  const tokens = tokenizeKeyword(keyword);
  const catalogKeyword = chooseKeyword(tokens, keyword);
  let nextPageCursor = cursor;
  let previousPageCursor = "";
  let collected = [];

  const maxPages =
    keyword.trim() !== "" ||
    minPrice !== null ||
    maxPrice !== null ||
    minRap !== null ||
    maxRap !== null ||
    sort !== "updated"
      ? 5
      : 1;

  for (let page = 0; page < maxPages && collected.length < limit * 5; page += 1) {
    const catalog = await fetchJson(
      buildCatalogUrl({
        cursor: page === 0 ? cursor : nextPageCursor,
        limit,
        keyword: catalogKeyword,
        marketType: "ugc",
        sort,
      })
    );

    if (!previousPageCursor) {
      previousPageCursor = catalog.previousPageCursor || "";
    }

    nextPageCursor = catalog.nextPageCursor || "";

    const rawItems = Array.isArray(catalog.data) ? catalog.data : [];

    const matching = rawItems.filter((item) => {
      if (!matchesKeyword(item, tokens)) {
        return false;
      }

      return item.creatorTargetId !== 1 || item.creatorName !== "Roblox";
    });

    const enriched = await mapWithConcurrency(matching, 5, async (item) => {
      const assetId = normalizeNumber(item.id || item.assetId);
      const resale = await fetchResaleData(assetId);
      return buildUgcItemFromCatalog(item, resale);
    });

    collected = collected.concat(enriched.filter((item) => item.assetId > 0));

    if (!nextPageCursor) {
      break;
    }
  }

  collected = filterItems(collected, {
    minPrice,
    maxPrice,
    minRap,
    maxRap,
  });

  collected = sortItems(collected, sort);

  return {
    items: collected.slice(0, limit),
    nextPageCursor,
    previousPageCursor,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchLimitedsPage({
  cursor,
  limit,
  keyword,
  marketType,
  sort,
  minPrice,
  maxPrice,
  minRap,
  maxRap,
}) {
  const safeLimit = normalizeLimit(limit);
  const safeMarketType = marketType === "roblox" ? "roblox" : "ugc";
  const safeSort = safeSortName(sort);

  const safeMinPrice = parseOptionalNumber(minPrice);
  const safeMaxPrice = parseOptionalNumber(maxPrice);
  const safeMinRap = parseOptionalNumber(minRap);
  const safeMaxRap = parseOptionalNumber(maxRap);

  const cacheKey = JSON.stringify({
    cursor,
    limit: safeLimit,
    keyword,
    marketType: safeMarketType,
    sort: safeSort,
    minPrice: safeMinPrice,
    maxPrice: safeMaxPrice,
    minRap: safeMinRap,
    maxRap: safeMaxRap,
  });

  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  let data;

  if (safeMarketType === "roblox") {
    data = await fetchClassicLimitedsPage({
      cursor,
      limit: safeLimit,
      keyword,
      sort: safeSort,
      minPrice: safeMinPrice,
      maxPrice: safeMaxPrice,
      minRap: safeMinRap,
      maxRap: safeMaxRap,
    });
  } else {
    data = await fetchUgcLimitedsPage({
      cursor,
      limit: safeLimit,
      keyword,
      sort: safeSort,
      minPrice: safeMinPrice,
      maxPrice: safeMaxPrice,
      minRap: safeMinRap,
      maxRap: safeMaxRap,
    });
  }

  pageCache.set(cacheKey, {
    fetchedAt: Date.now(),
    data,
  });

  return data;
}

function safeSortName(value) {
  return safeSort(String(value || "updated"));
}

async function fetchItemDetails(assetId, marketType) {
  assetId = Number(assetId);

  if (!assetId || assetId <= 0) {
    return {
      error: "Invalid assetId.",
    };
  }

  const safeMarketType = marketType === "roblox" ? "roblox" : "ugc";
  const cacheKey = `${safeMarketType}:${assetId}`;

  const cached = itemCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const [resale, economy, catalogDetails] = await Promise.all([
    fetchResaleData(assetId),
    fetchEconomyDetails(assetId),
    fetchCatalogDetailsBatch([assetId]),
  ]);

  const catalog = catalogDetails.get(assetId) || {};
  const collectible = economy.CollectiblesItemDetails || {};

  let rolimonsItem = null;

  if (safeMarketType === "roblox") {
    try {
      const rolimonsItems = await fetchRolimonsItems();
      rolimonsItem = rolimonsItems.find((item) => item.assetId === assetId) || null;
    } catch {
      rolimonsItem = null;
    }
  }

  const rap = firstPositiveNumber(
    resale.recentAveragePrice,
    economy.RecentAveragePrice,
    collectible.RecentAveragePrice,
    catalog.recentAveragePrice,
    rolimonsItem?.rolimonsRap
  );

  const lowestPrice = firstNumber(
    resale.lowestResalePrice,
    collectible.CollectibleLowestResalePrice,
    economy.PriceInRobux,
    catalog.lowestResalePrice,
    catalog.lowestPrice,
    catalog.price
  );

  const itemType = String(catalog.itemType || rolimonsItem?.itemType || "Asset");
  const thumbnailType = itemType === "Bundle" ? "BundleThumbnail" : "Asset";

  const history = normalizeHistoryPoints(resale.priceDataPoints);
  const metrics = calculateProfitLoss(history, rap);

  const dealPercent =
    rap && lowestPrice > 0 && lowestPrice < rap
      ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
      : null;

  const data = {
    assetId,
    name: String(
      catalog.name ||
      economy.Name ||
      rolimonsItem?.name ||
      "Unknown Limited"
    ),
    rap,
    rolimonsRap: rolimonsItem?.rolimonsRap || null,
    lowestPrice,
    availableCopies: firstNonNegativeNumber(
      resale.numberRemaining,
      catalog.unitsAvailableForConsumption
    ),
    totalCopies: firstPositiveNumber(
      collectible.TotalQuantity,
      catalog.totalQuantity,
      resale.assetStock
    ),
    thumbnail: `rbxthumb://type=${thumbnailType}&id=${assetId}&w=420&h=420`,
    creatorName: String(catalog.creatorName || rolimonsItem?.creatorName || ""),
    itemType,
    marketType: safeMarketType,
    dealPercent,
    updatedAt: new Date().toISOString(),
    ...metrics,
  };

  itemCache.set(cacheKey, {
    fetchedAt: Date.now(),
    data,
  });

  return data;
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      version: SERVER_VERSION,
      cacheTtlMs: CACHE_TTL_MS,
      rolimonsCacheTtlMs: ROLIMONS_CACHE_TTL_MS,
    });
    return;
  }

  if (url.pathname === "/api/limiteds") {
    try {
      const data = await fetchLimitedsPage({
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

      sendJson(res, 200, {
        ok: true,
        ...data,
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: "Could not load Roblox limiteds right now.",
        detail: error.message,
        items: [],
        nextPageCursor: "",
      });
    }

    return;
  }

  if (url.pathname === "/api/item") {
    try {
      const data = await fetchItemDetails(
        url.searchParams.get("assetId") || "0",
        url.searchParams.get("type") || "ugc"
      );

      sendJson(res, 200, {
        ok: !data.error,
        ...data,
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: "Could not load item details right now.",
        detail: error.message,
      });
    }

    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "Not found.",
  });
}

createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, {
      ok: false,
      error: "Server error.",
      detail: error.message,
    });
  });
}).listen(PORT, () => {
  console.log(`Limiteds Live ${SERVER_VERSION} running on port ${PORT}`);
});
