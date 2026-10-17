// Draws the app icons (gradient rounded square with an "A") as PNGs - no image libraries needed.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// point in polygon
const inPoly = (px, py, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
// "A" in unit space (0..1): outer triangle minus the counter, plus nothing else (bold geometric A)
const A_OUTER = [[0.5, 0.2], [0.78, 0.8], [0.64, 0.8], [0.58, 0.66], [0.42, 0.66], [0.36, 0.8], [0.22, 0.8]];
const A_HOLE = [[0.5, 0.4], [0.555, 0.54], [0.445, 0.54]];
function icon(size, pad, bg = [11, 10, 20]) {
  const S = 4; // supersampling
  return png(size, (x, y) => {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      // rounded square
      const p = pad, rad = 0.22 * (1 - 2 * pad), lo = p, hi = 1 - p;
      const cx = Math.min(Math.max(u, lo + rad), hi - rad), cy = Math.min(Math.max(v, lo + rad), hi - rad);
      const inSq = u >= lo && u <= hi && v >= lo && v <= hi && (u - cx) ** 2 + (v - cy) ** 2 <= rad * rad;
      let c = bg;
      if (inSq) {
        const t = (u + v) / 2; // gradient #a78bfa -> #22d3ee
        c = [167 + (34 - 167) * t, 139 + (211 - 139) * t, 250 + (238 - 250) * t];
        // letter scaled into the square
        const lu = (u - lo) / (hi - lo), lv = (v - lo) / (hi - lo);
        if (inPoly(lu, lv, A_OUTER) && !inPoly(lu, lv, A_HOLE)) c = [18, 12, 34];
      }
      r += c[0]; g += c[1]; b += c[2];
    }
    return [Math.round(r / S / S), Math.round(g / S / S), Math.round(b / S / S), 255];
  });
}
mkdirSync("icons", { recursive: true });
writeFileSync("icons/icon-192.png", icon(192, 0.04));
writeFileSync("icons/icon-512.png", icon(512, 0.04));
writeFileSync("icons/icon-maskable-512.png", icon(512, 0.14));
writeFileSync("icons/apple-touch-icon.png", icon(180, 0));
writeFileSync("icons/badge-96.png", icon(96, 0));
console.log("icons written");
