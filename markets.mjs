// Other marketplaces (G2G, U7BUY, ...): each one registers a price lookup here, and the Flip Finder
// asks every market for an item's cheapest offer there. Also shared helpers to match a free-text
// listing title ("Harvester Gun 2021 | REAL STOCK | MM2") to one of our items.

const markets = []; // { name, price(game, name, code) -> { usd, offers, url } | null }
export function registerMarket(name, price) { markets.push({ name, price }); }
export function otherMarketPrices(game, name, code = "") {
  const out = [];
  for (const m of markets) {
    const p = m.price(game, name, code);
    if (p?.usd > 0) out.push({ market: m.name, ...p });
  }
  return out;
}

export const words = (s) => ` ${String(s || "").toLowerCase().normalize("NFKD").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;

// Reads a paged list several pages at a time. getPage(p) -> rows (array), or null when the list
// ends / the page is refused. Stops at the first short or missing page.
export async function pagesInParallel(getPage, { pageSize, maxPages, parallel = 4, onRows }) {
  for (let start = 1; start <= maxPages; start += parallel) {
    const batch = Array.from({ length: Math.min(parallel, maxPages - start + 1) }, (_, i) => start + i);
    const pages = await Promise.all(batch.map((p) => getPage(p).catch(() => null)));
    let ended = false;
    for (const rows of pages) {
      if (!rows) { ended = true; break; }
      onRows(rows);
      if (rows.length < pageSize) { ended = true; break; }
    }
    if (ended) return;
  }
}

// Index of our item names for one game, longest first (so "Chroma Luger" wins over "Luger").
export function nameIndex(items) {
  const seen = new Map();
  for (const it of items) {
    const base = String(it.baseName || it.name).replace(/ \((No )?Finisher\)$/i, "").replace(/ \([^)]*\)$/, "");
    const w = words(base);
    if (w.trim().length >= 3 && !seen.has(w)) seen.set(w, base);
  }
  return [...seen].sort((a, b) => b[0].length - a[0].length);
}

// Words that may sit right next to an item name in a title without changing which item it is.
// Anything else touching the name ("Shadow Dragon Ducky", "Golden Harvester") means it's a
// different item we don't track, so the title is skipped.
const NOISE = new Set(("fr nfr mfr n m f r np neon mega fly ride potion no pet pets legendary ultra rare uncommon common egg eggs adopt me mm2 murder mystery "
  + "blade ball steal a brainrot roblox rbl item items knife gun godly ancient chroma unique vintage classic limited sword swords emote explosion finisher "
  + "fast instant delivery cheap cheapest best safe 100 24 7 online in stock stock real new hot sale deal offer buy x1 1x 1 x the for with and of "
  + "trade trading face to by from only all platform pc mobile mutation normal default sale weapon weapons wholesale super speedy quick legit trusted "
  + "seller shop store price premium ready cheapest good guaranteed delivered auto automatic gift instantly fastest low lowest top quality 2021 2022 2023 2024 2025 2026 "
  + "set_ value values ms m/s per second secret og brainrots").split(" "));
export function matchTitle(title, index) {
  const t = words(title);
  if (/ (random|mystery box|set|bundle|pack|lot|account|accounts|any|giveaway) /.test(t) || (String(title).match(/[,+&]/g) || []).length >= 2) return null;
  for (const [w, base] of index) {
    const at = t.indexOf(w);
    if (at < 0) continue;
    const before = t.slice(0, at).trim().split(" ").pop() || "";
    const after = t.slice(at + w.length).trim().split(" ")[0] || "";
    if ((before && !NOISE.has(before) && !/^\d+$/.test(before)) || (after && !NOISE.has(after) && !/^\d+$/.test(after))) continue; // part of a longer name
    return base;
  }
  return null;
}

// Cheapest price that isn't a likely fake/mislabelled outlier: the cheapest at or above half the
// median of the 5 cheapest (same rule Eldorado prices used to have).
export function robustMin(prices) {
  const s = prices.filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const median = s[Math.floor(Math.min(s.length, 5) / 2)];
  return s.find((v) => v >= median * 0.5) ?? s[0];
}

// Blade Ball: a listing is the Finisher version only if it says "finisher" (and not "no / without
// finisher"). Our items: "X (Finisher)" vs "X (No Finisher)" / plain.
export const listingHasFinisher = (title) => /finisher/i.test(title) && !/\b(no|without|w\/o|non)[\s-]*finisher/i.test(title);
export const itemIsFinisher = (name) => /\(Finisher\)$/i.test(String(name));
export const finKey = (id, finisher) => (finisher ? `${id}|fin` : id);

// Adopt Me version written in a title -> our trait code (null if it doesn't say).
export function amCode(title) {
  // "Adopt Me > Skelicorn > M" style: the last part is the version
  const parts = String(title).split(">").map((x) => x.trim().toLowerCase());
  if (parts.length >= 3) {
    const v = parts[parts.length - 1];
    const code = { fr: "fr", nfr: "nfr", mfr: "mfr", f: "f", r: "r", n: "n", m: "m", nf: "nf", nr: "nr", mf: "mf", mr: "mr", np: "none", "no potion": "none", normal: "none", neon: "n", mega: "m", "mega neon": "m" }[v];
    if (code) return code;
  }
  const t = words(title);
  if (/ (mfr|mega fly ride|mega neon fly ride) /.test(t)) return "mfr";
  if (/ (nfr|neon fly ride) /.test(t)) return "nfr";
  if (/ (mega neon|mega) /.test(t)) return "m";
  if (/ neon /.test(t)) return "n";
  if (/ (fr|fly ride|fly and ride) /.test(t)) return "fr";
  if (/ (no potion|np|nopotion) /.test(t)) return "none";
  if (/ fly /.test(t)) return "f";
  if (/ ride /.test(t)) return "r";
  return null;
}
