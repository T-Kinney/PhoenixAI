/**
 * Generate the PhoenixAI app icon.
 *
 * No image library is installed and none is worth adding for one asset, so the
 * mark is drawn procedurally and encoded as PNG using Node's built-in zlib.
 *
 * The mark: a rising phoenix — swept wings, a body tapering to a tail, and a
 * flame core — in ember tones on a dark ground. Drawn with signed-distance
 * fields and supersampled 4x so the curves stay clean at 32px in a taskbar.
 */

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "resources");

const SIZE = 512;
const SS = 2;                 // supersample factor
const DIM = SIZE * SS;

/* ---------- tiny PNG encoder ---------- */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- drawing ---------- */

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Ember ramp, cool at the edges to hot in the core.
const EMBER = [
  [0.42, 0.10, 0.04],
  [0.85, 0.24, 0.05],
  [0.98, 0.52, 0.09],
  [1.00, 0.78, 0.28],
  [1.00, 0.95, 0.72]
];
function ember(t) {
  const x = clamp(t) * (EMBER.length - 1);
  const i = Math.min(EMBER.length - 2, Math.floor(x));
  return mix(EMBER[i], EMBER[i + 1], x - i);
}

/**
 * One wing. Drawn as a filled band around a curved spine that rises steeply
 * from the shoulder then sweeps outward — a straight ray reads as an arm, not
 * a wing, so the outward arc at the tip is what makes it a bird.
 * `side` is -1 or +1.
 */
function wingField(x, y, side) {
  const px = x * side;
  if (px < -0.06) return -1;

  let best = -1;
  // Walk the spine and keep the closest approach.
  for (let k = 0; k <= 48; k++) {
    const t = k / 48;
    // Rises fast, then arcs out and slightly down at the tip.
    const sx = 0.05 + 0.78 * Math.sin(t * 1.36);
    const sy = -0.02 - 0.86 * t + 0.30 * t * t;
    const d = Math.hypot(px - sx, y - sy);
    // Broad at the shoulder, tapering to a point.
    const half = 0.175 * Math.pow(1 - t, 0.75) + 0.008;
    best = Math.max(best, half - d);
  }
  return best;
}

/** Three trailing feathers per wing, so the silhouette is not a solid blade. */
function featherField(x, y, side) {
  const px = x * side;
  let best = -1;
  for (const [t0, len] of [[0.46, 0.16], [0.64, 0.20], [0.81, 0.17]]) {
    const sx = 0.05 + 0.78 * Math.sin(t0 * 1.36);
    const sy = -0.02 - 0.86 * t0 + 0.30 * t0 * t0;
    for (let k = 0; k <= 20; k++) {
      const u = k / 20;
      const fx = sx + len * 0.55 * u;
      const fy = sy + len * u;          // trail downward behind the wing
      const d = Math.hypot(px - fx, y - fy);
      best = Math.max(best, 0.060 * (1 - u * 0.55) - d);
    }
  }
  return best;
}

/**
 * Body tapering into a single tail. Deliberately NOT forked — a split tail
 * reads as a pair of legs and turns the whole mark into a stick figure.
 * The body starts above the head circle so neck and skull are one shape.
 */
function bodyField(x, y) {
  if (y < -0.52 || y > 0.80) return -1;
  const t = (y + 0.52) / 1.32;                 // 0 at crown, 1 at tail tip
  // Narrow at the neck, widest at the chest, tapering to the tail.
  const chest = Math.sin(clamp(t / 0.42) * Math.PI * 0.5);
  const half = (0.045 + 0.085 * chest) * (1 - clamp((t - 0.42) / 0.58) * 0.86) + 0.010;
  return half - Math.abs(x);
}

/** Head, overlapping the neck so the two merge into one silhouette. */
function headField(x, y) {
  return 0.085 - Math.hypot(x * 1.1, (y + 0.47) * 0.95);
}

const px = Buffer.alloc(DIM * DIM * 4);

for (let j = 0; j < DIM; j++) {
  for (let i = 0; i < DIM; i++) {
    // Normalized coords, origin centre, y down.
    const x = (i / DIM) * 2 - 1;
    const y = (j / DIM) * 2 - 1;
    const r = Math.hypot(x, y);

    // Dark disc with a warm centre. Kept low-chroma so the bird carries the
    // colour rather than competing with the background.
    const plate = smooth(0.995, 0.94, r);
    let col = mix([0.10, 0.055, 0.045], [0.045, 0.035, 0.045], smooth(0.1, 0.95, r));
    let alpha = plate;

    // Bird silhouette.
    const bird = Math.max(
      wingField(x, y, 1),
      wingField(x, y, -1),
      featherField(x, y, 1),
      featherField(x, y, -1),
      bodyField(x, y),
      headField(x, y)
    );
    const birdMask = smooth(-0.012, 0.012, bird);

    if (birdMask > 0) {
      // Heat rises: hotter toward the head and the wing roots.
      // Hottest at the core and up through the head; cooler at the wing tips.
      const heat = clamp(0.86 - Math.hypot(x * 0.85, y + 0.15) * 0.78);
      col = mix(col, ember(heat), birdMask);
    }

    // Flame core behind the body.
    const core = smooth(0.42, 0.0, Math.hypot(x * 1.6, (y + 0.05) * 1.0));
    col = mix(col, ember(0.75), core * 0.30 * plate * (1 - birdMask));

    // Rim light so the mark reads on a light taskbar too.
    const rim = smooth(0.93, 0.99, r) * smooth(1.0, 0.96, r);
    col = mix(col, [1, 0.62, 0.22], rim * 0.55);

    const o = (j * DIM + i) * 4;
    px[o] = Math.round(clamp(col[0]) * 255);
    px[o + 1] = Math.round(clamp(col[1]) * 255);
    px[o + 2] = Math.round(clamp(col[2]) * 255);
    px[o + 3] = Math.round(clamp(alpha) * 255);
  }
}

/** Box-downsample the supersampled buffer to `size`. */
function downsample(src, srcDim, size) {
  const out = Buffer.alloc(size * size * 4);
  const factor = srcDim / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const o = (((y * factor) | 0) + sy) * srcDim * 4 + (((x * factor) | 0) + sx) * 4;
          r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });

// Windows .ico wants several sizes; the small ones are what you actually see
// in the taskbar, so they get their own downsample rather than being scaled
// from one large image by the packager.
const sizes = [256, 128, 64, 48, 32, 16];
const pngs = [];
for (const size of sizes) {
  const buf = encodePNG(downsample(px, DIM, size), size, size);
  pngs.push(buf);
  if (size === 256) fs.writeFileSync(path.join(OUT, "icon.png"), buf);
}
fs.writeFileSync(path.join(OUT, "icon-512.png"), encodePNG(downsample(px, DIM, SIZE), SIZE, SIZE));

const toIco = (await import("png-to-ico")).default;
fs.writeFileSync(path.join(OUT, "icon.ico"), await toIco(pngs));

console.log(`icon.png   ${fs.statSync(path.join(OUT, "icon.png")).size} bytes`);
console.log(`icon.ico   ${fs.statSync(path.join(OUT, "icon.ico")).size} bytes (${sizes.join(", ")})`);
