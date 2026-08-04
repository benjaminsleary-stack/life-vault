#!/usr/bin/env node
// Assert a rendered PNG is the size we asked for and is not silently clipped.
//
//   node scripts/check-png.mjs <file> <expected-px> <bleed|centred>
//
// "bleed" means the artwork must reach all four edges — the maskable icon, whose
// corners the launcher crops for itself. "centred" means it need not, but its
// margins must be symmetric, which is how clipping shows up: the bottom and
// right margins grow while the top and left ones stay where they are.
//
// This exists because headless Chrome quietly renders a viewport SHORTER than
// the --window-size it is given — 512x512 came back as 512x425 with the bottom
// 87 pixels transparent, and the PNG's own header still said 512x512. Nothing
// about that is visible in a file listing or a byte count. Golden rule 5: green
// is not done unless the output has been asserted.
//
// No dependencies: node's zlib does the inflate and the rest is the PNG spec.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const [file, wantPx, mode] = process.argv.slice(2);
if (!file || !wantPx || !["bleed", "centred"].includes(mode || "")) {
  console.error("usage: check-png.mjs <file> <expected-px> <bleed|centred>");
  process.exit(2);
}
const px = Number(wantPx);
const buf = readFileSync(file);

if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);

// Walk the chunks: IHDR for geometry, every IDAT concatenated for the pixels.
let pos = 8, w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString("ascii", pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === "IHDR") {
    w = data.readUInt32BE(0); h = data.readUInt32BE(4);
    depth = data[8]; colour = data[9]; interlace = data[12];
  } else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  pos += 12 + len;
}

const fail = (msg) => { console.error(`FAIL ${file}: ${msg}`); process.exit(1); };

if (w !== px || h !== px) fail(`header says ${w}x${h}, expected ${px}x${px}`);
// Chrome drops the alpha channel when a render is fully opaque, so the maskable
// icon comes back as colour type 2 rather than 6. Both are correct output.
if (depth !== 8 || (colour !== 6 && colour !== 2)) {
  fail(`expected 8-bit RGB or RGBA (colour 2 or 6), got depth ${depth}, colour ${colour}`);
}
const hasAlpha = colour === 6;
if (interlace !== 0) fail("interlaced PNGs are not handled");

// Un-filter the scanlines. Four bytes per pixel, so the "previous pixel" for
// the Sub/Paeth filters is four bytes back.
const raw = inflateSync(Buffer.concat(idat));
const bpp = hasAlpha ? 4 : 3, stride = w * bpp;
const out = Buffer.alloc(h * stride);
for (let y = 0; y < h; y++) {
  const ft = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? out[y * stride + x - bpp] : 0;
    const b = y > 0 ? out[(y - 1) * stride + x] : 0;
    const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
    let v = line[x];
    if (ft === 1) v += a;
    else if (ft === 2) v += b;
    else if (ft === 3) v += (a + b) >> 1;
    else if (ft === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else if (ft !== 0) fail(`unknown row filter ${ft} on row ${y}`);
    out[y * stride + x] = v & 0xff;
  }
}

// With no alpha channel every pixel is opaque by definition.
const alpha = (x, y) => (hasAlpha ? out[y * stride + x * bpp + 3] : 255);
const rowHasInk = (y) => { for (let x = 0; x < w; x++) if (alpha(x, y)) return true; return false; };
const colHasInk = (x) => { for (let y = 0; y < h; y++) if (alpha(x, y)) return true; return false; };

let top = 0; while (top < h && !rowHasInk(top)) top++;
let bottom = h - 1; while (bottom > top && !rowHasInk(bottom)) bottom--;
let left = 0; while (left < w && !colHasInk(left)) left++;
let right = w - 1; while (right > left && !colHasInk(right)) right--;
if (top >= h) fail("the image is entirely transparent — nothing rendered");

if (mode === "bleed") {
  if (top !== 0 || left !== 0 || bottom !== h - 1 || right !== w - 1) {
    fail(`artwork must reach every edge but stops at inset ` +
         `top ${top}, left ${left}, bottom ${h - 1 - bottom}, right ${w - 1 - right}. ` +
         `Headless Chrome clipping the viewport is the usual cause.`);
  }
} else {
  // Clipping shows up as lopsidedness: a centred mark loses its bottom/right
  // margin while the top/left one stays put.
  const insets = { top, left, bottom: h - 1 - bottom, right: w - 1 - right };
  const skewY = Math.abs(insets.top - insets.bottom), skewX = Math.abs(insets.left - insets.right);
  const tol = Math.max(2, Math.round(px * 0.01));
  if (skewY > tol || skewX > tol) {
    fail(`artwork is off-centre (insets ${JSON.stringify(insets)}, tolerance ${tol}px) — ` +
         `usually the viewport being shorter than --window-size.`);
  }
}

const pct = (((right - left + 1) * (bottom - top + 1)) / (w * h) * 100).toFixed(0);
console.log(`  ok ${file} — ${w}x${px}, ${mode}, artwork covers ${pct}% of the canvas`);
