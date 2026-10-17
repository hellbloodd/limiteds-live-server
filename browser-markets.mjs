// Runs on the PC booster: reads GameBoost and Itemku in a hidden Chrome (both sit behind a
// Cloudflare browser check that plain requests can't pass), matches each listing to our items by
// title, and returns the cheapest price per item. Needs Google Chrome or Edge installed.
import { existsSync } from "node:fs";
import { nameIndex, matchTitle, amCode, words, robustMin, listingHasFinisher, finKey } from "./markets.mjs";

const BROWSERS = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const GAMEBOOST = { "MM2": "murder-mystery-2", "Adopt Me": "adopt-me", "Blade Ball": "blade-ball" };
const ITEMKU = { "MM2": "murder-mystery-2/weapon", "Adopt Me": "adopt-me/pet", "Blade Ball": "blade-ball-roblox/limited-swords", "Steal a Brainrot": "steal-a-brainrot/item" };
const GB_MAX_PAGES = Number(process.env.GAMEBOOST_MAX_PAGES || 40);  // 100 cheapest-first listings a page (it rate-limits past ~50 quick pages)
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
  await page.goto(`https://gameboost.com/${GAMEBOOST[game]}/items`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  let retried = false;
  for (let p = 1; p <= GB_MAX_PAGES; p++) {
    const j = await page.evaluate(async (pg) => {
      const s = document.querySelector("script[data-page]");
      const version = s ? JSON.parse(s.textContent).version : "";
      const r = await fetch(`${location.pathname}?sort=price&per_page=100&page=${pg}`, { headers: { "X-Inertia": "true", "X-Inertia-Version": version, "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) return { error: r.status };
      const d = await r.json();
      const rate = d.props.exchange_rates?.eur_to_usd || 1.12;
      return { last: d.props.items.last_page, rows: d.props.items.data.map((x) => [x.title, x.price?.currency?.code === "USD" ? x.price.value : x.price?.value * rate, `${location.origin}${location.pathname}/${x.slug}`]) };
    }, p);
    if (j.error) {
      // Cloudflare slowing us down: wait, re-open the page (passes the check again), retry once
      if (retried) { log(`GameBoost ${game} page ${p}: HTTP ${j.error} - stopping here`); break; }
      log(`GameBoost ${game} page ${p}: HTTP ${j.error} - pausing 60 s`);
      await page.waitForTimeout(60000);
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

async function itemku(page, game, index, log) {
  const out = {};
  for (let p = 1; p <= IK_MAX_PAGES; p++) {
    const r = await page.goto(`https://www.itemku.com/en/g/${ITEMKU[game]}?page=${p}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    if (!r || r.status() >= 400) { if (p === 1) log(`Itemku ${game}: HTTP ${r?.status()}`); break; }
    await page.waitForSelector("a[href*='/product/']", { timeout: 15000 }).catch(() => {});
    const rows = await page.evaluate(() => [...document.querySelectorAll("a[href*='/product/']")].map((a) => {
      const t = a.innerText.replace(/\s+/g, " ").trim();
      const m = t.match(/(EUR|USD)\s*([\d.,\s]+)/);
      if (!m) return null;
      const price = Number(m[2].replace(/\s/g, "").replace(/,(\d{2})$/, ".$1").replace(/,/g, ""));
      const name = t.slice(0, m.index).replace(/^Ad /, "").replace(/ Wholesale\s*$/, "").trim();
      const rating = Number((t.match(/Sold ([\d.]+)\s*$/) || [])[1]) || null;
      return [name, m[1], price, rating, a.href.split("?")[0]];
    }).filter(Boolean));
    if (!rows.length) break;
    for (const [title, cur, price, rating, url] of rows) add(out, game, title, cur === "USD" ? price : price * 1.12, { rating: rating ? rating * 20 : null, url }, index); // rating out of 5 -> %
    await page.waitForTimeout(800);
  }
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
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    for (const [market, games, fn] of [["GameBoost", GAMEBOOST, gameboost], ["Itemku", ITEMKU, itemku]]) {
      for (const game of Object.keys(games)) {
        if (!items[game]?.length) continue;
        const t0 = Date.now();
        try {
          result[market][game] = finish(await fn(page, game, nameIndex(items[game]), log));
          log(`${market} ${game}: ${Object.keys(result[market][game]).length} items in ${Math.round((Date.now() - t0) / 1000)} s`);
        } catch (e) { log(`${market} ${game} failed: ${e.message.slice(0, 120)}`); }
      }
    }
  } finally { await browser.close().catch(() => {}); }
  return result;
}
