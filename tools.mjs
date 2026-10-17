// Owner tools: "My Listings" (undercut watch) and "Profits" (buy/sell ledger).
// Both hold private data, so reading or changing them needs the OWNER_KEY set on the server
// (sent by the pages as the x-owner-key header, which the owner types once per browser).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readRow, writeMm2Row } from "./mm2-values.mjs";
import { GAMES, gameItems, post, SITE, fmt, valueField } from "./deals.mjs";
import { eldoradoJson } from "./mm2-values.mjs";

import { sellerTrust } from "./sellers.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER_KEY = String(process.env.OWNER_KEY || "").trim();

export function isOwner(req) {
  const got = Buffer.from(String(req.headers["x-owner-key"] || ""));
  const want = Buffer.from(OWNER_KEY);
  return OWNER_KEY.length >= 6 && got.length === want.length && timingSafeEqual(got, want);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 20000) throw new Error("too large"); }
  return body ? JSON.parse(body) : {};
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clean = (s, n = 80) => String(s ?? "").slice(0, n);
const money = (n) => Math.round(Math.max(0, Number(n) || 0) * 100) / 100;

// ---------- item search (for picking items on the owner pages) ----------
let searchCache = { at: 0, items: [] };
async function allItems(port) {
  if (Date.now() - searchCache.at < 60 * 1000) return searchCache.items;
  const items = [];
  for (const [game, g] of Object.entries(GAMES)) {
    for (const i of await gameItems(g, port).catch(() => [])) {
      items.push({ game, key: i.key, name: i.name, image: i.image, usd: i.usd ?? null, second: i.second ?? null, url: i.eldoradoUrl || "",
        value: i.value ?? null, soldPrice: i.soldPrice ?? null, sold7d: i.sold7d || 0, change7d: i.priceChanges?.["7d"]?.pct ?? null, sellers: i.sellers || null });
    }
  }
  searchCache = { at: Date.now(), items };
  return items;
}

// ---------- syncing "My Listings" from the owner's public Eldorado shop ----------
// Listings are public: the owner's username -> seller id (users/<name>/publicByUsername) -> their
// offers per game (offers search filtered by userId). No Eldorado login involved.
const ELDORADO_GAME_IDS = { "MM2": 204, "Blade Ball": 203, "Adopt Me": 201, "Steal a Brainrot": 259 };
const normName = (s) => String(s || "").toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "");

async function ownerSettings() { return (await readRow("owner_settings").catch(() => null)) || {}; }

export async function resolveEldoradoUser(username) {
  const p = await eldoradoJson(`/api/users/${encodeURIComponent(username)}/publicByUsername`);
  if (!p?.id) throw new Error("No Eldorado user with that name.");
  return { eldoradoUser: p.username, eldoradoUserId: p.id };
}

// Our item for one of the owner's offers: same name (Eldorado adds "(2023)" etc.), Chroma for MM2
// chroma listings; Blade Ball listings are free text, so the offer title is matched against names.
function matchOffer(game, offer, items) {
  const env = (offer.tradeEnvironmentValues || []).map((v) => v.value);
  const chroma = (offer.attributes || []).some((a) => /chroma/i.test(a.value?.name || ""));
  const target = env.length ? env[env.length - 1] : offer.offerTitle;
  const want = normName((chroma ? "chroma " : "") + target);
  const byName = items.filter((i) => normName(i.name) === want || (chroma && normName(i.name) === normName("c. " + target)));
  if (byName.length) return byName.sort((a, b) => (b.usd > 0) - (a.usd > 0))[0];
  if (game === "Blade Ball") { // title like "Dragon Slayer ♨️Limited♨️": longest item name the title starts with
    const t = normName(offer.offerTitle);
    return items.filter((i) => normName(i.name).length > 3 && t.startsWith(normName(i.name))).sort((a, b) => b.name.length - a.name.length)[0] || null;
  }
  return null;
}

