# Frontier / Gold 200 calibration (harness: sf-eval chart, spec gold200_spec.json)
Score 82.9 -> 97.3 (fails 59 -> 17). Overrides: `best_overrides.json` (JSON only, no code, halation untouched).

## Diagnosis
- Tone: the chart runs with auto=[0,0,0,0], so AutoSetup (k_den, target_offset) is not involved; only the fixed
  `mid_grey_out` sets the 0 EV level. Gold's G density is ~0.17 logD/EV; `range_density` 2.0 maps that to 0.085 x/EV,
  so slope was 10.4 L*/EV however steep the sigmoid. The film gamma is not the limit: the scanner range was too wide.
- Yellow/orange: not the sensors (computed from the profile dyes: sensor cross-talk is <0.02 of the dye density) and not
  the inversion or the film-type fit (grey neutral to 0.5 a*/b*). Film density of yellow (C1.08 M1.02 Y0.26 vs white
  1.09/1.07/1.16) is fine; the low chroma (x0.80) was the tone curve: the patch sits at +1.5 EV, where L* was 8-12 too
  low and the shoulder squashed it. Raising slope/shoulder fixed ΔE 13 -> 9; the rest is hue (+7 deg, greener).

## Changes (all in `scanner.frontier.model` unless noted)
- range_density 2.0 -> 1.4: scanner/paper density range narrower = steeper positive gradation. Mid slope 10.4 -> 15.6 L*/EV.
- mid_grey_out 0.46 -> 0.48: 0 EV L* 49.4 -> 51.4 (spec 54 +-5; AutoSetup density target equivalent). All grey ramp points now pass.
- shoulder_start 0.82 -> 0.74, shoulder_sharpness 1.6 -> 2.0: +2 EV L* 70.8 -> 83.8 (target >=80), white L* 99.0, "strong shoulder".
- black_point 0.02 -> 0.05: black L* 12.6 -> 5.8 (deep Frontier blacks, spec 3-14).
- gradation_a 4.2 -> 4.5, white_point 0.98 -> 0.99: slightly harder mid contrast, white L* inside 93-99.5.
- saturation kept 1.12: with the steeper curve mean chroma ratio fell 1.23 -> 1.02; no extra boost needed.
- sensor_peak_nm R 650 -> 640 (-10), B 445 -> 450 (+5); sensor_fwhm R 45 -> 40: both within +-15 nm of Status M. R toward
  the cyan-dye flank and B toward the yellow-dye peak (450 nm) separate the yellow/orange/red dyes better. Hue of 7/9/15 improved.
- film_render.dir_couplers: amount 0.8, inhibition_interlayer 0.8, inhibition_samelayer 0.7 (within 0.5-1.5x, sits at the
  lower edge). Less inter-layer inhibition = more colour separation; biggest single gain in the sweep (+3.6 points).
  Low physical certainty: the DIR defaults came from the profile, I could not verify them against Gold data.

## Robustness (camera.exposure_compensation_ev, same overrides, no AutoSetup in the chart)
-2 EV 54.6 | -1 EV 73.3 | 0 EV 97.3 | +1 EV 77.8 | +2 EV 56.3. The score drops because the harness measures absolute L*
(grey shifts 15 L* per EV and the patches follow), not because colour breaks: mean chroma ratio 0.75 / 0.91 / 1.02 / 1.04 / 0.87.
Highlights are forgiving (+1 EV: L*(+2EV) 94.6, no clipping of hue); shadows lose chroma (-2 EV: mean ratio 0.75).
In the app AutoSetup would re-centre the density, which this chart cannot show.

## Remaining fails (left on purpose)
- yellow 16 (ΔE 9.0, chroma x0.88, hue +7 deg) and orange yellow 12: medium-confidence. Not reachable inside the allowed
  ranges without bending greens; a hue fix needs a per-hue matrix, which is forbidden.
- foliage/yellow-green hue (+3 deg vs target -8) and foliage chroma 1.32: low-confidence green trait, kept.
- cyan 18, bluish green 6 (chroma 0.75), blue 13 (ΔE 8): low confidence, not chased.
- skin chroma 1.14 (dark skin 1.35 over, light skin 0.93 under): tone-dependent, same curve cannot serve both.
- Grey is neutral rather than warm (spec b* +4, low-med): film-type setup neutralises it; no warm-mid key used.
- Debug print used for diagnosis was removed; note it had been swept into commit 334dceb by the concurrent agent, so frontier.rs shows a 2-line uncommitted deletion.
