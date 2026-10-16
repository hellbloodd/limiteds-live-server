// Steal a Brainrot values tracker (Secret and OG brainrots only), values from sabrvalues.com.
//
// sabrvalues.com disallows /api/ in robots.txt and its category pages load their lists from it, so we
// read the item pages instead: the sitemap lists every brainrot page, and each page embeds a
// schema.org Product block with the name, picture, rarity, demand and value (in Dragons -
// Dragon Cannelloni = 1). Rarities are re-checked once a day; Secret/OG values every update.
import {
  curlGet, supabaseConfig, createStateReader, registerSupabaseTick, priceChangesFrom, pickPrices, offerTuple, listingWindow, salesStats, mergeMm2History, periodChanges, sparkline,
  eldoradoJson, sendGamePage,
} from "./mm2-values.mjs";

const SB_ORIGIN = "https://sabrvalues.com";
export const SB_PREFIX = "sb_";
export const SB_CATEGORIES = ["secret", "og"];
const SB_LABEL = { secret: "Secret", og: "OG" };
const SB_SUPABASE_POLL_MS = 5 * 60 * 1000;
const RARITY_RECHECK_MS = 24 * 60 * 60 * 1000;
const PAGE_WORKERS = 6;

let sbItems = [];
let sbUpdatedAt = 0;
let sbHistory = {};
let sbLastError = "";
let sbEldorado = { updatedAt: null, prices: {} };
let sbPriceHistory = {};
let sbSales = {};

// ---------- sabrvalues.com ----------

function productLd(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { const j = JSON.parse(m[1]); if (j["@type"] === "Product") return j; } catch { /* other blocks */ }
  }
  // Next.js may stream it inside its RSC payload instead.
  const payload = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((x) => JSON.parse(`"${x[1]}"`)).join("");
  for (const m of payload.matchAll(/"__html":"((?:[^"\\]|\\.)*)"/g)) {
    try { const j = JSON.parse(JSON.parse(`"${m[1]}"`)); if (j["@type"] === "Product") return j; } catch { /* other blocks */ }
  }
  return null;
}

