import { gzipSync } from "node:zlib";
import http from "http";
import { URL } from "url";
import { handleMm2Request, startMm2Tracker } from "./mm2-values.mjs";
import { handleBbRequest, startBbTracker } from "./bb-values.mjs";
import { handleAmRequest, startAmTracker } from "./am-values.mjs";
import { handleSabRequest, startSabTracker } from "./sab-values.mjs";
import { requestRefresh, requestSelectedRefresh, startAutoUpdates, updaterStatus } from "./updater.mjs";
import { sniperStatus, boosterWork, boosterResults, boosterTakeFull, boosterFinishFull, sampleItem, requestMarketsScan, resetSniperLists } from "./sniper.mjs";
import { clearLibraryCache, eldoradoBudget } from "./mm2-values.mjs";
import { isOwner } from "./tools.mjs";
import { startHealthAlerts } from "./health.mjs";
import { startG2g, g2gStatus, g2gRefreshNow } from "./g2g.mjs";
import { startU7, u7Status, u7RefreshNow } from "./u7buy.mjs";
import { startRemoteMarkets, receiveMarket, remoteMarketStatus } from "./remote-markets.mjs";
import { startCurrency, refreshCurrency, receiveCurrency, currencyPrices } from "./currency.mjs";
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
import { handleFlipsRequest } from "./flips.mjs";
import { handleToolsRequest } from "./tools.mjs";


// Agony Values server: Roblox item values (MM2, Blade Ball, Adopt Me, Steal a Brainrot) with
// Eldorado and other marketplaces' prices, the Flip Finder, sniper, alerts and owner tools.
// (The original Roblox limiteds tracker that this file started as has been removed.)
const PORT = Number(process.env.PORT || 8787);
const SERVER_VERSION = "agony-values-2";

function sendJson(res, status, body) {
  // Big answers (the Flip Finder's is several MB) go out gzipped when the browser accepts it.
  const text = JSON.stringify(body);
  if (text.length > 20000 && /gzip/.test(res.req?.headers?.["accept-encoding"] || "")) {
    res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    return res.end(gzipSync(text, { level: 6 }));
  }
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}


const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  try {
    // Phone app: installable (manifest + service worker + icons) with push notifications
    const STATIC = { "/sw.js": ["sw.js", "text/javascript"], "/app.js": ["app.js", "text/javascript"], "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"] };
    const icon = /^\/icons\/([a-z0-9-]+\.png)$/.exec(parsedUrl.pathname);
    if (STATIC[parsedUrl.pathname] || icon) {
      const [file, type] = STATIC[parsedUrl.pathname] || [`icons/${icon[1]}`, "image/png"];
      try {
        const body = await readStatic(new URL(file, import.meta.url));
        res.writeHead(200, { "Content-Type": type, "Cache-Control": icon ? "public, max-age=604800" : "no-cache", ...(file === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}) });
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
  await new Promise(resolve => setTimeout(resolve, 5000));
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
