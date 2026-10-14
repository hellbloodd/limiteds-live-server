// Run on a home PC (not Render): scrapes MM2 values from Supreme Values every 15 minutes
// and saves them to Supabase for the live site to read. Cloudflare blocks Render's IPs,
// but lets home connections through.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (see start-mm2-push.bat).
// Usage: node mm2-push.mjs          (keeps running, pushes every 15 minutes)
//        node mm2-push.mjs --once   (push once and exit)
import { scrapeMm2Values, mergeMm2History, readMm2State, writeMm2State } from "./mm2-values.mjs";

const PUSH_EVERY_MS = 15 * 60 * 1000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

async function pushOnce() {
  const stamp = new Date().toLocaleTimeString();
  try {
    const { items, errors } = await scrapeMm2Values();
    if (errors.length) console.warn(`[${stamp}] Some categories failed: ${errors.join("; ")}`);
    const { history } = await readMm2State();
    const now = Date.now();
    mergeMm2History(history, items, now);
    await writeMm2State({ updatedAt: new Date(now).toISOString(), items }, history);
    console.log(`[${stamp}] Pushed ${items.length} MM2 weapon values to Supabase.`);
    return true;
  } catch (e) {
    console.error(`[${stamp}] MM2 push failed: ${e.message}`);
    return false;
  }
}

if (process.argv.includes("--once")) {
  process.exit((await pushOnce()) ? 0 : 1);
}
await pushOnce();
setInterval(pushOnce, PUSH_EVERY_MS);
