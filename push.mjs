// Phone notifications (Web Push) without any library. The server sends an empty "wake up" push
// signed with its VAPID key; the app's service worker (sw.js) then asks /api/push/latest what to
// show. Keys are made once and kept in Supabase row "vapid"; phones that turned alerts on are in
// row "push_subs" (only the owner can add one).
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { readRow, writeMm2Row, supabaseConfig } from "./mm2-values.mjs";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
let keys = null;       // { publicKey (base64url raw P-256 point), jwk }
let subs = null;       // [{ endpoint, keys, addedAt }]
let latest = { at: 0, title: "Agony Values", body: "Open the app for the latest.", url: "/flips" };

async function loadKeys() {
  if (keys) return keys;
  const saved = supabaseConfig() ? await readRow("vapid").catch(() => null) : null;
  if (saved?.publicKey && saved?.jwk) return (keys = saved);
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  keys = { publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")])), jwk: privateKey.export({ format: "jwk" }) };
  if (supabaseConfig()) await writeMm2Row("vapid", keys).catch(() => {});
  return keys;
}
async function loadSubs() {
  if (subs) return subs;
  subs = (supabaseConfig() ? await readRow("push_subs").catch(() => null) : null) || [];
  return subs;
}

export async function publicKey() { return (await loadKeys()).publicKey; }

export async function addSubscription(sub) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint)) throw new Error("Bad subscription");
  const list = await loadSubs();
  const i = list.findIndex((s) => s.endpoint === sub.endpoint);
  const entry = { endpoint: sub.endpoint, keys: sub.keys || null, addedAt: Date.now() };
  if (i >= 0) list[i] = entry; else list.push(entry);
  if (supabaseConfig()) await writeMm2Row("push_subs", list);
  return list.length;
}

function vapidJwt(endpoint) {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:alerts@agony-values.onrender.com" }));
  const key = createPrivateKey({ key: keys.jwk, format: "jwk" });
  const sig = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(sig)}`;
}

// msg: { title, body, url, image? } - shown on every subscribed phone.
export async function notifyPhones(msg) {
  latest = { at: Date.now(), ...msg };
  await loadKeys();
  const list = await loadSubs();
  if (!list.length) return 0;
  let sent = 0, dropped = false;
  await Promise.all(list.map(async (s) => {
    try {
      const r = await fetch(s.endpoint, { method: "POST", signal: AbortSignal.timeout(15000),
        headers: { TTL: "300", Urgency: "high", Authorization: `vapid t=${vapidJwt(s.endpoint)}, k=${keys.publicKey}`, "Content-Length": "0" } });
      if (r.status === 404 || r.status === 410) { s.gone = true; dropped = true; } // phone unsubscribed
      else if (r.ok) sent++;
    } catch { /* try again next time */ }
  }));
  if (dropped) { subs = list.filter((s) => !s.gone); if (supabaseConfig()) await writeMm2Row("push_subs", subs).catch(() => {}); }
  return sent;
}

export const latestNotification = () => latest;
