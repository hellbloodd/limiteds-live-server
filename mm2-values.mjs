// MM2 weapon values tracker — scrapes Supreme Values, keeps a value history on disk,
// and serves /api/mm2, /api/mm2/history and the /mm2 web page.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";

const SV_ORIGIN = "https://supremevalues.com";
const SV_BASE = `${SV_ORIGIN}/mm2`;
// Weapon categories only (pets, sets and misc are skipped).
const MM2_CATEGORIES = ["ancients", "godlies", "chromas", "uniques", "vintages", "evos", "legendaries", "rares", "uncommons", "commons"];
const MM2_REFRESH_MS = 15 * 60 * 1000;
const MM2_HISTORY_FILE = join(dirname(fileURLToPath(import.meta.url)), "mm2-history.json");
const MM2_HISTORY_MAX_POINTS = 500;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

let mm2Items = [];
let mm2UpdatedAt = 0;
let mm2Refreshing = null;
let mm2History = {}; // { itemKey: [[timestamp, value], ...] }
let mm2HistoryLoaded = false;

function decodeHtml(text) {
  return text.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function parseNumber(text) {
  const n = Number(String(text || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pick(block, re) {
  const m = block.match(re);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, "")) : "";
}

export function parseCategoryPage(html, category) {
  const items = [];
  const chunks = html.split('<div class="itemcell"').slice(1);
  for (const chunk of chunks) {
    const id = pick(chunk, /^\s*id="([^"]*)"/);
    const name = pick(chunk, /class="itemhead">([\s\S]*?)<\/div>/);
    if (!name) continue;
    const image = pick(chunk, /<img class="itemimage" src="([^"]+)"/);
    const changeText = pick(chunk, /Change in Value - \(<b[^>]*>([^<]*)<\/b>/);
    items.push({
      key: `${category}:${id || name}`,
      name,
      category,
      value: parseNumber(pick(chunk, /class="itemvalue[^"]*">([^<]*)</)),
      range: pick(chunk, /class="itemrange">([^<]*)</),
      stability: pick(chunk, /class="itemstability[^"]*">([^<]*)</),
      demand: parseNumber(pick(chunk, /Demand - <b>([^<]*)</)),
      rarity: parseNumber(pick(chunk, /Rarity - <b>([^<]*)</)),
      origin: pick(chunk, /class="itemorigin">([^<]*)</),
      change: parseNumber(changeText),
      changePct: pick(chunk, /class="sv-pctchange[^"]*">([^<]*)</),
      image: image && image.startsWith("/media/") ? `/api/mm2/image?path=${encodeURIComponent(image)}` : "",
      sourceUrl: `${SV_BASE}/${category}?item=${encodeURIComponent(id || name)}`,
    });
  }
  return items;
}

// Uses curl (built into Windows 10+) because Cloudflare on Supreme Values blocks Node's own HTTP clients.
function curlGet(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sSL", "--fail", "--max-time", "30", "-A", UA,
      "-H", "Accept: text/html,application/xhtml+xml,image/webp,*/*", "-H", "Accept-Language: en-US,en;q=0.9", url],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true, encoding: binary ? "buffer" : "utf8" },
    (error, stdout, stderr) => (error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(stdout)));
  });
}

const mm2ImageCache = new Map(); // path -> Promise<Buffer>

async function fetchCategory(category) {
  return parseCategoryPage(await curlGet(`${SV_BASE}/${category}`), category);
}

async function loadHistory() {
  if (mm2HistoryLoaded) return;
  mm2HistoryLoaded = true;
  try { mm2History = JSON.parse(await readFile(MM2_HISTORY_FILE, "utf8")); }
  catch { mm2History = {}; }
}

async function recordHistory(items, now) {
  let changed = false;
  for (const item of items) {
    if (item.value == null) continue;
    const points = mm2History[item.key] || (mm2History[item.key] = []);
    const last = points[points.length - 1];
    if (!last || last[1] !== item.value) {
      points.push([now, item.value]);
      if (points.length > MM2_HISTORY_MAX_POINTS) points.splice(0, points.length - MM2_HISTORY_MAX_POINTS);
      changed = true;
    }
  }
  if (changed) await writeFile(MM2_HISTORY_FILE, JSON.stringify(mm2History));
}

export function refreshMm2Values() {
  if (mm2Refreshing) return mm2Refreshing;
  mm2Refreshing = (async () => {
    await loadHistory();
    const results = await Promise.allSettled(MM2_CATEGORIES.map(fetchCategory));
    const items = [];
    const errors = [];
    results.forEach((r, i) => (r.status === "fulfilled" ? items.push(...r.value) : errors.push(`${MM2_CATEGORIES[i]}: ${r.reason.message}`)));
    if (errors.length) console.warn(`MM2 refresh errors: ${errors.join("; ")}`);
    if (items.length) {
      const now = Date.now();
      await recordHistory(items, now);
      mm2Items = items;
      mm2UpdatedAt = now;
      console.log(`MM2 values refreshed: ${items.length} weapons.`);
    }
    return { items: mm2Items, errors };
  })().finally(() => { mm2Refreshing = null; });
  return mm2Refreshing;
}

export function startMm2Tracker() {
  refreshMm2Values().catch((e) => console.warn(`MM2 refresh failed: ${e.message}`));
  setInterval(() => refreshMm2Values().catch((e) => console.warn(`MM2 refresh failed: ${e.message}`)), MM2_REFRESH_MS).unref();
}

// Returns true if the request was handled.
export async function handleMm2Request(url, res, sendJson) {
  if (url.pathname === "/mm2" || url.pathname === "/mm2/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(join(dirname(fileURLToPath(import.meta.url)), "mm2.html"), "utf8"));
    return true;
  }
  if (url.pathname === "/api/mm2") {
    if (!mm2Items.length) await refreshMm2Values();
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const category = url.searchParams.get("category") || "";
    const items = mm2Items.filter((it) => (!q || it.name.toLowerCase().includes(q)) && (!category || it.category === category));
    sendJson(res, 200, { updatedAt: new Date(mm2UpdatedAt).toISOString(), source: "supremevalues.com", count: items.length, categories: MM2_CATEGORIES, items });
    return true;
  }
  if (url.pathname === "/api/mm2/image") {
    const path = url.searchParams.get("path") || "";
    if (!/^\/media\/[\w\-\/%.]+\.(webp|png|jpe?g|gif)$/i.test(path) || path.includes("..")) {
      sendJson(res, 400, { error: "Bad image path" });
      return true;
    }
    if (!mm2ImageCache.has(path)) {
      mm2ImageCache.set(path, curlGet(SV_ORIGIN + path, { binary: true }).catch((e) => { mm2ImageCache.delete(path); throw e; }));
    }
    try {
      const buf = await mm2ImageCache.get(path);
      const ext = path.split(".").pop().toLowerCase();
      res.writeHead(200, { "Content-Type": `image/${ext === "jpg" ? "jpeg" : ext}`, "Cache-Control": "public, max-age=86400" });
      res.end(buf);
    } catch {
      sendJson(res, 404, { error: "Image not found" });
    }
    return true;
  }
  if (url.pathname === "/api/mm2/history") {
    await loadHistory();
    const key = url.searchParams.get("key") || "";
    sendJson(res, 200, { key, points: mm2History[key] || [] });
    return true;
  }
  return false;
}
