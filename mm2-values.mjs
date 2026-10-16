// MM2 weapon values tracker.
//
// Values come from mm2values.com (one page per rarity). Values sites block datacenter IPs like
// Render's, so they are scraped from a home PC by mm2-push.mjs and stored in Supabase
// (table mm2_state, see mm2-tables.sql); the live server only reads them from there.
// Without Supabase configured (local dev) the server scrapes directly instead.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";

const MV_ORIGIN = "https://www.mm2values.com";
// Our category -> mm2values.com page (?p=...). Weapon categories only (pets and misc are skipped).
const MV_PAGES = { ancients: "ancient", godlies: "godly", chromas: "chroma", uniques: "unique", vintages: "vintage",
  legendaries: "legend", rares: "rare", uncommons: "uncommon", commons: "common" };
export const MM2_CATEGORIES = Object.keys(MV_PAGES);
const MM2_SCRAPE_MS = 15 * 60 * 1000;
const MM2_SUPABASE_POLL_MS = 5 * 60 * 1000;
const MM2_HISTORY_MAX_POINTS = 500;
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HERE = dirname(fileURLToPath(import.meta.url));

let mm2Items = [];
let mm2UpdatedAt = 0;
let mm2History = {}; // { itemKey: [[timestamp, value], ...] }
let mm2LastError = "";
let mm2Eldorado = { updatedAt: null, prices: {} }; // prices: { itemKey: { usd, listings, url } }
let mm2PriceHistory = {};
let mm2Sales = {};

// ---------- Supabase ----------

export function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  return url && key ? { url, key } : null;
}

async function supabaseFetch(path, options = {}) {
  const { url, key } = supabaseConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// The mm2_state table holds one row per piece of state. MM2 uses unprefixed ids
// (latest, history, ...); other games use a prefix, e.g. "bb_latest" for Blade Ball.
const STATE_IDS = ["latest", "history", "history_fetched", "eldorado", "eldorado_history", "sales", "heartbeat"];

export async function readMm2State(prefix = "", only = STATE_IDS) {
  const rows = [];
  for (const id of only) rows.push(...await supabaseFetch(`mm2_state?select=id,data&id=eq.${prefix + id}`));
  const byId = Object.fromEntries(rows.map((r) => [r.id.slice(prefix.length), r.data]));
  return { latest: byId.latest || null, history: byId.history || {}, historyFetched: byId.history_fetched || {}, eldorado: byId.eldorado || null,
    priceHistory: byId.eldorado_history || {}, sales: byId.sales || {}, heartbeat: byId.heartbeat || null };
}

// Server side: each poll asks only for the rows' updated_at (tiny) and re-downloads just the rows
// that changed since last time - Supabase's free tier slows to a crawl if we pull megabytes every poll.
export function createStateReader(prefix = "") {
  const seen = {};
  const data = {};
  return async () => {
    const ids = STATE_IDS.map((id) => prefix + id).join(",");
    const meta = await supabaseFetch(`mm2_state?select=id,updated_at&id=in.(${ids})`);
    const changed = meta.filter((m) => seen[m.id] !== m.updated_at).map((m) => m.id);
    if (changed.length) {
      const rows = await supabaseFetch(`mm2_state?select=id,data,updated_at&id=in.(${changed.join(",")})`);
      for (const r of rows) { data[r.id.slice(prefix.length)] = r.data; seen[r.id] = r.updated_at; }
    }
    return { latest: data.latest || null, history: data.history || {}, eldorado: data.eldorado || null,
      priceHistory: data.eldorado_history || {}, sales: data.sales || {}, heartbeat: data.heartbeat || null };
  };
}

// Pusher side: upsert only the rows whose content differs from what was last read or written.
const lastWritten = {}; // full row id -> JSON
export function rememberRows(prefix, rows) {
  for (const [id, d] of Object.entries(rows)) if (d != null) lastWritten[prefix + id] = JSON.stringify(d);
}
export async function writeChangedRows(prefix, rows) {
  const now = new Date().toISOString();
  const out = [];
  for (const [id, d] of Object.entries(rows)) {
    const json = JSON.stringify(d);
    if (lastWritten[prefix + id] === json) continue;
    out.push({ id: prefix + id, data: d, updated_at: now });
    lastWritten[prefix + id] = json;
  }
  if (out.length) {
    await supabaseFetch("mm2_state?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(out),
    });
  }
  return out.map((r) => r.id);
}

