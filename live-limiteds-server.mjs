// live-limiteds-server.mjs
// Fast backend with instant estimated profit/loss from Rolimon's,
// then real profit/loss from your own RAP snapshots once enough time passes.

const { createServer } = await import("node:http");
const fs = await import("node:fs/promises");

const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "estimated-plus-real-profit-loss-2026-06-10";

const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "./rap-snapshots.json";
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 15 * 60 * 1000);

const PAGE_CACHE_MS = Number(process.env.PAGE_CACHE_MS || 30_000);
const DETAIL_CACHE_MS = Number(process.env.DETAIL_CACHE_MS || 45_000);
const ROLIMONS_CACHE_MS = Number(process.env.ROLIMONS_CACHE_MS || 120_000);

const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROBLOX_ECONOMY_DETAILS_URL = "https://economy.roblox.com/v2/assets";
const ROBLOX_CATALOG_BATCH_URL = "https://catalog.roblox.com/v1/catalog/items/details";

const pageCache = new Map();
const detailCache = new Map();
const resaleCache = new Map();
const catalogCache = new Map();

let rolimonsCache = null;
let robloxCsrfToken = "";
let snapshotsByAssetId = new Map();
let snapshotRunning = false;

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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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

function percentChange(oldRap, currentRap) {
  if (!oldRap || !currentRap || oldRap <= 0 || currentRap <= 0) return null;
  return Math.round(((currentRap - oldRap) / oldRap) * 10000) / 100;
}

function splitChange(change) {
  if (change === null || change === undefined) {
    return { profit: 0, loss: 0 };
  }

  if (change > 0) {
    return { profit: change, loss: 0 };
  }

  if (change < 0) {
    return { profit: 0, loss: Math.abs(change) };
  }

  return { profit: 0, loss: 0 };
}

function normalizeLimit(value) {
  return Math.max(10, Math.min(30, Math.floor(Number(value) || 30)));
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

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
          "User-Agent": "LimitedsLiveEstimatedReal/1.0",
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
      rolimonsRap: positive(values[2]),
      rolimonsValue: positive(values[3]),
      lowestPrice: 0,
      creatorName: "Roblox",
      itemType: "Asset",
      marketType: "roblox",
      thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
    }))
    .filter((item) => item.assetId > 0 && item.rolimonsRap);

  rolimonsCache = {
    fetchedAt: Date.now(),
    items,
  };

  return items;
}

