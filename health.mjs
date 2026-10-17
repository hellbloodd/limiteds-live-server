// Failure alerts (Discord only): every 5 minutes, check that each game's values and Eldorado prices
// are fresh and that the sniper is still checking. Each problem is posted once when it starts and
// once when it's fixed - no repeats while it lasts.
import { post } from "./deals.mjs";

const EVERY_MS = 5 * 60 * 1000;
const START_TIME = Date.now();
const GRACE_MS = 20 * 60 * 1000;        // after a restart, give everything time to run once
const PRICES_STALE_MS = Number(process.env.ALERT_PRICES_STALE_MIN || 30) * 60 * 1000;
const VALUES_STALE_MS = Number(process.env.ALERT_VALUES_STALE_MIN || 60) * 60 * 1000;
const GAMES = ["MM2", "Blade Ball", "Adopt Me", "Steal a Brainrot"];
const open = new Map(); // problem id -> { since, title }

const ago = (ms) => (ms < 90 * 60 * 1000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
const t = (iso) => Date.parse(iso || "") || 0;

export function findProblems({ updater, sniper, errors }, STARTED = START_TIME) {
  const now = Date.now(), out = [];
  const errFor = (game) => errors.find((e) => e.includes(game) && /fail|error|unavailable|took over/i.test(e)) || null;
  for (const game of GAMES) {
    const p = updater.prices?.[game] || {};
    const lastPrices = Math.max(t(p.okAt), STARTED);
    if (now - lastPrices > PRICES_STALE_MS && !(updater.running?.[game] && now - t(p.startedAt) < PRICES_STALE_MS)) {
      out.push({ id: `prices:${game}`, fixed: `${game} Eldorado prices are refreshing again`, title: `${game}: Eldorado prices are ${ago(now - lastPrices)} old`,
        detail: p.error ? `Last error: ${p.error}` : errFor(game) || (p.startedAt ? `Refresh started ${ago(now - t(p.startedAt))} ago and hasn't finished.` : "No refresh has finished since the server started.") });
    }
    const v = updater.values?.[game] || {};
    const lastValues = Math.max(t(v.lastOkAt), STARTED);
    if (now - lastValues > VALUES_STALE_MS) {
      out.push({ id: `values:${game}`, fixed: `${game} values are updating again`, title: `${game}: values haven't updated for ${ago(now - lastValues)}`,
        detail: (v.timedOut ? "The value update timed out. " : "") + (errFor(game) || "The values site may be down or blocking the server.") + " Prices keep refreshing from the last saved values." });
    }
  }
  if (sniper && sniper.hotItems > 0 && now - Math.max(sniper.lastCheckAt || 0, STARTED) > 10 * 60 * 1000) {
    out.push({ id: "sniper", fixed: "Sniper is checking listings again", title: "Sniper has stopped checking listings", detail: `No listing checked for ${ago(now - Math.max(sniper.lastCheckAt || 0, STARTED))} - new listings aren't being watched.` });
  }
  return out;
}

async function send(color, title, description) {
  await post({ username: "Agony Values status", embeds: [{ title, description, color, timestamp: new Date().toISOString(),
    footer: { text: "Live status: /api/status" } }] }).catch(() => {});
}

// getState(): { updater, sniper, errors } - passed in by the server so this file stays independent.
export function startHealthAlerts(getState) {
  setInterval(async () => {
    if (Date.now() - START_TIME < GRACE_MS) return;
    let problems;
    try { problems = findProblems(getState()); } catch { return; }
    const now = new Set(problems.map((p) => p.id));
    for (const p of problems) {
      if (open.has(p.id)) continue;
      open.set(p.id, { since: Date.now(), fixed: p.fixed });
      await send(0xef4444, `🚨 ${p.title}`, p.detail);
    }
    for (const [id, o] of open) {
      if (now.has(id)) continue;
      open.delete(id);
      await send(0x22c55e, `✅ ${o.fixed}`, `The problem lasted ${ago(Date.now() - o.since)}.`);
    }
  }, EVERY_MS).unref();
}
