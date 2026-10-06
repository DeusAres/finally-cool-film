// WebGPU input stage: lens (lens.js has the model and the CPU reference) + tone
// + colour matrix, run by the engine as the first pass of its GPU chain
// (spektrafilm-wasm `process_frame`), so the photo crosses to the GPU once, as
// an 8-bit texture, and no float frame ever crosses JS↔wasm. The texture is
// rgba8unorm-srgb: the sampler decodes to LINEAR light before filtering, so
// every bilinear tap is interpolated in linear light, as in the CPU path.
// Output: linear Rec.2020 (p3) or linear sRGB floats, interleaved RGB, for the region.
import { LENS_CONST, lensGeometry } from './lens.js';
import { P3_TO_REC2020, LUMA_P3 } from './color.js';
import { TONE_SQRT_N } from './tone.js';
import { CLIP_GAIN } from './common.js';
import { FRAME_UM, wf, wv3 } from './util.js';

const { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B } = LENS_CONST;

// Optical restore (INPUT_WGSL), µm on the 36 mm frame. OPT_LENS_UM is the taking
// lens left on the image: Gaussian-equivalent sigma, MTF(f) = exp(-2 pi² sigma² f²)
// = 0.96 / 0.85 / 0.70 / 0.53 at 10 / 20 / 30 / 40 cy/mm (MTF50 42 cy/mm).
// The film's own MTF (emulsion scatter) belongs to the output pass, not here.
const OPT_LENS_UM = 4.5, OPT_RING_UM = 40, OPT_NEAR_UM = 18, OPT_FAR1_UM = 50, OPT_FAR2_UM = 80;
// Fine-detail compression (INPUT_WGSL), µm on the 36 mm frame: bilateral mean in
// log luminance on two 8-tap rings at FINE_R1/R2_UM (the 15-60 µm band); range
// weight exp(-FINE_K d²), d in stops (sigma 0.5 stop): texture of a few tenths of
// a stop (ISP crunch, waxy NR, sharpening texture) is pulled FINE_STRENGTH of the
// way to the mean, edges over ~1.5 stops keep their full step. Grain re-supplies
// fine texture. Node twin (scratchpad/micro/twin.mjs), fine/mid band-energy
// ratio: tuxcat 0.54 → 0.39, room 0.88 → 0.69 (with Texture 0.5 → 0.25).
const FINE_R1_UM = 20, FINE_R2_UM = 45, FINE_K = 2;
// Clipped-highlight gate: 8 taps alternating CLIP_R1/R2_UM. A clipped pixel
// whose UNclipped surround is near-white (gamma luma > ~0.85) is a surface just
// over the clip (white fabric, overcast sky), not a light source: its boost goes.
// A lamp / window / sun has a darker surround (or is all clipped) and keeps it.
const CLIP_R1_UM = 200, CLIP_R2_UM = 450;
// Slider mapping (Texture, Chiarezza) and the stages they drive, in µm on the 36 mm frame.
// Texture = micro-contrast: scale (µm), range k (per stop²), midtone width (stops), strength at ±1.
const MICRO_UM = 60, MICRO_K = 0.4, MICRO_MID_STOPS = 2.5, MICRO_MAX = 0.8;
// Chiarezza = glow: blur radius (µm), symmetric veil and one-sided bleed of light at 1.
const GLOW_UM = 220, GLOW_VEIL = 0.25, GLOW_BLEED = 0.6;
// Fine-detail compression strength (ISP crunch, with restore). Scanner optics sigma (output px).
const FINE_STRENGTH = 0.6, SCAN_PX = 0.6;


export const INPUT_WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, p3: f32, regionW: f32, regionH: f32,
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // P3 → Rec.2020 rows (xyz)
  clar: vec4<f32>,                             // micro-contrast radius (px), strength (Texture); optical blur variance (px²); glow (Chiarezza)
  opt: vec4<f32>,                              // optical restore: frame px per µm, strength; fine-detail strength, range k
};
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(4) var<storage, read> tone: array<f32>;   // tone.js 'packed': gain ++ scene, over sqrt(display linear)

fn lut(base: u32, v: f32) -> f32 {             // same lookup as tone.js
  let f = sqrt(clamp(v, 0.0, 1.0)) * ${TONE_SQRT_N}.0;
  let i = u32(f);
  if (i >= ${TONE_SQRT_N}u) { return tone[base + ${TONE_SQRT_N}u]; }
  return mix(tone[base + i], tone[base + i + 1u], f - f32(i));
}

