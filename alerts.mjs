// Price alerts set by the owner: "tell me when <item> is at or under $X". Checked every 2 minutes
// against the latest prices (Eldorado, and optionally every other marketplace); a hit goes to
// Discord and the phone. An alert fires again only if the price drops further or 12 hours passed.
// Stored in Supabase row "price_alerts".
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";
import { GAMES, gameItems, post, SITE, fmt, valueField } from "./deals.mjs";
import { otherMarketPrices } from "./markets.mjs";
import { notifyPhones } from "./push.mjs";

const EVERY_MS = 2 * 60 * 1000;
const REFIRE_MS = 12 * 3600 * 1000;
let alerts = null; // [{ id, game, key, name, image, target, markets: "eldorado" | "any", createdAt, fired? }]

async function load() {
  if (alerts) return alerts;
  alerts = (supabaseConfig() ? await readRow("price_alerts").catch(() => null) : null) || [];
  return alerts;
}
const save = () => (supabaseConfig() ? writeMm2Row("price_alerts", alerts) : Promise.resolve());

export async function listAlerts(port) {
  await load();
  // with the current price, so the page shows how close each one is
  const byGame = {};
  for (const g of new Set(alerts.map((a) => a.game))) byGame[g] = new Map((await gameItems(GAMES[g], port).catch(() => [])).map((i) => [String(i.key), i]));
  return alerts.map((a) => {
    const i = byGame[a.game]?.get(String(a.key));
    const best = bestPrice(a, i);
    return { ...a, now: best?.usd ?? null, nowMarket: best?.market ?? null, nowUrl: best?.url ?? null };
  });
}

export async function addAlert(b) {
  await load();
  const target = Math.round(Number(b?.target) * 100) / 100;
  if (!GAMES[b?.game] || !b?.key || !b?.name || !(target > 0)) throw new Error("Pick an item and a price.");
  const a = { id: Math.random().toString(36).slice(2, 10), game: b.game, key: String(b.key), name: String(b.name).slice(0, 80), image: String(b.image || "").slice(0, 400),
    target, markets: b.markets === "any" ? "any" : "eldorado", createdAt: Date.now() };
  alerts = alerts.filter((x) => !(x.game === a.game && x.key === a.key && x.markets === a.markets)); // one per item + market choice
  alerts.push(a);
  await save();
  return a;
}

export async function removeAlert(id) {
  await load();
  alerts = alerts.filter((a) => a.id !== id);
  await save();
  return { ok: true };
}

// The cheapest price an alert watches: Eldorado's cheapest, or the cheapest on any marketplace.
function bestPrice(a, i) {
  if (!i) return null;
  const list = i.usd > 0 ? [{ market: "Eldorado", usd: i.usd, url: i.cheapestUrl || i.eldoradoUrl }] : [];
  if (a.markets === "any") {
    const code = a.game === "Adopt Me" ? "fr" : "";
    for (const o of otherMarketPrices(a.game, i.name, code)) if (o.usd >= (i.usd || o.usd) * 0.35) list.push({ market: o.market, usd: o.usd, url: o.url, rating: o.rating });
  }
  return list.sort((x, y) => x.usd - y.usd)[0] || null;
}

async function check(port) {
  await load();
  if (!alerts.length) return;
  let changed = false;
  for (const g of new Set(alerts.map((a) => a.game))) {
    const items = new Map((await gameItems(GAMES[g], port).catch(() => [])).map((i) => [String(i.key), i]));
    for (const a of alerts.filter((x) => x.game === g)) {
      const i = items.get(String(a.key));
      const best = bestPrice(a, i);
      if (!best || best.usd > a.target) continue;
      const f = a.fired;
      if (f && best.usd >= f.usd - 0.005 && Date.now() - f.at < REFIRE_MS) continue; // already told at this price
      a.fired = { usd: best.usd, at: Date.now(), market: best.market };
      changed = true;
      await post({
        username: "Agony Values price alert",
        embeds: [{
          title: `🔔 ${a.name} is $${fmt(best.usd)} on ${best.market} — your alert: $${fmt(a.target)}`,
          url: best.url || `${SITE}${GAMES[g].page}`, color: 0xf5b400, thumbnail: (a.image || i.image) ? { url: a.image || i.image } : undefined,
          fields: [
            { name: "Game", value: g, inline: true },
            { name: "Price now", value: `$${fmt(best.usd)} (${best.market})${best.rating ? ` · seller ${best.rating}%` : ""}`, inline: true },
            { name: "Your target", value: `$${fmt(a.target)}`, inline: true },
            valueField(i, best.usd),
            { name: "Next listing", value: i.second ? `$${fmt(i.second)}` : "—", inline: true },
            { name: "Links", value: `[Buy on ${best.market}](${best.url || SITE}) · [My alerts](${SITE}/alerts)`, inline: false },
          ],
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});
      notifyPhones({ title: `🔔 ${a.name} — $${fmt(best.usd)} on ${best.market}`, body: `Your alert: $${fmt(a.target)} or less\n💎 Value ${valueField(i, best.usd).value}`,
        url: best.url || `${SITE}/alerts`, image: a.image || i.image, tag: `alert-${a.id}` }).catch(() => {});
    }
  }
  if (changed) await save().catch(() => {});
}

export function startAlerts(port) {
  setInterval(() => check(port).catch((e) => console.warn(`Price alerts check failed: ${e.message}`)), EVERY_MS).unref();
}
export const checkAlertsNow = (port) => check(port); // tests
