import { sf, bootEngine, FILM, PAPER, BASE_PARAMS, deepMerge, inputParams, decodeRGBA, turnRGBA, forEachStrip, extractLinear, jpegThumb, THUMB_PX, PACK_LUT } from './lib/common.js';
import { sleep, store, stripRows, PREVIEW_LONG_SIDE, PREVIEW_KPX, FRAME_UM, DESK } from './lib/util.js';
import { drawHistogram as paintHistogram } from './lib/histogram.js';
import { initViewport } from './lib/viewport.js';
import { initPanel, PANEL_DEFAULT_VH } from './lib/panel.js';
import { initCropUI } from './lib/cropui.js';
import { JPEG_QUALITY_DEFAULT, jpegDistance, PROGRESSIVE_PIXEL_LIMIT, startEncoder, openEncoder, download } from './lib/encoder.js';
import { DISPLAY_GAIN_LUT } from './lib/color.js';
import { log, logText, prevLogText, setBusy, takeCrashMarker } from './lib/debuglog.js';
import { withMetadata } from './lib/exif.js';
import { isRaw, loadRaw, uploadRaw, previewThumb, withRotation } from './lib/raw.js';
import { internoParams } from './lib/interno.js';
import { invertAnchors, invertUniform, invertCPU } from './lib/invert.js';
import { iccSegment } from './lib/icc.js';
import { extractLens, lensGeometry, lensActive } from './lib/lens.js';
import { INPUT_WGSL, INPUT_WGSL_V3, INPUT_WGSL_HT, inputUniform } from './lib/lens-gpu.js';
import { dodgeBase, dodgeParams, dodgeArray, dodgeCPU } from './lib/dodge.js';
import { LUMA, XYZ_TO_RGB } from './lib/color.js';
import { igCanvas, fitInside } from './lib/igout.js';
import { dustField, borderFields, drawDustFramed, dustIntoStrip, releaseDustStrip } from './lib/dust.js';
import { FRAME_STYLES, FRAME_NAMES, frameMargins, drawFrame, frameIntoStrip } from './lib/filmframe.js';
import { OUTPUT_WGSL, packParams, toSpaceCPU } from './lib/output.js';
import { frameMap, frameImage, cropPx, turnCrop, isFull, FULL } from './lib/tilt.js';
import { tiltRuler } from './lib/ruler.js';
import { hyperToneMap, hyperArray, hyperGainCPU } from './lib/hypertone.js';
import { attachTips } from './lib/tips.js';
import { initUI2 } from './lib/ui2.js';
import { GRAD_NAMES, GRAIN_BLUR, GRAIN_UNIT, HS_MAX, HS_T0, HS_T1, HS_UM, HYPER_NAMES, HYPER_THUMB_PX, LAB_D_EV, NARROWBAND, SCATTER_SCALE, TONE_NAMES, V4_AUTO, V4_DIR, V4_FILM, V4_FRONTIER, V4_GRAIN, V4_GRAIN_SCALE, V4_NEUTRAL_SIGMA, V4_NORITSU, V4_NORITSU_AUTO, V4_STOCK, V4_TOE_SLOPE, frontierCmy, hyperLevel, labKeys, labModel } from './lib/look.js';

// Engine default; sets the physical pixel size of the engine's own effects (grain, halation, DIR diffusion) as the frame's
// long side in mm. Not util.js FRAME_UM (36 mm, the 24×36 frame, for the JS effects): the engine's look was tuned at 35,
// so the two scales differ by 2.8 %; aligning either one moves the look (not done: needs a look check).
const FILM_FORMAT_MM = 35;
const EXPORT_TILE = 1024;         // export tile core size (px)
const EXPORT_PAD = 128;           // tile overlap: covers halation / DIR diffusion reach at 12 MP
const MAX_EXPORT_PIXELS = 12.5e6; // keeps native 12 MP iPhone frames; 48 MP gets downscaled (20 MP crashed the grain exporter)
const IG_W = 1080, IG_H = 1440;    // Instagram canvas: 3:4, the profile grid's ratio since 2025 (the whole photo fits inside, mat around)
const IG_SUPER = 2;                // IG: the film is rendered at this × the posted size, then downscaled + output-sharpened (lib/igout.js)
// Film camera (Contax T3-like compact, handheld, no flash) loaded with Gold 200. Interno (lib/interno.js) takes a fixed
// INTERNO_EV off the scene exposure before the film: a pure function of the checkbox. The lab scanner's AutoSetup
// (frontier.auto) decides what it does about the thin negative.
const NO_AUTO = [0, 0, 0, 0];   // scanner AutoSetup result [d, c, m, y]: neutral
const BORDER_FRACTION = 0.01;     // mat (white, MAT_WHITE), fraction of the long side; normal export: thicker across the short side so the aspect is kept
/** Base mat width near `b` (±3 px, closest first) whose scaled side b·k is closest to a whole number (k = long / short side). */
const matBase = (b, k) => [0, -1, 1, -2, 2, -3, 3].map((d) => Math.max(1, b + d))
  .reduce((best, c) => (Math.abs(c * k - Math.round(c * k)) < Math.abs(best * k - Math.round(best * k)) - 1e-9 ? c : best));
/** The mat around a W×H canvas (the image with its film frame) at `bFrac` of the long side: { x, y } px on each side, the long
 * edges' width bFrac, scaled by long / short across the short ones (the canvas keeps its aspect). The preview and the export. */
function matMargins(W, H, bFrac) {
  const border = bFrac ? matBase(Math.round(Math.max(W, H) * bFrac), Math.max(W, H) / Math.min(W, H)) : 0;
  return { x: W <= H ? border : Math.round(border * W / H), y: W <= H ? Math.round(border * H / W) : border };
}

const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view');
const ctx = view.getContext('2d', { colorSpace: 'display-p3' });

let gpu = false;
let engine = null;          // sf.Engine for the current photo (its input colour space is fixed at construction)
let engineParams = '';      // JSON last given to `engine.update` (re-sending it is a no-op)
// v4 (the default since 4.0, user's decision; eval/V4.md): what the DNG impresses on Gold 200, shown with a neutral inversion of the
// negative (lib/invert.js) or through a Frontier / Noritsu (Scanner tab), no Luce tab: exposure is the phone's (metered as v3 Auto).
// index.html?v3: the previous app (Luce has Esposizione, Contrasto, Contrasto luci, automatic highlight dodging, lib/dodge.js,
// eval/V3.md, and the free contrast curve); ?v2 the one before. ?v4 still opens v4 (old links).
const QUERY = new URLSearchParams(location.search);
const V3 = !QUERY.has('v2');
const V4 = V3 && !QUERY.has('v3');
// UI 2 (lib/ui2.js): the default since 4.25 (user). ?ui1 or its menu (Interfaccia classica) switches to the classic UI and
// remembers it (a home-screen app keeps its own storage: also File > Prova la nuova interfaccia, back), ?ui2 back. v4 only.
if (QUERY.has('ui2')) store.set('fcf_ui2', null);
if (QUERY.has('ui1')) store.set('fcf_ui2', '0');
const UI2 = V4 && store.get('fcf_ui2') !== '0';
let ui2 = null;   // its handle once started (end of this file)
// v3 highlight dodging (Luci auto, lib/dodge.js) changes the scene light before the film: off in v4 (the film alone).
const DODGE = V3 && !V4;
let photo = null;           // { file, size: { w, h } of the full decode, preview, after, auto: scanner AutoSetup [d, c, m, y], rot: quarter turns clockwise, ... }
// The full-resolution decode of a JPEG / HEIC is not kept (24-48 MP = 96-195 MB for the photo's whole life): the export decodes
// the file again and closes it.
const decodeFull = (file) => createImageBitmap(file);   // export only (rotate turns the preview's pixels)
let rendering = false, dirty = false, exporting = false, renderCount = 0, renderErrors = 0;

// ---------- params ----------

const ui = () => ({
  ev: +$('ev').value, contrast: +$('contrast').value, highlight: +$('highlight').value, whites: +$('whites').value,
  mshift: +$('mshift').value, yshift: +$('yshift').value, vibrance: +$('vibrance').value, temp: +$('temp').value, black: +$('black').value,
  grain: +$('grain').value, halation: +$('halation').value, texture: +$('texture').value, clarity: +$('clarity').value, sharp: +$('sharp').value,
  ca: +$('ca').value, vignette: +$('vignette').value, falloff: +$('falloff').value, tilt: +$('tilt').value, htHi: +$('htHi').value, htLo: +$('htLo').value, hypersharp: +$('hypersharp').value,
  labD: +$('labD').value, labGrad: +$('labGrad').value, labHi: +$('labHi').value, labLo: +$('labLo').value, labSat: +$('labSat').value, labBright: +$('labBright').value,
  nbBright: +$('nbBright').value,
  ...(V3 ? { hlc: +$('hlc').value, shadows: +$('shadows').value, v3dodge: $('v3dodge').checked } : {}),   // v3: snapshotted with the rest (export tiles)
});
// CA slider is quadratic: realistic (subtle) amounts get most of the travel.
const lensOf = (u) => ({ ca: u.ca * u.ca, vignette: u.vignette, falloff: u.falloff });


/** Interno (lib/interno.js, one source of truth): a pure function of the checkbox (or of `on`); null when off. */
const interno = (on = $('indoor')?.checked) => (photo && on ? internoParams() : null);
const underEv = (on) => interno(on)?.under ?? 0;
// Temperatura luce: colour of the light on the scene, before the film (Gold 200 is daylight film). Slider v (K): the light is
// LIGHT_REF - v kelvin (right = warmer light); gains = Planckian white at that temperature / at LIGHT_REF, in the engine input
// space, normalised to luma 1 (no exposure change). v = 0 -> exactly [1, 1, 1] (identical to before).
const LIGHT_REF = 5500;
function planckRgb(T, space) {   // Kim et al. 2002 cubic fit of the Planckian locus (1667-25000 K), Y = 1
  const t = 1e3 / T, x = T < 4000 ? -0.2661239 * t ** 3 - 0.2343589 * t ** 2 + 0.8776956 * t + 0.179910
    : -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.240390;
  const y = T < 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : T < 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  const XYZ = [x / y, 1, (1 - x - y) / y];
  return XYZ_TO_RGB[space].map((r) => r[0] * XYZ[0] + r[1] * XYZ[1] + r[2] * XYZ[2]);
}
function lightGains(v, space) {
  if (!v) return [1, 1, 1];
  const a = planckRgb(LIGHT_REF - v, space), b = planckRgb(LIGHT_REF, space), g = a.map((c, i) => c / b[i]);
  const L = LUMA[space], n = L[0] * g[0] + L[1] * g[1] + L[2] * g[2];
  return g.map((c) => c / n);
}
const sceneWb = (on, space, temp) => {
  const g = interno(on)?.gains ?? [1, 1, 1], t = lightGains(temp, space);
  return [g[0] * t[0], g[1] * t[1], g[2] * t[2]];
};
const grainFactor = () => interno()?.grain ?? 1;
const baselineEv = () => photo?.preview.raw?.baseline ?? 0;
/** Scene exposure gain of the input pass: Esposizione, minus Interno's underexposure, plus the DNG baseline (physical, before the film). */
const sceneGain = (u) => 2 ** (u.ev - underEv() + baselineEv());

// Everything else is read at render time and goes through `engine.update`.
// The film model and the Frontier scanner are the engine's (the positive comes out of it);
// our input pass only conditions the light (display→scene, exposure, lens, Texture, Chiarezza, Nitidezza, Vividezza).
let forceSRGB = false;   // IG export: sRGB output (P3 dulls saturated reds on Instagram)
// Ritaglia (Trasforma; lib/tilt.js): the crop of the turned frame (fractions); while the Trasforma tab is open the whole frame
// renders and the crop is drawn over it (cropEditing), elsewhere the crop is the output frame.
const cropUI = initCropUI({ stage, view, active: () => !!photo, aspect: () => photo.preview.w / photo.preview.h,
  onEdit: () => render(), onMove: () => histoSoon() });
