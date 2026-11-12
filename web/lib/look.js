// The look's tuned constants and the pure functions over them (from app.js, 4.45: one module per area). Every number keeps its
// measured reason next to it. app.js imports them; eval/appconst.py reads them (one source of truth for the eval scripts).
// Magenta ↔ Verde / Giallo ↔ Blu: Frontier C/M/Y keys are 0.01 density each (eval/frontier_model.json user_controls); since v3.34
// one slider step is half a key (a whole key per step was too strong), so ±30 reaches ±15 keys.
export const FRONTIER_KEY = 0.005;
// v2-calib: sign of frontier.cmy (+ = more filtration, i.e. the opposite colour); the sliders read +m greener, +y bluer.
export const frontierCmy = (u) => [0, -u.mshift * FRONTIER_KEY, -u.yshift * FRONTIER_KEY];

// Hyper Tone (Scanner, Frontier): a recovery for the extremes (user), with the machine's separate Highlight and Shadow levels,
// 5 steps each (SP-3000: Lower, Low, Normal, High, Higher; 0 here = off). Each level moves an area's light by level / 5 x
// HYPER_MAX of its map EV beyond the mids' dead zone (lib/hypertone.js DEAD_EV), in the input pass before the film (v4.9; it was
// a density lift in the scanner: milky, mottled shadows, hypertone.js). Fujifilm publishes no gains: HYPER_MAX (the top level) is
// a choice; with the dead zone the mids are untouched (the first version flattened whole photos, user).
export const HYPER_MAX = 0.8, HYPER_LEVELS = 5;
export const hyperLevel = (v) => (v / HYPER_LEVELS) * HYPER_MAX;
export const HYPER_NAMES = ['off', 'molto basso', 'basso', 'normale', 'alto', 'molto alto'];
export const HYPER_THUMB_PX = 512;   // the map's source thumb: its resolution is the map's (lib/hypertone.js MAP_LONG)
// The lab operator's keys (Scanner tab, Frontier and Noritsu; SP-3000 manual, "Condition Setup and Maintenance" PP3-B1271E2:
// density key, Gradation Selection Hard2..Soft3 (Hard3..5 ours), Tone Adjustment highlight / shadow hard / soft, Saturation -9..+9, Bright Mode
// colour intensity -2..+4). The manual gives the levels, not what a step does: the step sizes below are choices.
// Densità: + = brighter print (v4.13, user: the lab's own sign, + = denser / darker, read backwards), 1/4 EV per step
// (FrontierParams.density, EV, + = brighter). Nessuno's Luminosità goes the same way and moves the inversion's mid grey by the
// same step (invert.js; a choice: one step size in the tab).
export const LAB_D_EV = 0.25;
// Gradazione: about 14 % of mid-tone slope per level in the key (slope x (1 + 1.9 c) up, x (1 + 0.85 c) down, frontier.rs),
// measured +9..12 % of Normal's L* slope per level on a grey ramp (v4 Frontier, +-0.25 EV at mid grey: 18.2 .. 26.8 .. 32.3 L*/EV
// for Soft3 .. Normal .. Hard2). Hard3..5 are not on the SP-3000 (user asked for more, 4.32): the same step, slope 1.31 / 1.42 /
// 1.52 x Normal; white (L* 94.8) and black (1.8) do not move (highlights locked), shadows clip no more (EV below L* 5: 3.4 -> 3.6),
// the lights pay: slope +1..+2 EV 15.7 -> 9.4 L*/EV at Hard5. The key clamps at k 2.9 (c = 1) and the grey ramp stays monotone up
// to c ~ 0.85 (dips 0.3 L* from c 0.9; eval/out/gradazione_levels.png).
export const GRAD_C = [-0.383, -0.271, -0.145, 0, 0.074, 0.157, 0.25, 0.34, 0.43],
  GRAD_NAMES = ['Soft3', 'Soft2', 'Soft1', 'Normal', 'Hard1', 'Hard2', 'Hard3', 'Hard4', 'Hard5'];
