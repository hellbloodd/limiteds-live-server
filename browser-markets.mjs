// Runs on the PC booster: reads GameBoost and Itemku in a hidden Chrome (both sit behind a
// Cloudflare browser check that plain requests can't pass), matches each listing to our items by
// title, and returns the cheapest price per item. Needs Google Chrome or Edge installed.
import { existsSync } from "node:fs";
import { nameIndex, matchTitle, amCode, words, robustMin, listingHasFinisher, finKey } from "./markets.mjs";

const BROWSERS = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const GAMEBOOST = { "MM2": "murder-mystery-2", "Adopt Me": "adopt-me", "Blade Ball": "blade-ball" };
const ITEMKU = { "MM2": "murder-mystery-2/weapon", "Adopt Me": "adopt-me/pet", "Blade Ball": "blade-ball-roblox/limited-swords", "Steal a Brainrot": "steal-a-brainrot/item" };
const GB_MAX_PAGES = Number(process.env.GAMEBOOST_MAX_PAGES || 20);  // up to 250 cheapest-first listings a page (it rate-limits past ~25-50 quick pages)
const IK_MAX_PAGES = Number(process.env.ITEMKU_MAX_PAGES || 40);    // 32 listings a page

function add(out, game, title, usd, extra, index) {
  const name = usd > 0 && matchTitle(title, index);
  if (!name) return;
  let id = words(name);
  if (game === "Adopt Me") { const code = amCode(title); if (!code) return; id += `|${code}`; }
  if (game === "Blade Ball") id = finKey(id, listingHasFinisher(title));
  (out[id] ||= { all: [] }).all.push({ usd, ...extra });
}
// each item: the cheapest believable price (not a lone fake far under the rest)
function finish(out) {
  for (const [id, o] of Object.entries(out)) {
    const usd = robustMin(o.all.map((x) => x.usd));
    const { usd: _u, ...extra } = o.all.find((x) => x.usd === usd) || {};
    out[id] = { usd: Math.round(usd * 100) / 100, offers: o.all.length, ...extra };
  }
  return out;
}