const titleCase = (s) => String(s || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function fetchBrainrot(slug) {
  const ld = productLd(await curlGet(`${SB_ORIGIN}/values/brainrots/${slug}`));
  if (!ld) return null;
  const prop = (n) => ld.additionalProperty?.find((p) => p.name === n)?.value;
  const rarity = String(prop("Rarity") || ld.category || "").toLowerCase();
  const value = Number(ld.offers?.price);
  return {
    key: slug, name: ld.name, category: rarity, value: value > 0 ? value : null,
    image: ld.image || "", demand: prop("Demand") || "",
  };
}

// scanned: { slug: [checkedAtMs, rarity] } - kept between runs so most pages are only read when needed.
export async function scrapeSabValues(scanned = {}) {
  const sitemap = await curlGet(`${SB_ORIGIN}/sitemap.xml`);
  const slugs = [...new Set([...sitemap.matchAll(/\/values\/brainrots\/([a-z0-9-]+)</g)].map((m) => m[1]))];
  if (!slugs.length) throw new Error("sabrvalues.com: no brainrot pages in the sitemap");
  const now = Date.now();
  const queue = slugs.filter((s) => !scanned[s] || now - scanned[s][0] > RARITY_RECHECK_MS || SB_CATEGORIES.includes(scanned[s][1]));
  const found = [];
  await Promise.all(Array.from({ length: PAGE_WORKERS }, async () => {
    for (let slug; (slug = queue.shift());) {
      try {
        const it = await fetchBrainrot(slug);
        if (!it) continue;
        scanned[slug] = [now, it.category];
        if (SB_CATEGORIES.includes(it.category) && it.value) found.push(it);
      } catch { /* page failed this time; retried next run */ }
    }
  }));
  if (!found.length) throw new Error("sabrvalues.com: no Secret/OG values found");
  const items = found.map((it) => ({
    ...it,
    rarity: SB_LABEL[it.category],
    stability: "",
    origin: "",
    extra: [["Demand", titleCase(it.demand) || "—"]],
    demand: null,
    sourceUrl: `${SB_ORIGIN}/values/brainrots/${it.key}`,
  })).sort((a, b) => b.value - a.value);
  return { items, scanned };
}

// ---------- Eldorado prices ----------
// Eldorado names brainrots exactly (Brainrot > Secret > Los Matteos) and has a Mutations filter;
// we price the plain version (mutation "none").

const SB_SHOP = "https://www.eldorado.gg/steal-a-brainrot-brainrots/i/259-2-0";
const ELDORADO_WORKERS = 8; // the shared limit in mm2-values.mjs caps total requests to Eldorado
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function fetchSabEldoradoPrices(items) {
  const tree = await eldoradoJson("/api/library/259/CustomItem?locale=en-US");
  const leaves = [];
  const walk = (n, p) => {
    const q = p.concat(n.value);
    if (n.childTradeEnvironments?.length) n.childTradeEnvironments.forEach((k) => walk(k, q));
    else if (q.length === 3) leaves.push(q);
  };
  tree.tradeEnvironments.forEach((n) => walk(n, []));
  const queue = items.map((it) => {
    const cands = leaves.filter((l) => l[1] === SB_LABEL[it.category] && norm(l[2]) === norm(it.name));
    return [it, cands.length === 1 ? cands[0] : null];
  }).filter(([, l]) => l);
  const prices = {};
  await Promise.all(Array.from({ length: ELDORADO_WORKERS }, async () => {
    for (let job; (job = queue.shift());) {
      const [it, [type, rarity, name]] = job;
      const filter = `tradeEnvironmentValue0=${encodeURIComponent(type)}&tradeEnvironmentValue1=${encodeURIComponent(rarity)}`
        + `&tradeEnvironmentValue2=${encodeURIComponent(name)}&steal-a-brainrot-mutations=none`;
      try {
        const j = await eldoradoJson("/api/v1/item-management/offers?gameId=259&category=CustomItem&pageIndex=1&pageSize=5"
          + "&useMinPurchasePrice=false&useOfferAttributeSearch=false&usePopularItems=false&offerSortingCriterion=Price&isAscending=true&" + filter);
        const offers = (j.results || []).map(offerTuple).filter((o) => o[1] > 0);
        const list = offers.map((o) => o[1]).sort((a, b) => a - b);
        if (!list.length) { prices[it.key] = { offers: [], windowMax: Infinity }; continue; } // nothing listed now
                prices[it.key] = {
          ...pickPrices(list), // cheapest real listing + the next one up
          ...listingWindow(offers, (j.recordCount || 0) > offers.length),
          listings: j.recordCount || list.length,
          url: `${SB_SHOP}?te_v0=${encodeURIComponent(type)}&te_v1=${encodeURIComponent(rarity)}&te_v2=${encodeURIComponent(name)}&steal-a-brainrot-mutations=none`,
        };
      } catch { /* no price this time */ }
    }
  }));
  return prices;
}

// ---------- Server ----------

export function compactSabItem(it) {
  return [it.key, it.name, it.category, it.value, it.image, it.extra];
}
const expandSabItem = ([key, name, category, value, image, extra]) => ({
  key, name, category, value, image, extra, rarity: SB_LABEL[category], stability: "", origin: "", demand: null,
  sourceUrl: `${SB_ORIGIN}/values/brainrots/${key}`,
});

let readSbRows;
async function loadFromSupabase() {
  try {
    readSbRows ||= createStateReader(SB_PREFIX);
    const { latest, history, eldorado, heartbeat, priceHistory, sales } = await readSbRows();
    sbPriceHistory = priceHistory;
    sbSales = sales;
    if (eldorado?.prices) sbEldorado = eldorado;
    if (latest?.items?.length) {
      sbItems = latest.items.map(expandSabItem);
      sbUpdatedAt = Date.parse(heartbeat?.updatedAt) || 0;
    }
    sbHistory = history;
    sbLastError = latest ? "" : "Steal a Brainrot values are still loading.";
  } catch (e) {
    sbLastError = e.message;
    console.warn(`Steal a Brainrot Supabase read failed: ${e.message}`);
  }
}

async function scrapeLocally() {
  try {
    const { items } = await scrapeSabValues();
    sbUpdatedAt = Date.now();
    mergeMm2History(sbHistory, items, sbUpdatedAt);
    sbItems = items;
    sbLastError = "";
  } catch (e) {
    sbLastError = e.message;
    console.warn(`Steal a Brainrot scrape failed: ${e.message}`);
  }
}

export function startSabTracker() {
  const [tick, every] = supabaseConfig() ? [loadFromSupabase, SB_SUPABASE_POLL_MS] : [scrapeLocally, 15 * 60 * 1000];
  registerSupabaseTick(tick);
  tick();
  setInterval(tick, every).unref();
}

function eldoradoFields(it) {
  const p = sbEldorado.prices[it.key];
  if (!p?.usd) return {};
  // Values are in Dragons, often far below 1, so keep 3 significant digits.
  return { usd: p.usd, second: p.second ?? null, ladder: p.ladder || null, listings: p.listings, eldoradoUrl: p.url, priceVariant: "no mutation", valuePerUsd: Number((it.value / p.usd).toPrecision(3)), priceChanges: priceChangesFrom(sbPriceHistory[it.key], p.usd), ...salesStats(sbSales[it.key]) };
}

// Returns true if the request was handled.
export async function handleSabRequest(url, res, sendJson) {
  if (url.pathname === "/stealabrainrot" || url.pathname === "/stealabrainrot/") {
    await sendGamePage(res, { api: "/api/stealabrainrot", title: "Steal a Brainrot Values", tab: "stealabrainrot", noun: "Secret & OG brainrots",
      sourceName: "sabrvalues.com", sourceUrl: `${SB_ORIGIN}/values/categories/secret`, shopUrl: SB_SHOP, unit: "🐉", unitName: "Dragons" });
    return true;
  }
  if (url.pathname === "/api/stealabrainrot") {
    const items = sbItems.map((it) => {
      const h = sbHistory[it.key];
      return { ...it, spark: sparkline(h), changes: periodChanges(h, it.value), ...eldoradoFields(it) };
    });
    sendJson(res, 200, {
      updatedAt: sbUpdatedAt ? new Date(sbUpdatedAt).toISOString() : null,
      pricesUpdatedAt: sbEldorado.updatedAt,
      source: "sabrvalues.com", count: items.length, categories: SB_CATEGORIES, items,
      ...(sbItems.length ? {} : { error: sbLastError || "Steal a Brainrot values are still loading." }),
    });
    return true;
  }
  if (url.pathname === "/api/stealabrainrot/history") {
    const key = url.searchParams.get("key") || "";
    sendJson(res, 200, { key, points: sbHistory[key] || [], pricePoints: sbPriceHistory[key] || [] });
    return true;
  }
  return false;
}
