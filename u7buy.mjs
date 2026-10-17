// U7BUY prices: every offer in each game's shop (100 a page, USD) from U7BUY's own API, matched
// to our items by title. Refreshed every 15 minutes; kept in Supabase row "u7buy_prices".
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";
import { registerMarket, nameIndex, matchTitle, amCode, words, robustMin, listingHasFinisher, itemIsFinisher, finKey } from "./markets.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SHOPS = { // game -> [spuId, shop page]
  "MM2": ["1888155406422889968", "https://www.u7buy.com/murder-mystery-2/shop"],
  "Adopt Me": ["1888155406422888618", "https://www.u7buy.com/adopt-me/adopt-me-items"],
  "Blade Ball": ["1888155406422890298", "https://www.u7buy.com/blade-ball/swords"],
  "Steal a Brainrot": ["1932643522747043841", "https://www.u7buy.com/steal-a-brainrot/steal-a-brainrot-items"],
};
const API = { "MM2": "/api/mm2", "Blade Ball": "/api/bladeball", "Adopt Me": "/api/adoptme", "Steal a Brainrot": "/api/stealabrainrot" };
const EVERY_MS = 15 * 60 * 1000, PAGE = 100, MAX_PAGES = 80;
let data = { updatedAt: null, games: {} }; // games[game][words(name) or +"|code"] = { usd, offers, rating }

export async function fetchU7Game(game, items) {
  const index = nameIndex(items);
  const out = {};
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.u7buy.com/prod-api/product/urlMapping/game-service/getOtherBusinessSpuInfoShowVo?pageNum=${page}&spuId=${SHOPS[game][0]}&sort=100&pageSize=${PAGE}&currency=USD`;
    // MM2's shop is big and its pages can be slow from the server: 60 s each, 3 tries, and a page
    // that still fails is skipped instead of losing the whole game
    let rows = null;
    for (let attempt = 1; attempt <= 3 && !rows; attempt++) {
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        rows = (await r.json())?.data?.pageList?.rows || [];
      } catch (e) { if (attempt === 3) console.warn(`U7BUY ${game} page ${page} skipped: ${e.message}`); else await new Promise((res) => setTimeout(res, 3000 * attempt)); }
    }
    if (!rows) continue;
    for (const o of rows) {
      const usd = Number(o.priceUsdDouble);
      const name = usd > 0 && matchTitle(o.offerName, index);
      if (!name) continue;
      let id = words(name);
      if (game === "Adopt Me") { const code = amCode(o.offerName); if (!code) continue; id += `|${code}`; }
      if (game === "Blade Ball") id = finKey(id, listingHasFinisher(o.offerName));
      if (game === "Steal a Brainrot" && /mutation|gold|diamond|rainbow|lava|galaxy|candy|bloodrot|radioactive/i.test(o.offerName) && !/no mutation/i.test(o.offerName)) continue;
      const rating = Number(o.remoteStoreDetail?.favorableRate) || null, sold = o.remoteStoreDetail?.completedNum || 0;
      const link = `https://www.u7buy.com/offer/other-detail?spuId=${SHOPS[game][0]}&offerId=${o.offerId}&businessId=${o.businessId}&isEntrance=0`;
      (out[id] ||= { all: [] }).all.push([usd, rating, sold, link]);
    }
    if (rows.length < PAGE) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  for (const [id, o] of Object.entries(out)) {
    const usd = robustMin(o.all.map((x) => x[0]));
    const best = o.all.find((x) => x[0] === usd);
    out[id] = { usd: Math.round(usd * 100) / 100, offers: o.all.length, rating: best?.[1] ?? null, sold: best?.[2] ?? 0, url: best?.[3] || null };
  }
  return out;
}

let u7Running = null;
export function u7RefreshNow(port) { return (u7Running ||= u7Refresh(port).finally(() => { u7Running = null; })); }
export async function u7Refresh(port) {
  const games = { ...data.games };
  for (const game of Object.keys(SHOPS)) {
    try {
      // right after a restart our own game data may still be loading: wait for it (up to ~3 min)
      let items = [];
      for (let attempt = 0; attempt < 4 && !items.length; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 60000));
        items = (await (await fetch(`http://127.0.0.1:${port}${API[game]}`, { signal: AbortSignal.timeout(60000) })).json()).items || [];
      }
      if (!items.length) console.warn(`U7BUY ${game}: no items from our own API yet - skipped this round`);
      if (items.length) { games[game] = await fetchU7Game(game, items); console.warn(`U7BUY ${game}: ${Object.keys(games[game]).length} items priced`); }
    } catch (e) { console.warn(`U7BUY ${game} prices failed: ${e.message}`); }
  }
  data = { v: 4, updatedAt: new Date().toISOString(), games };
  if (supabaseConfig()) await writeMm2Row("u7buy_prices", data).catch(() => {});
}

export function u7Price(game, name, code = "") {
  const g = data.games[game];
  if (!g) return null;
  const base = words(String(name).replace(/ \((No )?Finisher\)$/i, "").replace(/ \([^)]*\)$/, ""));
  const hit = game === "Adopt Me" ? g[`${base}|${code || "fr"}`] : g[game === "Blade Ball" ? finKey(base, itemIsFinisher(name)) : base];
  if (!hit) return null;
  return { ...hit, url: hit.url || `${SHOPS[game][1]}?keyword=${encodeURIComponent(name.replace(/ \([^)]*\)$/, ""))}` }; // the exact offer
}

export function startU7(port) {
  registerMarket("U7BUY", u7Price);
  (async () => {
    if (supabaseConfig()) { const saved = await readRow("u7buy_prices").catch(() => null); if (saved?.games && saved.v === 4) data = saved; } // v3: exact offer links
    await new Promise((r) => setTimeout(r, 2 * 60 * 1000)); // let the game data load first
    if (Date.now() - (Date.parse(data.updatedAt) || 0) > EVERY_MS) await u7Refresh(port).catch(() => {});
  })();
  setInterval(() => u7RefreshNow(port).catch(() => {}), EVERY_MS).unref();
}
export const u7Status = () => ({ updatedAt: data.updatedAt, items: Object.fromEntries(Object.entries(data.games).map(([g, m]) => [g, Object.keys(m).length])) });