async function fetchResaleData(assetId) {
  assetId = Number(assetId);

  const cached = resaleCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_MS) {
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
      "User-Agent": "LimitedsLiveEstimatedReal/1.0",
    };

    if (robloxCsrfToken) headers["x-csrf-token"] = robloxCsrfToken;

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

    const cached = catalogCache.get(id);
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

        catalogCache.set(id, {
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

async function loadSnapshots() {
  try {
    const text = await fs.readFile(SNAPSHOT_FILE, "utf8");
    const raw = JSON.parse(text);

    snapshotsByAssetId = new Map();

    for (const row of Array.isArray(raw) ? raw : []) {
      const assetId = Number(row.assetId);
      const rap = Number(row.rap);
      const time = Number(row.time);

      if (!assetId || !rap || !time) continue;

      if (!snapshotsByAssetId.has(assetId)) {
        snapshotsByAssetId.set(assetId, []);
      }

      snapshotsByAssetId.get(assetId).push({ time, rap });
    }

    for (const list of snapshotsByAssetId.values()) {
      list.sort((a, b) => a.time - b.time);
    }

    console.log(`Loaded RAP snapshots for ${snapshotsByAssetId.size} items.`);
  } catch {
    snapshotsByAssetId = new Map();
    console.log("No RAP snapshot file found yet.");
  }
}

async function saveSnapshots() {
  const rows = [];

  for (const [assetId, list] of snapshotsByAssetId.entries()) {
    for (const point of list) {
      rows.push({
        assetId,
        rap: point.rap,
        time: point.time,
      });
    }
  }

  await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(rows), "utf8");
}

function addSnapshot(assetId, rap, time) {
  assetId = Number(assetId);
  rap = Number(rap);

  if (!assetId || !rap || rap <= 0) return;

  if (!snapshotsByAssetId.has(assetId)) {
    snapshotsByAssetId.set(assetId, []);
  }

  const list = snapshotsByAssetId.get(assetId);
  const last = list[list.length - 1];

  if (last && Math.abs(last.time - time) < 10 * 60 * 1000) {
    last.rap = rap;
    last.time = time;
  } else {
    list.push({ time, rap });
  }

  const cutoff = Date.now() - 400 * 24 * 60 * 60 * 1000;

  while (list.length > 0 && list[0].time < cutoff) {
    list.shift();
  }
}

async function runSnapshotJob() {
  if (snapshotRunning) return;
  snapshotRunning = true;

  try {
    const items = await fetchRolimonsItems();
    const now = Date.now();

    for (const item of items) {
      addSnapshot(item.assetId, item.rolimonsRap, now);
    }

    await saveSnapshots();
    console.log(`Saved estimated RAP snapshot for ${items.length} limiteds.`);
  } catch (error) {
    console.warn(`Snapshot failed: ${error.message}`);
  } finally {
    snapshotRunning = false;
  }
}

function findSnapshotAtOrBefore(assetId, targetTime) {
  const list = snapshotsByAssetId.get(Number(assetId)) || [];
  let best = null;

  for (const point of list) {
    if (point.time <= targetTime) {
      best = point;
    } else {
      break;
    }
  }

  return best;
}

function findOldestSnapshot(assetId) {
  const list = snapshotsByAssetId.get(Number(assetId)) || [];
  return list.length > 0 ? list[0] : null;
}

function buildEstimatedMetrics(currentRap, rolimonsRap) {
  const change = percentChange(rolimonsRap, currentRap);
  const split = splitChange(change);

  return {
    estimatedChange: change,
    estimatedProfit: split.profit,
    estimatedLoss: split.loss,
  };
}

function buildRealMetrics(assetId, currentRap) {
  const now = Date.now();

  const point24h = findSnapshotAtOrBefore(assetId, now - 1 * 24 * 60 * 60 * 1000);
  const point7d = findSnapshotAtOrBefore(assetId, now - 7 * 24 * 60 * 60 * 1000);
  const point30d = findSnapshotAtOrBefore(assetId, now - 30 * 24 * 60 * 60 * 1000);
  const point1y = findSnapshotAtOrBefore(assetId, now - 365 * 24 * 60 * 60 * 1000);
  const pointAll = findOldestSnapshot(assetId);

  const change24h = percentChange(point24h?.rap, currentRap);
  const change7d = percentChange(point7d?.rap, currentRap);
  const change30d = percentChange(point30d?.rap, currentRap);
  const change1y = percentChange(point1y?.rap, currentRap);
  const changeAll = percentChange(pointAll?.rap, currentRap);

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
  };
}

function buildCombinedMetrics(assetId, currentRap, rolimonsRap) {
  const real = buildRealMetrics(assetId, currentRap);
  const estimated = buildEstimatedMetrics(currentRap, rolimonsRap);

  return {
    ...real,

    estimatedChange: estimated.estimatedChange,
    estimatedProfit: estimated.estimatedProfit,
    estimatedLoss: estimated.estimatedLoss,

    profit24h: real.profit24h ?? estimated.estimatedProfit,
    profit7d: real.profit7d ?? estimated.estimatedProfit,
    profit30d: real.profit30d ?? estimated.estimatedProfit,
    profit1y: real.profit1y ?? estimated.estimatedProfit,
    profitAllTime: real.profitAllTime ?? estimated.estimatedProfit,

    loss24h: real.loss24h ?? estimated.estimatedLoss,
    loss7d: real.loss7d ?? estimated.estimatedLoss,
    loss30d: real.loss30d ?? estimated.estimatedLoss,
    loss1y: real.loss1y ?? estimated.estimatedLoss,
    lossAllTime: real.lossAllTime ?? estimated.estimatedLoss,

    metricSource24h: real.change24h === null ? "estimated_rolimons" : "real_snapshot",
    metricSource7d: real.change7d === null ? "estimated_rolimons" : "real_snapshot",
    metricSource30d: real.change30d === null ? "estimated_rolimons" : "real_snapshot",
    metricSource1y: real.change1y === null ? "estimated_rolimons" : "real_snapshot",
    metricSourceAll: real.changeAll === null ? "estimated_rolimons" : "real_snapshot",
  };
}

