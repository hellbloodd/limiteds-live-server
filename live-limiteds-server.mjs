import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import http from "http";
import { URL } from "url";
import { handleMm2Request, startMm2Tracker } from "./mm2-values.mjs";
import { handleBbRequest, startBbTracker } from "./bb-values.mjs";
import { handleAmRequest, startAmTracker } from "./am-values.mjs";
import { handleSabRequest, startSabTracker } from "./sab-values.mjs";
import { requestRefresh, requestSelectedRefresh, startAutoUpdates, updaterStatus } from "./updater.mjs";
import { sniperStatus, boosterWork, boosterResults, boosterTakeFull, boosterFinishFull, sampleItem, requestMarketsScan, resetSniperLists } from "./sniper.mjs";
import { clearLibraryCache, eldoradoBudget } from "./mm2-values.mjs";
import { isOwner, warmItems } from "./tools.mjs";
import { startHealthAlerts } from "./health.mjs";
import { startG2g, g2gStatus, g2gRefreshNow } from "./g2g.mjs";
import { startU7, u7Status, u7RefreshNow } from "./u7buy.mjs";
import { startRemoteMarkets, receiveMarket, remoteMarketStatus } from "./remote-markets.mjs";
import { startCurrency, refreshCurrency, receiveCurrency, currencyPrices } from "./currency.mjs";
import { startAlerts, listAlerts, addAlert, removeAlert } from "./alerts.mjs";
import { startMarketHistory, marketHistory } from "./market-history.mjs";
import { startSeasons, seasonsReport, preloadSeasons } from "./seasons.mjs";
import { publicKey as pushPublicKey, addSubscription, notifyPhones, latestNotification } from "./push.mjs";
import { readFile as readStatic } from "node:fs/promises";
// The last 30 errors/warnings, for /api/status (Render's logs aren't always at hand).
const recentErrors = [];
for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    recentErrors.unshift(`${new Date().toISOString().slice(11, 19)} ${args.map(String).join(" ").slice(0, 300)}`);
    recentErrors.length = Math.min(recentErrors.length, 30);
    orig(...args);
  };
}
import { sendTestAlert } from "./deals.mjs";
import { handleFlipsRequest, warmFlips, preloadFlips } from "./flips.mjs";
import { handleToolsRequest, preloadItems, startPortfolioSnapshots } from "./tools.mjs";
import { dashboard, warmDashboard, preloadDashboard } from "./dashboard.mjs";
import { depthFor } from "./depth.mjs";
import { listEvents, addEvent, deleteEvent } from "./calendar.mjs";
import { saleMovers, marketDeals, itemSales, startMoverAlerts } from "./movers.mjs";


// Agony Values server: Roblox item values (MM2, Blade Ball, Adopt Me, Steal a Brainrot) with
// Eldorado and other marketplaces' prices, the Flip Finder, sniper, alerts and owner tools.
// (The original Roblox limiteds tracker that this file started as has been removed.)
const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "agony-values-2";

// Public answers that are the same for everyone are kept (already compressed) for a short while, so
// a page load doesn't rebuild and re-gzip several MB each time. Owner-only routes are never cached.
const SHARED_TTL = { "/api/mm2": 30e3, "/api/bladeball": 30e3, "/api/adoptme": 30e3, "/api/stealabrainrot": 30e3, "/api/trade-items": 60e3,
  "/api/seasons": 300e3, "/api/flips": 30e3, "/api/dashboard": 60e3, "/api/currency": 30e3, "/api/item-search": 60e3, "/api/sale-movers": 120e3, "/api/market-deals": 120e3 };
const shared = new Map(); // url -> { t, ttl, status, text, gz, etag }
const BASE_HEADERS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };

function writeCached(req, res, c) {
  const headers = { ...BASE_HEADERS, "Cache-Control": "no-cache", ETag: c.etag, Vary: "Accept-Encoding" };
  if (req.headers["if-none-match"] === c.etag) { res.writeHead(304, headers); return res.end(); }
  if (c.gz && /gzip/.test(req.headers["accept-encoding"] || "")) { res.writeHead(c.status, { ...headers, "Content-Encoding": "gzip" }); return res.end(c.gz); }
  res.writeHead(c.status, headers); res.end(c.text);
}

