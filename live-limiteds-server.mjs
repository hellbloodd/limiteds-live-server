// live-limiteds-server.mjs
// Fast Roblox Limiteds backend.
// Fast list loading + live RAP/details on item click.

const { createServer } = await import("node:http");

const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "fast-live-details-2026-06-10";

const PAGE_CACHE_MS = Number(process.env.PAGE_CACHE_MS || 30_000);
const ROLIMONS_CACHE_MS = Number(process.env.ROLIMONS_CACHE_MS || 120_000);
const DETAILS_CACHE_MS = Number(process.env.DETAILS_CACHE_MS || 45_000);

const ROBLOX_CATALOG_URL = "https://catalog.roblox.com/v1/search/items/details";
const ROBLOX_CATALOG_BATCH_URL = "https://catalog.roblox.com/v1/catalog/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROBLOX_ECONOMY_DETAILS_URL = "https://economy.roblox.com/v2/assets";
const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";

const pageCache = new Map();
const detailCache = new Map();
const resaleCache = new Map();
const catalogBatchCache = new Map();

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

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstPositive(...values) {
  for (const value of values) {
    const n = positive(value);
    if (n) return n;
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLimit(value) {
  const n = Number(value) || 30;
  return Math.max(10, Math.min(30, Math.floor(n)));
}

function normalizeMarketType(value) {
  return String(value || "").toLowerCase() === "roblox" ? "roblox" : "ugc";
}

function normalizeSort(value) {
  const sort = String(value || "updated");
  const allowed = new Set([
    "updated",
    "rap_desc",
    "price_asc",
    "price_desc",
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

function offsetFromCursor(cursor) {
  const text = String(cursor || "");
  if (!text.startsWith("offset:")) return 0;

  const offset = Number(text.slice("offset:".length));
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

function cursorFromOffset(offset, total) {
  return offset < total ? `offset:${offset}` : "";
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 6000;
  let response;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "LimitedsLiveFast/1.0",
          ...(options.headers || {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status !== 429) break;
    await sleep(500 + attempt * 500);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchRolimonsItems() {
  if (rolimonsCache && Date.now() - rolimonsCache.fetchedAt < ROLIMONS_CACHE_MS) {
    return rolimonsCache.items;
  }

  const data = await fetchJson(ROLIMONS_ITEM_DETAILS_URL, {
    retries: 1,
    timeoutMs: 6000,
  });

  const raw = data && typeof data.items === "object" ? data.items : {};

  const items = Object.entries(raw)
    .map(([assetId, values]) => ({
      assetId: Number(assetId),
      name: String(values[0] || "Unknown Limited"),
      acronym: String(values[1] || ""),
      rap: positive(values[2]),
      value: positive(values[3]),
      lowestPrice: 0,
      availableCopies: null,
      totalCopies: null,
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

async function fetchCatalogDetailsChunk(assetIds) {
  const body = JSON.stringify({
    items: assetIds.map((id) => ({
      itemType: "Asset",
      id,
    })),
  });

  let response;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "LimitedsLiveFast/1.0",
    };

    if (robloxCsrfToken) {
      headers["x-csrf-token"] = robloxCsrfToken;
    }

    response = await fetch(ROBLOX_CATALOG_BATCH_URL, {
      method: "POST",
      headers,
      body,
    });

    const token = response.headers.get("x-csrf-token");
    if (token) robloxCsrfToken = token;

    if (response.status === 403 && token) continue;
    if (response.status !== 429) break;

    await sleep(700 + attempt * 500);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for catalog batch`);
  }

  return response.json();
}

async function fetchCatalogDetailsBatch(assetIds) {
  const result = new Map();
  const missing = [];

  for (const rawId of assetIds) {
    const id = Number(rawId);
    if (!id || id <= 0) continue;

    const cached = catalogBatchCache.get(id);
    if (cached && Date.now() - cached.fetchedAt < PAGE_CACHE_MS) {
      result.set(id, cached.data);
    } else {
      missing.push(id);
    }
  }

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);

    try {
      const data = await fetchCatalogDetailsChunk(chunk);
      const rows = Array.isArray(data.data) ? data.data : [];

      for (const row of rows) {
        const id = Number(row.id);
        if (!id || id <= 0) continue;

        catalogBatchCache.set(id, {
          fetchedAt: Date.now(),
          data: row,
        });

        result.set(id, row);
      }
    } catch {
      break;
    }
  }

  return result;
}

async function fetchResaleData(assetId) {
  assetId = Number(assetId);

  const cached = resaleCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < DETAILS_CACHE_MS) {
    return cached.data;
  }

  try {
    const data = await fetchJson(`${ROBLOX_RESALE_URL}/${assetId}/resale-data`, {
      retries: 1,
      timeoutMs: 5000,
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
  try {
    return await fetchJson(`${ROBLOX_ECONOMY_DETAILS_URL}/${assetId}/details`, {
      retries: 1,
      timeoutMs: 5000,
    });
  } catch {
    return {};
  }
}

function normalizeHistory(points) {
  if (!Array.isArray(points)) return [];

  return points
    .map((point) => ({
      value: Number(point.value),
      date: String(point.date || ""),
    }))
    .filter((point) => point.value > 0 && Number.isFinite(Date.parse(point.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function percentChange(fromValue, toValue) {
  if (!fromValue || !toValue || fromValue <= 0 || toValue <= 0) return null;
  return Math.round(((toValue - fromValue) / fromValue) * 10000) / 100;
}

function splitChange(change) {
  if (change === null || change === undefined) return { profit: null, loss: null };
  if (change > 0) return { profit: change, loss: null };
  if (change < 0) return { profit: null, loss: Math.abs(change) };
  return { profit: null, loss: null };
}

function baseline(history, days) {
  const points = normalizeHistory(history);

  if (points.length === 0) return null;
  if (!days) return points[0].value;

  const target = Date.now() - days * 24 * 60 * 60 * 1000;
  let best = null;

  for (const point of points) {
    const time = Date.parse(point.date);
    if (time <= target) {
      best = point;
    } else {
      break;
    }
  }

  return best ? best.value : null;
}

function buildMetrics(history, currentRap) {
  const cleanHistory = normalizeHistory(history);

  if (currentRap && currentRap > 0) {
    cleanHistory.push({
      value: Math.round(currentRap),
      date: new Date().toISOString(),
    });
  }

  const change24h = percentChange(baseline(cleanHistory, 1), currentRap);
  const change7d = percentChange(baseline(cleanHistory, 7), currentRap);
  const change30d = percentChange(baseline(cleanHistory, 30), currentRap);
  const change1y = percentChange(baseline(cleanHistory, 365), currentRap);
  const changeAll = percentChange(baseline(cleanHistory, null), currentRap);

  const p24h = splitChange(change24h);
  const p7d = splitChange(change7d);
  const p30d = splitChange(change30d);
  const p1y = splitChange(change1y);
  const pAll = splitChange(changeAll);

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

    history: cleanHistory.slice(-1000),
  };
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function matchesTokens(item, tokens) {
  if (tokens.length === 0) return true;

  const haystack = `${item.name || item.itemName || ""} ${item.acronym || ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function applyFilters(items, filters) {
  return items.filter((item) => {
    if (filters.minPrice !== null && (!item.lowestPrice || item.lowestPrice < filters.minPrice)) return false;
    if (filters.maxPrice !== null && (!item.lowestPrice || item.lowestPrice > filters.maxPrice)) return false;
    if (filters.minRap !== null && (!item.rap || item.rap < filters.minRap)) return false;
    if (filters.maxRap !== null && (!item.rap || item.rap > filters.maxRap)) return false;
    return true;
  });
}

function sortItems(items, sort) {
  const metricKeys = {
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

  if (sort === "rap_desc") {
    items.sort((a, b) => numberOrZero(b.rap) - numberOrZero(a.rap));
  } else if (sort === "price_asc") {
    items.sort((a, b) => numberOrZero(a.lowestPrice || Infinity) - numberOrZero(b.lowestPrice || Infinity));
  } else if (sort === "price_desc") {
    items.sort((a, b) => numberOrZero(b.lowestPrice) - numberOrZero(a.lowestPrice));
  } else if (sort === "deal_desc") {
    items.sort((a, b) => numberOrZero(b.dealPercent) - numberOrZero(a.dealPercent));
  } else if (metricKeys[sort]) {
    const key = metricKeys[sort];
    items.sort((a, b) => numberOrZero(b[key]) - numberOrZero(a[key]));
  } else {
    items.sort((a, b) => numberOrZero(b.assetId) - numberOrZero(a.assetId));
  }

  return items;
}

function buildFastListItem(base, catalog) {
  const assetId = Number(base.assetId || base.id);
  const itemType = String(catalog.itemType || base.itemType || "Asset");
  const thumbnailType = itemType === "Bundle" ? "BundleThumbnail" : "Asset";

  const liveCatalogRap = firstPositive(
    catalog.recentAveragePrice,
    catalog.rap,
    base.rap
  );

  const lowestPrice = firstNumber(
    catalog.lowestResalePrice,
    catalog.lowestPrice,
    catalog.price,
    base.lowestPrice
  );

  const rap = firstPositive(liveCatalogRap, base.rap);

  const dealPercent =
    rap && lowestPrice > 0 && lowestPrice < rap
      ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
      : null;

  const cachedResale = resaleCache.get(assetId);
  const cachedMetrics =
    cachedResale && Date.now() - cachedResale.fetchedAt < DETAILS_CACHE_MS
      ? buildMetrics(cachedResale.data.priceDataPoints || [], firstPositive(cachedResale.data.recentAveragePrice, rap))
      : {};

  return {
    assetId,
    name: String(catalog.name || base.name || base.itemName || "Unknown Limited"),
    acronym: String(base.acronym || ""),
    rap,
    rolimonsRap: base.rap || null,
    lowestPrice,
    availableCopies: firstNumber(catalog.unitsAvailableForConsumption, base.availableCopies),
    totalCopies: firstPositive(catalog.totalQuantity, base.totalCopies),
    thumbnail: `rbxthumb://type=${thumbnailType}&id=${assetId}&w=420&h=420`,
    creatorName: String(catalog.creatorName || base.creatorName || ""),
    itemType,
    marketType: base.marketType || "roblox",
    dealPercent,
    ...cachedMetrics,
  };
}

async function fetchRobloxLimitedsFast(params) {
  const offset = offsetFromCursor(params.cursor);
  const tokens = tokenize(params.keyword);
  const sort = params.sort;

  let items = await fetchRolimonsItems();
  items = items.filter((item) => matchesTokens(item, tokens));

  if (params.minRap !== null) {
    items = items.filter((item) => item.rap && item.rap >= params.minRap);
  }

  if (params.maxRap !== null) {
    items = items.filter((item) => item.rap && item.rap <= params.maxRap);
  }

  if (sort === "updated") {
    items.sort((a, b) => b.assetId - a.assetId);
  } else {
    items.sort((a, b) => numberOrZero(b.rap) - numberOrZero(a.rap));
  }

  const scanSize =
    sort === "updated" && params.keyword === "" && params.minPrice === null && params.maxPrice === null
      ? offset + params.limit
      : Math.min(items.length, Math.max(offset + params.limit * 4, 120));

  const scanWindow = items.slice(0, scanSize);
  const details = await fetchCatalogDetailsBatch(scanWindow.map((item) => item.assetId));

  let enriched = scanWindow.map((item) => {
    return buildFastListItem(item, details.get(item.assetId) || {});
  });

  enriched = applyFilters(enriched, params);
  enriched = sortItems(enriched, sort);

  return {
    items: enriched.slice(offset, offset + params.limit),
    nextPageCursor: cursorFromOffset(offset + params.limit, enriched.length),
    previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - params.limit), enriched.length) : "",
    updatedAt: new Date().toISOString(),
  };
}

function buildCatalogUrl(params) {
  const url = new URL(ROBLOX_CATALOG_URL);

  url.searchParams.set("category", "All");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("limit", String(params.limit));

  if (params.sort === "price_asc") {
    url.searchParams.set("sortType", "4");
  } else {
    url.searchParams.set("sortType", "3");
  }

  if (params.cursor) {
    url.searchParams.set("cursor", params.cursor);
  }

  if (params.keyword) {
    url.searchParams.set("keyword", params.keyword);
  }

  return url;
}

async function fetchUgcLimitedsFast(params) {
  const catalog = await fetchJson(buildCatalogUrl(params), {
    retries: 1,
    timeoutMs: 6000,
  });

  const rows = Array.isArray(catalog.data) ? catalog.data : [];

  let items = rows
    .filter((item) => Number(item.id || item.assetId) > 0)
    .filter((item) => item.creatorTargetId !== 1 || item.creatorName !== "Roblox")
    .map((item) => {
      return buildFastListItem(
        {
          assetId: Number(item.id || item.assetId),
          name: item.name || item.itemName,
          rap: item.recentAveragePrice || item.rap,
          lowestPrice: item.lowestResalePrice || item.lowestPrice || item.price,
          creatorName: item.creatorName || "",
          itemType: item.itemType || "Asset",
          marketType: "ugc",
        },
        item
      );
    });

  items = applyFilters(items, params);
  items = sortItems(items, params.sort);

  return {
    items: items.slice(0, params.limit),
    nextPageCursor: catalog.nextPageCursor || "",
    previousPageCursor: catalog.previousPageCursor || "",
    updatedAt: new Date().toISOString(),
  };
}

async function fetchLimiteds(params) {
  const safeParams = {
    cursor: String(params.cursor || ""),
    limit: normalizeLimit(params.limit),
    keyword: String(params.keyword || "").slice(0, 80),
    marketType: normalizeMarketType(params.marketType),
    sort: normalizeSort(params.sort),
    minPrice: parseNumber(params.minPrice),
    maxPrice: parseNumber(params.maxPrice),
    minRap: parseNumber(params.minRap),
    maxRap: parseNumber(params.maxRap),
  };

  const cacheKey = JSON.stringify(safeParams);
  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < PAGE_CACHE_MS) {
    return cached.data;
  }

  const data =
    safeParams.marketType === "roblox"
      ? await fetchRobloxLimitedsFast(safeParams)
      : await fetchUgcLimitedsFast(safeParams);

  pageCache.set(cacheKey, {
    fetchedAt: Date.now(),
    data,
  });

  return data;
}

async function fetchItemDetails(assetId, marketType) {
  assetId = Number(assetId);

  if (!assetId || assetId <= 0) {
    return {
      error: "Invalid assetId.",
    };
  }

  const safeMarketType = normalizeMarketType(marketType);
  const cacheKey = `${safeMarketType}:${assetId}`;
  const cached = detailCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < DETAILS_CACHE_MS) {
    return cached.data;
  }

  const [resale, economy, catalogMap] = await Promise.all([
    fetchResaleData(assetId),
    fetchEconomyDetails(assetId),
    fetchCatalogDetailsBatch([assetId]),
  ]);

  const catalog = catalogMap.get(assetId) || {};
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

  const rap = firstPositive(
    resale.recentAveragePrice,
    economy.RecentAveragePrice,
    collectible.RecentAveragePrice,
    catalog.recentAveragePrice,
    catalog.rap,
    rolimonsItem?.rap
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

  const metrics = buildMetrics(resale.priceDataPoints || [], rap);

  const dealPercent =
    rap && lowestPrice > 0 && lowestPrice < rap
      ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
      : null;

  const data = {
    assetId,
    name: String(catalog.name || economy.Name || rolimonsItem?.name || "Unknown Limited"),
    acronym: String(rolimonsItem?.acronym || ""),
    rap,
    rolimonsRap: rolimonsItem?.rap || null,
    lowestPrice,
    availableCopies: firstNumber(resale.numberRemaining, catalog.unitsAvailableForConsumption),
    totalCopies: firstPositive(collectible.TotalQuantity, catalog.totalQuantity, resale.assetStock),
    thumbnail: `rbxthumb://type=${thumbnailType}&id=${assetId}&w=420&h=420`,
    creatorName: String(catalog.creatorName || rolimonsItem?.creatorName || ""),
    itemType,
    marketType: safeMarketType,
    dealPercent,
    updatedAt: new Date().toISOString(),
    ...metrics,
  };

  detailCache.set(cacheKey, {
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
    });
    return;
  }

  if (url.pathname === "/api/limiteds") {
    try {
      const data = await fetchLimiteds({
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
        error: "Could not load limiteds.",
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
        error: "Could not load item details.",
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
