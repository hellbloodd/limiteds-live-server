// One-off: switch MM2 from Supreme Values to mm2values.com without losing the charts.
// Matches each mm2values.com item to the old Supreme Values item by name and copies its history,
// scaled so the last old point lines up with mm2values.com's current value (percent changes are kept).
// Run once on the home PC: node mm2-migrate-mv.mjs   (needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
import { scrapeMm2Values, readMm2State, writeChangedRows, mergeMm2History } from "./mm2-values.mjs";

const norm = (name) => name.toLowerCase()
  .replace(/^(chroma|c\.)\s+/, "chroma ")
  .replace(/['’]/g, "")
  .replace(/\((gun|knife)\)/g, "$1")
  .replace(/[^a-z0-9]+/g, " ").trim();

const old = await readMm2State("", ["latest", "history"]);
if (old.latest?.source === "mm2values.com") { console.log("Already migrated."); process.exit(0); }
const oldByName = new Map((old.latest?.items || []).map((it) => [norm(it.name), it]));
const { items } = await scrapeMm2Values();

const history = {};
let carried = 0;
for (const it of items) {
  const prev = oldByName.get(norm(it.name));
  const points = (prev && old.history[prev.key] || []).filter(([, v]) => v >= 1);
  if (points.length) {
    const scale = it.value / points[points.length - 1][1];
    history[it.key] = points.map(([t, v]) => [t, Math.round(v * scale * 100) / 100]);
    carried++;
  }
}
const now = Date.now();
mergeMm2History(history, items, now);
await writeChangedRows("", {
  latest: { items, source: "mm2values.com" },
  history,
  history_fetched: {},
  heartbeat: { updatedAt: new Date(now).toISOString() },
});
console.log(`Switched to mm2values.com: ${items.length} items, history carried over for ${carried}.`);
