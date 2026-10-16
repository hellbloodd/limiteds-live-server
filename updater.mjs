// Fetches fresh values for every game (MM2: mm2values.com, Blade Ball: bbvalues.uk,
// Adopt Me: adoptmevalues.app), records history and Eldorado prices, and saves it all to Supabase.
// Runs inside the live server (every 15 minutes, and right away on "Refresh now"); mm2-push.mjs
// can still run it by hand from a PC.
import {
  scrapeMm2Values, mergeMm2History, readMm2State, writeChangedRows, rememberRows,
  fetchEldoradoItems, matchEldorado, fetchEldoradoPrice, eldoradoExclusive, reloadAllTrackers, recordPriceHistory,
  detectSales, mergeSales,
  readRow,
} from "./mm2-values.mjs";
import { BB_PREFIX, scrapeBbValues, fetchBbEldoradoPrices, compactBbItem, expandBbItem } from "./bb-values.mjs";
import { AM_PREFIX, scrapeAmValues, fetchAmEldoradoPrices, compactAmItem, fetchAmHistory } from "./am-values.mjs";
import { SB_PREFIX, scrapeSabValues, fetchSabEldoradoPrices, compactSabItem } from "./sab-values.mjs";
import { checkDeals, checkFlips } from "./deals.mjs";
import { checkUndercuts } from "./tools.mjs";
import { startSniper } from "./sniper.mjs";

let serverPort = null; // set when running inside the live server (deal alerts read its pages' data)

// The updater is the only writer, so it reads each game's state from Supabase once and keeps it in
// memory; each run then writes only the rows that changed (plus a tiny "heartbeat" with the time).
const stateCache = {};
async function getState(prefix) {
  if (!stateCache[prefix]) {
    // Row by row, skipping Blade Ball's item list (rebuilt every run): one big read times out
    // when Supabase's free tier is busy.
    const s = await readMm2State(prefix, prefix === "" ? undefined : ["history", "history_fetched", "eldorado", "eldorado_history", "sales"]);
    rememberRows(prefix, { latest: s.latest, history: s.history, history_fetched: s.historyFetched, eldorado: s.eldorado, eldorado_history: s.priceHistory, sales: s.sales });
    stateCache[prefix] = s;
  }
  return stateCache[prefix];
}

const UPDATE_EVERY_MS = 15 * 60 * 1000;
const HISTORY_STALE_MS = 24 * 60 * 60 * 1000;
// Prices (and deal alerts) on every 15-minute update: the threshold is a bit under 15 min because a
// price refresh finishes a few minutes after the update that started it.
const ELDORADO_EVERY_MS = 12 * 60 * 1000;
const ELDORADO_WORKERS = 8; // the shared limit in mm2-values.mjs caps total requests to Eldorado

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
async function refreshEldorado(items, previous, { save = true } = {}) {
  const leaves = await fetchEldoradoItems();
  const prices = {};
  const queue = items.filter((i) => !i.valueText).map((it) => [it, matchEldorado(it, leaves)]).filter(([, m]) => m);
  const matched = queue.length;
  await Promise.all(Array.from({ length: ELDORADO_WORKERS }, async () => {
    for (let job; (job = queue.shift());) {
      const [it, m] = job;
      try {
        const p = await fetchEldoradoPrice(m);
        if (p) prices[it.key] = p; // may be listings-only ({ offers: [] }) when nothing is listed
      } catch {
        if (previous?.prices?.[it.key]) prices[it.key] = previous.prices[it.key]; // keep the last known price
      }
    }
  }));
  if (save) await savePrices("", await getState(""), prices);
  return { matched, priced: Object.keys(prices).length, prices };
}

const stamp = () => new Date().toLocaleTimeString();

