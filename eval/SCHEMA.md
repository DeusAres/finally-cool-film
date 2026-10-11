# eval contract (shared by spec, harness, calibration)

Scene: synthetic chart, scene-linear, rendered by `spektrafilm-eval`.
- `grey`: neutral patches at reflectance 0.18 * 2^ev, ev = -4..+5 step 1/3 (lit by D55-ish daylight = film reference).
- `cc24`: X-Rite ColorChecker 24 (classic), reference Lab D50 (BabelColor/X-Rite post-2014), at normal exposure.
Output: final displayed image (after scanner), sRGB-encoded, converted to CIELAB D50 (Bradford from D65).
Exposure is absolute: no normalisation to the 0 EV grey patch. The 0 EV patch (reflectance 0.18) is only the reference for gradation checks; spec targets are absolute L*a*b* of the output.

## eval/gold200_spec.json
{
  "version": 1,
  "grey":   [ { "ev": -4.0, "L": [lo,hi], "a": [lo,hi], "b": [lo,hi] }, ... ],
  "cc24":   [ { "id": 1, "name": "dark skin", "ref_lab": [L,a,b],
                "target_lab": [L,a,b], "tol_de00": x,
                "chroma_ratio": [lo,hi] | null, "hue_shift_deg": [lo,hi] | null } , ... ],
  "global": [ { "id": "mean_chroma_ratio", "target": [lo,hi] },
              { "id": "grey_ab_max_dev_mid", "target": [lo,hi] }, ... ],
  "weights": { "grey": w, "cc24": w, "global": w },
  "sources": [ "..." ]
}
Derived quantities the harness computes (only these ids are allowed in "global"):
- mean_chroma_ratio: mean over cc24 chromatic patches (1-18) of C*out/C*ref
- red_chroma_ratio, yellow_chroma_ratio, green_chroma_ratio, blue_chroma_ratio, skin_chroma_ratio (patches 15,16,14,13,{1,2})
- skin_hue_deg: mean hue angle of patches 1,2
- sky_hue_deg: hue angle of patch 3
- foliage_hue_deg: hue angle of patch 4
- grey_slope_mid: dL*/dEV averaged over ev -1..+1
- grey_slope_shadow: dL*/dEV over ev -4..-2
- grey_slope_high: dL*/dEV over ev +2..+5
- grey_ab_max_dev_mid: max |(a*,b*) - mean(a*,b*)| over ev -1..+1 (cast stability)
- black_L: L* at ev -4 ; white_L: L* at ev +5

## harness output: eval/out/<run>/report.json
{ "grey":[{"ev","L","a","b"}], "cc24":[{"id","L","a","b","C","h","de00","pass"}], "global":{id:value},
  "score": 0..100, "fails":[ "..." ] }
Score: weighted mean of per-item pass fraction, where a range item scores 1 inside, decays linearly to 0 at 2x the half-width outside.
