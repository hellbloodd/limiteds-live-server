// Discord deal alerts: after each Eldorado price refresh, any item giving at least DEAL_MULT times the
// value per $ of items with a similar value (within 2x) is posted to the webhook in DISCORD_WEBHOOK_URL.
// Comparing with similar-value items matters: on Eldorado expensive items naturally give more value
// per $ than cheap ones, so one game-wide "typical" would flag every expensive item.
// Already-alerted deals are remembered (Supabase row "deal_alerts") and only re-sent if the price
// drops another 10% or a day has passed.
import { readRow, writeMm2Row } from "./mm2-values.mjs";

// DISCORD_WEBHOOK_URL, or any environment variable holding a Discord webhook link.
const isWebhook = (v) => /^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(String(v || "").trim());
const WEBHOOK = (isWebhook(process.env.DISCORD_WEBHOOK_URL) ? process.env.DISCORD_WEBHOOK_URL
  : Object.values(process.env).find(isWebhook) || "").trim();
const DEAL_MULT = Number(process.env.DEAL_MULTIPLIER || 2.5); // x value per $ of similar-value items
const MIN_USD = Number(process.env.DEAL_MIN_USD || 3);        // $1-ish listings are just Eldorado's price floor
const MIN_LISTINGS = 2;                                       // one lone listing isn't a market
const MIN_PEERS = 6;
const MAX_ALERTS_PER_CHECK = 10;
const REALERT_DROP = 0.9;                                    // re-alert if 10% cheaper than last alert
const REALERT_AFTER_MS = 24 * 60 * 60 * 1000;
const SITE = process.env.PUBLIC_SITE_URL || "https://agony-values.onrender.com";

// Our own pages' data, so alerts use exactly the numbers the site shows.
const GAMES = {
  "MM2": { api: "/api/mm2", page: "/mm2", color: 0xd9a441 },
  "Blade Ball": { api: "/api/bladeball", page: "/bladeball", color: 0x4f8cff },
  "Adopt Me": { api: "/api/adoptme", page: "/adoptme", color: 0xff7eb6 },
  "Steal a Brainrot": { api: "/api/stealabrainrot", page: "/stealabrainrot", color: 0x34c17a },
};

let alerted = null; // { "Game|itemKey": { usd, at } }

const fmt = (n) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? Number(n.toFixed(2)).toString() : Number(n.toPrecision(2)).toString());

async function post(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return;
    if (res.status !== 429) throw new Error(`Discord ${res.status}`);
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
    await new Promise((r) => setTimeout(r, wait * 1000 + 250));
  }
}

// Items (with a price) that beat similar-value items by DEAL_MULT, best first: [{ item, times, typical }].
export function findDeals(items) {
  const priced = items.filter((i) => i.valuePerUsd > 0 && i.usd > 0);
  const out = [];
  for (const i of priced) {
    if (i.usd < MIN_USD || (i.listings ?? 0) < MIN_LISTINGS) continue;
    const peers = priced.filter((p) => p !== i && p.value >= i.value / 2 && p.value <= i.value * 2)
      .map((p) => p.valuePerUsd).sort((a, b) => a - b);
    if (peers.length < MIN_PEERS) continue;
    const typical = peers[peers.length >> 1];
    if (i.valuePerUsd >= typical * DEAL_MULT) out.push({ item: i, times: i.valuePerUsd / typical, typical });
  }
  return out.sort((a, b) => b.times - a.times);
}

const gameItems = async (g, port) => (await (await fetch(`http://127.0.0.1:${port}${g.api}`)).json()).items || [];

function embed(game, g, { item: i, times, typical }, test = false) {
  return {
    username: "Agony Values deals",
    embeds: [{
      title: `${test ? "🧪 TEST — " : "🔥 "}${i.name} — ${times.toFixed(1)}× better than similar items`,
      url: i.eldoradoUrl,
      color: g.color,
      thumbnail: i.image ? { url: i.image } : undefined,
      fields: [
        { name: "Game", value: game, inline: true },
        { name: "Value", value: fmt(i.value), inline: true },
        { name: "Cheapest on Eldorado", value: `$${fmt(i.usd)}${i.priceVariant ? ` (${i.priceVariant})` : ""}`, inline: true },
        { name: "Value per $", value: `${fmt(i.valuePerUsd)} (similar items: ${fmt(typical)})`, inline: true },
        { name: "Listings", value: String(i.listings ?? "?"), inline: true },
        { name: "Links", value: `[Buy on Eldorado](${i.eldoradoUrl}) · [Agony Values](${SITE}${g.page})`, inline: false },
      ],
      footer: { text: test ? "Test alert — real alerts look like this." : "Check the listing before buying — prices change fast." },
      timestamp: new Date().toISOString(),
    }],
  };
}

// "Send a test alert": the current best deal across all games (or the best-value item if there are
// none), marked as a test. At most once per 10 minutes.
let lastTest = 0;
export async function sendTestAlert(port) {
  if (!WEBHOOK) return { ok: false, error: "DISCORD_WEBHOOK_URL is not set on the server." };
  if (Date.now() - lastTest < 10 * 60 * 1000) return { ok: false, error: "A test alert was sent less than 10 minutes ago." };
  lastTest = Date.now();
  let best = null;
  for (const [game, g] of Object.entries(GAMES)) {
    const items = await gameItems(g, port).catch(() => []);
    const d = findDeals(items)[0];
    if (d && (!best || d.times > best.d.times)) best = { game, g, d };
  }
  if (!best) {
    const [game, g] = Object.entries(GAMES)[0];
    const items = (await gameItems(g, port)).filter((i) => i.usd > 0).sort((a, b) => b.valuePerUsd - a.valuePerUsd);
    if (!items.length) return { ok: false, error: "No priced items to show yet." };
    best = { game, g, d: { item: items[0], times: 1, typical: items[0].valuePerUsd } };
  }
  await post(embed(best.game, best.g, best.d, true));
  return { ok: true, sent: best.d.item.name };
}

export async function checkDeals(game, port) {
  if (!WEBHOOK || !GAMES[game]) return 0;
  const g = GAMES[game];
  alerted ||= (await readRow("deal_alerts").catch(() => null)) || {};
  const now = Date.now();
  const deals = findDeals(await gameItems(g, port))
    .filter(({ item: i }) => {
      const prev = alerted[`${game}|${i.key}`];
      return !prev || i.usd <= prev.usd * REALERT_DROP || now - prev.at > REALERT_AFTER_MS;
    })
    .slice(0, MAX_ALERTS_PER_CHECK);

  for (const d of deals) {
    const i = d.item;
    await post(embed(game, g, d));
    alerted[`${game}|${i.key}`] = { usd: i.usd, at: now };
  }
  // Forget alerts older than a week so the row stays small.
  for (const [k, v] of Object.entries(alerted)) if (now - v.at > 7 * REALERT_AFTER_MS) delete alerted[k];
  if (deals.length) await writeMm2Row("deal_alerts", alerted);
  return deals.length;
}

export const dealAlertsEnabled = () => Boolean(WEBHOOK);
