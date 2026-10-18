// WebGPU input stage: lens (lens.js has the model and the CPU reference) + display→scene
// inverse (JPEG) + exposure + colour matrix, run by the engine as the first pass of its GPU chain
// (spektrafilm-wasm `process_frame`), so the photo crosses to the GPU once, as
// an 8-bit texture, and no float frame ever crosses JS↔wasm. The texture is
// rgba8unorm-srgb: the sampler decodes to LINEAR light before filtering, so
// every bilinear tap is interpolated in linear light, as in the CPU path.
// Output: linear Rec.2020 (p3) or linear sRGB floats, interleaved RGB, for the region.
import { LENS_CONST, lensGeometry } from './lens.js';
import { P3_TO_REC2020, LUMA, displayGainWGSL, DISPLAY_GAIN_LUT } from './color.js';
import { dodgeWGSL } from './dodge.js';
import { FRAME_UM, wf } from './util.js';

const { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B } = LENS_CONST;

// Slider mapping (Texture, Chiarezza) and the stages they drive, in µm on the 36 mm frame.
// Colour-noise reduction (always on): ring radii (frame px), luminance range k (per stop²).
const CHROMA_R1 = 1.5, CHROMA_R2 = 3.0, CHROMA_K = 8.0;
// Texture = micro-contrast: scale (µm), range k (per stop²), midtone width (stops), strength at ±1.
const MICRO_UM = 60, MICRO_K = 0.4, MICRO_MID_STOPS = 2.5, MICRO_MAX = 0.8;
// Chiarezza (v3.26, bipolar, replaces the old Orton glow): local midtone contrast (Lightroom-like Clarity) at CLAR_UM, edge-aware
// (range k per stop²: taps ~1 stop away barely count, no halos), strength at +1 / -1, cap (EV), midtone width (stops). In scene light
// before the film, so the film's own curve rolls the result off. Below 0 it flattens the local tones towards their base (softer,
// no veil, no blur of the edges).
const CLAR_UM = 500, CLAR_K = 1.0, CLAR_UP = 1.0, CLAR_DOWN = 0.6, CLAR_CAP = 0.7, CLAR_MID_STOPS = 3.5;
// Nitidezza (v3.30, one slider, -1..+1): edge acutance in scene light BEFORE the film, so the film's grain (added in the negative,
// later) is never sharpened. Base = Gaussian-like 17 taps at SHARP_UM (1 + 2 rings), detail d = log luma - base.
//  > 0: d x SHARP_MAX x slider, gated by a sensor-noise threshold (SHARP_T0 log2 at the preview pitch, x2 per 2 stops below mid
//       grey up to x4, x the pixel pitch vs preview: finer export pixels are noisier), result clamped to the local min / max (+-SHARP_TOL):
//       sharper edges, no halo, flat noisy areas untouched. No Amount / Radius / Detail / Masking to set.
//  < 0: towards the base (soft lens), d x SHARP_SOFT x slider, no gate.
const SHARP_UM = 25, SHARP_MAX = 2.2, SHARP_SOFT = 0.8, SHARP_T0 = 0.03, SHARP_TOL = 0.04, SHARP_KPX_REF = 2000 / 36000;


export const INPUT_WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, expo: f32, regionW: f32, regionH: f32,   // lens gain; scene exposure gain (Esposizione, Interno, DNG baseline)
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // frame primaries → engine input primaries, rows (xyz)
  fx: vec4<f32>,                               // micro-contrast radius (px), Texture strength, Nitidezza gain, frame px per µm
  wb: vec4<f32>,                               // per-channel gains in the engine input space (Interno: real light colour); 1 otherwise; w: Chiarezza contrast
  luma: vec4<f32>,                             // luma weights of the frame's primaries; w = 1: JPEG, apply the display→scene inverse
};
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(4) var<storage, read> inv: array<f32>;   // color.js DISPLAY_GAIN_LUT
${displayGainWGSL('inv')}

