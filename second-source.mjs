// Second value source per game, so a value isn't taken from one site alone:
//   MM2, Adopt Me, Steal a Brainrot: game.guide's value lists (public JSON)
//   Blade Ball: robloxtools.net (its top-tier list; game.guide has no Blade Ball list)
// Every site uses its own scale, so theirs is converted to ours with the median ratio over the items
// both list. Each matched item gets its second value (in our units) and how far the two disagree.
// Refreshed every 6 hours; kept as a warm snapshot for restarts.
import { allItems } from "./tools.mjs";
import { curlGet } from "./mm2-values.mjs";
import { loadWarm, saveWarm } from "./warm-store.mjs";

const UA = { "user-agent": "Mozilla/5.0 (compatible; AgonyValues/1.0)", accept: "application/json,text/html" };
const SOURCES = {
  "MM2": { name: "game.guide", url: "https://www.game.guide/mm2-value-list", api: "https://www.game.guide/api/value-list/mm2" },
  "Adopt Me": { name: "game.guide", url: "https://www.game.guide/adopt-me-value-list", api: "https://www.game.guide/api/value-list/adopt-me" },
  "Steal a Brainrot": { name: "game.guide", url: "https://www.game.guide/steal-a-brainrot-value-list", api: "https://www.game.guide/api/value-list/steal-a-brainrot" },
  "Blade Ball": { name: "robloxtools.net", url: "https://www.robloxtools.net/values/blade-ball", html: true },
};
let state = { at: 0, games: {} };

// "Cane 2018 (Knife)", "Cane Knife (2018)", "C. Luger" -> the same key: words sorted, punctuation gone
const norm = (s) => String(s || "").toLowerCase().replace(/^c\.\s*/, "chroma ").replace(/['’]/g, "")
  .split(/[^a-z0-9]+/).filter(Boolean).sort().join(" ");
const num = (t) => { const m = String(t).replace(/,/g, "").match(/([\d.]+)\s*([kmb])?/i); if (!m) return null; return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1); };

// fetch, one retry, then curl (a browser-like request some sites accept when they refuse plain fetch)
async function getText(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
      if (r.ok) return await r.text();
      last = new Error(`${new URL(url).hostname} ${r.status}`);
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 5000));
  }
  try { return await curlGet(url, ["Accept: application/json,text/html"]); }
  catch (e) { throw new Error(`${last?.message || "fetch failed"}; curl: ${e.message.slice(0, 80)}`); }
}

async function fetchTheirs(game) {
  const src = SOURCES[game];
  const body = await getText(src.api || src.url);
  if (src.html) { // robloxtools: cards of name + "Value" + number
    const h = body;
    return [...h.matchAll(/href="\/values\/blade-ball\/[a-z0-9-]+"[\s\S]*?alt="([^"]+)"[\s\S]*?Value<\/span><span[^>]*>([^<]+)</g)]
      .map((m) => ({ name: m[1].replace(/&amp;/g, "&").replace(/&#x27;/g, "'"), value: num(m[2]) })).filter((x) => x.value > 0);
  }
  const j = JSON.parse(body);
  return (j.items || []).map((i) => {
    if (game === "Adopt Me") { const v = i.values || {}; return { name: i.name, value: v.fr ?? v.normal ?? Object.values(v).find((x) => x > 0) ?? null, fr: v.fr ?? null }; }
    return { name: i.name, value: i.value };
  }).filter((x) => x.value > 0);
}

async function refreshGame(game, ours) {
  const theirs = await fetchTheirs(game);
  const byKey = new Map();
  for (const t of theirs) { const k = norm(t.name); byKey.set(k, byKey.has(k) ? null : t); } // same key twice: ambiguous, skip
  const pairs = [];
  for (const i of ours) {
    if (i.valueText) continue;
    const t = byKey.get(norm(i.name));
    if (!t) continue;
    const mine = game === "Adopt Me" && t.fr != null && i.vals?.fr ? i.vals.fr : i.value;
    const their = game === "Adopt Me" && t.fr != null && i.vals?.fr ? t.fr : t.value;
    if (mine > 0 && their > 0) pairs.push({ key: i.key, mine, their });
  }
  if (pairs.length < 10) throw new Error(`only ${pairs.length} items matched`);
  // scale: median of log(ours / theirs)
  const logs = pairs.map((p) => Math.log(p.mine / p.their)).sort((a, b) => a - b);
  const scale = Math.exp(logs[logs.length >> 1]);
  const items = {};
  for (const p of pairs) {
    const v2 = p.their * scale;
    items[p.key] = [Number(v2.toPrecision(4)), Math.round((v2 / p.mine - 1) * 100)];
  }
  const diffs = Object.values(items).map((x) => Math.abs(x[1])).sort((a, b) => a - b);
  return { source: SOURCES[game].name, url: SOURCES[game].url, at: new Date().toISOString(), matched: pairs.length, theirs: theirs.length, ours: ours.length,
    scale, medianGap: diffs[diffs.length >> 1], items };
}

async function refresh(port) {
  const all = await allItems(port);
  if (!all.length) return;
  for (const game of Object.keys(SOURCES)) {
    try { state.games[game] = await refreshGame(game, all.filter((i) => i.game === game)); }
    catch (e) { console.warn(`Second value source for ${game}: ${e.message}`); }
  }
  state.at = Date.now();
  saveWarm("second_values", state, 0);
}

// { source, url, at, matched, medianGap, items: { key: [valueInOurUnits, diffPct] } } or null
export const secondValues = (game) => state.games[game] || null;

export async function startSecondValues(port) {
  const saved = await loadWarm("second_values", 3 * 864e5);
  if (saved?.games && !state.at) state = saved;
  setTimeout(() => refresh(port).catch(() => {}), 3 * 60e3).unref();
  setInterval(() => refresh(port).catch(() => {}), 6 * 3600e3).unref();
}
