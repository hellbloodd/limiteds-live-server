// Agony Values PC booster. Run it on your own PC (start-booster.bat): it takes half of the
// sniper's items and checks them on Eldorado from your home IP - Eldorado limits requests per IP,
// so this roughly doubles how fast new listings are caught. Close it any time; the server takes
// all the items back within ~90 seconds.
//
// Needs: SITE (default https://agony-values.onrender.com) and OWNER_KEY (same as on Render).
import { listingsFor } from "./sniper.mjs";
import { fetchAmEldoradoPrices } from "./am-values.mjs";
import { scrapeBbValues } from "./bb-values.mjs";

// GameBoost + Itemku in a hidden Chrome every 30 minutes (they block plain requests).
const MARKETS_EVERY_MS = Number(process.env.BOOSTER_MARKETS_MIN || 30) * 60 * 1000;
let marketsRunning = false, marketsAt = Date.now() - MARKETS_EVERY_MS + 2 * 60 * 1000; // first run ~2 min after start
async function runMarkets() {
  marketsRunning = true; marketsAt = Date.now();
  try {
    const { scanBrowserMarkets } = await import("./browser-markets.mjs");
    const items = {};
    for (const [g, path] of [["MM2", "/api/mm2"], ["Blade Ball", "/api/bladeball"], ["Adopt Me", "/api/adoptme"], ["Steal a Brainrot", "/api/stealabrainrot"]])
      items[g] = (await (await fetch(SITE + path, { signal: AbortSignal.timeout(60000) })).json()).items || [];
    console.log(`
${new Date().toLocaleTimeString()}  Reading GameBoost and Itemku...`);
    const result = await scanBrowserMarkets(items, (m) => console.log(`  ${m}`));
    for (const [market, games] of Object.entries(result)) if (Object.keys(games).length) await api("/api/booster/market", { market, games });
    // Blade Ball tokens + Robux on U7BUY / GameBoost / Itemku
    const { scanCurrency } = await import("./browser-markets.mjs");
    await api("/api/booster/currency", { markets: await scanCurrency((m) => console.log(`  ${m}`)) }).catch((e) => console.log(`  currency failed: ${e.message}`));
    console.log(`${new Date().toLocaleTimeString()}  GameBoost / Itemku prices sent.`);
  } catch (e) { console.log(`
GameBoost / Itemku scan failed: ${e.message}`); }
  finally { marketsRunning = false; }
}

const FULL = {
  "Adopt Me": (items) => fetchAmEldoradoPrices(items),
  "Blade Ball values": async () => (await scrapeBbValues()).items, // when bbvalues.uk blocks the server
  // robloxtools.net (Blade Ball second value source) refuses the server's address, not a home connection
  "Blade Ball second values": async () => {
    const r = await fetch("https://www.robloxtools.net/values/blade-ball", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } });
    if (!r.ok) throw new Error(`robloxtools ${r.status}`);
    return { html: await r.text() };
  },
};
let fullRunning = false;
// A whole game's price refresh handed over by the server (runs alongside the item checks).
async function runFull() {
  fullRunning = true;
  try {
    const job = await api("/api/booster/full");
    if (!job.game || !FULL[job.game]) return;
    const t0 = Date.now();
    console.log(`
${new Date().toLocaleTimeString()}  Fetching ${job.game} for the server...`);
    const prices = await FULL[job.game](job.items);
    const r = await api("/api/booster/full", { game: job.game, prices });
    console.log(`${new Date().toLocaleTimeString()}  ${job.game}: ${r.priced ?? 0} sent in ${Math.round((Date.now() - t0) / 1000)} s.`);
  } catch (e) { console.log(`
Full refresh failed: ${e.message}`); }
  finally { fullRunning = false; }
}

const SITE = (process.env.SITE || "https://agony-values.onrender.com").replace(/\/$/, "");
const KEY = String(process.env.OWNER_KEY || "").trim();
const PARALLEL = Number(process.env.BOOSTER_PARALLEL || 4); // Eldorado allows ~4 at a time per IP
if (!KEY) { console.error("OWNER_KEY is missing - start the booster with start-booster.bat."); process.exit(1); }

const H = { "x-owner-key": KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;
const started = Date.now();

async function api(path, body) {
  const r = await fetch(SITE + path, { method: body ? "POST" : "GET", headers: H, body: body && JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (r.status === 401) { console.error("The site refused the owner key - check OWNER_KEY in booster-key.txt."); process.exit(1); }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

console.log(`Agony Values booster - helping ${SITE} (${PARALLEL} at a time). Leave this window open; close it to stop.`);
for (;;) {
  let work;
  try { work = await api(`/api/booster/work?max=${PARALLEL * 6}`); }
  catch (e) { console.log(`Can't reach the site (${e.message}) - retrying in 15 s.`); await sleep(15000); continue; }
  if (work.full && !fullRunning) runFull();
  if (!marketsRunning && (work.scanMarkets || Date.now() - marketsAt > MARKETS_EVERY_MS)) runMarkets(); // scanMarkets: "Refresh now" on the site
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
