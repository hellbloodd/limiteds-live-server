// Warm-start snapshots: the expensive in-memory lists (all items, Flip Finder, dashboard, season tags)
// are saved to Supabase now and then, gzipped, so after a restart the site answers at once from the
// last snapshot while fresh ones are rebuilt in the background (instead of ~3 minutes of slow pages).
import { gzipSync, gunzipSync } from "node:zlib";
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";

const lastSave = {};

// The snapshot saved as `id`, or null if there is none or it is older than maxAgeMs.
export async function loadWarm(id, maxAgeMs = 12 * 3600e3) {
  if (!supabaseConfig()) return null;
  try {
    const d = await readRow(`warm_${id}`);
    if (!d?.gz || Date.now() - d.at > maxAgeMs) return null;
    return JSON.parse(gunzipSync(Buffer.from(d.gz, "base64")).toString("utf8"));
  } catch (e) {
    console.warn(`Warm snapshot ${id} not loaded: ${e.message}`);
    return null;
  }
}

// Saves at most once per everyMs per id (fire and forget).
export function saveWarm(id, data, everyMs = 15 * 60e3) {
  if (!supabaseConfig() || data == null || Date.now() - (lastSave[id] || 0) < everyMs) return;
  lastSave[id] = Date.now();
  setImmediate(() => {
    try {
      const gz = gzipSync(JSON.stringify(data), { level: 6 }).toString("base64");
      writeMm2Row(`warm_${id}`, { at: Date.now(), gz }).catch((e) => console.warn(`Warm snapshot ${id} not saved: ${e.message}`));
    } catch (e) { console.warn(`Warm snapshot ${id} not saved: ${e.message}`); }
  });
}