// Each game's Supabase reader, so the updater can make the pages show new values right away.
const supabaseTicks = [];
export async function reloadAllTrackers() {
  await Promise.all(supabaseTicks.map((tick) => tick()));
}

// One row's data (or null).
export async function readRow(id) {
  const rows = await supabaseFetch(`mm2_state?select=data&id=eq.${id}`);
  return rows[0]?.data ?? null;
}

export async function writeMm2Row(id, data, prefix = "") {
  await supabaseFetch("mm2_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id: prefix + id, data, updated_at: new Date().toISOString() }]),
  });
}

// historyFetched: { itemKey: ms } — when each item's history was last pulled from the values site.
export async function writeMm2State(latest, history, historyFetched = {}, prefix = "") {
  const now = new Date().toISOString();
  await supabaseFetch("mm2_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      { id: prefix + "latest", data: latest, updated_at: now },
      { id: prefix + "history", data: history, updated_at: now },
      { id: prefix + "history_fetched", data: historyFetched, updated_at: now },
    ]),
  });
}

// ---------- Scraping ----------

function decodeHtml(text) {
  return text.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function parseNumber(text) {
  const n = Number(String(text || "").replace(/[^0-9.\-]/g, ""));
  return text && Number.isFinite(n) ? n : null;
}

function pick(block, re) {
  const m = block.match(re);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, "")) : "";
}

const slug = (name) => name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// One mm2values.com page: each item is a <div class=stackable> block like
//   <img src='img/Evergun.png'><b>Evergun</b><br> Value: 3,425<br>Range: N/A <br>
//   Demand: 5 - Rarity: 3.5<br>Stability: Stable<hr>
export function parseCategoryPage(html, category) {
  const items = [];
  for (const chunk of html.split("<div class=stackable>").slice(1)) {
    const block = chunk.split("<input")[0];
    const name = pick(block, /<b>([\s\S]*?)<\/b>/);
    const value = parseNumber(pick(block, /Value:\s*([\d,.]+)/));
    if (!name || !(value > 0)) continue;
    const range = pick(block, /Range:\s*([^<]*)/);
    const image = pick(block, /<img src='([^']+)'/);
    items.push({
      key: `${category}:${slug(name)}`,
      name,
      category,
      value,
      valueText: "",
      range: range && !/^n\/a$/i.test(range) ? range : "",
      stability: pick(block, /Stability:\s*([^<]*)/),
      demand: parseNumber(pick(block, /Demand:\s*([\d.]+)/)),
      rarity: parseNumber(pick(block, /Rarity:\s*([\d.]+)/)),
      origin: "",
      image: image ? new URL(image, `${MV_ORIGIN}/`).href : "",
      sourceUrl: `${MV_ORIGIN}/?p=${MV_PAGES[category]}`,
    });
  }
  return items;
}

// curl rather than fetch(): Cloudflare blocks Node's own HTTP clients even from home IPs.
export function curlGet(url, headers = ["Accept: text/html,application/xhtml+xml"]) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sSL", "--fail", "--max-time", "30", "-A", UA,
      ...headers.flatMap((h) => ["-H", h]), "-H", "Accept-Language: en-US,en;q=0.9", url],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true },
    (error, stdout, stderr) => (error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(stdout)));
  });
}

