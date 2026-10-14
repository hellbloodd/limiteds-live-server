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
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HERE = dirname(fileURLToPath(import.meta.url));

let mm2Items = [];
let mm2UpdatedAt = 0;
let mm2History = {}; // { itemKey: [[timestamp, value], ...] }
let mm2LastError = "";

// ---------- Supabase ----------

function supabaseConfig() {
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

export async function readMm2State() {
  const rows = await supabaseFetch("mm2_state?select=id,data");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.data]));
  return { latest: byId.latest || null, history: byId.history || {}, historyFetched: byId.history_fetched || {} };
}

// historyFetched: { itemKey: ms } — when each item's history was last pulled from Supreme Values.
export async function writeMm2State(latest, history, historyFetched = {}) {
  const now = new Date().toISOString();
  await supabaseFetch("mm2_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      { id: "latest", data: latest, updated_at: now },
      { id: "history", data: history, updated_at: now },
      { id: "history_fetched", data: historyFetched, updated_at: now },
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
  for (const chunk of html.split('<div class="itemcell"').slice(1)) {
    const id = pick(chunk, /^\s*id="([^"]*)"/);
    const name = pick(chunk, /class="itemhead">([\s\S]*?)<\/div>/);
    if (!name) continue;
    const image = pick(chunk, /<img class="itemimage" src="([^"]+)"/);
    items.push({
      key: `${category}:${id || name}`,
      name,
      category,
      value: parseNumber(pick(chunk, /class="itemvalue[^"]*">([^<]*)</)),
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
function curlGet(url) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sSL", "--fail", "--max-time", "30", "-A", UA,
      "-H", "Accept: text/html,application/xhtml+xml", "-H", "Accept-Language: en-US,en;q=0.9", url],
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
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .slice(-MM2_HISTORY_MAX_POINTS);
}

// Appends changed values to history in place. Returns true if anything changed.
export function mergeMm2History(history, items, now) {
  let changed = false;
  for (const item of items) {
    if (item.value == null) continue;
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

// ---------- Server ----------

async function loadFromSupabase() {
  try {
    const { latest, history } = await readMm2State();
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

// Last ~90 days of values, sampled to at most 30 points, for the mini chart on each card.
function sparkline(points) {
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

// Returns true if the request was handled.
export async function handleMm2Request(url, res, sendJson) {
  if (url.pathname === "/mm2" || url.pathname === "/mm2/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(join(HERE, "mm2.html"), "utf8"));
    return true;
  }
  if (url.pathname === "/api/mm2") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const category = url.searchParams.get("category") || "";
    const items = mm2Items
      .filter((it) => (!q || it.name.toLowerCase().includes(q)) && (!category || it.category === category))
      .map((it) => ({ ...it, spark: sparkline(mm2History[it.key]) }));
    sendJson(res, 200, {
      updatedAt: mm2UpdatedAt ? new Date(mm2UpdatedAt).toISOString() : null,
      source: "supremevalues.com", count: items.length, categories: MM2_CATEGORIES, items,
      ...(mm2Items.length ? {} : { error: mm2LastError || "MM2 values are still loading." }),
    });
    return true;
  }
  if (url.pathname === "/api/mm2/history") {
    const key = url.searchParams.get("key") || "";
    sendJson(res, 200, { key, points: mm2History[key] || [] });
    return true;
  }
  return false;
}
