// Run on a home PC (not Render): scrapes MM2 values (Supreme Values) and Blade Ball values
// (bbvalues.uk) every 15 minutes and saves them to Supabase for the live site to read.
// Both sites are behind Cloudflare, which blocks Render's IPs but lets home connections through.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (see start-mm2-push.bat).
// Usage: node mm2-push.mjs          (keeps running, pushes every 15 minutes)
//        node mm2-push.mjs --once   (push once and exit)
//        add --prices to refresh Eldorado prices now instead of waiting for the hourly refresh
import {
  scrapeMm2Values, mergeMm2History, readMm2State, writeChangedRows, rememberRows, rowUpdatedAt,
  fetchEldoradoItems, matchEldorado, fetchEldoradoPrice, eldoradoExclusive,
} from "./mm2-values.mjs";
import { BB_PREFIX, scrapeBbValues, fetchBbEldoradoPrices, compactBbItem } from "./bb-values.mjs";
import { AM_PREFIX, scrapeAmValues, fetchAmEldoradoPrices, compactAmItem, fetchAmHistory } from "./am-values.mjs";

// The pusher is the only writer, so it reads each game's state from Supabase once and keeps it in
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

const PUSH_EVERY_MS = 15 * 60 * 1000;
// Each item's full history is re-pulled from its Supreme Values page when its value changes,
// and otherwise at most once a day, a batch per run so the site isn't hammered.
const HISTORY_STALE_MS = 24 * 60 * 60 * 1000;
const HISTORY_BATCH = 80;
const HISTORY_CONCURRENCY = 2;
const ELDORADO_EVERY_MS = 60 * 60 * 1000;
const ELDORADO_WORKERS = 4; // parallel price lookups, ~40s for every weapon
const HISTORY_DELAY_MS = 400; // per request, per worker - stays well under Supreme Values' rate limit

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

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
const pricesRunning = {};
const pendingPrices = [];
function refreshPricesInBackground(game, lastUpdatedAt, job) {
  if (pricesRunning[game]) return;
  if (!process.argv.includes("--prices") && Date.now() - (Date.parse(lastUpdatedAt) || 0) <= ELDORADO_EVERY_MS) return;
  pricesRunning[game] = true;
  pendingPrices.push(eldoradoExclusive(job)
    .then((msg) => console.log(`[${stamp()}] ${msg}`), (e) => console.error(`[${stamp()}] ${game} Eldorado price refresh failed: ${e.message}`))
    .finally(() => { pricesRunning[game] = false; }));
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
const AM_HISTORY = { fetch: fetchAmHistory, staleMs: HISTORY_STALE_MS, batch: 400, firstBatch: 4000, concurrency: 4, delayMs: 100, byValue: true };
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

async function pushOnce() {
  const results = await Promise.all([pushMm2(), pushBladeBall(), pushAdoptMe()]);
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

if (process.argv.includes("--once")) {
  const ok = await pushOnce();
  await Promise.all(pendingPrices);
  process.exit(ok ? 0 : 1);
}

// One update at a time, whether from the 15-minute timer or a "Refresh now" click on the site.
let running = null;
function runUpdate() {
  running ||= pushOnce().finally(() => { running = null; });
  return running;
}

// "Refresh now" on the site leaves a refresh_request row in Supabase; check for a new one every 15s.
const REFRESH_CHECK_MS = 15 * 1000;
let handledRefresh = await rowUpdatedAt("refresh_request").catch(() => null);
setInterval(async () => {
  try {
    const at = await rowUpdatedAt("refresh_request");
    if (!at || at === handledRefresh) return;
    handledRefresh = at;
    console.log(`[${stamp()}] "Refresh now" clicked on the site - updating.`);
    await runUpdate();
  } catch { /* Supabase busy - try again next check */ }
}, REFRESH_CHECK_MS);

await runUpdate();
setInterval(runUpdate, PUSH_EVERY_MS);
