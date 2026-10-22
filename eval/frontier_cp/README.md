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
  - Fix: a scanner-stage op, `cyan_green_darken` (engine frontier.rs `cyan_green_weight`). It darkens opponent hues ~112-214
    deg in proportion to relative chroma (0.19-0.66), with the chromaticity kept. Fujifilm documents its 3D LUT acting on
    "highly saturated cyan/green" (IS&T ICIS 2006).
  - Prototyped in Python on the rendered patches (`proto.py col_X.json`), then fitted with the engine: 0.46, refitted
    together with saturation 0.92, blue 18 / green 20 deg.
  - Result: greens / cyans lightness +3.8 / +9.9 -> +2.0 / +0.2 L*. dE00 at 0 / -1 / +1 / +2 EV: 5.7 / 4.8 / 5.2 / 5.4
    (step 1: 6.6 / 6.0 / 6.4 / 6.5).
- **Step 3: chroma by hue.** After step 2 reds / skin / magentas / blues were 1.2-1.4x the real chroma, yellows / greens 1.0.
  Engine `hue_saturation` adds a saturation gain per hue (6 knots on the opponent hue: red, yellow, green, cyan, blue, magenta).
  It was prototyped on the rendered patches (`proto_hs.py`, fit at 0 EV, tested on the others), then refitted with the engine:
  0.88 / 1.06 / 0.97 / 1.04 / 0.73 / 0.64. dE00 0 / -1 / +1 / +2 EV: 5.3 / 4.5 / 4.8 / 5.1 (step 2: 5.7 / 4.8 / 5.2 / 5.4);
  chroma 1.05 of the real overall.
- **AutoSetup (density and colour).** The PNGs' Lightroom settings (XMP) are all 0, with a linear curve and white balance as
  shot. So brightness and casts are the lab's, not a post adjustment.
  - Density. The real Frontier lands the SG mid grey at L* 67.9 / 66.8 / 69.2 / 68.6 for -1 / 0 / +1 / +2 EV: full compensation,
    a bright level. Ours, on a reconstructed frame (`SIM_SURROUND=55,2.5,0` the wall, `SIM_BOARD=1` the white board;
    `autolevel.py`), gave 45.1 / 50.0 / 52.9 / 57.2.
  - With strength 1.0 (full; 0.85 leaves 62 -> 72 over the EVs) and target_offset 0.16: 67.4 / 68.3 / 68.0 / 69.3. The
    clamp_density 0.45 does not bind.
  - The target lifts the density key of every frame by 0.93 EV. The thin-negative ramp moves by as much (0.8 / 1.6 -> 1.73 /
    2.53); otherwise it switched the colour correction off on every frame.
  - Colour, from the tungsten frame. Real Frontier, tungsten over daylight, greys dark / mid / light: b* +12 / +25 / +14, a* -4
    at mid (the red goes). The Noritsu corrects more. Ours, under a simulated 3200 K (`sim.run(..., gains=(1.486, 1, 0.439))`,
    the Planckian / D65 ratio in Rec.2020), with k_col x strength:
    - 0.26 (v3) leaves +29 / +35 / +26, a* +9;
    - 0.6 leaves +24 / +24 / +12;
    - 0.85 leaves +19 / +18 / +6.
  - v4 uses 0.68 (app.js V4_AUTO), a lower bound: the light's temperature is not known.
- **Open questions.**
  - The cyan hue is ~24 deg greener than real; the blues are +5 L*.