fn at(pos: vec2<f32>) -> vec4<f32> {           // pos in frame pixel coords (pixel centres at integers)
  return textureSampleLevel(tex, smp, (pos + 0.5) / p.frame, 0.0);
}
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

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (f32(id.x) >= p.regionW || f32(id.y) >= p.regionH) { return; }
  let pos = p.origin + vec2<f32>(f32(id.x), f32(id.y));
  let d = pos - p.axis;
  let r = length(d);
  let g = coverage(min(r / p.rMax, 1.0));      // one curve drives both effects
  var c: vec3<f32>;
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
  // Colour-noise reduction: the phone's sensor chroma noise is invisible
  // in the photo, but the film's colour saturation amplifies it ~5× (measured: σC 0.6 → 2.9
  // with every look stage off) into digital-looking colour speckle; Gold scans show σC 0.4-0.9.
  // As a lab does: average the chroma (RGB / luminance) over two rings (CHROMA_R1/R2 px),
  // luminance-edge-aware, and keep this pixel's own luminance: detail and grain are untouched.
  {
    let y0 = max(dot(c, p.luma.xyz), 1e-5);
    var acc = c / y0; var wt = 1.0;
    for (var t = 0; t < 16; t++) {
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.3926991;
      let q = at(pos + vec2<f32>(cos(ang), sin(ang)) * select(${wf(CHROMA_R1)}, ${wf(CHROMA_R2)}, ring == 1)).rgb;
      let yq = max(dot(q, p.luma.xyz), 1e-5);
      let dl = log2(yq / y0);
      let w = exp(-dl * dl * ${wf(CHROMA_K)}) * select(1.0, 0.6, ring == 1);
      acc += w * q / yq; wt += w;
    }
    c = y0 * acc / wt;
  }
  // Nitidezza (SHARP_UM): see the constants. p.fx.z = gain (+ SHARP_MAX x slider / - SHARP_SOFT x slider).
  if (p.fx.z != 0.0) {
    let R = max(${wf(SHARP_UM)} * p.fx.w, 0.7);
    let lc = log2(max(dot(at(pos).rgb, p.luma.xyz), 1e-5));
    var s1 = 0.0; var s2 = 0.0; var lo = lc; var hi = lc;
    for (var t = 0; t < 8; t++) {
      let a1 = f32(t) * 0.7853982;
      let q1 = log2(max(dot(at(pos + vec2<f32>(cos(a1), sin(a1)) * R).rgb, p.luma.xyz), 1e-5));
      let q2 = log2(max(dot(at(pos + vec2<f32>(cos(a1 + 0.3926991), sin(a1 + 0.3926991)) * 2.0 * R).rgb, p.luma.xyz), 1e-5));
      s1 += q1; s2 += q2; lo = min(lo, q1); hi = max(hi, q1);
    }
    let d = lc - (lc + 0.6 * s1 + 0.25 * s2) / (1.0 + 0.6 * 8.0 + 0.25 * 8.0);
    var dl = p.fx.z * d;
    if (p.fx.z > 0.0) {
      let thr = ${wf(SHARP_T0)} * clamp(exp2(0.5 * (-2.47 - lc)), 1.0, 4.0) * max(p.fx.w / ${wf(SHARP_KPX_REF)}, 0.5);
      let gate = smoothstep(thr, 3.0 * thr, abs(d));
      dl = clamp(lc + dl * gate, lo - ${wf(SHARP_TOL)}, hi + ${wf(SHARP_TOL)}) - lc;
    }
    c *= exp2(dl);
  }
  // Texture = micro-contrast (MICRO_UM): local contrast in log luminance at the
  // scale of film adjacency (developer / DIR inhibitor diffusion at edges).
  // Edge-aware (taps over ~1 stop away barely count: no halos), midtone-weighted,
  // prefiltered taps (no aliasing at 48 MP). Bipolar: < 0 flattens micro-tones.
  if (p.fx.y != 0.0) {
    let l0 = log2(max(dot(c, p.luma.xyz), 1e-5));
    let o = max(0.35 * p.fx.x, 0.5);
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * p.fx.x;
      let lq = log2(max(dot(box4(q, o), p.luma.xyz), 1e-5));
      let d = lq - l0;
      let w = exp(-d * d * ${wf(MICRO_K)});
      sw += w; sl += w * lq;
    }
    let mid = exp(-pow((l0 + 2.47) / ${wf(MICRO_MID_STOPS)}, 2.0));   // midtones (log2 0.18 = -2.47)
    c *= exp2(clamp((l0 - sl / sw) * p.fx.y * mid, -0.4, 0.4));
  }
  // Chiarezza = local midtone contrast (CLAR_UM): log luminance pushed away from (> 0) or towards (< 0) an edge-aware local base,
  // midtone-weighted, capped. > 0 only expands (slope >= 1 in the pixel's own level); < 0 keeps slope >= 1 - CLAR_DOWN > 0.
  if (p.wb.w != 0.0) {
    let l0 = log2(max(dot(c, p.luma.xyz), 1e-5));
    let R = ${wf(CLAR_UM)} * p.fx.w;
    let o = max(0.35 * R, 0.5);
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * R;
      let lq = log2(max(dot(box4(q, o), p.luma.xyz), 1e-5));
      let d = lq - l0;
      let w = exp(-d * d * ${wf(CLAR_K)});
      sw += w; sl += w * lq;
    }
    let mid = exp(-pow((l0 + 2.47) / ${wf(CLAR_MID_STOPS)}, 2.0));
    c *= exp2(clamp((l0 - sl / sw) * p.wb.w * mid, -${wf(CLAR_CAP)}, ${wf(CLAR_CAP)}));
  }
  // JPEG: display → scene (color.js), a common gain on max(R,G,B). A raw frame is scene-linear already.
  if (p.luma.w > 0.5) { c *= displayGain(max(c.r, max(c.g, c.b))); }
  // Exposure: Esposizione, minus Interno's underexposure, plus the DNG baseline, as scene light before the film.
  c *= p.expo;
  var gainOut = p.scale;
  if (p.depth > 0.0) {
    let lost = p.depth * g;                    // fraction of light the lens loses here
    gainOut *= 1.0 - lost;
    c.r *= 1.0 + ${WARM_R} * lost;
    c.b *= 1.0 - ${WARM_B} * lost;
  }
  c = vec3<f32>(dot(p.m0.xyz, c), dot(p.m1.xyz, c), dot(p.m2.xyz, c));
  let i = (id.y * u32(p.regionW) + id.x) * 3u;
  c *= p.wb.xyz;
  outBuf[i] = c.r * gainOut; outBuf[i + 1u] = c.g * gainOut; outBuf[i + 2u] = c.b * gainOut;
}`;

// Debug v3 (debugv3.html): the same pass with the automatic highlight dodging (dodge.js) before the
// exposure gain; its base map rides after DISPLAY_GAIN_LUT in the same storage array.
export const INPUT_WGSL_V3 = INPUT_WGSL
  .replace('fn at(pos', `${dodgeWGSL('inv', DISPLAY_GAIN_LUT.length)}\nfn at(pos`)
  .replace('\n  c *= p.expo;\n', '\n  c = dodge(c, pos);\n  c *= p.expo;\n');

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const UNIFORM_FLOATS = 40;

/**
 * Uniforms of INPUT_WGSL for the region (x0, y0, w, h) of a W×H frame, scaled by `scale`
 * (lens gain); same contract as lens.js extractLens. `space`: primaries of the frame,
 * 'srgb' | 'p3' | 'rec2020' (a raw frame, already scene-linear: no display→scene inverse).
 * `expo`: scene exposure gain; `wb`: per-channel gains in the engine input space.
 */
export function inputUniform(W, H, space, x0, y0, w, h, scale, lens, expo, clarity = 0, texture = 0, wb = [1, 1, 1], sharp = 0) {
  const kpx = Math.max(W, H) / FRAME_UM;   // frame px per µm
  const geo = lensGeometry(W, H, lens), M = space === 'p3' ? P3_TO_REC2020 : IDENTITY;
  const u = new Float32Array([
    W, H, x0, y0,
    geo.cx, geo.cy, geo.rMax, geo.falloff,
    geo.dR, geo.dB, geo.blur, geo.depth,
    scale, expo, w, h,
    ...M[0], 0, ...M[1], 0, ...M[2], 0,
    MICRO_UM * kpx, texture * MICRO_MAX, sharp * (sharp > 0 ? SHARP_MAX : SHARP_SOFT), kpx,
    ...wb, clarity * (clarity > 0 ? CLAR_UP : CLAR_DOWN),
    ...LUMA[space], space === 'rec2020' ? 0 : 1,
  ]);
  if (u.length !== UNIFORM_FLOATS) throw new Error('inputUniform: layout drift');
  return u;
}