// Scrapes every category. Throws if nothing at all could be fetched.
export async function scrapeMm2Values() {
  // One page at a time, to go easy on the site.
  const results = [];
  for (const c of MM2_CATEGORIES) {
    results.push(await curlGet(`${MV_ORIGIN}/?p=${MV_PAGES[c]}`).then((html) => ({ status: "fulfilled", value: parseCategoryPage(html, c) }), (reason) => ({ status: "rejected", reason })));
  }
  const items = [];
  const errors = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? items.push(...r.value) : errors.push(`${MM2_CATEGORIES[i]}: ${r.reason.message}`)));
  if (!items.length) throw new Error(`No MM2 values scraped (${errors[0] || "empty pages"})`);
  return { items: cleanMm2Items(items), errors };
}

// Drops items with no value and the Gold/Silver/Bronze/Blue/Red/Purple prize "sets" (removed on
// request), and keeps one entry per name — the highest-valued one when several categories share it.
const PRIZE_SET = /^(gold|silver|bronze|blue|red|purple)\s/i;
function cleanMm2Items(items) {
  const byName = new Map();
  for (const item of items) {
    if (item.value == null) continue;
    if (item.category === "uniques" && PRIZE_SET.test(item.name)) continue;
    const name = item.name.toLowerCase();
    const kept = byName.get(name);
    if (!kept || item.value > kept.value) byName.set(name, item);
  }
  return [...byName.values()];
}

// From listing prices sorted low -> high: the cheapest real listing (skipping ones far below the
// rest - usually mislabelled items) and the next one up (what a flip would undercut).
export function pickPrices(sorted) {
  const median = sorted[Math.floor(Math.min(sorted.length, 5) / 2)]; // of the 5 cheapest
  const i = sorted.findIndex((v) => v >= median * 0.5);
  return { usd: sorted[i], second: sorted[i + 1] ?? null };
}

// ---------- Eldorado sales tracking ----------
// Each price check keeps the item's cheapest listings as [offerId, usd, quantity, expiresMs, sellerId].
// Comparing two checks: a listing whose quantity went down sold that many; a listing that vanished
// probably sold - unless it expired, its seller relisted, or newer cheaper listings just pushed it
// out of the window we look at. Sales are kept as { itemKey: [[unixSeconds, usd, qty], ...] }.
export const offerTuple = (r) => [r.offer?.id, r.offer?.pricePerUnitInUSD?.amount, r.offer?.quantity ?? 1,
  Date.parse(r.offer?.expireDate) || 0, r.offer?.userId || r.user?.id || ""];

// offers: tuples seen this check; full: true if only the first `n` listings were fetched (so anything
// priced above the last one we saw may still exist).
export function listingWindow(offers, full) {
  return { offers, windowMax: full && offers.length ? Math.max(...offers.map((o) => o[1])) : Infinity };
}

export function detectSales(prevByKey, prices, now = Date.now()) {
  const events = {};
  for (const [key, prev] of Object.entries(prevByKey)) {
    const p = prices[key];
    if (!p?.offers || !prev?.offers) continue; // price check failed this time - can't tell
    const cur = new Map(p.offers.map((o) => [o[0], o]));
    const sellersNow = new Set(p.offers.map((o) => o[4]));
    for (const [id, usd, qty, expires, seller] of prev.offers) {
      const c = cur.get(id);
      let sold = 0, price = usd;
      if (c) { if (c[2] < qty) { sold = qty - c[2]; price = c[1]; } }
      else if (!(expires && expires <= now) && usd <= p.windowMax && !(seller && sellersNow.has(seller))) sold = 1;
      if (sold > 0 && usd > 0) (events[key] ||= []).push([Math.round(now / 1000), Math.round(price * 100) / 100, sold]);
    }
  }
  return events;
}

// Adds new sale events and drops ones older than 30 days. Returns true if anything was added.
export function mergeSales(sales, events, now = Date.now()) {
  const cutoff = now / 1000 - 30 * 86400;
  for (const [key, list] of Object.entries(events)) (sales[key] ||= []).push(...list);
  for (const [key, list] of Object.entries(sales)) {
    const kept = list.filter((e) => e[0] >= cutoff);
    if (kept.length) sales[key] = kept; else delete sales[key];
  }
  return Object.keys(events).length > 0;
}