const viewCrop = () => (cropUI.editing() ? FULL : cropUI.crop());
/** The output frame of a W×H source as rendered now: { ox, oy, w, h } (tilt.js cropPx). */
const outFrame = (W, H) => cropPx(W, H, viewCrop());
// Output space ('p3' | 'srgb'): v3, Display P3 for P3 photos (sRGB for IG and sRGB photos); v4, always sRGB (the photos end
// on the web / Instagram). `engineWide`: the engine renders Rec.2020 and the output pass maps it softly into the output
// space (output.js GAMUT); otherwise the engine renders the output space itself (v3 sRGB: hard clip, kept as it was).
const outSpace = () => (!V4 && !forceSRGB && photo?.preview.p3 ? 'p3' : 'srgb');
const engineWide = () => V4 || outSpace() === 'p3';
const packTo = () => (engineWide() ? outSpace() : null);

// `region` {x0, y0, fw, fh, W, H}: the rendered region's origin in the frame, the size the engine's grain pitch is
// relative to (fw, fh: the tile's own size in an export, see exportFull), and the whole frame's size (W, H), in px. The grain
// is a hash of the frame position, so every tile of an export gets the same grain as the whole frame.
/** The render's top-left and the WHOLE frame's size (Hyper Tone's map spans the frame; Hyper Sharpness' pitch is the frame's). */
const wholeFrame = (region) => {
  const o = outFrame(photo.preview.w, photo.preview.h);
  return { origin_px: region ? [region.x0, region.y0] : [0, 0], frame_px: region ? [region.W, region.H] : [o.w, o.h] };
};
function renderParams(u, { noGrain = false, region = null } = {}) {
  return {
    camera: { auto_exposure: false, film_format_mm: FILM_FORMAT_MM },
    // P3 photos end up in Display P3 (same transfer curve as sRGB, so tones are
    // identical): the engine's sRGB-only gamut compression was squeezing
    // saturated reds / oranges / yellows by ~20% (measured). The engine renders
    // them into Rec.2020 (film colours fit there) and the output pass converts
    // to P3 with a soft gamut compression (output.js toP3); plain P3 output
    // hard-clipped dark warm browns (B = 0, hue swung red).
    // v2-calib: the engine now returns a positive, so its own gamut compression could be back on for sRGB.
    io: { output_color_space: engineWide() ? 'ITU-R BT.2020' : 'sRGB', output_gamut_compress: NO_GAMUT, scan_film: true },
    // The engine's scanner unsharp mask works in pixels (0.7 px: crisper at
    // preview size than on a 12 MP export) and inflated pixel-level detail
    // ×1.3–1.6 (measured): a phone's crunch, not film. Texture comes from the
    // film-adjacency clarity in the input pass instead (lens-gpu.js), in µm.
    // v4 Scanner 'Nessuno': no scanner look, the engine returns the negative read in three narrow bands (engine narrowband.rs:
    // the bands of the real Gold 200 reference scans, eval/V4.md), inverted in the output pass (lib/invert.js).
    scanner: neutralScan() ? { model: 'narrowband', narrowband: NARROWBAND, unsharp_mask: [0, 0] } : {
      model: 'frontier', black_correction: false, white_correction: false,
      // always sent: the engine merges updates; the Noritsu has none (they are the Frontier's)
      ...(scanner === 'noritsu' ? { unsharp_mask: [0, 0] }
        : hyperSharp(u, region)),
      frontier: {
        // v3.20: Alte luci / Bianchi below 0 darken the scene before the film (dodge.js, local, the negative keeps the detail); above 0 they
        // stay on the scanner curve (gentler than pushing the scene into the shoulder). v2 page: scanner only.
        cmy: frontierCmy(u), contrast: u.contrast, highlight: V3 ? Math.max(u.highlight, 0) : u.highlight, whites: V3 ? Math.max(u.whites, 0) : u.whites, black_lift: u.black,
        ...(V4 ? labKeys(u) : {}),
        auto: photo.auto, ...(V3 ? { debug_contrast_mode: 3 } : {}),
        // v3.16 Gold 200 look (tuned on 3 samples with a Gold 200 reviewer; chart 96.9): saturation_blue lifts cyan / sky hues (215-243 deg in the LUT) only where light (linear luma 0.22-0.36), so the
        // dark chart blues and the skin / greens stay put; Y 0.02 (no C) warms midtones and lights; narrower B / farther R sensors;
        // black 0.015 + a 6.2 against the milky blacks; setup_neutral_ev 1.5 + toe [R 0.9, B 1.0] take the cast out of the deep shadows.
        // v3.20: saturation_warm 0.3 (pale-to-mid yellow-orange / amber of low-sun skies and clouds, hue >~60 so skin and tungsten interiors are not touched); green rotation now full only for near-grey greens;
        // v3.17: green_hue_shift 24 (greens towards yellow-olive, luminance kept; full for dull low-chroma greens, vivid / light foliage keeps 15 %, v3.19),
        // saturation_blue 0.85 (paler upper sky), Y 0.0245 (a step of warmth in mids / shadows), saturation_blue band 8 deg towards violet (less cyan sky), cool_neutral_warm 0.8 (grey-blue cast of dark / mid low-chroma tones, e.g. rock; no yellowing of the lights), v3.18: saturation_blue ramps from linear luma 0.06 (deep blue skies, L* ~45, got no gain), highlight_neutral 0.6 from linear luma 0.38 (cream / yellow-green taken out of pale whites and light tones), Y back to 0.02 (rocks are warmed by cool_neutral_warm 1.0 instead), AutoSetup k_col 0.3 (a lab corrects part of a tungsten cast; daylight frames barely move).
        // Interno (v3.29): the toe keeps Gold's own cast (R 1.9 / B 0.85, neutralised range 2 EV: teal-green deep shadows and dark mids,
        // warm mids kept), cool_neutral_warm off (it warmed those shadows), balance M -0.02 / Y +0.04 so the lights stay cream / yellow, and
        // the magenta key goes greener with Contrasto (-0.03 per unit): Contrasto amplifies the scene's red-magenta in the light mids (white
        // fur turned pink). warm_hue_shift / saturation_warm off for every photo (v3.19's sunset tuning turned yellow-orange fur pink).
        model: { saturation: 1.01, saturation_blue: 0.15, blue_hue_shift: 17, green_hue_shift: 24, saturation_warm: 0, warm_hue_shift: 0, cool_neutral_warm: interno() ? 0 : 1.0, highlight_neutral: 0.6, balance_cmy: interno() ? [0, -0.03 - 0.03 * Math.max(u.contrast, 0), 0.0] : [0, 0.005, 0.02], sensor_peak_nm: [650, 540, 450], sensor_fwhm_nm: [40, 50, 40],
                 black_point: 0.012, gradation_a: 6.2, setup_toe_slope: interno() ? [1.4, 0.92] : V4 ? V4_TOE_SLOPE : [0.9, 1.0], setup_neutral_ev: interno() ? 2.0 : 1.5, auto: { k_col: 0.3, ...(V4 ? { neutral_sigma: V4_NEUTRAL_SIGMA, ...(scanner === 'noritsu' ? V4_NORITSU_AUTO : V4_AUTO) } : {}) },
                 ...(V4 ? labModel(u, scanner === 'noritsu' ? V4_NORITSU : V4_FRONTIER) : {}) },
      },
    },
    film_render: {
      // Grain is the engine's (rng 'hash': a pure function of seed + frame position, see eval/GRAIN.md).
      // Grana 1× = the old 0.25× (user-preferred); amount 1 = the calibrated Gold 200 grain (GRAIN_UNIT scales between them).
      grain: {
        active: !noGrain && u.grain > 0, rng: 'hash', ...(V4 ? v4Grain() : { blur: GRAIN_BLUR }),
        amount: u.grain * GRAIN_UNIT * grainFactor() * (V4 ? V4_GRAIN_SCALE : 1), seed: photo.grainSeed,
        ...(region ? { origin_px: [region.x0, region.y0], frame_px: [region.fw, region.fh] } : wholeFrame(null)),
      },
      // v2-calib: strength comes from the profile's antihalation; halation_amount is a multiplier on it (Halation slider).
      // v3.12: film scatter (core 2.2 / tail 9.3 µm) at half size: at full size it took ~35 % of the fine detail
      // everywhere, visible in the highlights where the shoulder leaves no contrast to hide it (sunlit walls).
      halation: { active: u.halation > 0, halation_amount: u.halation, scatter_spatial_scale: SCATTER_SCALE },
      ...(V4 ? { dir_couplers: V4_DIR } : {}),
    },
  };
}

function renderParamsJson(u, noGrain = false, tileMm = 0, region = null) {
  const p = renderParams(u, { noGrain, region });
  return JSON.stringify(tileMm ? deepMerge(p, { camera: { film_format_mm: tileMm } }) : p);
}

// One engine per photo (the input colour space is fixed at construction); the film and the scanner are all updates.
/** The engine set up for `u` (built once per photo: the input colour space is fixed at construction), updated with the
 * render params; the parse / merge / rebuild is skipped when they did not change (most sliders are ours: exposure, lens,
 * grain, texture). Calibration inputs (camera EV, enlarger filters, ... see spektrafilm-wasm Engine.update) are ignored by
 * update: none of ours change after the build. */
// The engine's output gamut compression stays off (renderParams). Also at construction: the engine would otherwise build its
// default compressor's table first (~0.55 s of desktop wasm, once per session), which the first update then drops.
const NO_GAMUT = { algorithm: 'off' };
function syncEngine(u, { noGrain = false, tileMm = 0, region = null } = {}) {
  if (!engine) {
    engine = new sf.Engine(FILM, PAPER, JSON.stringify(deepMerge(BASE_PARAMS, inputParams(photo.preview.p3), V4 ? V4_STOCK : {},
      { io: { output_gamut_compress: NO_GAMUT } })));
    engineParams = '';
  }
  const json = renderParamsJson(u, noGrain, tileMm, region);
  if (json !== engineParams) { engine.update(json); engineParams = json; }
  return engine;
}

// The frame goes to the GPU a strip at a time: the wasm heap (which never
// shrinks) only ever holds one strip, not the whole frame.
function uploadFrame(data, w, h) {
  sf.alloc_frame(w, h);
  for (let y = 0, n = stripRows(w); y < h; y += n) {
    const rows = Math.min(h, y + n) - y;
    sf.set_frame_rows(data.subarray(y * w * 4, (y + rows) * w * 4), y);
  }
}

// ---------- lens & input ----------
// Applied to the light reaching the film (engine input), in frame coordinates.
// GPU: the whole input stage (lens, display→scene, exposure, matrix) runs inside the engine's
// chain from the frame texture (sf.set_frame), see lens-gpu.js. CPU fallback
// below (no WebGPU): float input built here, float output converted here.

/** The sensor noise floor of `frame` (the preview's or an export's decode of this photo) at its pixel pitch, [luminance, R, G,
 * B] (noiseAt). Zeros: a JPEG. */
function frameNoise(frame) {
  return frame.raw ? noiseAt(Math.max(frame.w, frame.h)) : [0, 0, 0, 0];
}
/** This photo's noise floor (dng.js noiseFloor, of the preview decode) for an image of it `longSide` px long: x the pitch ratio
 * (white noise: sigma per pixel ~ 1 / the pixel's side). Zeros: a JPEG, an ORF, a DNG without a NoiseProfile (the noise-aware
 * parts then do what they did before). */
function noiseAt(longSide) {
  const pv = photo.preview, nz = pv.raw?.noise;
  return nz ? nz.map((v) => v * longSide / Math.max(pv.w, pv.h)) : [0, 0, 0, 0];
}

