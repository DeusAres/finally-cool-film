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

export const INPUT_WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, p3: f32, regionW: f32, regionH: f32,
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // P3 → Rec.2020 rows (xyz)
  clar: vec4<f32>,                             // clarity: radius (frame px), strength
  opt: vec4<f32>,                              // optical restore: frame px per µm, strength
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
  // Optical restore (OPT_* in µm on the 36 mm frame). A phone frame carries its ISP's
  // signature: unsharp-mask halos (bench: in-focus edges +6..9% overshoot,
  // -9% undershoot, MTF > 1 at 5-15 cy/mm) and pixel-crisp edges. A camera lens
  // on film has neither. 18 taps; reach 80 µm (≤ 10 px at 12 MP, inside the tile pad).
  if (p.opt.y > 0.0) {
    let k = p.opt.x;
    let s0 = at(pos);
    var c0 = s0.rgb;
    // 1. Taking lens: Gaussian-equivalent sigma OPT_LENS_UM. Four diagonal bilinear
    //    taps at ±o make the separable kernel [o/2, 1-o, o/2] (variance o per axis);
    //    blended by a for variance a*o = sigma² (px). Linear light, as optics.
    let s2 = (${wf(OPT_LENS_UM)} * k) * (${wf(OPT_LENS_UM)} * k);
    let o = clamp(s2, 0.5, 1.0);
    // Not on clipped light (alpha): blurring a thin clipped source would drain the
    // halation it feeds, more at 12 MP than in the preview.
    let a = min(s2 / o, 1.0) * p.opt.y * (1.0 - s0.a);
    var bx = box4(pos, o);
    if (p.dR > 0.0 && r > 0.5) {               // CA: R and B were sampled elsewhere, blur them there
      let u = vec2<f32>(d.x / r, d.y / r * ${ANISO_Y});
      let qR = pos + u * (p.dR * g); let qB = pos + u * (p.dB * g);
      c0 = vec3<f32>(at(qR).r, c0.g, at(qB).b);
      bx = vec3<f32>(box4(qR, o).r, bx.g, box4(qB, o).b);
    }
    c += (bx - c0) * a;
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
  // Film adjacency / clarity (CLARITY_UM): local contrast in log luminance at
  // the scale where colour negative's MTF rises above 100% (developer and DIR
  // inhibitor diffusion at edges). Edge-aware: taps more than ~1 stop away
  // barely count, so strong edges get no halo; texture gets the lift. Taps
  // read the full-frame texture in frame coordinates: tiles stay seamless.
  if (p.clar.y > 0.0) {
    let l0 = log2(max(dot(c, LW), 1e-5));
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * p.clar.x;
      let lq = log2(max(dot(at(q).rgb, LW), 1e-5));
      let d = lq - l0;
      let w = exp(-d * d * 0.4);
      sw += w; sl += w * lq;
    }
    c *= exp2(clamp((l0 - sl / sw) * p.clar.y, -0.6, 0.6));
  }
  // tone.js applyTone: display curve on max(R,G,B) as a common gain, then per-channel scene LUT.
  let k = lut(0u, max(c.r, max(c.g, c.b)));
  let S = ${TONE_SQRT_N}u + 1u;
  c = vec3<f32>(lut(S, c.r * k), lut(S, c.g * k), lut(S, c.b * k));
  // Clipped highlights (alpha = clipped fraction of the pixel, common.js): that
  // fraction of the light was really much brighter; it feeds halation/scatter.
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
// Clarity scale on the 36 mm frame, and strength at Texture = 1.
const CLARITY_UM = 250;
export const CLARITY_MAX = 1.0;

export function inputUniform(W, H, p3, x0, y0, w, h, scale, lens, clarity = 0, restore = 1) {
  const geo = lensGeometry(W, H, lens), M = P3_TO_REC2020;
  return new Float32Array([
    W, H, x0, y0,
    geo.cx, geo.cy, geo.rMax, geo.falloff,
    geo.dR, geo.dB, geo.blur, geo.depth,
    scale, p3 ? 1 : 0, w, h,
    ...M[0], 0, ...M[1], 0, ...M[2], 0,
    CLARITY_UM / (FRAME_UM / Math.max(W, H)), clarity * CLARITY_MAX, 0, 0,
    Math.max(W, H) / FRAME_UM, restore, 0, 0,
  ]);
}
