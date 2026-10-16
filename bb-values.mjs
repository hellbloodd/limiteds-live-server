// Blade Ball values tracker — same idea as mm2-values.mjs, with values from bbvalues.uk.
//
// bbvalues.uk sits behind Cloudflare too, so values are fetched from a home PC by mm2-push.mjs
// and stored in Supabase (mm2_state rows prefixed "bb_"); the live server only reads them.
import {
  curlGet, supabaseConfig, createStateReader, registerSupabaseTick, priceChangesFrom, pickPrices, offerTuple, listingWindow, salesStats, mergeMm2History, periodChanges, sparkline, eldoradoJson, sendGamePage,
} from "./mm2-values.mjs";

const BB_ORIGIN = "https://bbvalues.uk";
const BB_API_HEADERS = ["x-bbv-handshake: v1-secure-request", "Accept: application/json", `Referer: ${BB_ORIGIN}/values/`];
const BB_IMAGES = "https://images.bbvalues.uk/item%20images";
export const BB_PREFIX = "bb_";
export const BB_CATEGORIES = ["swords", "explosions", "emotes"];
const BB_SUPABASE_POLL_MS = 5 * 60 * 1000;

let bbItems = [];
let bbUpdatedAt = 0;
let bbHistory = {};
let bbLastError = "";
let bbEldorado = { updatedAt: null, prices: {} };
let bbPriceHistory = {};
let bbSales = {};

// ---------- bbvalues.uk ----------

