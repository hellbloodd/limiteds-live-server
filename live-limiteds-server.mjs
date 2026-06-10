    headers: {
      Accept: "application/json",
      "User-Agent": "LimitedsLiveMarketViewer/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

function buildCatalogUrl({ cursor, limit, keyword }) {
  const url = new URL(ROBLOX_CATALOG_URL);

  // The details endpoint does not accept Category=Collectibles.
  // Accessories + salesTypeFilter=2 returns collectible/resellable catalog items.
  url.searchParams.set("category", "Accessories");
  url.searchParams.set("salesTypeFilter", "2");
  url.searchParams.set("sortType", "3");
  url.searchParams.set("limit", String(limit));

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

async function fetchCatalogPage({ cursor = "", limit = 30, keyword = "" }) {
  const safeLimit = normalizeLimit(limit);
  const safeKeyword = String(keyword || "").slice(0, 80);
  const cacheKey = `${safeKeyword}:${cursor}:${safeLimit}`;
  const cached = pageCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const catalog = await fetchJson(buildCatalogUrl({
    cursor,
    limit: safeLimit,
    keyword: safeKeyword,
  }));
  const rawItems = Array.isArray(catalog.data) ? catalog.data : [];

  const items = await Promise.all(
    rawItems.map(async (item) => {
      const assetId = normalizeNumber(item.id || item.assetId);
      const resale = assetId > 0 ? await fetchResaleData(assetId) : {};
      const lowestPrice = firstNumber(
        item.lowestPrice,
        item.lowestResalePrice,
        item.price,
        resale.lowestResalePrice,
        item.priceStatus === "Off Sale" ? 0 : undefined
      );
      const rap = firstNumber(
        item.recentAveragePrice,
        item.rap,
        resale.recentAveragePrice
      );

      return {
        assetId,
        name: String(item.name || item.itemName || "Unknown Limited"),
        rap,
        lowestPrice,
        thumbnail: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`,
      };
    })
  );

  const data = {
    items: items.filter((item) => item.assetId > 0),
    nextPageCursor: catalog.nextPageCursor || "",
    previousPageCursor: catalog.previousPageCursor || "",
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