// Tono luci / ombre (Tone Adjustment, one level each way): highlight key +-0.5 (Hard: opener, brighter lights, 4.31 gentler, see
// frontier.rs HIGHLIGHT_UP; Soft: held down); the frame's brightness is Densità's (the negative as a whole, the shoulder keeps
// the whites' detail);
// black lift +-0.15 of black_lift_max (Soft: lifted blacks; Hard: deeper, the darkest tones clip).
export const TONE_HI = 0.5, TONE_LO = 0.15, TONE_NAMES = ['Soft', 'Standard', 'Hard'];
// Saturazione: 5 % per step on the scanner's saturation. Bright (Fujifilm: "saturation of primary colors ... without affecting
// the saturation of neutral colors or skin tones", IS&T ICIS 2006): +8 % per step on the green, cyan, blue and magenta knots of
// hue_saturation (red / yellow, where skin sits, untouched; greys have no hue).
export const LAB_SAT = 0.05, LAB_BRIGHT = 0.08;
export const labKeys = (u) => ({
  density: u.labD * LAB_D_EV, contrast: u.contrast + GRAD_C[u.labGrad + 3], highlight: u.highlight + u.labHi * TONE_HI,
  black_lift: u.black - u.labLo * TONE_LO, saturation: 1 + u.labSat * LAB_SAT,
});
export const labModel = (u, model) => (u.labBright === 0 ? model
  : { ...model, hue_saturation: model.hue_saturation.map((g, i) => (i >= 2 ? g * (1 + u.labBright * LAB_BRIGHT) : g)) });
// Hyper Sharpness (Scanner, Frontier; slider 0 = off): the engine's unsharp mask on the scan, gated by relative detail
// (ScannerParams.unsharp_threshold) so the grain is left alone and only structure is sharpened (the real machine's version
// fried the grain). Radius HS_UM on the film: about one Frontier scanner pixel (36 mm / ~3000 px; a choice). Amount at the
// slider's top HS_MAX (a choice). Gate t0 / t1 measured at the preview pitch on the v4 Frontier rock (grain 3.1x): relative
// detail at HS_UM in flat sky (grain) p99 0.032, on rock structure p50 0.085; scaled with the pixel pitch as Nitidezza's
// (finer export pixels carry stronger per-pixel grain).
export const HS_UM = 12, HS_MAX = 1.0, HS_T0 = 0.03, HS_T1 = 0.08;

// v4: the film alone. Pre-film modifiers that are not the film (Texture, the lens) start at 0, the user can still add them;
// grain and halation are the film's own and start (and reset, Azzera) at its values: Grana at the measured Gold 200 strength
// (the v3 default 2.5× is ~80 % of the full-frame Gold scans, README v3.32), Halation at the stock's antihalation (1).
export const V4_FILM = { grain: 3.1, halation: 1 };