// { sold24h, sold7d, soldPrice } - soldPrice is the median price of sales in the last 7 days.
export function salesStats(list, now = Date.now()) {
  if (!list?.length) return { sold24h: 0, sold7d: 0, soldPrice: null };
  const t = now / 1000;
  let sold24h = 0, sold7d = 0;
  const prices = [];
  for (const [ts, usd, qty] of list) {
    if (ts >= t - 86400) sold24h += qty;
    if (ts >= t - 7 * 86400) { sold7d += qty; prices.push(usd); }
  }
  prices.sort((a, b) => a - b);
  return { sold24h, sold7d, soldPrice: prices.length ? prices[prices.length >> 1] : null };
}

// ---------- Eldorado price history ----------
// { itemKey: [[day, usd], ...] } where day = days since 1970 (UTC). One point per day at most, and a
// new point only when the price differs from the previous one (so a flat price costs nothing).
const DAY_MS = 864e5;
const PRICE_HISTORY_MAX_POINTS = 400;

export function recordPriceHistory(hist, prices, now = Date.now()) {
  const day = Math.floor(now / DAY_MS);
  for (const [key, p] of Object.entries(prices)) {
    if (!(p?.usd > 0)) continue;
    const usd = Math.round(p.usd * 100) / 100;
    const points = hist[key] || (hist[key] = []);
    const last = points[points.length - 1];
    if (last && last[0] === day) {
      last[1] = usd; // keep today's latest price
      const prev = points[points.length - 2];
      if (prev && prev[1] === usd) points.pop(); // back to yesterday's price: no change point needed
    } else if (!last || last[1] !== usd) {
      points.push([day, usd]);
      if (points.length > PRICE_HISTORY_MAX_POINTS) points.splice(0, points.length - PRICE_HISTORY_MAX_POINTS);
    }
  }
}

// Price now vs 7 days / 30 days / 6 months / 1 year ago. A period is left out until we have
// history that old (no "first price we saw" fallback - the comparison would be misleading).
const PRICE_PERIODS = { "7d": 7, "30d": 30, "6m": 182, "1y": 365 };
export function priceChangesFrom(points, usd) {
  const out = {};
  if (!points?.length || !(usd > 0)) return out;
  const today = Math.floor(Date.now() / DAY_MS);
  for (const [period, days] of Object.entries(PRICE_PERIODS)) {
    const cutoff = today - days;
    if (points[0][0] > cutoff) continue;
    const then = points.filter(([d]) => d <= cutoff).pop()[1];
    out[period] = { then, pct: Math.round((usd - then) / then * 1000) / 10 };
  }
  return out;
}

// Appends changed values to history in place. Returns true if anything changed.
export function mergeMm2History(history, items, now) {
  let changed = false;
  for (const item of items) {
    if (item.value == null || item.valueText) continue;
    const points = history[item.key] || (history[item.key] = []);
    const last = points[points.length - 1];
    if (!last || last[1] !== item.value) {
      points.push([now, item.value]);
      if (points.length > MM2_HISTORY_MAX_POINTS) points.splice(0, points.length - MM2_HISTORY_MAX_POINTS);
      changed = true;
    }
  }
  return changed;
}

// ---------- Eldorado prices ----------
// Uses the public endpoints Eldorado's own MM2 shop page calls. Items there are a tree of
// type > rarity > name (names carry a year, e.g. "Evergun (2023)"); Chroma is a property filter.

const ELDORADO = "https://www.eldorado.gg";
const ELDORADO_SHOP = `${ELDORADO}/mm2-shop/i/204-2-0`;
const ELDORADO_RARITIES = { godlies: ["Godly"], ancients: ["Ancient"], uniques: ["Unique"], vintages: ["Vintage"], evos: ["Godly", "Ancient", "Unique"], legendaries: ["Legendary"], rares: ["Rare"], uncommons: ["Uncommon"], commons: ["Common"] };

