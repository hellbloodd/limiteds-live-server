// New-listing sniper. Eldorado can't sort listings by newest, but a mispriced new listing jumps to the
// top of the cheapest-first list for its item. So every SNIPE_EVERY_S seconds we re-read the 5
// cheapest listings of a "hot list" of items that matter (priced $5+, selling or well listed), and
// when a listing we haven't seen before is well under the usual price, Discord gets pinged at once.
// Blade Ball can't be read item by item on Eldorado, so it stays on the normal 15-minute scan.
import { fetchEldoradoItems, matchEldorado, fetchEldoradoPrice, readRow } from "./mm2-values.mjs";
import { fetchAmEldoradoPrices } from "./am-values.mjs";
import { fetchSabEldoradoPrices } from "./sab-values.mjs";
import { GAMES, gameItems, post, SITE, fmt } from "./deals.mjs";

// Runs continuously, SNIPE_PARALLEL items at a time. Each item has its own check interval: when its
// listings change it's re-checked within CHECK_MIN_S, and every quiet check doubles the wait (up to
// CHECK_MAX_S) - so the request budget goes to the items that are actually moving.
const PARALLEL = Number(process.env.SNIPE_PARALLEL || 5);
const HOT_LIST_SIZE = Number(process.env.SNIPE_HOT_LIST || 1500);
const CHECK_MIN_MS = Number(process.env.SNIPE_CHECK_MIN_S || 45) * 1000;
const CHECK_MAX_MS = Number(process.env.SNIPE_CHECK_MAX_S || 900) * 1000;
const schedule = new Map(); // "game|key" -> { nextAt, interval }
const lastSig = new Map();  // "game|key" -> listing signature (ids + prices + stock of the cheapest listings)
let checks = 0, changes = 0;
const statsSince = Date.now();
const MIN_PRICE = Number(process.env.SNIPE_MIN_PRICE || 5); // only items whose cheapest listing is at least this
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
  // Every game's active items priced SNIPE_MIN_PRICE+ in one pool, most active first, up to the
  // hot list size (no fixed share per game).
  const pool = [];
  for (const game of SNIPE_GAMES) {
    for (const item of await gameItems(GAMES[game], port).catch(() => [])) {
      if (item.usd >= MIN_PRICE && ((item.sold7d || 0) >= 1 || (item.listings || 0) >= 3)) pool.push({ game, item });
    }
  }
  pool.sort((a, b) => (b.item.sold7d || 0) - (a.item.sold7d || 0) || (b.item.listings || 0) - (a.item.listings || 0) || b.item.usd - a.item.usd);
  const out = pool.slice(0, HOT_LIST_SIZE);
  // new items start soon (busier ones first); known ones keep their schedule
  out.forEach(({ game, item }, i) => {
    const id = `${game}|${item.key}`;
    if (!schedule.has(id)) schedule.set(id, { nextAt: Date.now() + Math.min(i * 200, 5 * 60 * 1000), interval: (item.sold7d || 0) >= 3 ? CHECK_MIN_MS * 2 : CHECK_MIN_MS * 4 });
  });
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
  checks++;
  if (!p?.offers?.length) return false;
  const id = `${game}|${item.key}`;
  const sig = p.offers.map((o) => `${o[0]}:${o[1]}:${o[2]}`).sort().join(",");
  const changed = lastSig.has(id) && lastSig.get(id) !== sig;
  lastSig.set(id, sig);
  if (changed) { changes++; onPrice(game, item.key, p); } // only changed prices go to the site's storage
  const before = seen.get(id);
  seen.set(id, new Set(p.offers.map((o) => o[0])));
  if (!before) return changed; // first look at this item: just remember what's there

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
  return changed;
}

// busy(): true while a full Eldorado price refresh runs - the sniper then drops to 2 at a time so
// the refresh still gets most of Eldorado's request budget.
async function loop(port, busy) {
  const due = () => {
    const now = Date.now();
    let best = null;
    for (const job of hot) {
      const sc = schedule.get(`${job.game}|${job.item.key}`);
      if (sc && sc.nextAt <= now && !sc.taken && (!best || sc.nextAt < best.sc.nextAt)) best = { job, sc };
    }
    return best;
  };
  await Promise.all(Array.from({ length: PARALLEL }, async (_, w) => {
    for (;;) {
      try {
        if (w === 0 && (!hot.length || Date.now() - hotBuiltAt > 15 * 60 * 1000)) await buildHotList(port);
        if (w === 0 && Date.now() - mm2LeavesAt > 60 * 60 * 1000) { mm2Leaves = null; mm2LeavesAt = Date.now(); } // MM2's item list hourly
        while (w >= 2 && busy()) await new Promise((r) => setTimeout(r, 5000));
        const next = due();
        if (!next) { await new Promise((r) => setTimeout(r, 1000)); continue; }
        next.sc.taken = true;
        const changed = await checkOne(next.job.game, next.job.item).catch(() => false);
        next.sc.interval = changed ? CHECK_MIN_MS : Math.min(next.sc.interval * 2, CHECK_MAX_MS);
        next.sc.nextAt = Date.now() + next.sc.interval;
        next.sc.taken = false;
      } catch (e) {
        console.error(`Sniper check failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }));
}
let mm2LeavesAt = Date.now();

let onPrice = () => {};
export function startSniper(port, busy, priceSink) {
  if (priceSink) onPrice = priceSink;
  setTimeout(() => loop(port, busy), 60 * 1000).unref();
}

export function sniperStatus() {
  const mins = Math.max(1, (Date.now() - statsSince) / 60000);
  const ints = hot.map((j) => schedule.get(`${j.game}|${j.item.key}`)?.interval || 0);
  return { hotItems: hot.length, parallel: PARALLEL, checksPerMin: Math.round(checks / mins), changedPerMin: Math.round(changes / mins * 10) / 10,
    fastItems: ints.filter((i) => i <= CHECK_MIN_MS).length, slowItems: ints.filter((i) => i >= CHECK_MAX_MS).length, recent: recentSnipes };
}
