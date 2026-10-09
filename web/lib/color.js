// Colour constants, once. Everything that needs a matrix, a luma weight or a transfer
// function (decoding, lens, input pass, output pass, ICC) takes it from here; the WGSL
// strings interpolate the same numbers.

// ---------- transfer functions ----------

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

/** 8-bit sRGB / Display P3 code value → linear light (both use the sRGB transfer function). */
export const LIN8 = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** WGSL: sRGB EOTF / OETF on vec3 (same functions as above). */
export const SRGB_WGSL = /* wgsl */`
fn srgbDec(v: vec3<f32>) -> vec3<f32> { return select(pow((v + 0.055) / 1.055, vec3<f32>(2.4)), v / 12.92, v <= vec3<f32>(0.04045)); }
fn srgbEnc(v: vec3<f32>) -> vec3<f32> { return select(1.055 * pow(max(v, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055, 12.92 * v, v <= vec3<f32>(0.0031308)); }`;

// ---------- primaries → matrices → luma ----------

// CIE xy of the red, green, blue primaries; all three share the D65 white.
const D65_XY = [0.3127, 0.3290];
const PRIMARIES = {
  srgb: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]],
  p3: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
  rec2020: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]],
};

const mul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
export function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A, -(b * i - c * h), b * f - c * e], [B, a * i - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]]
    .map((r) => r.map((v) => v / det));
}

/** Linear RGB → XYZ (D65) of a space, from its primaries and white. */
function rgbToXyz(prim) {
  const col = prim.map(([x, y]) => [x / y, 1, (1 - x - y) / y]);          // XYZ of each primary at Y = 1
  const P = [0, 1, 2].map((r) => col.map((c) => c[r]));                   // columns = primaries
  const [wx, wy] = D65_XY, W = [wx / wy, 1, (1 - wx - wy) / wy];
  const S = inv3(P).map((r) => r[0] * W[0] + r[1] * W[1] + r[2] * W[2]);  // primary intensities that sum to white
  return P.map((r) => r.map((v, j) => v * S[j]));
}

export const RGB_TO_XYZ = Object.fromEntries(Object.entries(PRIMARIES).map(([k, p]) => [k, rgbToXyz(p)]));

/** Luminance weights (Y of linear RGB) of each space: the middle row of its RGB → XYZ matrix. */
export const LUMA = Object.fromEntries(Object.entries(RGB_TO_XYZ).map(([k, m]) => [k, m[1]]));

/** Linear RGB of space `from` → linear RGB of space `to` (both D65). */
const convert = (from, to) => mul(inv3(RGB_TO_XYZ[to]), RGB_TO_XYZ[from]);
export const P3_TO_REC2020 = convert('p3', 'rec2020');
export const REC2020_TO_P3 = convert('rec2020', 'p3');

// ---------- display → scene (JPEG input) ----------
// ONE fixed, generic inverse of what a phone does to the light, applied to linear
// display values (the EOTF is already undone: the GPU sampler decodes sRGB / P3):
// phones roll the highlights off with a soft shoulder. Above KNEE we undo it with
//   f(x) = KNEE + (x - KNEE) / (1 - SHOULDER · (x - KNEE) / (1 - KNEE)),   x in [KNEE, 1]
// i.e. the inverse of a Reinhard-type shoulder, anchored so display white 1 lands at
// KNEE + (1 - KNEE) / (1 - SHOULDER) = 1.5 (+0.58 EV). f is the identity up to KNEE (so mid
// grey 0.18 stays 0.18), has slope 1 at KNEE (C1) and slope >= 1 above (monotonic).
// Applied as a common gain on max(R,G,B), so hue and saturation survive. No measured
// pipeline, no per-photo fit.
// v2-calib: KNEE / SHOULDER are generic; tune against the acceptance set only if the engine's highlights need it.
const DISPLAY_KNEE = 0.5, DISPLAY_SHOULDER = 0.5;
export const displayToScene = (x) => (x <= DISPLAY_KNEE ? x : DISPLAY_KNEE + (x - DISPLAY_KNEE) / (1 - DISPLAY_SHOULDER * (x - DISPLAY_KNEE) / (1 - DISPLAY_KNEE)));

export const SQRT_N = 1024;   // the gain LUT is sampled over sqrt(max channel): fine near black, where it is 1
/** f(m) / m for m = (i / SQRT_N)²: read by the GPU input pass (storage buffer) and by `sceneFromDisplay`. */
export const DISPLAY_GAIN_LUT = Float32Array.from({ length: SQRT_N + 1 }, (_, i) => {
  const m = (i / SQRT_N) ** 2;
  return m > 0 ? displayToScene(m) / m : 1;
});

/** Gain of `displayToScene` for a pixel whose max(R,G,B) is m (display linear, 0..1). */
export function displayGain(m) {
  const f = Math.sqrt(m <= 0 ? 0 : m >= 1 ? 1 : m) * SQRT_N, i = f | 0;
  return i >= SQRT_N ? DISPLAY_GAIN_LUT[SQRT_N] : DISPLAY_GAIN_LUT[i] + (DISPLAY_GAIN_LUT[i + 1] - DISPLAY_GAIN_LUT[i]) * (f - i);
}

/** WGSL: the same lookup over a storage array holding DISPLAY_GAIN_LUT. */
export const displayGainWGSL = (arr) => /* wgsl */`
fn displayGain(m: f32) -> f32 {
  let f = sqrt(clamp(m, 0.0, 1.0)) * ${SQRT_N}.0;
  let i = u32(f);
  if (i >= ${SQRT_N}u) { return ${arr}[${SQRT_N}u]; }
  return mix(${arr}[i], ${arr}[i + 1u], f - f32(i));
}`;
