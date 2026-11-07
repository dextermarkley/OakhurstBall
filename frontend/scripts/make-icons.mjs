#!/usr/bin/env node
// Renders the PWA / home-screen PNG icons (no native deps): navy tile, orange
// basketball with navy seams, 4x4 supersampled. Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const NAVY = [0x16, 0x21, 0x3a];
const ORANGE = [0xf0, 0x7a, 0x24];

/** Colour at a point in a 512-unit design space centered on (0,0). */
function shade(x, y) {
  const R = 170; // ball radius
  const W = 8; // half stroke width
  const r = Math.hypot(x, y);
  if (r > R + W) return NAVY;
  if (Math.abs(r - R) <= W) return NAVY; // outline
  if (Math.abs(x) <= W || Math.abs(y) <= W) return NAVY; // straight seams
  // Side seams: arcs of circles centered at (±282, 0) with radius 202.
  if (Math.abs(Math.hypot(282.2 - Math.abs(x), y) - 202.2) <= W) return NAVY;
  return ORANGE;
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let rgb = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 512 - 256;
          const y = ((py + (sy + 0.5) / ss) / size) * 512 - 256;
          const c = shade(x, y);
          rgb = rgb.map((v, i) => v + c[i]);
        }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(rgb[i] / (ss * ss));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

for (const [name, size] of [
  ['pwa-192.png', 192],
  ['pwa-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), png(size));
  console.log('wrote public/' + name);
}
