// Adopt Me values tracker — same idea as mm2-values.mjs, with values from adoptmevalues.app.
//
// adoptmevalues.app disallows /api/ in robots.txt, so we read the public values page instead: it is
// server-rendered and embeds every item in a "packed" list (decoded the same way the site's own
// unpackPets() does). It sits behind Cloudflare, so like the others it's fetched from a home PC by
// mm2-push.mjs and stored in Supabase (mm2_state rows prefixed "am_").
import {
  curlGet, supabaseConfig, createStateReader, registerSupabaseTick, priceChangesFrom, pickPrices, offerTuple, listingWindow, salesStats, mergeMm2History, periodChanges, sparkline, eldoradoJson, sendGamePage,
  pageSize,
} from "./mm2-values.mjs";

const AM_ORIGIN = "https://www.adoptmevalues.app";
const AM_VALUES_PAGE = `${AM_ORIGIN}/values`;
export const AM_PREFIX = "am_";
const AM_SUPABASE_POLL_MS = 5 * 60 * 1000;

let amItems = [];
let amUpdatedAt = 0;
let amHistory = {};
let amLastError = "";
let amEldorado = { updatedAt: null, prices: {} };
let amPriceHistory = {};
let amSales = {};
let amCategories = [];

// ---------- adoptmevalues.app ----------

// Pages stream their data as Next.js "self.__next_f.push([1, "..."])" chunks.
function nextPayload(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
}

// The JSON object starting at `marker` inside the payload.
function extractObject(payload, marker) {
  const start = payload.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { if (--depth === 0) return JSON.parse(payload.slice(start, i + 1)); }
  }
  return null;
}

function extractPacked(html) {
  const packed = extractObject(nextPayload(html), '{"imageBase"');
  if (!packed) throw new Error("adoptmevalues.app: item list not found on the values page");
  return packed;
}

// URL slug the site uses for item pages, e.g. "Frost Dragon" -> /values/frost-dragon
const amSlug = (name) => name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Value history from the item's own page: series D (default / no potion), FR (fly ride), N (neon) and
// M (mega neon) as dated points. We use whichever series matches the value we display, as change points.
export async function fetchAmHistory(item) {
  const html = await curlGet(`${AM_ORIGIN}/values/${amSlug(item.name)}`);
  const h = extractObject(nextPayload(html), '{"history":')?.history;
  const series = Object.values(h?.series || {}).filter((s) => Array.isArray(s) && s.length);
  if (!series.length) return [];
  const last = (s) => s[s.length - 1].value;
  const best = series.reduce((a, b) => (Math.abs(last(b) - item.value) < Math.abs(last(a) - item.value) ? b : a));
  const points = [];
  for (const p of best) {
    const t = Date.parse(`${p.date}T00:00:00Z`);
    if (!Number.isFinite(t) || !(p.value > 0)) continue;
    if (points.length && points[points.length - 1][1] === p.value) continue;
    points.push([t, p.value]);
  }
  return points;
}

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
const fmtV = (n) => (n ? round(n).toLocaleString("en-US") : "—");

export async function scrapeAmValues() {
  const packed = extractPacked(await curlGet(AM_VALUES_PAGE));
  const items = [];
  const seen = new Map();
  for (const e of packed.items) {
    // Field order from the site's unpackPets(): id, name, image, rarity, type, category, score,
    // then [default, fly, ride, fly ride, no potion] for normal, neon and mega neon.
    const [id, name, image, rarityIdx, typeIdx] = e;
    const [r, rF, rR, rFR, rNP, n, nF, nR, nFR, nNP, m, mF, mR, mFR, mNP] = e.slice(7, 22);
    const value = round(r || rFR);
    if (!(value > 0)) continue;
    const type = packed.types[typeIdx] || "other";
    const item = {
      key: String(id),
      name,
      category: type,
      value,
      rarity: (packed.rarities[rarityIdx] || "").replace(/\b\w/g, (c) => c.toUpperCase()),
      stability: "",
      origin: "",
      demand: null,
      image: image && !image.startsWith("http") ? `${packed.imageBase}/${encodeURI(image)}` : image,
      // Shown in the detail view.
      extra: type === "pets" ? [
        ["Fly Ride", fmtV(rFR)], ["No Potion", fmtV(rNP)],
        ["Neon", fmtV(n)], ["Neon Fly Ride", fmtV(nFR)],
        ["Mega Neon", fmtV(m)], ["Mega Fly Ride", fmtV(mFR)],
      ] : [],
      flyRide: round(rFR) || null,
      // value of each potion/neon version, keyed by Eldorado's trait code (for per-variant flips)
      vals: type === "pets" ? Object.fromEntries(Object.entries({
        none: rNP || r, f: rF, r: rR, fr: rFR, n: nNP || n, nf: nF, nr: nR, nfr: nFR, m: mNP || m, mf: mF, mr: mR, mfr: mFR,
      }).filter(([, v]) => v > 0).map(([k, v]) => [k, round(v)])) : null,
    };
    // A few non-pet items appear twice under the same name: keep the higher value.
    const dupe = `${type}:${name.toLowerCase()}`;
    const prev = seen.get(dupe);
    if (prev && prev.value >= value) continue;
    if (prev) items.splice(items.indexOf(prev), 1);
    seen.set(dupe, item);
    items.push(item);
  }
  if (!items.length) throw new Error("No Adopt Me values found");
  return { items, categories: packed.types.filter((t) => items.some((i) => i.category === t)) };
}

