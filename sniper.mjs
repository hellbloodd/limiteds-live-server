// New-listing sniper. Eldorado can't sort listings by newest, but a mispriced new listing jumps to the
// top of the cheapest-first list for its item. So every SNIPE_EVERY_S seconds we re-read the 5
// cheapest listings of a "hot list" of items that matter (priced $5+, selling or well listed), and
// when a listing we haven't seen before is well under the usual price, Discord gets pinged at once.
// Blade Ball can't be read item by item on Eldorado, so it stays on the normal 15-minute scan.
import { fetchEldoradoItems, matchEldorado, fetchEldoradoPrice, readRow } from "./mm2-values.mjs";
import { fetchAmEldoradoPrices } from "./am-values.mjs";
import { fetchSabEldoradoPrices } from "./sab-values.mjs";
import { GAMES, gameItems, post, SITE, fmt } from "./deals.mjs";

// Runs continuously: SNIPE_PARALLEL items at a time, and the next pass starts as soon as one ends.
const PARALLEL = Number(process.env.SNIPE_PARALLEL || 5);
const HOT_LIST_SIZE = Number(process.env.SNIPE_HOT_LIST || 500);
let lastPassMs = 0;
const DISCOUNT = Number(process.env.SNIPE_DISCOUNT_PCT || 25) / 100; // at least 25% under the usual price
const MIN_PROFIT = Number(process.env.SNIPE_MIN_PROFIT || 3);          // after the fee, relisting under the next one
const FEE = Number(process.env.FLIP_FEE_PCT || 10) / 100;
const SNIPE_GAMES = ["MM2", "Adopt Me", "Steal a Brainrot"];

let hot = [];             // [{ game, item }]
let hotBuiltAt = 0;
const seen = new Map();   // "game|key" -> Set of offer ids seen at the top
const alerted = new Set(); // offer ids already sent
export const recentSnipes = []; // newest first, for the Flip Finder
let mm2Leaves = null;
let ownerId = null;

async function buildHotList(port) {
  const out = [];
  for (const game of SNIPE_GAMES) {
    const items = (await gameItems(GAMES[game], port).catch(() => [])).filter((i) => i.usd >= 5 && ((i.sold7d || 0) >= 1 || (i.listings || 0) >= 3));
    items.sort((a, b) => (b.sold7d || 0) - (a.sold7d || 0) || (b.listings || 0) - (a.listings || 0) || b.usd - a.usd);
    for (const item of items.slice(0, Math.ceil(HOT_LIST_SIZE / SNIPE_GAMES.length))) out.push({ game, item });
  }
  hot = out;
  hotBuiltAt = Date.now();
  ownerId = (await readRow("owner_settings").catch(() => null))?.eldoradoUserId || null;
}

// Fresh listings for one item: { usd, second, offers: [[id, usd, qty, expires, seller], ...], url }
async function listingsFor(game, item) {
  if (game === "MM2") {
    mm2Leaves ||= await fetchEldoradoItems();
    const m = matchEldorado(item, mm2Leaves);
    return m ? fetchEldoradoPrice(m) : null;
  }
  const prices = game === "Adopt Me" ? await fetchAmEldoradoPrices([item], { frOnly: true }) : await fetchSabEldoradoPrices([item]);
  return prices[item.key] || null;
}

// Pure decision: which listings among `offers` (not seen `before`, not the owner's) are snipes.
export function findSnipes(before, offers, item, owner = null) {
  const usual = item.soldPrice || item.usd; // what it really sells for, else the cheapest we knew
  const sorted = [...offers].sort((a, b) => a[1] - b[1]);
  const out = [];
  for (const [offerId, price, , , seller] of sorted) {
    if (before.has(offerId) || (owner && seller === owner)) continue;
    const next = sorted.find((x) => x[0] !== offerId && x[1] > price)?.[1] ?? item.second ?? usual;
    const profit = (next - 0.01) * (1 - FEE) - price;
    if (price > usual * (1 - DISCOUNT) || profit < MIN_PROFIT) continue;
    out.push({ offerId, price, usual, next, profit, suspicious: price < usual * 0.4 }); // far below what it sells for: often a mislabelled item
  }
  return out;
}

