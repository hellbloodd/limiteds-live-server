// MM2 weapon values tracker.
//
// Supreme Values sits behind Cloudflare, which blocks datacenter IPs like Render's.
// So the values are scraped from a home PC by mm2-push.mjs and stored in Supabase
// (table mm2_state, see mm2-tables.sql); the live server only reads them from there.
// Without Supabase configured (local dev) the server scrapes directly instead.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";

const SV_ORIGIN = "https://supremevalues.com";
const SV_BASE = `${SV_ORIGIN}/mm2`;
// Weapon categories only (pets, sets and misc are skipped).
export const MM2_CATEGORIES = ["ancients", "godlies", "chromas", "uniques", "vintages", "evos", "legendaries", "rares", "uncommons", "commons"];
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
const STATE_IDS = ["latest", "history", "history_fetched", "eldorado"];

export async function readMm2State(prefix = "") {
  const ids = STATE_IDS.map((id) => prefix + id).join(",");
  const rows = await supabaseFetch(`mm2_state?select=id,data&id=in.(${ids})`);
  const byId = Object.fromEntries(rows.map((r) => [r.id.slice(prefix.length), r.data]));
  return { latest: byId.latest || null, history: byId.history || {}, historyFetched: byId.history_fetched || {}, eldorado: byId.eldorado || null };
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

export function parseCategoryPage(html, category) {
  const items = [];
  // Each item is an itemcolumn (carrying the numeric data-value) wrapping an itemcell.
  for (const chunk of html.split('<div class="itemcolumn"').slice(1)) {
    if (!chunk.includes('class="itemcell"')) continue;
    const id = pick(chunk, /class="itemcell"\s+id="([^"]*)"/);
    // Low tiers show a trade ratio ("x4 T1 Legendaries") instead of a number; data-value has the number.
    const valueText = pick(chunk, /class="itemvalue[^"]*">([^<]*)</);
    const dataValue = Number(pick(chunk, /^[^>]*data-value="([^"]*)"/));
    const name = pick(chunk, /class="itemhead">([\s\S]*?)<\/div>/);
    if (!name) continue;
    const image = pick(chunk, /<img class="itemimage" src="([^"]+)"/);
    items.push({
      key: `${category}:${id || name}`,
      name,
      category,
      value: Number.isFinite(dataValue) && pick(chunk, /^[^>]*data-value="([^"]*)"/) !== "" ? dataValue : parseNumber(valueText),
      valueText: /^[\d,.\s]*$/.test(valueText) ? "" : valueText,
      range: pick(chunk, /class="itemrange">([^<]*)</),
      stability: pick(chunk, /class="itemstability[^"]*">([^<]*)</),
      demand: parseNumber(pick(chunk, /Demand - <b>([^<]*)</)),
      rarity: parseNumber(pick(chunk, /Rarity - <b>([^<]*)</)),
      origin: pick(chunk, /class="itemorigin">([^<]*)</),
      change: parseNumber(pick(chunk, /Change in Value - \(<b[^>]*>([^<]*)<\/b>/)),
      changePct: pick(chunk, /class="sv-pctchange[^"]*">([^<]*)</),
      image: image ? new URL(image, `${SV_ORIGIN}/`).href : "",
      sourceUrl: `${SV_BASE}/${category}?item=${encodeURIComponent(id || name)}`,
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
  // One category at a time: firing all ten at once trips Supreme Values' rate limit (HTTP 429).
  const results = [];
  for (const c of MM2_CATEGORIES) {
    results.push(await curlGet(`${SV_BASE}/${c}`).then((html) => ({ status: "fulfilled", value: parseCategoryPage(html, c) }), (reason) => ({ status: "rejected", reason })));
  }
  const items = [];
  const errors = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? items.push(...r.value) : errors.push(`${MM2_CATEGORIES[i]}: ${r.reason.message}`)));
  if (!items.length) throw new Error(`No MM2 values scraped (${errors[0] || "empty pages"})`);
  return { items: cleanMm2Items(items), errors };
}

