// The film around the picture (Cornice): procedural, no textures, no canvas, no fonts.
//
// What a scan of a NEGATIVE shows outside the picture, once inverted the way a lab scanner does (dense = light):
//   - the rebate (unexposed clear base + fog) is the least dense film there is, so it inverts to near-black. It is not
//     flat #000: very dark, a touch warm, with fine grain and a slow unevenness of a few %;
//   - where no film is in the light path (sprocket holes) the scanner gets all its light: the deepest black;
//   - where the carrier's metal blocks the light nothing reaches the sensor, which inverts to paper white;
//   - the camera gate's edge, between picture and rebate, is soft (~1-2 px at 12 MP: the gate sits a hair off the
//     emulsion), very slightly wavy, rounded at the corners, and eats a few px into the picture.
// Styles (FRAME_STYLES):
//   - nero: the rebate as a thin band (0.5 % of the long side, user's choice) on all sides, cut straight by the scan crop;
//   - limato: the darkroom "filed carrier": the same band, its outer edge the carrier opening filed by hand (straight
//     file strokes, rough corners), carrier white beyond it;
//   - intera: the whole 35 mm strip: rails with sprocket holes and latent-image edge numbers, carrier white around.
// No dust here: dust.js draws it over the frame as well, so the marks are one system everywhere. A mat around all of it
// is the app's.
//
// Geometry is in mm of film (util.js FRAME_UM: the picture's long side is the 36 mm frame), so the preview and an export
// look the same scaled; only the fine grain is per pixel. Film space is landscape (the film runs along x, the picture's
// long side); for a portrait picture the canvas is film space turned 90° clockwise. Every pixel is evaluated from its
// absolute coordinates (hashed noise, geometry built from the seed alone), so any split of the canvas into strips gives
// the same bytes as one call.

import { FRAME_UM } from './util.js';

export const FRAME_STYLES = ['none', 'nero', 'limato', 'intera'];
export const FRAME_NAMES = { none: 'Nessuna', nero: 'Bordo nero', limato: 'Carrier limato', intera: 'Pellicola intera' };

const FRAME_MM = FRAME_UM / 1000;      // the picture's long side, mm of film
// The brief gave the gate's sizes in px at 12 MP: a 3:2 frame 4243 px long, so 1 px there is PX12 mm.
const PX12 = FRAME_MM / 4243;
// No ramp narrower than this many px: a smaller one shows stairs on a small preview.
const MIN_RAMP_PX = 0.8;

// Colours, display sRGB 8-bit (the app's output space).
const REBATE = [17, 13, 11];           // scanned rebate: very dark, warm (Gold's orange mask is not fully cancelled). Visual, from the prototype (15/255 x (1, .8, .68)), unverified against a real Frontier scan
const REBATE_UNEVEN = 0.10;            // ± relative level, slow (fog, scanner light falloff): "a few %" of density reads as ~10 % this close to black. Visual
const REBATE_GRAIN = 0.22;             // ± relative level, per pixel: grain and scanner noise in the shadows. Visual
const HOLE = [3, 3, 4];                // no film: the scanner's clipped black, a hair darker than the rebate
const CARRIER = [250, 248, 244];       // carrier metal (blocked light, inverted): paper white, per the brief
const CARRIER_UNEVEN = 1.6;            // ± levels, slow: the carrier's own sheen. Visual
const AMBER = [255, 180, 70];          // latent-image edge print, per the brief

// Camera gate (all styles), per the brief: it eats 1-3 px at 12 MP into the picture, edge ramp ~1.5 px at 12 MP.
const GATE_EAT = [1 * PX12, 3 * PX12];  // mm, min and max of the inward offset
const GATE_TILT = 1 * PX12;            // mm, the most two ends of a side differ (sides not quite parallel)
const GATE_RAMP = 1.5 * PX12;          // mm
const GATE_RADIUS = 0.3;               // mm, corner radius: "slightly rounded". A visual choice, unverified

