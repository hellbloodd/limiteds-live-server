// Local/prod backend for the Roblox Limiteds Live UI.
// Run with: node live-limiteds-server.mjs
//
// The Roblox client calls this server, not Roblox marketplace APIs directly.
// Deploy it to a public HTTPS host before using it in a published Roblox game.

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300_000);
const ROLIMONS_CACHE_TTL_MS = Number(process.env.ROLIMONS_CACHE_TTL_MS || 600_000);
const ROBLOX_CATALOG_URL = "https://catalog.roblox.com/v1/search/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";
const ALLOWED_LIMITS = [10, 28, 30];

const pageCache = new Map();
const resaleCache = new Map();
const economyCache = new Map();
const detailCache = new Map();
let rolimonsCache = null;

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
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "LimitedsLiveMarketViewer/1.0",
        },
      });
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

  return response.json();
}

function buildCatalogUrl({ cursor, limit, keyword, marketType, sort }) {
  const url = new URL(ROBLOX_CATALOG_URL);
  const metricSorts = [
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
  ];
  const sortType = sort === "price_asc" ? "4" : metricSorts.includes(sort) ? "5" : "3";

  // All + salesTypeFilter=2 covers accessories, faces/heads, and bundle-like collectible results.
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
      retries: 1,
      timeoutMs: 2500,
    });
    resaleCache.set(assetId, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return {};
  }
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

function normalizeHistoryPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .filter((point) => typeof point.value === "number" && point.value > 0)
    .slice(-180)
    .map((point) => ({
      value: point.value,
      date: String(point.date || ""),
    }));
}

function findHistoryValueAtLeastDaysAgo(history, days) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const targetTime = Date.now() - days * 24 * 60 * 60 * 1000;
  let best = null;

  for (const point of history) {
    const value = Number(point.value);
    const time = Date.parse(point.date || "");

    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time)) {
      continue;
    }

    if (time <= targetTime) {
      best = value;
    }
  }

  return best ?? Number(history[0]?.value) ?? null;
}

function percentDrop(fromValue, toValue) {
  if (!fromValue || !toValue || fromValue <= 0 || toValue <= 0 || toValue >= fromValue) {
    return null;
  }

  return Math.round(((fromValue - toValue) / fromValue) * 10000) / 100;
}

