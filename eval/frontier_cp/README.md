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
- **Open questions.**
  - Saturated greens and cyans are 5-11 L* lighter than the real machine: a stage that keeps luminance, as saturation does,
    cannot fix it.
  - The real scans are brighter at Auto: SG mid grey L* 67 F / 70 N, ours ~51 with a surround of the wall's measured
    brightness. How much of that is the "minor exposure adjustment" in post is unknown, so the level is not changed.
  - AutoSetup compensates the exposure fully on the real machines (Kodak mid step within 2-3 L* over -1..+2 EV); ours drifts
    ~+11 L*. In the app Auto meters the scene first, so this only shows when Esposizione is moved after Auto.
