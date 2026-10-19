// Season tracker: which MM2 items belong to Halloween / Christmas (mm2values.com's "Display:
// Halloween / Xmas" views), refreshed every 6 hours, plus their value and price trends so you can
// time buying before an event and selling during it.
import { curlGet } from "./mm2-values.mjs";

const PAGES = ["ancient", "godly", "chroma", "unique", "vintage", "legend", "rare", "uncommon", "common"];
const EVENTS = { Halloween: { disp: "hallow", month: 9, day: 31 }, Christmas: { disp: "xmas", month: 11, day: 25 } };
const EVERY_MS = 6 * 3600 * 1000;
let tags = { at: 0, names: {} }; // names[event] = Set of lowercase names

async function refreshTags() {
  const names = {};
  for (const [event, { disp }] of Object.entries(EVENTS)) {
    const set = new Set();
    for (const p of PAGES) {
      try {
        const html = await curlGet(`https://www.mm2values.com/?p=${p}&f=&wDisp=${disp}`);
        for (const m of html.matchAll(/<b>([^<]{2,60})<\/b><br>\s*Value:/g)) set.add(m[1].trim().toLowerCase());
      } catch { /* skip this page this time */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (set.size) names[event] = set;
  }
  if (Object.keys(names).length) tags = { at: Date.now(), names };
}

const nextDate = ({ month, day }) => {
  const now = new Date(), y = now.getUTCFullYear();
  let d = Date.UTC(y, month, day);
  if (d < Date.now() - 864e5) d = Date.UTC(y + 1, month, day);
  return d;
};

// items: the MM2 page's items (with changes / priceChanges / usd)
export function seasonsReport(items) {
  const events = [];
  for (const [event, cfg] of Object.entries(EVENTS)) {
    const set = tags.names[event];
    if (!set) continue;
    const list = items.filter((i) => set.has(i.name.toLowerCase())).map((i) => ({
      key: i.key, name: i.name, image: i.image, category: i.category, value: i.value, valueText: i.valueText || "", usd: i.usd ?? null, listings: i.listings ?? null,
      v7: i.changes?.["7d"]?.pct ?? null, v30: i.changes?.["30d"]?.pct ?? null, v1y: i.changes?.["1y"]?.pct ?? null, p7: i.priceChanges?.["7d"]?.pct ?? null, p30: i.priceChanges?.["30d"]?.pct ?? null,
    })).sort((a, b) => (b.value || 0) - (a.value || 0));
    const avg = (k) => { const v = list.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    const date = nextDate(cfg);
    events.push({ event, date: new Date(date).toISOString(), daysAway: Math.ceil((date - Date.now()) / 864e5), count: list.length,
      avg: { v7: avg("v7"), v30: avg("v30"), v1y: avg("v1y"), p7: avg("p7"), p30: avg("p30") }, items: list });
  }
  return { updatedAt: tags.at ? new Date(tags.at).toISOString() : null, events: events.sort((a, b) => a.daysAway - b.daysAway) };
}

export function startSeasons() {
  setTimeout(() => refreshTags().catch(() => {}), 90 * 1000).unref();
  setInterval(() => refreshTags().catch(() => {}), EVERY_MS).unref();
}
