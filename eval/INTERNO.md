# Interno / luce scarsa — current model

A pure toggle (Luce tab), off on every photo load, no EXIF or white-balance coupling.

When ON (all physics, no tints):
1. Thin negative: the film sees scene × 2^-`INTERNO_EV` (2 EV, `web/lib/interno.js`). The camera meter
   (app auto exposure) does not compensate it.
2. Lab recovery: Frontier AutoSetup runs on the thin negative (cached per Interno state, so off→on→off is exact).
   The film-type setup neutralises only the normal density range (`setup_neutral_ev` = ±2 EV); below it the toe
   keeps its layer imbalance (`setup_toe_slope`) → cyan recovered shadows, warm mids, milky blacks.
3. Grain: amplified by the scanner gain, grain amount × 2^(0.5·U) (`internoParams().grain`).

Shared code: `internoParams()` → `{ under: 2, gains: [1,1,1], grain: 2 }`, used by `web/app.js` and
`eval/dng2npy.mjs --interno`. Harness: `sf-eval image ... --under 2` (or `under` in the meta JSON).