// Saves a game's new Eldorado prices and adds them to its price history. The history row grows over
// time, so it's written at most every 3 hours (or when the day changes) - prices themselves every time.
const PRICE_HISTORY_SAVE_MS = 3 * 60 * 60 * 1000;
const priceHistorySaved = {}; // prefix -> [ms, day]
const lastItems = {}; // prefix -> items from the last value update (memory only)
const lastListings = {}; // prefix -> { itemKey: { offers, windowMax } } from the previous check (memory only)
// partial: only some items were re-checked (Flip Finder "Refresh now") - merge them into the
// existing prices and listing snapshots instead of replacing everything.
async function savePrices(prefix, state, allPrices, { partial = false, live = false } = {}) {
  // Sales: compare this check's listings with the previous one, then keep only prices for saving.
  state.sales ||= {};
  const prev = lastListings[prefix];
  const prevSubset = prev && partial ? Object.fromEntries(Object.keys(allPrices).filter((k) => prev[k]).map((k) => [k, prev[k]])) : prev;
  const soldNow = prevSubset ? detectSales(prevSubset, allPrices) : {};
  const salesChanged = mergeSales(state.sales, soldNow);
  const snap = Object.fromEntries(Object.entries(allPrices).filter(([, p]) => p.offers).map(([k, p]) => [k, { offers: p.offers, windowMax: p.windowMax }]));
  lastListings[prefix] = partial ? { ...(prev || {}), ...snap } : snap;
  const prices = partial ? { ...(state.eldorado?.prices || {}) } : {};
  if (partial) for (const [k, p] of Object.entries(allPrices)) if (!(p.usd > 0) && !p.variants) delete prices[k]; // nothing listed any more
  for (const [k, p] of Object.entries(allPrices)) {
    if (!(p.usd > 0) && !p.variants) continue; // (Adopt Me pets can have other versions listed but no Fly Ride)
    const { offers, windowMax, ...keep } = p;
    // the 5 cheapest listing prices, for the Flip Finder's price ladder
    if (offers?.length) keep.ladder = offers.map((o) => Math.round(o[1] * 100) / 100).filter((v) => v > 0).sort((a, b) => a - b).slice(0, 5);
    // partial: keep what the fresh check didn't fetch (Adopt Me versions, listing counts...)
    prices[k] = partial ? { ...(prices[k] || {}), ...keep } : keep;
  }
  if (salesChanged) console.log(`[${stamp()}] ${prefix || "mm2_"}: ${Object.values(soldNow).flat().reduce((n, e) => n + e[2], 0)} Eldorado sale(s) detected.`);
  state.eldorado = { updatedAt: live ? state.eldorado?.updatedAt || new Date().toISOString() : new Date().toISOString(), liveAt: live ? new Date().toISOString() : state.eldorado?.liveAt, prices };
  state.priceHistory ||= {};
  recordPriceHistory(state.priceHistory, partial ? Object.fromEntries(Object.keys(allPrices).filter((k) => prices[k]).map((k) => [k, prices[k]])) : prices);
  const now = Date.now(), day = Math.floor(now / 864e5);
  const [savedAt = 0, savedDay = -1] = priceHistorySaved[prefix] || [];
  const rows = { eldorado: state.eldorado, sales: state.sales };
  if (now - savedAt > PRICE_HISTORY_SAVE_MS || day !== savedDay) {
    rows.eldorado_history = state.priceHistory;
    priceHistorySaved[prefix] = [now, day];
  }
  await writeChangedRows(prefix, rows);
}

// Eldorado price refreshes (hourly, a few minutes each) run in the background so a value update -
// and the site's "Refresh now" button - never waits for them. One per game at a time.
let forcePrices = false;
let priorityGame = null; // the game whose page clicked "Refresh now" gets its prices first
const pricesRunning = {};
const priceStatus = {}; // game -> { startedAt, okAt, message, errorAt, error } for /api/status
export const updaterStatus = () => ({ updating: Boolean(running), values: pushStatus, running: { ...pricesRunning }, prices: priceStatus });
const wantedPrices = []; // [game, job] collected during an update, started when it finishes
export const pendingPrices = [];
function refreshPricesInBackground(game, lastUpdatedAt, job) {
  if (pricesRunning[game]) return;
  if (!forcePrices && Date.now() - (Date.parse(lastUpdatedAt) || 0) <= ELDORADO_EVERY_MS) return;
  pricesRunning[game] = true;
  wantedPrices.push([game, job]);
}
// Games' full price refreshes run one after another (never together): each then gets all of
// Eldorado's request budget and finishes fast, instead of four slow refreshes at once. The game
// whose page clicked "Refresh now" goes first.
let priceChain = Promise.resolve();
function startWantedPrices() {
  const jobs = wantedPrices.splice(0);
  jobs.sort(([a], [b]) => (b === priorityGame) - (a === priorityGame));
  for (const entry of jobs) {
    const [game, job, markDone] = entry;
    const run = priceChain.then(() => {
      priceStatus[game] = { ...priceStatus[game], startedAt: new Date().toISOString() };
      return job();
    });
    const done = run.finally(() => markDone?.())
      .then(async (msg) => {
        console.log(`[${stamp()}] ${msg}`);
        priceStatus[game] = { ...priceStatus[game], okAt: new Date().toISOString(), message: msg };
        await reloadAllTrackers();
        if (serverPort) {
          const sent = await checkDeals(game, serverPort).catch((e) => { console.error(`[${stamp()}] ${game} deal alerts failed: ${e.message}`); return 0; });
          if (sent) console.log(`[${stamp()}] ${game}: sent ${sent} deal alert(s) to Discord.`);
          for (const [label, check] of [["flip", checkFlips], ["undercut", checkUndercuts]]) {
            const n = await check(game, serverPort).catch((e) => { console.error(`[${stamp()}] ${game} ${label} alerts failed: ${e.message}`); return 0; });
            if (n) console.log(`[${stamp()}] ${game}: sent ${n} ${label} alert(s) to Discord.`);
          }
        }
      }, (e) => { console.error(`[${stamp()}] ${game} Eldorado price refresh failed: ${e.message}`); priceStatus[game] = { ...priceStatus[game], errorAt: new Date().toISOString(), error: e.message }; })
      .finally(() => { pricesRunning[game] = false; });
    priceChain = run.catch(() => {}); // the next game starts when this one's prices are in
    pendingPrices.push(done);
  }
}

