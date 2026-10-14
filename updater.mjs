// Fetches fresh values for every game (MM2: mm2values.com, Blade Ball: bbvalues.uk,
// Adopt Me: adoptmevalues.app), records history and Eldorado prices, and saves it all to Supabase.
// Runs inside the live server (every 15 minutes, and right away on "Refresh now"); mm2-push.mjs
// can still run it by hand from a PC.
import {
  scrapeMm2Values, mergeMm2History, readMm2State, writeChangedRows, rememberRows,
  fetchEldoradoItems, matchEldorado, fetchEldoradoPrice, eldoradoExclusive, reloadAllTrackers,
} from "./mm2-values.mjs";
import { BB_PREFIX, scrapeBbValues, fetchBbEldoradoPrices, compactBbItem } from "./bb-values.mjs";
import { AM_PREFIX, scrapeAmValues, fetchAmEldoradoPrices, compactAmItem, fetchAmHistory } from "./am-values.mjs";
import { SB_PREFIX, scrapeSabValues, fetchSabEldoradoPrices, compactSabItem } from "./sab-values.mjs";

// The updater is the only writer, so it reads each game's state from Supabase once and keeps it in
// memory; each run then writes only the rows that changed (plus a tiny "heartbeat" with the time).
const stateCache = {};
async function getState(prefix) {
  if (!stateCache[prefix]) {
    // Row by row, skipping Blade Ball's item list (rebuilt every run): one big read times out
    // when Supabase's free tier is busy.
    const s = await readMm2State(prefix, prefix === "" ? undefined : ["history", "history_fetched", "eldorado"]);
    rememberRows(prefix, { latest: s.latest, history: s.history, history_fetched: s.historyFetched, eldorado: s.eldorado });
    stateCache[prefix] = s;
  }
  return stateCache[prefix];
}

const UPDATE_EVERY_MS = 15 * 60 * 1000;
const HISTORY_STALE_MS = 24 * 60 * 60 * 1000;
const ELDORADO_EVERY_MS = 60 * 60 * 1000;
const ELDORADO_WORKERS = 4; // parallel price lookups, ~40s for every weapon

async function refreshHistories(allItems, history, historyFetched, now, opts) {
  const items = allItems.filter((it) => !it.valueText); // ratio-valued items have no numeric history
  const changed = items.filter((it) => {
    const points = history[it.key];
    return !points?.length || points[points.length - 1][1] !== it.value;
  });
  const stale = items
    .filter((it) => !changed.includes(it) && now - (historyFetched[it.key] || 0) > opts.staleMs)
    .sort((a, b) => (historyFetched[a.key] || 0) - (historyFetched[b.key] || 0));
  const neverFetched = changed.filter((it) => !historyFetched[it.key]);
  if (opts.byValue) neverFetched.sort((a, b) => b.value - a.value);
  // Changed items always; never-fetched/stale ones in batches. Items we track changes for ourselves
  // (opts.byValue) don't need a re-pull just because the value moved.
  const changedKnown = opts.byValue ? [] : changed.filter((it) => historyFetched[it.key]);
  const batch = opts.firstBatch && !Object.keys(historyFetched).length ? opts.firstBatch : opts.batch;
  const queue = [...changedKnown, ...[...neverFetched, ...stale].slice(0, batch)];
  let ok = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    for (let it; (it = queue.shift());) {
      try {
        const points = await opts.fetch(it);
        if (points.length) { history[it.key] = points; ok++; }
        historyFetched[it.key] = now;
      } catch { /* keep what we have; retried next run */ }
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }));
  return ok;
}

// Cheapest Eldorado.gg listing for every weapon that has a numeric value.
async function refreshEldorado(items, previous) {
  const leaves = await fetchEldoradoItems();
  const prices = {};
  const queue = items.filter((i) => !i.valueText).map((it) => [it, matchEldorado(it, leaves)]).filter(([, m]) => m);
  const matched = queue.length;
  await Promise.all(Array.from({ length: ELDORADO_WORKERS }, async () => {
    for (let job; (job = queue.shift());) {
      const [it, m] = job;
      try {
        const p = await fetchEldoradoPrice(m);
        if (p) prices[it.key] = p;
      } catch {
        if (previous?.prices?.[it.key]) prices[it.key] = previous.prices[it.key]; // keep the last known price
      }
    }
  }));
  const state = await getState("");
  state.eldorado = { updatedAt: new Date().toISOString(), prices };
  await writeChangedRows("", { eldorado: state.eldorado });
  return { matched, priced: Object.keys(prices).length };
}

const stamp = () => new Date().toLocaleTimeString();

