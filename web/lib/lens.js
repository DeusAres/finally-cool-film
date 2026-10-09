// Lens stage: lateral chromatic aberration + vignetting, applied to the linear
// light that reaches the film — i.e. BEFORE the emulsion, the physical order.
//
// Ported from the grain project's Stage E ("Lens"), same geometry and defaults:
//   - one slightly off-centre optical axis and one normalised-radius coverage
//     curve drive BOTH effects, so they always agree on where the "edge" is;
//     `falloff` blends a true cos⁴ optical falloff (wide, reaches the middle)
//     with a mechanical cutoff (flat centre, fast roll at the rim);
//   - CA is lateral only: R and B displaced radially about the axis (blue
//     ~1.35× red, it disperses more), G is the reference; each channel is also
//     smeared along its own radial direction (separation and defocus come from
//     the same glass), with a slight anisotropy so it reads as glass, not plugin;
//   - vignetting is an exposure falloff in linear light plus a light warm drift
//     (old glass and cement transmit less blue at large field angles).
//
// Changes vs the original, all consequences of running inside a film pipeline:
//   - samples are interpolated in LINEAR light (the original lerped 8-bit
//     gamma-encoded values, which darkens and fringes edges);
//   - no "Hunt" chroma compensation: the darkened corners now go through the
//     negative and the scan, whose response to under-exposure is the real
//     thing the compensation was imitating;
//   - output is float, never re-quantised to 8 bit before the film;
//   - works on any sub-rectangle with FRAME coordinates, sampling the whole
//     frame, so export tiles are seamless and match the preview exactly;
//   - displacement, smear and falloff are fractions of the corner radius, so
//     the look is identical at preview size and at 12 MP;
//   - the smear uses ~1 tap per pixel of its length (the original capped it at
//     7 taps, so long smears broke into discrete stippled copies);
//   - CA is calibrated in µm on the 35 mm frame (see CA_MAX_UM), ~7× below the
//     original's ceiling, so the whole slider range stays within real glass.
import { LIN8, P3_TO_REC2020, displayGain } from './color.js';

// Lateral colour at the corner at amount 1, in µm on the film: a strong toy /
// vintage lens. Expressed on the 35 mm frame (half diagonal 21.63 mm) like the
// engine's own physical units. The original used 0.018 of the corner radius
// (~390 µm, ~45 px at 12 MP): far beyond real glass, it read as an RGB glitch.
const CA_MAX_UM = 60;
const HALF_DIAG_UM = 21633;
const CA_MAX = CA_MAX_UM / HALF_DIAG_UM;   // fraction of corner radius
const CA_BLUR = 0.55;       // radial smear length, fraction of the displacement
const CA_TAPS = 32;         // tap cap; taps ≈ 1 per pixel of smear so it stays continuous
const CA_BLUE_K = 1.35;     // blue disperses more than red
const AXIS_X = 0.018;       // optical axis offset, fraction of min(w, h)
const AXIS_Y = -0.012;
const ANISO_Y = 1.06;       // real elements are never perfectly symmetric
const VIG_MAX = 0.72;       // corner loses up to 72% of light (~1.8 stops) at amount 1
const VIG_T = 0.90;         // field-width term of the cos⁴ falloff
const VIG_KNEE = 0.55;      // where the mechanical cutoff starts, fraction of radius
const WARM_R = 0.06;        // linear gain on R per unit of light lost
const WARM_B = 0.08;        // linear cut on B per unit of light lost
const LUT_N = 2048;

// Shared with the WebGPU implementation (lens-gpu.js).
export const LENS_CONST = { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B };
export const lensActive = (l) => l.ca > 0 || l.vignette > 0;

// Coverage curve: 0 on the axis, 1 at the farthest corner.
// falloff 0 → cos⁴ optical falloff; 1 → mechanical cutoff. Blending the two
// (rather than steepening cos⁴) keeps both ends meaningful; g(u) ~ u² near
// the axis, so CA stays finite there.
function coverageLUT(falloff) {
  const lut = new Float32Array(LUT_N + 1);
  const raw = (u) => (1 + (u * VIG_T) ** 2) ** -2;
  const r1 = raw(1), denom = (1 - r1) || 1;
  for (let i = 0; i <= LUT_N; i++) {
    const u = i / LUT_N;
    const soft = (1 - raw(u)) / denom;
    let t = (u - VIG_KNEE) / (1 - VIG_KNEE);
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    lut[i] = soft + (t * t * (3 - 2 * t) - soft) * falloff;
  }
  return lut;
}