fn at(pos: vec2<f32>) -> vec4<f32> {           // pos in frame pixel coords (pixel centres at integers)
  return textureSampleLevel(tex, smp, (pos + 0.5) / p.frame, 0.0);
}
const LW = ${wv3(LUMA_P3)};
fn gam(c: vec3<f32>) -> f32 {                 // luminance, gamma-encoded (where phone ISPs sharpen)
  return pow(max(dot(c, LW), 0.0) + 0.001, 1.0 / 2.2);
}
fn gamAt(pos: vec2<f32>) -> f32 { return gam(at(pos).rgb); }
fn box4(q: vec2<f32>, o: f32) -> vec3<f32> {   // four diagonal bilinear taps at ±o, averaged
  return 0.25 * (at(q + vec2<f32>(o, o)).rgb + at(q + vec2<f32>(-o, o)).rgb
               + at(q + vec2<f32>(o, -o)).rgb + at(q + vec2<f32>(-o, -o)).rgb);
}
// Gaussian-equivalent blur of variance s2 (px² per axis). Up to 1 px²: four diagonal
// bilinear taps at ±o make the separable kernel [o/2, 1-o, o/2] (variance o), blended
// by s2/o. Beyond: two such boxes at 0.6σ and 1.28σ (mean variance σ²), 8 taps.
fn soft(q: vec2<f32>, s2: f32) -> vec3<f32> {
  if (s2 <= 1.0) {
    let o = clamp(s2, 0.5, 1.0);
    let c = at(q).rgb;
    return c + (box4(q, o) - c) * min(s2 / o, 1.0);
  }
  let s = sqrt(s2);
  return 0.5 * (box4(q, 0.6 * s) + box4(q, 1.28 * s));
}
fn coverage(u: f32) -> f32 {                   // 0 on the axis, 1 at the farthest corner
  let raw = pow(1.0 + (u * ${VIG_T}) * (u * ${VIG_T}), -2.0);
  let r1 = pow(1.0 + ${VIG_T} * ${VIG_T}, -2.0);
  let soft = (1.0 - raw) / (1.0 - r1);
  let t = clamp((u - ${VIG_KNEE}) / (1.0 - ${VIG_KNEE}), 0.0, 1.0);
  return soft + (t * t * (3.0 - 2.0 * t) - soft) * p.falloff;
}