// Keeps the watchlist's Eldorado-synced entries in line with the owner's live listings for a game.
// Returns { added, updated, removed } (removed = sold or delisted since the last sync).
export async function syncEldoradoListings(game, port) {
  const s = await ownerSettings();
  if (!s.eldoradoUserId || !ELDORADO_GAME_IDS[game]) return null;
  const j = await eldoradoJson(`/api/v1/item-management/offers?gameId=${ELDORADO_GAME_IDS[game]}&category=CustomItem&pageIndex=1&pageSize=50`
    + `&useMinPurchasePrice=false&useOfferAttributeSearch=false&usePopularItems=false&userId=${encodeURIComponent(s.eldoradoUserId)}`);
  const items = await gameItems(GAMES[game], port);
  const list = (await readRow("watchlist").catch(() => null)) || [];
  const seen = new Set();
  let added = 0, updated = 0;
  for (const r of j.results || []) {
    const o = r.offer, price = o?.pricePerUnitInUSD?.amount;
    if (!o?.id || !(price > 0)) continue;
    seen.add(o.id);
    const it = matchOffer(game, o, items);
    const entry = list.find((w) => w.offerId === o.id);
    if (entry) {
      if (entry.myPrice !== money(price) || entry.qty !== o.quantity) { entry.myPrice = money(price); entry.qty = o.quantity; updated++; }
    } else {
      list.push({ id: newId(), source: "eldorado", offerId: o.id, game, key: it?.key || "", name: it?.name || clean(o.offerTitle),
        title: clean(o.offerTitle, 120), myPrice: money(price), qty: o.quantity ?? 1, addedAt: Date.now() });
      added++;
    }
  }
  const before = list.length;
  const kept = list.filter((w) => !(w.source === "eldorado" && w.game === game && !seen.has(w.offerId)));
  const removed = before - kept.length;
  if (added || updated || removed) await writeMm2Row("watchlist", kept);
  return { added, updated, removed, listings: seen.size };
}