/** 8-bit render of a region (x0, y0, w, h: in the output frame, outFrame) of `frame` into `target` (RGBA, w×h×4 bytes). */
async function renderRegion(frame, x0, y0, w, h, target, u) {
  const lens = lensOf(u), expo = sceneGain(u), c = viewCrop();
  if (gpu) {
    const g = gpuInput(frame, x0, y0, w, h, u);
    return engine.process_frame(g.wgsl, g.uniform, g.arr, w, h, PACK_LUT, OUTPUT_WGSL, packParams(packTo(), invUniform(u)), target);
  }
  const map = frameMap(frame.w, frame.h, u.tilt, c), o = cropPx(frame.w, frame.h, c);   // Raddrizza / Ritaglia (tilt.js); null when neither
  const rgb = lensActive(lens) || map
    ? extractLens(frame.data, frame.w, frame.h, frame.p3, x0, y0, w, h, expo, lensGeometry(o.w, o.h, lens), true, map)
    : extractLinear(frame.data, frame.w, frame.p3, x0, y0, w, h, expo, true);
  if (u.temp) {   // Temperatura luce (the GPU applies it as the input pass's wb gains)
    const g = lightGains(u.temp, frame.p3 ? 'rec2020' : 'srgb');
    for (let i = 0; i < rgb.length; i += 3) { rgb[i] *= g[0]; rgb[i + 1] *= g[1]; rgb[i + 2] *= g[2]; }
  }
  const ip = inputPass(u, frame.p3 ? 'p3' : 'srgb'), at0 = DISPLAY_GAIN_LUT.length;
  if (ip.dodge) dodgeCPU(rgb, w, h, x0, y0, o.w, o.h, expo, ip.arr, at0, LUMA[frame.p3 ? 'rec2020' : 'srgb'], map, frame.w, frame.h);
  if (ip.ht) {   // Hyper Tone: the map's gain on the scene light (hypertone.js hyperGainCPU, as the GPU pass)
    const g = new Float32Array(3);
    for (let y = 0, j = 0; y < h; y++) {
      for (let x = 0; x < w; x++, j += 3) { hyperGainCPU(ip.arr, at0, x0 + x, y0 + y, o.w, o.h, g); rgb[j] *= g[0]; rgb[j + 1] *= g[1]; rgb[j + 2] *= g[2]; }
    }
  }
  const out = engine.process(rgb, w, h), d32 = new Uint32Array(target.buffer, target.byteOffset, w * h);
  const px = new Float32Array(3), to = packTo(), inv = invUniform(u);
  for (let p = 0, j = 0; p < w * h; p++, j += 3) {
    px[0] = out[j]; px[1] = out[j + 1]; px[2] = out[j + 2];
    if (inv) invertCPU(px, inv);   // v4: negative -> positive, as the GPU output pass
    if (to) toSpaceCPU(px, to);   // Rec.2020 → output space, as the GPU output pass
    d32[p] = (q8(px[0]) | (q8(px[1]) << 8) | (q8(px[2]) << 16) | 0xff000000) >>> 0;
  }
}
/** The GPU input pass of a render of that region of `frame`: its WGSL, uniform and storage array. `frame` is sampled through
 * normalised coordinates, so a frame smaller than the uploaded one (the reduced preview, render) reads the texture scaled. */
function gpuInput(frame, x0, y0, w, h, u) {
  const space = frame.raw ? 'rec2020' : frame.p3 ? 'p3' : 'srgb', wb = sceneWb(undefined, space === 'srgb' ? 'srgb' : 'rec2020', u.temp);
  const ip = inputPass(u, space);
  return { wgsl: ip.wgsl, arr: ip.arr, uniform: inputUniform(frame.w, frame.h, space, x0, y0, w, h, 1, lensOf(u), sceneGain(u), u.clarity, u.texture, wb, u.sharp, u.vibrance / 100, !!interno(), u.tilt, viewCrop(), frameNoise(frame)) };
}
/** A fresh copy of the photo's scene-linear thumb at `longSide`: the raw's own (decoded with it, raw.js previewThumb), or the
 * JPEG preview's. */
const thumbOf = (preview, longSide = THUMB_PX, mean = false) => (preview.raw ? previewThumb(preview.raw, longSide, mean) : jpegThumb(preview, longSide));

/** v3: DISPLAY_GAIN_LUT + the dodging header and base map (base: once per photo, from the AutoSetup thumbnail). */
function v3Gain(u, space) {
  if (!photo.dodge) {
    const { rgb, w, h } = thumbOf(photo.preview);
    photo.dodge = dodgeBase(rgb, w, h, LUMA[space === 'p3' ? 'rec2020' : space]);   // a P3 JPEG's thumb is Rec.2020 (extractLinear)
    log(`v3 dodge base ${w}x${h} median ${photo.dodge.M.toFixed(2)} p99 ${photo.dodge.P.toFixed(2)}`);
  }
  return dodgeArray(DISPLAY_GAIN_LUT, photo.dodge, { ...dodgeParams(photo.dodge, u.contrast, u.ev - (photo.autoEv ?? u.ev)), dodge: u.v3dodge }, u.hlc, u.shadows, Math.min(u.highlight, 0), Math.min(u.whites, 0));
}
/** The input pass of this render: its WGSL and storage array (DISPLAY_GAIN_LUT, then a local exposure's header and map).
 * v3: the dodging, Ombre, Alte luci / Bianchi (dodge.js); v4: Hyper Tone (Frontier, hypertone.js); else the plain pass. */
function inputPass(u, space) {
  if (DODGE) return { wgsl: INPUT_WGSL_V3, arr: v3Gain(u, space), dodge: true };
  if (htOn(u)) return { wgsl: INPUT_WGSL_HT, arr: hyperPassArray(u), ht: true };
  return { wgsl: INPUT_WGSL, arr: DISPLAY_GAIN_LUT };
}
const q8 = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));

// ---------- auto ----------
// Auto = the engine's own exposure metering on a thumb of the photo (Esposizione), then the
// scanner's AutoSetup on that thumb as the film will see it (frontier.auto).
// Auto exposure = engine meter on the thumb, clamped to the Esposizione slider range. AutoSetup is a function of (Interno on/off, the exposure it ran at):
// cached per photo, never touches the sliders, so toggling Interno off restores the exact previous result.

function autoSetup(on, evIn = null) {
  const eng = syncEngine(ui());   // a fresh engine has the library defaults (camera auto-exposure on, no scanner model)
  const { rgb, w, h } = thumbOf(photo.preview);
  const scale = (k) => { for (let i = 0; i < rgb.length; i++) rgb[i] *= k; };
  scale(2 ** baselineEv());
  // The meter sees the scene as shot: it never compensates Interno's U (the negative stays thin).
  // Auto keeps its own -2..+2.5 range (the slider's before v3.33, when it became -3..+3): a wider slider must not change what Auto picks.
  const ev = evIn !== null ? evIn : Math.max(AUTO_EV_MIN, Math.min(AUTO_EV_MAX, Math.round(eng.auto_exposure_ev(rgb.slice(), w, h) * 10) / 10));
  if (neutralScan()) return { ev, auto: null };   // no scanner AutoSetup: the neutral inversion has its own anchors (v4Anchors)
  scale(2 ** (ev - underEv(on)));
  // Engine.frontier_auto_setup takes linear RGBA f32 (w*h*4), not RGB.
  const rgba = new Float32Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h * 3; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 1; }
  const auto = Array.from(eng.frontier_auto_setup(rgba, w, h));
  return { ev, auto };
}

function hyperSharp(u, region) {
  if (!(u.hypersharp > 0)) return { unsharp_mask: [0, 0] };
  const [W, H] = wholeFrame(region).frame_px, kpx = Math.max(W, H) / FRAME_UM, gate = Math.max(kpx / PREVIEW_KPX, 0.5);
  return { unsharp_mask: [HS_UM * kpx, u.hypersharp * HS_MAX], unsharp_threshold: [HS_T0 * gate, HS_T1 * gate] };
}

const htOn = (u) => V4 && scanner === 'frontier' && (u.htHi > 0 || u.htLo > 0);
/** photo.hyper: the Hyper Tone map of the output frame (lib/hypertone.js): built from the thumb at HYPER_THUMB_PX once per photo
 * and scanner density (photo.hyperBase, the guided filter: the costly part), then turned and cropped like the render, a cheap
 * resample of the smooth map, so a Raddrizza drag or a crop does not rebuild it. */
function syncHyperMap(u) {
  // The thumb as the scanner renders it, as on the machine (Hypertone dodges the scanned image): Auto's exposure + baseline (v4 has
  // no exposure slider), the AutoSetup's density key (EV) and the operator's (Densità). Without the key a dark backlit frame that AutoSetup lifts by 2 EV
  // left its sky outside the map's dead zone: Hyper Tone luci 5 did nothing while the sky lost its blue (sunset, measured).
  const key0 = scanEv() + baselineEv() + (photo.auto?.[0] ?? 0), gain = 2 ** (key0 + u.labD * LAB_D_EV);   // the operator's density key too
  // While Densità is being dragged the map is kept (only its density key moved): a new map changes the input pass, so the
  // developed film (cached on it, wgpu_backend film_key) was re-run on every step (the user's PC: ~270 ms a step instead of
  // ~20-80). The render after the slider rests (sliderInput) rebuilds it.
  const dragD = sliding('labD') && photo.hyperBase?.key0 === key0;
  if (photo.hyperBase?.gain !== gain && !dragD) {
    const { preview } = photo, { rgb, w, h } = thumbOf(preview, HYPER_THUMB_PX, true);   // a raw's mean thumb (raw.js rawMeanThumb)
    photo.hyperBase = { ...hyperToneMap(rgb, w, h, LUMA[preview.raw || preview.p3 ? 'rec2020' : 'srgb'], gain, noiseAt(Math.max(w, h))[0]), gain, key0 };   // a P3 JPEG's thumb is Rec.2020 (extractLinear)
    log(`hyper tone map ${photo.hyperBase.w}x${photo.hyperBase.h}`);
  }
  // the map spans the output frame as rendered (turned and cropped like it: the input pass samples it in output-frame px)
  const b = photo.hyperBase, key = `${u.tilt}|${JSON.stringify(viewCrop())}`;
  if (photo.hyper?.base !== b || photo.hyper.key !== key) {
    const { data: map, w, h } = frameImage(b.map, b.w, b.h, 1, u.tilt, viewCrop());
    photo.hyper = { map, w, h, base: b, key };
  }
}
/** The Hyper Tone pass's storage array (hypertone.js hyperArray), kept while the map and the levels stay (a slider elsewhere
 * re-renders without rebuilding the ~1 MB array). */
function hyperPassArray(u) {
  syncHyperMap(u);
  const kHi = hyperLevel(u.htHi), kLo = hyperLevel(u.htLo), c = photo.hyperArr;
  if (c?.hyper !== photo.hyper || c.kHi !== kHi || c.kLo !== kLo) photo.hyperArr = { hyper: photo.hyper, kHi, kLo, arr: hyperArray(DISPLAY_GAIN_LUT, photo.hyper, kHi, kLo) };
  return photo.hyperArr.arr;
}

// Nessuno's mid grey (what lands on display mid grey, invert.js): a level of the scene's light set by the exposure, not by the
// frame. Until 4.39 it was the frame's median density: a low-key frame, a room in shade with the sun on a face
// (IDG_20261108_155937_321, ~7 stops), had its room lifted to mid grey (median L* 49, the iPhone's 15) and the black -> mid
// slope ~3x steeper than the film's, which turned the room's small colour differences into regional casts (blue / orange walls).
// Now: the meter's grey (Auto puts the metered scene at SCENE_GREY, 18 % linear, on the film) MEDIAN_EV lower, moved with
// Esposizione (a denser negative is not a brighter print, as the lab scanners; Luminosità moves the print), read as the density
// of a uniform GREY_PX-square patch through the same engine (uniform: halation and DIR diffusion do nothing to it; 8 px: small
// and cheap, a choice). MEDIAN_EV: the engine's meter averages light, so an ordinary frame's median sits under its grey;
// measured on the check photos (sea / rock / cat / ORF / sunset: -0.7 / -1.65 / -0.7 / -1.1 / -1.0 EV, mean -1.0; the IDG room
// above -3.4): -1 keeps the old median anchor's brightness on average (the look the user approved), each frame now within its
// own +-0.6 EV of it. Tried: the meter's grey itself (check cases 6-12 L* darker) and the DNG's grey (18 % after its
// BaselineExposure; 10-17 L* darker: the phone exposes for the highlights and its renderer lifts the mids).
const SCENE_GREY = 0.18, MEDIAN_EV = -1.0, GREY_PX = 8;
/** v4: the inversion anchors of this frame (lib/invert.js), from the engine's negative scan of the metered thumb (no grain,
 * lens, dodge or Temperatura: the frame's own range, the sliders act on top) and of a mid-grey patch at the same exposure. */