// v4 DIR couplers (film stage): inter-image inhibition, same layer and between layers, 0.6 / 0.6 -> 1.0 / 1.0. Measured against
// real Gold 200 (eval/gold200, eval/V4.md): the film's chroma on the same registered pixels, 0.84 / 0.88 -> 0.91 / 0.97 of the
// film's; 1.2 overshoots the film's strongest colours. The old values had no Gold data behind them (eval/calib/CALIB.md).
// First calibration step, to be refined as more references come in. v3 keeps the engine's defaults (its look was tuned on them).
export const V4_DIR = { inhibition_samelayer: 1.0, inhibition_interlayer: 1.0 };
// v4 Scanner 'Nessuno': the narrowband scan with the film-type setup (engine NarrowbandParams.setup: each channel on the stock's
// grey axis, per level of its grey ramp, base and mask removed), inverted with one black / white for the three channels (invert.js,
// shared). The per-channel inversion it replaces took each channel's range from the frame and stretched the one with the least:
// on a sunset (IDG_20261022_182651_466) the grey-blue sky between the clouds came out cyan and the red clouds orange-pale
// (blue share of the upper sky 69 % vs the DNG's 19 %); on the barn of the gold200 dataset the white wall came out cyan. With the
// setup, both follow the DNG (the film's own rendering stays: Gold reads a blue sky deeper than its RGB, by its spectral layers).
export const NARROWBAND = { setup: true };
// v4 film layer speeds (engine FilmRenderingParams.layer_speed_ev, set when the engine is built): red +0.75 EV, fitted on real Gold
// 200 (eval/gold200) for the mids' green cast with the per-channel inversion. The setups (NARROWBAND, the scanners' film-type
// setup) put each channel back on the stock's grey axis, so its colour effect is gone (with / without: < 0.5 mean L* a* b* per
// tone band, and re-measured on the gold200 scenes: no systematic cast left, eval/V4.md 4.16). It still sets where the red layer
// sits on its curve, so its grain: without it the sea frame's edges / texture go 0.86 / 0.76 -> 0.95 / 0.80 (check.py). Kept for
// that: the v4 grain strength (V4_FILM) was measured with it. To revisit with the grain.
// 4.28 shoulder (engine film_render.shoulder_log_e / _tau, profile.rs with_shoulder): above logE 1.0 (~+3.3 EV over mid grey) the
// profile's curves flattened to D ~1.6 by +2 logE, so an overexposed frame washed out (ours vs a real Gold 200 Frontier SP-3000
// tripod bracket, eval/out/work/refs/labscans/ikigai_gold200_bracket, at +5 EV: L* +12 / contrast -33 vs the real +2 / -14). The
// straight line continued with its gamma decaying by tau (logE): 0.6 (~the profile) / 1.0 / 1.6 / 2.5 / 4.0 give contrast at
// +5 EV -36 / -25 / -17 / -11 / -8 (real -14) and mean L* +15 / +11 / +7 / +3 / +0 (real +2): 2.5 (Dmax ~2.2). The datasheet's
// curves could not be read (E-7022 host blocked): a measured fit on one scene. Normal frames: only their brightest highlights reach it.
export const V4_STOCK = { film_render: { layer_speed_ev: [0.75, 0, 0], shoulder_log_e: 1.0, shoulder_tau: 2.5 } };
// v4 Frontier AutoSetup reads the colour from near-neutral pixels (engine FrontierAutoParams.neutral_sigma, density): a frame
// filled by one colour no longer pulls it towards grey (the Frontier's "subject failure"). Measured (sf-eval, v4 Frontier):
// green park ORF Y key -0.065 -> -0.018 (its grey path no longer pink), tungsten cat C +0.035 -> +0.024 (a real cast still read),
// neutral frames within 0.01. 0.03 / 0.1 bracket it (-0.014 / -0.023 on the park); 0.06 is the middle, a choice.
export const V4_NEUTRAL_SIGMA = 0.06;
// v4 Frontier AutoSetup, from the real Frontier's Gold 200 frames with charts (eval/frontier_cp; their Lightroom export has every
// setting at 0, so brightness and casts are the lab's). Density: over -1..+2 EV the real machine keeps the chart's mid grey within
// 2.4 L* (full compensation): strength 1.0 (v3 0.85 drifted ~+11 L*). Level, fitted on the three frames with grey patches
// rebuilt as scenes (recon.py, autorecon.py): the lab's mid grey is 67 / 80 / 53 (grey wall / black studio / outdoors); the
// trimmed mean alone (v3's target 0.0109) gave 58 / 86 / 59 (rms 7.2): a frame on black was lifted too much. highlight_weight 0.6
// reads 60 % of the key from the bright large areas (engine: the G 95th percentile on the knee), target_offset -0.12: 62 / 79 /
// 57 (rms 3.6; the grid's valley is flat over 0.5-0.7 / -0.10..-0.16). Checked on every Gold Frontier frame of the tool, 5 scenes
// x -1..+2 EV (recon_model.py EVS: each scene rebuilt through our tone curve and exposed as the camera did; Landscape and Night
// not in the fit): mean L* ours - real, rms 8.2 -> 2.8; harbour -12.4 -> +2.0, night +8.6 -> +0.5, grey wall -8.7 -> -3.1, outdoor
// portrait +2.1 -> +3.7 (brighter than the lab). Left: overexposed frames' highlights sit in the film's shoulder, so the harbour
// at +2 EV is +4.8; reading that term in EV along the grey ramp fixes it but over-corrects the others (rms 3.2-3.5): not taken.
// v3.47's draft target 0.16 matched the grey wall only (outdoor photos came out washed).
// Since 4.4 the highlight percentile is each pixel's densest channel (engine highlight_max_channel), not G: a bright saturated
// subject (a user's DNG of the inside of a pumpkin under a lamp, IDG_20261024_153100_228: R in the shoulder, G a mid tone) was not
// guarded, and auto exposure lifted the dark frame +1.3 EV: its light oranges came out yellow and washed (hue 87 deg vs the
// DNG's 56; now 78). target_offset -0.12 -> -0.07 refit (-0.12 / -0.04 / +0.04: 3.1 / 2.9 / 4.6): the 20 real frames 2.8 -> 2.6.
// Colour: k_col x strength 0.68 (v3 0.3 x 0.85). The tungsten frame keeps b* +12 / +25 / +14 over daylight (dark / mid /
// light greys) and takes the red out (a* -4); ours at v3's 0.26 kept +29 / +35 / +26 and a* +9 under a simulated 3200 K;
// 0.6 / 0.85 leave +24 / +24 / +12 and +19 / +18 / +6: 0.68 matches the mean. The light's temperature is not known (3200 K
// assumed): warmer light would mean an even stronger correction, so this is a lower bound.
// 4.14: with V4_TOE_SLOPE the setup densities moved and the 20 real frames came out +2.2 L* bright (rms 3.15 -> 3.46);
// target_offset -0.04 -> -0.10 (-0.07: rms 2.89, mean +1.2): rms 2.61, mean +0.2 (recon_model.py EVS -1..+2).
// 4.16: the refitted tone (V4_FRONTIER gradation_a 11.15) printed the frames darker (same harness, 4.15 -> refit: rms 3.24 ->
// 3.69, mean -1.3 -> -2.0; this run reads 3.24 where 4.14's read 2.61, the frame set / slider build differ): -0.10 -> -0.07,
// rms 3.25, mean -0.85 (-0.04: 3.20 but Daylight +6 L*).
// 4.28: dense frames: the real Frontier compensates the bracket in full up to +5 EV (mean L* within 3 of 0 EV); the inherited clamp
// (0.45 density, ~3 EV, no source) stopped ours at ~3 EV. clamp_density_dense 1.0 (~7 EV) leaves the darkening to the key; the
// lift of a thin frame keeps 0.45 (the real -3 EV frame is printed darker than ours already, a wider lift would add to that).
export const V4_AUTO = { strength: 1.0, k_col: 0.68, highlight_weight: 0.6, target_offset: -0.07, highlight_max_channel: true, clamp_density_dense: 1.0 };
// v4 Frontier tone and colour, fitted to a real Frontier (eval/frontier_cp, eval/V4.md): the Color Precision film comparison tool's
// Gold 200 chart frames (ColorChecker SG + Kodak grey scale, -1..+2 EV; the same negatives also on a Noritsu), our v4 Frontier
// rendering the same patches on CPU with the operator's density / C M Y keys as free nuisances. Tone: grey L* rms 2.6 -> 1.2;
// the real scans (both machines: a 9.6 / 9.3) have firmer mids and deeper lower mids / blacks than the guessed curve (a 6.2,
// v3.16 by eye), no shoulder (start 0.95 = the same fit, and AutoSetup's highlight cap at the knee, frontier.rs, then no longer
// darkens whole frames: at 0.69 the sky of the rock went grey, mean L* -11), white 0.97. Colour: the real Frontier is less
// saturated (chroma 0.80 of the chart's, Noritsu 0.90, ours was 1.12) and renders saturated colours darker than a grey of the
// same luminance, greens / cyans most (up to 21 L*): per-hue lightness, saturation and rotation (engine hue_lightness /
// hue_saturation / hue_shift, knots red yellow green cyan blue magenta; Fujifilm documents its 3D LUT acting by hue: "blue sky,
// ... highly saturated cyan/green, and luminosity of reds"), saturation 0.92, the cyan-blue boost nearly off; v3's hue
// rotations hold (blue 18 / green 20 deg fitted vs 17 / 24). Chart dE00 7.2 -> 4.4 at 0 EV (the fit), 7.5 / 7.2 / 7.6 -> 4.0 /
// 3.9 / 4.1 at -1 / +1 / +2 EV; chroma 1.06 and lightness +0.1 L* of the real. Left: the saturated green-cyan D9 is ~19 deg greener
// than real at every EV (pure cyans / blues within 5 deg); its neighbours in hue are right, both real machines put it ~28 deg from
// cyan C8 (we 49): an error of our spectral chain on that dye, not the scanner's LUT (proto_rot.py: 12 knots gain <= 0.1 dE00).
// 4.6, red -> orange: the green sensor band at 540 nm read red and orange alike (hue M4 -> I7 14-19 deg; the real Frontier 27-34,
// the real Noritsu on the same negatives 22: the scanner's bands set it). At 555 nm (565 / 575: 28 / 32 deg but the hue ops cannot
// hold the rest) with warm_hue_shift 6 (skin, the v3 op) and the per-hue ops refitted (proto_all.py at 0 EV): dE00 3.93 / 4.30 /
// 4.02 / 4.15 -> 3.79 / 4.17 / 3.89 / 3.85 (-1 / 0 / +1 / +2 EV), separation 18-28 deg, skin hue +8..+14 -> +2..+11 deg.
// The band moves the setup densities: AutoSetup's target_offset -0.07 -> -0.04 (V4_AUTO); the 20 real frames 2.6 -> 3.2 L* rms
// (overexposed frames now a little darker, Charts +1 / +2 EV -6), the price of the colour.
// 4.14, ambers: warm_hue_shift turned vivid amber / golden orange 7 deg too red and 9 % too dull (chart, the autumn-leaf patches
// L6 G7 I7 I8 E3; user: sunlit leaves came out brown): the engine now fades it out for vivid colours (frontier.rs WARM_VIVID),
// skin keeps it. dE00 -1 / 0 / +1 / +2 EV 3.79 / 4.17 / 3.89 / 3.85 -> 3.80 / 3.82 / 3.70 / 3.70; ambers 4.73 -> 2.91 (hue
// -7.4 -> -0.3 deg), skin hue +10.2 -> +8.9 deg (0 EV).
// v4 (both scanners): the toe beyond the neutralised range keeps more of Gold's own cool cast (blue slope 1.0 -> 0.75, red
// 0.9 -> 1.0). Real Frontier / Noritsu chart scans at -3 EV (Color Precision PDFs, eval/frontier_cp) have milky blue-grey blacks
// (b* -13); ours were warm (+5) and the frame 8.5 dE00 off. Chromatic dE00 Frontier -3 / -1 / 0 / +1 / +2 / +3 EV 8.55 / 3.80 /
// 3.82 / 3.70 / 3.70 / 4.52 -> 7.21 / 3.63 / 3.96 / 3.56 / 3.43 / 4.18; Noritsu -3 / 0 / +2 8.48 / 4.31 / 4.49 -> 7.31 / 4.42 / 4.58.
// Blue 0.5-0.6 matched the -3 EV blacks exactly but cost 0.3-0.4 at 0 EV: 0.75 is the compromise (a choice on those numbers).
// 4.16, whites (-1..-2.6 L* at every EV): the 555 nm green band of 4.6 reads G with ~11 % less density per stop (G gamma 0.53 ->
// 0.47) and the tone was never refitted: grey L* rms 2.29 (540 nm: 1.17). fit_tone.py at 555 nm: gradation_a 9.6 -> 11.15
// (black / white unchanged), rms 1.15; the per-hue ops refitted on it (proto_all.py jointly on -1 / 0 / +1 / +2 EV). Grey L* rms
// -1 / 0 / +1 / +2 2.52 / 1.81 / 2.43 / 2.37 -> 1.89 / 1.57 / 1.85 / 2.00, whites -1.9 / -1.3 / -2.4 / -2.6 -> -0.8 / -0.1 /
// -1.4 / -1.3; chromatic dE00 -3..+4 7.21 / 3.63 / 3.96 / 3.56 / 3.43 / 4.18 / 5.22 -> 6.96 / 3.52 / 4.10 / 3.46 / 3.52 / 4.09 /
// 4.98 (mean over -1..+2 unchanged); blacks ~1.2 L* deeper. Skin: the real lab's skin hue follows each frame's light-grey cast
// (ours - real a*/b* -2.0/+1.7 at -1 EV ... +1.2/-0.4 at +3), with it removed ours is +0.1 deg on average: no rotation added.
// -3 EV left (6.96): the real lab prints a thin frame with ~1.5x the 0 EV tone contrast but no more chroma, which a fixed
// per-channel curve cannot do (a film-toe question, eval/frontier_cp/README.md).
export const V4_TOE_SLOPE = [1.0, 0.75];
export const V4_FRONTIER = { gradation_a: 11.15, black_point: 0.023, white_point: 0.97, shoulder_start: 0.95, shoulder_sharpness: 0,
  saturation: 0.92, saturation_blue: 0.05, blue_hue_shift: 18, green_hue_shift: 20, sensor_peak_nm: [650, 555, 450], warm_hue_shift: 6,
  hue_lightness: [0.91, 0.93, 0.57, 0.80, 0.95, 0.93], hue_saturation: [0.86, 1.08, 0.94, 1.07, 0.77, 0.76], hue_shift: [2.4, 1.3, 6.0, 4.1, -2.9, 15.3] };
