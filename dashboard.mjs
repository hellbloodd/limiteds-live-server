// Home dashboard numbers: items tracked/listed per game, confirmed Eldorado sales per day and a
// price index per game (median price change of listed items vs 30 days ago), cached for 10 minutes.
import { mm2MarketData } from "./mm2-values.mjs";
import { bbMarketData } from "./bb-values.mjs";
import { amMarketData } from "./am-values.mjs";
import { sbMarketData } from "./sab-values.mjs";
import { allItems } from "./tools.mjs";

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
    // price index: each listed item's price on each day relative to its price at the start
    const series = Object.values(priceHistory).filter((p) => p.length);
    const start = Math.max(today - DAYS, Math.min(today - 1, median(series.map((p) => Math.floor(p[0][0]))) ?? today));
    const index = [];
    for (let d = start; d <= today; d++) {
      const ratios = [];
      for (const p of series) { const a = priceOn(p, start), b = priceOn(p, d); if (a > 0 && b > 0) ratios.push(b / a); }
      if (ratios.length >= 5) index.push([d, Math.round(median(ratios) * 1000) / 10]);
    }
    // confirmed sales per day (count and dollars)
    const perDay = Array.from({ length: 14 }, (_, i) => [today - 13 + i, 0, 0]);
    let sold24h = 0, usd7d = 0;
    const now = Date.now() / 1000;
    for (const list of Object.values(sales)) for (const [ts, usd, qty] of list) {
      const i = Math.floor(ts / 86400) - (today - 13);
      if (i >= 0 && i < 14) { perDay[i][1] += qty; perDay[i][2] += usd * qty; }
      if (ts >= now - 86400) sold24h += qty;
      if (ts >= now - 7 * 86400) usd7d += usd * qty;
    }
    perDay.forEach((r) => { r[2] = Math.round(r[2]); });
    games[game] = { tracked: own.length, listed: own.filter((i) => i.usd > 0).length, sold24h, usd7d: Math.round(usd7d), sales: perDay, index };
  }
  return { at: new Date().toISOString(), games };
}

export async function dashboard(port) {
  if (cache && Date.now() - cache.t < 10 * 60 * 1000) return cache.data;
  const data = await build(port);
  cache = { t: Date.now(), data };
  return data;
}
