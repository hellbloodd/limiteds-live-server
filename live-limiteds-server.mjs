// Local/prod backend for the Roblox Limiteds Live UI.
// Run with: node live-limiteds-server.mjs
//
// The Roblox client calls this server, not Roblox marketplace APIs directly.
// Deploy it to a public HTTPS host before using it in a published Roblox game.

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000);
const ROBLOX_CATALOG_URL = "https://catalog.roblox.com/v1/search/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ALLOWED_LIMITS = [10, 28, 30];

const pageCache = new Map();
const resaleCache = new Map();
const detailCache = new Map();

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

function normalizeLimit(limit) {
  const requested = Number(limit) || 30;
  return ALLOWED_LIMITS.reduce((best, current) => {
    return Math.abs(current - requested) < Math.abs(best - requested) ? current : best;
  }, 30);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  let response;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "LimitedsLiveMarketViewer/1.0",
      },
    });

    if (response.status !== 429) {
      break;
    }

    await sleep(350 + attempt * 500);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

function buildCatalogUrl({ cursor, limit, keyword, marketType, sort }) {
  const url = new URL(ROBLOX_CATALOG_URL);
  const sortType = sort === "price_asc" ? "4" : sort === "price_desc" || sort === "rap_desc" ? "5" : "3";

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
    const data = await fetchJson(`${ROBLOX_RESALE_URL}/${assetId}/resale-data`);
    resaleCache.set(assetId, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return {};
  }
}

async function fetchEconomyDetails(assetId) {
  try {
    return await fetchJson(`https://economy.roblox.com/v2/assets/${assetId}/details`);
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

  const haystack = String(item.name || item.itemName || "").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function chooseCatalogKeyword(tokens, fallback) {
  if (tokens.length === 0) {
    return fallback;
  }

  return tokens.reduce((best, token) => token.length > best.length ? token : best, tokens[0]);
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
    collectibleDetails.RecentAveragePrice
  );

  const data = {
    assetId: safeAssetId,
    name: String(details.Name || "Unknown Limited"),
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

async function fetchCatalogPage({ cursor = "", limit = 30, keyword = "", marketType = "ugc", sort = "updated" }) {
  const safeLimit = normalizeLimit(limit);
  const safeKeyword = String(keyword || "").slice(0, 80);
  const keywordTokens = tokenizeKeyword(safeKeyword);
  const catalogKeyword = chooseCatalogKeyword(keywordTokens, safeKeyword);
  const safeMarketType = marketType === "roblox" ? "roblox" : "ugc";
  const safeSort = ["price_asc", "price_desc", "rap_desc", "updated"].includes(sort) ? sort : "updated";
  const cacheKey = `${safeMarketType}:${safeSort}:${safeKeyword}:${cursor}:${safeLimit}`;
  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  let nextPageCursor = cursor;
  let previousPageCursor = "";
  let collectedItems = [];

  const maxPages = keywordTokens.length > 0 ? 6 : safeSort === "rap_desc" ? 6 : 3;

  for (let page = 0; page < maxPages && collectedItems.length < safeLimit; page += 1) {
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

        return item.creatorTargetId === 1 && item.creatorName === "Roblox";
    });

    const pageItems = [];

    for (const item of matchingItems) {
      const assetId = normalizeNumber(item.id || item.assetId);
      const shouldFetchClassicResaleData = safeMarketType === "roblox" && assetId > 0 && assetId < 10000000000;
      const resale = shouldFetchClassicResaleData ? await fetchResaleData(assetId) : {};
      pageItems.push(buildItemFromCatalog(item, resale, safeMarketType));

      if (shouldFetchClassicResaleData) {
        await sleep(35);
      }
    }

    collectedItems = collectedItems.concat(
      pageItems.filter((item) => item.assetId > 0 && item.lowestPrice > 0)
    );

    if (!nextPageCursor) {
      break;
    }
  }

  if (safeSort === "price_asc") {
    collectedItems.sort((a, b) => a.lowestPrice - b.lowestPrice);
  } else if (safeSort === "price_desc") {
    collectedItems.sort((a, b) => b.lowestPrice - a.lowestPrice);
  } else if (safeSort === "rap_desc") {
    collectedItems = collectedItems.filter((item) => item.rap && item.rap > 0);
    collectedItems.sort((a, b) => b.rap - a.rap);
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
