// Local/prod backend for the Roblox Limiteds Live UI.
// Run with: node live-limiteds-server.mjs
//
// The Roblox client calls this server, not Roblox marketplace APIs directly.
// Deploy it to a public HTTPS host before using it in a published Roblox game.

const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "snapshot-debug-2026-06-10-1";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300_000);
const ROLIMONS_CACHE_TTL_MS = Number(process.env.ROLIMONS_CACHE_TTL_MS || 600_000);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 60 * 60 * 1000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const SNAPSHOT_SECRET = String(process.env.SNAPSHOT_SECRET || "");
const ROBLOX_CATALOG_URL = "https://catalog.roblox.com/v1/search/items/details";
const ROBLOX_CATALOG_BATCH_URL = "https://catalog.roblox.com/v1/catalog/items/details";
const ROBLOX_RESALE_URL = "https://economy.roblox.com/v1/assets";
const ROLIMONS_ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";
const ALLOWED_LIMITS = [10, 28, 30];

const pageCache = new Map();
const resaleCache = new Map();
const economyCache = new Map();
const catalogDetailCache = new Map();
const detailCache = new Map();
let rolimonsCache = null;
let robloxCsrfToken = "";
let lastSnapshotRunAt = 0;
let lastSnapshotAttemptAt = 0;
let snapshotRunning = false;
let memorySnapshots = [];

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

  return response.json();
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
  const sortType = sort === "price_asc" || sort === "deal_desc" ? "4" : metricSorts.includes(sort) ? "5" : "3";

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
      retries: 2,
      timeoutMs: 5000,
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
    .map((point) => ({
      value: point.value,
      date: String(point.date || ""),
    }))
    .filter((point) => Number.isFinite(Date.parse(point.date)))
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

  const targetTime = Date.now() - days * 24 * 60 * 60 * 1000;
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
  const compactedHistory = compactHistoryByDay(rawHistory).slice(-1000);
  const history = compactedHistory.length >= 2 ? compactedHistory : rawHistory.slice(-1000);

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
    };
  }

  const rap = Number(currentRap);
  const baselineAll = findHistoryBaselineValue(rawHistory, null);
  const baseline24h = findHistoryBaselineValue(rawHistory, 1);
  const baseline7d = findHistoryBaselineValue(rawHistory, 7);
  const baseline30d = findHistoryBaselineValue(rawHistory, 30);
  const baseline1y = findHistoryBaselineValue(rawHistory, 365);
  const changeAll = percentChange(baselineAll, rap);
  const change24h = percentChange(baseline24h, rap);
  const change7d = percentChange(baseline7d, rap);
  const change30d = percentChange(baseline30d, rap);
  const change1y = percentChange(baseline1y, rap);

  return {
    history,
    lossAllTime: changeAll,
    loss24h: change24h,
    loss7d: change7d,
    loss30d: change30d,
    loss1y: change1y,
    profitAllTime: changeAll,
    profit24h: change24h,
    profit7d: change7d,
    profit30d: change30d,
    profit1y: change1y,
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

  return isLossSort ? left - right : right - left;
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
      items = await fetchRolimonsItems();
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
    const rows = pricedItems
      .filter((item) => item.assetId > 0 && item.rap > 0)
      .map((item) => ({
        asset_id: item.assetId,
        name: item.name,
        rap: Math.round(item.rap),
        lowest_price: item.lowestPrice && item.lowestPrice > 0 ? Math.round(item.lowestPrice) : null,
        saved_at: savedAt,
      }));
    let saved;

    try {
      saved = await saveSnapshotRows(rows);
    } catch (error) {
      throw new Error(`Snapshot database save failed: ${error.message}`);
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
  if (SNAPSHOT_INTERVAL_MS <= 0 || snapshotRunning) {
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

async function enrichRolimonsItemsWithCatalogDetails(items) {
  const detailByAssetId = await fetchCatalogDetailsBatch(items.map((item) => item.assetId));

  return items.map((item) => {
    const details = detailByAssetId.get(item.assetId) || {};
    const lowestPrice = firstNumber(
      details.lowestResalePrice,
      details.lowestPrice,
      details.price,
      item.lowestPrice
    );
    const rap = firstPositiveNumber(
      item.rap,
      details.recentAveragePrice
    );

    return {
      ...item,
      rap,
      lowestPrice,
      availableCopies: firstNonNegativeNumber(details.unitsAvailableForConsumption, item.availableCopies),
      totalCopies: firstPositiveNumber(details.totalQuantity, item.totalCopies),
      creatorName: String(details.creatorName || item.creatorName || "Roblox"),
      itemType: String(details.itemType || item.itemType || "Asset"),
      dealPercent: rap && lowestPrice > 0 && lowestPrice < rap
        ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
        : null,
    };
  });
}

async function addHistoryMetrics(item) {
  const resale = await fetchResaleData(item.assetId);
  const ownHistory = await fetchStoredSnapshots(item.assetId);
  const rap = firstPositiveNumber(item.rap, resale.recentAveragePrice);
  const metrics = buildRapChangeMetrics(ownHistory, rap);

  return {
    ...item,
    rap,
    lowestPrice: firstNumber(resale.lowestResalePrice, item.lowestPrice),
    availableCopies: firstNonNegativeNumber(resale.numberRemaining, item.availableCopies),
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
  };
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
    const shouldScanAllMatches = keywordTokens.length > 0 || Boolean(metricKey);
    const scanSize = shouldScanAllMatches
      || sort === "deal_desc"
      ? items.length
      : Math.min(items.length, Math.max(offset + limit * 8, 240));
    const scanWindow = sort === "deal_desc"
      ? interleaveForCoverage(items).slice(0, scanSize)
      : items.slice(0, scanSize);
    const needsLiveResalePrice = !metricKey && (sort === "price_asc" || sort === "price_desc" || sort === "deal_desc");
    let enriched = metricKey
      ? scanWindow
      : needsLiveResalePrice
      ? await enrichRolimonsItemsWithCatalogDetails(scanWindow)
      : await mapWithConcurrency(
        scanWindow,
        8,
        (item) => enrichRolimonsItem(item, false, true)
    );

    if (metricKey) {
      enriched = await addHistoryMetricsBatch(enriched);
      enriched.sort((a, b) => compareChangeMetric(a, b, metricKey, isLossSort));
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
  const dealPercent = rap && lowestPrice > 0 && lowestPrice < rap
    ? Math.round(((rap - lowestPrice) / rap) * 10000) / 100
    : null;
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
    marketType,
  };
}

function isBuyableCollectibleItem(item) {
  return Number(item.rap) > 0 && Number(item.lowestPrice) > 0;
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
  const catalogDetails = marketType === "roblox" && safeAssetId > 0
    ? (await fetchCatalogDetailsBatch([safeAssetId])).get(safeAssetId) || {}
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
  const lowestPrice = firstNumber(
    catalogDetails.lowestResalePrice,
    catalogDetails.lowestPrice,
    collectibleDetails.CollectibleLowestResalePrice,
    details.PriceInRobux,
    resale.lowestResalePrice
  );
  const rap = firstPositiveNumber(
    rolimonsItem?.rap,
    catalogDetails.recentAveragePrice,
    details.RecentAveragePrice,
    collectibleDetails.RecentAveragePrice,
    resale.recentAveragePrice
  );

  const ownHistory = await fetchStoredSnapshots(safeAssetId);
  const saleHistory = normalizeHistoryPoints(resale.priceDataPoints).map((point) => ({
    ...point,
    source: "sale",
  }));
  const metrics = buildRapChangeMetrics(ownHistory, rap);
  const chartHistory = buildRawComparableRapHistory(
    saleHistory.length >= 2 ? saleHistory : ownHistory,
    rap
  );

  const data = {
    assetId: safeAssetId,
    name: String(catalogDetails.name || details.Name || rolimonsItem?.name || "Unknown Limited"),
    rap,
    lowestPrice,
    availableCopies: firstNonNegativeNumber(catalogDetails.unitsAvailableForConsumption, resale.numberRemaining),
    totalCopies: firstPositiveNumber(catalogDetails.totalQuantity, collectibleDetails.TotalQuantity, resale.assetStock),
    creatorName: String(catalogDetails.creatorName || creator.Name || ""),
    thumbnail: `rbxthumb://type=Asset&id=${safeAssetId}&w=420&h=420`,
    history: chartHistory,
    volumeHistory: normalizeHistoryPoints(resale.volumeDataPoints),
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
  const isChangeSort = safeSort.startsWith("loss_") || safeSort.startsWith("profit_");
  const isRobloxPriceSort = safeMarketType === "roblox"
    && (safeSort === "price_asc" || safeSort === "price_desc");
  const isRobloxDealSort = safeMarketType === "roblox" && safeSort === "deal_desc";
  const shouldScanFullWindow = needsMetricScan || hasRangeFilter || keywordTokens.length > 0 || safeMarketType === "ugc";
  const maxPages = isRobloxPriceSort || isRobloxDealSort
    ? 40
    : safeMarketType === "ugc" ? 12 : keywordTokens.length > 0 ? 4 : needsMetricScan || hasRangeFilter ? 5 : 1;

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
        const shouldFetchResaleData = safeMarketType === "ugc" || (isChangeSort && safeMarketType === "roblox" && assetId > 0 && assetId < 10000000000);
        const resale = shouldFetchResaleData ? await fetchResaleData(assetId) : {};
        const builtItem = buildItemFromCatalog(item, resale, safeMarketType);
        const classicItem = classicItemByAssetId?.get(assetId);

        if (classicItem) {
          builtItem.rap = builtItem.rap || classicItem.rap;
          builtItem.name = builtItem.name || classicItem.name;
        }

        if (safeMarketType !== "ugc" || isBuyableCollectibleItem(builtItem)) {
          pageItems.push(builtItem);
        }

        if (shouldFetchResaleData) {
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
    if (safeMarketType === "ugc" && !isBuyableCollectibleItem(item)) return false;
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
    const isLossSort = String(safeSort).startsWith("loss_");

    if (metricKey) {
      collectedItems.sort((a, b) => compareChangeMetric(a, b, metricKey, isLossSort));
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
  maybeRunSnapshotInBackground();

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      version: SERVER_VERSION,
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
  console.log(`Limiteds Live server ${SERVER_VERSION} running on http://localhost:${PORT}`);
});
