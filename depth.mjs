// Market depth for the item preview: every listing at each price. The regular price checks only read
// the cheapest few listings, so when that snapshot is thin this fetches up to 50 listings for the one
// item (low priority, cached 5 minutes).
import { listingDepth } from "./updater.mjs";
import { listingsFor } from "./sniper.mjs";
import { lowPriority, withPageSize } from "./mm2-values.mjs";
import { allItems } from "./tools.mjs";

const cache = new Map(); // "game|key" -> { t, d }
const CACHE_MS = 5 * 60 * 1000;

export async function depthFor(game, key, port) {
  const snap = listingDepth(game, key);
  if (snap && (snap.complete || snap.offers.length >= 20)) return snap;
  const id = `${game}|${key}`;
  const c = cache.get(id);
  if (c && Date.now() - c.t < CACHE_MS) return c.d;
  const item = (await allItems(port)).find((i) => i.game === game && i.key === key);
  if (!item) return snap || { offers: [] };
  try {
    const p = await withPageSize(50, () => lowPriority(() => listingsFor(game, item)));
    if (p?.offers?.length) {
      const offers = p.offers.filter((o) => o[1] > 0).map((o) => [Math.round(o[1] * 100) / 100, Math.max(1, Number(o[2]) || 1)]).sort((a, b) => a[0] - b[0]);
      const d = { offers, complete: !(p.windowMax < Infinity), listings: p.listings ?? offers.length, at: new Date().toISOString() };
      cache.set(id, { t: Date.now(), d });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return d;
    }
  } catch (e) {
    console.warn(`Market depth for ${id} failed: ${e.message}`);
  }
  return snap || { offers: [] };
}
