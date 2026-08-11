/**
 * Generate the extension icons.
 *
 * Chrome will not take an SVG for a toolbar icon, and pulling in an image
 * library for four small PNGs is not worth the dependency, so the icons are
 * drawn here and encoded with Node's built-in zlib.
 *
 * The mark follows the panel's colour semantics: an amber arrow for bytes in
 * transit, coming to rest on a mint bar that stands for the file on disk.
 *
 * Run with: npm run icons
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../icons');
const SIZES = [16, 32, 48, 128];
/** Samples per axis. Four is enough to keep the arrow's edges clean. */
const SUPERSAMPLE = 4;

const GROUND = [0x0a, 0x11, 0x14];
const SIGNAL = [0xff, 0xb0, 0x2e];
const LOCKED = [0x46, 0xdf, 0xae];

// --------------------------------------------------------------------------
// Geometry, described on a nominal 128x128 grid
// --------------------------------------------------------------------------

const GRID = 128;

const BADGE = { x0: 2, y0: 2, x1: 126, y1: 126, radius: 27 };
const SHAFT = { x0: 55, y0: 26, x1: 73, y1: 68, radius: 3 };
const HEAD = { apexX: 64, apexY: 97, baseY: 62, halfWidth: 30 };
const BASE_BAR = { x0: 33, y0: 104, x1: 95, y1: 114, radius: 5 };

function insideRoundedRect(x, y, { x0, y0, x1, y1, radius }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;

  const nearestX = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const nearestY = Math.min(Math.max(y, y0 + radius), y1 - radius);
  const dx = x - nearestX;
  const dy = y - nearestY;

  // Inside the inner cross is always in; otherwise it is a corner test.
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

function insideTriangle(x, y, { apexX, apexY, baseY, halfWidth }) {
  if (y < baseY || y > apexY) return false;
  // Width tapers linearly from the base to the apex.
  const progress = (y - baseY) / (apexY - baseY);
  const halfAtY = halfWidth * (1 - progress);
  return Math.abs(x - apexX) <= halfAtY;
}

/** Colour at a point on the nominal grid, or null where the icon is transparent. */
function sample(x, y) {
  if (!insideRoundedRect(x, y, BADGE)) return null;
  if (insideRoundedRect(x, y, BASE_BAR)) return LOCKED;
  if (insideTriangle(x, y, HEAD)) return SIGNAL;
  if (insideRoundedRect(x, y, SHAFT)) return SIGNAL;
  return GROUND;
}

/** Render one size to an RGBA buffer, averaging supersamples for smooth edges. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = GRID / (size * SUPERSAMPLE);

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let subRow = 0; subRow < SUPERSAMPLE; subRow++) {
        for (let subColumn = 0; subColumn < SUPERSAMPLE; subColumn++) {
          const x = (column * SUPERSAMPLE + subColumn + 0.5) * step;
          const y = (row * SUPERSAMPLE + subRow + 0.5) * step;
          const colour = sample(x, y);
          if (!colour) continue;
          red += colour[0];
          green += colour[1];
          blue += colour[2];
          alpha += 1;
        }
      }

      const total = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (row * size + column) * 4;
      if (alpha === 0) continue;

      // Average over covered samples only, so edge pixels keep their hue and
      // fade through alpha rather than darkening towards black.
      pixels[offset] = Math.round(red / alpha);
      pixels[offset + 1] = Math.round(green / alpha);
      pixels[offset + 2] = Math.round(blue / alpha);
      pixels[offset + 3] = Math.round((alpha / total) * 255);
    }
  }

  return pixels;
}

// --------------------------------------------------------------------------
// Minimal PNG encoder
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) {
    const source = row * size * 4;
    const target = row * (size * 4 + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, source, source + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------------

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

for (const size of SIZES) {
  const file = resolve(OUTPUT_DIRECTORY, `icon-${size}.png`);
  const png = encodePng(size, render(size));
  writeFileSync(file, png);
  console.log(`icon-${size}.png  ${png.length} bytes`);
}
