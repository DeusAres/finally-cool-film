// Interno / luce scarsa: the one place that turns the toggle into physics (see eval/INTERNO.md).
// No DOM: used by app.js and by eval/dng2npy.mjs.
import { LUMA, illuminantRgb } from './color.js';

export const INTERNO_MIN_EV = 1, INTERNO_MAX_EV = 2.5, INTERNO_FLOOR_EV = 1.5;
export const JPEG_CCT_K = 3400;   // no illuminant data in a JPEG: mixed tungsten / LED
export const FILM_REF_CCT_K = 5503;   // D55, the daylight film's reference light

/**
 * Parameters of an indoor / low-light scene.
 *  - under: EXIF estimate of the underexposure (EV, any value); U = clamp(max(under, 1.5), 1, 2.5).
 *    The film sees scene x 2^-U (the camera meter must not compensate it).
 *  - isRaw / cctK: a DNG gives the as-shot CCT (dng.js); anything else uses JPEG_CCT_K.
 *  - space: primaries the gains are expressed in = the engine input space: 'rec2020' (raw, and P3 files,
 *    default for raw) or 'srgb' (sRGB JPEG, default otherwise).
 * Returns { under: U, gains: [r, g, b], grain }.
 *  - gains: the camera white balance neutralised the scene light; daylight film does not white-balance, so the
 *    film sees it again. gains = rgb(light) / rgb(D55) (von Kries ratio of the two white points in the input
 *    space), divided by its own luminance (LUMA weights of that space) so a neutral keeps its luminance: the
 *    brightness change comes only from U.
 *  - grain: density grain is amplified by the scanner gain, 2^(0.5 U).
 */
export function internoParams({ under = 0, isRaw = false, cctK, space } = {}) {
  const U = Math.min(INTERNO_MAX_EV, Math.max(INTERNO_MIN_EV, Math.max(under, INTERNO_FLOOR_EV)));
  const T = isRaw && Number.isFinite(cctK) && cctK > 0 ? cctK : JPEG_CCT_K;
  const sp = space || (isRaw ? 'rec2020' : 'srgb');
  const light = illuminantRgb(T, sp), ref = illuminantRgb(FILM_REF_CCT_K, sp);
  const g = light.map((v, i) => v / ref[i]);
  const Y = g.reduce((s, v, i) => s + v * LUMA[sp][i], 0);
  return { under: U, gains: g.map((v) => v / Y), grain: 2 ** (0.5 * U) };
}