// bbvalues.uk runs on a Cloudflare Worker that often fails with an instant 503 "error code: 1102"
// (worker over its resource limit) - from every other request to most of them at busy times.
// We only need one success per update, so keep trying for up to ~2 minutes.
async function bbJson(path) {
  let text;
  for (let attempt = 1; ; attempt++) {
    try { text = await curlGet(BB_ORIGIN + path, BB_API_HEADERS); break; } catch (e) {
      if (attempt >= 40) throw new Error(`bbvalues.uk unavailable (${e.message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const json = JSON.parse(text);
  if (json && !Array.isArray(json) && json.e) throw new Error(`bbvalues.uk: ${json.e}`);
  return json;
}

// All valued items, named so every entry is unambiguous:
// - swords sold with and without their finisher (bbvalues.uk flag f) are listed as
//   "Fire Dragon (Finisher)" and "Fire Dragon (No Finisher)";
// - an emote or explosion sharing its name with an item in another category gets the category,
//   e.g. "Blue Bunny Scythe (Emote)" next to the sword "Blue Bunny Scythe".
// Exact repeats (same name, category and version) keep the highest-valued one.
export async function scrapeBbValues() {
  const raw = await bbJson("/api/items");
  const categoriesByName = new Map();
  for (const r of raw) categoriesByName.set(r.n, new Set([...(categoriesByName.get(r.n) || []), r.c]));
  const byName = new Map();
  for (const r of raw) {
    if (!(r.p > 0)) continue;
    const category = `${String(r.c).toLowerCase()}s`;
    const variant = r.s === "Finisher" ? "Finisher"
      : r.s === "SwordAccessory" ? "Accessory"
      : r.f && r.c === "Sword" ? "No Finisher"
      : "";
    const labels = [variant, r.c !== "Sword" && categoriesByName.get(r.n).size > 1 ? r.c : ""].filter(Boolean);
    const item = {
      key: r.id,
      name: labels.length ? `${r.n} (${labels.join(", ")})` : r.n,
      baseName: r.n,
      variant,
      category,
      value: r.p,
      stability: r.st ? r.st[0].toUpperCase() + r.st.slice(1) : "",
      rarity: r.r === "LimitedU" ? "Limited (Unique)" : r.r,
      origin: r.tg || "",
      change24h: Number(r.ch) || 0, // bbvalues.uk's own 24h change, used until we have history
      demand: null,
      image: `${BB_IMAGES}/${encodeURIComponent(`${r.id}.webp`)}`,
      sourceUrl: `${BB_ORIGIN}/values/`,
    };
    const dedupeKey = `${category}:${item.name.toLowerCase()}`;
    const kept = byName.get(dedupeKey);
    if (!kept || item.value > kept.value) byName.set(dedupeKey, item);
  }
  const items = [...byName.values()];
  if (!items.length) throw new Error("No Blade Ball values returned");
  return { items, errors: [] };
}

// ---------- Eldorado prices ----------
// Blade Ball listings on Eldorado have no item tree, just free-text titles. We page through every
// listing (cheapest first) and match a title to an item only when its leading name is exactly
// the item's name: "Dragon Slayer ♨️Limited♨️" counts, "Dual Dragon Slayer" or bundles don't.

const BB_SHOP = "https://www.eldorado.gg/blade-ball-swords/i/203-2-0";
const ELDORADO_PAGE_SIZE = 50;
const ELDORADO_MAX_PAGES = 150;
const ELDORADO_WORKERS = 2;

const normName = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

function titleName(title) {
  const lead = String(title)
    .replace(/^[^\p{L}\p{N}]+/u, "") // leading emoji / symbols
    .split(/\s[-–—|:]\s|[|【\[(♨⚡✅🔥⭐🌟🔴🟢]|\s{2,}/u)[0];
  return normName(lead
    // "+ Finisher", "w/ Finisher", "No Finisher", "without finisher" ... and anything after it
    .replace(/\s*(\+|&|w\/o?|with(out)?|no|non)?[\s-]*finisher\b.*$/i, "")
    .replace(/\b(sword|limited|unique|secret|bb|blade ball)\b\s*$/gi, ""));
}

export async function fetchBbEldoradoPrices(items, onProgress = () => {}) {
  const byName = new Map(); // base name -> items (all versions)
  for (const it of items) {
    const n = normName(it.baseName || it.name);
    byName.set(n, [...(byName.get(n) || []), it]);
  }
  const found = {}; // key -> [offer tuple, ...]
  const fetchPage = (page) => eldoradoJson(`/api/v1/item-management/offers?gameId=203&category=CustomItem&pageIndex=${page}`
    + `&pageSize=${ELDORADO_PAGE_SIZE}&useMinPurchasePrice=false&useOfferAttributeSearch=false&usePopularItems=false`
    + "&offerSortingCriterion=Price&isAscending=true");
  const first = await fetchPage(1);
  const totalPages = Math.min(first.totalPages || 1, ELDORADO_MAX_PAGES);
  const pages = [first];
  const queue = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  await Promise.all(Array.from({ length: ELDORADO_WORKERS }, async () => {
    for (let page; (page = queue.shift());) pages.push(await fetchPage(page));
  }));
  onProgress(totalPages, totalPages);
  for (const j of pages) {
    for (const r of j.results || []) {
      const usd = r.offer?.pricePerUnitInUSD?.amount;
      const title = r.offer?.offerTitle || "";
      if (!(usd > 0)) continue;
      // Sellers write "Blue Bunny Scythe Emote" or "Blue Bunny Scythe | Emote" for the emote, so
      // "emote"/"explosion" anywhere in the title decides the category; otherwise it's the sword.
      const kind = /\bemotes?\b/i.test(title) ? "emotes" : /\bexplosions?\b/i.test(title) ? "explosions" : "swords";
      const lead = titleName(title);
      // Some names contain the word themselves ("Chroma Blade Explosion"), so try the full lead first.
      let cands = (byName.get(lead) || []).filter((m) => m.category === kind);
      if (!cands.length && kind !== "swords") {
        // "Aurora Burst Emote" -> "Aurora Burst"; "Chroma Blade - Explosion" -> "Chroma Blade Explosion"
        const base = normName(lead.replace(/\b(emote|explosion)s?\b/g, ""));
        const word = kind === "emotes" ? "emote" : "explosion";
        cands = [...(byName.get(base) || []), ...(byName.get(`${base} ${word}`) || [])].filter((m) => m.category === kind);
      }
      if (kind === "swords" && cands.length > 1) {
        // "finisher" -> the Finisher version; "no finisher" / "without finisher" / nothing -> the plain one.
        const finisher = /finisher/i.test(title) && !/\b(no|without|w\/o|non)[\s-]*finisher/i.test(title);
        cands = cands.filter((m) => (finisher ? m.variant === "Finisher" : m.variant !== "Finisher"));
      }
      if (cands.length === 1) (found[cands[0].key] ||= []).push(offerTuple(r));
    }
  }
  const prices = {};
  for (const [key, offers] of Object.entries(found)) {
    const list = offers.map((o) => o[1]).sort((a, b) => a - b);
    // Skip listings far below the rest (mislabelled items), same rule as MM2.
        const item = items.find((i) => i.key === key);
    prices[key] = {
      ...pickPrices(list), // cheapest real listing + the next one up
      listings: list.length,
      ...listingWindow(offers.slice(0, 40), false), // every listing is scanned, so nothing hides off-window
      url: `${BB_SHOP}?searchQuery=${encodeURIComponent(item.name)}`,
    };
  }
  return prices;
}

// ---------- Server ----------

// Items are stored as small arrays (5000 objects with repeated field names make a row too big to
// write when Supabase is busy); picture and link are rebuilt from the key.
export function compactBbItem(it) {
  return [it.key, it.name, it.category, it.value, it.stability, it.rarity, it.origin, it.change24h];
}
const expandBbItem = (it) => {
  if (!Array.isArray(it)) return { ...it, image: bbImage(it.key), sourceUrl: `${BB_ORIGIN}/values/` };
  const [key, name, category, value, stability, rarity, origin, change24h] = it;
  return { key, name, category, value, stability, rarity, origin, change24h, demand: null, image: bbImage(key), sourceUrl: `${BB_ORIGIN}/values/` };
};
const bbImage = (key) => `${BB_IMAGES}/${encodeURIComponent(`${key}.webp`)}`;

let readBbRows;
async function loadFromSupabase() {
  try {
    readBbRows ||= createStateReader(BB_PREFIX);
    const { latest, history, eldorado, heartbeat, priceHistory, sales } = await readBbRows();
    bbPriceHistory = priceHistory;
    bbSales = sales;
    if (eldorado?.prices) bbEldorado = eldorado;
    if (latest?.items?.length) {
      bbItems = latest.items.map(expandBbItem);
      bbUpdatedAt = Date.parse(heartbeat?.updatedAt || latest.updatedAt) || 0;
    }
    bbHistory = history;
    bbLastError = latest ? "" : "No Blade Ball values in Supabase yet — run mm2-push.mjs on a home PC.";
  } catch (e) {
    bbLastError = e.message;
    console.warn(`Blade Ball Supabase read failed: ${e.message}`);
  }
}

async function scrapeLocally() {
  try {
    const { items } = await scrapeBbValues();
    bbUpdatedAt = Date.now();
    mergeMm2History(bbHistory, items, bbUpdatedAt);
    bbItems = items;
    bbLastError = "";
    console.log(`Blade Ball values scraped: ${items.length} items.`);
  } catch (e) {
    bbLastError = e.message;
    console.warn(`Blade Ball scrape failed: ${e.message}`);
  }
}

export function startBbTracker() {
  const [tick, every] = supabaseConfig() ? [loadFromSupabase, BB_SUPABASE_POLL_MS] : [scrapeLocally, 15 * 60 * 1000];
  registerSupabaseTick(tick);
  tick();
  setInterval(tick, every).unref();
}

function eldoradoFields(it) {
  const p = bbEldorado.prices[it.key];
  if (!p?.usd) return {};
  return { usd: p.usd, second: p.second ?? null, listings: p.listings, eldoradoUrl: p.url, valuePerUsd: Math.round(it.value / p.usd * 10) / 10, priceChanges: priceChangesFrom(bbPriceHistory[it.key], p.usd), ...salesStats(bbSales[it.key]) };
}

// Returns true if the request was handled.
export async function handleBbRequest(url, res, sendJson) {
  if (url.pathname === "/bladeball" || url.pathname === "/bladeball/") {
    await sendGamePage(res, { api: "/api/bladeball", title: "Blade Ball Values", tab: "bladeball", noun: "Blade Ball items",
      sourceName: "bbvalues.uk", sourceUrl: `${BB_ORIGIN}/values/`, shopUrl: BB_SHOP });
    return true;
  }
  if (url.pathname === "/api/bladeball") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const category = url.searchParams.get("category") || "";
    const items = bbItems
      .filter((it) => (!q || it.name.toLowerCase().includes(q)) && (!category || it.category === category))
      .map((it) => {
        const h = bbHistory[it.key];
        const changes = periodChanges(h, it.value);
        if (it.change24h && !changes["24h"]?.abs) {
          const base = it.value - it.change24h;
          changes["24h"] = { abs: it.change24h, pct: base ? Math.round(it.change24h / base * 1000) / 10 : 0 };
        }
        return { ...it, spark: sparkline(h), changes, ...eldoradoFields(it) };
      });
    sendJson(res, 200, {
      updatedAt: bbUpdatedAt ? new Date(bbUpdatedAt).toISOString() : null,
      pricesUpdatedAt: bbEldorado.updatedAt,
      source: "bbvalues.uk", count: items.length, categories: BB_CATEGORIES, items,
      ...(bbItems.length ? {} : { error: bbLastError || "Blade Ball values are still loading." }),
    });
    return true;
  }
  if (url.pathname === "/api/bladeball/history") {
    const key = url.searchParams.get("key") || "";
    sendJson(res, 200, { key, points: bbHistory[key] || [], pricePoints: bbPriceHistory[key] || [] });
    return true;
  }
  return false;
}

