// Game events straight from Roblox: each game's official Roblox Events (start / end times, set by the
// developers) and its game page (an event tag in the name like "[🎃]", the description, last update).
// Read every 2 hours; feeds the Calendar and the Seasons countdowns (MM2 Halloween / Christmas).
import { loadWarm, saveWarm } from "./warm-store.mjs";

export const UNIVERSES = { "MM2": 66654135, "Adopt Me": 383310974, "Blade Ball": 4777817887, "Steal a Brainrot": 7709344486 };
const PLACES = { "MM2": 142823291, "Adopt Me": 920587237, "Blade Ball": 13772394625, "Steal a Brainrot": 109983668079237 };
const EVERY_MS = 2 * 3600e3;
let state = { at: 0, events: [], games: {} };

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Roblox ${r.status}`);
  return r.json();
};

// Small recurring things (Adopt Me's weekly "2x Tuesday" / "Admin Abuse") vs real updates and events.
const isMinor = (e) => /2d tuesday|admin abuse|double xp|2x /i.test(`${e.title} ${e.subtitle}`)
  || (e.end && Date.parse(e.end) - Date.parse(e.date) <= 2 * 3600e3 && !/launch|update|event/i.test(e.subtitle || ""));

async function refresh() {
  const events = [], games = {};
  for (const [game, u] of Object.entries(UNIVERSES)) {
    try {
      let cursor = "", pages = 0;
      do {
        const r = await getJson(`https://apis.roblox.com/virtual-events/v1/universes/${u}/virtual-events?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const e of r.data || []) {
          const start = e.eventTime?.startUtc, end = e.eventTime?.endUtc || null;
          if (!start || Date.parse(end || start) < Date.now() - 60 * 864e5) continue; // the last 2 months and everything upcoming
          const ev = { id: `rbx-${e.id}`, game, title: e.title || e.displayTitle || "Event", subtitle: e.subtitle || "", note: String(e.description || "").trim().slice(0, 400),
            date: new Date(start).toISOString(), end: end ? new Date(end).toISOString() : null, link: `https://www.roblox.com/events/${e.id}`, source: "roblox" };
          ev.minor = isMinor(ev);
          events.push(ev);
        }
        cursor = r.nextPageCursor; pages++;
      } while (cursor && pages < 15);
    } catch (e) { console.warn(`Roblox events for ${game}: ${e.message}`); }
  }
  try {
    const r = await getJson(`https://games.roblox.com/v1/games?universeIds=${Object.values(UNIVERSES).join(",")}`);
    for (const g of r.data || []) {
      const game = Object.keys(UNIVERSES).find((k) => UNIVERSES[k] === g.id);
      if (!game) continue;
      const tag = (String(g.name).match(/^\s*\[([^\]]{1,24})\]/) || [])[1] || "";
      // description lines that look like an event / update announcement
      const lines = String(g.description || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const news = lines.filter((l) => /\bevent\b|\bupdate\b|halloween|christmas|winter|easter|summer|spring|week \d/i.test(l) && l.length < 160).slice(0, 4);
      games[game] = { name: g.name, tag, updated: g.updated, playing: g.playing, news, url: `https://www.roblox.com/games/${PLACES[game]}` };
    }
  } catch (e) { console.warn(`Roblox game pages: ${e.message}`); }
  if (events.length || Object.keys(games).length) {
    state = { at: Date.now(), events: events.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)), games: Object.keys(games).length ? games : state.games };
    saveWarm("roblox_events", state, 0);
  }
}

export const robloxEvents = () => state;

// The current or next event of a game whose title matches `re` (e.g. MM2 /hallow/i), or null.
export function eventWindow(game, re) {
  const now = Date.now();
  return state.events.filter((e) => e.game === game && re.test(`${e.title} ${e.subtitle}`) && Date.parse(e.end || e.date) >= now)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0] || null;
}

export async function startRobloxEvents() {
  const saved = await loadWarm("roblox_events", 3 * 864e5);
  if (saved?.events && !state.at) state = saved;
  setTimeout(() => refresh().catch(() => {}), 20 * 1000).unref();
  setInterval(() => refresh().catch(() => {}), EVERY_MS).unref();
}
