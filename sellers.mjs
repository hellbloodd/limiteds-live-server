// Seller trust: Eldorado's public review summary per seller (feedback % and number of ratings),
// cached for a day and kept in Supabase (row "sellers") so restarts don't refetch everything.
import { eldoradoJson, readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // sellerId -> { s: score %, n: ratings, at: ms }
let loaded = false, dirty = false;
const queue = [];
let working = false;

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  if (!supabaseConfig()) return;
  const row = await readRow("sellers").catch(() => null);
  for (const [id, v] of Object.entries(row || {})) cache.set(id, v);
}

// "trusted" 50+ ratings and 97%+, "ok" 10+ and 93%+, "new" under 10 ratings, "risky" below 93%.
export function trustOf(info) {
  if (!info) return null;
  const level = info.n < 10 ? "new" : info.s < 93 ? "risky" : info.n >= 50 && info.s >= 97 ? "trusted" : "ok";
  return { level, score: info.s, ratings: info.n };
}

export function sellerTrust(id) {
  if (!id) return null;
  return trustOf(cache.get(id));
}

async function fetchSeller(id) {
  const j = await eldoradoJson(`/api/orders/reviews/${encodeURIComponent(id)}?pageIndex=1&pageSize=1`);
  const u = j?.userOrderInfo || {};
  const info = { s: Math.round((u.feedbackScore ?? 0) * 10) / 10, n: u.ratingCount || 0, at: Date.now() };
  cache.set(id, info);
  dirty = true;
  return info;
}

// One seller, now (used for snipe alerts).
export async function getSellerTrust(id) {
  if (!id) return null;
  await loadOnce();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return trustOf(hit);
  return trustOf(await fetchSeller(id).catch(() => hit || null));
}

// Many sellers, in the background, one request at a time (they share Eldorado's budget).
export function warmSellers(ids) {
  for (const id of ids) if (id && !queue.includes(id) && !(Date.now() - (cache.get(id)?.at || 0) < TTL_MS)) queue.push(id);
  if (working) return;
  working = true;
  (async () => {
    await loadOnce();
    for (let id; (id = queue.shift());) {
      await fetchSeller(id).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  })().finally(() => { working = false; });
}

setInterval(async () => {
  if (!dirty || !supabaseConfig()) return;
  dirty = false;
  const now = Date.now();
  const obj = {};
  for (const [id, v] of cache) if (now - v.at < 7 * TTL_MS) obj[id] = v;
  await writeMm2Row("sellers", obj).catch(() => { dirty = true; });
}, 10 * 60 * 1000).unref();

loadOnce().catch(() => {});