// nero, limato: widths as fractions of the picture's long side (user's choice: "about 0.5 %").
const BAND = 0.005;                    // black rebate band
const FILED_ROUGH = 0.006;             // limato: the filed edge reaches up to this much further out, in places
const FILED_CARRIER = 0.015;           // limato: the canvas margin beyond the band, carrier white where the file did not reach
const FILED_FACET = [0.4, 2.2];        // mm, length of one file stroke (a straight facet). Visual
const FILED_RADIUS = [0.25, 0.7];      // mm, corner radius of the filed opening; < 0.9 mm so it never cuts the picture's corner. Visual
const FILED_RAMP = 2.5 * PX12;         // mm: the carrier sits above the film, a little out of focus. Visual

// intera: 135 film (ISO 1007), mm.
const RAIL = 5.5;                      // film edge to picture: (35 - 24) / 2
const GAP = 2.0;                       // rebate past each end of the picture: the inter-frame gap (38 mm pitch - 36)
const CARRIER_MM = 1.2;                // carrier white beyond the film's edges and the strip's ends (brief)
const PERF = { along: 1.98, across: 2.79, r: 0.5, pitch: 4.75 };   // KS perforation and pitch
const PERF_EDGE = 2.2;                 // hole centre from the film edge: within the 2.0-2.4 mm of real 35 mm; leaves a 1.9 mm band for the edge print
const PERF_RAMP = 1 * PX12;            // mm: a punched edge, sharp (brief: "soft 1 px")
const FILM_EDGE_RAMP = 1.5 * PX12;     // mm: the film's slit edge, in focus like the gate's
const MASK_RAMP = 3 * PX12;            // mm: the carrier's mask at the strip's ends, above the film. Visual
// Edge print: generic frame numbers and arrows (no brand, no DX code), drawn as vector strokes.
const PRINT = {
  height: 0.95,                        // mm, glyph skeleton height (the stroke adds its width: ~1.1 mm caps, as on Kodak 135)
  stroke: 0.15,                        // stroke width, in glyph heights
  ramp: 0.035,                         // mm, edge softness: the latent image is printed by a light source through the base
  glow: 0.09,                          // mm, halo falloff: light spread in the emulsion
  halo: 0.32,                          // halo strength relative to the core
  peak: 0.78,                          // the strongest the print gets (screen over the rebate): dense but not white. Visual
};
// Labels and positions (mm from the picture's left end) on the top and bottom rail; '>' is the arrow.
const PRINT_ITEMS = [[0, 1.2, '>12'], [0, 20.2, '>12A'], [1, 10.7, '>13'], [1, 29.7, '>13A']];

// ---------- noise ----------

function rng(seed) {                   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform [0, 1) from an integer lattice point: stateless, so any pixel in any order gets the same value. */
function hash(seed, i, j) {
  let h = seed ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1], lattice step 1. */
function noise1(seed, x) {
  const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f), a = hash(seed, i, 0);
  return 2 * (a + (hash(seed, i + 1, 0) - a) * s) - 1;
}
function noise2(seed, x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(seed, i, j), b = hash(seed, i + 1, j), c = hash(seed, i, j + 1), d = hash(seed, i + 1, j + 1);
  return 2 * (a + (b - a) * sx + (c - a + (a - b + d - c) * sx) * sy) - 1;
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** Coverage of a shape from its signed distance `d` (px, > 0 outside) and the width of its edge ramp (px). */
const inside = (d, ramp) => smooth(0.5 - d / ramp);
const rampPx = (mm, u) => Math.max(MIN_RAMP_PX, mm * u);

// ---------- geometry ----------

/** Film-space layout: picture L x S px (long x short), u px per mm, margins ML along the film and MS across it. */
function layout(style, W, H) {
  const L = Math.max(W, H), S = Math.min(W, H), u = L / FRAME_MM;
  const m = style === 'nero' ? [BAND * L, BAND * L]
    : style === 'limato' ? [(BAND + FILED_CARRIER) * L, (BAND + FILED_CARRIER) * L]
    : style === 'intera' ? [(GAP + CARRIER_MM) * u, (RAIL + CARRIER_MM) * u] : [0, 0];
  const ML = Math.round(m[0]), MS = Math.round(m[1]);
  return { portrait: H > W, L, S, u, ML, MS, FW: L + 2 * ML, FH: S + 2 * MS };
}

/** Integer px added on each side of a W x H picture: left = right = mx, top = bottom = my. */
export function frameMargins(style, W, H) {
  const g = layout(style, W, H);
  return g.portrait ? { mx: g.MS, my: g.ML } : { mx: g.ML, my: g.MS };
}

/** An edge's offset (px) at every px along it: f(mm) at the px centre, mm counted from the canvas's film origin. */
function sampleEdge(n, u, f) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = f((i + 0.5) / u) * u;
  return a;
}