function buildHistoryForClient(assetId, currentRap) {
  const list = snapshotsByAssetId.get(Number(assetId)) || [];

  const history = list.map((point) => ({
    value: point.rap,
    date: new Date(point.time).toISOString(),
  }));

  if (currentRap && currentRap > 0) {
    history.push({
      value: Math.round(currentRap),
      date: new Date().toISOString(),
    });
  }

  return history.slice(-1000);
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
  const text = `${item.name || ""} ${item.acronym || ""}`.toLowerCase();
  return tokens.every((token) => text.includes(token));
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
    items.sort((a, b) => num(b.rap) - num(a.rap));
  } else if (sort === "price_asc") {
    items.sort((a, b) => num(a.lowestPrice || Infinity) - num(b.lowestPrice || Infinity));
  } else if (sort === "price_desc") {
    items.sort((a, b) => num(b.lowestPrice) - num(a.lowestPrice));
  } else if (sort === "deal_desc") {
    items.sort((a, b) => num(b.dealPercent) - num(a.dealPercent));
  } else if (metricKeys[sort]) {
    const key = metricKeys[sort];
    items.sort((a, b) => num(b[key]) - num(a[key]));
  } else {
    items.sort((a, b) => num(b.assetId) - num(a.assetId));
  }

  return items;
}

function buildListItem(base, catalog = {}) {
  const assetId = Number(base.assetId);

  const liveRap = firstPositive(
    catalog.recentAveragePrice,
    catalog.rap,
    base.rolimonsRap
  );

  const lowestPrice = firstNumber(
    catalog.lowestResalePrice,
    catalog.lowestPrice,
    catalog.price,
    base.lowestPrice
  );

  const metrics = buildCombinedMetrics(assetId, liveRap, base.rolimonsRap);

  const dealPercent =
    liveRap && lowestPrice > 0 && lowestPrice < liveRap
      ? Math.round(((liveRap - lowestPrice) / liveRap) * 10000) / 100
      : null;

  return {
    assetId,
    name: String(catalog.name || base.name || "Unknown Limited"),
    acronym: String(base.acronym || ""),
    rap: liveRap,
    rolimonsRap: base.rolimonsRap,
    rolimonsValue: base.rolimonsValue,
    lowestPrice,
    availableCopies: firstNumber(catalog.unitsAvailableForConsumption, base.availableCopies),
    totalCopies: firstPositive(catalog.totalQuantity, base.totalCopies),
    thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
    creatorName: String(catalog.creatorName || base.creatorName || "Roblox"),
    itemType: String(catalog.itemType || base.itemType || "Asset"),
    marketType: "roblox",
    dealPercent,
    ...metrics,
  };
}

async function fetchLimiteds(params) {
  const safe = {
    cursor: String(params.cursor || ""),
    limit: normalizeLimit(params.limit),
    keyword: String(params.keyword || "").slice(0, 80),
    marketType: normalizeMarketType(params.marketType),
    sort: normalizeSort(params.sort),
    minPrice: parseOptionalNumber(params.minPrice),
    maxPrice: parseOptionalNumber(params.maxPrice),
    minRap: parseOptionalNumber(params.minRap),
    maxRap: parseOptionalNumber(params.maxRap),
  };

  const cacheKey = JSON.stringify(safe);
  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < PAGE_CACHE_MS) {
    return cached.data;
  }

  const offset = offsetFromCursor(safe.cursor);
  const tokens = tokenize(safe.keyword);

  let items = await fetchRolimonsItems();
  items = items.filter((item) => matchesTokens(item, tokens));

  if (safe.minRap !== null) items = items.filter((item) => item.rolimonsRap >= safe.minRap);
  if (safe.maxRap !== null) items = items.filter((item) => item.rolimonsRap <= safe.maxRap);

  if (safe.sort === "updated") {
    items.sort((a, b) => b.assetId - a.assetId);
  } else {
    items.sort((a, b) => num(b.rolimonsRap) - num(a.rolimonsRap));
  }

  const scanSize =
    safe.sort === "updated" && safe.keyword === "" && safe.minPrice === null && safe.maxPrice === null
      ? offset + safe.limit
      : Math.min(items.length, Math.max(offset + safe.limit * 4, 120));

  const scanWindow = items.slice(0, scanSize);
  const catalogMap = await fetchCatalogDetailsBatch(scanWindow.map((item) => item.assetId));

  let enriched = scanWindow.map((item) => buildListItem(item, catalogMap.get(item.assetId) || {}));

  enriched = applyFilters(enriched, safe);
  enriched = sortItems(enriched, safe.sort);

  const data = {
    items: enriched.slice(offset, offset + safe.limit),
    nextPageCursor: cursorFromOffset(offset + safe.limit, enriched.length),
    previousPageCursor: offset > 0 ? cursorFromOffset(Math.max(0, offset - safe.limit), enriched.length) : "",
    updatedAt: new Date().toISOString(),
  };

  pageCache.set(cacheKey, {
    fetchedAt: Date.now(),
    data,
  });

  return data;
}

