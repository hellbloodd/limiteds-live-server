// Owner tools: "My Listings" (undercut watch) and "Profits" (buy/sell ledger).
// Both hold private data, so reading or changing them needs the OWNER_KEY set on the server
// (sent by the pages as the x-owner-key header, which the owner types once per browser).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readRow, writeMm2Row } from "./mm2-values.mjs";
import { GAMES, gameItems, post, SITE, fmt } from "./deals.mjs";

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

// ---------- undercut watch ----------
// watchlist row: [{ id, game, key, name, myPrice, addedAt, alerted: { usd, at } }]
export async function checkUndercuts(game, port) {
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