// A halo is only removed where the step D is a real edge and the excursion E a modest part of it.
fn gate(E: f32, D: f32, plateau: f32) -> f32 { return smoothstep(0.03, 0.08, D) * (1.0 - smoothstep(0.3, 0.55, E / max(D, 1e-4))) * plateau; }

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (f32(id.x) >= p.regionW || f32(id.y) >= p.regionH) { return; }
  let pos = p.origin + vec2<f32>(f32(id.x), f32(id.y));
  let d = pos - p.axis;
  let r = length(d);
  let g = coverage(min(r / p.rMax, 1.0));      // one curve drives both effects
  var c: vec3<f32>;
  var clipA = at(pos).a;                       // clipped-highlight weight (halo pixels lose it below)
  if (p.dR > 0.0 && r > 0.5) {
    let u = vec2<f32>(d.x / r, d.y / r * ${ANISO_Y});
    let oR = p.dR * g; let oB = p.dB * g; let L = p.blur * g;
    if (L < 0.5) {
      c = vec3<f32>(at(pos + u * oR).r, at(pos).g, at(pos + u * oB).b);
    } else {
      // Smear each channel along its own radial displacement (G too, at zero offset).
      let taps = i32(min(${CA_TAPS}.0, max(3.0, ceil(L) + 1.0)));
      let step = L / f32(taps - 1); let half = L * 0.5;
      var acc = vec3<f32>(0.0);
      for (var t = 0; t < taps; t++) {
        let o = f32(t) * step - half;
        acc += vec3<f32>(at(pos + u * (oR + o)).r, at(pos + u * o).g, at(pos + u * (oB + o)).b);
      }
      c = acc / f32(taps);
    }
  } else {
    c = at(pos).rgb;
  }
  // Optical softness, linear light, edges included (a phone frame is pixel-crisp; film is
  // not): taking lens (OPT_LENS_UM, with restore) + scanner optics (SCAN_PX, in output
  // pixels: a scan is never crisp at its own pixel). Gaussian-equivalent variance p.clar.z (px²), computed in inputUniform.
  // Not on clipped light (alpha): blurring a thin clipped source would drain the halation it feeds.
  if (p.clar.z > 0.0) {
    let s0 = at(pos);
    var c0 = s0.rgb;
    let a = 1.0 - s0.a;
    var bx = soft(pos, p.clar.z);
    if (p.dR > 0.0 && r > 0.5) {               // CA: R and B were sampled elsewhere, blur them there
      let u = vec2<f32>(d.x / r, d.y / r * ${ANISO_Y});
      let qR = pos + u * (p.dR * g); let qB = pos + u * (p.dB * g);
      c0 = vec3<f32>(at(qR).r, c0.g, at(qB).b);
      bx = vec3<f32>(soft(qR, p.clar.z).r, bx.g, soft(qB, p.clar.z).b);
    }
    c += (bx - c0) * a;
  }
  // Halo removal (OPT_* in µm on the 36 mm frame). A phone frame carries its ISP's
  // signature: unsharp-mask halos (bench: in-focus edges +6..9% overshoot,
  // -9% undershoot, MTF > 1 at 5-15 cy/mm). A camera lens on film has none.
  // 18 taps; reach 80 µm (≤ 10 px at 12 MP, inside the tile pad).
  if (p.opt.y > 0.0) {
    let k = p.opt.x;
    // 2. Halo removal. Edge normal from the first harmonic of an 8-tap ring;
    //    plateaus 50 / 80 µm out on each side; a pixel beyond the plateau
    //    envelope [lo, hi] is pulled back onto it. Not a halo (kept): no real
    //    edge (step under ~8-20 levels), sides that are not plateaus (texture), or
    //    an excursion that is a large fraction of the step (a real rim light or
    //    thin line; the near taps make the whole feature share one decision).
    var gv = vec2<f32>(0.0);
    let rg = max(${wf(OPT_RING_UM)} * k, 1.5);
    for (var i = 0; i < 8; i++) {
      let dir = vec2<f32>(cos(f32(i) * 0.7853982), sin(f32(i) * 0.7853982));
      gv += dir * gamAt(pos + dir * rg);
    }
    let gm = length(gv);
    if (gm > 1e-4) {
      let n = gv / gm;
      let r1 = max(${wf(OPT_FAR1_UM)} * k, 2.5); let r2 = max(${wf(OPT_FAR2_UM)} * k, 4.0); let rn = max(${wf(OPT_NEAR_UM)} * k, 1.0);
      let A1 = gamAt(pos - n * r1); let A2 = gamAt(pos - n * r2);
      let B1 = gamAt(pos + n * r1); let B2 = gamAt(pos + n * r2);
      let nA = gamAt(pos - n * rn); let nB = gamAt(pos + n * rn);
      let A = 0.5 * (A1 + A2); let B = 0.5 * (B1 + B2);
      let lo = min(A, B); let hi = max(A, B);
      let plateau = 1.0 - smoothstep(0.2, 0.5, (abs(A1 - A2) + abs(B1 - B2)) / max(hi - lo, 1e-4));
      let G0 = gam(c);
      var Gn = G0;
      if (G0 > hi) {
        let E = max(G0, max(nA, nB)) - hi; let D = hi - min(lo, min(nA, nB));
        let w = gate(E, D, plateau);
        Gn = G0 - (G0 - hi) * w * p.opt.y;
        clipA *= 1.0 - w * p.opt.y;               // a removed halo must not come back as halation
      } else if (G0 < lo) {
        let E = lo - min(G0, min(nA, nB)); let D = max(hi, max(nA, nB)) - lo;
        let w = gate(E, D, plateau);
        Gn = G0 + (lo - G0) * w * p.opt.y;
      }
      c *= pow(Gn / G0, 2.2);
    }
  }
  // Fine-detail compression (FINE_*_UM): film + scan render 15-60 µm texture soft
  // and creamy while edges stay sharp; a phone's ISP leaves crunch there.
  // Edge-aware: taps over ~1.5 stops away barely count. 16 taps; reach 45 µm.
  if (p.opt.z != 0.0) {
    let k = p.opt.x;
    let l0 = log2(dot(c, LW) + 0.004);           // +0.004: shadow noise is not edges
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 16; t++) {
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.3926991;
      let rad = select(max(${wf(FINE_R1_UM)} * k, 0.75), max(${wf(FINE_R2_UM)} * k, 1.5), ring == 1);
      let lq = log2(dot(at(pos + vec2<f32>(cos(ang), sin(ang)) * rad).rgb, LW) + 0.004);
      let dd = lq - l0;
      let w = exp(-dd * dd * p.opt.w) * select(1.0, 0.7, ring == 1);
      sw += w; sl += w * lq;
    }
    let lim = select(8.0, 0.5, p.opt.z < 0.0);   // negative strength (Texture > 0) lifts detail: capped
    c *= exp2(clamp((sl / sw - l0) * p.opt.z, -lim, lim));
  }
  // Texture = micro-contrast (MICRO_UM): local contrast in log luminance at the
  // scale of film adjacency (developer / DIR inhibitor diffusion at edges).
  // Edge-aware (taps over ~1 stop away barely count: no halos), midtone-weighted,
  // prefiltered taps (no aliasing at 48 MP). Bipolar: < 0 flattens micro-tones.
  if (p.clar.y != 0.0) {
    let l0 = log2(max(dot(c, LW), 1e-5));
    let o = max(0.35 * p.clar.x, 0.5);
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * p.clar.x;
      let lq = log2(max(dot(box4(q, o), LW), 1e-5));
      let d = lq - l0;
      let w = exp(-d * d * ${wf(MICRO_K)});
      sw += w; sl += w * lq;
    }
    let mid = exp(-pow((l0 + 2.47) / ${wf(MICRO_MID_STOPS)}, 2.0));   // midtones (log2 0.18 = -2.47)
    c *= exp2(clamp((l0 - sl / sw) * p.clar.y * mid, -0.4, 0.4));
  }
  // Chiarezza = dreamy glow (GLOW_UM, linear light, Orton-style): a wide blur
  // whose light bleeds into darker neighbours (halo round bright shapes) plus a
  // small symmetric veil; flat areas and detail inside them stay as they are.
  if (p.clar.w > 0.0) {
    let R = ${wf(GLOW_UM)} * p.opt.x;
    let o = max(0.35 * R, 0.5);
    var acc = box4(pos, o); var wt = 1.0;
    for (var t = 0; t < 24; t++) {
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let wr = select(select(0.3, 0.6, ring == 1), 1.0, ring == 0);
      acc += wr * box4(pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * R, o);
      wt += wr;
    }
    let gl = acc / wt - c;
    c += p.clar.w * (${wf(GLOW_VEIL)} * gl + ${wf(GLOW_BLEED)} * max(gl, vec3<f32>(0.0)));
  }
  // tone.js applyTone: display curve on max(R,G,B) as a common gain, then per-channel scene LUT.
  let k = lut(0u, max(c.r, max(c.g, c.b)));
  let S = ${TONE_SQRT_N}u + 1u;
  c = vec3<f32>(lut(S, c.r * k), lut(S, c.g * k), lut(S, c.b * k));
  // Clipped highlights (alpha = clipped fraction of the pixel, common.js): that
  // fraction of the light was really much brighter; it feeds halation/scatter.
  // Gate (CLIP_R*_UM): partly clipped white fabric must not turn into patchy
  // +5 EV islands. 8 taps, only on clipped pixels; reach 450 µm (100 px at 48 MP).
  if (clipA > 0.0) {
    let k = p.opt.x;
    var nb = 0.0; var nd = 1.0;
    for (var t = 0; t < 8; t++) {
      let rad = select(${wf(CLIP_R1_UM)}, ${wf(CLIP_R2_UM)}, (t & 1) == 1) * k;
      let ang = f32(t) * 0.7853982 + 0.3926991;
      let s = at(pos + vec2<f32>(cos(ang), sin(ang)) * rad);
      let free = 1.0 - s.a;
      let br = smoothstep(0.80, 0.93, gam(s.rgb));
      nb += free * br; nd += free * (1.0 - br);
    }
    clipA *= 1.0 - smoothstep(0.25, 0.6, nb / (nb + nd));
  }
  c *= 1.0 + ${CLIP_GAIN}.0 * clipA;
  var gainOut = p.scale;
  if (p.depth > 0.0) {
    let lost = p.depth * g;                    // fraction of light the lens loses here
    gainOut *= 1.0 - lost;
    c.r *= 1.0 + ${WARM_R} * lost;
    c.b *= 1.0 - ${WARM_B} * lost;
  }
  if (p.p3 > 0.5) { c = vec3<f32>(dot(p.m0.xyz, c), dot(p.m1.xyz, c), dot(p.m2.xyz, c)); }
  let i = (id.y * u32(p.regionW) + id.x) * 3u;
  outBuf[i] = c.r * gainOut; outBuf[i + 1u] = c.g * gainOut; outBuf[i + 2u] = c.b * gainOut;
}`;

/**
 * Uniforms of INPUT_WGSL for the region (x0, y0, w, h) of a W×H frame, scaled
 * by `scale`; same contract as lens.js extractLens. `restore` (0..1): optical
 * restore strength (halo removal + taking lens), on by default.
 */
export function inputUniform(W, H, p3, x0, y0, w, h, scale, lens, clarity = 0, restore = 1, texture = 0) {
  const kpx = Math.max(W, H) / FRAME_UM;   // frame px per µm
  const geo = lensGeometry(W, H, lens), M = P3_TO_REC2020;
  return new Float32Array([
    W, H, x0, y0,
    geo.cx, geo.cy, geo.rMax, geo.falloff,
    geo.dR, geo.dB, geo.blur, geo.depth,
    scale, p3 ? 1 : 0, w, h,
    ...M[0], 0, ...M[1], 0, ...M[2], 0,
    MICRO_UM * kpx, texture * MICRO_MAX,
    // Off (user's choice after A/B on the debug build): lens + scanner blur, halo removal, fine-detail compression.
    0, clarity,
    kpx, 0, 0, FINE_K,
  ]);
}