// Serves a fresh cached copy if there is one; returns true when it did.
function serveShared(req, res, pathname) {
  if (req.method !== "GET" || !SHARED_TTL[pathname]) return false;
  const c = shared.get(req.url);
  if (!c || Date.now() - c.t > c.ttl) return false;
  writeCached(req, res, c);
  return true;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  const req = res.req;
  const pathname = req ? req.url.split("?")[0] : "";
  if (req?.method === "GET" && SHARED_TTL[pathname] && status === 200 && !body?.error) { // never keep a "still loading" answer
    const gz = text.length > 20000 ? gzipSync(text, { level: 6 }) : null;
    const c = { t: Date.now(), ttl: SHARED_TTL[pathname], status, text, gz, etag: `"${createHash("sha1").update(text).digest("base64url").slice(0, 20)}"` };
    shared.set(req.url, c);
    if (shared.size > 300) shared.delete(shared.keys().next().value);
    return writeCached(req, res, c);
  }
  // Big answers go out gzipped when the browser accepts it.
  if (text.length > 20000 && /gzip/.test(req?.headers?.["accept-encoding"] || "")) {
    res.writeHead(status, { ...BASE_HEADERS, "Cache-Control": "no-store", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    return res.end(gzipSync(text, { level: 6 }));
  }
  res.writeHead(status, { ...BASE_HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store" });
  res.end(text);
}


const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  try {
    if (serveShared(req, res, parsedUrl.pathname)) return;
    // Phone app: installable (manifest + service worker + icons) with push notifications
    const STATIC = { "/sw.js": ["sw.js", "text/javascript"], "/app.js": ["app.js", "text/javascript"], "/glass.css": ["glass.css", "text/css"], "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"] };
    const icon = /^\/icons\/([a-z0-9-]+\.png)$/.exec(parsedUrl.pathname);
    if (STATIC[parsedUrl.pathname] || icon) {
      const [file, type] = STATIC[parsedUrl.pathname] || [`icons/${icon[1]}`, "image/png"];
      try {
        const body = await readStatic(new URL(file, import.meta.url));
        res.writeHead(200, { "Content-Type": type, "Cache-Control": icon ? "public, max-age=604800" : file === "sw.js" || file.endsWith(".webmanifest") ? "no-cache" : "public, max-age=600, stale-while-revalidate=86400", ...(file === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}) });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    if (parsedUrl.pathname === "/api/push/key") return sendJson(res, 200, { publicKey: await pushPublicKey() });
    if (parsedUrl.pathname === "/api/push/latest") return sendJson(res, 200, latestNotification());
    if ((parsedUrl.pathname === "/api/push/subscribe" || parsedUrl.pathname === "/api/push/test") && req.method === "POST") {
      if (!isOwner(req)) return sendJson(res, 401, { error: "Wrong or missing owner key." });
      if (parsedUrl.pathname === "/api/push/test") {
        const it = sampleItem();
        return sendJson(res, 200, { sent: await notifyPhones(it ? {
          title: `🔔 Test: ${it.name} — example snipe`,
          body: [`💵 Cheapest $${it.usd}${it.second ? ` · next $${it.second}` : ""}`, `🎮 ${it.game} · ${it.sold7d || 0} sold/7d`, "This is what a snipe alert looks like ✓"].join("\n"),
          url: it.eldoradoUrl || "/flips", image: it.image, tag: "av-test",
        } : { title: "🔔 Agony Values alerts are on", body: "You'll get snipes here as they happen.", url: "/flips", tag: "av-test" }) });
      }
      let body = ""; for await (const c of req) { body += c; if (body.length > 10000) break; }
      try { return sendJson(res, 200, { ok: true, phones: await addSubscription(JSON.parse(body)) }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    // PC booster (booster.mjs): owner only
    if (parsedUrl.pathname.startsWith("/api/booster/")) {
      if (!isOwner(req)) return sendJson(res, 401, { error: "Wrong or missing owner key." });
      if (parsedUrl.pathname === "/api/booster/work") return sendJson(res, 200, boosterWork(Number(parsedUrl.searchParams.get("max")) || 40));
      if (parsedUrl.pathname === "/api/booster/full" && req.method === "GET") return sendJson(res, 200, boosterTakeFull() || { game: null });
      let body = ""; for await (const c of req) { body += c; if (body.length > 30e6) break; }
      if (parsedUrl.pathname === "/api/booster/currency") { let b = {}; try { b = JSON.parse(body); } catch { /* bad body */ } return sendJson(res, 200, await receiveCurrency(b.markets)); }
      if (parsedUrl.pathname === "/api/booster/market") { let b = {}; try { b = JSON.parse(body); } catch { /* bad body */ } return sendJson(res, 200, await receiveMarket(b.market, b.games)); }
      if (parsedUrl.pathname === "/api/booster/full") { let b = {}; try { b = JSON.parse(body); } catch { /* bad body */ } return sendJson(res, 200, boosterFinishFull(b.game, b.prices)); }
      let results = []; try { results = JSON.parse(body).results || []; } catch { /* bad body */ }
      return sendJson(res, 200, await boosterResults(results));
    }
    if (parsedUrl.pathname === "/api/status") return sendJson(res, 200, { ...updaterStatus(), eldorado: eldoradoBudget(), markets: { G2G: g2gStatus(), U7BUY: u7Status(), ...remoteMarketStatus() }, sniper: { ...sniperStatus(), recent: undefined }, recentErrors });
    if (parsedUrl.pathname === "/ping") return sendJson(res, 200, { status: "awake", version: SERVER_VERSION });
    if (parsedUrl.pathname === "/api/currency") return sendJson(res, 200, currencyPrices());
    if (parsedUrl.pathname === "/api/seasons") {
      const items = (await (await fetch(`http://127.0.0.1:${PORT}/api/mm2`)).json().catch(() => ({ items: [] }))).items || [];
      return sendJson(res, 200, seasonsReport(items));
    }
    if (parsedUrl.pathname === "/api/depth") return sendJson(res, 200, await depthFor(parsedUrl.searchParams.get("game") || "", parsedUrl.searchParams.get("key") || "", PORT));
    if (parsedUrl.pathname === "/api/sale-movers") return sendJson(res, 200, await saleMovers(parsedUrl.searchParams.get("period") || "24h", PORT));
    if (parsedUrl.pathname === "/api/market-deals") return sendJson(res, 200, await marketDeals(PORT));
    if (parsedUrl.pathname === "/api/sales") return sendJson(res, 200, { sales: itemSales(parsedUrl.searchParams.get("game") || "", parsedUrl.searchParams.get("key") || "") });
    if (parsedUrl.pathname === "/api/dashboard") return sendJson(res, 200, await dashboard(PORT));
    if (parsedUrl.pathname === "/api/market-history") return sendJson(res, 200, { markets: await marketHistory(parsedUrl.searchParams.get("game") || "", parsedUrl.searchParams.get("key") || "") });
    // price alerts (owner only)
    // event calendar: anyone can read it, only the owner adds or removes events
    if (parsedUrl.pathname === "/api/calendar") {
      try {
        if (req.method === "GET") {
          const seasons = await (await fetch(`http://127.0.0.1:${PORT}/api/seasons`)).json().catch(() => null);
          return sendJson(res, 200, { events: await listEvents(seasons) });
        }
        if (!process.env.OWNER_KEY || !isOwner(req)) return sendJson(res, 401, { error: "Only the owner can change the calendar (owner key)." });
        if (req.method === "DELETE") { await deleteEvent(parsedUrl.searchParams.get("id") || ""); return sendJson(res, 200, { ok: true }); }
        if (req.method === "POST") {
          let body = ""; for await (const c of req) { body += c; if (body.length > 10000) break; }
          return sendJson(res, 200, { ok: true, event: await addEvent(JSON.parse(body || "{}")) });
        }
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (parsedUrl.pathname === "/api/alerts") {
      if (!process.env.OWNER_KEY) return sendJson(res, 503, { error: "Set OWNER_KEY (a password of 6+ characters) in Render's Environment first." });
      if (!isOwner(req)) return sendJson(res, 401, { error: "Wrong owner key." });
      try {
        if (req.method === "GET") return sendJson(res, 200, { alerts: await listAlerts(PORT) });
        if (req.method === "DELETE") return sendJson(res, 200, await removeAlert(parsedUrl.searchParams.get("id")));
        if (req.method === "POST") {
          let body = ""; for await (const c of req) { body += c; if (body.length > 10000) break; }
          return sendJson(res, 200, { ok: true, alert: await addAlert(JSON.parse(body || "{}")) });
        }
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (parsedUrl.pathname === "/alerts" || parsedUrl.pathname === "/alerts/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readStatic(new URL("alerts.html", import.meta.url)));
    }
    if (parsedUrl.pathname === "/currency" || parsedUrl.pathname === "/currency/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readStatic(new URL("currency.html", import.meta.url)));
    }
    if (parsedUrl.pathname === "/" || parsedUrl.pathname === "/app") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readStatic(new URL("home.html", import.meta.url)));
    }
    if (parsedUrl.pathname === "/api/refresh-values") {
      // "Refresh now": Eldorado + every other marketplace (G2G, U7BUY here; GameBoost/Itemku on the PC booster)
      // new items: reload Eldorado's item lists and the sniper's watch list too
      clearLibraryCache(); resetSniperLists();
      const r = requestRefresh(parsedUrl.searchParams.get("game"));
      if (process.env.SUPABASE_URL && !parsedUrl.searchParams.get("game")) {
        g2gRefreshNow().catch(() => {}); u7RefreshNow(PORT).catch(() => {}); refreshCurrency().catch(() => {});
        r.markets = { G2G: true, U7BUY: true, browser: requestMarketsScan() };
      }
      return sendJson(res, 200, r);
    }
    if (parsedUrl.pathname === "/api/refresh-flips" && req.method === "POST") {
      let body = ""; for await (const c of req) { body += c; if (body.length > 50000) break; }
      let sel = []; try { sel = JSON.parse(body).items || []; } catch { /* bad body */ }
      return sendJson(res, 200, requestSelectedRefresh(sel));
    }
    if (parsedUrl.pathname === "/api/test-deal-alert") return sendJson(res, 200, await sendTestAlert(PORT).catch((e) => ({ ok: false, error: e.message })));
    if (await handleMm2Request(parsedUrl, res, sendJson)) return;
    if (await handleBbRequest(parsedUrl, res, sendJson)) return;
    if (await handleAmRequest(parsedUrl, res, sendJson)) return;
    if (await handleSabRequest(parsedUrl, res, sendJson)) return;
    if (parsedUrl.pathname === "/api/snipes") return sendJson(res, 200, sniperStatus());
    if (await handleFlipsRequest(parsedUrl, res, sendJson, PORT)) return;
    if (await handleToolsRequest(parsedUrl, req, res, sendJson, PORT)) return;

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`Unhandled error: ${error.message}`);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

async function startServer() {
  console.log("Waiting for Render network to be ready...");
  // meanwhile, load the last saved snapshots so the first visitors don't wait for rebuilds
  const preload = Promise.allSettled([preloadItems(), preloadFlips(), preloadDashboard(), preloadSeasons()]);
  await new Promise(resolve => setTimeout(resolve, 5000));
  await Promise.race([preload, new Promise((resolve) => setTimeout(resolve, 10000))]);
  server.listen(PORT, () => console.log(`Agony Values server ${SERVER_VERSION} running on http://localhost:${PORT}`));
}

startServer();
startMm2Tracker();
startBbTracker();
startAmTracker();
startSabTracker();
// The server fetches values itself (every 15 min + "Refresh now"); needs Supabase to store them.
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  startAutoUpdates(PORT);
  startG2g(); // other marketplaces' prices for the Flip Finder (cross-market flips)
  startU7(PORT);
  startRemoteMarkets(); // GameBoost / Itemku, sent by the PC booster
  startCurrency(); // Blade Ball tokens and Robux on every marketplace
  startAlerts(PORT); // the owner's price alerts
  startMoverAlerts(PORT);
  startPortfolioSnapshots(PORT); // portfolio value saved every 6 hours (the chart fills in without visiting) // Discord + phone when an item's average sale price jumps or drops
  warmItems(PORT); // item search / alerts / portfolio list, always ready
  startMarketHistory(PORT); // price history on G2G / U7BUY / GameBoost / Itemku
  startSeasons(); // Halloween / Christmas item lists from mm2values
  warmFlips(PORT); warmDashboard(PORT); // Flip Finder data always ready
  // Discord alert when a game's prices/values go stale or the sniper stops (and when it's fixed)
  startHealthAlerts(() => ({ updater: updaterStatus(), sniper: sniperStatus(), errors: recentErrors }));
}

// Keep-awake: Render's free plan sleeps a service after ~15 minutes without visitors, which would
// pause updates, alerts, sales tracking and the sniper. Visiting our own public /ping through
// Render's address every 10 minutes counts as a visit. RENDER_EXTERNAL_URL is set by Render itself.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_AWAKE !== "off") {
  const pingUrl = `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/ping`;
  setInterval(() => { fetch(pingUrl).catch(() => {}); }, 10 * 60 * 1000).unref();
  console.log(`Keep-awake: pinging ${pingUrl} every 10 minutes.`);
}