/**
 * Signed distance (px, > 0 outside) to a rectangle with rounded corners whose sides are moved inwards by per-px offsets
 * (px): l / r indexed by the film row, t / b by the film column. Corner radii (px) [top-left, top-right, bottom-right,
 * bottom-left].
 */
function roughRect(x0, y0, x1, y1, l, r, t, b, radii) {
  const nx = t.length - 1, ny = l.length - 1;
  return (x, y) => {
    const iy = y <= 0 ? 0 : y >= ny ? ny : y | 0, ix = x <= 0 ? 0 : x >= nx ? nx : x | 0;
    const xl = x0 + l[iy], xr = x1 - r[iy], yt = y0 + t[ix], yb = y1 - b[ix];
    const left = 2 * x < xl + xr, top = 2 * y < yt + yb;
    const rad = radii[top ? (left ? 0 : 1) : (left ? 3 : 2)];
    const qx = (left ? xl - x : x - xr) + rad, qy = (top ? yt - y : y - yb) + rad;
    const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rad;
  };
}

/**
 * The camera gate: the picture's window, its sides moved 1-3 px (at 12 MP) inwards along a slow wave and a slight tilt.
 * `safe`: film-space box where the picture is certainly whole (nothing to draw).
 */
function gate(R, g) {
  const { u, ML, MS, L, S, FW, FH } = g, lenL = L / u, lenS = S / u;
  const eat = (along, origin, len) => {
    const sd = (R() * 4294967296) >>> 0, tilt = (R() - 0.5) * GATE_TILT;
    return sampleEdge(along, u, (s) => {
      // waves of ~9, 2.5 and 0.5 mm: a machined edge, straight to the eye, not to a ruler
      const n = 0.6 * noise1(sd, s / 9) + 0.3 * noise1(sd + 1, s / 2.5) + 0.1 * noise1(sd + 2, s / 0.5);
      const e = (GATE_EAT[0] + GATE_EAT[1]) / 2 + (GATE_EAT[1] - GATE_EAT[0]) / 2 * n + tilt * ((s - origin) / len - 0.5);
      return Math.max(GATE_EAT[0] / 2, e);
    });
  };
  const oL = ML / u, oS = MS / u;
  const l = eat(FH, oS, lenS), r = eat(FH, oS, lenS), t = eat(FW, oL, lenL), b = eat(FW, oL, lenL);
  const rad = GATE_RADIUS * u, ramp = rampPx(GATE_RAMP, u);
  const sdf = roughRect(ML, MS, ML + L, MS + S, l, r, t, b, [rad, rad, rad, rad]);
  const inset = (GATE_EAT[1] + GATE_TILT) * u + rad + ramp + 2;
  return { sdf, ramp, safe: [ML + inset, MS + inset, ML + L - inset, MS + S - inset] };
}

/** Image coverage of the gate at (x, y); cheap outside the picture's box (no picture there). */
function gateCover(G, x, y, x0, y0, x1, y1) {
  if (x < x0 || y < y0 || x > x1 || y > y1) return 0;
  return inside(G.sdf(x, y), G.ramp);
}

