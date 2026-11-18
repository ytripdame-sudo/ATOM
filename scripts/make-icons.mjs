#!/usr/bin/env node
/**
 * Renders extension/icons/*.png from geometry — the atom mark on a rounded
 * tile. No image libraries: 4x supersampled coverage, then a hand-rolled PNG
 * encoder on top of node:zlib. Run `node scripts/make-icons.mjs` after changing
 * the mark so the icon and the in-app logo stay the same idea.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const OUT_DIR = fileURLToPath(new URL('../extension/icons/', import.meta.url));

const RING_ANGLE = (55 * Math.PI) / 180;
const RING_RX = 0.325;
const RING_RY = 0.122;
const RING_HALF_WIDTH = 0.028;

/* ------------------------------------------------------------------ colour */

function shade(x, y) {
  if (!insideRounded(x, y, 0.02, 0.225)) return [0, 0, 0, 0];

  // Tile: near-black with a violet wash from the top.
  let r = 24 - 12 * y;
  let g = 26 - 12 * y;
  let b = 34 - 15 * y;
  const wash = Math.max(0, 1 - Math.hypot(x - 0.5, y - 0.2) / 0.85) * 0.5;
  r += 74 * wash;
  g += 34 * wash;
  b += 104 * wash;

  // Rings.
  const ringA = ringCoverage(x, y, RING_ANGLE);
  const ringB = ringCoverage(x, y, -RING_ANGLE);
  const ring = Math.max(ringA * 1, ringB * 0.82);
  if (ring > 0) {
    const ringR = 176 + 18 * (1 - y);
    const ringG = 168 + 24 * (1 - y);
    const ringB2 = 255;
    r = r * (1 - ring) + ringR * ring;
    g = g * (1 - ring) + ringG * ring;
    b = b * (1 - ring) + ringB2 * ring;
  }

  // Nucleus.
  if (Math.hypot(x - 0.5, y - 0.5) < 0.072) {
    r = 242;
    g = 243;
    b = 255;
  }

  return [r, g, b, 1];
}

function ringCoverage(x, y, rotation) {
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const dx = x - 0.5;
  const dy = y - 0.5;
  const px = dx * cos - dy * sin;
  const py = dx * sin + dy * cos;

  const radius = Math.hypot(px / RING_RX, py / RING_RY);
  if (radius < 1e-6) return 0;

  const gx = px / (RING_RX * RING_RX);
  const gy = py / (RING_RY * RING_RY);
  const gradient = Math.hypot(gx, gy) / radius;
  const distance = Math.abs((radius - 1) / gradient);

  return distance <= RING_HALF_WIDTH ? 1 : 0;
}

function insideRounded(x, y, inset, radius) {
  const min = inset;
  const max = 1 - inset;
  if (x < min || x > max || y < min || y > max) return false;

  const dx = Math.max(min + radius - x, 0, x - (max - radius));
  const dy = Math.max(min + radius - y, 0, y - (max - radius));
  return dx * dx + dy * dy <= radius * radius || (x > min + radius && x < max - radius) || (y > min + radius && y < max - radius);
}

/* --------------------------------------------------------------- rendering */

function render(size) {
  const samples = size * SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);
  const sums = new Float64Array(size * size * 4);

  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const [r, g, b, a] = shade((sx + 0.5) / samples, (sy + 0.5) / samples);
      const index = (Math.floor(sy / SUPERSAMPLE) * size + Math.floor(sx / SUPERSAMPLE)) * 4;
      sums[index] += r * a;
      sums[index + 1] += g * a;
      sums[index + 2] += b * a;
      sums[index + 3] += a;
    }
  }

  const total = SUPERSAMPLE * SUPERSAMPLE;
  for (let i = 0; i < size * size; i += 1) {
    const alpha = sums[i * 4 + 3] / total;
    if (alpha <= 0.002) continue;
    pixels[i * 4] = Math.min(255, Math.round(sums[i * 4] / total / alpha));
    pixels[i * 4 + 1] = Math.min(255, Math.round(sums[i * 4 + 1] / total / alpha));
    pixels[i * 4 + 2] = Math.min(255, Math.round(sums[i * 4 + 2] / total / alpha));
    pixels[i * 4 + 3] = Math.round(alpha * 255);
  }

  return pixels;
}

/* ------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolor + alpha
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- main */

await mkdir(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  await writeFile(`${OUT_DIR}icon${size}.png`, png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