function percentGain(fromValue, toValue) {
  if (!fromValue || !toValue || fromValue <= 0 || toValue <= fromValue) {
    return null;
  }

  return Math.round(((toValue - fromValue) / fromValue) * 10000) / 100;
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

async function enrichRolimonsItem(item, includeResale = false) {
  const [details, resale] = await Promise.all([
    fetchEconomyDetails(item.assetId),
    includeResale && item.assetId > 0 && item.assetId < 10000000000
      ? fetchResaleData(item.assetId)
      : {},
  ]);
  const collectibleDetails = details.CollectiblesItemDetails || {};
  const rap = firstPositiveNumber(
    resale.recentAveragePrice,
    details.RecentAveragePrice,
    collectibleDetails.RecentAveragePrice,
    item.rap
  );
  const lowestPrice = firstNumber(
    collectibleDetails.CollectibleLowestResalePrice,
    details.PriceInRobux,
    resale.lowestResalePrice,
    item.lowestPrice
  );

  return {
    ...item,
    rap,
    lowestPrice,
    availableCopies: firstNonNegativeNumber(resale.numberRemaining, item.availableCopies),
    totalCopies: firstPositiveNumber(collectibleDetails.TotalQuantity, item.totalCopies),
    dealPercent: rap && lowestPrice > 0 && lowestPrice < rap
      ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
      : null,
  };
}

async function addHistoryMetrics(item) {
  const resale = await fetchResaleData(item.assetId);
  const history = normalizeHistoryPoints(resale.priceDataPoints);
  const firstHistoryValue = history.length > 0 ? Number(history[0].value) : null;
  const rap = firstPositiveNumber(resale.recentAveragePrice, item.rap);

  return {
    ...item,
    rap,
    lowestPrice: firstNumber(resale.lowestResalePrice, item.lowestPrice),
    availableCopies: firstNonNegativeNumber(resale.numberRemaining, item.availableCopies),
    lossAllTime: percentDrop(firstHistoryValue, rap),
    loss24h: percentDrop(findHistoryValueAtLeastDaysAgo(history, 1), rap),
    loss7d: percentDrop(findHistoryValueAtLeastDaysAgo(history, 7), rap),
    loss30d: percentDrop(findHistoryValueAtLeastDaysAgo(history, 30), rap),
    loss1y: percentDrop(findHistoryValueAtLeastDaysAgo(history, 365), rap),
    profitAllTime: percentGain(firstHistoryValue, rap),
    profit24h: percentGain(findHistoryValueAtLeastDaysAgo(history, 1), rap),
    profit7d: percentGain(findHistoryValueAtLeastDaysAgo(history, 7), rap),
    profit30d: percentGain(findHistoryValueAtLeastDaysAgo(history, 30), rap),
    profit1y: percentGain(findHistoryValueAtLeastDaysAgo(history, 365), rap),
  };
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

  if (sort === "rap_desc" || sort === "deal_desc" || metricKey) {
    items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  } else if (sort === "price_asc" || sort === "price_desc") {
    // Price sorts are handled better by Roblox catalog search, not the RAP index.
    items.sort((a, b) => (b.rap || 0) - (a.rap || 0));
  } else if (sort === "updated") {
    items.sort((a, b) => b.assetId - a.assetId);
  } else {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }

  if (sort === "price_asc" || sort === "price_desc" || sort === "deal_desc" || metricKey || minPrice !== null || maxPrice !== null) {
    const shouldScanAllMatches = keywordTokens.length > 0;
    const scanSize = shouldScanAllMatches
      ? items.length
      : Math.min(items.length, Math.max(offset + limit * 8, 240));
    const scanWindow = items.slice(0, scanSize);
    let enriched = await mapWithConcurrency(scanWindow, 8, enrichRolimonsItem);

    if (metricKey) {
      enriched = await mapWithConcurrency(enriched, 4, addHistoryMetrics);
      enriched = enriched.filter((item) => item[metricKey] && item[metricKey] > 0);
      enriched.sort((a, b) => b[metricKey] - a[metricKey]);
    } else if (sort === "deal_desc") {
      enriched = enriched.filter((item) => item.dealPercent && item.dealPercent > 0);
      enriched.sort((a, b) => b.dealPercent - a.dealPercent);
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

    const pageItems = enriched.slice(offset, offset + limit);
    const visibleItems = metricKey
      ? pageItems
      : await mapWithConcurrency(pageItems, 8, (item) => enrichRolimonsItem(item, true));

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

function buildItemFromCatalog(item, resale, marketType) {
  const assetId = normalizeNumber(item.id || item.assetId);
  const lowestPrice = firstNumber(
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
  const history = normalizeHistoryPoints(resale.priceDataPoints);
  const dealPercent = rap && lowestPrice > 0 && lowestPrice < rap
    ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
    : null;
  const firstHistoryValue = history.length > 0 ? Number(history[0].value) : null;
  const lossAllTime = percentDrop(firstHistoryValue, rap);
  const loss24h = percentDrop(findHistoryValueAtLeastDaysAgo(history, 1), rap);
  const loss7d = percentDrop(findHistoryValueAtLeastDaysAgo(history, 7), rap);
  const loss30d = percentDrop(findHistoryValueAtLeastDaysAgo(history, 30), rap);
  const loss1y = percentDrop(findHistoryValueAtLeastDaysAgo(history, 365), rap);
  const profitAllTime = percentGain(firstHistoryValue, rap);
  const profit24h = percentGain(findHistoryValueAtLeastDaysAgo(history, 1), rap);
  const profit7d = percentGain(findHistoryValueAtLeastDaysAgo(history, 7), rap);
  const profit30d = percentGain(findHistoryValueAtLeastDaysAgo(history, 30), rap);
  const profit1y = percentGain(findHistoryValueAtLeastDaysAgo(history, 365), rap);
  const availableCopies = firstNonNegativeNumber(
    item.unitsAvailableForConsumption,
    resale.numberRemaining
  );
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
    dealPercent,
    loss24h,
    loss7d,
    loss30d,
    loss1y,
    lossAllTime,
    profit24h,
    profit7d,
    profit30d,
    profit1y,
    profitAllTime,
    marketType,
  };
}

async function fetchItemDetails(assetId, marketType = "ugc") {
  const safeAssetId = normalizeNumber(Number(assetId));
  const cacheKey = `${safeAssetId}:${marketType}`;
  const cached = detailCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const resale = safeAssetId > 0 && safeAssetId < 10000000000
    ? await fetchResaleData(safeAssetId)
    : {};
  const details = safeAssetId > 0 ? await fetchEconomyDetails(safeAssetId) : {};
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
  const lowestPrice = firstNumber(
    collectibleDetails.CollectibleLowestResalePrice,
    details.PriceInRobux,
    resale.lowestResalePrice
  );
  const rap = firstPositiveNumber(
    resale.recentAveragePrice,
    details.RecentAveragePrice,
    collectibleDetails.RecentAveragePrice,
    rolimonsItem?.rap
  );

  const data = {
    assetId: safeAssetId,
    name: String(details.Name || rolimonsItem?.name || "Unknown Limited"),
    rap,
    lowestPrice,
    availableCopies: firstNonNegativeNumber(resale.numberRemaining),
    totalCopies: firstPositiveNumber(collectibleDetails.TotalQuantity, resale.assetStock),
    creatorName: String(creator.Name || ""),
    thumbnail: `rbxthumb://type=Asset&id=${safeAssetId}&w=420&h=420`,
    history: normalizeHistoryPoints(resale.priceDataPoints),
    volumeHistory: normalizeHistoryPoints(resale.volumeDataPoints),
    marketType,
  };

  detailCache.set(cacheKey, { fetchedAt: Date.now(), data });
  return data;
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
  const cacheKey = [
    safeMarketType,
    safeSort,
    safeKeyword,
    cursor,
    safeLimit,
    safeMinPrice ?? "",
    safeMaxPrice ?? "",
    safeMinRap ?? "",
    safeMaxRap ?? "",
  ].join(":");
  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  let nextPageCursor = cursor;
  let previousPageCursor = "";
  let collectedItems = [];

  const isMetricSort = [
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
  ].includes(safeSort);
  const needsMetricScan = isMetricSort
    || safeMinRap !== null
    || safeMaxRap !== null;
  const hasRangeFilter = safeMinPrice !== null
    || safeMaxPrice !== null
    || safeMinRap !== null
    || safeMaxRap !== null;
  const isRobloxPriceSort = safeMarketType === "roblox"
    && (safeSort === "price_asc" || safeSort === "price_desc");
  const shouldScanFullWindow = needsMetricScan || hasRangeFilter || keywordTokens.length > 0;
  const maxPages = keywordTokens.length > 0 ? 4 : needsMetricScan || hasRangeFilter ? 5 : isRobloxPriceSort ? 40 : 1;

  const shouldUseClassicIndex = safeMarketType === "roblox"
    && (
      keywordTokens.length > 0
      || safeSort === "updated"
      || safeSort === "rap_desc"
      || safeSort === "deal_desc"
      || safeSort.startsWith("loss_")
      || safeSort.startsWith("profit_")
      || safeMinRap !== null
      || safeMaxRap !== null
    );

  if (shouldUseClassicIndex) {
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
    for (let page = 0; page < maxPages && (shouldScanFullWindow || collectedItems.length < safeLimit); page += 1) {
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

          if (classicItemByAssetId) {
            return classicItemByAssetId.has(assetId);
          }

          return item.creatorTargetId === 1 && item.creatorName === "Roblox";
      });

      const pageItems = [];

      for (const item of matchingItems) {
        const assetId = normalizeNumber(item.id || item.assetId);
        const shouldFetchClassicResaleData = needsMetricScan && safeMarketType === "roblox" && assetId > 0 && assetId < 10000000000;
        const resale = shouldFetchClassicResaleData ? await fetchResaleData(assetId) : {};
        const builtItem = buildItemFromCatalog(item, resale, safeMarketType);
        const classicItem = classicItemByAssetId?.get(assetId);

        if (classicItem) {
          builtItem.rap = builtItem.rap || classicItem.rap;
          builtItem.name = builtItem.name || classicItem.name;
        }

        pageItems.push(builtItem);

        if (shouldFetchClassicResaleData) {
          await sleep(35);
        }
      }

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

  collectedItems = collectedItems.filter((item) => {
    if (safeMinPrice !== null && (!item.lowestPrice || item.lowestPrice < safeMinPrice)) return false;
    if (safeMaxPrice !== null && (!item.lowestPrice || item.lowestPrice > safeMaxPrice)) return false;
    if (safeMinRap !== null && (!item.rap || item.rap < safeMinRap)) return false;
    if (safeMaxRap !== null && (!item.rap || item.rap > safeMaxRap)) return false;
    return true;
  });

  if (safeSort === "price_asc") {
    collectedItems.sort((a, b) => a.lowestPrice - b.lowestPrice);
  } else if (safeSort === "price_desc") {
    collectedItems.sort((a, b) => b.lowestPrice - a.lowestPrice);
  } else if (safeSort === "rap_desc") {
    collectedItems = collectedItems.filter((item) => item.rap && item.rap > 0);
    collectedItems.sort((a, b) => b.rap - a.rap);
  } else if (safeSort === "deal_desc") {
    collectedItems = collectedItems.filter((item) => item.dealPercent && item.dealPercent > 0);
    collectedItems.sort((a, b) => b.dealPercent - a.dealPercent);
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

    if (metricKey) {
      collectedItems = collectedItems.filter((item) => item[metricKey] && item[metricKey] > 0);
      collectedItems.sort((a, b) => b[metricKey] - a[metricKey]);
    }
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
  return data;
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
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
        url.searchParams.get("type") || "ugc"
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

  sendJson(res, 404, { error: "Not found" });
}

const { createServer } = await import("node:http");

createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: "Server error", detail: error.message });
  });
}).listen(PORT, () => {
  console.log(`Limiteds Live server running on http://localhost:${PORT}`);
});
