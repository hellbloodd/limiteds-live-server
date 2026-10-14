// Manual update from a PC (the live server normally updates itself every 15 minutes and on
// "Refresh now"). Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (see start-mm2-push.bat).
// Usage: node mm2-push.mjs            (update once and exit)
//        node mm2-push.mjs --prices   (also refresh Eldorado prices now)
import { runUpdate, pendingPrices } from "./updater.mjs";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}
const ok = await runUpdate({ prices: process.argv.includes("--prices") });
await Promise.all(pendingPrices);
process.exit(ok ? 0 : 1);