// ---------- Live prices: hot items between full refreshes ----------
// The sniper re-reads the cheapest listings of the ~500 most active items nonstop; those fresh
// prices are merged into the stored prices every LIVE_FLUSH_MS, so the items that matter stay
// minutes-fresh while the rest follow the 15-minute refresh.
const LIVE_FLUSH_MS = 3 * 60 * 1000;
const livePending = {}; // prefix -> { key: price }
const GAME_PREFIX = { "MM2": "", "Blade Ball": BB_PREFIX, "Adopt Me": AM_PREFIX, "Steal a Brainrot": SB_PREFIX };
export function recordLivePrice(game, key, price) {
  const prefix = GAME_PREFIX[game];
  if (prefix === undefined || !price) return;
  (livePending[prefix] ||= {})[key] = price;
}
async function flushLivePrices() {
  for (const [prefix, prices] of Object.entries(livePending)) {
    const game = Object.keys(GAME_PREFIX).find((g) => GAME_PREFIX[g] === prefix);
    if (!Object.keys(prices).length || pricesRunning[game]) continue; // a full refresh is writing this game
    delete livePending[prefix];
    try {
      await savePrices(prefix, await getState(prefix), prices, { partial: true, live: true });
      await reloadAllTrackers();
    } catch (e) { console.error(`[${stamp()}] ${game} live price save failed: ${e.message}`); }
  }
}

async function pushBladeBall() {
  try {
    const { items } = await scrapeBbValues();
    lastItems[BB_PREFIX] = items;
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
      await savePrices(BB_PREFIX, state, prices);
      return `Blade Ball Eldorado prices: ${Object.keys(prices).length} items listed.`;
    });
    return true;
  } catch (e) {
    console.error(`[${stamp()}] Blade Ball push failed: ${e.message}`);
    // bbvalues.uk down: Eldorado prices still refresh, using the last saved values.
    try {
      const state = await getState(BB_PREFIX);
      const items = lastItems[BB_PREFIX] ||= ((await readRow(`${BB_PREFIX}latest`))?.items || []).map(expandBbItem);
      if (items.length) refreshPricesInBackground("Blade Ball", state.eldorado?.updatedAt, async () => {
        const prices = await fetchBbEldoradoPrices(items);
        await savePrices(BB_PREFIX, state, prices);
        return `Blade Ball Eldorado prices: ${Object.keys(prices).length} items listed (values from the last update).`;
      });
    } catch (e2) { console.error(`[${stamp()}] Blade Ball fallback price refresh failed: ${e2.message}`); }
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
    lastItems[AM_PREFIX] = items;
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
      await savePrices(AM_PREFIX, state, prices);
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
    lastItems[SB_PREFIX] = items;
    const now = Date.now();
    mergeMm2History(history, items, now);
    state.latest = { items: items.map(compactSabItem) };
    await writeChangedRows(SB_PREFIX, { latest: state.latest, history, history_fetched: historyFetched, heartbeat: { updatedAt: new Date(now).toISOString() } });
    console.log(`[${stamp()}] Pushed ${items.length} Steal a Brainrot values.`);
    refreshPricesInBackground("Steal a Brainrot", eldorado?.updatedAt, async () => {
      const prices = await fetchSabEldoradoPrices(items);
      await savePrices(SB_PREFIX, state, prices);
      return `Steal a Brainrot Eldorado prices: ${Object.keys(prices).length} brainrots listed.`;
    });
    return true;
  } catch (e) {
    console.error(`[${stamp()}] Steal a Brainrot push failed: ${e.message}`);
    return false;
  }
}