// All four games' price refreshes run at the same time; one shared limit keeps the total number of
// requests to Eldorado in flight at ELDORADO_CONCURRENCY so we stay under its rate limit.
// (Kept as a pass-through so callers don't change.)
export function eldoradoExclusive(fn) { return fn(); }

const ELDORADO_CONCURRENCY = Number(process.env.ELDORADO_CONCURRENCY || 4); // more than ~4 at once gets 429s
let eldoradoActive = 0;
const eldoradoWaiting = [];
async function eldoradoSlot() {
  if (eldoradoActive < ELDORADO_CONCURRENCY) { eldoradoActive++; return; }
  await new Promise((res) => eldoradoWaiting.push(res)); // the finishing request hands its slot over
}
function eldoradoRelease() {
  const next = eldoradoWaiting.shift();
  if (next) next(); else eldoradoActive--;
}

// Retries "429 Too Many Requests" after a short pause.
export async function eldoradoJson(path) {
  for (let attempt = 1; ; attempt++) {
    await eldoradoSlot();
    let res;
    try { res = await fetch(ELDORADO + path, { headers: { "User-Agent": UA, Accept: "application/json" } }); }
    finally { eldoradoRelease(); }
    if (res.ok) return res.json();
    if (res.status !== 429 || attempt >= 6) throw new Error(`Eldorado ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 2500 + Math.random() * 1000)); // back off, spread out retries
  }
}

// All knife/gun items on Eldorado as [type, rarity, name].
export async function fetchEldoradoItems() {
  const tree = await eldoradoJson("/api/library/204/CustomItem?locale=en-US");
  const leaves = [];
  const walk = (n, path) => {
    const p = path.concat(n.value);
    if (n.childTradeEnvironments?.length) n.childTradeEnvironments.forEach((k) => walk(k, p));
    else if (p.length === 3 && (p[0] === "Knife" || p[0] === "Gun")) leaves.push(p);
  };
  tree.tradeEnvironments.forEach((n) => walk(n, []));
  return leaves;
}

// Compared without spaces: "Swirlygun" / "Swirly Gun", "Log Chopper" / "Logchopper".
const normName = (s) => s.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "");

// Finds the Eldorado item for an MM2 item, or null if there's no single clear match.
export function matchEldorado(item, leaves) {
  let name = item.name, type = null, chroma = item.category === "chromas";
  if (/^(chroma|c\.)\s+/i.test(name)) { chroma = true; name = name.replace(/^(chroma|c\.)\s+/i, ""); }
  const t = name.match(/\((gun|knife)\)\s*$/i);
  if (t) { type = t[1][0].toUpperCase() + t[1].slice(1).toLowerCase(); name = name.replace(/\((gun|knife)\)\s*$/i, ""); }
  let cands = leaves.filter((l) => normName(l[2]) === normName(name) && (!type || l[0] === type));
  // mm2values.com writes the type as a plain suffix ("Cane Knife", "Bones Gun") where Eldorado has
  // "Cane (2015)" under Knife - retry without it.
  const suffix = !cands.length && name.match(/\s(gun|knife)\s*$/i);
  if (suffix) {
    type = suffix[1][0].toUpperCase() + suffix[1].slice(1).toLowerCase();
    const base = normName(name.replace(/\s(gun|knife)\s*$/i, ""));
    cands = leaves.filter((l) => normName(l[2]) === base && l[0] === type);
  }
  const narrow = (f) => { const c = cands.filter(f); if (c.length) cands = c; };
  const rarities = chroma ? ["Godly", "Ancient"] : ELDORADO_RARITIES[item.category] || [];
  // High tiers must match rarity exactly - e.g. the Godly "Batwing" is not Eldorado's Ancient Batwing.
  if (["godlies", "ancients", "uniques", "vintages"].includes(item.category)) cands = cands.filter((l) => rarities.includes(l[1]));
  else if (cands.length > 1) narrow((l) => rarities.includes(l[1]));
  if (cands.length > 1) { // same name released in several years: use the year in the item's origin
    const year = (item.origin.match(/\b(20\d\d)\b/) || [])[1];
    if (year) narrow((l) => l[2].includes(`(${year})`));
  }
  return cands.length === 1 ? { type: cands[0][0], rarity: cands[0][1], name: cands[0][2], chroma } : null;
}

function eldoradoFilter(m) {
  return `tradeEnvironmentValue0=${encodeURIComponent(m.type)}&tradeEnvironmentValue1=${encodeURIComponent(m.rarity)}`
    + `&tradeEnvironmentValue2=${encodeURIComponent(m.name)}&mm2-properties=${m.chroma ? "chroma" : "common"}`;
}

// Cheapest listing (USD) and number of listings for one matched item.
export async function fetchEldoradoPrice(m) {
  const j = await eldoradoJson("/api/v1/item-management/offers?gameId=204&category=CustomItem&pageIndex=1&pageSize=5"
    + "&useMinPurchasePrice=false&useOfferAttributeSearch=false&usePopularItems=false&offerSortingCriterion=Price&isAscending=true&"
    + eldoradoFilter(m));
  const offers = (j.results || []).map(offerTuple).filter((o) => o[1] > 0);
  const prices = offers.map((o) => o[1]).sort((a, b) => a - b);
  if (!prices.length) return { offers: [], windowMax: Infinity }; // no listings now (lets sales tracking see it)
  // Skip listings far below the rest - usually a mis-tagged item (a normal Traveler's Gun listed as Chroma).
  const { usd, second } = pickPrices(prices);
  return {
    usd, second, listings: j.recordCount || prices.length, ...listingWindow(offers, (j.recordCount || 0) > offers.length),
    url: `${ELDORADO_SHOP}?te_v0=${encodeURIComponent(m.type)}&te_v1=${encodeURIComponent(m.rarity)}&te_v2=${encodeURIComponent(m.name)}${m.chroma ? "&mm2-properties=chroma" : ""}`,
  };
}

// ---------- Server ----------

let readMm2Rows;
async function loadFromSupabase() {
  try {
    readMm2Rows ||= createStateReader();
    const { latest, history, eldorado, heartbeat, priceHistory, sales } = await readMm2Rows();
    mm2PriceHistory = priceHistory;
    mm2Sales = sales;
    if (eldorado?.prices) mm2Eldorado = eldorado;
    if (latest?.items?.length) {
      mm2Items = latest.items;
      mm2UpdatedAt = Date.parse(heartbeat?.updatedAt || latest.updatedAt) || 0;
    }
    mm2History = history;
    mm2LastError = latest ? "" : "No MM2 values in Supabase yet — run mm2-push.mjs on a home PC.";
  } catch (e) {
    mm2LastError = e.message;
    console.warn(`MM2 Supabase read failed: ${e.message}`);
  }
}

async function scrapeLocally() {
  try {
    const { items, errors } = await scrapeMm2Values();
    if (errors.length) console.warn(`MM2 scrape errors: ${errors.join("; ")}`);
    mm2UpdatedAt = Date.now();
    mergeMm2History(mm2History, items, mm2UpdatedAt);
    mm2Items = items;
    mm2LastError = "";
    console.log(`MM2 values scraped: ${items.length} weapons.`);
  } catch (e) {
    mm2LastError = e.message;
    console.warn(`MM2 scrape failed: ${e.message}`);
  }
}

export function startMm2Tracker() {
  const [tick, every] = supabaseConfig() ? [loadFromSupabase, MM2_SUPABASE_POLL_MS] : [scrapeLocally, MM2_SCRAPE_MS];
  registerSupabaseTick(tick);
  tick();
  setInterval(tick, every).unref();
}

function eldoradoFields(it) {
  const p = mm2Eldorado.prices[it.key];
  if (!p?.usd) return {};
  return { usd: p.usd, second: p.second ?? null, ladder: p.ladder || null, listings: p.listings, eldoradoUrl: p.url, valuePerUsd: Math.round(it.value / p.usd * 10) / 10,
    priceChanges: priceChangesFrom(mm2PriceHistory[it.key], p.usd), ...salesStats(mm2Sales[it.key]) };
}

// History without points from before the item had a real value (fractional sort-order numbers below 1).
function numericHistory(key) {
  return (mm2History[key] || []).filter(([, v]) => v >= 1);
}

const MM2_PERIODS = { "24h": 1, "7d": 7, "30d": 30, "1y": 365, all: 0 };

// Value change over each period, from history: compares the current value with the value
// that was in effect at the start of the period (or the first recorded value if the item is newer).
export function periodChanges(points, current) {
  const out = {};
  if (!points?.length || current == null) return out;
  const now = Date.now();
  for (const [period, days] of Object.entries(MM2_PERIODS)) {
    const cutoff = now - days * 864e5;
    const base = days ? (points.filter(([t]) => t <= cutoff).pop() || points[0])[1] : points[0][1];
    out[period] = { abs: current - base, pct: base ? Math.round((current - base) / base * 1000) / 10 : 0 };
  }
  return out;
}

// Last ~90 days of values, sampled to at most 30 points, for the mini chart on each card.
export function sparkline(points) {
  if (!points?.length) return [];
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recent = points.filter(([t]) => t >= cutoff);
  // Start from the value that was current at the cutoff so flat items still draw a line.
  const before = points.filter(([t]) => t < cutoff).pop();
  const values = [...(before ? [before[1]] : []), ...recent.map(([, v]) => v)];
  if (values.length < 2) return values.length ? [values[0], values[0]] : [];
  const step = Math.max(1, Math.ceil(values.length / 30));
  const out = values.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== values[values.length - 1]) out.push(values[values.length - 1]);
  return out;
}

export function registerSupabaseTick(tick) {
  if (supabaseConfig()) supabaseTicks.push(tick);
}

// mm2.html is shared by every game page; the config fills in the game-specific parts.
export async function sendGamePage(res, config) {
  const html = (await readFile(join(HERE, "mm2.html"), "utf8"))
    .replace("/*GAME_CONFIG*/", `window.GAME = ${JSON.stringify(config).replace(/</g, "\\u003c")};`);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// Returns true if the request was handled.
export async function handleMm2Request(url, res, sendJson) {
  if (url.pathname === "/mm2" || url.pathname === "/mm2/") {
    await sendGamePage(res, { api: "/api/mm2", title: "MM2 Values", tab: "mm2", noun: "MM2 weapons",
      sourceName: "mm2values.com", sourceUrl: "https://www.mm2values.com/?p=godly", shopUrl: "https://www.eldorado.gg/mm2-shop/i/204-2-0" });
    return true;
  }
  if (url.pathname === "/api/mm2") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const category = url.searchParams.get("category") || "";
    const items = mm2Items
      .filter((it) => (!q || it.name.toLowerCase().includes(q)) && (!category || it.category === category))
      // Ratio-valued items ("x2 T1 Commons") have no real number to chart or compare.
      .map((it) => (it.valueText ? { ...it, spark: [], changes: {} }
        : { ...it, spark: sparkline(numericHistory(it.key)), changes: periodChanges(numericHistory(it.key), it.value), ...eldoradoFields(it) }));
    sendJson(res, 200, {
      updatedAt: mm2UpdatedAt ? new Date(mm2UpdatedAt).toISOString() : null,
      pricesUpdatedAt: mm2Eldorado.updatedAt,
      source: "mm2values.com", count: items.length, categories: MM2_CATEGORIES, items,
      ...(mm2Items.length ? {} : { error: mm2LastError || "MM2 values are still loading." }),
    });
    return true;
  }
  if (url.pathname === "/api/mm2/history") {
    const key = url.searchParams.get("key") || "";
    const ratio = mm2Items.find((it) => it.key === key)?.valueText;
    sendJson(res, 200, { key, points: ratio ? [] : numericHistory(key), pricePoints: mm2PriceHistory[key] || [] });
    return true;
  }
  return false;
}
