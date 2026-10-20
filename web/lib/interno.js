// Interno / luce scarsa: a pure function of the checkbox (see eval/INTERNO.md).
// No DOM: used by app.js and by eval/dng2npy.mjs.

export const INTERNO_EV = 2;   // the film sees scene x 2^-INTERNO_EV

/** Parameters of the Interno toggle: { under: U, gains, grain }. Since v3.39 gains and grain are identity (the light colour is
 * the scene's, the grain no longer boosted: x2 until v3.30, x1.41 until v3.38); kept as fields because dng2npy.mjs and app.js
 * read them. */
export function internoParams() {
  return { under: INTERNO_EV, gains: [1, 1, 1], grain: 1 };
}
