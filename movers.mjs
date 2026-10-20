// Biggest gains / drops in average sale price: for each item, the average price of confirmed Eldorado
// sales in the last period (24h, 3d, 7d, 14d) vs the period before it. Sale events are [unix s, usd, qty];
// each sale counts once (a bulk listing of 999 cheap units doesn't outweigh real sales), and with 5+
// sales the top and bottom 10% are dropped so one odd sale can't fake a move; sales 4x away from the
// item's median sale are ignored. Cached 5 minutes.
import { mm2MarketData } from "./mm2-values.mjs";
import { bbMarketData } from "./bb-values.mjs";
import { amMarketData } from "./am-values.mjs";
import { sbMarketData } from "./sab-values.mjs";
import { allItems } from "./tools.mjs";
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";
import { cheapestElsewhere } from "./markets.mjs";
import { listingDepth } from "./updater.mjs";
import { post, SITE, fmt } from "./deals.mjs";
import { notifyPhones } from "./push.mjs";

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
      // sales far from the item's typical sale price (4x above or below the median of all its sales)
      // are troll / mis-tagged listings, not the market moving
      const all = list.map((e) => e[1]).filter((u) => u > 0).sort((x, y) => x - y);
      const mid = all[all.length >> 1];
      for (const [ts, usd] of list) {
        if (ts < oldest) oldest = ts;
        if (!(usd > 0) || usd > mid * 4 || usd < mid / 4) continue;
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
  // right after a restart the sales aren't loaded yet: say so, and don't keep that answer
  if (!d.rows.length && !d.trackedDays) return { ...d, error: "Sales are still loading after a restart — try again in a minute." };
  cache.set(period, { t: Date.now(), d });
  return d;
}

// ---------- one item's confirmed sales (sell-time estimate in the item preview) ----------
export function itemSales(game, key) {
  const list = DATA[game]?.().sales?.[key] || [];
  return list.map(([ts, usd, qty]) => [ts, usd, qty || 1]);
}

// ---------- deals measured against what items actually sell for ----------
// under: cheapest listing anywhere well below the typical (median) sale price of the last 7 days.
// bulk: buying the cheapest 3 / 5 / 10 units (from the last Eldorado check) and reselling them at the
// typical sale price still pays, and the item sells often enough to move that many in a week.
const SELL_FEE = 0.10;
let dealsCache = null;
export async function marketDeals(port) {
  if (dealsCache && Date.now() - dealsCache.t < 5 * 60e3) return dealsCache.d;
  const items = await allItems(port);
  const under = [], bulk = [];
  for (const i of items) {
    if (!(i.soldPrice > 0) || (i.sold7d || 0) < 3) continue;
    const offers = [...(i.usd > 0 ? [["Eldorado", i.usd, i.url]] : []), ...cheapestElsewhere(i.game, i.name, i.game === "Adopt Me" ? "fr" : "", i.usd)].sort((a, b) => a[1] - b[1]);
    const best = offers[0];
    // under 30% of the typical sale is almost always a different item matched by name, or a scam listing
    if (best && best[1] <= i.soldPrice * 0.75 && best[1] >= i.soldPrice * 0.3) {
      const profit = i.soldPrice * (1 - SELL_FEE) - best[1];
      if (profit >= 0.5) under.push({ game: i.game, key: i.key, name: i.name, image: i.image, buy: best[1], market: best[0], url: best[2], soldPrice: i.soldPrice, sold7d: i.sold7d,
        below: Math.round((1 - best[1] / i.soldPrice) * 1000) / 10, profit: Math.round(profit * 100) / 100 });
    }
    const depth = listingDepth(i.game, i.key);
    if (!depth?.offers?.length) continue;
    let bestN = null;
    for (const n of [3, 5, 10]) {
      if (i.sold7d < n) break; // not enough buyers to resell that many within a week
      let left = n, cost = 0;
      for (const [p, u] of depth.offers) { const t = Math.min(u, left); cost += t * p; left -= t; if (!left) break; }
      if (left) break; // fewer units listed than that
      if (cost / n < i.soldPrice * 0.3) break; // that cheap is a mis-tagged item or a scam, not a deal
      const resale = n * i.soldPrice * (1 - SELL_FEE), profit = resale - cost;
      if (profit > 0 && profit / cost >= 0.15 && (!bestN || profit > bestN.profit)) bestN = { n, cost: Math.round(cost * 100) / 100, profit: Math.round(profit * 100) / 100, roi: Math.round(profit / cost * 1000) / 10 };
    }
    if (bestN) bulk.push({ game: i.game, key: i.key, name: i.name, image: i.image, url: i.url, soldPrice: i.soldPrice, sold7d: i.sold7d, cheapest: depth.offers[0][0], ...bestN });
  }
  under.sort((a, b) => b.profit - a.profit);
  bulk.sort((a, b) => b.profit - a.profit);
  const d = { at: new Date().toISOString(), fee: SELL_FEE, under: under.slice(0, 150), bulk: bulk.slice(0, 150) };
  if (items.length) dealsCache = { t: Date.now(), d };
  return d;
}

