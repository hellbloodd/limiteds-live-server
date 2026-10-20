// Biggest gains / drops in average sale price: for each item, the average price of confirmed Eldorado
// sales in the last period (24h, 3d, 7d, 14d) vs the period before it. Sale events are [unix s, usd, qty];
// each sale counts once (a bulk listing of 999 cheap units doesn't outweigh real sales), and with 5+
// sales the top and bottom 10% are dropped so one odd sale can't fake a move. Cached 5 minutes.
import { mm2MarketData } from "./mm2-values.mjs";
import { bbMarketData } from "./bb-values.mjs";
import { amMarketData } from "./am-values.mjs";
import { sbMarketData } from "./sab-values.mjs";
import { allItems } from "./tools.mjs";

const DATA = { "MM2": mm2MarketData, "Blade Ball": bbMarketData, "Adopt Me": amMarketData, "Steal a Brainrot": sbMarketData };
export const PERIODS = { "24h": 1, "3d": 3, "7d": 7, "14d": 14 };
const cache = new Map();

function avg(prices) {
  if (!prices.length) return null;
  const p = [...prices].sort((a, b) => a - b);
  const cut = p.length >= 5 ? Math.floor(p.length * 0.1) : 0;
  const kept = p.slice(cut, p.length - cut);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

async function build(period, port) {
  const days = PERIODS[period];
  const now = Date.now() / 1000, span = days * 86400;
  const byId = new Map((await allItems(port)).map((i) => [`${i.game}|${i.key}`, i]));
  const rows = [];
  let oldest = Infinity;
  for (const [game, get] of Object.entries(DATA)) {
    for (const [key, list] of Object.entries(get().sales || {})) {
      const recent = [], before = [];
      for (const [ts, usd] of list) {
        if (ts < oldest) oldest = ts;
        if (ts >= now - span) recent.push(usd);
        else if (ts >= now - 2 * span) before.push(usd);
      }
      if (!recent.length || !before.length) continue;
      const a = avg(recent), b = avg(before);
      if (!(a > 0 && b > 0)) continue;
      const it = byId.get(`${game}|${key}`);
      rows.push({ game, key, name: it?.name || key, image: it?.image || "", usd: it?.usd ?? null, url: it?.url || "",
        avgNow: Math.round(a * 100) / 100, avgBefore: Math.round(b * 100) / 100, pct: Math.round((a / b - 1) * 1000) / 10,
        salesNow: recent.length, salesBefore: before.length });
    }
  }
  // how far back sales tracking goes (a 14d comparison needs 28 days of sales)
  const trackedDays = isFinite(oldest) ? Math.floor((now - oldest) / 86400) : 0;
  return { period, at: new Date().toISOString(), trackedDays, enoughHistory: trackedDays >= days * 2, rows };
}

export async function saleMovers(period, port) {
  if (!PERIODS[period]) period = "24h";
  const c = cache.get(period);
  if (c && Date.now() - c.t < 5 * 60e3) return c.d;
  const d = await build(period, port);
  cache.set(period, { t: Date.now(), d });
  return d;
}
