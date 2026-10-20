// Event calendar: game updates and events the owner adds (name, game, date, note), stored in Supabase
// row "calendar_events", plus the MM2 Halloween / Christmas dates the season tracker already knows.
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";
import { robloxEvents } from "./roblox-events.mjs";

let events = null;
const load = async () => (events ||= (supabaseConfig() ? await readRow("calendar_events").catch(() => null) : null) || []);
const save = () => (supabaseConfig() ? writeMm2Row("calendar_events", events) : Promise.resolve());
const GAMES = ["MM2", "Blade Ball", "Adopt Me", "Steal a Brainrot", "Other"];
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

// seasons: the season tracker's report ({ events: [{ event, date, count }] })
export async function listEvents(seasons) {
  await load();
  const rbx = robloxEvents();
  // season dates only when Roblox has no event for them yet
  const auto = (seasons?.events || []).filter((e) => e.source !== "roblox").map((e) => ({ id: `auto-${e.event}`, game: "MM2", title: `${e.event} event (usual date)`, date: e.date,
    note: `${e.count} ${e.event} items tracked — see Seasons for how they move before and during the event.`, link: "/seasons", auto: true }));
  const fromRoblox = rbx.events.map((e) => ({ ...e, auto: true }));
  return { events: [...events, ...fromRoblox, ...auto].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)), games: rbx.games, checkedAt: rbx.at ? new Date(rbx.at).toISOString() : null };
}

export async function addEvent(body) {
  await load();
  const date = new Date(body.date);
  if (!clean(body.title, 1) || isNaN(date)) throw new Error("A title and a valid date are needed.");
  const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), game: GAMES.includes(body.game) ? body.game : "Other",
    title: clean(body.title, 80), date: date.toISOString(), end: body.end && !isNaN(new Date(body.end)) ? new Date(body.end).toISOString() : null,
    note: clean(body.note, 300), link: /^https?:\/\//.test(body.link || "") ? clean(body.link, 300) : "" };
  events.push(e);
  if (events.length > 300) events.splice(0, events.length - 300);
  await save();
  return e;
}

export async function deleteEvent(id) {
  await load();
  const n = events.length;
  events = events.filter((e) => e.id !== id);
  if (events.length !== n) await save();
}