// ---------- Eldorado prices ----------
// Eldorado names Adopt Me pets and eggs exactly (Pets > Legendary > Frost Dragon) and has a Traits
// filter (none, f, r, fr, n, nfr, m, mfr, ...). Pets are priced as Fly Ride - by far the most listed
// version - and compared with the Fly Ride value; eggs have no traits.

const AM_SHOP = "https://www.eldorado.gg/adopt-me-pets/i/201-2-0";
const ELDORADO_WORKERS = 8; // the shared limit in mm2-values.mjs caps total requests to Eldorado
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const RARITY = { "ultra rare": "Ultra-Rare", legendary: "Legendary", rare: "Rare", common: "Common", uncommon: "Uncommon" };

async function fetchEldoradoLeaves() {
  const tree = await eldoradoJson("/api/library/201/CustomItem?locale=en-US");
  const leaves = [];
  const walk = (n, path) => {
    const p = path.concat(n.value);
    if (n.childTradeEnvironments?.length) n.childTradeEnvironments.forEach((k) => walk(k, p));
    else if (p.length === 3 && (p[0] === "Pets" || p[0] === "Eggs")) leaves.push(p);
  };
  tree.tradeEnvironments.forEach((n) => walk(n, []));
  return leaves;
}

function matchLeaf(item, leaves) {
  const group = item.category === "pets" ? "Pets" : item.category === "eggs" ? "Eggs" : null;
  if (!group) return null;
  let cands = leaves.filter((l) => l[0] === group && norm(l[2]) === norm(item.name));
  if (cands.length > 1) {
    const r = RARITY[item.rarity.toLowerCase()];
    const byRarity = cands.filter((l) => l[1] === r);
    if (byRarity.length) cands = byRarity;
  }
  return cands.length === 1 ? cands[0] : null;
}

// Eldorado's trait codes for pets, with readable labels. One unfiltered request returns the 50
// cheapest listings of every version; versions missing from it (popular pets have hundreds of
// listings) get their own filtered request.
export const AM_TRAITS = { none: "No Potion", f: "Fly", r: "Ride", fr: "Fly Ride", n: "Neon", nf: "Neon Fly", nr: "Neon Ride", nfr: "Neon Fly Ride", m: "Mega Neon", mf: "Mega Fly", mr: "Mega Ride", mfr: "Mega Fly Ride" };
// Versions worth an extra request when they're missing from the 50 cheapest listings: the neon and
// mega ones (they're priced far above the rest, so they rarely make the cheapest 50). The others
// only come from the unfiltered list.
const FILTERABLE = ["n", "nfr", "m", "mfr"];
const traitOf = (r) => (r.offer?.attributes || []).find((a) => a.id === "adopt-me-traits")?.value?.id || "";
const OFFERS = "/api/v1/item-management/offers?gameId=201&category=CustomItem&pageIndex=1"
  + "&useMinPurchasePrice=false&useOfferAttributeSearch=false&usePopularItems=false&offerSortingCriterion=Price&isAscending=true&";

function priceOf(offers, listings, url) {
  const list = offers.map((o) => o[1]).sort((a, b) => a - b);
  const bySeller = [...offers].sort((a, b) => a[1] - b[1]);
  return { ...pickPrices(list), listings, url, ladder: list.slice(0, 5).map((v) => Math.round(v * 100) / 100), sellers: bySeller.slice(0, 2).map((o) => o[4] || null), stock: bySeller[0]?.[2] ?? null };
}