// v4 Noritsu (Scanner tab): the Frontier's scanner model with a Noritsu's tone, colour and AutoSetup, fitted as V4_FRONTIER on the
// same Color Precision Gold 200 frames scanned on their Noritsu (eval/frontier_cp). It overrides every v3 Gold-look op (none of
// them is the Noritsu's). Tone: a 9.26, black 0.025, white 1.0 (opener whites than the Frontier's 0.97), grey L* rms 1.25.
// Colour: per-hue lightness / saturation / rotation (6 knots, proto_all.py then the engine): dE00 6.4-6.7 -> 4.3-4.5 over
// -1..+2 EV, chroma 1.06 of the real. The magenta rotation (31 deg) is the machine's: on the same negatives the real Noritsu
// renders magentas / purples / violets 8-24 deg redder than the real Frontier (9 patches, every EV); here it takes dE00 4.75-4.93
// -> 4.31-4.49 at the 4 EVs, helps 7 patches (B4 9.6 -> 2.4, H3 11.0 -> 4.7), worsens none by more than 0.2. Balance: the Noritsu's greys are warm in the shadows / mids, neutral in the lights (mid b*
// +13 on the chart frame, +7 outdoors, against the Frontier's +4.5 / +2): C M Y +0.02 / +0.05 / +0.075 over the Frontier's
// balance, the mean of the chart-frame fit (0.03 / 0.068 / 0.103) and the outdoor frame's about half of it.
// 4.16, skin: with each frame's light-grey cast removed, the Noritsu's skin is still +4..+5 deg yellow at every EV, the chain's
// error the Frontier corrects with warm_hue_shift 6 (WARM_VIVID keeps the ambers): the same here. Skin hue at 0 EV +7.6 -> +2.7
// deg, chromatic dE00 -3 / -1 / 0 / +1 / +2 7.31 / 4.48 / 4.42 / 4.49 / 4.58 -> 7.26 / 4.30 / 4.25 / 4.24 / 4.43, +3 / +4 4.71 /
// 4.93 -> 4.90 / 5.07 (the price; 4: 4.27 at 0 EV, 4.79 at +3, softer). A choice for the common exposures.
export const V4_NORITSU = { gradation_a: 9.26, black_point: 0.025, white_point: 1.0, shoulder_start: 0.95, shoulder_sharpness: 0,
  saturation: 1.0, saturation_blue: 0, blue_hue_shift: 0, green_hue_shift: 0, saturation_warm: 0, warm_hue_shift: 6,
  cool_neutral_warm: 0, highlight_neutral: 0, balance_cmy: [0.02, 0.055, 0.095],
  hue_shift: [2, -4.8, 3.1, 1.8, 1.6, 30.8], hue_lightness: [1.16, 0.99, 0.69, 0.86, 0.91, 0.94], hue_saturation: [0.84, 0.94, 0.96, 0.91, 0.62, 0.87] };
