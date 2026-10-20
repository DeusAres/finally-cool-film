// Output pass of the engine's process_frame: Rec.2020 -> Display P3 or sRGB (soft gamut
// compression) when the engine renders wide, the 8-bit pack through the LUT, and a soft floor at black.
// Film grain is NOT here any more: it is the engine's (film_render.grain, rng 'hash',
// see eval/GRAIN.md), so it is the same on GPU, CPU and every export tile.

import { wf, wv3 } from './util.js';
import { SRGB_WGSL, REC2020_TO_P3, REC2020_TO_SRGB, LUMA, srgbToLinear, linearToSrgb } from './color.js';
import { INVERT_WGSL, INVERT_LEN } from './invert.js';

// ACES-style soft gamut compression (rgc) into each output space: threshold, the distance that maps to the edge, power.
// P3: thr 0.9 / lim 1.3 (measured on film colours, v2). sRGB (v4, web / Instagram): lim 1.6 covers the farthest Rec.2020
// colour from sRGB (the cyan secondary, distance 1.59), so everything the engine renders lands inside; thr 0.8
// leaves 80 % of the way to the edge untouched (unverified: chosen so saturated reds keep their gradation instead of a flat
// clip). `fitWhite` (sRGB only): the matrix pushes bright warm tones past 1 in R (a cream highlight at Rec.2020 0.95/0.85/0.60
// gives R 259/255) and the distance compression never limits the peak. A pixel whose largest channel is over 1 is pulled
// towards its own luminance (Rec.709) until that channel is 1: luminance and hue kept, a little saturation given up; a pixel
// already inside (every neutral, every white up to 255) is untouched; one brighter than white becomes white. P3 (v3): none.
const GAMUT = {
  p3: { id: 1, M: REC2020_TO_P3, thr: 0.9, lim: 1.3, pw: 1.2, fitWhite: false },
  srgb: { id: 2, M: REC2020_TO_SRGB, thr: 0.8, lim: 1.6, pw: 1.2, fitWhite: true },
};
const LUMA709 = LUMA.srgb;   // Rec.709 / sRGB luminance weights (color.js)
const rgcScale = (g) => (g.lim - g.thr) / (((1 - g.thr) / (g.lim - g.thr)) ** -g.pw - 1) ** (1 / g.pw);
// One channel's distance from the achromatic axis compressed beyond thr so that lim maps exactly to the gamut edge.
const rgcWGSL = (name, g) => `fn ${name}(d: f32) -> f32 {
  if (d < ${wf(g.thr)}) { return d; }
  let x = (d - ${wf(g.thr)}) / ${wf(rgcScale(g))};
  return ${wf(g.thr)} + ${wf(rgcScale(g))} * x / pow(1.0 + pow(x, ${wf(g.pw)}), ${wf(1 / g.pw)});
}`;
// Rec.2020 (sRGB-encoded) → the output space (sRGB-encoded). Film colours outside it are pulled in along their own channel
// instead of clipping to 0, which would rotate the hue and flatten them.
const toSpaceWGSL = (name, g) => `${rgcWGSL(name + 'Rgc', g)}
fn ${name}(e: vec3<f32>) -> vec3<f32> {
  let l = srgbDec(e);
  var p = vec3<f32>(${g.M.map((r) => `dot(${wv3(r)}, l)`).join(', ')});
  let a = max(p.x, max(p.y, p.z));
  if (a > 0.0) {
    let d = (vec3<f32>(a) - p) / a;
    p = vec3<f32>(a) - vec3<f32>(${name}Rgc(d.x), ${name}Rgc(d.y), ${name}Rgc(d.z)) * a;
  }${g.fitWhite ? `
  let m = max(p.x, max(p.y, p.z));
  if (m > 1.0) {
    let y = dot(${wv3(LUMA709)}, p);
    p = select(vec3<f32>(y) + (p - vec3<f32>(y)) * ((1.0 - y) / (m - y)), vec3<f32>(1.0), y >= 1.0);
  }` : ''}
  return srgbEnc(p);
}`;

export const OUTPUT_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
// P[] layout (the engine prepends 4 slots, so packParams' first value is P[4]):
//   P[4] = 1 / 2: the engine output is Rec.2020 -> convert to Display P3 / sRGB here, with
//        ACES-style per-channel soft gamut compression (GAMUT); 0: the engine output is already final
//   P[5] = 1: v4, the engine output is the negative's scan -> invert it first (invert.js), uniforms at P[6..14]
fn q(v: f32) -> f32 { return f32(lut[u32(clamp(v * 4095.0 + 0.5, 0.0, 4095.0))]) / 255.0; }

