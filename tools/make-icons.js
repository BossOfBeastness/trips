// Generates the app icons. Dev-time only — run `node tools/make-icons.js`.
// No dependencies: writes PNGs by hand so the project stays install-free.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const BG = [0x14, 0x16, 0x1c];
const ACCENT = [0xff, 0xb4, 0x54];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Distance from point to line segment, all in 0..1 icon space.
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// A journey: small origin dot, a line, a fat destination dot.
const A = { x: 0.30, y: 0.72 };
const B = { x: 0.70, y: 0.30 };

function coverage(u, v, size) {
  const aa = 1.2 / size; // roughly one pixel of feathering

  const soft = (d, r) => Math.max(0, Math.min(1, (r - d) / aa + 0.5));

  const line = soft(distToSegment(u, v, A.x, A.y, B.x, B.y), 0.022);
  const dotA = soft(Math.hypot(u - A.x, v - A.y), 0.070);
  const dotB = soft(Math.hypot(u - B.x, v - B.y), 0.115);
  // Punch a hole in the big dot so it reads as a destination ring.
  const holeB = soft(Math.hypot(u - B.x, v - B.y), 0.055);

  return Math.max(0, Math.min(1, Math.max(line, dotA, dotB - holeB)));
}

function build(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const a = coverage(u, v, size);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        buf[i + c] = Math.round(BG[c] * (1 - a) + ACCENT[c] * a);
      }
      buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, build(size));
  console.log('wrote', file);
}