/**
 * The filed opening (limato): the picture's box grown by the band plus a rough offset of up to FILED_ROUGH. Each side is a
 * chain of straight file strokes (random length and slope) with a small jitter on top.
 */
function filedOpening(R, g) {
  const { u, ML, MS, L, S, FW, FH } = g, band = BAND * L, rough = FILED_ROUGH * L / u;
  const side = (along) => {
    const len = along / u, bp = [], v = [];
    let w = R();
    for (let s = -1; s < len + 1; s += FILED_FACET[0] + (FILED_FACET[1] - FILED_FACET[0]) * R()) {
      w = R() < 0.1 ? 0.85 + 0.15 * R() : 0.5 * w + 0.5 * R();   // mean-reverting, with the odd deep bite of the file
      bp.push(s); v.push(rough * w * w);                          // squared: mostly shallow, rarely the full depth
    }
    bp.push(len + 3); v.push(v[v.length - 1]);
    const sd = (R() * 4294967296) >>> 0;
    return sampleEdge(along, u, (s) => {
      let lo = 0, hi = bp.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bp[m] <= s) lo = m; else hi = m; }
      const f = (s - bp[lo]) / (bp[hi] - bp[lo]);
      const facet = v[lo] + (v[hi] - v[lo]) * f;
      // jitter: file teeth (0.04 mm) and the hand's tremor (0.15 mm), ~1-2 px at 12 MP
      const jit = 0.008 * noise1(sd, s / 0.04) + 0.012 * noise1(sd + 1, s / 0.15);
      return -Math.max(0, facet + jit);                         // negative: the opening grows outwards
    });
  };
  const radii = [0, 1, 2, 3].map(() => (FILED_RADIUS[0] + (FILED_RADIUS[1] - FILED_RADIUS[0]) * R()) * u);
  const sdf = roughRect(ML - band, MS - band, ML + L + band, MS + S + band, side(FH), side(FH), side(FW), side(FW), radii);
  return { sdf, ramp: rampPx(FILED_RAMP, u) };
}

// ---------- colours ----------

const GRAIN_TILE = 512;                // px, side of the grain tile: repeats too far apart to show in near-black
const GRAIN_CELLS = 320;               // clump lattice cells across the tile: 1.6 px clumps (a 12 MP scan's grain), wrapping seamlessly
/** A tile of film grain (≈ [-1, 1]): the soft clump plus per-pixel noise, the scanner's look of the rebate's grain. */
function grainTile(sd) {
  const n = GRAIN_TILE, c = GRAIN_CELLS, t = new Float32Array(n * n);
  const lat = (i, j) => 2 * hash(sd, i % c, j % c) - 1;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const fx = x * c / n, fy = y * c / n, i = fx | 0, j = fy | 0, a = smooth(fx - i), b = smooth(fy - j);
    const clump = (lat(i, j) * (1 - a) + lat(i + 1, j) * a) * (1 - b) + (lat(i, j + 1) * (1 - a) + lat(i + 1, j + 1) * a) * b;
    t[y * n + x] = 0.65 * clump + 0.35 * (2 * hash(sd + 1, x, y) - 1);
  }
  return t;
}

/**
 * The slow fields of the film-space canvas (rebate unevenness, the carrier's sheen), sampled every ~0.1 mm and
 * interpolated: they vary over mm, a per-pixel evaluation would cost the most of the frame for nothing.
 */
