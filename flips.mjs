// Flip Finder: every item from all four games that has at least two Eldorado listings, with the
// cheapest real listing (buy) and the next one up (what a relist would undercut). The page does the
// profit maths with the user's own seller fee.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
            listings: v.listings, url: v.url, variant: v.label,
            sold24h: fr ? i.sold24h || 0 : 0, sold7d: fr ? i.sold7d || 0 : 0, soldPrice: fr ? i.soldPrice ?? null : null,
            ladder: v.ladder || null, valuePerUsd: v.value ? Math.round(v.value / v.usd * 10) / 10 : null, unit: "",
          });
        }
        continue;
      }
      if (!(i.usd > 0) || !(i.second > i.usd + 0.01)) continue; // no gap to the next listing: never a flip
      rows.push({
        game, page, key: i.key, name: i.name, image: i.image, value: i.value, usd: i.usd, second: i.second,
        listings: i.listings, url: i.eldoradoUrl, variant: i.priceVariant || "",
        sold24h: i.sold24h || 0, sold7d: i.sold7d || 0, soldPrice: i.soldPrice ?? null,
        ladder: i.ladder || null, valuePerUsd: i.valuePerUsd ?? null, unit: "",
      });
    }
  }
  return { pricesUpdatedAt, pricesByGame, count: rows.length, rows };
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
    sendJson(res, 200, cache.body);
    return true;
  }
  return false;
}
