// Laboratorio (v4): the printer's colour analyser. For each negative it sets the enlarger's yellow / magenta filtration
// so the print comes out near neutral, removing most but not all of the cast (a warm room stays a little warm).
//
// It measures prints, not negatives: `print(y, m)` renders a small print of the frame with those filter shifts and
// returns its RGB (any RGB with a D65 white, display-encoded is fine: neutral is R = G = B in every such space). The
// filters act almost linearly on the print's colour (measured on the cat DNG with sf-eval: +1 Y -> b* -1.2, a* ~0;
// +1 M -> a* -0.9, b* +0.6), so one step solved from two probe prints lands where it should.
//
// No DOM: a pure function of the print callback.

// Share of the cast the lab removes. Unverified: an analyser integrates to grey but labs keep some of the scene's
// mood; 0.7 leaves the cat DNG's warm room at about a* +3 / b* +4 in the mids (from +12 / +13 uncorrected).
export const LAB_K = 0.7;
const STEP = 8;          // probe filter step: large enough to beat the measurement noise, small enough to stay linear
const MAX_SHIFT = 40;    // filter clamp: past it the frame is a subject failure the lab would not chase either

// Opponent log-chroma of display-encoded RGB: o1 red-green, o2 yellow-blue; 0 / 0 = neutral.
const EPS = 1e-3;
function cast(rgb) {
  let s1 = 0, s2 = 0, sw = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] + EPS, g = rgb[i + 1] + EPS, b = rgb[i + 2] + EPS, luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < 0.15 || luma > 0.85) continue;          // midtones only: the lab measures where the print is readable
    const o1 = Math.log(r / g), o2 = Math.log(Math.sqrt(r * g) / b);
    const w = 1 / (1 + (o1 * o1 + o2 * o2) / 0.04);    // saturated colours count less (a red wall is not a cast)
    s1 += w * o1; s2 += w * o2; sw += w;
  }
  return sw ? [s1 / sw, s2 / sw] : [0, 0];
}

/** Enlarger filter shifts { y, m } that remove `k` of the frame's cast; `print(y, m)` -> RGB array of a small print. */
export function labFilters(print, k = LAB_K) {
  const c0 = cast(print(0, 0)), cy = cast(print(STEP, 0)), cm = cast(print(0, STEP));
  const a = (cy[0] - c0[0]) / STEP, b = (cm[0] - c0[0]) / STEP, c = (cy[1] - c0[1]) / STEP, d = (cm[1] - c0[1]) / STEP;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return { y: 0, m: 0 };
  const t1 = -k * c0[0], t2 = -k * c0[1];   // wanted change of o1 / o2
  const clamp = (v) => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, v));
  return { y: clamp((d * t1 - b * t2) / det), m: clamp((a * t2 - c * t1) / det) };
}