${SRGB_WGSL}
${INVERT_WGSL}
${toSpaceWGSL('toP3', GAMUT.p3)}
${toSpaceWGSL('toSRGB', GAMUT.srgb)}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  var c = vec3<f32>(src[3u * i], src[3u * i + 1u], src[3u * i + 2u]);   // the engine's positive (v4: negative), sRGB-encoded
  if (P[5] > 0.5) { c = srgbEnc(invertNeg(c, 6u)); }
  if (P[4] > 1.5) { c = toSRGB(c); } else if (P[4] > 0.5) { c = toP3(c); }
  c = vec3<f32>(q(c.x), q(c.y), q(c.z));
  // Soft floor at black: unchanged a few levels above it, approaching it below (softplus),
  // so the engine's grain, already added, never leaves pure-black specks in the deepest shadows. Black itself
  // comes from the scanner (frontier.black_lift).
  let k = 2.0 / 255.0; let b = -2.0 * k;          // black maps to itself within 0.3 levels; there is room below it
  let x = (c - b) / k;                         // stable softplus: max(x,0) + log(1 + e^-|x|)
  c = b + k * (max(x, vec3<f32>(0.0)) + log(vec3<f32>(1.0) + exp(-abs(x))));
  let o = vec3<u32>(round(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
  dst[i] = o.x | (o.y << 8u) | (o.z << 16u) | 0xff000000u;
}`;

/** Number of f32 slots OUTPUT_WGSL reads after the engine's own 4 (P[4]). */
const PACK_PARAMS_LEN = 2 + INVERT_LEN;

/** Params for OUTPUT_WGSL (P[4..]): `to`: 'p3' | 'srgb' when the engine output is Rec.2020 and must be mapped into that
 * space, null when it is already final; `inv`: v4 inversion uniforms (invert.js invertUniform), or null for the engine's positive. */
export function packParams(to = null, inv = null) {
  const p = new Float32Array([to ? GAMUT[to].id : 0, inv ? 1 : 0, ...(inv ?? new Array(INVERT_LEN).fill(0))]);
  if (p.length !== PACK_PARAMS_LEN) throw new Error('OUTPUT_WGSL uniform layout mismatch');
  return p;
}

// CPU twin of toP3 / toSRGB in OUTPUT_WGSL, for the no-WebGPU path and the export mat: `px` is one engine output pixel
// (sRGB-encoded Rec.2020), converted in place to the sRGB-encoded output space `to` ('p3' | 'srgb').
const RGC_CPU = Object.fromEntries(Object.entries(GAMUT).map(([k, g]) => {
  const scl = rgcScale(g);
  return [k, (d) => { if (d < g.thr) return d; const x = (d - g.thr) / scl; return g.thr + scl * x / (1 + x ** g.pw) ** (1 / g.pw); }];
}));
export function toSpaceCPU(px, to) {
  const g = GAMUT[to], rgc = RGC_CPU[to];   // per-space constants built once, not per pixel
  const r = srgbToLinear(px[0]), gr = srgbToLinear(px[1]), b = srgbToLinear(px[2]);
  const [m0, m1, m2] = g.M;   // no per-pixel allocation
  let p0 = m0[0] * r + m0[1] * gr + m0[2] * b, p1 = m1[0] * r + m1[1] * gr + m1[2] * b, p2 = m2[0] * r + m2[1] * gr + m2[2] * b;
  const a = Math.max(p0, p1, p2);
  if (a > 0) { p0 = a - rgc((a - p0) / a) * a; p1 = a - rgc((a - p1) / a) * a; p2 = a - rgc((a - p2) / a) * a; }
  const m = Math.max(p0, p1, p2);
  if (g.fitWhite && m > 1) {
    const y = LUMA709[0] * p0 + LUMA709[1] * p1 + LUMA709[2] * p2;
    if (y >= 1) { p0 = p1 = p2 = 1; } else { const f = (1 - y) / (m - y); p0 = y + (p0 - y) * f; p1 = y + (p1 - y) * f; p2 = y + (p2 - y) * f; }
  }
  px[0] = linearToSrgb(p0); px[1] = linearToSrgb(p1); px[2] = linearToSrgb(p2);
}