// frOnly: just the Fly Ride listings, one request per pet (the sniper's fast path).
export async function fetchAmEldoradoPrices(items, { frOnly = false } = {}) {
  const leaves = await fetchEldoradoLeaves();
  const queue = items.map((it) => [it, matchLeaf(it, leaves)]).filter(([, l]) => l);
  const prices = {};
  await Promise.all(Array.from({ length: ELDORADO_WORKERS }, async () => {
    for (let job; (job = queue.shift());) {
      const [it, [type, rarity, name]] = job;
      const pet = type === "Pets";
      const filter = `tradeEnvironmentValue0=${encodeURIComponent(type)}&tradeEnvironmentValue1=${encodeURIComponent(rarity)}&tradeEnvironmentValue2=${encodeURIComponent(name)}`;
      const shopUrl = (code) => `${AM_SHOP}?te_v0=${encodeURIComponent(type)}&te_v1=${encodeURIComponent(rarity)}&te_v2=${encodeURIComponent(name)}${code ? `&adopt-me-traits=${code}` : ""}`;
      try {
        if (!pet) { // eggs: no traits
          const j = await eldoradoJson(OFFERS + `pageSize=${pageSize(5)}&` + filter);
          const offers = (j.results || []).map(offerTuple).filter((o) => o[1] > 0);
          if (!offers.length) { prices[it.key] = { offers: [], windowMax: Infinity }; continue; }
          prices[it.key] = { ...priceOf(offers, j.recordCount || offers.length, shopUrl("")), ...listingWindow(offers, (j.recordCount || 0) > offers.length), variant: "" };
          continue;
        }
        if (frOnly) {
          const j = await eldoradoJson(OFFERS + `pageSize=${pageSize(5)}&` + filter + "&adopt-me-traits=fr");
          const offers = (j.results || []).filter((r) => traitOf(r) === "fr").map(offerTuple).filter((o) => o[1] > 0);
          if (offers.length) prices[it.key] = { ...priceOf(offers, j.recordCount || offers.length, shopUrl("fr")), ...listingWindow(offers, (j.recordCount || 0) > offers.length), variant: "Fly Ride" };
          continue;
        }
        const j = await eldoradoJson(OFFERS + "pageSize=50&" + filter);
        const results = j.results || [];
        const full = (j.recordCount || 0) <= results.length;
        const groups = {}; // trait -> { offers, count }
        for (const r of results) {
          const o = offerTuple(r), t = traitOf(r);
          if (!(o[1] > 0) || !AM_TRAITS[t]) continue;
          (groups[t] ||= { offers: [], count: 0, full }).offers.push(o);
          groups[t].count++;
        }
        // versions that have a value but fewer than 2 listings in the window: ask for them directly
        // (skipped for cheap pets - Fly Ride under $5 - to keep the request count down)
        const frCheapest = Math.min(...(groups.fr?.offers || []).map((o) => o[1]));
        if (!full && !(frCheapest < 5)) for (const t of FILTERABLE) {
          if (!(it.vals?.[t] > 0) || (groups[t]?.offers.length || 0) >= 2) continue;
          try {
            const f = await eldoradoJson(OFFERS + "pageSize=10&" + filter + `&adopt-me-traits=${t}`);
            const offers = (f.results || []).filter((r) => traitOf(r) === t).map(offerTuple).filter((o) => o[1] > 0);
            if (offers.length) groups[t] = { offers, count: f.results.length < 10 ? offers.length : f.recordCount || offers.length, full: f.results.length < 10 };
          } catch { /* skip this version */ }
        }
        const variants = {};
        for (const [t, g] of Object.entries(groups)) { const { url, ...v } = priceOf(g.offers, g.count, ""); variants[t] = v; } // url rebuilt from baseUrl
        const fr = groups.fr;
        prices[it.key] = fr
          ? { ...priceOf(fr.offers, fr.count, shopUrl("fr")), ...listingWindow(fr.offers, !fr.full), variant: "Fly Ride", variants, baseUrl: shopUrl("") }
          : Object.keys(variants).length ? { offers: [], windowMax: Infinity, variants, baseUrl: shopUrl(""), usd: 0 } : { offers: [], windowMax: Infinity };
      } catch { /* no price this time */ }
    }
  }));
  return prices;
}

// ---------- Server ----------

