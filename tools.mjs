// Owner tools: "My Listings" (undercut watch) and "Profits" (buy/sell ledger).
// Both hold private data, so reading or changing them needs the OWNER_KEY set on the server
// (sent by the pages as the x-owner-key header, which the owner types once per browser).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readRow, writeMm2Row } from "./mm2-values.mjs";
import { GAMES, gameItems, post, SITE, fmt } from "./deals.mjs";
import { eldoradoJson } from "./mm2-values.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER_KEY = String(process.env.OWNER_KEY || "").trim();

function isOwner(req) {
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
      items.push({ game, key: i.key, name: i.name, image: i.image, usd: i.usd ?? null, second: i.second ?? null, url: i.eldoradoUrl || "" });
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

// ---------- routes ----------
export async function handleToolsRequest(url, req, res, sendJson, port) {
  const page = { "/watch": "watch.html", "/profits": "profits.html" }[url.pathname.replace(/\/$/, "")];
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

  const route = { "/api/watchlist": "watchlist", "/api/ledger": "ledger" }[url.pathname];
  if (!route) return false;
  if (!OWNER_KEY) { sendJson(res, 503, { error: "Set OWNER_KEY (a password of 6+ characters) in Render's Environment first." }); return true; }
  if (!isOwner(req)) { sendJson(res, 401, { error: "Wrong owner key." }); return true; }

  const list = (await readRow(route).catch(() => null)) || [];
  if (req.method === "GET") {
    if (route === "watchlist") {
      // add live prices so the page shows where you stand
      const live = new Map((await allItems(port)).map((i) => [`${i.game}|${i.key}`, i]));
      sendJson(res, 200, { entries: list.map((w) => ({ ...w, live: live.get(`${w.game}|${w.key}`) || null })) });
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