// Eldorado price refreshes (hourly, a few minutes each) run in the background so a value update -
// and the site's "Refresh now" button - never waits for them. One per game at a time.
let forcePrices = false;
let priorityGame = null; // the game whose page clicked "Refresh now" gets its prices first
const pricesRunning = {};
const wantedPrices = []; // [game, job] collected during an update, started when it finishes
export const pendingPrices = [];
function refreshPricesInBackground(game, lastUpdatedAt, job) {
  if (pricesRunning[game]) return;
  if (!forcePrices && Date.now() - (Date.parse(lastUpdatedAt) || 0) <= ELDORADO_EVERY_MS) return;
  pricesRunning[game] = true;
  wantedPrices.push([game, job]);
}
function startWantedPrices() {
  const jobs = wantedPrices.splice(0).sort(([a], [b]) => (b === priorityGame) - (a === priorityGame));
  for (const [game, job] of jobs) {
    pendingPrices.push(eldoradoExclusive(job)
      .then(async (msg) => { console.log(`[${stamp()}] ${msg}`); await reloadAllTrackers(); }, (e) => console.error(`[${stamp()}] ${game} Eldorado price refresh failed: ${e.message}`))
      .finally(() => { pricesRunning[game] = false; }));
  }
}

async function pushBladeBall() {
  try {
    const { items } = await scrapeBbValues();
    const state = await getState(BB_PREFIX);
    const { history, historyFetched, eldorado } = state;
    const now = Date.now();
    // bbvalues.uk's API is too unreliable for per-item history downloads, so Blade Ball history
    // is built from our own updates: every value change we see is recorded.
    mergeMm2History(history, items, now);
    state.latest = { items: items.map(compactBbItem) };
    await writeChangedRows(BB_PREFIX, { latest: state.latest, history, heartbeat: { updatedAt: new Date(now).toISOString() } });
    console.log(`[${stamp()}] Pushed ${items.length} Blade Ball values.`);
    refreshPricesInBackground("Blade Ball", eldorado?.updatedAt, async () => {
      const prices = await fetchBbEldoradoPrices(items);
      state.eldorado = { updatedAt: new Date().toISOString(), prices };
      await writeChangedRows(BB_PREFIX, { eldorado: state.eldorado });
      return `Blade Ball Eldorado prices: ${Object.keys(prices).length} items listed.`;
    });
    return true;
  } catch (e) {
    console.error(`[${stamp()}] Blade Ball push failed: ${e.message}`);
    return false;
  }
}

// Adopt Me values come from adoptmevalues.app's public values page (its /api/ is off-limits in
// robots.txt). History comes from each item's own page (dated daily values back to 2024): all of
// them on the first run, then each item again once a day, a batch per run.
const AM_HISTORY = { fetch: fetchAmHistory, staleMs: HISTORY_STALE_MS, batch: 150, firstBatch: 4000, concurrency: 4, delayMs: 100, byValue: true };
async function pushAdoptMe() {
  try {
    const { items, categories } = await scrapeAmValues();
    const state = await getState(AM_PREFIX);
    const { history, historyFetched, eldorado } = state;
    const now = Date.now();
    const pulled = await refreshHistories(items, history, historyFetched, now, AM_HISTORY);
    if (pulled) console.log(`[${stamp()}] Adopt Me history: ${pulled} items updated (${items.filter((i) => historyFetched[i.key]).length}/${items.length} done).`);
    mergeMm2History(history, items, now);
    state.latest = { items: items.map(compactAmItem), categories };
    await writeChangedRows(AM_PREFIX, { latest: state.latest, history, history_fetched: historyFetched, heartbeat: { updatedAt: new Date(now).toISOString() } });
    console.log(`[${stamp()}] Pushed ${items.length} Adopt Me values.`);
    refreshPricesInBackground("Adopt Me", eldorado?.updatedAt, async () => {
      const prices = await fetchAmEldoradoPrices(items);
      state.eldorado = { updatedAt: new Date().toISOString(), prices };
      await writeChangedRows(AM_PREFIX, { eldorado: state.eldorado });
      return `Adopt Me Eldorado prices: ${Object.keys(prices).length} pets/eggs listed.`;
    });
    return true;
  } catch (e) {
    console.error(`[${stamp()}] Adopt Me push failed: ${e.message}`);
    return false;
  }
}

