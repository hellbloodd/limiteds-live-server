// Agony Values PC booster. Run it on your own PC (start-booster.bat): it takes half of the
// sniper's items and checks them on Eldorado from your home IP - Eldorado limits requests per IP,
// so this roughly doubles how fast new listings are caught. Close it any time; the server takes
// all the items back within ~90 seconds.
//
// Needs: SITE (default https://agony-values.onrender.com) and OWNER_KEY (same as on Render).
import { listingsFor } from "./sniper.mjs";

const SITE = (process.env.SITE || "https://agony-values.onrender.com").replace(/\/$/, "");
const KEY = String(process.env.OWNER_KEY || "").trim();
const PARALLEL = Number(process.env.BOOSTER_PARALLEL || 4); // Eldorado allows ~4 at a time per IP
if (!KEY) { console.error("OWNER_KEY is missing - start the booster with start-booster.bat."); process.exit(1); }

const H = { "x-owner-key": KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;
const started = Date.now();

async function api(path, body) {
  const r = await fetch(SITE + path, { method: body ? "POST" : "GET", headers: H, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (r.status === 401) { console.error("The site refused the owner key - check OWNER_KEY in booster-key.txt."); process.exit(1); }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

console.log(`Agony Values booster - helping ${SITE} (${PARALLEL} at a time). Leave this window open; close it to stop.`);
for (;;) {
  let work;
  try { work = await api(`/api/booster/work?max=${PARALLEL * 6}`); }
  catch (e) { console.log(`Can't reach the site (${e.message}) - retrying in 15 s.`); await sleep(15000); continue; }
  if (!work.items?.length) { await sleep(3000); continue; }

  const queue = [...work.items], results = [];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let job; (job = queue.shift());) {
      const listings = await listingsFor(job.game, job.item).catch(() => null);
      results.push({ game: job.game, key: job.item.key, listings });
    }
  }));
  try {
    await api("/api/booster/results", { results });
    total += results.length;
  } catch (e) { console.log(`Couldn't send results (${e.message}).`); }
  const mins = (Date.now() - started) / 60000;
  process.stdout.write(`\r${new Date().toLocaleTimeString()}  checked ${total} items (${Math.round(total / Math.max(mins, 1))}/min)   `);
}