async function checkOne(game, item) {
  const p = await listingsFor(game, item).catch(() => null);
  if (!p?.offers?.length) return;
  const id = `${game}|${item.key}`;
  const before = seen.get(id);
  seen.set(id, new Set(p.offers.map((o) => o[0])));
  if (!before) return; // first look at this item: just remember what's there

  for (const { offerId, price, usual, next, profit, suspicious } of findSnipes(before, p.offers, item, ownerId)) {
    if (alerted.has(offerId)) continue;
    alerted.add(offerId);
    const snipe = { at: Date.now(), game, key: item.key, name: item.name, image: item.image, price, usual, next, profit,
      discount: Math.round((1 - price / usual) * 100), url: p.url || item.eldoradoUrl, suspicious };
    recentSnipes.unshift(snipe);
    recentSnipes.length = Math.min(recentSnipes.length, 50);
    await post({
      username: "Agony Values sniper",
      embeds: [{
        title: `🎯 New listing: ${item.name} — ${snipe.discount}% under usual`,
        url: snipe.url, color: suspicious ? 0xe0a335 : 0x22d3ee, thumbnail: item.image ? { url: item.image } : undefined,
        description: suspicious ? "⚠️ This is very cheap — it may be a mislabelled item. Check the listing carefully." : undefined,
        fields: [
          { name: "Game", value: game, inline: true },
          { name: "Listed at", value: `$${fmt(price)}`, inline: true },
          { name: item.soldPrice ? "Usually sells for" : "Previous cheapest", value: `$${fmt(usual)}`, inline: true },
          { name: "Next listing", value: `$${fmt(next)}`, inline: true },
          { name: `Flip profit (${Math.round(FEE * 100)}% fee)`, value: `+$${fmt(profit)}`, inline: true },
          { name: "Sells", value: `${item.sold7d || 0} in 7d`, inline: true },
          { name: "Links", value: `[Buy on Eldorado](${snipe.url}) · [Flip Finder](${SITE}/flips)`, inline: false },
        ],
        footer: { text: "New listings go fast — check it and buy quickly." },
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});
  }
}

// busy(): true while a full Eldorado price refresh runs - the sniper then drops to 2 at a time so
// the refresh still gets most of Eldorado's request budget.
async function loop(port, busy) {
  for (;;) {
    const t0 = Date.now();
    try {
      if (!hot.length || Date.now() - hotBuiltAt > 15 * 60 * 1000) await buildHotList(port);
      if (Date.now() - mm2LeavesAt > 60 * 60 * 1000) { mm2Leaves = null; mm2LeavesAt = Date.now(); } // refresh MM2's item list hourly
      const queue = [...hot];
      await Promise.all(Array.from({ length: PARALLEL }, async (_, w) => {
        for (let job; (job = queue.shift());) {
          while (w >= 2 && busy()) await new Promise((r) => setTimeout(r, 5000));
          await checkOne(job.game, job.item).catch(() => {});
        }
      }));
    } catch (e) {
      console.error(`Sniper pass failed: ${e.message}`);
    }
    lastPassMs = Date.now() - t0;
    await new Promise((r) => setTimeout(r, Math.max(2000, 10000 - lastPassMs))); // tiny gap between passes
  }
}
let mm2LeavesAt = Date.now();

export function startSniper(port, busy) {
  setTimeout(() => loop(port, busy), 60 * 1000).unref();
}

export function sniperStatus() {
  return { hotItems: hot.length, parallel: PARALLEL, lastPassSeconds: Math.round(lastPassMs / 1000), recent: recentSnipes };
}
