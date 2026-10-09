// WebGPU input stage: lens (lens.js has the model and the CPU reference) + display→scene
// inverse (JPEG) + exposure + colour matrix, run by the engine as the first pass of its GPU chain
// (spektrafilm-wasm `process_frame`), so the photo crosses to the GPU once, as
// an 8-bit texture, and no float frame ever crosses JS↔wasm. The texture is
// rgba8unorm-srgb: the sampler decodes to LINEAR light before filtering, so
// every bilinear tap is interpolated in linear light, as in the CPU path.
// Output: linear Rec.2020 (p3) or linear sRGB floats, interleaved RGB, for the region.
import { LENS_CONST, lensGeometry } from './lens.js';
import { P3_TO_REC2020, LUMA, displayGainWGSL } from './color.js';
import { CLIP_GAIN } from './common.js';
import { FRAME_UM, wf } from './util.js';

const { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B } = LENS_CONST;

// Clipped-highlight gate: 8 taps alternating CLIP_R1/R2_UM. A clipped pixel
// whose UNclipped surround is near-white (gamma luma > ~0.85) is a surface just
// over the clip (white fabric, overcast sky), not a light source: its boost goes.
// A lamp / window / sun has a darker surround (or is all clipped) and keeps it.
const CLIP_R1_UM = 200, CLIP_R2_UM = 450;
// Slider mapping (Texture, Chiarezza) and the stages they drive, in µm on the 36 mm frame.
// Colour-noise reduction (always on): ring radii (frame px), luminance range k (per stop²).
const CHROMA_R1 = 1.5, CHROMA_R2 = 3.0, CHROMA_K = 8.0;
// Texture = micro-contrast: scale (µm), range k (per stop²), midtone width (stops), strength at ±1.
const MICRO_UM = 60, MICRO_K = 0.4, MICRO_MID_STOPS = 2.5, MICRO_MAX = 0.8;
// Chiarezza = glow: blur radius (µm), symmetric veil and one-sided bleed of light at 1.
const GLOW_UM = 220, GLOW_VEIL = 0.25, GLOW_BLEED = 0.6;


export const INPUT_WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, expo: f32, regionW: f32, regionH: f32,   // lens gain; scene exposure gain (Esposizione, Interno, DNG baseline)
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // frame primaries → engine input primaries, rows (xyz)
  fx: vec4<f32>,                               // micro-contrast radius (px), Texture strength, Chiarezza glow, frame px per µm
  wb: vec4<f32>,                               // per-channel gains in the engine input space (Interno: real light colour); 1 otherwise
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
fn gam(c: vec3<f32>) -> f32 {                 // luminance of the frame's primaries, gamma-encoded (where phone ISPs sharpen)
  return pow(max(dot(c, p.luma.xyz), 0.0) + 0.001, 1.0 / 2.2);
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
  var clipA = at(pos).a;                       // clipped-highlight weight (gated below)
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
  // Chiarezza = dreamy glow (GLOW_UM, linear light, Orton-style): a wide blur
  // whose light bleeds into darker neighbours (halo round bright shapes) plus a
  // small symmetric veil; flat areas and detail inside them stay as they are.
  if (p.fx.z > 0.0) {
    let R = ${wf(GLOW_UM)} * p.fx.w;
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
    c += p.fx.z * (${wf(GLOW_VEIL)} * gl + ${wf(GLOW_BLEED)} * max(gl, vec3<f32>(0.0)));
  }
  // JPEG: display → scene (color.js), a common gain on max(R,G,B). A raw frame is scene-linear already.
  if (p.luma.w > 0.5) { c *= displayGain(max(c.r, max(c.g, c.b))); }
  // Exposure: Esposizione, minus Interno's underexposure, plus the DNG baseline, as scene light before the film.
  c *= p.expo;
  // Clipped highlights (alpha = clipped fraction of the pixel, common.js / raw.js): that
  // fraction of the light was really much brighter; it feeds halation/scatter.
  // alpha and the gate's taps are the SENSOR / file values (the texture), never the exposed
  // light: Esposizione must not move what counts as clipped.
  // Gate (CLIP_R*_UM): partly clipped white fabric must not turn into patchy
  // +5 EV islands. 8 taps, only on clipped pixels; reach 450 µm (100 px at 48 MP).
  if (clipA > 0.0) {
    let k = p.fx.w;
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
  c = vec3<f32>(dot(p.m0.xyz, c), dot(p.m1.xyz, c), dot(p.m2.xyz, c));
  let i = (id.y * u32(p.regionW) + id.x) * 3u;
  c *= p.wb.xyz;
  outBuf[i] = c.r * gainOut; outBuf[i + 1u] = c.g * gainOut; outBuf[i + 2u] = c.b * gainOut;
}`;

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const UNIFORM_FLOATS = 40;

/**
 * Uniforms of INPUT_WGSL for the region (x0, y0, w, h) of a W×H frame, scaled by `scale`
 * (lens gain); same contract as lens.js extractLens. `space`: primaries of the frame,
 * 'srgb' | 'p3' | 'rec2020' (a raw frame, already scene-linear: no display→scene inverse).
 * `expo`: scene exposure gain; `wb`: per-channel gains in the engine input space.
 */
export function inputUniform(W, H, space, x0, y0, w, h, scale, lens, expo, clarity = 0, texture = 0, wb = [1, 1, 1]) {
  const kpx = Math.max(W, H) / FRAME_UM;   // frame px per µm
  const geo = lensGeometry(W, H, lens), M = space === 'p3' ? P3_TO_REC2020 : IDENTITY;
  const u = new Float32Array([
    W, H, x0, y0,
    geo.cx, geo.cy, geo.rMax, geo.falloff,
    geo.dR, geo.dB, geo.blur, geo.depth,
    scale, expo, w, h,
    ...M[0], 0, ...M[1], 0, ...M[2], 0,
    MICRO_UM * kpx, texture * MICRO_MAX, clarity, kpx,
    ...wb, 0,
    ...LUMA[space], space === 'rec2020' ? 0 : 1,
  ]);
  if (u.length !== UNIFORM_FLOATS) throw new Error('inputUniform: layout drift');
  return u;
}
