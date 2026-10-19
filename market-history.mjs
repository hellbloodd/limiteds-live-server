// Price history on the other marketplaces (G2G, U7BUY, GameBoost, Itemku): every 30 minutes each
// item's cheapest price on each one is recorded like Eldorado's (hourly for 3 days, then daily).
// Stored as one map "<market>|<game>|<item key>" -> points in the sharded Supabase row
// "market_history", so a save only rewrites the parts that changed.
import { readRow, writeChangedRows, supabaseConfig, recordPriceHistory } from "./mm2-values.mjs";
import { otherMarketPrices } from "./markets.mjs";
import { allItems } from "./tools.mjs";

const EVERY_MS = 30 * 60 * 1000;
let hist = null;

async function load() {
  if (hist) return hist;
  hist = (supabaseConfig() ? await readRow("market_history").catch(() => null) : null) || {};
  return hist;
}

async function record(port) {
  await load();
  const prices = {};
  for (const i of await allItems(port)) {
    for (const o of otherMarketPrices(i.game, i.name, i.game === "Adopt Me" ? "fr" : "")) {
      if (o.usd >= (i.usd || o.usd) * 0.35) prices[`${o.market}|${i.game}|${i.key}`] = { usd: o.usd };
    }
  }
  if (!Object.keys(prices).length) return;
  recordPriceHistory(hist, prices);
  if (supabaseConfig()) await writeChangedRows("", { market_history: hist }).catch((e) => console.warn(`Market history save failed: ${e.message}`));
}

// { market: [[day, usd], ...] } for one item
export async function marketHistory(game, key) {
  await load();
  const out = {};
  for (const m of ["G2G", "U7BUY", "GameBoost", "Itemku"]) { const p = hist[`${m}|${game}|${key}`]; if (p?.length) out[m] = p; }
  return out;
}

export function startMarketHistory(port) {
  setTimeout(() => record(port).catch(() => {}), 5 * 60 * 1000).unref();
  setInterval(() => record(port).catch((e) => console.warn(`Market history failed: ${e.message}`)), EVERY_MS).unref();
}
