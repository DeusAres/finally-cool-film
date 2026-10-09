# Interno / luce scarsa — contract (binding)

Bug: the toggle does nothing. `underEv()` returns `photo.under` (EXIF estimate), which is 0 for well-lit EXIF,
and any underexposure is then re-normalised by camera auto exposure / AutoSetup.

Physical model when Interno is ON (all physics, no tints):
1. Thin negative: film sees scene × 2^-U, U = clamp(max(EXIF estimate, 1.5), 1, 2.5) EV. The camera meter
   (app auto exposure) must NOT compensate U.
2. Real light colour: daylight film does not white-balance. The film sees the scene under its real illuminant:
   per-channel gains in scene-linear (input space) that undo the camera white balance back to the scene
   illuminant, relative to the film reference (D55). DNG: illuminant from AsShotNeutral (dng.js already
   interpolates by CCT). JPEG: no illuminant data -> fixed 3400 K (mixed tungsten/LED) assumption.
3. Lab: Frontier AutoSetup runs on the thin negative (re-run on toggle). Its density correction may lift up to
   +2.5 EV; its colour correction stays partial (existing k_col), so part of the warm cast survives, as in real
   lab scans. Blacks cannot go below base+fog density -> milky blacks; layer toes differ -> shadow crossover.
4. Grain: density-domain grain is amplified by the scanner gain: grain amplitude × 2^(0.5·U).

Shared code: `web/lib/interno.js` (no DOM) exports
  `internoParams({ under, isRaw, cctK }) -> { under: U, gains: [r,g,b], grain: g }`
  used by app.js AND eval/dng2npy.mjs (single source of truth).
Harness: `sf-eval image ... --under U --gains r,g,b` (no auto-meter compensation of U; AutoSetup on the thin negative).