// Drops items with no value (one-off leaderboard prizes like the Gold/Silver/Bronze uniques)
// and keeps one entry per name — the highest-valued one when several categories share it.
function cleanMm2Items(items) {
  const byName = new Map();
  for (const item of items) {
    if (item.value == null) continue;
    const name = item.name.toLowerCase();
    const kept = byName.get(name);
    if (!kept || item.value > kept.value) byName.set(name, item);
  }
  return [...byName.values()];
}

// Full value history from the item's Supreme Values page, as [[ms, value], ...].
// The page embeds it as "history":[{"v":2000,"t":"2023-12-22 22:55:02"}, ...].
export async function fetchSvHistory(item) {
  const html = await curlGet(item.sourceUrl);
  const m = html.match(/"history":(\[[^\]]*\])/);
  if (!m) return [];
  return JSON.parse(m[1])
    .map((p) => [Date.parse(`${String(p.t).replace(" ", "T")}Z`), Number(p.v)])
    .filter(([t, v]) => Number.isFinite(t) && v >= 1) // below 1 = the fractional sort order used before an item had a real value
    .slice(-MM2_HISTORY_MAX_POINTS);
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

// Retries "429 Too Many Requests" after a short pause (MM2 and Blade Ball refresh at the same time).
export async function eldoradoJson(path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ELDORADO + path, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status !== 429 || attempt >= 5) throw new Error(`Eldorado ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
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

const normName = (s) => s.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Finds the Eldorado item for a Supreme Values item, or null if there's no single clear match.
export function matchEldorado(item, leaves) {
  let name = item.name, type = null, chroma = item.category === "chromas";
  if (/^(chroma|c\.)\s+/i.test(name)) { chroma = true; name = name.replace(/^(chroma|c\.)\s+/i, ""); }
  const t = name.match(/\((gun|knife)\)\s*$/i);
  if (t) { type = t[1][0].toUpperCase() + t[1].slice(1).toLowerCase(); name = name.replace(/\((gun|knife)\)\s*$/i, ""); }
  const n = normName(name);
  let cands = leaves.filter((l) => normName(l[2]) === n && (!type || l[0] === type));
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
  const prices = (j.results || []).map((r) => r.offer?.pricePerUnitInUSD?.amount).filter((v) => v > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  // Skip listings far below the rest - usually a mis-tagged item (a normal Traveler's Gun listed as Chroma).
  const median = prices[Math.floor(prices.length / 2)];
  const usd = prices.find((v) => v >= median * 0.5);
  return {
    usd, listings: j.recordCount || prices.length,
    url: `${ELDORADO_SHOP}?te_v0=${encodeURIComponent(m.type)}&te_v1=${encodeURIComponent(m.rarity)}&te_v2=${encodeURIComponent(m.name)}${m.chroma ? "&mm2-properties=chroma" : ""}`,
  };
}

// ---------- Server ----------

async function loadFromSupabase() {
  try {
    const { latest, history, eldorado } = await readMm2State();
    if (eldorado?.prices) mm2Eldorado = eldorado;
    if (latest?.items?.length) {
      mm2Items = latest.items;
      mm2UpdatedAt = Date.parse(latest.updatedAt) || 0;
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
  tick();
  setInterval(tick, every).unref();
}

function eldoradoFields(it) {
  const p = mm2Eldorado.prices[it.key];
  if (!p) return {};
  return { usd: p.usd, listings: p.listings, eldoradoUrl: p.url, valuePerUsd: Math.round(it.value / p.usd * 10) / 10 };
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
      sourceName: "supremevalues.com", sourceUrl: "https://supremevalues.com/mm2", shopUrl: "https://www.eldorado.gg/mm2-shop/i/204-2-0" });
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
      source: "supremevalues.com", count: items.length, categories: MM2_CATEGORIES, items,
      ...(mm2Items.length ? {} : { error: mm2LastError || "MM2 values are still loading." }),
    });
    return true;
  }
  if (url.pathname === "/api/mm2/history") {
    const key = url.searchParams.get("key") || "";
    const ratio = mm2Items.find((it) => it.key === key)?.valueText;
    sendJson(res, 200, { key, points: ratio ? [] : numericHistory(key) });
    return true;
  }
  return false;
}