// Noritsu AutoSetup. Unlike the Frontier it barely lifts a dark frame (chart on black: mid grey 67 vs 70 on the grey wall, the
// Frontier 80 / 67) while compensating exposure fully: a highlight-anchored setup. The engine's highlight guard (95th percentile
// kept below the knee + margin) does that: margin -0.08 with the mean's target 0.15 gives, on scenes rebuilt from the real
// Noritsu scans (recon.py / autorecon.py), wall / black / outdoors 68.7 / 58.7 / 57.9 (real 69.7 / 66.9 / 54.0; the v3 setup
// 58.8 / 83.8 / 59.5). Colour: the tungsten frame keeps b* -3 / +7 / +5 (dark / mid / light) over daylight, much less than
// the Frontier: k_col 1.15 (1.0 / 1.3 leave +11 / +9 / +7 and +3 / -5 / -5), clamp_colour 0.3 (0.15 bound it). Exposure-faithful
// check on its 20 Gold frames (recon_model.py EVS): rms 4.7 L*; the Frontier's mean / highlight blend does no better (4.9+ on the
// fit scenes, eval/frontier_cp/README.md). Its highlights on the densest channel (as V4_AUTO since 4.4) with margin -0.04: rms
// 4.7 -> 4.3 L* (-0.08 / 0.0: 4.6 / 5.5), but its cap then prints a sunset with a saturated sky near black (median L* 62 -> 25,
// v4_sky_noritsu): not taken. 4.16: target 0.15 -> 0.10. Per set the level is bound either by the highlight guard (Charts,
// Studio, Daylight, Night: their keys at 0 EV sit on the -0.08 cap, the target does not reach them) or by the mean (Landscape,
// alone: +4.8 L*); a lower target fixes the one set the mean binds: Landscape -0.4, Charts -3.4 -> -4.8, the rest unchanged,
// rms 4.6 -> 4.2 L* (each frame rendered over a range of keys, verified in the engine). Percentile 90 / margin -0.16 reaches
// 3.45 but moves Charts / Studio by 2-2.5 L* on 5 scenes: not taken. What is left is per scene (Daylight +6 that no frame
// statistic explains, Charts -5): structural.
// 4.28: the Frontier's dense limit (V4_AUTO clamp_density_dense) assumed for the Noritsu too: no Noritsu bracket beyond +2 EV.
export const V4_NORITSU_AUTO = { strength: 1.0, target_offset: 0.10, highlight_margin: -0.08, k_col: 1.15, clamp_colour: 0.3, clamp_density_dense: 1.0 };
export const SCATTER_SCALE = 0.5;   // film scatter size multiplier (engine default 1), see renderParams
// v3.32: dye-cloud blur 0.65 -> 0.45 (reference px, ~12 -> ~8 um): measured on 10 full-frame Gold 200 scans the grain has ~12 % of
// its power below 40 um wavelength and r50 ~13.5 um; ours had 3 % / 18.6 um (soft). At 0.45
// (with the engine's variance-matched kernel, filming.rs): 12 % / 14.8 um, and the preview matches the export seen at its size.
export const GRAIN_BLUR = 0.45;
// 4.29 v4 grain as a lab scan shows it (user: "sabbiosa invece che granulosa", "emulazione 99%"). Fitted (coordinate search,
// scratch opt2.py) on two references measured the same way, by tone (flat 48 px patches: luma high-pass std, autocorrelation
// half-width r50, chroma / luma, share of power above 25 c/mm), our renders in the patches' own colours:
// - 6 Frontier lab scans of samples/kg200 (10-11.5 um/px, IJG q70 4:2:0: ours through the same JPEG before measuring);
// - 2 high-quality 35 mm Noritsu HS-1800 scans (refs/labscans/optikoldschool_gold200_35_vs_120, 5.3 um/px, ~q98) box-resampled
//   to our 12 MP pitch.
// Ours was a soft mottle, r50 ~15 um at every tone. Now (Frontier set / Noritsu set): r50 within ~1 um of both (Noritsu, at our
// pitch: 6.4-7.0 vs 5.3-6.2 um, fine share 65-71 vs 68-77 %), strength by tone inside the real scans' spread (the Frontier scans
// alone range x3-5 between frames). The model, engine hash grain (GrainParams):
// - the lab scanner sharpens the grain: scan_sharpen, unsharp mask of radius HS_UM (one Frontier scanner pixel), grain only;
// - two crystal populations: the few big fast ones (the shadows' grain, coarse) get their own dye cloud blur_fast and share
//   fast_count_frac (the inherited 0.002, no source, made them dominate every tone);
// - the scanner's own noise: scan_noise, sigma in density at density 1 growing as 10^(slope (d - 1)) (dense negative = the
//   positive's lights: little light reaches the sensor), colour share scan_noise_chroma (the scanner software's colour NR).
// Left: the two references disagree (Frontier lights / Noritsu mid-lights), one set cannot fit both; shadows a bit weak.
// Colour mottle (user request 2026-11-08: our grain's colour was a per-pixel pepper, the real scans' sits at clump scale):
// layer_blur_fast, the fast crystals' dye cloud per layer (R, G, B), the yellow (blue-sensitive) layer's 3.5x coarser at the same
// std, with scan_noise_chroma 0.5 -> 0.35 (most of the per-pixel colour is the scanner noise's). Measured on the Noritsu set at
// the 12 MP pitch (scratch ours_full.py / blot2.py), tones 15-50 / 130-170 / 170-210 / 210-235, before -> after (real):
//   chroma / luma, mid band 27-108 um   0.079 / 0.037 / 0.036 / 0.039 -> 0.077 / 0.082 / 0.056 / 0.036   (0.246 / 0.154 / 0.154 / 0.087)
//   chroma / luma, fine < 2 px          0.44 / 0.26 / 0.28 / 0.31     -> 0.45 / 0.23 / 0.22 / 0.23       (0.35 / 0.22 / 0.19 / 0.12)
//   luma std 4.6 / 15.0 / 14.3 / 8.0 -> 4.6 / 15.0 / 14.5 / 8.2; r50 8.2 / 6.8 / 6.4 / 6.2 -> 8.3 / 6.8 / 6.4 / 6.2 um.
// Shadows and lights barely move: there G is what the mid band answers to (G 1.5: shadows 0.107, but r50 +18 %), and B 4+
// saturates (and leaves the CPU's sampled-kernel range at this pitch). The same multiplier on the slow crystals too: fine colour
// +23 %, r50 +20 % (B 2): not taken.
export const V4_GRAIN = {
  blur: 0.2, blur_fast: 0.35, fast_count_frac: 0.02, layer_blur_fast: [1, 1, 3.5], scan_sharpen_um: HS_UM, scan_sharpen: 0.85,
  scan_noise: 0.0098, scan_noise_slope: 0.6, scan_noise_chroma: 0.35,   // scan_noise per 10 um pixel (0.011 at the fit's 8.95 um)
};

export const V4_GRAIN_SCALE = 1.95;   // Grana's slider unit for this grain: the fitted amount (3.95) at the default Grana (V4_FILM)
export const GRAIN_UNIT = 0.65;   // slider 1× -> engine amount (= old slider 0.25 / old default 0.4)
