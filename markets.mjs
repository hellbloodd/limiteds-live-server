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

// Which item a title is about, or null. Bundles / random boxes / multi-item titles are skipped.
export function matchTitle(title, index) {
  const t = words(title);
  if (/ (random|mystery box|set|bundle|pack|lot|account|accounts|any|giveaway) /.test(t) || (String(title).match(/[,+&]/g) || []).length >= 2) return null;
  for (const [w, base] of index) if (t.includes(w)) return base;
  return null;
}

// Adopt Me version written in a title -> our trait code (null if it doesn't say).
export function amCode(title) {
  const t = words(title);
  if (/ (mfr|mega fly ride|mega neon fly ride) /.test(t)) return "mfr";
  if (/ (nfr|neon fly ride) /.test(t)) return "nfr";
  if (/ (mega neon|mega) /.test(t)) return "m";
  if (/ neon /.test(t)) return "n";
  if (/ (fr|fly ride|fly and ride|fly ride) /.test(t)) return "fr";
  if (/ (no potion|np|nopotion) /.test(t)) return "none";
  if (/ fly /.test(t)) return "f";
  if (/ ride /.test(t)) return "r";
  return null;
}
