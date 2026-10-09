// Interno / luce scarsa: a pure function of the checkbox (see eval/INTERNO.md).
// No DOM: used by app.js and by eval/dng2npy.mjs.

export const INTERNO_EV = 2;   // the film sees scene x 2^-INTERNO_EV

/** Parameters of the Interno toggle: { under: U, gains: [1, 1, 1], grain: 2^(0.5 U) } (density grain is amplified by the scanner gain). */
export function internoParams() {
  return { under: INTERNO_EV, gains: [1, 1, 1], grain: 2 ** (0.5 * INTERNO_EV) };
}