function v4Anchors(ev) {
  const { rgb, w, h } = thumbOf(photo.preview);
  const g = 2 ** (ev + baselineEv());
  for (let i = 0; i < rgb.length; i++) rgb[i] *= g;
  const eng = syncEngine(ui(), { noGrain: true }), scan = eng.process(rgb, w, h);
  const grey = eng.process(new Float32Array(GREY_PX * GREY_PX * 3).fill(SCENE_GREY * 2 ** (ev - (photo.autoEv ?? ev) + MEDIAN_EV)), GREY_PX, GREY_PX).slice(0, 3);
  return invertAnchors(scan, { shared: true, grey });   // the scan is on the stock's grey axis (NARROWBAND)
}
const invUniform = (u) => (neutralScan() ? invertUniform(photo.inv, { mshift: u.mshift, yshift: u.yshift, ev: u.nbBright * LAB_D_EV }) : null);

// ---------- preview ----------

// A slider counts as dragged until SLIDER_REST_MS after its last input event (a choice: longer than the gap between a drag's
// input events, short enough that the exact render follows at once); then one render if the drag left a stand-in on screen:
// a reduced preview (render), or Densità's kept Hyper Tone map (syncHyperMap).
const SLIDER_REST_MS = 250;
let sliderMovedAt = 0, sliderMoved = '', sliderRest = 0;
const sliding = (id = sliderMoved) => sliderMoved === id && performance.now() - sliderMovedAt < SLIDER_REST_MS;
function sliderInput(id) {
  sliderMovedAt = performance.now(); sliderMoved = id;
  clearTimeout(sliderRest);
  sliderRest = setTimeout(() => { if (photo && (photo.reduced || (id === 'labD' && htOn(ui())))) render(); }, SLIDER_REST_MS);
}
// While a slider that re-runs the film is dragged, the preview renders at LOW_SCALE of its side (a choice, user: half the long
// side, ~4x fewer pixels; the user's PC (integrated GPU) took ~270-340 ms a film step at 1500x2000; measured on SwiftShader,
// an Esposizione step on the IDG 1500x2000 preview: 2.8 s at 750x1000 vs 13-15 s full) and is drawn scaled up;
// the engine works in physical units (pixel = film_format_mm / long side), so grain and halation keep their size, softer. A
// slider whose render hits the developed film (the GPU film cache: the scanner, the lab, the output pass) stays at full size: a
// reduced render would re-run the film at its own size, and so would the full one after it.
const LOW_SCALE = 0.5;
let lowCtx = null;   // the reduced render's canvas, drawn scaled onto the view
/** Draw `img` (a reduced render) over the whole view canvas, scaled up. */
function drawReduced(img) {
  const cs = img.colorSpace;
  if (lowCtx?.getContextAttributes().colorSpace !== cs) lowCtx = document.createElement('canvas').getContext('2d', { colorSpace: cs });
  lowCtx.canvas.width = img.width; lowCtx.canvas.height = img.height;
  lowCtx.putImageData(img, 0, 0);
  ctx.drawImage(lowCtx.canvas, 0, 0, view.width, view.height);
}
/** What the developed film of a full-frame w×h preview render depends on (the engine's film_key, wgpu_backend.rs): the film's
 * params (all but the scanner) and the input pass. */
function filmOf(u, w, h) {
  const { scanner: _, ...film } = renderParams(u, { region: { x0: 0, y0: 0, fw: w, fh: h, W: w, H: h } }), g = gpuInput(photo.preview, 0, 0, w, h, u);
  return { key: JSON.stringify(film) + g.uniform.join(), wgsl: g.wgsl, arr: g.arr };
}
const sameFilm = (a, b) => a.key === b.key && a.wgsl === b.wgsl && (a.arr === b.arr || (a.arr.length === b.arr.length && a.arr.every((v, i) => v === b.arr[i])));

async function render() {
  if (!photo) return;
  if (rendering || exporting) { dirty = true; return; }   // export: re-rendered when it ends
  rendering = true;
  try {
    do {
      dirty = false;
      const u = ui(), look = UI2 ? { key: defaultKey(), atDefault: atDefault(u) } : null;   // the mascot's, as this frame is rendered
      if (V4 && !loadingPhoto) prepareScanner();   // the scanner re-reads the negative when Esposizione / Interno moved (cached)
      const pv = photo.preview, { w, h } = outFrame(pv.w, pv.h), t0 = performance.now(), n = ++renderCount;
      // the reduced preview (LOW_SCALE): the same frame texture read as a smaller frame (gpuInput); GPU only (the CPU path reads pixels)
      const film = gpu ? filmOf(u, w, h) : null, low = film && sliding() && !(photo.film && sameFilm(film, photo.film));
      const frame = low ? { ...pv, w: Math.round(pv.w * LOW_SCALE), h: Math.round(pv.h * LOW_SCALE) } : pv, r = outFrame(frame.w, frame.h);
      photo.reduced = low;   // from the start: a rest timer during this render must still ask for the full one
      // Breadcrumb: if iOS kills the tab mid-render, the next load says so.
      setBusy(`anteprima #${n} ${r.w}x${r.h} ${JSON.stringify(u)}`);
      syncEngine(u, { region: { x0: 0, y0: 0, fw: r.w, fh: r.h, W: r.w, H: r.h } });
      const cs = outSpace() === 'p3' ? 'display-p3' : 'srgb';
      // the histogram, the mascot and the 'after' image (photo.after) are full renders only
      const img = low ? new ImageData(r.w, r.h, { colorSpace: cs }) : photo.after?.width === w && photo.after.height === h && photo.after.colorSpace === cs ? photo.after : (photo.after = new ImageData(w, h, { colorSpace: cs }));
      await renderRegion(frame, 0, 0, r.w, r.h, new Uint8Array(img.data.buffer), u);
      if (!low) photo.film = film;
      const t1 = performance.now();
      if (view.width !== w || view.height !== h) sizeView();   // the crop changed the output frame
      if (!showingBefore && low) drawReduced(img);
      else if (!showingBefore) { ctx.putImageData(photo.after, 0, 0); drawHistogram(photo.after); ui2?.rendered(photo.after, look); }
      const t2 = performance.now(), ms = (v) => Math.round(v);
      status(`${r.w}×${r.h} · ${ms(t2 - t0)} ms (render ${ms(t1 - t0)} · display ${ms(t2 - t1)})${gpu ? '' : ' CPU'}`);
      log(`render #${n} ${ms(t1 - t0)}+${ms(t2 - t1)} ms`);
    } while (dirty && !exporting);
    renderErrors = 0;
  } catch (e) {
    log('render error: ' + (e?.stack || e));
    // A GPU error or a lost device leaves the engine dead (every later render fails the same way): after the second in a
    // row the status line offers a reload, which keeps nothing but recovers.
    status('Errore: ' + (e?.message || e) + (++renderErrors >= 2 ? ' — tocca qui per ricaricare' : ''), renderErrors >= 2 ? 'reload' : '');
  } finally {
    rendering = false;
    setBusy(exporting ? 'export' : loadingPhoto ? loadMark : null);   // a decode in flight gets its marker back
  }
}

/** Every slider of `u` (ui()) at its default (sliderBase); the frame (turn, Raddrizza, crop) and Interno are not sliders. */
const atDefault = (u) => Object.keys(FORMAT).every((id) => OVERLAY_ONLY.has(id) || Math.abs(u[id] - sliderBase(id)) < 1e-9);
/** What the default render below depends on: the scanner, Interno, the frame as rendered now. */
const defaultKey = () => JSON.stringify([scanner, $('indoor').checked, viewCrop(), $('tilt').value, photo?.rot]);
/** The photo as the current scanner gives it with every slider at its default, at the frame as rendered now and with Interno as
 * it is: UI 2's mascot judges the final render's colour against it (mascot.js), so a cast or a saturation is the sliders',
 * never another scanner's look. One preview render, off screen; null without a photo or when `key` (defaultKey) is no longer
 * what is shown. */
async function renderDefault(key) {
  while (rendering || exporting || loadingPhoto || internoBusy || rotBusy) await sleep(20);   // the engine is shared
  const p = photo;
  if (!p || defaultKey() !== key) return null;
  rendering = true;
  try {
    const u = { ...ui(), ...Object.fromEntries(Object.keys(FORMAT).map((id) => [id, sliderBase(id)])) };
    prepareScanner(u.ev);
    const pv = photo.preview, { w, h } = outFrame(pv.w, pv.h);
    syncEngine(u, { region: { x0: 0, y0: 0, fw: w, fh: h, W: w, H: h } });
    const img = new ImageData(w, h, { colorSpace: outSpace() === 'p3' ? 'display-p3' : 'srgb' });
    await renderRegion(pv, 0, 0, w, h, new Uint8Array(img.data.buffer), u);
    return img;
  } finally {
    if (photo === p && !loadingPhoto) prepareScanner();   // the sliders' exposure again (cached); the next render syncs the engine
    rendering = false;
    if (dirty) render();   // an edit that arrived meanwhile
  }
}

// ---------- histogram (overlay, top left; lib/histogram.js) ----------
// While the crop is drawn (Trasforma), only the crop box's pixels.
const histo = $('histo');
const drawHistogram = (img) => paintHistogram(histo, img, cropUI.editing() ? cropPx(img.width, img.height, cropUI.crop()) : null);
/** The histogram of the crop box, once per frame however many pointer moves arrive (iPhone: up to 120 a second; a pass reads
 * ~0.75 M pixels of the preview). */
let histoFrame = 0;
function histoSoon() {
  if (!histoFrame) histoFrame = requestAnimationFrame(() => { histoFrame = 0; if (photo?.after && !showingBefore) drawHistogram(photo.after); });
}

// ---------- dust & scratches (separate layer, dust.js) and the film frame (Cornice, filmframe.js) ----------
// Drawn over the preview by the compositor and into the export strips; never
// touches the engine render, so moving the slider or reseeding is instant.
// The frame is the output stage's, like the dust: the film around the picture (its rebate, the carrier) added around the
// rendered image, the mat (Bordo) outside it; the dust lies on the film, so it covers the frame too (dust.js drawDustFramed).

