// Home dashboard numbers: items tracked/listed per game, confirmed Eldorado sales per day and a
// price change % per game (median change of a fixed basket of listed items), cached for 10 minutes.
import { mm2MarketData, saleUnits } from "./mm2-values.mjs";
import { bbMarketData } from "./bb-values.mjs";
import { amMarketData } from "./am-values.mjs";
import { sbMarketData } from "./sab-values.mjs";
import { allItems } from "./tools.mjs";
import { loadWarm, saveWarm } from "./warm-store.mjs";

const DATA = { "MM2": mm2MarketData, "Blade Ball": bbMarketData, "Adopt Me": amMarketData, "Steal a Brainrot": sbMarketData };
const DAYS = 30;
let cache = null;

const priceOn = (points, day) => { let p = null; for (const q of points) { if (q[0] < day + 1) p = q[1]; else break; } return p; };
const median = (a) => { if (!a.length) return null; a.sort((x, y) => x - y); return a[a.length >> 1]; };

async function build(port) {
  const items = await allItems(port);
  const today = Math.floor(Date.now() / 864e5);
  const games = {};
  for (const [game, get] of Object.entries(DATA)) {
    const { priceHistory, sales } = get();
    const own = items.filter((i) => i.game === game);
    // price change %: one fixed basket of items (priced $0.50+ at the start AND still listed today),
    // each item's change vs its own start price, then the median - so cheap junk listings, items that
    // came and went, and a few wild outliers can't move the line. Clipped to -90%..+500% per item.
    const series = Object.values(priceHistory).filter((p) => p.length);
    const start = Math.max(today - DAYS, Math.min(today - 1, median(series.map((p) => Math.floor(p[0][0]))) ?? today));
    const basket = series.map((p) => [p, priceOn(p, start)]).filter(([p, a]) => a >= 0.5 && priceOn(p, today) > 0);
    const index = [];
    for (let d = start; d <= today; d++) {
      const ch = basket.map(([p, a]) => Math.min(5, Math.max(-0.9, priceOn(p, d) / a - 1)));
      if (ch.length >= 5) index.push([d, Math.round(median(ch) * 1000) / 10]);
    }
    const basketSize = basket.length;
    // confirmed sales per day (count and dollars)
    const perDay = Array.from({ length: 14 }, (_, i) => [today - 13 + i, 0, 0]);
    let sold24h = 0, usd7d = 0;
    const now = Date.now() / 1000;
    for (const list of Object.values(sales)) for (const [ts, usd, q] of list) {
      const qty = saleUnits(q);
      if (!qty) continue;
      const i = Math.floor(ts / 86400) - (today - 13);
      if (i >= 0 && i < 14) { perDay[i][1] += qty; perDay[i][2] += usd * qty; }
      if (ts >= now - 86400) sold24h += qty;
      if (ts >= now - 7 * 86400) usd7d += usd * qty;
    }
    perDay.forEach((r) => { r[2] = Math.round(r[2]); });
    games[game] = { tracked: own.length, listed: own.filter((i) => i.usd > 0).length, sold24h, usd7d: Math.round(usd7d), sales: perDay, index, basket: basketSize };
  }
  return { at: new Date().toISOString(), games };
}

let building = null;
const rebuild = (port) => (building ||= build(port).then((data) => { cache = { t: Date.now(), data }; saveWarm("dashboard", data); return data; }).finally(() => { building = null; }));

// Stale-while-revalidate: answer from the last build and refresh it in the background.
export async function dashboard(port) {
  if (!cache) return rebuild(port);
  if (Date.now() - cache.t > 10 * 60 * 1000) rebuild(port).catch(() => {});
  return cache.data;
}

export async function preloadDashboard() {
  const data = await loadWarm("dashboard");
  if (data && !cache) cache = { t: 0, data };
}

export function warmDashboard(port) {
  setTimeout(() => rebuild(port).catch(() => {}), 60 * 1000).unref();
}
