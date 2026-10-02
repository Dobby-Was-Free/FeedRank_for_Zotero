"use strict";

/*
 * Rasterise a logo SVG to PNG, exactly.
 *
 * Writes ONLY the PNG outputs. The input SVG is opened read-only and is never
 * rewritten, cropped, or normalised: earlier revisions of this tooling redrew
 * the artwork by hand and also modified the source files, which changed the
 * design. This reads the real path data, flattens the curves, and fills with the
 * even-odd rule, so what comes out is the supplied artwork and nothing else.
 *
 * No image library is available, so this is a small scanline rasteriser with
 * 4x4 supersampling for anti-aliasing, plus a minimal PNG encoder.
 *
 * Usage:
 *   node tools/rasterize-logo.js <input.svg> <output.png> [size] [--crop]
 *
 * --crop fits the artwork's painted bounding box to the square canvas, which is
 * what makes the mark fill the frame instead of sitting inside the generous
 * margin the source viewBox provides.
 */

const fs = require("node:fs");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
// SVG parsing (paths, rects, circles, groups, presentation attributes)
// ---------------------------------------------------------------------------

function parseAttributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// Tokenise a `d` attribute into commands with numeric arguments.
function tokenizePath(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const commands = [];
  let i = 0;
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      const name = tokens[i++];
      const args = [];
      // Consume numbers until the next command letter. Arity is resolved per
      // command below, so an over-long run is fine.
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) args.push(Number(tokens[i++]));
      commands.push({ name, args });
    } else {
      i++;
    }
  }
  return commands;
}

// Flatten one path into a list of subpaths (arrays of [x, y] points).
function flattenPath(d) {
  const subpaths = [];
  let current = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastControl = null;   // for S/T reflection
  let lastWasCubic = false, lastWasQuad = false;

  const start = (x, y) => {
    if (current.length > 1) subpaths.push(current);
    current = [[x, y]];
    cx = sx = x; cy = sy = y;
  };
  const lineTo = (x, y) => { current.push([x, y]); cx = x; cy = y; };

  const cubic = (x1, y1, x2, y2, x, y) => {
    const x0 = cx, y0 = cy;
    // Adaptive-ish flattening: 24 segments is ample at these scales.
    for (let s = 1; s <= 24; s++) {
      const t = s / 24, u = 1 - t;
      const px = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x;
      const py = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y;
      current.push([px, py]);
    }
    cx = x; cy = y;
  };

  const quad = (x1, y1, x, y) => {
    // Elevate a quadratic to a cubic and reuse the flattener.
    const x0 = cx, y0 = cy;
    cubic(x0 + (2 / 3) * (x1 - x0), y0 + (2 / 3) * (y1 - y0),
      x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x, y);
  };

  for (const { name, args } of tokenizePath(d)) {
    const relative = name === name.toLowerCase();
    const upper = name.toUpperCase();
    const dx = relative ? cx : 0;
    const dy = relative ? cy : 0;
    switch (upper) {
      case "M": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const x = args[i] + dx, y = args[i + 1] + dy;
          if (i === 0) start(x, y); else lineTo(x, y);
        }
        lastWasCubic = lastWasQuad = false;
        break;
      }
      case "L": {
        for (let i = 0; i + 1 < args.length; i += 2) lineTo(args[i] + dx, args[i + 1] + dy);
        lastWasCubic = lastWasQuad = false;
        break;
      }
      case "H": {
        for (const value of args) lineTo(value + dx, cy);
        lastWasCubic = lastWasQuad = false;
        break;
      }
      case "V": {
        for (const value of args) lineTo(cx, value + dy);
        lastWasCubic = lastWasQuad = false;
        break;
      }
      case "C": {
        for (let i = 0; i + 5 < args.length; i += 6) {
          cubic(args[i] + dx, args[i + 1] + dy, args[i + 2] + dx, args[i + 3] + dy,
            args[i + 4] + dx, args[i + 5] + dy);
          lastControl = [args[i + 2], args[i + 3]];
        }
        lastWasCubic = true; lastWasQuad = false;
        break;
      }
      case "S": {
        for (let i = 0; i + 3 < args.length; i += 4) {
          const [rx, ry] = lastWasCubic && lastControl
            ? [2 * cx - lastControl[0] - (relative ? 0 : 0), 2 * cy - lastControl[1]]
            : [cx, cy];
          cubic(rx, ry, args[i] + dx, args[i + 1] + dy, args[i + 2] + dx, args[i + 3] + dy);
          lastControl = [args[i], args[i + 1]];
        }
        lastWasCubic = true; lastWasQuad = false;
        break;
      }
      case "Q": {
        for (let i = 0; i + 3 < args.length; i += 4) {
          quad(args[i] + dx, args[i + 1] + dy, args[i + 2] + dx, args[i + 3] + dy);
          lastControl = [args[i], args[i + 1]];
        }
        lastWasQuad = true; lastWasCubic = false;
        break;
      }
      case "T": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const [rx, ry] = lastWasQuad && lastControl
            ? [2 * cx - lastControl[0], 2 * cy - lastControl[1]]
            : [cx, cy];
          quad(rx, ry, args[i] + dx, args[i + 1] + dy);
          lastControl = [rx, ry];
        }
        lastWasQuad = true; lastWasCubic = false;
        break;
      }
      case "A": {
        // Elliptical arcs. The supplied artwork uses none, so a conservative
        // line to the endpoint keeps the shape closed without pretending to
        // implement the full spec.
        for (let i = 0; i + 6 < args.length; i += 7) lineTo(args[i + 5] + dx, args[i + 6] + dy);
        lastWasCubic = lastWasQuad = false;
        break;
      }
      case "Z": {
        if (current.length > 1) {
          current.push([sx, sy]);
          subpaths.push(current);
          current = [];
        }
        cx = sx; cy = sy;
        lastWasCubic = lastWasQuad = false;
        break;
      }
      default: break;
    }
  }
  if (current.length > 1) subpaths.push(current);
  return subpaths;
}