const dustLayer = $('dustLayer'), dctx = dustLayer.getContext('2d');
const frameLayer = $('frameLayer'), fctx = frameLayer.getContext('2d'), matLayer = $('matLayer');
const dustAmount = () => +$('dust').value;
const frameStyle = () => FRAME_STYLES[+$('frame').value] || 'none';
let frameM = { mx: 0, my: 0 };   // the preview's frame + mat margins (fitToScreen fits the image with both)
function dustMarks() {
  const { w, h } = outFrame(photo.preview.w, photo.preview.h), key = `${photo.dustSeed}|${w}x${h}`;
  if (photo.dustKey !== key) {
    const aspect = Math.max(w, h) / Math.min(w, h);
    photo.dust = { marks: dustField(photo.dustSeed, aspect), around: borderFields(photo.dustSeed, aspect) };
    photo.dustKey = key;
  }
  return photo.dust;
}
/** A layer canvas centred on the view (an abs-pos flex child, same transform) at W×H. */
function sizeLayer(c, W, H) {
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; c.style.width = W + 'px'; c.style.height = H + 'px'; }
}
/** The preview's overlays: the film frame (the photo's own seed: the same frame on every load and export) and the dust. */
function drawOverlays() {
  if (!photo) return;
  const { w, h } = outFrame(photo.preview.w, photo.preview.h), style = frameStyle();
  const { mx, my } = frameMargins(style, w, h), W = w + 2 * mx, H = h + 2 * my;
  const showFrame = style !== 'none' && !showingBefore;
  // the mat (Bordo, Trasforma) around the image and its frame, as the export adds it (matMargins)
  const mat = showingBefore ? { x: 0, y: 0 } : matMargins(W, H, borderFrac());
  frameM = { mx: mx + mat.x, my: my + mat.y };
  matLayer.style.display = mat.x || (style !== 'none' && !showingBefore) ? 'block' : 'none';
  matLayer.style.width = W + 2 * mat.x + 'px'; matLayer.style.height = H + 2 * mat.y + 'px';
  matLayer.style.background = `rgb(${matColour().join(',')})`;
  frameLayer.style.display = showFrame ? 'block' : 'none';
  const fkey = `${style}|${photo.grainSeed}|${w}x${h}`;
  if (showFrame && frameLayer.dataset.key !== fkey) {
    sizeLayer(frameLayer, W, H);
    const img = fctx.createImageData(W, H);
    drawFrame(img.data, style, photo.grainSeed, w, h, 0, 0, W, H);
    fctx.putImageData(img, 0, 0);
    frameLayer.dataset.key = fkey;
  }
  sizeLayer(dustLayer, W, H);
  dctx.clearRect(0, 0, W, H);
  const a = dustAmount();
  dustLayer.style.display = a > 0 && !showingBefore ? 'block' : 'none';
  if (a > 0) { const d = dustMarks(); drawDustFramed(dctx, d.marks, d.around, a, w, h, mx, my); }
}
const newDustSeed = () => (Math.random() * 2 ** 32) >>> 0;
// Grain is the film's own: the same photo gets the same grain on every load
// and every export (FNV-1a of name, size, date).
const fileSeed = (f) => { let h = 2166136261; for (const ch of `${f.name}|${f.size}|${f.lastModified}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };


let showingBefore = false;
/** The 'before' view (A/B, a fresh preview): the source as decoded, turned and cropped like the render (Raddrizza, Ritaglia). */
function beforeImage() {
  const pv = photo.preview, deg = +$('tilt').value, c = viewCrop();
  if (!deg && isFull(c)) return pv.before;
  const key = `${deg}|${JSON.stringify(c)}`;
  if (photo.beforeTilt?.pv !== pv || photo.beforeTilt.key !== key) {
    const t = frameImage(pv.before.data, pv.w, pv.h, 4, deg, c);
    photo.beforeTilt = { pv, key, img: new ImageData(t.data, t.w, t.h, pv.p3 ? { colorSpace: 'display-p3' } : undefined) };
  }
  return photo.beforeTilt.img;
}
function showBefore(on) {
  if (!photo?.after) return;
  if (on === showingBefore) return;
  showingBefore = on;
  drawOverlays();
  const img = on ? beforeImage() : photo.after;
  ctx.putImageData(img, 0, 0);
  drawHistogram(img);
  $('badge').style.display = on ? 'block' : 'none';
}
const compare = $('compare');
compare.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); showBefore(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) compare.addEventListener(ev, () => showBefore(false));
compare.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- zoom & pan (lib/viewport.js) ----------
const viewport = initViewport({ stage, view, layers: [view, dustLayer, frameLayer, matLayer], label: $('zoomLabel'),
  margins: () => frameM, active: () => !!photo, onChange: () => cropUI.place() });
const fitToScreen = viewport.fit;
$('fit').addEventListener('click', fitToScreen);

// ---------- resizable slider panel (lib/panel.js) ----------
const controls = $('controls');
const setPanel = initPanel(controls, $('grip'));

// Bottom tab bar: one section of sliders at a time; tapping while collapsed expands the sheet.
/** v4: a slider's default, what Azzera gives it (UI 2): the photo's Auto exposure, the film's grain / halation, else 0. */
function sliderBase(id) { return id === 'ev' ? photo?.autoEv ?? 0 : id in V4_FILM ? V4_FILM[id] : 0; }
if (V4) {
  document.querySelector('#tabs [data-tab="light"]').remove();   // v4: the light is the phone's exposure
  // Magenta ↔ Verde / Giallo ↔ Blu are the scanner's colour keys (the inversion's, or the Frontier's cmy): in the Scanner tab
  for (const id of ['mshift', 'yshift']) document.querySelector('[data-pane="scanner"]').append($(id).closest('.row'));
  // Esposizione (and its Auto) is the camera's: how much light the film gets, at the top of Pellicola. Measured on a dim indoor
  // DNG (IDG_20261024_153100_228): at the phone's exposure Gold's green layer sits in its toe on orange light and Nessuno split
  // the pumpkin flesh into red and yellow; 1-2 EV more film exposure keeps it one orange (the scanner re-reads the denser negative).
  document.querySelector('[data-pane="film"]').prepend($('auto').closest('.row'), $('ev').closest('.row'));
  for (const id of ['texture', 'ca', 'vignette', 'falloff']) $(id).value = 0;
  for (const [id, v] of Object.entries(V4_FILM)) $(id).value = v;
}
{
  const tabBtns = [...document.querySelectorAll('#tabs button')], panes = [...document.querySelectorAll('.pane')];
  const showTab = (t) => {
    tabBtns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    panes.forEach((p) => { p.hidden = p.dataset.pane !== t; });
    controls.scrollTop = 0;
    cropUI.setEditing(t === 'transform');   // Ritaglia: the whole frame with the crop box while Trasforma is open
  };
  const savedTab = store.get('fcf_tab');
  if (tabBtns.some((b) => b.dataset.tab === savedTab)) showTab(savedTab);
  tabBtns.forEach((b) => b.addEventListener('click', () => {
    showTab(b.dataset.tab); store.set('fcf_tab', b.dataset.tab);
    if (!DESK.matches && controls.getBoundingClientRect().height <= 8) store.set('fcf_panel', String(setPanel(innerHeight * PANEL_DEFAULT_VH) || 1));
  }));
}

// ---------- photo ----------

// loadSeq: the newest pick (an older load that resumes after it returns without touching anything); loadAbort stops an
// older pick's raw decode (raw.js); loadMark: the decode's crash breadcrumb (a render during the decode puts it back).
let loadSeq = 0, loadingPhoto = false, loadAbort = null, loadMark = null;
async function loadPhoto(file) {
  if (!file || exporting) return;   // a drop during an export would decode on top of it (memory) and race its finally
  const my = ++loadSeq, prev = photo;
  loadingPhoto = true;   // from here: the update check must not reload under it (also during the boot wait)
  loadAbort?.abort(new Error('decodifica annullata'));   // a raw still decoding for an older pick is replaced, not queued
  const abort = loadAbort = new AbortController();
  if (!engineReady) {
    status('Caricamento motore…');
    await booted;
    if (my !== loadSeq) return;   // a newer pick waited too and loads instead
    if (!engineReady) { status(bootError, 'reload'); loadingPhoto = false; return; }   // boot failed: show its error again
  }
  status('Decodifica…');
  // Nothing exportable until this photo has loaded and been auto-measured; stays disabled on error.
  $('export').disabled = $('exportIG').disabled = $('auto').disabled = true;
  // Breadcrumb: a decode killed for memory (a 48 MP HEIC, a 20 MP raw) is reported on the next load.
  loadMark = `decodifica ${file.name} ${(file.size / 1e6).toFixed(1)} MB`;
  setBusy(loadMark, true);
  try {
    log(`photo: ${file.name} ${file.type} ${(file.size / 1e6).toFixed(1)} MB`);
    if (await isRaw(file)) {
      // DNG (raw.js): scene-linear Rec.2020, half-float frame; output in Display P3.
      if (!gpu) throw new Error('I file RAW (DNG / ORF) richiedono WebGPU');
      // the 'before' view, half-float frame and thumbs come converted (raw.js previewOf); the view lives on as preview.data only
      const t = performance.now(), { view, ...raw } = await loadRaw(file, PREVIEW_LONG_SIDE, 0, { signal: abort.signal, thumbs: [THUMB_PX], means: [HYPER_THUMB_PX] });
      while (rendering || exporting) await sleep(20);
      if (my !== loadSeq) return;
      const preview = { data: view, w: raw.w, h: raw.h, p3: true, raw };
      preview.before = new ImageData(preview.data, preview.w, preview.h, { colorSpace: 'display-p3' });
      log(`raw ${raw.fullW}x${raw.fullH}, preview ${raw.w}x${raw.h}, orientation ${raw.orientation}, baseline ${raw.baseline} EV, ${Math.round(performance.now() - t)} ms (${raw.decodedIn})`);
      $('indoor').checked = false; rotPending = 0; resetTransform();
      photo = { file, size: null, preview, auto: NO_AUTO, dustSeed: newDustSeed(), grainSeed: fileSeed(file), rot: 0 };
      uploadRaw(sf, raw);
    } else {
      const bitmap = await decodeFull(file);
      // A render or export in flight still uses the current photo, engine and GPU frame.
      while (rendering || exporting) await sleep(20);
      if (my !== loadSeq) { bitmap.close(); return; }
      let preview;
      const size = { w: bitmap.width, h: bitmap.height };   // read before close(): a closed bitmap reports 0 x 0
      try {
        preview = decodeRGBA(bitmap, PREVIEW_LONG_SIDE);
        preview.before = new ImageData(preview.data, preview.w, preview.h, preview.p3 ? { colorSpace: 'display-p3' } : undefined);
      } finally { bitmap.close(); }
      log(`decoded ${size.w}x${size.h}, preview ${preview.w}x${preview.h}, p3=${preview.p3}`);
      $('indoor').checked = false; rotPending = 0; resetTransform();
      photo = { file, size, preview, auto: NO_AUTO, dustSeed: newDustSeed(), grainSeed: fileSeed(file), rot: 0 };
      if (gpu) {
        uploadFrame(preview.data, preview.w, preview.h);
      }
    }
    engine?.free(); engine = null;   // the input colour space is fixed at construction
    showPreview();
    await runAuto();
    if (my !== loadSeq) return;   // a newer pick is decoding: its load enables the buttons
    photoUsable();
  } catch (e) {
    if (my !== loadSeq) { log(`load superseded: ${file.name} (${e?.message || e})`); return; }   // the newer pick owns the status
    log('load error: ' + (e?.stack || e));
    status('Errore: ' + (e?.message || e));
    if (photo === prev && prev) photoUsable();   // failed decode: the previous photo is still shown, keep it usable
  } finally {
    if (my === loadSeq) { loadingPhoto = false; loadMark = null; if (!rendering && !exporting) setBusy(null); }
  }
}

/** The current photo's buttons enabled and shown (a load that finished, or a failed one that kept the previous photo, even one
 * whose own load was superseded before it got here). */
function photoUsable() {
  $('export').disabled = $('auto').disabled = $('exportIG').disabled = false;
  ui2?.photoLoaded();
  $('exportIG').hidden = $('newPhoto').hidden = false;
}

/** Canvas, dust layer, 'before' image and fit for the current photo.preview (new photo or a turn). */
/** The canvas at the output frame's size (the preview cropped as rendered now), fitted to the screen. */
function sizeView() {
  const { w, h } = outFrame(photo.preview.w, photo.preview.h);
  view.width = w; view.height = h;
  view.style.width = w + 'px'; view.style.height = h + 'px';
  drawOverlays();
  fitToScreen();
}
function showPreview() {
  view.style.display = 'block'; $('empty').style.display = 'none'; $('tools').hidden = false;
  sizeView();
  const before = beforeImage();
  ctx.putImageData(before, 0, 0);
  drawHistogram(before);
}

// ---------- transform: quarter turns ----------
// The turn is applied at the source (raw.js withRotation / common.js decodeRGBA, forEachStrip): the preview,
// the dodging base, AutoSetup thumbs and the export tiles all see an upright frame of the turned size.
// Sliders and the auto exposure stay (they do not depend on the frame's orientation).
let rotPending = 0, rotBusy = false;
async function rotate(quarters) {
  if (!photo) return;
  rotPending += quarters;
  if (rotBusy) return;   // folded into the running turn
  rotBusy = true;
  try {
    const target = photo;
    while (rotPending) {
      while (rendering || exporting || internoBusy) await sleep(20);
      if (photo !== target) return;   // a new photo arrived during the wait: the turn was for the old one
      const q = rotPending; rotPending = 0;
      const rot = (photo.rot + q + 4) & 3;
      // the preview's own pixels turned (exact copy, no await: an export cannot start in between); a raw's frame is turned
      // as it uploads, its thumbs are looked up by the turn (raw.js)
      const pv = photo.preview, t = turnRGBA(pv.data, pv.w, pv.h, q);
      const preview = { data: t.data, w: t.w, h: t.h, p3: pv.p3 };
      preview.before = new ImageData(preview.data, preview.w, preview.h, preview.p3 ? { colorSpace: 'display-p3' } : undefined);
      if (pv.raw) {
        preview.raw = withRotation(pv.raw, rot);
        uploadRaw(sf, preview.raw);
      } else if (gpu) uploadFrame(preview.data, preview.w, preview.h);
      Object.assign(photo, { rot, preview, dodge: null, hyper: null, hyperBase: null });   // dodging base, Hyper Tone map: rebuilt from the turned thumb
      for (let i = 0; i < Math.abs(q); i++) cropUI.turn((c) => turnCrop(c, Math.sign(q)));   // the same part of the photo stays cropped
      log(`rotate ${rot * 90}°, preview ${preview.w}x${preview.h}`);
      showPreview();
    }
    await render();
  } catch (e) {
    log('rotate error: ' + (e?.stack || e));
    status('Errore: ' + (e?.message || e));
  } finally {
    rotBusy = false;
    if (rotPending && photo) rotate(0);   // a turn tapped for a newer photo while the old loop was ending
  }
}
// The 90° turns (their buttons sit in Raddrizza's header since 4.36): when one lands, UI 2 commits it to undo / redo.
const turn = (q) => rotate(q).then(() => ui2?.edited?.());
$('rotL').addEventListener('click', () => turn(-1));
$('rotR').addEventListener('click', () => turn(1));

// ---------- transform: Raddrizza (tilt) ----------
// Tape-measure dial (lib/ruler.js) over the hidden #tilt range input: the angle goes into the input pass (lib/tilt.js) of the
// preview and the export. It is relative to the displayed frame, so it stays across the quarter turns (rotations about the same
// centre commute); a new photo and Azzera impostazioni set it to 0. While it is dragged, the crop box shows a ninths grid.
const tiltDial = tiltRuler($('tiltRuler'), $('tilt'), $('tiltOut'), { onDrag: (on) => $('cropBox').classList.toggle('fine', on) });
$('tilt').addEventListener('input', () => { if (photo) render(); });
$('tiltLabel').addEventListener('dblclick', () => tiltDial.set(0));
/** Back to no tilt and the whole frame without a render (new photo: its own first render follows). */
function resetTransform() { $('tilt').value = 0; tiltDial.sync(); cropUI.reset(); }


async function runAuto() {
  // render() returns early while another render / export is in flight: wait first (the engine is shared).
  while (rendering || exporting) await sleep(20);
  const on = $('indoor').checked, a = autoSetup(on);
  photo.autoEv = a.ev; photo.autoCache = a.auto ? { [autoKey(on, a.ev)]: a.auto } : {}; photo.inv = null;
  $('ev').value = a.ev;
  syncOutputs();
  log(`auto: ev ${a.ev}`);
  prepareScanner();
  await render();
}

/** The film's exposure the scanner reads: v4, the Esposizione slider (the lab scans the negative it gets: a denser one is not a
 * brighter print, its dark colours are cleaner); v3, the photo's Auto (its Esposizione moves the print after AutoSetup). */
const scanEv = () => (V4 ? +$('ev').value : photo.autoEv);

/** What the current scanner needs for this photo at exposure `ev` (default: the slider's) and Interno state, measured once
 * each: the neutral inversion's anchors, or the Frontier / Noritsu AutoSetup. */
function prepareScanner(ev = scanEv()) {
  const on = $('indoor').checked, key = autoKey(on, ev);
  if (neutralScan()) {
    if (photo.inv?.key === key) return;
    photo.inv = { ...v4Anchors(ev), key };
    const f = (v) => v.map((x) => x.toFixed(2)).join('/');
    log(`scanner none: density black ${f(photo.inv.lo)} white ${f(photo.inv.hi)} mid ${photo.inv.xm.toFixed(2)}`);
  } else {
    if (photo.autoCache[key]) { photo.auto = photo.autoCache[key]; return; }
    photo.auto = photo.autoCache[key] = autoSetup(on, ev).auto;
    log(`scanner ${scanner}: autosetup ${photo.auto.map((v) => v.toFixed(3)).join(' ')}`);
  }
}

// ---------- scanner (v4 tab; v3 is always the Frontier) ----------
// 'none': the negative read in narrow bands and inverted neutrally (the film alone); 'frontier': the Frontier SP-3000 model on
// the same negative (v3's scanner and its Gold-look corrections); 'noritsu': the same scanner model with a Noritsu's tone, colour
// and AutoSetup (V4_NORITSU, fitted on real Noritsu scans). The choice is remembered.
const SCANNERS = ['none', 'frontier', 'noritsu'];
let scanner = V4 && SCANNERS.includes(store.get('fcf_scanner')) ? store.get('fcf_scanner') : V4 ? 'none' : 'frontier';
function neutralScan() { return scanner === 'none'; }
const autoKey = (on, ev) => `${scanner}:${on}:${ev}`;   // the scanner's setup depends on the scanner, Interno and the exposure
async function setScanner(s) {
  scanner = s; store.set('fcf_scanner', s);
  for (const b of document.querySelectorAll('[data-scanner]')) b.setAttribute('aria-checked', String(b.dataset.scanner === s));
  $('frontierRows').hidden = scanner !== 'frontier';   // Hyper Tone / Hyper Sharpness are the Frontier's
  $('labRows').hidden = neutralScan();   // the operator's keys of a lab scanner (Frontier, Noritsu)
  $('neutralRows').hidden = !neutralScan();   // Luminosità: the neutral inversion's mid grey
  if (!photo || loadingPhoto) return;   // a photo still loading measures for this scanner in its own runAuto
  internoBusy++;   // an export waits for the switch (same guard as Interno)
  try {
    while (rendering || exporting) await sleep(20);   // the engine is shared
    // A fresh engine: updates are merged, so the last scanner's keys that this one does not send stayed in (Frontier -> Noritsu
    // kept V4_AUTO's highlight_weight / highlight_max_channel: AutoSetup put a backlit sunset at L* 18 instead of 62).
    engine?.free(); engine = null;
    prepareScanner();
  } finally { internoBusy--; }
  render();
}
if (V4) {
  for (const b of document.querySelectorAll('[data-scanner]')) b.addEventListener('click', () => { if (b.dataset.scanner !== scanner) setScanner(b.dataset.scanner); });
  setScanner(scanner);
} else document.querySelector('#tabs [data-tab="scanner"]').remove();

// ---------- export ----------
// Full resolution rendered in tiles, one strip of tiles at a time; each strip
// is streamed to jpegli in a worker (lib/encoder.js) and dropped. Neither the full float image
// nor the full RGB image ever exists (in JS, wasm or on the GPU).
// Each tile keeps the frame's physical pixel size (film_format_mm scaled to the
// tile) and the same engine parameters as the preview, with an overlap margin cropped away.
startEncoder();
// Export JPEG quality (File tab): only read by exportFull, never re-renders. Double tap the label: back to the default.
{
  const q = $('quality'), out = () => { q.nextElementSibling.textContent = `${q.value}%`; };
  q.addEventListener('input', out);
  q.previousElementSibling.addEventListener('dblclick', () => { q.value = JPEG_QUALITY_DEFAULT; out(); });
  out();
}

// The mat (Bordo bianco, IG canvas) is pure white (user, v4.10): it was the scanner's own paper white, ~244 / 244 / 246 on the
// Frontier, which read as a grey-blue border; the photo's brightest whites may now look a touch less white beside it.
const MAT_WHITE = [255, 255, 255];
/** The export's mat: its width as a fraction of the long side and its colour. UI 2: its border slider (0 = none, % of the long
 * side) and colour (#borderPct / #borderColor, lib/ui2.js); classic: the switch, BORDER_FRACTION, white. */
const borderFrac = () => (UI2 && $('borderPct') ? +$('borderPct').value / 100 : $('border').checked ? BORDER_FRACTION : 0);
const matColour = () => {
  const h = UI2 && $('borderColor')?.value;
  return h && /^#[0-9a-f]{6}$/i.test(h) ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : MAT_WHITE;
};

// `ig`: Instagram export (v3.27, any orientation): an IG_W × IG_H (3:4) sRGB canvas, the whole photo fitted inside it (mat colour
// around, so Instagram never crops it), rendered at IG_SUPER × the posted size, then Lanczos-downscaled in linear light and
// output-sharpened for screen (lib/igout.js), like Lightroom's Resize to fit + Sharpen for Screen.
async function exportFull(ig = false) {
  // not during a photo load: its decode and the export's would be in memory together
  if (!photo || exporting || loadingPhoto) return;
  while (internoBusy || rotBusy) await sleep(20);   // a pending Interno toggle / AutoSetup / turn must land before the snapshot
  if (!photo || exporting || loadingPhoto) return;
  exporting = true;
  $('export').disabled = $('exportIG').disabled = $('auto').disabled = $('newPhoto').disabled = $('pick').disabled = $('indoor').disabled = $('rotL').disabled = $('rotR').disabled = true;
  setBusy('export', true);
  let enc = null;
  try {   // from `exporting = true` on: anything that throws must reach the finally (it re-enables the buttons)
    // A preview render in flight shares the engine and the GPU frame: let it finish first.
    while (rendering) await sleep(20);
    const u = ui(), dust = dustAmount(), dustD = dustMarks(), style = frameStyle(), fseed = photo.grainSeed;   // fixed for every strip
    const t0 = performance.now();
    const rawPv = photo.preview.raw, size = photo.size;
    const rot = photo.rot || 0, turned = rot & 1;
    const fw = rawPv ? rawPv.fullW : turned ? size.h : size.w, fh = rawPv ? rawPv.fullH : turned ? size.w : size.h;
    const c = viewCrop(), cw = fw * c.w, chh = fh * c.h;   // the output frame (Ritaglia) at full resolution
    const bFrac = borderFrac(), mat = matColour();
    // IG: the posted image (iw × ih) fits inside the canvas with a bFrac mat; the film renders at IG_SUPER × that.
    const fm = frameMargins(style, cw, chh), ecw = cw + 2 * fm.mx, ech = chh + 2 * fm.my;   // with the film frame (Cornice)
    const igFit = ig ? fitInside(ecw, ech, IG_W, IG_H, Math.round(bFrac * IG_H)) : null;
    const scale = ig ? Math.min(1, IG_SUPER * Math.max(igFit.iw, igFit.ih) / Math.max(ecw, ech))
      : Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (cw * chh)));
    if (ig) forceSRGB = true;
    const longCap = Math.round(Math.max(fw, fh) * scale);
    enc = await openEncoder();   // before the decode: a dead encoder fails the export at once
    status('Esporto: decodifica…');
    let frame;   // { data (CPU path only), w, h, p3, raw }
    if (rawPv) {
      // Full-resolution raw decode, uploaded as it decodes (half-float strips from the worker: raw.js loadRaw `sf`)
      const raw = await loadRaw(photo.file, scale < 1 ? Math.round(longCap) : undefined, rot, { sf });
      log(`export raw ${raw.w}x${raw.h} (${raw.decodedIn})`);
      frame = { data: null, w: raw.w, h: raw.h, p3: true, raw: true };
    } else {
      const bitmap = await decodeFull(photo.file);
      try {
        if (gpu && scale === 1) {
          // Native size: decoded and uploaded a strip at a time, so the full
          // frame (~50 MB at 12 MP, plus its canvas) is never in memory.
          frame = { data: null, w: fw, h: fh, p3: false };
          sf.alloc_frame(frame.w, frame.h);
          forEachStrip(bitmap, (data, y0, rows, p3) => { sf.set_frame_rows(data, y0); frame.p3 = p3; }, rot);
        } else {
          frame = decodeRGBA(bitmap, longCap, rot);
          // GPU: the pixels live in the frame texture; drop them for the tile loop.
          if (gpu) { uploadFrame(frame.data, frame.w, frame.h); frame.data = null; }
        }
      } finally { bitmap.close(); }
    }
    const { w, h } = outFrame(frame.w, frame.h), { p3 } = frame;   // the output frame: the crop of the decoded source
    const progressive = w * h > PROGRESSIVE_PIXEL_LIMIT ? 0 : 2;
    // v3.36: the mat keeps the photo's aspect (a 3:4 photo exports at exactly 3:4): bFrac of the long side on the long edges,
    // scaled by long / short across the short ones (portrait 2736x3648: 36 px left / right, 48 px top / bottom -> 2808x3744).
    // The base width moves by up to ±3 px to the value that makes the thick side a whole number (3:4 -> a multiple of 3: exact).
    // The film frame (Cornice) around the image: the canvas is W×H, the image at (mx, my); the mat goes around the canvas.
    const { mx, my } = frameMargins(style, w, h), W = w + 2 * mx, H = h + 2 * my;
    const { x: borderX, y: borderY } = ig ? { x: 0, y: 0 } : matMargins(W, H, bFrac), border = borderX;
    log(`export start ${w}x${h} p3=${p3} progressive=${progressive} frame=${style} ${mx}x${my} border=${borderX}x${borderY}`);

    const longSide = Math.max(w, h);
    const strips = Math.ceil(h / EXPORT_TILE), cols = Math.ceil(w / EXPORT_TILE);

    let tileBuf = null;   // reused across tiles
    enc.check();
    const done = enc.result();
    const quality = +$('quality').value, distance = jpegDistance(quality);
    log(`export quality ${quality} (distance ${distance.toFixed(2)})`);
    const igFull = ig ? new Uint8Array(W * H * 3) : null;   // IG: the whole supersampled render, downscaled at the end
    if (!ig) enc.post({ cmd: 'start', width: W, height: H, distance, progressive, yuv444: 1, border: borderX, borderY, mat });

    // a strip of canvas rows from ey0: the frame over it, the dust, then to the encoder (IG: into the whole canvas)
    const emit = (strip, ey0, rows) => {
      frameIntoStrip(strip, style, fseed, w, h, mx, my, ey0, rows);
      dustIntoStrip(strip, w, h, mx, my, ey0, rows, dust, dustD);
      if (ig) igFull.set(strip, ey0 * W * 3);
      else enc.post({ cmd: 'rows', rgb: strip.buffer }, [strip.buffer]);
    };
    // a new strip: the mat's colour where the frame leaves its margin uncovered (Carrier limato outside the filed edge), the
    // image's rows written over it
    const matStrip = (rows) => { const a = new Uint8Array(W * rows * 3); if (mx || my) for (let i = 0; i < a.length; i += 3) a.set(mat, i); return a; };
    const frameRows = (ey0, rows) => { for (let y = 0; y < rows; y += EXPORT_TILE) emit(matStrip(Math.min(EXPORT_TILE, rows - y)), ey0 + y, Math.min(EXPORT_TILE, rows - y)); };
    frameRows(0, my);   // the frame above the image
    for (let s = 0; s < strips; s++) {
      const ty = s * EXPORT_TILE, ch = Math.min(EXPORT_TILE, h - ty);
      const strip = matStrip(ch);
      for (let c = 0; c < cols; c++) {
        if (enc.failed()) throw new Error(enc.failed());
        const tx = c * EXPORT_TILE;
        status(`Esporto ${w}×${h}: tile ${s * cols + c + 1}/${strips * cols}…`);
        const x0 = Math.max(0, tx - EXPORT_PAD), y0 = Math.max(0, ty - EXPORT_PAD);
        const tw = Math.min(w, tx + EXPORT_TILE + EXPORT_PAD) - x0, th = Math.min(h, ty + EXPORT_TILE + EXPORT_PAD) - y0;
        syncEngine(u, { tileMm: FILM_FORMAT_MM * Math.max(tw, th) / longSide, region: { x0, y0, fw: tw, fh: th, W: w, H: h } });   // frame_px = the tile's dims: film_format_mm is already scaled to the tile, the engine's grain pitch is film_format_mm / max(frame_px)
        const tile = (tileBuf = tileBuf?.length >= tw * th * 4 ? tileBuf : new Uint8Array(tw * th * 4)).subarray(0, tw * th * 4);
        await renderRegion(frame, x0, y0, tw, th, tile, u);
        const cw = Math.min(EXPORT_TILE, w - tx);
        const t32 = new Uint32Array(tile.buffer, tile.byteOffset, tw * th);
        for (let y = 0; y < ch; y++) {   // RGBA tile → RGB strip (one 32-bit read per pixel; little-endian, as the CPU path)
          let src = (ty - y0 + y) * tw + (tx - x0), dst = (y * W + mx + tx) * 3;
          for (let x = 0; x < cw; x++) { const v = t32[src++]; strip[dst] = v; strip[dst + 1] = v >> 8; strip[dst + 2] = v >> 16; dst += 3; }
        }
      }
      emit(strip, my + ty, ch);
      log(`strip ${s + 1}/${strips} sent`);
    }
    frameRows(my + h, my);   // and below it
    if (ig) {
      status('Esporto IG: ridimensiono e rendo nitido…');
      const canvas = igCanvas(igFull, W, H, igFit, IG_W, IG_H, mat);
      log(`IG ${w}x${h} -> ${igFit.iw}x${igFit.ih} on ${IG_W}x${IG_H}`);
      enc.post({ cmd: 'start', width: IG_W, height: IG_H, distance, progressive: 2, yuv444: 1, border: 0 });
      for (let y = 0; y < IG_H; y += 256) {
        const rows = canvas.slice(y * IG_W * 3, Math.min(IG_H, y + 256) * IG_W * 3);
        enc.post({ cmd: 'rows', rgb: rows.buffer }, [rows.buffer]);
      }
    }
    status('Esporto: JPEG (jpegli)…');
    enc.post({ cmd: 'finish' });
    const result = await done;
    const film = `Kodak Gold 200${neutralScan() ? '' : `, ${scanner === 'frontier' ? 'Frontier' : 'Noritsu'} scan`}`;
    const bytes = await withMetadata(result, photo.file, film, outSpace(), iccSegment(outSpace()), log);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const base = (photo.file.name || 'foto').replace(/\.[^.]+$/, '');
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`export done ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    status(`Esportata: ${result.width}×${result.height}, ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    download(blob, `${base}_gold200${ig ? '_ig' : ''}${border || (ig && bFrac) ? '_bordo' : ''}.jpg`);
  } catch (e) {
    enc?.post({ cmd: 'abort' });
    log('export error: ' + (e?.stack || e));
    status('Export fallito: ' + (e?.message || e) + ' (tocca qui per il log)');
  } finally {
    forceSRGB = false;
    startEncoder();   // a fresh worker: the old one's wasm heap kept this export's peak
    setBusy(null);
    exporting = false;
    releaseDustStrip();
    $('export').disabled = $('exportIG').disabled = $('auto').disabled = $('newPhoto').disabled = $('pick').disabled = $('indoor').disabled = $('rotL').disabled = $('rotR').disabled = false;
    try {
      if (gpu) {   // back to the preview frame
        if (photo.preview.raw) uploadRaw(sf, photo.preview.raw);
        else uploadFrame(photo.preview.data, photo.preview.w, photo.preview.h);
      }
    } catch (e) { log('preview re-upload failed: ' + (e?.stack || e)); }
    if (engine) syncEngine(ui());   // back to preview params
    if (dirty) render();   // sliders moved during the export
  }
}

// ---------- log panel ----------

// Current session first, then the previous one (where a crash's trail ends).
const fullLog = () => `── sessione attuale ──\n${logText() || '(vuoto)'}\n\n── sessione precedente ──\n${prevLogText() || '(vuoto)'}`;
function openLog(title) {
  $('logTitle').textContent = title;
  $('logText').textContent = fullLog();
  $('logPanel').style.display = 'flex';
}
// The status line opens the log; a message shown with an action (status(msg, 'reload'): a waiting update, a broken GPU, a
// failed boot) reloads instead, until the next message replaces it. One action per tap; never during an export.
const reloadNow = () => { if (!exporting) freshReload(); };
$('status').addEventListener('click', () => { if ($('status').dataset.action === 'reload') reloadNow(); else openLog('Log'); });
$('logClose').addEventListener('click', () => { $('logPanel').style.display = 'none'; });
$('logCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(fullLog()); $('logCopy').textContent = 'Copiato ✓'; } catch { $('logCopy').textContent = 'Seleziona il testo'; }
});

// ---------- wiring ----------

function status(msg, action = '') { const el = $('status'); el.textContent = msg; el.dataset.action = action; }

const sign = (v) => (v > 0 ? '+' : '');
const pct = (v) => `${Math.round(v * 100)}`;
const mult = (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`);
const mult2 = (v) => (v === 0 ? 'off' : `${v.toFixed(2)}×`);
const pctOff = (v) => (v === 0 ? 'off' : pct(v));
const signPct = (v) => `${sign(v)}${pct(v)}`;
const FORMAT = {
  ev: (v) => `${sign(v)}${v.toFixed(1)}`,
  contrast: signPct, highlight: signPct, whites: signPct,
  mshift: (v) => `${sign(v)}${v}`, yshift: (v) => `${sign(v)}${v}`, vibrance: (v) => (v === 0 ? 'off' : `${v}`), temp: (v) => `${LIGHT_REF - v} K`,
  grain: mult2, halation: mult,
  ca: pctOff, vignette: pctOff,
  falloff: pct,
  texture: signPct, clarity: signPct, sharp: signPct, dust: pctOff, frame: (v) => FRAME_NAMES[FRAME_STYLES[v]], black: pctOff, htHi: (v) => HYPER_NAMES[v], htLo: (v) => HYPER_NAMES[v], hypersharp: pctOff,
  labD: (v) => `${sign(v)}${v}`, labGrad: (v) => GRAD_NAMES[v + 3], labHi: (v) => TONE_NAMES[v + 1], labLo: (v) => TONE_NAMES[v + 1],
  labSat: (v) => `${sign(v)}${v}`, labBright: (v) => `${sign(v)}${v}`, nbBright: (v) => `${sign(v)}${v}`,
};
const DUST_RESEED = 0.27;   // Rimescola with Polvere off turns it on at this amount (the default before v3.33)
const AUTO_EV_MIN = -2, AUTO_EV_MAX = 2.5;   // Auto's exposure range, see autoSetup
// Double tap on a slider's thumb (or its label): back to 0 / off, whatever its default (like Azzera impostazioni for one slider).
// A tap is a short press that barely moves; the two taps must both land on the thumb, so a double tap on the track never resets.
function onThumbDoubleTap(input, fn) {
  let down = null, last = null;
  const nearThumb = (x) => {
    const r = input.getBoundingClientRect(), t = 20;   // native thumb ~16-20 px
    const f = (+input.value - +input.min) / (+input.max - +input.min);
    return Math.abs(x - (r.left + t / 2 + f * (r.width - t))) <= 22;
  };
  input.addEventListener('pointerdown', (e) => { down = nearThumb(e.clientX) ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null; });
  input.addEventListener('pointerup', (e) => {
    const tap = down && e.timeStamp - down.t < 300 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
    down = null;
    if (!tap) { last = null; return; }
    if (last && e.timeStamp - last < 400) { last = null; fn(); } else last = e.timeStamp;
  });
  input.addEventListener('pointercancel', () => { down = null; last = null; });
}
/** The v4 grain for the chosen scanner: Scanner 'Nessuno' (a neutral read, no lab machine) has no lab scanner noise. Checked on
 * the gold200 dataset (eval/gold200: the real negatives' narrowband raw scans at full resolution, 11.6 um/px, inverted as
 * invert.js does, vs the app's export of the same scenes' digital frames, flat patches by tone): grain std 2.3 / 7.9 / 7.7 /
 * 5.6 / 8.0 / 7.8 vs the real 1.9 / 5.5 / 5.8 / 5.1 / 6.4 / 7.8 (shadows to whites), clumps r50 8.3-11.7 vs 6.5-9.0 um.
 * (A synthetic export of six flat patches showed its lights x2: the inversion's anchors stretch such a narrow frame.) */
const v4Grain = () => (neutralScan() ? { ...V4_GRAIN, scan_noise: 0 } : V4_GRAIN);
const OVERLAY_ONLY = new Set(['dust', 'frame']);   // drawn as layers: no engine render
function syncOutputs() { for (const id of Object.keys(FORMAT)) $(id).nextElementSibling.textContent = FORMAT[id](+$(id).value); }

for (const id of Object.keys(FORMAT)) {
  const update = () => {
    syncOutputs();
    if (!OVERLAY_ONLY.has(id)) { render(); return; }
    drawOverlays();
    if (id === 'frame' && viewport.isFitted()) fitToScreen();   // the frame changes the fitted size
  };
  $(id).addEventListener('input', () => { if (!OVERLAY_ONLY.has(id)) sliderInput(id); update(); });
  const zero = () => { $(id).value = 0; update(); };
  $(id).previousElementSibling.addEventListener('dblclick', zero);
  onThumbDoubleTap($(id), zero);
}
for (const id of ['borderPct', 'borderColor']) $(id).addEventListener('input', () => { drawOverlays(); if (viewport.isFitted()) fitToScreen(); });
$('reseed').addEventListener('click', () => {
  if (!photo) return;
  photo.dustSeed = newDustSeed();
  if (!dustAmount()) { $('dust').value = DUST_RESEED; syncOutputs(); }
  drawOverlays();
});
$('pick').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadPhoto(f); });
// Drag & drop a photo anywhere on the page (desktop): same path as Scegli foto. Only file drags are taken.
{
  const isFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  addEventListener('dragenter', (e) => { if (!isFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dropping'); });
  addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('dragleave', (e) => { if (!isFiles(e)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); depth = 0; document.body.classList.remove('dropping');
    const f = e.dataTransfer.files[0];
    if (f) loadPhoto(f);
  });
}
$('newPhoto').addEventListener('click', () => $('pick').click());
$('auto').addEventListener('click', () => runAuto().catch((e) => { log('auto error: ' + (e?.stack || e)); status('Errore: ' + (e?.message || e)); }));
let internoBusy = 0;
$('indoor').addEventListener('change', async () => {
  if (!photo) return;
  internoBusy++;
  const target = photo;
  let on;
  try {
    while (rendering || exporting) await sleep(20);
    if (photo !== target) return;   // a new photo arrived during the wait: it reset the switch, nothing to apply
    on = $('indoor').checked;   // the lab re-reads the (thin) negative; sliders are not touched
    prepareScanner();
  } catch (e) {   // the switch goes back to what is applied
    log('interno error: ' + (e?.stack || e)); status('Errore: ' + (e?.message || e));
    $('indoor').checked = !on;
  } finally { internoBusy--; }
  render();
});
// Azzera impostazioni (File): every slider to its zero / off position, whatever its default (Qualità JPEG, the switches, rotation
// and the photo's Auto stay as they are).
$('resetAll').addEventListener('click', () => {
  const ids = [...Object.keys(FORMAT), ...(V3 ? ['hlc', 'shadows'] : [])];
  for (const id of ids) $(id).value = 0;
  if (V4) {   // v4: the exposure is the phone's (no Luce tab to bring it back), grain and halation the film's
    if (photo) $('ev').value = photo.autoEv;
    for (const [id, v] of Object.entries(V4_FILM)) $(id).value = v;
  }
  syncOutputs();
  if (V3) for (const id of ['hlc', 'shadows']) $(id).dispatchEvent(new Event('input'));
  resetTransform();
  if (photo) { drawOverlays(); render(); }
});
$('export').addEventListener('click', () => exportFull());
// UI 2 (lib/ui2.js): the edit state it snapshots for undo / redo is every slider, the scanner, Raddrizza and the crop; a tool
// resets to what Azzera impostazioni gives it (the photo's exposure, the film's grain / halation, else 0).
const UI2_IDS = () => [...Object.keys(FORMAT)];
if (V4) {
  $('resetAll').insertAdjacentHTML('afterend', `<button class="btn ghost wide" id="ui2toggle">${UI2 ? 'Interfaccia classica' : 'Nuova interfaccia'}</button>`);
  $('ui2toggle').addEventListener('click', () => { store.set('fcf_ui2', UI2 ? '0' : null); location.reload(); });
}
if (UI2) {
  ui2 = initUI2({
    baseOf: sliderBase, renderDefault,
    snapshot: () => ({ v: Object.fromEntries(UI2_IDS().map((id) => [id, $(id).value])), tilt: $('tilt').value, ...cropUI.state(), scanner, rot: photo?.rot ?? 0 }),
    restore: async (st) => {
      // the 90° turn first (it turns the crop with it), then the crop as it was in that turn
      const q = photo ? (st.rot - photo.rot + 4) & 3 : 0;
      if (q) await rotate(q === 3 ? -1 : q);
      for (const [id, v] of Object.entries(st.v)) $(id).value = v;
      syncOutputs();
      $('tilt').value = st.tilt; tiltDial.sync();
      cropUI.restore(st);
      if (st.scanner !== scanner) setScanner(st.scanner); else if (photo) { drawOverlays(); render(); }
    },
    openTab: (t) => document.querySelector(`#tabs [data-tab="${t}"]`)?.click(),
    rotate: (q) => rotate(q),
    exportFull: (ig) => exportFull(ig),
  });
}
$('exportIG').addEventListener('click', () => exportFull(true));
$('border').checked = store.get('fcf_border') !== '0';   // on by default
$('border').addEventListener('change', () => store.set('fcf_border', $('border').checked ? '1' : '0'));
syncOutputs();

// Build stamp: replaced at deploy (scripts/stamp-version.sh) with the version and
// its time; it lives in app.js itself, so a stale cached app.js shows a stale stamp.
const BUILD = '__BUILD__';
$('ver').textContent = (BUILD.startsWith('__') ? 'dev' : BUILD) + (V4 ? ' · v4' : V3 ? '' : ' · modalità v2');
if (V3) {
  // a switch to compare with/without the dodging (Alte luci / Bianchi / Nero stay)
  $('indoor').closest('.row').insertAdjacentHTML('beforebegin',
    '<div class="row toggle"><label for="v3dodge">Luci auto (v3)</label><input type="checkbox" id="v3dodge" role="switch" checked></div>');
  $('v3dodge').addEventListener('change', () => render());
  $('contrast').closest('.row').insertAdjacentHTML('afterend',
    '<div class="row"><label for="hlc">Contrasto luci</label><input type="range" id="hlc" min="-1" max="1" step="0.01" value="0"><output for="hlc"></output></div>');
  $('hlc').closest('.row').insertAdjacentHTML('afterend',
    '<div class="row"><label for="shadows">Ombre</label><input type="range" id="shadows" min="-1" max="1" step="0.01" value="0"><output for="shadows"></output></div>');
  for (const [id, fmt] of [['hlc', signPct], ['shadows', signPct]]) {
    const out = () => { $(id).nextElementSibling.textContent = fmt(+$(id).value); };
    $(id).addEventListener('input', () => { out(); render(); });
    const zero = () => { $(id).value = 0; out(); render(); };
    $(id).previousElementSibling.addEventListener('dblclick', zero);
    onThumbDoubleTap($(id), zero);
    out();
  }
}

const crashed = takeCrashMarker();
if (crashed) openLog(`La sessione precedente si è interrotta durante: ${crashed}. Copia il log e mandamelo.`);
log(`boot ${BUILD} ${navigator.userAgent}`);

// Update check: the deploy writes version.txt (commit id). index.html is cached (GitHub Pages ~10 min, and an iOS
// home-screen app stays in memory), so at start and whenever the app comes back to the foreground we read
// version.txt past every cache; on a new deploy we reload (without a photo open) or offer a tap to update.
const BUILD_ID = '__BUILD_ID__';
let updating = false;
addEventListener('pagehide', () => { if (updating) setBusy(null); });
async function freshReload() {
  updating = true;   // the busy marker is cleared on pagehide: a reload in the middle of a render or a decode is not a crash
  try { await fetch('index.html', { cache: 'reload' }); } catch { /* offline: plain reload */ }
  location.reload();
}
async function checkUpdate() {
  if (BUILD_ID.startsWith('__') || updating) return;
  try {
    const r = await fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const id = (await r.text()).trim();
    if (!id || id === BUILD_ID) return;
    log(`update available ${BUILD_ID} -> ${id}`);
    // one automatic reload per new id: the CDN may still serve the old index.html for a few minutes (no loop)
    let tried = null; try { tried = sessionStorage.getItem('fcf_reload_for'); } catch { /* storage blocked */ }
    if (!photo && !loadingPhoto && !exporting && tried !== id) {   // not while the first photo decodes
      try { sessionStorage.setItem('fcf_reload_for', id); } catch { /* storage blocked */ }
      return freshReload();
    }
    offerUpdate();
  } catch { /* offline */ }
}
// The status line says so until the next message replaces it; the version label keeps the offer (tap to update).
function offerUpdate() {
  status('Nuova versione disponibile — tocca qui per aggiornare', 'reload');
  const v = $('ver');
  if (v.classList.contains('update')) return;
  v.classList.add('update'); v.textContent += ' · aggiorna ↻'; v.addEventListener('click', reloadNow);
}
attachTips();   // after every row exists (the v3 rows above included)
// Offline (sw.js): only the deployed app registers it (a local / headless run keeps the plain network). persist() asks the
// browser not to evict the cached app under storage pressure (granted or not is the browser's call; logged).
if ('serviceWorker' in navigator && !BUILD_ID.startsWith('__')) {
  navigator.serviceWorker.register('sw.js').catch((e) => log('sw: ' + (e?.message || e)));
  navigator.storage?.persist?.().then((ok) => log(`storage persist: ${ok}`), () => {});
}
checkUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
addEventListener('pageshow', (e) => { if (e.persisted) checkUpdate(); });

// A photo picked or dropped while the engine still downloads waits for it (loadPhoto): decoding before the boot took the
// CPU path for a GPU device and left the GPU frame unset.
let engineReady = false, bootError = '';
const booted = bootEngine().then(async (ok) => {
  gpu = ok; engineReady = true;
  log(`engine ready, gpu=${gpu}`);
  status(gpu ? 'Pronto. Scegli una foto.' : 'WebGPU non disponibile: userò la CPU (lento).');
}).catch((e) => { log('boot error: ' + (e?.stack || e)); bootError = 'Errore avvio: ' + (e?.message || e) + ' — tocca qui per ricaricare'; status(bootError, 'reload'); });
