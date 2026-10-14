// Run on a home PC (not Render): scrapes MM2 values from Supreme Values every 15 minutes
// and saves them to Supabase for the live site to read. Cloudflare blocks Render's IPs,
// but lets home connections through.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (see start-mm2-push.bat).
// Usage: node mm2-push.mjs          (keeps running, pushes every 15 minutes)
//        node mm2-push.mjs --once   (push once and exit)
import { scrapeMm2Values, mergeMm2History, readMm2State, writeMm2State, fetchSvHistory } from "./mm2-values.mjs";

const PUSH_EVERY_MS = 15 * 60 * 1000;
// Each item's full history is re-pulled from its Supreme Values page when its value changes,
// and otherwise at most once a day, a batch per run so the site isn't hammered.
const HISTORY_STALE_MS = 24 * 60 * 60 * 1000;
const HISTORY_BATCH = 80;
const HISTORY_CONCURRENCY = 2;
const HISTORY_DELAY_MS = 400; // per request, per worker - stays well under Supreme Values' rate limit

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

async function refreshHistories(items, history, historyFetched, now) {
  const changed = items.filter((it) => {
    const points = history[it.key];
    return !points?.length || points[points.length - 1][1] !== it.value;
  });
  const stale = items
    .filter((it) => !changed.includes(it) && now - (historyFetched[it.key] || 0) > HISTORY_STALE_MS)
    .sort((a, b) => (historyFetched[a.key] || 0) - (historyFetched[b.key] || 0));
  // Changed items always; never-fetched/stale ones in batches.
  const queue = [...changed.filter((it) => historyFetched[it.key]), ...[...changed.filter((it) => !historyFetched[it.key]), ...stale].slice(0, HISTORY_BATCH)];
  let ok = 0;
  await Promise.all(Array.from({ length: HISTORY_CONCURRENCY }, async () => {
    for (let it; (it = queue.shift());) {
      try {
        const points = await fetchSvHistory(it);
        if (points.length) { history[it.key] = points; ok++; }
        historyFetched[it.key] = now;
      } catch { /* keep what we have; retried next run */ }
      await new Promise((r) => setTimeout(r, HISTORY_DELAY_MS));
    }
  }));
  return ok;
}

async function pushOnce() {
  const stamp = () => new Date().toLocaleTimeString();
  try {
    const scraped = await scrapeMm2Values();
    const { latest, history, historyFetched } = await readMm2State();
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
    const withHistory = items.filter((it) => historyFetched[it.key]).length;
    console.log(`[${stamp()}] Pushed ${items.length} MM2 values (${pulled} histories updated, ${withHistory}/${items.length} have full history).`);
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
