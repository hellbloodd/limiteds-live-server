// G2G.com prices: the cheapest offer per item for each game, from G2G's public offer search (Roblox
// items category, filtered by game, cheapest first, grouped per item). Refreshed every 15 minutes;
// G2G has its own request budget, separate from Eldorado's. Kept in Supabase row "g2g_prices".
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";
import { registerMarket, listingHasFinisher, itemIsFinisher, finKey, pagesInParallel } from "./markets.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const GAME_IDS = { "MM2": "928871b7", "Blade Ball": "941f9c83", "Adopt Me": "150df5a4", "Steal a Brainrot": "7840f705" };
const EVERY_MS = 15 * 60 * 1000;
const PAGE = 100, MAX_PAGES = 40;
// Adopt Me versions as G2G writes them -> our trait codes
const AM_CODES = { "fr": "fr", "nfr": "nfr", "mfr": "mfr", "f": "f", "r": "r", "n": "n", "m": "m", "nf": "nf", "nr": "nr", "mf": "mf", "mr": "mr",
  "no potion": "none", "np": "none", "normal": "none", "neon": "n", "mega": "m", "mega neon": "m" };

export const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "");
let data = { updatedAt: null, games: {} }; // games[game][normName or normName|code] = { usd, offers }

export async function fetchG2gGame(game) {
  const out = {};
  const getPage = async (page) => {
    const url = `https://sls.g2g.com/offer/search?seo_term=rbl-item&country=US&currency=USD&sort=lowest_price&page_size=${PAGE}&page=${page}&filter_attr=b08c318c:${GAME_IDS[game]}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { if (page > 1 && r.status === 400) return null; throw new Error(`G2G ${r.status}`); } // G2G stops paging deep into long lists
    return (await r.json())?.payload?.results || [];
  };
  if (!(await getPage(1).catch(() => null))) throw new Error("G2G unreachable");
  await pagesInParallel(getPage, { pageSize: PAGE, maxPages: MAX_PAGES, parallel: 4, onRows: (results) => {
    for (const x of results) {
      const usd = Number(x.converted_unit_price);
      const parts = String(x.title || "").split(">").map((p) => p.trim());
      if (!(usd > 0) || parts.length < 2) continue;
      // MM2 names on G2G carry the type and year ("Icepiercer Gun 2022"); ours don't
      let id = norm(game === "MM2" ? parts[1].replace(/\b(19|20)\d{2}\b/g, "").replace(/\b(gun|knife)\s*$/i, "") : parts[1]);
      if (game === "Adopt Me" && parts[2]) { const code = AM_CODES[parts[2].toLowerCase()]; if (code) id += `|${code}`; }
      if (game === "Blade Ball") id = finKey(id, listingHasFinisher(x.title));
      if (game === "Steal a Brainrot" && parts.length >= 4 && !/no mutation/i.test(parts[3])) continue; // mutated brainrots are priced differently
      // the item's G2G page with all its sellers, cheapest first
      const fa = String(x.offer_group || "").split("/").filter(Boolean).map((g) => g.replace("#", ":")).join("|");
      const url = fa ? `https://www.g2g.com/categories/rbl-item/offer/group?fa=${encodeURIComponent(fa)}&sort=lowest_price` : null;
      const prev = out[id];
      if (!prev || usd < prev.usd) out[id] = { usd: Math.round(usd * 100) / 100, offers: (prev?.offers || 0) + (x.total_offer || 1), url };
      else prev.offers += x.total_offer || 1;
    }
  } });
  return out;
}

let g2gRunning = null;
export function g2gRefreshNow() { return (g2gRunning ||= g2gRefresh().finally(() => { g2gRunning = null; })); }
export async function g2gRefresh() {
  const games = { ...data.games };
  await Promise.all(Object.keys(GAME_IDS).map(async (game) => { // all four games at once
    try { games[game] = await fetchG2gGame(game); }
    catch (e) { console.warn(`G2G ${game} prices failed: ${e.message}`); }
  }));
  data = { v: 3, updatedAt: new Date().toISOString(), games };
  if (supabaseConfig()) await writeMm2Row("g2g_prices", data).catch(() => {});
}

export function startG2g() {
  registerMarket("G2G", g2gPrice);
  (async () => {
    if (supabaseConfig()) { const saved = await readRow("g2g_prices").catch(() => null); if (saved?.games && saved.v === 3) data = saved; } // v2: exact listing links + MM2 names
    if (Date.now() - (Date.parse(data.updatedAt) || 0) > EVERY_MS) await g2gRefresh().catch(() => {});
  })();
  setInterval(() => g2gRefreshNow().catch(() => {}), EVERY_MS).unref();
}

// G2G's cheapest price for one of our items (code: Adopt Me version, e.g. "fr"), or null.
export function g2gPrice(game, name, code = "") {
  const g = data.games[game];
  if (!g) return null;
  const base = norm(String(name).replace(/ \((No )?Finisher\)$/i, ""));
  const hit = game === "Blade Ball" ? g[finKey(base, itemIsFinisher(name))] : (code && g[`${base}|${code}`]) || (!code || code === "fr" ? g[base] : null);
  if (!hit) return null;
  return { ...hit, url: hit.url || `https://www.g2g.com/search?q=${encodeURIComponent(name.replace(/ \([^)]*\)$/, ""))}` };
}
export const g2gStatus = () => ({ updatedAt: data.updatedAt, items: Object.fromEntries(Object.entries(data.games).map(([g, m]) => [g, Object.keys(m).length])) });
