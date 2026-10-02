"use strict";

/*
 * Derive FeedRank's small UI icons from the supplied raster artwork.
 *
 * Why this exists instead of rendering the SVG at 16x16: rasterising the vector
 * mark straight to 16 pixels produced a muddy, unrecognisable smudge in the menu
 * and the item pane, which is exactly what a user sees there. The supplied
 * artwork already ships a hand-tuned 48x48 version for small sizes
 * (`logo_small.png`), so the icons are produced by a proper area-average
 * downscale of that, with alpha handled premultiplied so edges neither darken
 * nor halo. Nothing is redrawn, cropped, recoloured, or simplified: every pixel
 * comes from the supplied PNGs.
 *
 * Usage:
 *   node tools/make-ui-icons.js            # write the four icons
 *   node tools/make-ui-icons.js --check    # verify they match the source
 *
 * The supplied `logo.png`, `logo_small.png`, `logo.svg`, and
 * `logo_transparent.svg` are read-only inputs and are never modified.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const CONTENT = path.join(ROOT, "chrome", "content");
// Ordered best-first: the small, hand-tuned asset is the right source for a
// 16-20 px icon, and the 96 px asset is the fallback if it is ever removed.
const SOURCES = ["assets/logo_small.png", "chrome/content/logo.png"];

const TARGETS = [
  { file: "feedrank-menu.png", size: 16, note: "context-menu row" },
  { file: "feedrank-pane.png", size: 16, note: "item-pane section header" },
  { file: "feedrank-pane-sidenav.png", size: 20, note: "item-pane sidenav" },
];

// --- PNG decode ------------------------------------------------------------

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG to 8-bit RGBA. Supports the colour types and bit depths the
 * supplied assets actually use, and refuses anything else rather than guessing.
 */
function decodePNG(buffer, label) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(label + " is not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let transparency = null;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (interlace) throw new Error(label + " is interlaced, which this tool does not read");
  if (bitDepth !== 8) throw new Error(label + " is " + bitDepth + "-bit, which this tool does not read");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(label + " has an unsupported colour type " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position++];
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      line[i] = value & 0xff;
    }
    previous = line;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[d] = line[s]; rgba[d + 1] = line[s + 1]; rgba[d + 2] = line[s + 2]; rgba[d + 3] = line[s + 3];
      } else if (colorType === 2) {
        rgba[d] = line[s]; rgba[d + 1] = line[s + 1]; rgba[d + 2] = line[s + 2]; rgba[d + 3] = 255;
      } else if (colorType === 0) {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = line[s]; rgba[d + 3] = 255;
      } else if (colorType === 4) {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = line[s]; rgba[d + 3] = line[s + 1];
      } else if (colorType === 3) {
        rgba[d] = palette[line[s] * 3];
        rgba[d + 1] = palette[line[s] * 3 + 1];
        rgba[d + 2] = palette[line[s] * 3 + 2];
        rgba[d + 3] = transparency && line[s] < transparency.length ? transparency[line[s]] : 255;
      }
    }
  }
  return { width, height, rgba };
}

// --- PNG encode ------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- downscale -------------------------------------------------------------

/**
 * Area-average downscale to a square `size`, with colour averaged premultiplied
 * by alpha so a semi-transparent edge keeps the artwork's colour instead of
 * fading toward black, and so no half-covered source pixel is dropped.
 *
 * Uses an exact coverage integral rather than whole-pixel buckets, which is what
 * keeps a 48 px source legible at 16 px.
 */
function downscale(source, size) {
  const out = Buffer.alloc(size * size * 4);
  const scaleX = source.width / size;
  const scaleY = source.height / size;
  const at = (x, y) => {
    const s = (y * source.width + x) * 4;
    return [source.rgba[s], source.rgba[s + 1], source.rgba[s + 2], source.rgba[s + 3]];
  };
  for (let y = 0; y < size; y++) {
    const y0 = y * scaleY;
    const y1 = y0 + scaleY;
    for (let x = 0; x < size; x++) {
      const x0 = x * scaleX;
      const x1 = x0 + scaleX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.min(Math.ceil(y1), source.height); sy++) {
        const coverageY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (coverageY <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(Math.ceil(x1), source.width); sx++) {
          const coverageX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (coverageX <= 0) continue;
          const w = coverageX * coverageY;
          const [pr, pg, pb, pa] = at(sx, sy);
          const alpha = pa / 255;
          r += pr * alpha * w;
          g += pg * alpha * w;
          b += pb * alpha * w;
          a += pa * w;
          weight += w;
        }
      }
      const d = (y * size + x) * 4;
      if (weight <= 0) continue;
      const alpha = a / weight;
      const unPremultiply = alpha > 0 ? 255 / alpha : 0;
      out[d] = Math.min(255, Math.round((r / weight) * unPremultiply));
      out[d + 1] = Math.min(255, Math.round((g / weight) * unPremultiply));
      out[d + 2] = Math.min(255, Math.round((b / weight) * unPremultiply));
      out[d + 3] = Math.round(alpha);
    }
  }
  return out;
}

// --- main ------------------------------------------------------------------

function findSource() {
  for (const name of SOURCES) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) return { name, full, image: decodePNG(fs.readFileSync(full), name) };
  }
  throw new Error("None of the supplied logo PNGs were found: " + SOURCES.join(", "));
}

function main() {
  const check = process.argv.includes("--check");
  const source = findSource();
  if (source.image.width !== source.image.height) {
    throw new Error(source.name + " is not square; refusing to guess at a crop");
  }
  const produced = [];
  for (const target of TARGETS) {
    const rgba = downscale(source.image, target.size);
    const png = encodePNG(rgba, target.size, target.size);
    const destination = path.join(CONTENT, target.file);
    const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
    const same = existing && existing.equals(png);
    if (check) {
      if (!same) throw new Error(target.file + " is not derived from " + source.name);
    } else if (!same) {
      fs.writeFileSync(destination, png);
    }
    produced.push({ ...target, bytes: png.length, changed: !same });
  }
  const verb = check ? "verified" : "wrote";
  for (const entry of produced) {
    console.log(
      "  " + verb + " chrome/content/" + entry.file + " " + entry.size + "x" + entry.size +
      " (" + entry.bytes + " bytes, " + entry.note + ")" +
      (check || entry.changed ? "" : " — unchanged"),
    );
  }
  console.log(verb + " " + produced.length + " UI icons from " + source.name +
    " (" + source.image.width + "x" + source.image.height + ")");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("make-ui-icons: " + (error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}

module.exports = { decodePNG, encodePNG, downscale };