// Steal a Brainrot (Secret + OG) from sabrvalues.com item pages. Which page is which rarity is kept
// in the history_fetched row so most runs only re-read the Secret/OG pages. History is recorded
// from our own updates.
async function pushStealABrainrot() {
  try {
    const state = await getState(SB_PREFIX);
    const { history, historyFetched, eldorado } = state;
    const { items } = await scrapeSabValues(historyFetched);
    const now = Date.now();
    mergeMm2History(history, items, now);
    state.latest = { items: items.map(compactSabItem) };
    await writeChangedRows(SB_PREFIX, { latest: state.latest, history, history_fetched: historyFetched, heartbeat: { updatedAt: new Date(now).toISOString() } });
    console.log(`[${stamp()}] Pushed ${items.length} Steal a Brainrot values.`);
    refreshPricesInBackground("Steal a Brainrot", eldorado?.updatedAt, async () => {
      const prices = await fetchSabEldoradoPrices(items);
      state.eldorado = { updatedAt: new Date().toISOString(), prices };
      await writeChangedRows(SB_PREFIX, { eldorado: state.eldorado });
      return `Steal a Brainrot Eldorado prices: ${Object.keys(prices).length} brainrots listed.`;
    });
    return true;
  } catch (e) {
    console.error(`[${stamp()}] Steal a Brainrot push failed: ${e.message}`);
    return false;
  }
}

async function pushOnce() {
  const results = await Promise.all([pushMm2(), pushBladeBall(), pushAdoptMe(), pushStealABrainrot()]);
  return results.every(Boolean);
}

async function pushMm2() {
  try {
    const scraped = await scrapeMm2Values();
    const state = await getState("");
    const { latest, history, historyFetched, eldorado } = state;
    let items = scraped.items;
    if (scraped.errors.length) {
      // Keep the last good values for categories that failed this time, instead of dropping them.
      const failed = new Set(scraped.errors.map((e) => e.split(":")[0]));
      const names = new Set(items.map((it) => it.name.toLowerCase()));
      const kept = (latest?.items || []).filter((it) => failed.has(it.category) && !names.has(it.name.toLowerCase()));
      items = [...items, ...kept];
      console.warn(`[${stamp()}] ${failed.size} categories failed (kept their last values): ${scraped.errors.join("; ")}`);
    }
    const now = Date.now();
    // mm2values.com has no history pages, so MM2 history is recorded from our own updates
    // (on top of the older history carried over from Supreme Values - see mm2-migrate-mv.mjs).
    mergeMm2History(history, items, now);
    state.latest = { items };
    await writeChangedRows("", { latest: state.latest, history, heartbeat: { updatedAt: new Date(now).toISOString() } });
    console.log(`[${stamp()}] Pushed ${items.length} MM2 values.`);
    refreshPricesInBackground("MM2", eldorado?.updatedAt, async () => {
      const { matched, priced } = await refreshEldorado(items, eldorado);
      return `MM2 Eldorado prices: ${priced} weapons listed (of ${matched} matched).`;
    });
    return true;
  } catch (e) {
    console.error(`[${stamp()}] MM2 push failed: ${e.message}`);
    return false;
  }
}

// One update at a time, whether from the timer or a "Refresh now" click.
let running = null;
let lastFinished = 0;
export function runUpdate({ prices = false, priority = null } = {}) {
  if (running) return running;
  forcePrices = prices;
  priorityGame = priority;
  running = pushOnce()
    .then(async (ok) => { lastFinished = Date.now(); await reloadAllTrackers(); return ok; })
    .finally(() => { startWantedPrices(); running = null; forcePrices = false; });
  return running;
}

// "Refresh now": refreshes values, and Eldorado prices too unless they were refreshed by a click in
// the last 5 minutes (Eldorado rate-limits). Returns right away; the page then watches the
// "Updated" / prices times. `game` (the page's game) gets its prices first.
const GAME_NAMES = { mm2: "MM2", bladeball: "Blade Ball", adoptme: "Adopt Me", stealabrainrot: "Steal a Brainrot" };
const PRICES_MIN_GAP_MS = 5 * 60 * 1000;
let lastPricesRequest = 0;
export function requestRefresh(game) {
  if (running) return { started: false, running: true, prices: false };
  const prices = Date.now() - lastPricesRequest >= PRICES_MIN_GAP_MS && !Object.values(pricesRunning).some(Boolean);
  if (!prices && Date.now() - lastFinished < 60 * 1000) return { started: false, recent: true, prices: false };
  if (prices) lastPricesRequest = Date.now();
  runUpdate({ prices, priority: GAME_NAMES[game] || null }).catch(() => {});
  return { started: true, prices };
}

// Update every 15 minutes while the server is up (Render's free plan sleeps when idle; the first
// page view after waking triggers an update if the values are stale).
export function startAutoUpdates() {
  setTimeout(() => runUpdate().catch(() => {}), 20 * 1000).unref();
  setInterval(() => runUpdate().catch(() => {}), UPDATE_EVERY_MS).unref();
}