/** Frame-level lens geometry for a W×H frame. */
export function lensGeometry(W, H, { ca, vignette, falloff }) {
  const m = Math.min(W, H);
  const cx = W / 2 + AXIS_X * m, cy = H / 2 + AXIS_Y * m;
  const rMax = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const dR = ca * CA_MAX * rMax;
  return { cx, cy, rMax, falloff, cov: coverageLUT(falloff), dR, dB: -dR * CA_BLUE_K, blur: dR * CA_BLUR, depth: vignette * VIG_MAX };
}

// Bilinear sample of channel `c` of 8-bit RGBA `data`, interpolated in linear light.
function sample(data, W, H, c, x, y) {
  x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
  y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
  const x0 = x | 0, y0 = y | 0, x1 = x0 < W - 1 ? x0 + 1 : x0, y1 = y0 < H - 1 ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0, r0 = y0 * W, r1 = y1 * W;
  const a = LIN8[data[(r0 + x0) * 4 + c]], b = LIN8[data[(r0 + x1) * 4 + c]];
  const d = LIN8[data[(r1 + x0) * 4 + c]], e = LIN8[data[(r1 + x1) * 4 + c]];
  const t = a + (b - a) * fx;
  return t + (d + (e - d) * fx - t) * fy;
}

/**
 * Engine input for the region (x0, y0, w, h) of the W×H frame `data` (8-bit
 * RGBA), with the lens applied in frame coordinates and the result multiplied
 * by `scale`. With `inverse` the interpolated display-linear samples are turned into
 * scene light (color.js displayToScene); without it they are used as-is. Linear Rec.2020 when `p3`,
 * else linear sRGB — same contract as
 * common.js `extractLinear`, which this replaces when a lens is active.
 */
export function extractLens(data, W, H, p3, x0, y0, w, h, scale, geo, inverse = false) {
  const { cx, cy, rMax, cov, dR, dB, blur, depth } = geo;
  const M = P3_TO_REC2020;
  const rgb = new Float32Array(w * h * 3);
  const caOn = dR > 0;
  let j = 0;
  for (let y = y0; y < y0 + h; y++) {
    const dy = y - cy;
    for (let x = x0; x < x0 + w; x++, j += 3) {
      const dx = x - cx, r = Math.sqrt(dx * dx + dy * dy);
      const fi = (r / rMax) * LUT_N, f0 = fi | 0;
      const g = f0 >= LUT_N ? cov[LUT_N] : cov[f0] + (cov[f0 + 1] - cov[f0]) * (fi - f0);   // one lookup drives both effects
      let R, G, B;
      if (caOn && r > 0.5) {
        const ux = dx / r, uy = (dy / r) * ANISO_Y;
        const oR = dR * g, oB = dB * g, L = blur * g;
        if (L < 0.5) {
          R = sample(data, W, H, 0, x + ux * oR, y + uy * oR);
          G = LIN8[data[(y * W + x) * 4 + 1]];
          B = sample(data, W, H, 2, x + ux * oB, y + uy * oB);
        } else {
          // Smear each channel along its own radial displacement (G too, at zero offset).
          const taps = Math.min(CA_TAPS, Math.max(3, Math.ceil(L) + 1));
          const step = L / (taps - 1), half = L / 2;
          R = G = B = 0;
          for (let t = 0; t < taps; t++) {
            const o = t * step - half;
            R += sample(data, W, H, 0, x + ux * (oR + o), y + uy * (oR + o));
            G += sample(data, W, H, 1, x + ux * o, y + uy * o);
            B += sample(data, W, H, 2, x + ux * (oB + o), y + uy * (oB + o));
          }
          R /= taps; G /= taps; B /= taps;
        }
      } else {
        const i = (y * W + x) * 4;
        R = LIN8[data[i]]; G = LIN8[data[i + 1]]; B = LIN8[data[i + 2]];
      }
      if (inverse) { const k = displayGain(Math.max(R, G, B)); R *= k; G *= k; B *= k; }
      let k = scale;
      if (depth > 0) {
        const lost = depth * g;           // fraction of light the lens loses here
        k *= 1 - lost;
        R *= 1 + WARM_R * lost;
        B *= 1 - WARM_B * lost;
      }
      if (p3) {
        rgb[j] = (M[0][0] * R + M[0][1] * G + M[0][2] * B) * k;
        rgb[j + 1] = (M[1][0] * R + M[1][1] * G + M[1][2] * B) * k;
        rgb[j + 2] = (M[2][0] * R + M[2][1] * G + M[2][2] * B) * k;
      } else {
        rgb[j] = R * k; rgb[j + 1] = G * k; rgb[j + 2] = B * k;
      }
    }
  }
  return rgb;
}