// ---------- alerts: average sale price jumped or dropped a lot in 24h ----------
// Checked every 30 minutes; Discord + phone for the biggest moves (items selling at $2+, 3+ sales in
// both days, 40%+ move). An item is announced again only after 12 hours and a further 15-point move.
const ALERT_MIN_PCT = Number(process.env.MOVER_ALERT_PCT) || 40;
let fired = null;
async function checkMoverAlerts(port) {
  fired ||= (supabaseConfig() ? await readRow("mover_alerts").catch(() => null) : null) || {};
  const d = await saleMovers("24h", port);
  if (!d.rows?.length) return;
  const now = Date.now();
  const hits = d.rows.filter((r) => r.salesNow >= 3 && r.salesBefore >= 3 && Math.max(r.avgNow, r.avgBefore) >= 2 && Math.abs(r.pct) >= ALERT_MIN_PCT)
    .filter((r) => { const f = fired[`${r.game}|${r.key}`]; return !f || (now - f.at > 12 * 3600e3 && Math.abs(r.pct - f.pct) >= 15) || Math.sign(f.pct) !== Math.sign(r.pct); })
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 5);
  for (const r of hits) {
    fired[`${r.game}|${r.key}`] = { at: now, pct: r.pct };
    const up = r.pct > 0, page = { "MM2": "/mm2", "Blade Ball": "/bladeball", "Adopt Me": "/adoptme", "Steal a Brainrot": "/stealabrainrot" }[r.game];
    await post({
      username: "Agony Values movers",
      embeds: [{
        title: `${up ? "🚀" : "📉"} ${r.name}: average sale price ${up ? "+" : ""}${r.pct}% in 24h`,
        url: `${SITE}${page}?item=${encodeURIComponent(r.key)}`, color: up ? 0x34f5a6 : 0xff5c8a, thumbnail: r.image ? { url: r.image } : undefined,
        fields: [
          { name: "Game", value: r.game, inline: true },
          { name: "Avg sale", value: `$${fmt(r.avgBefore)} → $${fmt(r.avgNow)}`, inline: true },
          { name: "Sales", value: `${r.salesBefore} → ${r.salesNow}`, inline: true },
          { name: "Cheapest now", value: r.usd ? `$${fmt(r.usd)}` : "—", inline: true },
          { name: "Links", value: `${r.url ? `[Eldorado](${r.url}) · ` : ""}[All movers](${SITE}/movers)`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});
    notifyPhones({ title: `${up ? "🚀" : "📉"} ${r.name} ${up ? "+" : ""}${r.pct}% (24h sales)`, body: `Avg sale $${fmt(r.avgBefore)} → $${fmt(r.avgNow)} · ${r.game}`,
      url: `${SITE}${page}?item=${encodeURIComponent(r.key)}`, image: r.image, tag: `mover-${r.game}-${r.key}` }).catch(() => {});
  }
  for (const [k, f] of Object.entries(fired)) if (now - f.at > 7 * 864e5) delete fired[k];
  if (hits.length && supabaseConfig()) await writeMm2Row("mover_alerts", fired).catch(() => {});
}
export function startMoverAlerts(port) {
  setTimeout(() => checkMoverAlerts(port).catch((e) => console.warn(`Mover alerts: ${e.message}`)), 10 * 60e3).unref();
  setInterval(() => checkMoverAlerts(port).catch((e) => console.warn(`Mover alerts: ${e.message}`)), 30 * 60e3).unref();
}