// Stored compactly; the picture URL and detail rows are kept because they can't be rebuilt.
export function compactAmItem(it) {
  return [it.key, it.name, it.category, it.value, it.rarity, it.image, it.extra, it.flyRide, it.vals || null];
}
const expandAmItem = (a) => {
  const [key, name, category, value, rarity, image, extra, flyRide, vals] = a;
  return { key, name, category, value, rarity, image, extra, flyRide, vals: vals || null, stability: "", origin: "", demand: null, sourceUrl: AM_VALUES_PAGE };
};

let readAmRows;
async function loadFromSupabase() {
  try {
    readAmRows ||= createStateReader(AM_PREFIX);
    const { latest, history, eldorado, heartbeat, priceHistory, sales } = await readAmRows();
    amPriceHistory = priceHistory;
    amSales = sales;
    if (eldorado?.prices) amEldorado = eldorado;
    if (latest?.items?.length) {
      amItems = latest.items.map(expandAmItem);
      amCategories = latest.categories || [];
      amUpdatedAt = Date.parse(heartbeat?.updatedAt) || 0;
    }
    amHistory = history;
    amLastError = latest ? "" : "No Adopt Me values in Supabase yet — run mm2-push.mjs on a home PC.";
  } catch (e) {
    amLastError = e.message;
    console.warn(`Adopt Me Supabase read failed: ${e.message}`);
  }
}

async function scrapeLocally() {
  try {
    const { items, categories } = await scrapeAmValues();
    amUpdatedAt = Date.now();
    mergeMm2History(amHistory, items, amUpdatedAt);
    amItems = items;
    amCategories = categories;
    amLastError = "";
  } catch (e) {
    amLastError = e.message;
    console.warn(`Adopt Me scrape failed: ${e.message}`);
  }
}

export function startAmTracker() {
  const [tick, every] = supabaseConfig() ? [loadFromSupabase, AM_SUPABASE_POLL_MS] : [scrapeLocally, 15 * 60 * 1000];
  registerSupabaseTick(tick);
  tick();
  setInterval(tick, every).unref();
}

function eldoradoFields(it) {
  const p = amEldorado.prices[it.key];
  const variantRows = () => Object.entries(p.variants || {}).map(([code, v]) => ({ code, label: AM_TRAITS[code], value: it.vals?.[code] ?? null, ...v, url: `${p.baseUrl}&adopt-me-traits=${code}` }));
  if (!p?.usd) return p?.variants ? { variants: variantRows() } : {};
  // Pets are priced as Fly Ride, so compare with the Fly Ride value.
  const value = p.variant === "Fly Ride" && it.flyRide ? it.flyRide : it.value;
  const variants = p.variants ? variantRows() : null;
  return { variants, usd: p.usd, second: p.second ?? null, ladder: p.ladder || null, sellers: p.sellers || null, stock: p.stock ?? null, listings: p.listings, eldoradoUrl: p.url, priceVariant: p.variant, valuePerUsd: Math.round(value / p.usd * 10) / 10, priceChanges: priceChangesFrom(amPriceHistory[it.key], p.usd), ...salesStats(amSales[it.key]) };
}

// Returns true if the request was handled.
export async function handleAmRequest(url, res, sendJson) {
  if (url.pathname === "/adoptme" || url.pathname === "/adoptme/") {
    await sendGamePage(res, { api: "/api/adoptme", title: "Adopt Me Values", tab: "adoptme", noun: "Adopt Me items",
      sourceName: "adoptmevalues.app", sourceUrl: AM_VALUES_PAGE, shopUrl: AM_SHOP });
    return true;
  }
  if (url.pathname === "/api/adoptme") {
    const items = amItems.map((it) => {
      const h = amHistory[it.key];
      return { ...it, spark: sparkline(h), changes: periodChanges(h, it.value), ...eldoradoFields(it) };
    });
    sendJson(res, 200, {
      updatedAt: amUpdatedAt ? new Date(amUpdatedAt).toISOString() : null,
      pricesUpdatedAt: amEldorado.updatedAt,
      source: "adoptmevalues.app", count: items.length, categories: amCategories, items,
      ...(amItems.length ? {} : { error: amLastError || "Adopt Me values are still loading." }),
    });
    return true;
  }
  if (url.pathname === "/api/adoptme/history") {
    const key = url.searchParams.get("key") || "";
    sendJson(res, 200, { key, points: amHistory[key] || [], pricePoints: amPriceHistory[key] || [] });
    return true;
  }
  return false;
}
export const amMarketData = () => ({ priceHistory: amPriceHistory, sales: amSales });