// ---------- undercut watch ----------
// watchlist row: [{ id, game, key, name, myPrice, addedAt, alerted: { usd, at } }]
export async function checkUndercuts(game, port) {
  await syncEldoradoListings(game, port).catch((e) => console.error(`${game} listing sync failed: ${e.message}`));
  const list = (await readRow("watchlist").catch(() => null)) || [];
  const mine = list.filter((w) => w.game === game);
  if (!mine.length) return 0;
  const items = new Map((await gameItems(GAMES[game], port)).map((i) => [i.key, i]));
  let sent = 0;
  for (const w of mine) {
    const i = items.get(w.key);
    if (!(i?.usd > 0) || i.usd >= w.myPrice - 0.004) continue; // nobody below you
    if (w.alerted && w.alerted.usd <= i.usd && Date.now() - w.alerted.at < 24 * 3600 * 1000) continue; // already told
    const suggest = Math.max(0.01, i.usd - 0.01);
    await post({
      username: "Agony Values — my listings",
      embeds: [{
        title: `⚠️ Undercut: ${w.name}`,
        url: i.eldoradoUrl, color: 0xe0576a, thumbnail: i.image ? { url: i.image } : undefined,
        description: `Someone listed **${w.name}** at **$${fmt(i.usd)}** — yours is **$${fmt(w.myPrice)}**.\nTo be the cheapest again, relist at **$${fmt(suggest)}**.`,
        fields: [
          { name: "Game", value: game, inline: true },
          valueField(i),
          { name: "Listings", value: String(i.listings ?? "?"), inline: true },
          { name: "Links", value: `[See listings](${i.eldoradoUrl}) · [My Listings](${SITE}/watch)`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});
    w.alerted = { usd: i.usd, at: Date.now() };
    sent++;
  }
  if (sent) await writeMm2Row("watchlist", list);
  return sent;
}

// The price to set for one of your listings: 1¢ under the cheapest seller worth competing with
// (a new or low-rated seller far below is often fake), never under what you paid plus Eldorado's
// fee (from your Profits ledger), and if you're already cheapest, as high as the 2nd allows.
const FEE = Number(process.env.FLIP_FEE_PCT || 10) / 100;
function suggestPrice(w, l, ledger, me) {
  if (!l?.usd) return null;
  const buys = ledger.filter((e) => e.game === w.game && e.key === w.key).sort((a, b) => b.ts - a.ts);
  const lastBuy = buys.find((e) => e.type === "buy");
  const soldSince = lastBuy && buys.some((e) => e.type === "sell" && e.ts > lastBuy.ts);
  const cost = lastBuy && !soldSince ? lastBuy.price : null;
  const floor = cost ? Math.ceil((cost / (1 - FEE)) * 100) / 100 + 0.01 : 0.01; // break-even after the fee
  const [s0, s1] = l.sellers || [];
  const t0 = sellerTrust(s0);
  const iAmCheapest = (me && s0 === me) || Math.abs(l.usd - w.myPrice) < 0.005;
  let price, why;
  if (iAmCheapest) {
    if (!l.second) return { price: w.myPrice, why: "You're the only listing.", floor: cost ? floor : null };
    price = Math.max(w.myPrice, l.second - 0.01);
    why = price > w.myPrice + 0.004 ? `You're cheapest — you can raise to 1¢ under the next listing (${l.second}).` : "You're cheapest — keep this price.";
  } else if (t0 && (t0.level === "risky" || t0.level === "new") && l.second) {
    price = l.second - 0.01;
    why = `The cheapest ($${l.usd}) is from a ${t0.level === "new" ? "new" : "low-rated"} seller — beat the next one instead.`;
  } else {
    price = l.usd - 0.01;
    why = "1¢ under the cheapest listing.";
  }
  price = Math.round(price * 100) / 100;
  if (price < floor) return { price: floor, why: `Matching would sell under what you paid ($${cost}) after the ${Math.round(FEE * 100)}% fee — hold at break-even.`, floor, belowCost: true };
  return { price, why, floor: cost ? floor : null };
}

// ---------- Portfolio ----------
// What you hold (Profits ledger, first-bought-first-sold), priced at today's Eldorado listings:
// market value (cheapest listing), what you'd get selling now (1¢ under it, after the fee), and
// unrealised profit. A daily point of the totals is kept in Supabase row "portfolio_history".
async function portfolio(port) {
  const ledger = ((await readRow("ledger").catch(() => null)) || []).slice().sort((a, b) => a.ts - b.ts);
  const live = new Map((await allItems(port)).map((i) => [`${i.game}|${i.key}`, i]));
  const lots = new Map();
  let realised = 0;
  for (const e of ledger) {
    const k = `${e.game}|${e.key || e.name}`;
    const L = lots.get(k) || { game: e.game, key: e.key, name: e.name, queue: [], firstTs: e.ts };
    lots.set(k, L);
    if (e.type === "buy") L.queue.push({ qty: e.qty, cost: e.price, ts: e.ts });
    else {
      let left = e.qty, cost = 0;
      while (left > 0 && L.queue.length) {
        const lot = L.queue[0], take = Math.min(left, lot.qty);
        cost += take * lot.cost; lot.qty -= take; left -= take;
        if (!lot.qty) L.queue.shift();
      }
      realised += e.qty * e.price - (e.fee || 0) - cost;
    }
  }
  const holdings = [];
  for (const [k, L] of lots) {
    const qty = L.queue.reduce((n, l) => n + l.qty, 0);
    if (!qty) continue;
    const cost = L.queue.reduce((n, l) => n + l.qty * l.cost, 0);
    const i = live.get(k);
    const usd = i?.usd ?? null;
    const sellNowEach = usd ? Math.max(0, (usd - 0.01) * (1 - FEE)) : null;
    holdings.push({
      game: L.game, key: L.key, name: L.name, image: i?.image || "", url: i?.url || "", qty, cost, avgCost: cost / qty,
      heldDays: Math.floor((Date.now() - Math.min(...L.queue.map((l) => l.ts))) / 864e5),
      usd, second: i?.second ?? null, soldPrice: i?.soldPrice ?? null, sold7d: i?.sold7d || 0, change7d: i?.change7d ?? null, value: i?.value ?? null,
      marketValue: usd ? usd * qty : null, sellNow: sellNowEach != null ? sellNowEach * qty : null,
      unrealised: sellNowEach != null ? sellNowEach * qty - cost : null,
      sellersTrust: i?.sellers ? sellerTrust(i.sellers[0]) : null,
    });
  }
  holdings.sort((a, b) => (b.marketValue ?? b.cost) - (a.marketValue ?? a.cost));
  const sum = (f) => holdings.reduce((n, h) => n + (h[f] ?? 0), 0);
  const totals = { cost: sum("cost"), marketValue: sum("marketValue"), sellNow: sum("sellNow"), unrealised: sum("unrealised"), realised, items: sum("qty"),
    unpriced: holdings.filter((h) => h.usd == null).length };
  // one point a day (the latest call of the day wins)
  const hist = (await readRow("portfolio_history").catch(() => null)) || [];
  const day = new Date().toISOString().slice(0, 10);
  const point = [day, Math.round(totals.cost * 100) / 100, Math.round(totals.sellNow * 100) / 100, Math.round(realised * 100) / 100];
  if (holdings.length || hist.length) {
    if (hist.length && hist[hist.length - 1][0] === day) hist[hist.length - 1] = point; else hist.push(point);
    await writeMm2Row("portfolio_history", hist.slice(-730)).catch(() => {});
  }
  return { fee: FEE, totals, holdings, history: hist };
}

// ---------- routes ----------
export async function handleToolsRequest(url, req, res, sendJson, port) {
  const page = { "/watch": "watch.html", "/profits": "profits.html", "/portfolio": "portfolio.html" }[url.pathname.replace(/\/$/, "")];
  if (page) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(join(HERE, page), "utf8"));
    return true;
  }
  if (url.pathname === "/tools.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "max-age=300" });
    res.end(await readFile(join(HERE, "tools.css"), "utf8"));
    return true;
  }
  if (url.pathname === "/api/item-search") {
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();
    const game = url.searchParams.get("game") || "";
    const items = q.length < 2 ? [] : (await allItems(port))
      .filter((i) => (!game || i.game === game) && i.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.length - b.name.length)
      .slice(0, 12);
    sendJson(res, 200, { items });
    return true;
  }

  if (url.pathname === "/api/owner-settings" || url.pathname === "/api/sync-listings") {
    if (!OWNER_KEY) { sendJson(res, 503, { error: "Set OWNER_KEY (a password of 6+ characters) in Render's Environment first." }); return true; }
    if (!isOwner(req)) { sendJson(res, 401, { error: "Wrong owner key." }); return true; }
    if (url.pathname === "/api/sync-listings") {
      const out = {};
      for (const game of Object.keys(ELDORADO_GAME_IDS)) out[game] = await syncEldoradoListings(game, port).catch((e) => ({ error: e.message }));
      sendJson(res, 200, out);
      return true;
    }
    if (req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const name = clean(b.eldoradoUser, 40).trim();
      try {
        const s = name ? await resolveEldoradoUser(name) : {};
        await writeMm2Row("owner_settings", s);
        sendJson(res, 200, s);
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return true;
    }
    sendJson(res, 200, await ownerSettings());
    return true;
  }

  if (url.pathname === "/api/holdings") {
    if (!OWNER_KEY) { sendJson(res, 503, { error: "Set OWNER_KEY (a password of 6+ characters) in Render's Environment first." }); return true; }
    if (!isOwner(req)) { sendJson(res, 401, { error: "Wrong owner key." }); return true; }
    sendJson(res, 200, await portfolio(port));
    return true;
  }
  const route = { "/api/watchlist": "watchlist", "/api/ledger": "ledger" }[url.pathname];
  if (!route) return false;
  if (!OWNER_KEY) { sendJson(res, 503, { error: "Set OWNER_KEY (a password of 6+ characters) in Render's Environment first." }); return true; }
  if (!isOwner(req)) { sendJson(res, 401, { error: "Wrong owner key." }); return true; }

  const list = (await readRow(route).catch(() => null)) || [];
  if (req.method === "GET") {
    if (route === "watchlist") {
      // add live prices so the page shows where you stand
      const live = new Map((await allItems(port)).map((i) => [`${i.game}|${i.key}`, i]));
      const ledger = (await readRow("ledger").catch(() => null)) || [];
      const me = (await readRow("owner_settings").catch(() => null))?.eldoradoUserId || null;
      sendJson(res, 200, { entries: list.map((w) => {
        const l = live.get(`${w.game}|${w.key}`) || null;
        return { ...w, live: l, suggest: suggestPrice(w, l, ledger, me) };
      }) });
    } else {
      const live = new Map((await allItems(port)).map((i) => [`${i.game}|${i.key}`, i]));
      sendJson(res, 200, { entries: list.map((e) => ({ ...e, liveUsd: live.get(`${e.game}|${e.key}`)?.usd ?? null })) });
    }
    return true;
  }
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    const next = list.filter((e) => e.id !== id);
    await writeMm2Row(route, next);
    sendJson(res, 200, { ok: true, count: next.length });
    return true;
  }
  if (req.method === "POST") {
    const b = await readBody(req).catch(() => null);
    if (!b || !b.name || !GAMES[b.game]) { sendJson(res, 400, { error: "Pick an item first." }); return true; }
    let entry;
    if (route === "watchlist") {
      if (!(Number(b.myPrice) > 0)) { sendJson(res, 400, { error: "Enter your listing price." }); return true; }
      entry = { id: newId(), game: b.game, key: clean(b.key, 200), name: clean(b.name), myPrice: money(b.myPrice), addedAt: Date.now() };
      const existing = list.findIndex((w) => w.game === entry.game && w.key === entry.key);
      if (existing >= 0) list.splice(existing, 1); // one entry per item: replace
    } else {
      if (!["buy", "sell"].includes(b.type) || !(Number(b.price) > 0)) { sendJson(res, 400, { error: "Enter a buy or sell with a price." }); return true; }
      entry = { id: newId(), ts: Number(b.ts) || Date.now(), game: b.game, key: clean(b.key, 200), name: clean(b.name), type: b.type,
        qty: Math.max(1, Math.floor(Number(b.qty) || 1)), price: money(b.price), fee: money(b.fee), note: clean(b.note, 120) };
      if (list.length >= 5000) list.shift();
    }
    list.push(entry);
    await writeMm2Row(route, list);
    sendJson(res, 200, { ok: true, entry });
    return true;
  }
  sendJson(res, 405, { error: "Method not allowed" });
  return true;
}
