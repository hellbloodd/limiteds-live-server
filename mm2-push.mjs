// Run on a home PC (not Render): scrapes MM2 values (Supreme Values) and Blade Ball values
// (bbvalues.uk) every 15 minutes and saves them to Supabase for the live site to read.
// Both sites are behind Cloudflare, which blocks Render's IPs but lets home connections through.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (see start-mm2-push.bat).
// Usage: node mm2-push.mjs          (keeps running, pushes every 15 minutes)
//        node mm2-push.mjs --once   (push once and exit)
//        add --prices to refresh Eldorado prices now instead of waiting for the hourly refresh
import {
  scrapeMm2Values, mergeMm2History, readMm2State, writeMm2State, writeMm2Row, fetchSvHistory,
  fetchEldoradoItems, matchEldorado, fetchEldoradoPrice,
} from "./mm2-values.mjs";
import { BB_PREFIX, scrapeBbValues, fetchBbEldoradoPrices } from "./bb-values.mjs";

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

const MM2_HISTORY = { fetch: fetchSvHistory, staleMs: HISTORY_STALE_MS, batch: HISTORY_BATCH, concurrency: HISTORY_CONCURRENCY, delayMs: HISTORY_DELAY_MS };

async function refreshHistories(allItems, history, historyFetched, now, opts = MM2_HISTORY) {
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
  const queue = [...changedKnown, ...[...neverFetched, ...stale].slice(0, opts.batch)];
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
  await writeMm2Row("eldorado", { updatedAt: new Date().toISOString(), prices });
  return { matched, priced: Object.keys(prices).length };
}

const stamp = () => new Date().toLocaleTimeString();

async function pushBladeBall() {
  try {
    const { items } = await scrapeBbValues();
    const { history, historyFetched, eldorado } = await readMm2State(BB_PREFIX);
    const now = Date.now();
    // bbvalues.uk's API is too unreliable for per-item history downloads, so Blade Ball history
    // is built from our own updates: every value change we see is recorded.
    mergeMm2History(history, items, now);
    await writeMm2State({ updatedAt: new Date(now).toISOString(), items }, history, historyFetched, BB_PREFIX);
    console.log(`[${stamp()}] Pushed ${items.length} Blade Ball values.`);
    if (process.argv.includes("--prices") || now - (Date.parse(eldorado?.updatedAt) || 0) > ELDORADO_EVERY_MS) {
      try {
        const prices = await fetchBbEldoradoPrices(items);
        await writeMm2Row("eldorado", { updatedAt: new Date().toISOString(), prices }, BB_PREFIX);
        console.log(`[${stamp()}] Blade Ball Eldorado prices: ${Object.keys(prices).length} items listed.`);
      } catch (e) {
        console.error(`[${stamp()}] Blade Ball Eldorado price refresh failed: ${e.message}`);
      }
    }
    return true;
  } catch (e) {
    console.error(`[${stamp()}] Blade Ball push failed: ${e.message}`);
    return false;
  }
}

async function pushOnce() {
  const [mm2, bb] = await Promise.all([pushMm2(), pushBladeBall()]);
  return mm2 && bb;
}

async function pushMm2() {
  try {
    const scraped = await scrapeMm2Values();
    const { latest, history, historyFetched, eldorado } = await readMm2State();
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
    const pulled = await refreshHistories(items, history, historyFetched, now);
    mergeMm2History(history, items, now); // ensures the current value is the latest point
    await writeMm2State({ updatedAt: new Date(now).toISOString(), items }, history, historyFetched);
    const numeric = items.filter((it) => !it.valueText);
    const withHistory = numeric.filter((it) => historyFetched[it.key]).length;
    console.log(`[${stamp()}] Pushed ${items.length} MM2 values (${pulled} histories updated, ${withHistory}/${numeric.length} numeric weapons have full history).`);
    if (process.argv.includes("--prices") || now - (Date.parse(eldorado?.updatedAt) || 0) > ELDORADO_EVERY_MS) {
      try {
        const { matched, priced } = await refreshEldorado(items, eldorado);
        console.log(`[${stamp()}] Eldorado prices: ${priced} weapons listed (of ${matched} matched).`);
      } catch (e) {
        console.error(`[${stamp()}] Eldorado price refresh failed: ${e.message}`);
      }
    }
    return true;
  } catch (e) {
    console.error(`[${stamp()}] MM2 push failed: ${e.message}`);
    return false;
  }
}

if (process.argv.includes("--once")) {
  process.exit((await pushOnce()) ? 0 : 1);
}
await pushOnce();
setInterval(pushOnce, PUSH_EVERY_MS);
