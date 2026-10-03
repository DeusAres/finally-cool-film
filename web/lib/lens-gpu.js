// WebGPU input stage: lens (lens.js has the model and the CPU reference) + tone
// + colour matrix, run by the engine as the first pass of its GPU chain
// (spektrafilm-wasm `process_frame`), so the photo crosses to the GPU once, as
// an 8-bit texture, and no float frame ever crosses JS↔wasm. The texture is
// rgba8unorm-srgb: the sampler decodes to LINEAR light before filtering, so
// every bilinear tap is interpolated in linear light, as in the CPU path.
// Output: linear Rec.2020 (p3) or linear sRGB floats, interleaved RGB, for the region.
import { LENS_CONST, lensGeometry } from './lens.js';
import { P3_TO_REC2020 } from './color.js';
import { TONE_SQRT_N } from './tone.js';
import { CLIP_GAIN } from './common.js';

const { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B } = LENS_CONST;

export const INPUT_WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, p3: f32, regionW: f32, regionH: f32,
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // P3 → Rec.2020 rows (xyz)
  clar: vec4<f32>,                             // clarity: radius (frame px), strength
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
  // Film adjacency / clarity (CLARITY_UM): local contrast in log luminance at
  // the scale where colour negative's MTF rises above 100% (developer and DIR
  // inhibitor diffusion at edges). Edge-aware: taps more than ~1 stop away
  // barely count, so strong edges get no halo; texture gets the lift. Taps
  // read the full-frame texture in frame coordinates: tiles stay seamless.
  if (p.clar.y > 0.0) {
    let lw = vec3<f32>(0.2290, 0.6917, 0.0793);
    let l0 = log2(max(dot(c, lw), 1e-5));
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * p.clar.x;
      let lq = log2(max(dot(at(q).rgb, lw), 1e-5));
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
  c *= 1.0 + ${CLIP_GAIN}.0 * at(pos).a;
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
 * by `scale`; same contract as lens.js extractLens.
 */
// Clarity scale on the 36 mm frame, and strength at Texture = 1.
const CLARITY_UM = 250, FRAME_UM = 36000;
export const CLARITY_MAX = 1.0;

export function inputUniform(W, H, p3, x0, y0, w, h, scale, lens, clarity = 0) {
  const geo = lensGeometry(W, H, lens), M = P3_TO_REC2020;
  return new Float32Array([
    W, H, x0, y0,
    geo.cx, geo.cy, geo.rMax, geo.falloff,
    geo.dR, geo.dB, geo.blur, geo.depth,
    scale, p3 ? 1 : 0, w, h,
    ...M[0], 0, ...M[1], 0, ...M[2], 0,
    CLARITY_UM / (FRAME_UM / Math.max(W, H)), clarity * CLARITY_MAX, 0, 0,
  ]);
}