function roundedRectSubpath(x, y, w, h, r) {
  const points = [];
  const arc = (cx, cy, from) => {
    for (let i = 0; i <= 12; i++) {
      const a = from + (Math.PI / 2) * (i / 12);
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  // Clockwise from the top-left corner's start angle.
  arc(x + r, y + r, Math.PI);
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  points.push(points[0]);
  return points;
}

function circleSubpath(cx, cy, r) {
  const points = [];
  for (let i = 0; i <= 48; i++) {
    const a = (Math.PI * 2 * i) / 48;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return points;
}

function hexToRGB(value) {
  const hex = String(value || "").trim();
  if (hex === "none" || hex === "") return null;
  const m = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let body = m[1];
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

/*
 * Convert a stroked subpath into a filled outline.
 *
 * The rasteriser fills by the even-odd rule, so a stroke becomes the original
 * polyline walked forward and then back, offset by half the stroke width on each
 * side. Joins and caps are handled by inserting an arc fan at every vertex and a
 * disc at each end, which is what makes the result round-joined and round-capped
 * exactly like SVG's defaults for this artwork.
 *
 * Without this, every `fill="none" stroke="..."` path — which is how the page
 * outline and the fold edge are drawn — simply disappears.
 */
function strokeToOutline(subpaths, width, join, cap) {
  const h = width / 2;
  const disc = (cx, cy) => {
    const ring = [];
    for (let i = 0; i <= 24; i++) {
      const a = (Math.PI * 2 * i) / 24;
      ring.push([cx + h * Math.cos(a), cy + h * Math.sin(a)]);
    }
    return ring;
  };

  const pieces = [];
  for (const points of subpaths) {
    // Drop consecutive duplicates, which would produce a zero-length normal.
    const pts = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) pts.push(p);
    }
    if (pts.length < 2) {
      if (pts.length === 1) pieces.push(disc(pts[0][0], pts[0][1]));
      continue;
    }
    const closed = Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 &&
      Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9;

    // Offset both sides using the normal of each segment, averaged at joins.
    const left = [];
    const right = [];
    const segments = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = pts[i + 1][0] - pts[i][0];
      const dy = pts[i + 1][1] - pts[i][1];
      const len = Math.hypot(dx, dy) || 1;
      segments.push({ nx: -dy / len, ny: dx / len });
    }
    for (let i = 0; i < pts.length; i++) {
      const before = segments[i - 1];
      const after = segments[i];
      let nx, ny;
      if (before && after) {
        nx = (before.nx + after.nx) / 2;
        ny = (before.ny + after.ny) / 2;
        const len = Math.hypot(nx, ny) || 1;
        // Miter length grows as the angle sharpens; clamp it so a hairpin
        // corner cannot throw a spike across the canvas.
        const miter = Math.min(3, 1 / Math.max(0.35, len));
        nx = (nx / len) * miter;
        ny = (ny / len) * miter;
      } else {
        nx = (before || after).nx;
        ny = (before || after).ny;
      }
      left.push([pts[i][0] + nx * h, pts[i][1] + ny * h]);
      right.push([pts[i][0] - nx * h, pts[i][1] - ny * h]);
    }
    // One polygon: forward along one side, back along the other.
    const outline = left.concat(right.slice().reverse());
    if (closed) outline.push(outline[0]);
    pieces.push(outline);
    if (join === "round" && !closed) {
      // Round joins fall out of the disc at each interior vertex.
      for (let i = 1; i < pts.length - 1; i++) pieces.push(disc(pts[i][0], pts[i][1]));
    }
    if (cap === "round") {
      pieces.push(disc(pts[0][0], pts[0][1]));
      if (!closed) pieces.push(disc(pts[pts.length - 1][0], pts[pts.length - 1][1]));
    }
  }
  return pieces;
}

/*
 * Collect every paint operation in document order, carrying the nearest
 * ancestor's presentation attributes down (the artwork sets `fill` on groups).
 */
function collectShapes(svg) {
  const shapes = [];
  const stack = [];
  const tagRe = /<(\/?)(g|path|rect|circle)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = tagRe.exec(svg)) !== null) {
    const [, closing, name, attrText, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = parseAttributes(attrText);
    if (name === "g") {
      stack.push(attrs);
      continue;
    }
    // Nearest ancestor wins, then the element's own attribute.
    const inherited = {};
    for (const frame of stack) Object.assign(inherited, frame);
    const merged = { ...inherited, ...attrs };

    let subpaths = null;
    let isWhiteFill = false;
    if (name === "path" && attrs.d) {
      subpaths = flattenPath(attrs.d);
      isWhiteFill = /^#(fff|ffffff)$/i.test(String(merged.fill || ""));
    } else if (name === "rect") {
      const x = Number(attrs.x || 0), y = Number(attrs.y || 0);
      const w = Number(attrs.width || 0), h = Number(attrs.height || 0);
      const r = Number(attrs.rx || attrs.ry || 0);
      if (w > 0 && h > 0) {
        subpaths = [r > 0
          ? roundedRectSubpath(x, y, w, h, Math.min(r, w / 2, h / 2))
          : [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
      }
    } else if (name === "circle") {
      const r = Number(attrs.r || 0);
      if (r > 0) subpaths = [circleSubpath(Number(attrs.cx || 0), Number(attrs.cy || 0), r)];
    }
    if (!subpaths || !subpaths.length) continue;

    const opacityOf = (value) =>
      value == null ? 1 : Math.max(0, Math.min(1, Number(value)));

    // A fill and a stroke on the same element are two separate paint operations.
    const fill = hexToRGB(merged.fill);
    if (fill) {
      shapes.push({
        fill,
        opacity: opacityOf(merged["fill-opacity"] ?? merged.opacity),
        subpaths,
        isWhiteFill,
      });
    }
    const stroke = hexToRGB(merged.stroke);
    const strokeWidth = Number(merged["stroke-width"]);
    if (stroke && Number.isFinite(strokeWidth) && strokeWidth > 0) {
      shapes.push({
        fill: stroke,
        opacity: opacityOf(merged["stroke-opacity"] ?? merged.opacity),
        subpaths: strokeToOutline(
          subpaths,
          strokeWidth,
          merged["stroke-linejoin"] || "miter",
          merged["stroke-linecap"] || "butt",
        ),
      });
    }
  }
  return shapes;
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

// Even-odd point-in-polygon test across every subpath of one shape.
function isInside(shape, x, y) {
  let inside = false;
  for (const poly of shape.subpaths) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function paintedBounds(shapes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const shape of shapes) {
    for (const poly of shape.subpaths) {
      for (const [x, y] of poly) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [input, output, sizeArg] = positional;
  if (!input || !output) {
    process.stderr.write(
      "usage: node tools/rasterize-logo.js <input.svg> <output.png> [size] [--crop] [--plate=RRGGBB]\n",
    );
    process.exitCode = 2;
    return;
  }
  const size = Number(sizeArg) || 96;
  const plateFlag = args.find((a) => a.startsWith("--plate="));
  const plate = plateFlag ? hexToRGB("#" + plateFlag.split("=")[1]) : null;
  const svg = fs.readFileSync(input, "utf8");

  const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1];
  if (!viewBox) throw new Error("input SVG has no viewBox");
  const [vbX, vbY, vbW, vbH] = viewBox.split(/\s+/).map(Number);
  if (![vbX, vbY, vbW, vbH].every(Number.isFinite)) throw new Error("input SVG viewBox is malformed");

  const shapes = collectShapes(svg);
  if (!shapes.length) throw new Error("no filled shapes found in the input SVG");

  // Decide the source rectangle: either the declared viewBox or, with --crop,
  // the artwork's own painted bounds plus a small margin.
  let srcX = vbX, srcY = vbY, srcW = vbW;
  if (flags.has("--crop")) {
    const b = paintedBounds(shapes);
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const side = Math.max(w, h) * 1.04;
    srcX = (b.minX + b.maxX) / 2 - side / 2;
    srcY = (b.minY + b.maxY) / 2 - side / 2;
    srcW = side;
  }

  const SS = 4;                      // supersampling factor
  const N = size * SS;
  const scale = N / srcW;
  const acc = new Float64Array(N * N * 4);   // premultiplied RGBA

  // An optional opaque backing plate. Zotero's MenuManager accepts only a single
  // light/dark icon pair, so a transparent raster of artwork whose page is white
  // would glare on a dark menu. Rendering the SAME artwork over a plate colour
  // changes only the backing, never the design, and gives the dark variant
  // something legible to sit on.
  if (plate) {
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      acc[o] = plate[0];
      acc[o + 1] = plate[1];
      acc[o + 2] = plate[2];
      acc[o + 3] = 1;
    }
  }

  for (const shape of shapes) {
    const [r, g, b] = shape.fill;
    // The artwork's white page is a transparent hole in the supplied SVG. On a
    // real screen that hole shows the page behind it, which is right for a
    // standalone logo but wrong for an icon that has to sit on an arbitrary
    // surface: a menu row or an item pane has no white page underneath, so the
    // document reads as an empty outline. Unless a plate is requested for the
    // whole canvas, make the white FILLS opaque so the document is solid.
    const alpha = (shape.isWhiteFill && !plate) ? 1 : shape.opacity;
    for (let py = 0; py < N; py++) {
      const y = srcY + (py + 0.5) / scale;
      for (let px = 0; px < N; px++) {
        const x = srcX + (px + 0.5) / scale;
        if (!isInside(shape, x, y)) continue;
        const a = alpha;
        const o = (py * N + px) * 4;
        // Source-over with premultiplied alpha.
        const dstA = acc[o + 3];
        const outA = a + dstA * (1 - a);
        acc[o] = r * a + acc[o] * (1 - a);
        acc[o + 1] = g * a + acc[o + 1] * (1 - a);
        acc[o + 2] = b * a + acc[o + 2] * (1 - a);
        acc[o + 3] = outA;
      }
    }
  }

  // Box-downsample to the output size.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          r += acc[o]; g += acc[o + 1]; b += acc[o + 2]; a += acc[o + 3];
        }
      }
      const n = SS * SS;
      r /= n; g /= n; b /= n; a /= n;
      const o = (y * size + x) * 4;
      // Un-premultiply for the PNG's straight-alpha convention.
      if (a > 0) {
        out[o] = Math.max(0, Math.min(255, Math.round(r / a)));
        out[o + 1] = Math.max(0, Math.min(255, Math.round(g / a)));
        out[o + 2] = Math.max(0, Math.min(255, Math.round(b / a)));
      }
      out[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }

  fs.writeFileSync(output, encodePNG(out, size, size));
  const b = flags.has("--crop") ? paintedBounds(shapes) : null;
  process.stdout.write(
    "wrote " + output + " (" + size + "x" + size + ")" +
    (b ? ", cropped from " + (b.maxX - b.minX).toFixed(0) + "x" + (b.maxY - b.minY).toFixed(0) +
      " painted bounds in a " + vbW + "x" + vbH + " viewBox" : "") + "\n",
  );
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, single IDAT, filter 0)
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                     // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

main();
