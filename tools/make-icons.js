// Generates the app icons. Dev-time only — run `node tools/make-icons.js`.
// No dependencies: writes PNGs by hand so the project stays install-free.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');

// The app's own gradient, baked to pixels: pale leaf through moss to deep
// canopy, with the fruit warming one corner. Same values as app.css.
const PALE   = [0xa9, 0xcb, 0xa8];
const FROND  = [0x6f, 0xa3, 0x7c];
const CANOPY = [0x1e, 0x47, 0x32];
const FRUIT  = [0xc2, 0x5f, 0x1e];
const PAPER  = [0xf4, 0xf7, 0xf0];

// Distance from a point to a line segment, in 0..1 icon space.
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// A journey: origin dot, a run, a ringed destination.
const A = { x: 0.29, y: 0.73 };
const B = { x: 0.69, y: 0.32 };

const RING_R = 0.150;
const _len = Math.hypot(B.x - A.x, B.y - A.y);
const STOP = {
  x: A.x + (B.x - A.x) * ((_len - RING_R) / _len),
  y: A.y + (B.y - A.y) * ((_len - RING_R) / _len),
};

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

const clamp01 = n => Math.max(0, Math.min(1, n));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// sRGB is not linear, so blending raw bytes muddies a gradient. Convert, blend,
// convert back — this is the difference between a clean fade and a grey smear.
const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function blend(colours, t) {
  // colours: [[rgb, stop], ...] sorted by stop
  let lo = colours[0], hi = colours[colours.length - 1];
  for (let i = 0; i < colours.length - 1; i++) {
    if (t >= colours[i][1] && t <= colours[i + 1][1]) { lo = colours[i]; hi = colours[i + 1]; break; }
  }
  const span = hi[1] - lo[1];
  const k = span ? (t - lo[1]) / span : 0;
  const a = lo[0].map(v => toLinear(v / 255));
  const b = hi[0].map(v => toLinear(v / 255));
  return mix(a, b, k).map(v => Math.round(toSrgb(v) * 255));
}

const RAMP = [[PALE, 0], [FROND, 0.52], [CANOPY, 1]];

// iOS rounds the corners itself, so the artwork is a full bleed square: the
// gradient runs corner to corner with the fruit glowing from the top left.
function build(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // 152deg linear ramp, matching the .bloom gradient in app.css.
      const t = clamp01((u * 0.47 + v * 0.88) / 1.35);
      let rgb = blend(RAMP, t);

      // Warm light at the top left, tight enough to stay a highlight not a stain.
      const glow = clamp01(1 - Math.hypot(u - 0.24, v - 0.19) / 0.46);
      rgb = mix(rgb, FRUIT, Math.pow(glow, 2.4) * 0.3);

      // The mark: a route from a small origin to a ringed destination. It has to
      // read at 60px on a home screen, so it is thick, pale and high contrast.
      const aa = 1.4 / size;
      const soft = (d, r) => clamp01((r - d) / aa + 0.5);
      // Stop the run at the ring's outer edge, or it reads as a 9 rather than
      // a journey arriving somewhere.
      const line = soft(distToSegment(u, v, A.x, A.y, STOP.x, STOP.y), 0.030);
      const dotA = soft(Math.hypot(u - A.x, v - A.y), 0.085);
      const ring = soft(Math.hypot(u - B.x, v - B.y), 0.150)
                 - soft(Math.hypot(u - B.x, v - B.y), 0.088);
      const markAlpha = clamp01(Math.max(line, dotA, ring));

      rgb = mix(rgb, PAPER, markAlpha).map(Math.round);

      const i = (y * size + x) * 4;
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255;
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
