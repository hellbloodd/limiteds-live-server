// Marketplaces read by the PC booster's hidden browser (GameBoost, Itemku): the booster sends the
// cheapest price per item; we keep them (Supabase rows "market_gameboost" / "market_itemku") and
// offer them to the Flip Finder like G2G/U7BUY. Prices older than 6 hours aren't used.
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";
import { registerMarket, words } from "./markets.mjs";

const MAX_AGE_MS = 6 * 3600 * 1000;
const SEARCH = {
  GameBoost: { "MM2": "murder-mystery-2", "Adopt Me": "adopt-me", "Blade Ball": "blade-ball" },
  Itemku: { "MM2": "murder-mystery-2/weapon", "Adopt Me": "adopt-me/pet", "Blade Ball": "blade-ball-roblox/limited-swords", "Steal a Brainrot": "steal-a-brainrot/item" },
};
const store = {}; // market -> { updatedAt, games }
const rowId = (m) => `market_${m.toLowerCase()}`;

function lookup(market) {
  return (game, name, code = "") => {
    const d = store[market];
    if (!d?.games?.[game] || Date.now() - (Date.parse(d.updatedAt) || 0) > MAX_AGE_MS) return null;
    const base = words(String(name).replace(/ \((No )?Finisher\)$/i, "").replace(/ \([^)]*\)$/, ""));
    const hit = game === "Adopt Me" ? d.games[game][`${base}|${code || "fr"}`] : d.games[game][base];
    if (!hit) return null;
    const q = encodeURIComponent(name.replace(/ \([^)]*\)$/, ""));
    const url = hit.url || (market === "GameBoost" ? `https://gameboost.com/${SEARCH.GameBoost[game]}/items?search=${q}` : `https://www.itemku.com/en/g/${SEARCH.Itemku[game]}?q=${q}`);
    return { usd: hit.usd, offers: hit.offers, rating: hit.rating ?? null, url, age: d.updatedAt };
  };
}

export function startRemoteMarkets() {
  for (const m of Object.keys(SEARCH)) {
    registerMarket(m, lookup(m));
    if (supabaseConfig()) readRow(rowId(m)).then((d) => { if (d?.games && !store[m]) store[m] = d; }).catch(() => {});
  }
}

// From the booster: { market, games: { game: { id: { usd, offers, rating?, url? } } } }
export async function receiveMarket(market, games) {
  if (!SEARCH[market] || !games || typeof games !== "object") return { ok: false };
  const prev = store[market]?.games || {};
  const merged = { ...prev };
  for (const [g, map] of Object.entries(games)) if (SEARCH[market][g] && map && Object.keys(map).length) merged[g] = map; // a failed game keeps its last prices
  store[market] = { updatedAt: new Date().toISOString(), games: merged };
  if (supabaseConfig()) await writeMm2Row(rowId(market), store[market]).catch(() => {});
  return { ok: true, items: Object.values(merged).reduce((n, m) => n + Object.keys(m).length, 0) };
}

export const remoteMarketStatus = () => Object.fromEntries(Object.keys(SEARCH).map((m) => [m, { updatedAt: store[m]?.updatedAt || null,
  items: Object.fromEntries(Object.entries(store[m]?.games || {}).map(([g, x]) => [g, Object.keys(x).length])) }]));