function slowFields(sd, g) {
  const { u, FW, FH } = g, step = Math.max(1, Math.round(0.1 * u)), nx = Math.ceil(FW / step) + 2, ny = Math.ceil(FH / step) + 2;
  const reb = new Float32Array(nx * ny), car = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const xm = i * step / u, ym = j * step / u;
    // rebate: 4 mm and 1 mm patches; carrier: 3 mm
    reb[j * nx + i] = 1 + REBATE_UNEVEN * (0.7 * noise2(sd, xm / 4, ym / 4) + 0.3 * noise2(sd + 1, xm, ym));
    car[j * nx + i] = CARRIER_UNEVEN * noise2(sd + 2, xm / 3, ym / 3);
  }
  const at = (f, x, y) => {
    const fx = x / step, fy = y / step, i = fx | 0, j = fy | 0, a = fx - i, b = fy - j, k = j * nx + i;
    return (f[k] * (1 - a) + f[k + 1] * a) * (1 - b) + (f[k + nx] * (1 - a) + f[k + nx + 1] * a) * b;
  };
  return { rebate: (x, y) => at(reb, x, y), carrier: (x, y) => at(car, x, y) };
}

/** The film's colours at film px (x, y) / canvas px (cx, cy), into `c` (floats, 0-255). */
function palette(seed) {
  const R = rng(seed), sd = (R() * 4294967296) >>> 0, tile = grainTile(sd + 3), m = GRAIN_TILE - 1;
  let slow = null;
  const grain = (cx, cy) => tile[(cy & m) * GRAIN_TILE + (cx & m)];
  // chroma grain: the same tile read elsewhere, so independent of the mono grain at this pixel
  const chroma = (cx, cy) => tile[((cy + 211) & m) * GRAIN_TILE + ((cx + 347) & m)];
  return {
    init(g) { slow = slowFields(sd, g); return this; },
    rebate(c, x, y, cx, cy) {
      const k = slow.rebate(x, y) * (1 + REBATE_GRAIN * grain(cx, cy)), ch = 0.3 * REBATE_GRAIN * chroma(cx, cy);
      c[0] = REBATE[0] * k * (1 + ch); c[1] = REBATE[1] * k; c[2] = REBATE[2] * k * (1 - ch);
    },
    /** Mix `c` towards the carrier's white by `t`. */
    carrier(c, t, x, y, cx, cy) {
      if (t <= 0) return;
      const d = slow.carrier(x, y) + 0.4 * grain(cx, cy);
      for (let k = 0; k < 3; k++) c[k] += (CARRIER[k] + d - c[k]) * t;
    },
    /** Mix `c` towards the hole's black by `t` (the scanner's own noise only). */
    hole(c, t, cx, cy) {
      const d = 0.3 * chroma(cx, cy);
      for (let k = 0; k < 3; k++) c[k] += (HOLE[k] * (1 + d) - c[k]) * t;
    },
    seed: sd,
  };
}

function put(out, o, c, a) { out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255 * a; }

// ---------- edge print (intera) ----------

const arc = (cx, cy, rx, ry, a0, a1, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
const PI = Math.PI;
const SIX = [[...arc(0.31, 0.5, 0.29, 0.5, -0.3 * PI, -PI, 8), [0.02, 0.69]], arc(0.31, 0.69, 0.29, 0.31, 0, 2 * PI, 20)];
// Glyph skeletons: polylines in a box 1 high (y down), `w` wide; '>' is a filled triangle (an arrow).
const GLYPHS = {
  '0': { w: 0.6, lines: [arc(0.3, 0.5, 0.3, 0.5, 0, 2 * PI, 24)] },
  '1': { w: 0.36, lines: [[[0.02, 0.22], [0.28, 0], [0.28, 1]]] },
  '2': { w: 0.6, lines: [[...arc(0.3, 0.29, 0.29, 0.29, -0.95 * PI, 0.2 * PI, 14), [0.02, 1], [0.6, 1]]] },
  '3': { w: 0.6, lines: [arc(0.3, 0.25, 0.27, 0.25, -0.9 * PI, 0.5 * PI, 12), arc(0.3, 0.75, 0.3, 0.25, -0.5 * PI, 0.9 * PI, 12)] },
  '4': { w: 0.62, lines: [[[0.46, 1], [0.46, 0], [0, 0.7], [0.62, 0.7]]] },
  '5': { w: 0.6, lines: [[[0.56, 0], [0.1, 0], [0.06, 0.46], ...arc(0.3, 0.68, 0.3, 0.32, -0.75 * PI, 0.85 * PI, 16)]] },
  '6': { w: 0.6, lines: SIX },
  '7': { w: 0.6, lines: [[[0, 0], [0.6, 0], [0.2, 1]]] },
  '8': { w: 0.6, lines: [arc(0.3, 0.255, 0.25, 0.245, 0, 2 * PI, 20), arc(0.3, 0.735, 0.3, 0.265, 0, 2 * PI, 20)] },
  '9': { w: 0.6, lines: SIX.map((l) => l.map(([x, y]) => [0.62 - x, 1 - y])) },
  'A': { w: 0.66, lines: [[[0, 1], [0.33, 0], [0.66, 1]], [[0.13, 0.64], [0.53, 0.64]]] },
  '>': { w: 0.62, fill: [[0, 0.16], [0.62, 0.5], [0, 0.84]] },
};
const TRACKING = 0.32;                 // gap between glyphs, in glyph heights (stroke included)

/** Distance (mm) from (x, y) to segment a-b. */
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, px = x - ax, py = y - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
  const ex = px - dx * t, ey = py - dy * t;
  return Math.sqrt(ex * ex + ey * ey);
}