async function gameboost(page, game, index, log) {
  const out = {};
  // a fresh session per game: GameBoost refuses the first data request of a new game otherwise
  await page.context().clearCookies().catch(() => {});
  await page.goto(`https://gameboost.com/${GAMEBOOST[game]}/items`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  let retried = false;
  for (let p = 1; p <= GB_MAX_PAGES; p++) {
    const j = await page.evaluate(async (pg) => {
      const s = document.querySelector("script[data-page]");
      const version = s ? JSON.parse(s.textContent).version : "";
      const r = await fetch(`${location.pathname}?sort=price&per_page=250&page=${pg}`, { headers: { "X-Inertia": "true", "X-Inertia-Version": version, "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) return { error: r.status };
      const d = await r.json();
      const rate = d.props.exchange_rates?.eur_to_usd || 1.12;
      return { last: d.props.items.last_page, rows: d.props.items.data.map((x) => [x.title, x.price?.currency?.code === "USD" ? x.price.value : x.price?.value * rate, `${location.origin}${location.pathname}/${x.slug}`]) };
    }, p);
    if (j.error) {
      // Cloudflare slowing us down: wait, re-open the page (passes the check again), retry once
      if (retried) { log(`GameBoost ${game} page ${p}: HTTP ${j.error} - stopping here`); break; }
      log(`GameBoost ${game} page ${p}: HTTP ${j.error} - pausing 90 s`);
      await page.waitForTimeout(90000);
      await page.context().clearCookies().catch(() => {}); // a fresh session passes Cloudflare's check again
      await page.goto(`https://gameboost.com/${GAMEBOOST[game]}/items`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
      retried = true; p--; continue;
    }
    retried = false;
    for (const [title, usd, url] of j.rows) add(out, game, title, usd, { url }, index); // url: that exact listing
    if (p >= j.last) break;
    await page.waitForTimeout(1500); // gentle: stays under GameBoost's rate limit
  }
  return out;
}

const IK_TABS = 3; // Itemku pages read in 3 tabs at once
async function itemkuPage(page, game, p) {
  const r = await page.goto(`https://www.itemku.com/en/g/${ITEMKU[game]}?page=${p}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  if (!r || r.status() >= 400) return null;
  await page.waitForSelector("a[href*='/product/']", { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => [...document.querySelectorAll("a[href*='/product/']")].map((a) => {
    const t = a.innerText.replace(/\s+/g, " ").trim();
    const m = t.match(/(EUR|USD)\s*([\d.,\s]+)/);
    if (!m) return null;
    const price = Number(m[2].replace(/\s/g, "").replace(/,(\d{2})$/, ".$1").replace(/,/g, ""));
    const name = t.slice(0, m.index).replace(/^Ad /, "").replace(/ Wholesale\s*$/, "").trim();
    const rating = Number((t.match(/Sold ([\d.]+)\s*$/) || [])[1]) || null;
    return [name, m[1], price, rating, a.href.split("?")[0]];
  }).filter(Boolean));
}
async function itemku(tabs, game, index, log) {
  const out = {};
  const take = (rows) => { for (const [title, cur, price, rating, url] of rows || []) add(out, game, title, cur === "USD" ? price : price * 1.12, { rating: rating ? rating * 20 : null, url }, index); }; // rating out of 5 -> %
  const first = await itemkuPage(tabs[0], game, 1);
  if (!first?.length) { log(`Itemku ${game}: no listings`); return out; }
  take(first);
  // "Results found: 1 012 products" -> how many pages to read (32 a page); an empty page doesn't stop the rest
  const total = Number((await tabs[0].evaluate(() => (document.body.innerText.match(/Results found:\s*([\d\s.,]+)\s*products/i) || [])[1] || "")).replace(/\D/g, "")) || 0;
  // the shown total undercounts, so read on past it until a few pages come back empty
  const pages = IK_MAX_PAGES;
  const queue = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2);
  let empties = 0;
  await Promise.all(tabs.map(async (tab) => {
    for (let p; (p = queue.shift());) {
      const rows = await itemkuPage(tab, game, p);
      if (!rows?.length) { if (++empties >= 3 && p > Math.ceil(total / 32)) queue.length = 0; continue; } // past the end: stop
      take(rows);
    }
  }));
  return out;
}

// items: { game: [our items] } (from the site's public APIs). Returns { GameBoost: {game: map}, Itemku: {...} }.
export async function scanBrowserMarkets(items, log = console.log) {
  const { chromium } = await import("playwright-core");
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error("Google Chrome or Microsoft Edge is needed for GameBoost / Itemku");
  const browser = await chromium.launch({ executablePath: exe, headless: false,
    args: ["--window-position=-32000,-32000", "--window-size=1200,900", "--disable-blink-features=AutomationControlled", "--mute-audio"] });
  const result = { GameBoost: {}, Itemku: {} };
  try {
    // GameBoost (one tab, paced for its rate limit) and Itemku (3 tabs) run at the same time
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const gbTab = await ctx.newPage();
    const ikTabs = await Promise.all(Array.from({ length: IK_TABS }, () => ctx.newPage()));
    const run = async (market, games, fn, tab) => {
      for (const game of Object.keys(games)) {
        if (!items[game]?.length) continue;
        const t0 = Date.now();
        try {
          result[market][game] = finish(await fn(tab, game, nameIndex(items[game]), log));
          log(`${market} ${game}: ${Object.keys(result[market][game]).length} items in ${Math.round((Date.now() - t0) / 1000)} s`);
        } catch (e) { log(`${market} ${game} failed: ${e.message.slice(0, 120)}`); }
      }
    };
    await Promise.all([run("GameBoost", GAMEBOOST, gameboost, gbTab), run("Itemku", ITEMKU, itemku, ikTabs)]);
  } finally { await browser.close().catch(() => {}); }
  return result;
}

// ---------- Currency (Blade Ball tokens, Robux) ----------
// Per 1,000, in USD. Robux per 1,000 RECEIVED: gamepass offers that don't cover Roblox's 30% tax
// deliver 700 per 1,000 bought. Returns { U7BUY: { robux }, GameBoost: { tokens, robux }, Itemku: { tokens, robux } }.
const EUR_USD = 1.12; // Itemku / U7BUY show EUR; GameBoost gives its own rate
export async function scanCurrency(log = console.log) {
  const { chromium } = await import("playwright-core");
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error("Google Chrome or Microsoft Edge is needed");
  const browser = await chromium.launch({ executablePath: exe, headless: false, args: ["--window-position=-32000,-32000", "--disable-blink-features=AutomationControlled", "--mute-audio"] });
  const out = { U7BUY: {}, GameBoost: {}, Itemku: {} };
  const best = (list, extra = {}) => {
    const v = robustMin(list.map((x) => x.per1k));
    return v ? { ...list.find((x) => x.per1k === v), ...extra, per1k: v } : null;
  };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    // GameBoost: every seller's offer, priced per unit
    for (const [cur, path] of [["robux", "roblox/robux"], ["tokens", "blade-ball/tokens"]]) {
      try {
        await page.context().clearCookies().catch(() => {});
        await page.goto(`https://gameboost.com/${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(4000);
        const offers = await page.evaluate((cur) => {
          const p = JSON.parse(document.querySelector("script[data-page]").textContent).props;
          const rate = p.exchange_rates?.eur_to_usd || 1.12;
          return [p.selectedCurrencyOffer, ...(p.otherSellerOffers || [])].filter(Boolean).map((o) => {
            const unit = (o.price?.currency === "USD" ? o.price.value : o.price?.value * rate);
            const noTax = cur === "robux" && /(not|n't|no)\s+(cover|covered|covering)[^.\n]{0,20}tax|tax[^.\n]{0,25}not\s+covered/i.test(o.description || "");
            return { per1k: unit * 1000 / (noTax ? 0.7 : 1), url: o.store_url, note: noTax ? "tax not covered (price shown per 1,000 received)" : undefined };
          }).filter((x) => x.per1k > 0);
        }, cur);
        out.GameBoost[cur] = best(offers);
        log(`GameBoost ${cur}: ${offers.length} offers`);
      } catch (e) { log(`GameBoost ${cur} failed: ${e.message.slice(0, 80)}`); }
    }
    // Itemku: the package list ("1.000 Token EUR 2.75", "1000 Robux EUR 7.66")
    for (const [cur, path, word] of [["tokens", "blade-ball-roblox/token", "Token"], ["robux", "roblox/robux-via-username", "Robux"]]) {
      try {
        await page.goto(`https://www.itemku.com/en/g/${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(4000);
        const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
        const packs = [...text.matchAll(new RegExp(String.raw`([\d.,]+)\s*${word}s?\s+(EUR|USD)\s*([\d.,]+)`, "gi"))].map((m) => {
          const qty = Number(m[1].replace(/[.,](?=\d{3}\b)/g, ""));
          const price = Number(m[3].replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
          return { qty, per1k: price * (m[2] === "USD" ? 1 : EUR_USD) / qty * 1000 };
        }).filter((x) => x.qty >= 100 && x.per1k > 0);
        const pick = packs.filter((x) => x.qty >= 1000).length ? packs.filter((x) => x.qty >= 1000) : packs;
        const v = pick.length ? Math.min(...pick.map((x) => x.per1k)) : null;
        if (v) out.Itemku[cur] = { per1k: v, url: page.url(), note: cur === "robux" ? "gift via username" : `${pick.find((x) => x.per1k === v).qty} pack` };
        log(`Itemku ${cur}: ${packs.length} packages`);
      } catch (e) { log(`Itemku ${cur} failed: ${e.message.slice(0, 80)}`); }
    }
    // U7BUY: Robux packages (bought vs received after tax)
    try {
      await page.goto("https://www.u7buy.com/roblox/roblox-robux", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
      const packs = await page.evaluate(() => {
        const find = (o, d = 0) => { if (!o || typeof o !== "object" || d > 7) return null; if (Array.isArray(o) && o.some((x) => x?.faceValue && x?.price)) return o; for (const v of Object.values(o)) { const r = find(v, d + 1); if (r) return r; } return null; };
        return (find(useNuxtApp().payload.data) || []).map((x) => ({ price: Number(x.price), received: Number(x.receiveCounts) || Number(x.buyCounts), bought: Number(x.buyCounts) }));
      });
      const list = packs.filter((x) => x.price > 0 && x.received > 0).map((x) => ({ per1k: x.price * EUR_USD / x.received * 1000, url: "https://www.u7buy.com/roblox/roblox-robux",
        note: x.received < x.bought ? "gamepass, tax not covered (per 1,000 received)" : "tax covered" }));
      out.U7BUY.robux = list.length ? list.reduce((a, b) => (b.per1k < a.per1k ? b : a)) : null;
      log(`U7BUY robux: ${packs.length} packages`);
    } catch (e) { log(`U7BUY robux failed: ${e.message.slice(0, 80)}`); }
  } finally { await browser.close().catch(() => {}); }
  for (const m of Object.keys(out)) for (const c of Object.keys(out[m])) if (out[m][c]) out[m][c].per1k = Math.round(out[m][c].per1k * 100) / 100;
  return out;
}