async function fetchItemDetails(assetId, marketType) {
  assetId = Number(assetId);
  if (!assetId || assetId <= 0) return { error: "Invalid assetId." };

  const safeMarketType = normalizeMarketType(marketType);
  const cacheKey = `${safeMarketType}:${assetId}`;
  const cached = detailCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_MS) {
    return cached.data;
  }

  const [resale, economy, catalogMap, rolimonsItems] = await Promise.all([
    fetchResaleData(assetId),
    fetchEconomyDetails(assetId),
    fetchCatalogDetailsBatch([assetId]),
    fetchRolimonsItems().catch(() => []),
  ]);

  const catalog = catalogMap.get(assetId) || {};
  const rolimonsItem = rolimonsItems.find((item) => item.assetId === assetId) || null;
  const collectible = economy.CollectiblesItemDetails || {};

  const liveRap = firstPositive(
    resale.recentAveragePrice,
    economy.RecentAveragePrice,
    collectible.RecentAveragePrice,
    catalog.recentAveragePrice,
    catalog.rap,
    rolimonsItem?.rolimonsRap
  );

  if (liveRap) {
    addSnapshot(assetId, liveRap, Date.now());
    saveSnapshots().catch(() => {});
  }

  const lowestPrice = firstNumber(
    resale.lowestResalePrice,
    collectible.CollectibleLowestResalePrice,
    economy.PriceInRobux,
    catalog.lowestResalePrice,
    catalog.lowestPrice,
    catalog.price
  );

  const metrics = buildCombinedMetrics(assetId, liveRap, rolimonsItem?.rolimonsRap);

  const dealPercent =
    liveRap && lowestPrice > 0 && lowestPrice < liveRap
      ? Math.round(((liveRap - lowestPrice) / liveRap) * 10000) / 100
      : null;

  const data = {
    assetId,
    name: String(catalog.name || economy.Name || rolimonsItem?.name || "Unknown Limited"),
    acronym: String(rolimonsItem?.acronym || ""),
    rap: liveRap,
    rolimonsRap: rolimonsItem?.rolimonsRap || null,
    rolimonsValue: rolimonsItem?.rolimonsValue || null,
    lowestPrice,
    availableCopies: firstNumber(resale.numberRemaining, catalog.unitsAvailableForConsumption),
    totalCopies: firstPositive(collectible.TotalQuantity, catalog.totalQuantity, resale.assetStock),
    thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
    creatorName: String(catalog.creatorName || rolimonsItem?.creatorName || "Roblox"),
    itemType: String(catalog.itemType || rolimonsItem?.itemType || "Asset"),
    marketType: safeMarketType,
    dealPercent,
    history: buildHistoryForClient(assetId, liveRap),
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
      snapshotItems: snapshotsByAssetId.size,
    });
    return;
  }

  if (url.pathname === "/api/limiteds") {
    try {
      const data = await fetchLimiteds({
        cursor: url.searchParams.get("cursor") || "",
        limit: url.searchParams.get("limit") || "30",
        keyword: url.searchParams.get("keyword") || "",
        marketType: url.searchParams.get("type") || "roblox",
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
        url.searchParams.get("type") || "roblox"
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

await loadSnapshots();
runSnapshotJob();
setInterval(runSnapshotJob, SNAPSHOT_INTERVAL_MS);

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
