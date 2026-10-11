# Grain v2 contract (binding)

Goal: physical colour-negative grain on the GPU path = the engine's dye-cloud model, per layer (C/M/Y) in
negative DENSITY, before the Frontier scanner LUT. `web/lib/grain.js` grain is removed.

## Engine
- `film_render.grain` (existing GrainParams: particle area/scale, uniformity, sub-layers, dye-cloud blur,
  micro_structure) + new fields:
  - `rng: "hash"` (new default) — counter-based per-pixel RNG (pcg/hash of (seed, layer, sub-layer, global px)),
    Poisson/binomial sampled per pixel (exact inversion for small lambda, normal approx above ~30). The old
    MT19937 path stays as `rng: "numpy"` (Python parity).
  - `amount` (f64, default 1): user slider multiplier on grain strength (implemented physically: scales the
    particle area, i.e. fewer/larger clouds = coarser; or the amplitude — implementer chooses, documents).
  - `origin_px: [x0, y0]`, `frame_px: [W, H]`: the region's position in the full frame, so preview, tiles and
    export hash the SAME grain at the same film location (seamless tiles; size in µm on the 35 mm frame).
  - `seed: u64` per photo (app passes its per-file seed).
- ONE formula in Rust (CPU) mirrored in WGSL (GPU), parity test like the frontier LUT test. Runs in the GPU
  resident chain on the density image right before the scanner LUT. Dye-cloud blur via the existing gaussian
  blur shaders. `active=false` or amount 0 = bit-identical to no grain.
- Scanner sharpening: mild unsharp mask after the scan (Frontier), params in µm, default on (calibrated later).

## App
- grain slider → `film_render.grain.amount` (+ Interno factor 2^(U/2) multiplies it), `active = amount > 0`,
  per-file `seed`, `origin_px`/`frame_px` per render/tile. Remove grain code from GRAIN_WGSL (keep gamut/pack).

## Acceptance (mid grey, default amount; measured by sf-eval grain metrics)
- chroma/luma noise std ratio 0.6–1.0; inter-channel correlation 0.1–0.4; kurtosis > 3 or |skew| > 0.2;
  autocorr size Y ≥ M ≥ C; std follows LUT slope (peaks mids, lower at extremes).
- Overall visible intensity per L* band within ±25% of today's grain.js at default (user likes it).
- Survives IG export (1080 px) — visible after JPEG q~80.
