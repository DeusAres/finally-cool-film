// Film grain, procedural, applied where it shows: in the final 8-bit pass
// (the engine's output pack shader, see spektrafilm-wasm `process_frame`),
// after the film/print/scan chain, as the grain of a scanned negative reads.
//
// Why not the engine's own grain: measured on real Kodak Gold 200 scans
// (shopfront, cliffs, palms, two people on grass), grain is strongest in the
// shadows and low mids (L* ~20–60), fades in the deep blacks and is nearly
// gone in the highlights (the print/scan shoulder flattens it). The engine's
// grain, after our tone inversion (which places display highlights mid-curve
// on the film), did the opposite: strongest at L* 60–90, weak in the shadows.
//
// Model:
//   - amplitude follows that measured response, GRAIN_SHAPE(L*) below;
//   - noise lives in µm on the 36 mm frame, so preview and every export tile
//     draw the same grain;
//   - a pixel larger than a grain averages several: amplitude scales with
//     grain size / pixel size (RMS granularity ∝ 1/√area), so the grain reads
//     the same at preview size and at 12 MP once viewed at the same size;
//   - two scales: fine grain plus larger clumps (dye clouds coalesce);
//   - three dye layers grain independently: part of the noise is per
//     channel (chromatic), more so in the shadows, where it shows on scans.

const FRAME_UM = 36000;

export const GRAIN_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
// P[4] region width, P[5..6] region origin (frame px), P[7] µm per px,
// P[8] amplitude (8-bit levels), P[9] grain size (µm), P[10] seed.

fn q(v: f32) -> f32 { return f32(lut[u32(clamp(v * 4095.0 + 0.5, 0.0, 4095.0))]) / 255.0; }

fn pcg(v0: vec3<u32>) -> u32 {                 // pcg3d hash
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3<u32>(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
fn lattice(p: vec2<i32>, s: u32) -> f32 {      // ~N(0,1): sum of two uniforms, rescaled
  let h = pcg(vec3<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y), s));
  let a = f32(h & 0xffffu) / 65535.0;
  let b = f32(h >> 16u) / 65535.0;
  return (a + b - 1.0) * 2.45;
}
fn vnoise(p: vec2<f32>, s: u32) -> f32 {       // value noise, smooth interpolation
  let i = vec2<i32>(floor(p)); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lattice(i, s), lattice(i + vec2<i32>(1, 0), s), u.x),
             mix(lattice(i + vec2<i32>(0, 1), s), lattice(i + vec2<i32>(1, 1), s), u.x), u.y);
}
fn lstar(c: vec3<f32>) -> f32 {
  let l = select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
  let y = dot(l, vec3<f32>(0.2126, 0.7152, 0.0722));
  return select(903.3 * y, 116.0 * pow(y, 1.0 / 3.0) - 16.0, y > 0.008856);
}
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  var c = vec3<f32>(q(src[3u * i]), q(src[3u * i + 1u]), q(src[3u * i + 2u]));
  if (P[8] > 0.0) {
    let w = u32(P[4]);
    let um = (vec2<f32>(f32(i % w), f32(i / w)) + vec2<f32>(P[5], P[6]) + 0.5) * P[7];
    let size = max(P[9], P[7]);                // a cell is never smaller than a pixel
    let avg = P[9] / size;                     // averaging over larger pixels
    let s = u32(P[10]);
    let p = um / size;
    let L = lstar(c);
    // GRAIN_SHAPE: measured on real scans (see grain.js).
    let shape = (0.3 + 0.7 * sstep(2.0, 22.0, L)) * (1.0 - 0.95 * sstep(55.0, 88.0, L));
    let chroma = mix(0.55, 0.2, sstep(10.0, 50.0, L));
    let mono = 0.8 * vnoise(p, s) + 0.6 * vnoise(p / 2.3 + 17.0, s + 1u);
    let n = vec3<f32>(vnoise(p + 31.0, s + 2u), vnoise(p + 57.0, s + 3u), vnoise(p + 83.0, s + 4u));
    c += (P[8] / 255.0) * avg * shape * (mono + chroma * n);
  }
  let o = vec3<u32>(round(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
  dst[i] = o.x | (o.y << 8u) | (o.z << 16u) | 0xff000000u;
}`;

/**
 * Params for GRAIN_WGSL: region (x0, y0, w) of a frame whose long side is
 * `frameLong` px; `amount` is the Grana slider (0 = off), `seed` per photo.
 */
export function grainParams(w, x0, y0, frameLong, amount, seed) {
  const umPerPx = FRAME_UM / frameLong;
  // Size grows a little with the amount (a coarser-looking stock); 12 µm at 1.
  const size = 12 * (0.75 + 0.25 * amount);
  return new Float32Array([w, x0, y0, umPerPx, GRAIN_LEVELS * amount, size, seed % 65536]);
}

// Peak amplitude (8-bit levels, per unit of noise) at amount 1.
const GRAIN_LEVELS = 13;
