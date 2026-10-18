// Currency prices: Blade Ball tokens and Robux, per 1,000, on every marketplace.
// - Eldorado (server): its recommended offer, never the cheapest-first list (that's where scams sit).
// - G2G (server): token offers in its Roblox items, cheapest believable one.
// - U7BUY, GameBoost, Itemku: read by the PC booster's hidden browser (Cloudflare), sent here.
// Robux are compared per 1,000 RECEIVED: gamepass offers that don't cover Roblox's 30% tax deliver 700
// per 1,000 bought, so their price is divided by 0.7.
import { readRow, writeMm2Row, supabaseConfig, eldoradoJson } from "./mm2-values.mjs";
import { robustMin } from "./markets.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const EVERY_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 6 * 3600 * 1000; // booster prices older than this aren't shown
export const CURRENCIES = { tokens: "Blade Ball tokens", robux: "Robux" };
// data.markets[market][currency] = { per1k, url, seller?, rating?, note?, at }
let data = { v: 1, markets: {} };

function put(market, currency, entry) {
  if (!(entry?.per1k > 0)) return;
  ((data.markets[market] ||= {})[currency] = { ...entry, per1k: Math.round(entry.per1k * 100) / 100, at: new Date().toISOString() });
}

async function eldorado() {
  // tokens: the first real token packs in Eldorado's Recommended order (same rule as the Blade Ball page)
  const t = await eldoradoJson("/api/v1/item-management/offers?gameId=203&category=Currency&pageIndex=1&pageSize=30&useMinPurchasePrice=false");
  const per1k = [];
  for (const { offer: o } of t?.results || []) {
    const title = o.offerTitle || "";
    if (/spin|limited|sword|explosion|emote|account|coin/i.test(title)) continue;
    const m = title.match(/(\d+(?:[.,]\d{3})*(?:\.\d+)?)\s*(k)?\s*(?:x\s*)?tokens?\b/i);
    if (!m) continue;
    const n = Number(/[.,]\d{3}$/.test(m[1]) && !m[2] ? m[1].replace(/[.,]/g, "") : m[1].replace(",", ".")) * (m[2] ? 1000 : 1);
    const price = o.pricePerUnitInUSD?.amount ?? o.pricePerUnit?.amount;
    if (n > 0 && price > 0) per1k.push(price / n * 1000);
    if (per1k.length === 3) break;
  }
  if (per1k.length) put("Eldorado", "tokens", { per1k: per1k.sort((a, b) => a - b)[per1k.length >> 1], url: "https://www.eldorado.gg/blade-ball-tokens/g/203-0-0", note: "median of the recommended offers" });
  // Robux: the offer Eldorado recommends on its Robux page
  const r = await eldoradoJson("/api/predefinedOffers/game?gameId=70&category=Currency&pageIndex=1&pageSize=1");
  const best = r?.results?.[0];
  const unit = best?.offer?.pricePerUnitInUSD?.amount ?? best?.offer?.pricePerUnit?.amount;
  if (unit > 0) put("Eldorado", "robux", { per1k: unit * 1000, url: "https://www.eldorado.gg/buy-robux/g/70-0-0", seller: best.user?.username,
    rating: best.userOrderInfo?.feedbackScore ? Math.round(best.userOrderInfo.feedbackScore * 10) / 10 : null, note: "Eldorado's recommended offer" });
}

async function g2g() {
  // Blade Ball tokens are sold per token inside G2G's Roblox items ("1 Token · min 500")
  const prices = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(`https://sls.g2g.com/offer/search?seo_term=rbl-item&country=US&currency=USD&sort=lowest_price&page_size=100&page=${page}&filter_attr=b08c318c:941f9c83`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) break;
    const rows = (await r.json())?.payload?.results || [];
    for (const x of rows) {
      const title = String(x.title || "");
      if (!/\btokens?\b/i.test(title) || /coin|spin|sword|emote|explosion/i.test(title)) continue;
      const unit = Number(x.converted_unit_price);
      const per1k = unit < 0.05 ? unit * 1000 : null; // priced per token
      if (!per1k) continue;
      const fa = String(x.offer_group || "").split("/").filter(Boolean).map((g) => g.replace("#", ":")).join("|");
      // single offers have their own page; grouped ones a page listing all sellers
      const url = fa.includes(":") ? `https://www.g2g.com/categories/rbl-item/offer/group?fa=${encodeURIComponent(fa)}&sort=lowest_price` : `https://www.g2g.com/offer/${x.offer_id}`;
      prices.push({ per1k, url });
    }
    if (rows.length < 100) break;
  }
  const best = robustMin(prices.map((p) => p.per1k));
  if (best) put("G2G", "tokens", { ...prices.find((p) => p.per1k === best), per1k: best, note: `cheapest believable of ${prices.length} offers` });
}

export async function refreshCurrency() {
  await Promise.all([eldorado().catch((e) => console.warn(`Currency (Eldorado) failed: ${e.message}`)), g2g().catch((e) => console.warn(`Currency (G2G) failed: ${e.message}`))]);
  if (supabaseConfig()) await writeMm2Row("currency_prices", data).catch(() => {});
}

// From the PC booster: { market: { tokens?: {...}, robux?: {...} } }
export async function receiveCurrency(markets) {
  for (const [market, cur] of Object.entries(markets || {})) {
    if (!["U7BUY", "GameBoost", "Itemku"].includes(market)) continue;
    for (const c of Object.keys(CURRENCIES)) if (cur?.[c]) put(market, c, cur[c]);
  }
  if (supabaseConfig()) await writeMm2Row("currency_prices", data).catch(() => {});
  return { ok: true };
}

export function currencyPrices() {
  const out = {};
  for (const c of Object.keys(CURRENCIES)) {
    out[c] = Object.entries(data.markets).map(([market, cur]) => cur[c] && { market, ...cur[c] })
      .filter((e) => e && Date.now() - Date.parse(e.at) < MAX_AGE_MS).sort((a, b) => a.per1k - b.per1k);
  }
  return { currencies: CURRENCIES, prices: out };
}

export function startCurrency() {
  (async () => {
    if (supabaseConfig()) { const saved = await readRow("currency_prices").catch(() => null); if (saved?.markets) data = saved; }
    await refreshCurrency().catch(() => {});
  })();
  setInterval(() => refreshCurrency().catch(() => {}), EVERY_MS).unref();
}