// Each game's value update gets 8 minutes: one that hangs (a database or site request that never
// answers) must not hold up the others' price refreshes forever.
const PUSH_LIMIT_MS = 8 * 60 * 1000;
const pushStatus = {}; // game -> { startedAt, doneAt, ok, timedOut }
function guarded(game, push) {
  pushStatus[game] = { startedAt: new Date().toISOString() };
  let timer;
  const limit = new Promise((res) => { timer = setTimeout(() => { console.error(`[${stamp()}] ${game} value update took over 8 min - moving on.`); pushStatus[game].timedOut = true; res(false); }, PUSH_LIMIT_MS); });
  return Promise.race([push().then((ok) => { pushStatus[game] = { ...pushStatus[game], doneAt: new Date().toISOString(), ok }; return ok; }), limit]).finally(() => clearTimeout(timer));
}
async function pushOnce() {
  const results = await Promise.all([guarded("MM2", pushMm2), guarded("Blade Ball", pushBladeBall), guarded("Adopt Me", pushAdoptMe), guarded("Steal a Brainrot", pushStealABrainrot)]);
  return results.every(Boolean);
}

async function pushMm2() {
  try {
    const scraped = await scrapeMm2Values();
    const state = await getState("");
    const { latest, history, historyFetched, eldorado } = state;
    let items = scraped.items;
    lastItems[""] = items;
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
export function startAutoUpdates(port) {
  serverPort = port;
  startSniper(port, () => Object.values(pricesRunning).some(Boolean) || Boolean(selectedRunning), recordLivePrice);
  setInterval(() => flushLivePrices().catch(() => {}), LIVE_FLUSH_MS).unref();
  // Blade Ball can't be read item by item, but its whole list is only ~90 pages: scan it every 5 min.
  setInterval(() => refreshBbPricesNow().catch(() => {}), 5 * 60 * 1000).unref();
  setTimeout(() => runUpdate().catch(() => {}), 20 * 1000).unref();
  setInterval(() => runUpdate().catch(() => {}), UPDATE_EVERY_MS).unref();
}

// ---------- Flip Finder "Refresh now": re-check only the items on screen ----------
// selection: [{ game, key }, ...] (up to 200). Blade Ball listings can only be read game-wide
// (~90 pages), the other games item by item - far fewer requests than a full refresh.
const PREFIX_OF = { "MM2": "", "Blade Ball": BB_PREFIX, "Adopt Me": AM_PREFIX, "Steal a Brainrot": SB_PREFIX };
let selectedRunning = null;
let lastSelected = 0;
export function requestSelectedRefresh(selection) {
  if (selectedRunning) return { started: false, running: true };
  if (Date.now() - lastSelected < 60 * 1000) return { started: false, recent: true };
  const byGame = {};
  for (const { game, key } of (selection || []).slice(0, 200)) if (PREFIX_OF[game] !== undefined && key) (byGame[game] ||= new Set()).add(String(key));
  const games = Object.keys(byGame);
  if (!games.length) return { started: false, empty: true };
  lastSelected = Date.now();
  selectedRunning = Promise.all(games.map(async (game) => {
    const prefix = PREFIX_OF[game];
    if (pricesRunning[game]) return; // the automatic refresh is already fetching this game's prices
    const items = (lastItems[prefix] || []).filter((i) => byGame[game].has(String(i.key)));
    if (!items.length) return;
    const state = await getState(prefix);
    try {
      const prices = game === "MM2" ? (await refreshEldorado(items, state.eldorado, { save: false })).prices
        : game === "Blade Ball" ? await fetchBbEldoradoPrices(lastItems[prefix]) // whole game anyway
        : game === "Adopt Me" ? await fetchAmEldoradoPrices(items)
        : await fetchSabEldoradoPrices(items);
      await savePrices(prefix, state, prices, { partial: game !== "Blade Ball" });
      await reloadAllTrackers(); // show each game as soon as it's done
      console.log(`[${stamp()}] ${game}: re-checked ${game === "Blade Ball" ? "all" : items.length} item prices for the Flip Finder.`);
    } catch (e) { console.error(`[${stamp()}] ${game} selected price refresh failed: ${e.message}`); }
  })).then(() => reloadAllTrackers()).finally(() => { selectedRunning = null; });
  return { started: true, games };
}

async function refreshBbPricesNow() {
  if (pricesRunning["Blade Ball"] || running) return;
  const items = lastItems[BB_PREFIX];
  if (!items?.length) return;
  const state = await getState(BB_PREFIX);
  if (Date.now() - (Date.parse(state.eldorado?.updatedAt) || 0) < 4 * 60 * 1000) return;
  pricesRunning["Blade Ball"] = true;
  wantedPrices.push(["Blade Ball", async () => {
    const prices = await fetchBbEldoradoPrices(items);
    await savePrices(BB_PREFIX, state, prices);
    return `Blade Ball Eldorado prices: ${Object.keys(prices).length} items listed (5-minute scan).`;
  }]);
  startWantedPrices();
}
