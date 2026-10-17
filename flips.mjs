// Flip Finder: every item from all four games that has at least two Eldorado listings, with the
// cheapest real listing (buy) and the next one up (what a relist would undercut). The page does the
// profit maths with the user's own seller fee.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sellerTrust, warmSellers } from "./sellers.mjs";
import { undercutStats } from "./sniper.mjs";
import { otherMarketPrices } from "./markets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAMES = [
  ["MM2", "/api/mm2", "/mm2"],
  ["Blade Ball", "/api/bladeball", "/bladeball"],
  ["Adopt Me", "/api/adoptme", "/adoptme"],
  ["Steal a Brainrot", "/api/stealabrainrot", "/stealabrainrot"],
];
const CACHE_MS = 60 * 1000;
let cache = { at: 0, body: null };

async function collect(port) {
  const rows = [];
  let pricesUpdatedAt = null;
  const pricesByGame = {};
  for (const [game, api, page] of GAMES) {
    const data = await (await fetch(`http://127.0.0.1:${port}${api}`)).json().catch(() => ({ items: [] }));
    pricesByGame[game] = data.pricesUpdatedAt || null;
    if (data.pricesUpdatedAt && (!pricesUpdatedAt || data.pricesUpdatedAt > pricesUpdatedAt)) pricesUpdatedAt = data.pricesUpdatedAt;
    for (const i of data.items || []) {
      // Adopt Me pets: one flip row per version (No Potion, Fly Ride, Neon, Mega Neon...).
      if (i.variants?.length) {
        for (const v of i.variants) {
          if (!(v.usd > 0) || !(v.second > v.usd + 0.01)) continue; // no gap to the next listing: never a flip
          const fr = v.code === "fr"; // sales are tracked for the Fly Ride listings
          rows.push({
            game, page, key: `${i.key}:${v.code}`, name: i.name, image: i.image, value: v.value, usd: v.usd, second: v.second,
            listings: v.listings, url: v.url, variant: v.label, sellers: v.sellers || null,
            sold24h: fr ? i.sold24h || 0 : 0, sold7d: fr ? i.sold7d || 0 : 0, soldPrice: fr ? i.soldPrice ?? null : null,
            ladder: v.ladder || null, valuePerUsd: v.value ? Math.round(v.value / v.usd * 10) / 10 : null, unit: "",
          });
        }
        continue;
      }
      if (!(i.usd > 0) || !(i.second > i.usd + 0.01)) continue; // no gap to the next listing: never a flip
      rows.push({
        game, page, key: i.key, name: i.name, image: i.image, value: i.value, usd: i.usd, second: i.second,
        listings: i.listings, url: i.eldoradoUrl, variant: i.priceVariant || "", sellers: i.sellers || null,
        sold24h: i.sold24h || 0, sold7d: i.sold7d || 0, soldPrice: i.soldPrice ?? null,
        ladder: i.ladder || null, valuePerUsd: i.valuePerUsd ?? null, unit: "",
      });
    }
  }
  // Other marketplaces: buying there and relisting 1¢ under Eldorado's cheapest is a flip too.
  for (const r of [...rows]) {
    const code = r.game === "Adopt Me" ? (String(r.key).split(":")[1] || "fr") : "";
    // under 35% of Eldorado's price it's almost always a different item or a fake listing: ignored
    const others = otherMarketPrices(r.game, r.name, code).filter((o) => o.usd >= r.usd * 0.35);
    if (!others.length) continue;
    r.others = others.map((o) => ({ market: o.market, usd: o.usd, url: o.url, rating: o.rating ?? null })); // shown next to the Eldorado price
    for (const o of others) {
      if (!(o.usd < r.usd - 0.01)) continue;
      rows.push({ ...r, key: `${r.key}@${o.market}`, market: `${o.market} → Eldorado`, buyMarket: o.market, usd: o.usd, second: r.usd,
        url: o.url, sellUrl: r.url, ladder: [o.usd, ...(r.ladder || [r.usd])].slice(0, 5), sellers: null, others: null,
        buyRating: o.rating ?? null, eldoradoUsd: r.usd });
    }
  }
  return { pricesUpdatedAt, pricesByGame, count: rows.length, rows };
}

// The page's filters, applied here so only matching rows are sent (the full list is several MB).
// Each row also gets its sellers' trust and how often the item gets undercut (from the sniper).
function filterRows(body, q) {
  const num = (k, d) => (q.has(k) && q.get(k) !== "" && !Number.isNaN(Number(q.get(k))) ? Number(q.get(k)) : d);
  const fee = num("fee", 10) / 100, minProfit = num("minProfit", -Infinity), minRoi = num("minRoi", -Infinity);
  const minListings = num("minListings", 0), minSold = num("minSold", 0), game = q.get("game") || "";
  const rows = body.rows.filter((r) => {
    if (game && r.game !== game) return false;
    const profit = (r.second - 0.01) * (1 - fee) - r.usd;
    return profit >= minProfit && profit / r.usd * 100 >= minRoi && (r.listings ?? 0) >= minListings && r.sold7d >= minSold;
  }).map((r) => ({ ...r, trust: [sellerTrust(r.sellers?.[0]), sellerTrust(r.sellers?.[1])], undercut: undercutStats(r.game, r.key) }));
  // look up the sellers we don't know yet, best flips first
  warmSellers(rows.sort((a, b) => ((b.second - 0.01) * (1 - fee) - b.usd) - ((a.second - 0.01) * (1 - fee) - a.usd)).slice(0, 300)
    .flatMap((r) => r.sellers || []).filter(Boolean));
  return { ...body, total: body.rows.length, count: rows.length, rows };
}

// Returns true if the request was handled.
export async function handleFlipsRequest(url, res, sendJson, port) {
  if (url.pathname === "/flips" || url.pathname === "/flips/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(join(HERE, "flips.html"), "utf8"));
    return true;
  }
  if (url.pathname === "/api/flips") {
    // ?fresh=1 (used while "Refresh now" waits for new prices) skips the 1-minute cache
    if (!cache.body || url.searchParams.has("fresh") || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), body: await collect(port) };
    sendJson(res, 200, filterRows(cache.body, url.searchParams));
    return true;
  }
  return false;
}
