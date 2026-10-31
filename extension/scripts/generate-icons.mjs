// Render public/icon.svg -> icon-16/32/48/128.png memakai stdlib saja (node:fs, node:zlib).
// Geometri 1:1 dengan icon.svg (ruang 128): bg rounded-rect rx28 #0B57D0,
// loop arc r36 stroke14 (gap 50° kanan-atas), kepala panah, jarum jam + titik tengah.
// Rasterizer analitik (SDF per subpiksel, SS=4x) + penulis PNG minimal (deflate, filter 0).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BLUE = [11, 87, 208], WHITE = [255, 255, 255], ACCENT = [211, 225, 253];
const C = { x: 64, y: 64 }, R = 36, LOOP_W = 14;
// Gap loop: sudut (-70°, -20°) dieksklusi; dalam [0,360): luar (290,340)
const inSweep = (a) => a >= 340 || a <= 290;
const SEG_H = { x1: 64, y1: 64, x2: 81.3, y2: 74, w: 10 }; // jarum pendek (aksen)
const SEG_M = { x1: 64, y1: 64, x2: 64, y2: 38, w: 10 };   // jarum panjang (putih)
const TRI = [[96, 38], [71, 40], [79, 20]];               // kepala panah, tip [0]
const DOT = { x: 64, y: 64, r: 8 };
const ARC_END_1 = [97.8, 51.7], ARC_END_2 = [76.3, 30.2]; // round caps

const dist2 = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
function distSeg(px, py, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const t = Math.min(1, Math.max(0, ((px - s.x1) * dx + (py - s.y1) * dy) / (dx * dx + dy * dy)));
  return dist2(px, py, s.x1 + t * dx, s.y1 + t * dy);
}
function inTri(px, py) {
  const [a, b, c] = TRI;
  const s = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = s([px, py], a, b), d2 = s([px, py], b, c), d3 = s([px, py], c, a);
  return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
}
function inLoop(px, py) {
  const dx = px - C.x, dy = py - C.y, r = Math.hypot(dx, dy);
  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (a < 0) a += 360;
  if (Math.abs(r - R) <= LOOP_W / 2 && inSweep(a)) return true;
  return dist2(px, py, ...ARC_END_1) <= LOOP_W / 2 || dist2(px, py, ...ARC_END_2) <= LOOP_W / 2;
}
const inRR = (px, py) => {
  const r = 28, qx = Math.abs(px - 64) - (64 - r), qy = Math.abs(py - 64) - (64 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
};
// Urutan lapis (bawah->atas); kembalikan warna lapis teratas yg menutupi, null = transparan
function sample(px, py) {
  if (!inRR(px, py)) return null;
  let col = BLUE;
  if (inLoop(px, py)) col = WHITE;
  if (inTri(px, py)) col = WHITE;
  if (distSeg(px, py, SEG_H) <= SEG_H.w / 2) col = ACCENT;
  if (distSeg(px, py, SEG_M) <= SEG_M.w / 2) col = WHITE;
  if (dist2(px, py, DOT.x, DOT.y) <= DOT.r) col = WHITE;
  return col;
}

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc = (b) => {
  let c = 0xffffffff;
  for (const v of b) c = CRC_T[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
function toPNG(size) {
  const SS = 4, rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const col = sample(((x + (sx + 0.5) / SS) / size) * 128, ((y + (sy + 0.5) / SS) / size) * 128);
          if (!col) continue;
          n++; r += col[0]; g += col[1]; b += col[2];
        }
      }
      const o = (y * size + x) * 4;
      if (!n) continue; // alfa 0
      rgba[o] = Math.round(r / n); rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n); rgba[o + 3] = Math.round((n / (SS * SS)) * 255);
    }
  }
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4);
  head[8] = 8; head[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ROOT, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(ROOT, `icon-${s}.png`), toPNG(s));
  console.log(`icon-${s}.png ok`);
}