/** One glyph placed in film mm: segments (flat [ax, ay, bx, by, ...]), a filled triangle or none, and its box in film px. */
function placeGlyph(gl, x0, ym, u, ML, MS, gain) {
  const h = PRINT.height, top = ym - h / 2, P = ([x, y]) => [x0 + x * h, top + y * h];
  const segs = [], tri = gl.fill ? gl.fill.map(P).flat() : null;
  for (const line of gl.lines || [gl.fill.concat([gl.fill[0]])]) {
    const pts = line.map(P);
    for (let i = 1; i < pts.length; i++) segs.push(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  const reach = PRINT.stroke * h + 5 * PRINT.glow;
  return { segs, tri, gain,
    box: [ML + (x0 - reach) * u, MS + (top - reach) * u, ML + (x0 + gl.w * h + reach) * u, MS + (top + h + reach) * u] };
}

/** The edge print's glyphs: rails' text centred between the holes' inner edge and the picture. */
function edgePrint(R, g) {
  const { u, ML, MS, S } = g, band = RAIL - PERF_EDGE - PERF.across / 2, glyphs = [];
  for (const [rail, x, label] of PRINT_ITEMS) {
    const ym = rail ? S / u + band / 2 : -band / 2, gain = 0.85 + 0.15 * R();
    let xm = x;
    for (const ch of label) {
      const gl = GLYPHS[ch];
      // each glyph a touch off the line and of its own strength: the printing head's flicker
      glyphs.push(placeGlyph(gl, xm, ym + (R() - 0.5) * 0.03, u, ML, MS, gain * (0.92 + 0.08 * R())));
      xm += (gl.w + TRACKING) * PRINT.height;
    }
  }
  return glyphs;
}

/** The print's strength (0..1) at film mm (xm, ym) inside the glyph `G`'s box. */
function glyphInk(G, xm, ym) {
  let d = Infinity;
  const s = G.segs;
  for (let i = 0; i < s.length; i += 4) d = Math.min(d, segDist(xm, ym, s[i], s[i + 1], s[i + 2], s[i + 3]));
  const half = PRINT.stroke * PRINT.height / 2;
  if (G.tri && inTriangle(G.tri, xm, ym)) d = -d;
  else if (!G.tri) d -= half;
  const core = smooth(0.5 - d / PRINT.ramp), glow = PRINT.halo * Math.exp(-Math.max(0, d) / PRINT.glow);
  return Math.min(1, core + glow) * G.gain;
}
function inTriangle(t, x, y) {
  const s = (ax, ay, bx, by) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const a = s(t[0], t[1], t[2], t[3]), b = s(t[2], t[3], t[4], t[5]), c = s(t[4], t[5], t[0], t[1]);
  return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0);
}

// ---------- styles ----------
// Each returns the film-space layout plus `shade(x, y, cx, cy, out, o)`: the RGBA at film px (x, y), canvas px (cx, cy).

function sceneNero(seed, g) {
  const R = rng(seed), G = gate(R, g), P = palette(R() * 4294967296).init(g), c = [0, 0, 0];
  const { ML, MS, L, S } = g;
  return { ...g, safe: G.safe, shade(x, y, cx, cy, out, o) {
    P.rebate(c, x, y, cx, cy);
    put(out, o, c, 1 - gateCover(G, x, y, ML, MS, ML + L, MS + S));
  } };
}

function sceneLimato(seed, g) {
  const R = rng(seed), G = gate(R, g), F = filedOpening(R, g), P = palette(R() * 4294967296).init(g), c = [0, 0, 0];
  const { ML, MS, L, S } = g;
  return { ...g, safe: G.safe, shade(x, y, cx, cy, out, o) {
    P.rebate(c, x, y, cx, cy);
    const white = 1 - inside(F.sdf(x, y), F.ramp);
    P.carrier(c, white, x, y, cx, cy);
    put(out, o, c, 1 - gateCover(G, x, y, ML, MS, ML + L, MS + S) * (1 - white));
  } };
}

function sceneIntera(seed, g) {
  const R = rng(seed), G = gate(R, g), P = palette(R() * 4294967296).init(g), sd = P.seed, c = [0, 0, 0];
  const { u, ML, MS, L, S, FW } = g, Lm = L / u, Sm = S / u;
  // the film's slit edges: straight, a ±0.005 mm wander over ~6 mm
  const edge = () => { const e = (R() * 4294967296) >>> 0; return sampleEdge(FW, u, (s) => 0.005 * noise1(e, s / 6)); };
  const top = edge(), bot = edge();
  // the carrier's mask past the strip's ends: straight, a little skewed (±0.04 mm across the film)
  const skew = [(R() - 0.5) * 0.08, (R() - 0.5) * 0.08];
  const filmRamp = rampPx(FILM_EDGE_RAMP, u), maskRamp = rampPx(MASK_RAMP, u), perfRamp = rampPx(PERF_RAMP, u);
  const glyphs = edgePrint(R, g), mid = Lm / 2, edgeMm = perfRamp / u;
  const holeY = [-RAIL + PERF_EDGE, Sm + RAIL - PERF_EDGE], hx = PERF.along / 2 - PERF.r, hy = PERF.across / 2 - PERF.r;
  const printBand = [MS - (RAIL - PERF_EDGE) * u, MS + S + (RAIL - PERF_EDGE) * u];   // holes' centres: the print is between
  // the glyphs whose box reaches each film column (most columns: none)
  const byCol = Array.from({ length: FW }, () => null);
  for (const G of glyphs) for (let x = Math.max(0, G.box[0] | 0); x <= Math.min(FW - 1, G.box[2]); x++) (byCol[x] ||= []).push(G);

  const film = (x, y, xm, ym) => {
    const ix = x <= 0 ? 0 : x >= FW - 1 ? FW - 1 : x | 0;
    const side = Math.max(MS - RAIL * u + top[ix] - y, y - (MS + S + RAIL * u - bot[ix]));
    const t = (ym - Sm / 2) / Sm;
    const end = Math.max(-GAP + skew[0] * t - xm, xm - (Lm + GAP + skew[1] * t)) * u;
    return inside(side, filmRamp) * inside(end, maskRamp);
  };
  const hole = (xm, ym) => {
    const yc = ym < Sm / 2 ? holeY[0] : holeY[1];
    const xc = mid + (Math.floor((xm - mid) / PERF.pitch) + 0.5) * PERF.pitch;   // symmetric about the picture's centre
    if (Math.abs(ym - yc) > PERF.across / 2 + edgeMm || Math.abs(xm - xc) > PERF.along / 2 + edgeMm) return 0;
    const qx = Math.abs(xm - xc) - hx, qy = Math.abs(ym - yc) - hy;
    const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
    const d = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - PERF.r;
    return inside(d * u, perfRamp);
  };
  const ink = (x, y, xm, ym) => {
    let t = 0;
    const near = byCol[x | 0];
    if (!near) return 0;
    for (const G of near) {
      const b = G.box;
      if (y >= b[1] && y <= b[3]) t = 1 - (1 - t) * (1 - glyphInk(G, xm, ym));
    }
    if (!t) return 0;
    // uneven: patches of 0.25 mm and a fine 0.04 mm mottle
    return PRINT.peak * t * (0.82 + 0.12 * noise2(sd + 7, xm / 0.25, ym / 0.25) + 0.06 * noise2(sd + 8, xm / 0.04, ym / 0.04));
  };

  return { ...g, safe: G.safe, shade(x, y, cx, cy, out, o) {
    const xm = (x - ML) / u, ym = (y - MS) / u, f = film(x, y, xm, ym);
    if (f <= 0) { c[0] = c[1] = c[2] = 0; P.carrier(c, 1, x, y, cx, cy); put(out, o, c, 1); return; }
    P.rebate(c, x, y, cx, cy);
    if (y < MS || y > MS + S) {
      if (y > printBand[0] && y < printBand[1]) {
        const t = ink(x, y, xm, ym);
        if (t) for (let k = 0; k < 3; k++) c[k] = 255 - (255 - c[k]) * (1 - t * AMBER[k] / 255);   // screen: light added
      }
      const p = hole(xm, ym);
      if (p > 0) P.hole(c, p, cx, cy);
    }
    P.carrier(c, 1 - f, x, y, cx, cy);
    put(out, o, c, 1 - gateCover(G, x, y, ML, MS, ML + L, MS + S) * f);
  } };
}

const SCENES = { nero: sceneNero, limato: sceneLimato, intera: sceneIntera };
let cached = null;                     // the last scene: an export draws the same frame strip after strip
function scene(style, seed, W, H) {
  const key = `${style}|${seed}|${W}x${H}`;
  if (cached?.key !== key) cached = { key, s: SCENES[style](seed >>> 0, layout(style, W, H)) };
  return cached.s;
}

/**
 * Draw the frame into `out` (RGBA, w*h*4): the region (x0, y0, w, h) of the canvas (W + 2 mx) x (H + 2 my) that holds the
 * W x H picture at (mx, my) (frameMargins). Straight RGBA: the frame's colour, alpha its coverage (255 on the frame, 0 on
 * the picture away from the gate's edge, partial along it); the caller composites it over the picture.
 */
export function drawFrame(out, style, seed, W, H, x0, y0, w, h) {
  if (!SCENES[style]) { out.fill(0, 0, w * h * 4); return; }
  const F = scene(style, seed, W, H), { portrait, FH, safe } = F;
  for (let y = 0; y < h; y++) {
    const cy = y0 + y, row = y * w * 4;
    // the picture's untouched span on this row (film x along a landscape row; film y, reversed, along a portrait one)
    let s0 = w, s1 = w;
    const [a, b, lo, hi] = portrait ? [safe[0], safe[2], FH - safe[3], FH - safe[1]] : [safe[1], safe[3], safe[0], safe[2]];
    if (cy + 0.5 > a && cy + 0.5 < b) {
      s0 = Math.min(w, Math.max(0, Math.ceil(lo - 0.5) - x0));
      s1 = Math.min(w, Math.max(s0, Math.floor(hi - 0.5) - x0));
    }
    const px = (x) => {
      const cx = x0 + x;
      if (portrait) F.shade(cy + 0.5, FH - cx - 0.5, cx, cy, out, row + 4 * x);
      else F.shade(cx + 0.5, cy + 0.5, cx, cy, out, row + 4 * x);
    };
    for (let x = 0; x < s0; x++) px(x);
    out.fill(0, row + 4 * s0, row + 4 * s1);
    for (let x = s1; x < w; x++) px(x);
  }
}
