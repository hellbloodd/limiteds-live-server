// G2G.com prices: the cheapest offer per item for each game, from G2G's public offer search (Roblox
// items category, filtered by game, cheapest first, grouped per item). Refreshed every 15 minutes;
// G2G has its own request budget, separate from Eldorado's. Kept in Supabase row "g2g_prices".
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";

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
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://sls.g2g.com/offer/search?seo_term=rbl-item&country=US&currency=USD&sort=lowest_price&page_size=${PAGE}&page=${page}&filter_attr=b08c318c:${GAME_IDS[game]}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { if (page > 1 && r.status === 400) break; throw new Error(`G2G ${r.status}`); } // G2G stops paging deep into long lists
    const results = (await r.json())?.payload?.results || [];
    for (const x of results) {
      const usd = Number(x.converted_unit_price);
      const parts = String(x.title || "").split(">").map((p) => p.trim());
      if (!(usd > 0) || parts.length < 2) continue;
      let id = norm(parts[1]);
      if (game === "Adopt Me" && parts[2]) { const code = AM_CODES[parts[2].toLowerCase()]; if (code) id += `|${code}`; }
      if (game === "Steal a Brainrot" && parts.length >= 4 && !/no mutation/i.test(parts[3])) continue; // mutated brainrots are priced differently
      const prev = out[id];
      if (!prev || usd < prev.usd) out[id] = { usd: Math.round(usd * 100) / 100, offers: (prev?.offers || 0) + (x.total_offer || 1) };
      else prev.offers += x.total_offer || 1;
    }
    if (results.length < PAGE) break;
    await new Promise((res) => setTimeout(res, 400));
  }
  return out;
}

export async function g2gRefresh() {
  const games = { ...data.games };
  for (const game of Object.keys(GAME_IDS)) {
    try { games[game] = await fetchG2gGame(game); }
    catch (e) { console.warn(`G2G ${game} prices failed: ${e.message}`); }
  }
  data = { updatedAt: new Date().toISOString(), games };
  if (supabaseConfig()) await writeMm2Row("g2g_prices", data).catch(() => {});
}

export function startG2g() {
  (async () => {
    if (supabaseConfig()) { const saved = await readRow("g2g_prices").catch(() => null); if (saved?.games) data = saved; }
    if (Date.now() - (Date.parse(data.updatedAt) || 0) > EVERY_MS) await g2gRefresh().catch(() => {});
  })();
  setInterval(() => g2gRefresh().catch(() => {}), EVERY_MS).unref();
}

// G2G's cheapest price for one of our items (code: Adopt Me version, e.g. "fr"), or null.
export function g2gPrice(game, name, code = "") {
  const g = data.games[game];
  if (!g) return null;
  const base = norm(String(name).replace(/ \((No )?Finisher\)$/i, ""));
  const hit = (code && g[`${base}|${code}`]) || (!code || code === "fr" ? g[base] : null);
  if (!hit) return null;
  return { ...hit, url: `https://www.g2g.com/search?q=${encodeURIComponent(name.replace(/ \([^)]*\)$/, ""))}` };
}
export const g2gStatus = () => ({ updatedAt: data.updatedAt, items: Object.fromEntries(Object.entries(data.games).map(([g, m]) => [g, Object.keys(m).length])) });
