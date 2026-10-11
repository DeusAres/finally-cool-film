// Output pass of the engine's process_frame: Rec.2020 -> Display P3 (soft gamut
// compression) for P3 photos, the 8-bit pack through the LUT, and a soft floor at black.
// Film grain is NOT here any more: it is the engine's (film_render.grain, rng 'hash',
// see eval/GRAIN.md), so it is the same on GPU, CPU and every export tile.

import { wf, wv3 } from './util.js';
import { SRGB_WGSL, REC2020_TO_P3, srgbToLinear, linearToSrgb } from './color.js';

// ACES-style soft gamut compression (rgc): threshold, the distance that maps to the edge, power.
const RGC = { thr: 0.9, lim: 1.3, pw: 1.2 };

export const GRAIN_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
// P[] layout (the engine prepends 4 slots, so packParams' first value is P[4]):
//   P[4] = 1: the engine output is Rec.2020 -> convert to Display P3 here, with
//        ACES-style per-channel soft gamut compression (see toP3)
fn q(v: f32) -> f32 { return f32(lut[u32(clamp(v * 4095.0 + 0.5, 0.0, 4095.0))]) / 255.0; }

${SRGB_WGSL}
// One channel's distance from the achromatic axis compressed beyond THR so that
// LIM (the farthest a film colour lands outside P3) maps exactly to the gamut edge.
fn rgc(d: f32) -> f32 {
  let thr = ${wf(RGC.thr)}; let lim = ${wf(RGC.lim)}; let pw = ${wf(RGC.pw)};
  if (d < thr) { return d; }
  let scl = (lim - thr) / pow(pow((1.0 - thr) / (lim - thr), -pw) - 1.0, 1.0 / pw);
  let x = (d - thr) / scl;
  return thr + scl * x / pow(1.0 + pow(x, pw), 1.0 / pw);
}
// Rec.2020 (sRGB-encoded) → Display P3 (sRGB-encoded). Film colours a little
// outside P3 (dark saturated browns, deep reds) are pulled in along their own
// channel instead of clipping to 0, which would rotate the hue and flatten them.
fn toP3(e: vec3<f32>) -> vec3<f32> {
  let l = srgbDec(e);
  var p = vec3<f32>(${REC2020_TO_P3.map((r) => `dot(${wv3(r)}, l)`).join(', ')});
  let a = max(p.x, max(p.y, p.z));
  if (a > 0.0) {
    let d = (vec3<f32>(a) - p) / a;
    p = vec3<f32>(a) - vec3<f32>(rgc(d.x), rgc(d.y), rgc(d.z)) * a;
  }
  return srgbEnc(p);
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  var c = vec3<f32>(src[3u * i], src[3u * i + 1u], src[3u * i + 2u]);   // the engine's positive, sRGB-encoded
  if (P[4] > 0.5) { c = toP3(c); }
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

/** Number of f32 slots GRAIN_WGSL reads after the engine's own 4 (P[4]). */
export const PACK_PARAMS_LEN = 1;

/** Params for GRAIN_WGSL (P[4]): `rec2020ToP3`: the engine output is Rec.2020 and the photo is Display P3. */
export function packParams(rec2020ToP3 = false) {
  const p = new Float32Array([rec2020ToP3 ? 1 : 0]);
  if (p.length !== PACK_PARAMS_LEN) throw new Error('GRAIN_WGSL uniform layout mismatch');
  return p;
}

// CPU twin of toP3 in GRAIN_WGSL, for the no-WebGPU path and the export mat: `px` is one
// engine output pixel (sRGB-encoded Rec.2020), converted in place to sRGB-encoded Display P3.
const RGC_SCL = (RGC.lim - RGC.thr) / (((1 - RGC.thr) / (RGC.lim - RGC.thr)) ** -RGC.pw - 1) ** (1 / RGC.pw);
const rgcCPU = (d) => { if (d < RGC.thr) return d; const x = (d - RGC.thr) / RGC_SCL; return RGC.thr + RGC_SCL * x / (1 + x ** RGC.pw) ** (1 / RGC.pw); };
export function toP3CPU(px) {
  const r = srgbToLinear(px[0]), g = srgbToLinear(px[1]), b = srgbToLinear(px[2]);
  const [m0, m1, m2] = REC2020_TO_P3;   // no per-pixel allocation
  let p0 = m0[0] * r + m0[1] * g + m0[2] * b, p1 = m1[0] * r + m1[1] * g + m1[2] * b, p2 = m2[0] * r + m2[1] * g + m2[2] * b;
  const a = Math.max(p0, p1, p2);
  if (a > 0) { p0 = a - rgcCPU((a - p0) / a) * a; p1 = a - rgcCPU((a - p1) / a) * a; p2 = a - rgcCPU((a - p2) / a) * a; }
  px[0] = linearToSrgb(p0); px[1] = linearToSrgb(p1); px[2] = linearToSrgb(p2);
}
