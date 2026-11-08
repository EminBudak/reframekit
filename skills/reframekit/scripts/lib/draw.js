"use strict";

// Pictures without a dependency or ffmpeg's text filters, which not every
// build has: a small RGB canvas, a 5x7 pixel font and a PNG writer.

const zlib = require("node:zlib");

function rgb(hex) {
  const v = parseInt(String(hex).replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function canvas(width, height, background) {
  const px = Buffer.alloc(width * height * 3);
  const [r, g, b] = rgb(background);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  const blend = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = Math.round(px[i] * (1 - alpha) + color[0] * alpha);
    px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + color[1] * alpha);
    px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + color[2] * alpha);
  };
  const c = {
    width,
    height,
    px,
    rect(x, y, w, h, color, alpha = 1) {
      const col = rgb(color);
      for (let yy = Math.max(0, Math.round(y)); yy < Math.min(height, Math.round(y + h)); yy++) {
        for (let xx = Math.max(0, Math.round(x)); xx < Math.min(width, Math.round(x + w)); xx++) blend(xx, yy, col, alpha);
      }
    },
    // An outline `thick` pixels wide inside the box, dashed when `dash` is
    // the length of a dash.
    frame(x, y, w, h, color, { thick = 2, dash = 0, alpha = 1 } = {}) {
      const x0 = Math.round(x);
      const y0 = Math.round(y);
      const x1 = Math.round(x + w);
      const y1 = Math.round(y + h);
      const col = rgb(color);
      const on = (i) => !dash || Math.floor(i / dash) % 2 === 0;
      for (let t = 0; t < thick; t++) {
        for (let xx = x0; xx < x1; xx++) {
          if (!on(xx - x0)) continue;
          blend(xx, y0 + t, col, alpha);
          blend(xx, y1 - 1 - t, col, alpha);
        }
        for (let yy = y0; yy < y1; yy++) {
          if (!on(yy - y0)) continue;
          blend(x0 + t, yy, col, alpha);
          blend(x1 - 1 - t, yy, col, alpha);
        }
      }
    },
    // RGB pixels (w x h, 3 bytes each) copied in at x, y.
    blit(pixels, w, h, x, y) {
      for (let yy = 0; yy < h; yy++) {
        const ty = Math.round(y) + yy;
        if (ty < 0 || ty >= height) continue;
        for (let xx = 0; xx < w; xx++) {
          const tx = Math.round(x) + xx;
          if (tx < 0 || tx >= width) continue;
          const s = (yy * w + xx) * 3;
          const d = (ty * width + tx) * 3;
          px[d] = pixels[s];
          px[d + 1] = pixels[s + 1];
          px[d + 2] = pixels[s + 2];
        }
      }
    },
    text(x, y, string, color, scale = 2) {
      const col = rgb(color);
      let cx = Math.round(x);
      for (const ch of String(string).toUpperCase()) {
        const glyph = FONT[ch] || FONT["?"];
        for (let row = 0; row < 7; row++) {
          for (let k = 0; k < 5; k++) {
            if (glyph[row][k] !== "#") continue;
            for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) blend(cx + k * scale + dx, Math.round(y) + row * scale + dy, col, 1);
          }
        }
        cx += 6 * scale;
      }
      return cx;
    },
    textWidth: (string, scale = 2) => String(string).length * 6 * scale - scale,
  };
  return c;
}

const GLYPHS = `
A .###. #...# #...# ##### #...# #...# #...#
B ####. #...# #...# ####. #...# #...# ####.
C .###. #...# #.... #.... #.... #...# .###.
D ####. #...# #...# #...# #...# #...# ####.
E ##### #.... #.... ####. #.... #.... #####
F ##### #.... #.... ####. #.... #.... #....
G .###. #...# #.... #.### #...# #...# .####
H #...# #...# #...# ##### #...# #...# #...#
I .###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.
J ..### ...#. ...#. ...#. ...#. #..#. .##..
K #...# #..#. #.#.. ##... #.#.. #..#. #...#
L #.... #.... #.... #.... #.... #.... #####
M #...# ##.## #.#.# #.#.# #...# #...# #...#
N #...# #...# ##..# #.#.# #..## #...# #...#
O .###. #...# #...# #...# #...# #...# .###.
P ####. #...# #...# ####. #.... #.... #....
Q .###. #...# #...# #...# #.#.# #..#. .##.#
R ####. #...# #...# ####. #.#.. #..#. #...#
S .#### #.... #.... .###. ....# ....# ####.
T ##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
U #...# #...# #...# #...# #...# #...# .###.
V #...# #...# #...# #...# #...# .#.#. ..#..
W #...# #...# #...# #.#.# #.#.# #.#.# .#.#.
X #...# #...# .#.#. ..#.. .#.#. #...# #...#
Y #...# #...# .#.#. ..#.. ..#.. ..#.. ..#..
Z ##### ....# ...#. ..#.. .#... #.... #####
0 .###. #...# #..## #.#.# ##..# #...# .###.
1 ..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.
2 .###. #...# ....# ...#. ..#.. .#... #####
3 ##### ...#. ..#.. ...#. ....# #...# .###.
4 ...#. ..##. .#.#. #..#. ##### ...#. ...#.
5 ##### #.... ####. ....# ....# #...# .###.
6 ..##. .#... #.... ####. #...# #...# .###.
7 ##### ....# ...#. ..#.. .#... .#... .#...
8 .###. #...# #...# .###. #...# #...# .###.
9 .###. #...# #...# .#### ....# ...#. .##..
. ..... ..... ..... ..... ..... .##.. .##..
: ..... .##.. .##.. ..... .##.. .##.. .....
- ..... ..... ..... ##### ..... ..... .....
+ ..... ..#.. ..#.. ##### ..#.. ..#.. .....
/ ..... ....# ...#. ..#.. .#... #.... .....
( ...#. ..#.. .#... .#... .#... ..#.. ...#.
) .#... ..#.. ...#. ...#. ...#. ..#.. .#...
% ##... ##..# ...#. ..#.. .#... #..## ...##
, ..... ..... ..... ..... .##.. ..#.. .#...
= ..... ..... ##### ..... ##### ..... .....
> .#... ..#.. ...#. ....# ...#. ..#.. .#...
< ...#. ..#.. .#... #.... .#... ..#.. ...#.
' ..#.. ..#.. .#... ..... ..... ..... .....
? .###. #...# ....# ...#. ..#.. ..... ..#..
_ ..... ..... ..... ..... ..... ..... #####
`;

const FONT = { " ": Array(7).fill(".....") };
for (const line of GLYPHS.trim().split("\n")) {
  const [ch, ...rows] = line.split(" ");
  FONT[ch] = rows;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 8-bit RGB, each row filtered against the pixel to its left.
function png(c, text = {}) {
  const { width, height, px } = c;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const left = x >= 3 ? px[y * stride + x - 3] : 0;
      raw[y * (stride + 1) + 1 + x] = (v - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const notes = Object.entries(text).map(([k, v]) => chunk("tEXt", Buffer.from(`${k}\0${v}`, "latin1")));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), ...notes, chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

module.exports = { canvas, png, rgb };
