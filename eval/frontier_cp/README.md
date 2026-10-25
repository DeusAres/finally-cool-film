# Real Frontier reference (v4 Frontier calibration)

Data (not in this repo: no licence stated, © O10 Media LLC, used for measurement only): the Color Precision
[film comparison tool](https://www.colorprecision.com/pages/film-comparison-tool). The same negatives are scanned on a "Frontier"
and a "Noritsu", 3128×2082 sRGB PNGs, exported from Lightroom. Per the page there were no colour adjustments, only "minor exposure
adjustments". The lab is not named. The Charts set has Gold 200 at -1 / 0 / +1 / +2 EV (and 0 EV tungsten, and a +1 push) with:
- a ColorChecker Digital SG (Calibrite);
- a SpyderCheckr 24;
- a Kodak Q-13 grey scale.

Files: `colorprecision-cdn.s3.us-east-1.amazonaws.com/Pictures-for-Slider-Comparison/Charts/Gold-0EV-Frontier.png` etc.
SG reference: X-Rite Lab D50, November 2014 edition, from [zenodo.org/records/3245895](https://zenodo.org/records/3245895)
(`ColorCheckerSG_After_Nov2014.txt`, put it in WORK or set `SG_REF`).

Run from a WORK directory (needs sf-eval, scripts/eval/build-sf-eval.sh; python with numpy, scipy, opencv, Pillow):

    python3 -I measure_real.py CHARTS/Gold-0EV-Frontier.png CHARTS/Gold-*EV-*.png > real.json   # SG 140 + Kodak 20 patches
    python3 -I measure_real.py CHARTS/Gold-0EV-Frontier.png --check                            # sg_check.jpg: the boxes
    SET=Studio python3 -I measure_real.py STUDIO/Gold-0EV-Frontier.png STUDIO/Gold-*.png > real_studio.json   # SG on black
    python3 -I measure_charts.py CHARTS/Gold-0EV-Frontier.png CHARTS/*.png > charts_measure.json  # Spyder + Kodak (Charts)
    CP_SLIDER=SLIDER python3 -I recon.py && python3 -I autorecon.py NAME '{auto params}'      # Auto on the rebuilt real frames
    CP_SLIDER=SLIDER python3 -I recon_model.py NAME '{auto params}' [SET/FRAME ...]   # level error on any frame (SCAN=Noritsu)
    python3 -I sim.py ext '{"scanner":{"frontier":{"model":{"gradation_a":0.001,"shoulder_sharpness":0,"black_point":0,
        "white_point":1,"range_density":2.4,"cool_neutral_warm":0,"highlight_neutral":0}}}}' -1 0 1 2   # linear curve: density per patch
    python3 -I fit_tone.py Frontier gradation_a,black_point,white_point '{"shoulder_sharpness":0,"shoulder_start":0.95}'
    python3 -I fit_colour.py NAME '{tone}' '[density,c,m,y]' saturation,saturation_blue,blue_hue_shift,green_hue_shift
    python3 -I colour.py NAME '{model}' EV        # nuisance keys fitted on the greys, then chroma / hue / L by hue family
    python3 -I probe.py NAME '{sf-eval overrides}'  # one render, fixed keys: lightness vs the grey of the same reference L*, by family
    python3 -I proto_hs.py col_0.json:Gold-0EV-Frontier col_m1.json:Gold-minus1EV-Frontier ...   # per-hue saturation prototype
    python3 -I grid.py out.png Gold-0EV-Frontier col_A.json col_B.json   # split patches: real | renders

## Method
- `sim.py` builds the chart as a scene-linear Rec.2020 frame:
  - the SG patches from the reference Lab (Bradford to D65), in the real layout at half the real pitch (36 mm = 1564 px);
  - the Kodak steps at reflection density 0.05 + 0.1 i (nominal, unverified);
  - a dense neutral ramp;
  - a neutral surround.

  The frame is rendered with sf-eval (`--gains`: AutoSetup runs on the frame), with the v4 Frontier params of `mkfrontier.py`.
  That mirror of app.js is written by hand, without V4_FRONTIER.
- Nuisances: the operator's / Lightroom's brightness (the Frontier density key, per frame), the colour balance (C M Y keys, fitted
  on the SG greys; the wall and the lab's AutoSetup are unknown), the Kodak card's light (it reads ~0.5 EV darker than the SG on
  both machines: lower in the frame).
- Tone: the gradation stage is per channel after the film-type setup, so one render with a near-linear curve gives each patch's
  normalised density; `curve.py` (a port of frontier.rs Gradation, matches the engine to 0.004 encoded) then fits the curve in
  Python.
- Colour: Nelder-Mead on the mean CIEDE2000 of the 76 chromatic SG patches, one render per evaluation. I4 and M3 are left out:
  on this Calibrite chart they differ from the X-Rite data (both machines agree with each other, 45-90° away in hue from the
  reference).

## Results (2026-10-22)
- **Tone.** The real machines have a steeper gradation than the old guessed curve (a 9.6 Frontier / 9.3 Noritsu, 6.2 before):
  deeper lower mids and blacks (Kodak step 15: 7 L* real, 13 ours), firmer mids, no shoulder needed. Grey L* rms is 2.6 -> 1.2
  over -1..+2 EV.
- **Colour.** The real Frontier keeps 0.80 of the chart's chroma (Noritsu 0.90, the old v4 1.12): saturation 0.84. The cyan-blue
  boost of v3.16 goes (0.15 -> 0.05). v3's hue rotations are confirmed (fitted 22 / 20 deg vs 17 / 24). dE00 7.2 -> 6.6
  (0 EV, fitted), 7.5 / 7.2 / 7.6 -> 6.0 / 6.4 / 6.5 (-1 / +1 / +2 EV, held out).
- **Step 2: saturated greens and cyans.** After step 1 they were 5-11 L* (vivid greens up to 21 L*) lighter than on the real
  Frontier, measured against a grey of the same reference L* (`probe.py`, so the keys do not matter).
  - Ruled out by experiment:
    - DIR inhibition 0.6 helps but is film stage, and gold200 wants 1.0;
    - a steeper short-wavelength flank of the green layer only moves the cyans 9.9 -> 8.2 and makes greens / blues worse;
    - a green sensor band at 559 nm fits better with fixed keys, but with refitted keys the gain is only 0.3-0.5 dE00, the
      blue gets worse, and the second-hand LED graph says 537 nm.
  - Fix: a scanner-stage op that darkens saturated colours, chromaticity kept. Fujifilm documents its 3D LUT acting on
    "highly saturated cyan/green" (IS&T ICIS 2006).
    - First version: `cyan_green_darken`, opponent hues ~112-214 deg, in proportion to relative chroma (0.19-0.66),
      prototyped with `proto.py`, fitted 0.46.
    - It is now `hue_lightness` (step 4).
  - Result with that first version: greens / cyans lightness +3.8 / +9.9 -> +2.0 / +0.2 L*. dE00 at 0 / -1 / +1 / +2 EV:
    5.7 / 4.8 / 5.2 / 5.4 (step 1: 6.6 / 6.0 / 6.4 / 6.5).
- **Step 3: chroma by hue.** After step 2 reds / skin / magentas / blues were 1.2-1.4x the real chroma, yellows / greens 1.0.
  Engine `hue_saturation` adds a saturation gain per hue (6 knots on the opponent hue: red, yellow, green, cyan, blue, magenta).
  It was prototyped on the rendered patches (`proto_hs.py`, fit at 0 EV, tested on the others), then refitted with the engine:
  0.88 / 1.06 / 0.97 / 1.04 / 0.73 / 0.64. dE00 0 / -1 / +1 / +2 EV: 5.3 / 4.5 / 4.8 / 5.1 (step 2: 5.7 / 4.8 / 5.2 / 5.4);
  chroma 1.05 of the real overall.
- **AutoSetup (density and colour).** The PNGs' Lightroom settings (XMP) are all 0, with a linear curve and white balance as
  shot. So brightness and casts are the lab's, not a post adjustment.
  - Density, exposure. Over -1..+2 EV the real Frontier keeps the SG mid grey at L* 66.8-69.2: full compensation. v4 uses
    strength 1.0; v3's 0.85 drifted ~+11 L*.
  - Density, level: v3's (target_offset 0.0109) up to 4.0; 4.1 below ("Level since 4.1").
    - A first fit on the Charts frame alone (target 0.16, `autolevel.py` on a synthetic frame with the wall and the board)
      matched its 67 L* but made outdoor photos washed out (user; sea / rock mean L* 51 / 47 -> 67 / 60).
    - The other frames with charts show the lab's level depends on the scene. Mid grey: grey wall 67, black studio 80
      (`SET=Studio measure_real.py`), outdoors 53 (Spyder greys; their reflectance read off the Charts frame).
    - `recon.py` rebuilds each frame's scene from the scan through its own grey patches; `autorecon.py` runs our Auto on it:
      | AutoSetup | wall | black | outdoors |
      |---|---|---|---|
      | target 0.16 | 75 | 86 | 76 |
      | v3 target, strength 1.0 | 58 | 86 | 59 |
    - Ours tells the wall frame from the outdoor one much less than the lab does. The outdoor scan's clipped background hides
      how bright it really was, so the reconstruction is weakest there. The v3 level is the one closest outdoors, the app's
      use.
  - Colour, from the tungsten frame. Real Frontier, tungsten over daylight, greys dark / mid / light: b* +12 / +25 / +14, a* -4
    at mid (the red goes). The Noritsu corrects more. Ours, under a simulated 3200 K (`sim.run(..., gains=(1.486, 1, 0.439))`,
    the Planckian / D65 ratio in Rec.2020), with k_col x strength:
    - 0.26 (v3) leaves +29 / +35 / +26, a* +9;
    - 0.6 leaves +24 / +24 / +12;
    - 0.85 leaves +19 / +18 / +6.
  - v4 uses 0.68 (app.js V4_AUTO), a lower bound: the light's temperature is not known.
  - Level since 4.1: the key is read partly from the highlights (engine `highlight_weight`: the key that puts the G 95th
    percentile on the knee, blended with the trimmed-mean key; both move alike with exposure, so the compensation stays full).
    Grid on the three rebuilt frames (mid grey, wall / black / outdoors; real 67 / 80 / 53):
    | highlight_weight, target_offset | wall | black | outdoors | rms |
    |---|---|---|---|---|
    | 0, 0.0109 (v3) | 58 | 86 | 59 | 7.2 |
    | 0.5, -0.10 | 60 | 81 | 56 | 4.3 |
    | 0.6, -0.12 | 62 | 79 | 57 | 3.6 |
    | 0.7, -0.16 | 64 | 77 | 58 | 3.9 |
    | 0.8, -0.16 | 68 | 76 | 61 | 4.7 |
    v4 uses 0.6 / -0.12. The outdoor frame's mean and 95th percentile in EV sit within 0.1 / 0.4 of the wall frame's, so no
    statistic of the frame explains the lab printing it ~14 L* darker; it stays ~4 L* too bright.
  - Check on frames without grey patches (`EVS=-1,0,1,2 recon_model.py`): each scene's 0 EV scan is turned back into a scene
    through our own tone curve at zero keys (fitted to the real one), then exposed by 2^ev as the camera did; our render's mean
    L* is compared with the real frame at that EV. All 20 Gold Frontier frames, mean L* ours - real per scene (+ = brighter):
    | | Charts | Studio | Daylight | Landscape | Night | rms (20) |
    |---|---|---|---|---|---|---|
    | v3 level (4.0) | -8.7 | +3.0 | +2.1 | -12.4 | +8.6 | 8.2 |
    | 0.6 / -0.12 (4.1) | -3.1 | -0.5 | +3.7 | +2.0 | +0.5 | 2.8 |
    Landscape and Night were not in the fit. Left: at +2 EV the harbour is +4.8 (its highlights in the film's shoulder, where
    density per EV falls, under-correct). The highlight term read in EV along the grey ramp fixes it but over-corrects the
    other scenes at +2 EV (rms 3.2 / 3.4 / 3.5 at target -0.12 / -0.08 / -0.16): not taken.
    The default mode (each frame rebuilt from its own scan) loses the negative's exposure: it is a level check at 0 EV only.
    The Noritsu, exposure-faithful (`SCAN=Noritsu EVS=...`): rms 4.7 L* over the 20 frames (Charts -3.1, Studio -0.2,
    Daylight +6.3, Landscape +4.8, Night -4.4 mean). The Frontier's blend (highlight_weight 0.4-1.0, target -0.36..+0.12,
    margin back to 0.1672, fitted on Charts / Studio / Daylight) does not beat its highlight-anchored setup there (4.9-13.0 vs
    4.5 L*): its grey-wall vs outdoor gap (~12 L*) is not in those statistics either. Kept.
- **Step 4: lightness and hue by hue.** After step 3, saturated colours of every hue were still lighter than real (blues
  +4.8 L*), and the cyans were 24 deg greener.
  - Engine `hue_lightness` (6 knots, the same chroma ramp 0.19-0.66) replaces `cyan_green_darken`; `hue_shift` (6 knots, deg,
    luminance kept) is added.
  - Prototyped with `proto_hl.py` on renders without the old op (fit at 0 EV, tested on the others):
    - lightness 0.91 / 0.92 / 0.46 / 0.75 / 0.90 / 0.96;
    - rotation 3 / 1 / 6 / 7 / -5 / 12 deg.
  - Engine, keys refitted: dE00 0 / -1 / +1 / +2 EV 4.4 / 4.0 / 3.9 / 4.1 (step 3: 5.3 / 4.5 / 4.8 / 5.1). Chroma 1.06 and
    lightness +0.1 L* of the real; blues +1.8 L*; cyan hue -18 deg.
- **Open questions.**
  - Cyan, per patch (`colour.py` at the 4 EVs, sim - real hue): the "cyan family -18 deg" median was set by the dark /
    low-chroma patches (B7, E9, J2: chroma 7-18, their hue swings -63..+2 deg with EV) and by D9. Consistent errors: green-cyans
    C9 / D9 / F9 (opponent hue 155 / 169 / 183) -12 / -19 / -7 deg; the greens below 146 and the cyans / blues from 215 are within
    5 deg. `proto_rot.py` (an extra rotation, 12 knots, fit at 0 EV): all knots free -> dE00 -0.06..-0.17, D9 -20 -> -16; only the
    150 / 180 / 210 knots -> -0.03..-0.11, F9 overshoots before D9 is fixed. D9 sits 49 deg from C8 in our render, ~28 on both
    real machines and on the reference: an error of our film / sensor chain on that dye, not a hue-smooth scanner trait. Left as
    is (a scanner-stage patch would be the wrong stage and buys <= 0.1 dE00).
  - Violets -16..-27 deg (3-4 patches).
  - Red -> orange separation (a user's lantana DNG, IDG_20261018_182846_761: the orange florets came out red). On the chart,
    hue M4 (red) -> I7 (orange): reference 31 deg, real Frontier 33, ours 16 at every EV (reds +7..+15 deg towards orange,
    oranges -5..+3: too red); Nessuno shows the same squeeze on the DNG (orange 44 -> 31 deg), so it starts in our film /
    sensor chain. Tried in the scanner stage with `proto_rot.py` (an extra rotation, fit at 0 EV, SEP=M4,I7):
    | basis, knots, SMOOTH | dE00 0 / -1 / +1 / +2 EV (now 4.30 / 3.93 / 4.02 / 4.15) | separation (real 27-34) |
    |---|---|---|
    | opponent, 24 (15 deg), 0 | 3.96 / 3.82 / 3.82 / 3.91 | 26-33, but the knots swing +5.6 / -6.3 / +4.8: banding on gradients |
    | opponent, 24, 0.002 | 4.12 / 3.78 / 3.93 / 4.03 | 21-27 |
    | OkLab, 24, 0 | 4.19 / 3.85 / 4.07 / 4.14 | 21-26 |
    | OkLab, 24, 0.002 | 4.23 / 3.84 / 4.05 / 4.14 | 18-24 |
    No smooth hue rotation gives the separation back: left as is (the fix belongs to the spectral chain).
    Fixed in 4.6 in the scanner's spectral read instead: the Frontier's green sensor band. The real Frontier separates red and
    orange more than the real Noritsu on the same negatives (33 vs 22 deg), so the bands set it. `colour.py` at 0 EV, old hue
    ops: G peak 525 / 540 / 555 / 565 / 575 nm -> separation 12 / 16 / 23 / 28 / 32 deg, dE00 4.83 / 4.30 / 4.24 / 5.19 / 6.80
    (R 630 / 670 and narrower bands: no gain). At 555 nm the per-hue ops were refitted (`proto_all.py` on renders without them,
    fit at 0 EV) with `warm_hue_shift` 6 (skin, +8..+14 deg yellow before): engine dE00 3.93 / 4.30 / 4.02 / 4.15 -> 3.79 /
    4.17 / 3.89 / 3.85 (-1 / 0 / +1 / +2 EV), separation 14-19 -> 18-28, skin +2..+11 deg. 565 nm separates more but the ops
    cannot hold the rest (refit dE00 4.13-4.62). The new band moves the setup densities: AutoSetup target_offset -0.07 -> -0.04,
    the 20 frames' level rms 2.6 -> 3.2 L* (overexposed frames a little darker). The earlier rejection of a 559 nm band (step 2)
    was with the old hue ops.

## Noritsu (app.js V4_NORITSU, V4_NORITSU_AUTO)
The same frames on the tool's Noritsu, with the same method; the Frontier's scanner model takes the Noritsu's parameters.
- **Tone.** `fit_tone.py Noritsu`: a 9.26, black 0.025, white 1.0 (opener whites than the Frontier); grey L* rms 1.25.
- **Colour.**
  - Start: `SCAN=Noritsu colour.py` with neutral colour (no v3 ops), dE00 6.4-6.7.
  - `proto_all.py` fits the 18 per-hue values at 0 EV: dE00 4.3 / 4.5 / 4.5 / 4.5 in the engine (-1..+2 EV held out), chroma
    1.06 of the real.
  - The magenta rotation (31 deg), checked per patch (`SCAN=Noritsu colour.py` at the 4 EVs, with it and with the magenta knot
    at 0): dE00 4.75 / 4.86 / 4.87 / 4.93 -> 4.31 / 4.49 / 4.48 / 4.49 (0 / -1 / +1 / +2 EV). It is carried by H3 / B4 / C2 / B3
    (opponent hue 331-348, hue error -13..-30 deg without) and partly B2 / M2 / L4 (15-24); no patch worsens by more than 0.2.
    It is the machine's: the real Noritsu renders the same negatives' magentas / purples / violets 8-24 deg redder than the real
    Frontier (9 patches, every EV). Kept. Left: violets I2 / C3 (opponent 284) -20 deg, as on the Frontier (a narrow feature
    next to blues that are right, see the cyan note).
- **Balance.** The Noritsu's greys are warm in the shadows / mids and neutral in the lights:
  - chart frame: mid b* +13 (Frontier +4.5);
  - outdoors: Spyder greys +7 to +11 in the mids / darks, ~0 in the lights.

  So C M Y +0.02 / +0.05 / +0.075 over the Frontier's balance: the mean of the chart fit and about half of it outdoors.
- **AutoSetup.** The Noritsu compensates exposure fully but barely lifts the frame on black (mid grey 67 vs 70 on the wall; the
  Frontier 80 / 67).
  - A lower density clamp reproduces the frame on black but breaks the exposure compensation (+2 EV: 72); trimming the dark
    percentiles shifts every frame alike.
  - What fits is a highlight-anchored setup, the engine's highlight guard: margin -0.08, target 0.15.
  - Rebuilt frames, mid grey, wall / black / outdoors: 68.7 / 58.7 / 57.9 (real 69.7 / 66.9 / 54.0; the v3 setup 58.8 / 83.8 /
    59.5). On the Frontier the same scheme makes outdoors brighter (61-66 vs real 53), so the Frontier keeps v3's level.
  - Tungsten: the Noritsu leaves b* -3 / +7 / +5 over daylight. k_col 1.15 and clamp_colour 0.3 match (1.0 / 1.3 leave
    +11 / +9 / +7 and +3 / -5 / -5).
