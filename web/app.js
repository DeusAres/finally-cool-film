import { sf, bootEngine, FILM, PAPER, BASE_PARAMS, deepMerge, inputParams, decodeRGBA, turnRGBA, forEachStrip, extractLinear, jpegThumb, THUMB_PX, PACK_LUT } from './lib/common.js';
import { sleep, store, stripRows, PREVIEW_LONG_SIDE, PREVIEW_KPX, FRAME_UM } from './lib/util.js';
import { DISPLAY_GAIN_LUT } from './lib/color.js';
import { log, logText, prevLogText, setBusy, takeCrashMarker } from './lib/debuglog.js';
import { readExifSegment, patchExif, insertExif } from './lib/exif.js';
import { isRaw, loadRaw, uploadRaw, rawThumb, rawPreviewRGBA, withRotation } from './lib/raw.js';
import { internoParams } from './lib/interno.js';
import { invertAnchors, invertUniform, invertCPU } from './lib/invert.js';
import { iccSegment } from './lib/icc.js';
import { extractLens, lensGeometry, lensActive } from './lib/lens.js';
import { INPUT_WGSL, INPUT_WGSL_V3, inputUniform } from './lib/lens-gpu.js';
import { dodgeBase, dodgeParams, dodgeArray, dodgeCPU } from './lib/dodge.js';
import { LUMA, XYZ_TO_RGB } from './lib/color.js';
import { downscale, sharpenForScreen, fitInside } from './lib/igout.js';
import { dustField, drawDust, compositeDust } from './lib/dust.js';
import { OUTPUT_WGSL, packParams, toSpaceCPU } from './lib/output.js';
import { tiltMap, tiltRGBA } from './lib/tilt.js';
import { tiltRuler } from './lib/ruler.js';
import { hyperToneMap } from './lib/hypertone.js';

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
const JPEG_QUALITY_DEFAULT = 90;   // export slider default: jpegli quality 90 = distance 1.0 (visually lossless), the pre-v3.15 fixed setting
/** jpegli's quality -> butteraugli distance (jpegli_quality_to_distance): 90 -> 1.0, 100 -> 0.1 (largest files). */
const jpegDistance = (q) => (q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25);
const PROGRESSIVE_PIXEL_LIMIT = 6e6; // progressive keeps all DCT coeffs in the wasm heap (~29 B/px): baseline above
const BORDER_FRACTION = 0.01;     // mat (the image's paper white), fraction of the long side; normal export: thicker across the short side so the aspect is kept
/** Base mat width near `b` (±3 px, closest first) whose scaled side b·k is closest to a whole number (k = long / short side). */
const matBase = (b, k) => [0, -1, 1, -2, 2, -3, 3].map((d) => Math.max(1, b + d))
  .reduce((best, c) => (Math.abs(c * k - Math.round(c * k)) < Math.abs(best * k - Math.round(best * k)) - 1e-9 ? c : best));

const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view'), tiltGrid = $('tiltGrid');
const ctx = view.getContext('2d', { colorSpace: 'display-p3' });

let gpu = false;
let engine = null;          // sf.Engine for the current photo (its input colour space is fixed at construction)
let engineParams = '';      // JSON last given to `engine.update` (re-sending it is a no-op)
// v3 (default; index.html?v2 = the previous app): Luce has Esposizione, Contrasto, Contrasto luci,
// automatic highlight dodging (lib/dodge.js, eval/V3.md) and the free contrast curve.
const V3 = !new URLSearchParams(location.search).has('v2');
// v4 (index.html?v4, in progress, eval/V4.md): what the DNG impresses on Gold 200, shown with a neutral inversion of the negative
// (lib/invert.js), no scanner look and no Luce tab: exposure is the phone's (metered as v3 Auto).
const V4 = V3 && new URLSearchParams(location.search).has('v4');
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
  ...(V3 ? { hlc: +$('hlc').value, shadows: +$('shadows').value, v3dodge: $('v3dodge').checked } : {}),   // v3: snapshotted with the rest (export tiles)
});
// CA slider is quadratic: realistic (subtle) amounts get most of the travel.
const lensOf = (u) => ({ ca: u.ca * u.ca, vignette: u.vignette, falloff: u.falloff });

// Magenta ↔ Verde / Giallo ↔ Blu: Frontier C/M/Y keys are 0.01 density each (eval/frontier_model.json user_controls); since v3.34
// one slider step is half a key (a whole key per step was too strong), so ±30 reaches ±15 keys.
const FRONTIER_KEY = 0.005;
// v2-calib: sign of frontier.cmy (+ = more filtration, i.e. the opposite colour); the sliders read +m greener, +y bluer.
const frontierCmy = (u) => [0, -u.mshift * FRONTIER_KEY, -u.yshift * FRONTIER_KEY];

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
const wholeFrame = (region) => ({
  origin_px: region ? [region.x0, region.y0] : [0, 0], frame_px: region ? [region.W, region.H] : [photo.preview.w, photo.preview.h],
});
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
    io: { output_color_space: engineWide() ? 'ITU-R BT.2020' : 'sRGB', output_gamut_compress: { algorithm: 'off' }, scan_film: true },
    // The engine's scanner unsharp mask works in pixels (0.7 px: crisper at
    // preview size than on a 12 MP export) and inflated pixel-level detail
    // ×1.3–1.6 (measured): a phone's crunch, not film. Texture comes from the
    // film-adjacency clarity in the input pass instead (lens-gpu.js), in µm.
    // v4 Scanner 'Nessuno': no scanner look, the engine returns the negative read in three narrow bands (engine narrowband.rs:
    // the bands of the real Gold 200 reference scans, eval/V4.md), inverted in the output pass (lib/invert.js).
    scanner: neutralScan() ? { model: 'narrowband', unsharp_mask: [0, 0], hyper_tone: { highlights: 0, shadows: 0 } } : {
      model: 'frontier', black_correction: false, white_correction: false,
      // always sent: the engine merges updates; the Noritsu has none (they are the Frontier's)
      ...(scanner === 'noritsu' ? { hyper_tone: { highlights: 0, shadows: 0 }, unsharp_mask: [0, 0] }
        : { hyper_tone: { highlights: hyperLevel(u.htHi), shadows: hyperLevel(u.htLo), ...wholeFrame(region) }, ...hyperSharp(u, region) }),
      frontier: {
        // v3.20: Alte luci / Bianchi below 0 darken the scene before the film (dodge.js, local, the negative keeps the detail); above 0 they
        // stay on the scanner curve (gentler than pushing the scene into the shoulder). v2 page: scanner only.
        cmy: frontierCmy(u), contrast: u.contrast, highlight: V3 ? Math.max(u.highlight, 0) : u.highlight, whites: V3 ? Math.max(u.whites, 0) : u.whites, black_lift: u.black,
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
                 black_point: 0.012, gradation_a: 6.2, setup_toe_slope: interno() ? [1.4, 0.92] : [0.9, 1.0], setup_neutral_ev: interno() ? 2.0 : 1.5, auto: { k_col: 0.3, ...(V4 ? { neutral_sigma: V4_NEUTRAL_SIGMA, ...(scanner === 'noritsu' ? V4_NORITSU_AUTO : V4_AUTO) } : {}) },
                 ...(V4 ? (scanner === 'noritsu' ? V4_NORITSU : V4_FRONTIER) : {}) },
      },
    },
    film_render: {
      // Grain is the engine's (rng 'hash': a pure function of seed + frame position, see eval/GRAIN.md).
      // Grana 1× = the old 0.25× (user-preferred); amount 1 = the calibrated Gold 200 grain (GRAIN_UNIT scales between them).
      grain: {
        active: !noGrain && u.grain > 0, rng: 'hash', blur: GRAIN_BLUR, amount: u.grain * GRAIN_UNIT * grainFactor(), seed: photo.grainSeed,
        origin_px: region ? [region.x0, region.y0] : [0, 0], frame_px: region ? [region.fw, region.fh] : [photo.preview.w, photo.preview.h],
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
function syncEngine(u, { noGrain = false, tileMm = 0, region = null } = {}) {
  if (!engine) {
    engine = new sf.Engine(FILM, PAPER, JSON.stringify(deepMerge(BASE_PARAMS, inputParams(photo.preview.p3), V4 ? V4_STOCK : {})));
    engineParams = '';
  }
  const json = renderParamsJson(u, noGrain, tileMm, region);
  if (json !== engineParams) { engine.update(json); engineParams = json; }
  syncHyperMap(u);
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

/** 8-bit render of a region of `frame` into `target` (RGBA, w×h×4 bytes). */
async function renderRegion(frame, x0, y0, w, h, target, u) {
  const lens = lensOf(u), expo = sceneGain(u);
  if (gpu) {
    const space = frame.raw ? 'rec2020' : frame.p3 ? 'p3' : 'srgb', wb = sceneWb(undefined, space === 'srgb' ? 'srgb' : 'rec2020', u.temp);
    return engine.process_frame(DODGE ? INPUT_WGSL_V3 : INPUT_WGSL, inputUniform(frame.w, frame.h, space, x0, y0, w, h, 1, lens, expo, u.clarity, u.texture, wb, u.sharp, u.vibrance / 100, !!interno(), u.tilt),
      DODGE ? v3Gain(u, space) : DISPLAY_GAIN_LUT, w, h, PACK_LUT,
      OUTPUT_WGSL, packParams(packTo(), invUniform(u)), target);
  }
  const map = tiltMap(frame.w, frame.h, u.tilt);   // Raddrizza (tilt.js); null at 0
  const rgb = lensActive(lens) || map
    ? extractLens(frame.data, frame.w, frame.h, frame.p3, x0, y0, w, h, expo, lensGeometry(frame.w, frame.h, lens), true, map)
    : extractLinear(frame.data, frame.w, frame.p3, x0, y0, w, h, expo, true);
  if (u.temp) {   // Temperatura luce (the GPU applies it as the input pass's wb gains)
    const g = lightGains(u.temp, frame.p3 ? 'rec2020' : 'srgb');
    for (let i = 0; i < rgb.length; i += 3) { rgb[i] *= g[0]; rgb[i + 1] *= g[1]; rgb[i + 2] *= g[2]; }
  }
  if (DODGE) dodgeCPU(rgb, w, h, x0, y0, frame.w, frame.h, expo, v3Gain(u, frame.p3 ? 'p3' : 'srgb'), DISPLAY_GAIN_LUT.length, LUMA[frame.p3 ? 'rec2020' : 'srgb'], map);
  const out = engine.process(rgb, w, h), d32 = new Uint32Array(target.buffer, target.byteOffset, w * h);
  const px = new Float32Array(3), to = packTo(), inv = invUniform(u);
  for (let p = 0, j = 0; p < w * h; p++, j += 3) {
    px[0] = out[j]; px[1] = out[j + 1]; px[2] = out[j + 2];
    if (inv) invertCPU(px, inv);   // v4: negative -> positive, as the GPU output pass
    if (to) toSpaceCPU(px, to);   // Rec.2020 → output space, as the GPU output pass
    d32[p] = (q8(px[0]) | (q8(px[1]) << 8) | (q8(px[2]) << 16) | 0xff000000) >>> 0;
  }
}
/** v3: DISPLAY_GAIN_LUT + the dodging header and base map (base: once per photo, from the AutoSetup thumbnail). */
function v3Gain(u, space) {
  if (!photo.dodge) {
    const raw = photo.preview.raw, { rgb, w, h } = raw ? rawThumb(raw, THUMB_PX) : jpegThumb(photo.preview);
    photo.dodge = dodgeBase(rgb, w, h, LUMA[space === 'p3' ? 'rec2020' : space]);   // a P3 JPEG's thumb is Rec.2020 (extractLinear)
    log(`v3 dodge base ${w}x${h} median ${photo.dodge.M.toFixed(2)} p99 ${photo.dodge.P.toFixed(2)}`);
  }
  return dodgeArray(DISPLAY_GAIN_LUT, photo.dodge, { ...dodgeParams(photo.dodge, u.contrast, u.ev - (photo.autoEv ?? u.ev)), dodge: u.v3dodge }, u.hlc, u.shadows, Math.min(u.highlight, 0), Math.min(u.whites, 0));
}
const q8 = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));

// ---------- auto ----------
// Auto = the engine's own exposure metering on a thumb of the photo (Esposizione), then the
// scanner's AutoSetup on that thumb as the film will see it (frontier.auto).
// Auto exposure = engine meter on the thumb, clamped to the Esposizione slider range. AutoSetup is a function of (Interno on/off, the exposure it ran at):
// cached per photo, never touches the sliders, so toggling Interno off restores the exact previous result.

function autoSetup(on, evIn = null) {
  const eng = syncEngine(ui()), { preview } = photo, raw = preview.raw;   // a fresh engine has the library defaults (camera auto-exposure on, no scanner model)
  const { rgb, w, h } = raw ? rawThumb(raw, THUMB_PX) : jpegThumb(preview);
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

// Hyper Tone (Scanner, Frontier): a recovery for the extremes (user), with the machine's separate Highlight and Shadow levels,
// 5 steps each (SP-3000: Lower, Low, Normal, High, Higher; 0 here = off). Each level moves an area's density by level / 5 x
// HYPER_MAX of its map EV beyond the mids' dead zone (lib/hypertone.js DEAD_EV), engine params.rs HyperToneParams. Fujifilm
// publishes no gains: HYPER_MAX 0.5 (the top level) is a choice; with the dead zone the mids are untouched (the first version
// flattened whole photos, user), so at the top a shadow 3 EV under mid grey is lifted 1 EV and a sky 3 EV over brought down 1.
const HYPER_MAX = 0.5, HYPER_LEVELS = 5;
const hyperLevel = (v) => (v / HYPER_LEVELS) * HYPER_MAX;
const HYPER_NAMES = ['off', 'molto basso', 'basso', 'normale', 'alto', 'molto alto'];
const HYPER_THUMB_PX = 512;   // the map's source thumb: its resolution is the map's (lib/hypertone.js MAP_LONG)
// Hyper Sharpness (Scanner, Frontier; slider 0 = off): the engine's unsharp mask on the scan, gated by relative detail
// (ScannerParams.unsharp_threshold) so the grain is left alone and only structure is sharpened (the real machine's version
// fried the grain). Radius HS_UM on the film: about one Frontier scanner pixel (36 mm / ~3000 px; a choice). Amount at the
// slider's top HS_MAX (a choice). Gate t0 / t1 measured at the preview pitch on the v4 Frontier rock (grain 3.1x): relative
// detail at HS_UM in flat sky (grain) p99 0.032, on rock structure p50 0.085; scaled with the pixel pitch as Nitidezza's
// (finer export pixels carry stronger per-pixel grain).
const HS_UM = 12, HS_MAX = 1.0, HS_T0 = 0.03, HS_T1 = 0.08;
function hyperSharp(u, region) {
  if (!(u.hypersharp > 0)) return { unsharp_mask: [0, 0] };
  const [W, H] = wholeFrame(region).frame_px, kpx = Math.max(W, H) / FRAME_UM, gate = Math.max(kpx / PREVIEW_KPX, 0.5);
  return { unsharp_mask: [HS_UM * kpx, u.hypersharp * HS_MAX], unsharp_threshold: [HS_T0 * gate, HS_T1 * gate] };
}

/** The photo's Hyper Tone map in the engine (built once per photo and turn, from its thumb at HYPER_THUMB_PX, lib/hypertone.js),
 * when Hyper Tone acts. */
function syncHyperMap(u) {
  if (!((u.htHi > 0 || u.htLo > 0) && scanner === 'frontier')) return;
  if (!photo.hyper) {
    const { preview } = photo, raw = preview.raw, { rgb, w, h } = raw ? rawThumb(raw, HYPER_THUMB_PX) : jpegThumb(preview, HYPER_THUMB_PX);
    // the thumb as the film sees it (Auto's exposure + baseline: v4 has no exposure slider, so it is fixed per photo)
    photo.hyper = hyperToneMap(rgb, w, h, LUMA[raw || preview.p3 ? 'rec2020' : 'srgb'], 2 ** (photo.autoEv + baselineEv()));   // a P3 JPEG's thumb is Rec.2020 (extractLinear)
    log(`hyper tone map ${photo.hyper.w}x${photo.hyper.h}`);
  }
  if (engine.hyperFor !== photo.hyper) {
    engine.set_hyper_tone_map(photo.hyper.map, photo.hyper.w, photo.hyper.h);
    engine.hyperFor = photo.hyper;
  }
}

/** v4: the inversion anchors of this frame (lib/invert.js), from the engine's negative scan of the metered thumb (no grain,
 * lens, dodge or Temperatura: the frame's own range, the sliders act on top). */
function v4Anchors(ev) {
  const { preview } = photo, raw = preview.raw;
  const { rgb, w, h } = raw ? rawThumb(raw, THUMB_PX) : jpegThumb(preview);
  const g = 2 ** (ev + baselineEv());
  for (let i = 0; i < rgb.length; i++) rgb[i] *= g;
  return invertAnchors(syncEngine(ui(), { noGrain: true }).process(rgb, w, h));
}
const invUniform = (u) => (neutralScan() ? invertUniform(photo.inv, u.mshift, u.yshift) : null);

// ---------- preview ----------

async function render() {
  if (!photo) return;
  if (rendering || exporting) { dirty = true; return; }   // export: re-rendered when it ends
  rendering = true;
  try {
    do {
      dirty = false;
      const u = ui();
      const pv = photo.preview, t0 = performance.now(), n = ++renderCount;
      // Breadcrumb: if iOS kills the tab mid-render, the next load says so.
      setBusy(`anteprima #${n} ${pv.w}x${pv.h} ${JSON.stringify(u)}`);
      syncEngine(u, { region: { x0: 0, y0: 0, fw: pv.w, fh: pv.h, W: pv.w, H: pv.h } });
      const cs = outSpace() === 'p3' ? 'display-p3' : 'srgb';
      if (photo.after?.width !== pv.w || photo.after?.height !== pv.h || photo.after.colorSpace !== cs) photo.after = new ImageData(pv.w, pv.h, { colorSpace: cs });
      await renderRegion(pv, 0, 0, pv.w, pv.h, new Uint8Array(photo.after.data.buffer), u);
      const t1 = performance.now();
      if (!showingBefore) { ctx.putImageData(photo.after, 0, 0); drawHistogram(photo.after); }
      const t2 = performance.now(), ms = (v) => Math.round(v);
      status(`${pv.w}×${pv.h} · ${ms(t2 - t0)} ms (render ${ms(t1 - t0)} · display ${ms(t2 - t1)})${gpu ? '' : ' CPU'}`);
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

// ---------- histogram (overlay, top left) ----------
// RGB + luminance of what is on screen, from the 8-bit display pixels (every
// other pixel in both directions is plenty). Square-root scale against the
// tallest bin that is not a clipped end: a dark or sky-heavy frame keeps a
// readable shape instead of one spike and a flat line.
const histo = $('histo'), hctx = histo.getContext('2d');
const HBINS = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
function drawHistogram(img) {
  const bins = HBINS;
  for (const b of bins) b.fill(0);
  const { data, width, height } = img;
  for (let y = 0; y < height; y += 2) {
    for (let i = y * width * 4, end = i + width * 4; i < end; i += 8) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      bins[0][r]++; bins[1][g]++; bins[2][b]++;
      bins[3][(r * 54 + g * 183 + b * 19) >> 8]++;
    }
  }
  let max = 1;
  for (const h of bins) for (let v = 1; v < 255; v++) max = Math.max(max, h[v]);
  max = Math.sqrt(max);
  const W = histo.width, H = histo.height;
  hctx.clearRect(0, 0, W, H);
  const area = (h, style, op) => {
    hctx.globalCompositeOperation = op;
    hctx.fillStyle = style;
    hctx.beginPath(); hctx.moveTo(0, H);
    for (let v = 0; v < 256; v++) hctx.lineTo(v * W / 255, H - Math.min(1, Math.sqrt(h[v]) / max) * (H - 2));
    hctx.lineTo(W, H); hctx.closePath(); hctx.fill();
  };
  area(bins[3], 'rgba(200,200,200,0.35)', 'source-over');
  area(bins[0], 'rgba(255,60,60,0.55)', 'lighter');
  area(bins[1], 'rgba(60,255,60,0.55)', 'lighter');
  area(bins[2], 'rgba(70,110,255,0.6)', 'lighter');
  hctx.globalCompositeOperation = 'source-over';
  histo.style.display = 'block';
}

// ---------- dust & scratches (separate layer, dust.js) ----------
// Drawn over the preview by the compositor and into the export strips; never
// touches the engine render, so moving the slider or reseeding is instant.

const dustLayer = $('dustLayer'), dctx = dustLayer.getContext('2d');
const dustAmount = () => +$('dust').value;
function dustMarks() {
  const { w, h } = photo.preview, key = `${photo.dustSeed}|${w}x${h}`;
  if (photo.dustKey !== key) { photo.dust = dustField(photo.dustSeed, Math.max(w, h) / Math.min(w, h)); photo.dustKey = key; }
  return photo.dust;
}
function drawDustLayer() {
  if (!photo) return;
  const { w, h } = photo.preview;
  if (dustLayer.width !== w || dustLayer.height !== h) {
    dustLayer.width = w; dustLayer.height = h;
    dustLayer.style.width = w + 'px'; dustLayer.style.height = h + 'px';
  }
  dctx.clearRect(0, 0, w, h);
  const a = dustAmount();
  dustLayer.style.display = a > 0 && !showingBefore ? 'block' : 'none';
  if (a > 0) drawDust(dctx, dustMarks(), a, w, h);
}
const newDustSeed = () => (Math.random() * 2 ** 32) >>> 0;
// Grain is the film's own: the same photo gets the same grain on every load
// and every export (FNV-1a of name, size, date).
const fileSeed = (f) => { let h = 2166136261; for (const ch of `${f.name}|${f.size}|${f.lastModified}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

/** Composite dust marks at amount `a` into an RGB strip (rows y0.. of a w×h export). */
function dustIntoStrip(strip, w, h, y0, rows, a, marks) {
  if (!a) return;
  const c = dustStripCanvas || (dustStripCanvas = document.createElement('canvas'));
  if (c.width !== w || c.height !== rows) { c.width = w; c.height = rows; }   // resizing clears
  const x = c.getContext('2d', { willReadFrequently: true });
  x.clearRect(0, 0, w, rows);
  drawDust(x, marks, a, w, h, 0, y0);
  compositeDust(strip, x.getImageData(0, 0, w, rows).data);
}
let dustStripCanvas = null;

let showingBefore = false;
/** The 'before' view (A/B, a fresh preview): the source as decoded, turned and cropped like the render when Raddrizza is set. */
function beforeImage() {
  const pv = photo.preview, deg = +$('tilt').value;
  if (!deg) return pv.before;
  if (photo.beforeTilt?.pv !== pv || photo.beforeTilt.deg !== deg) {
    photo.beforeTilt = { pv, deg, img: new ImageData(tiltRGBA(pv.before.data, pv.w, pv.h, deg), pv.w, pv.h, pv.p3 ? { colorSpace: 'display-p3' } : undefined) };
  }
  return photo.beforeTilt.img;
}
function showBefore(on) {
  if (!photo?.after) return;
  if (on === showingBefore) return;
  showingBefore = on;
  drawDustLayer();
  const img = on ? beforeImage() : photo.after;
  ctx.putImageData(img, 0, 0);
  drawHistogram(img);
  $('badge').style.display = on ? 'block' : 'none';
}
const compare = $('compare');
compare.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); showBefore(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) compare.addEventListener(ev, () => showBefore(false));
compare.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- zoom & pan (CSS transform; canvas stays centred in the stage) ----------

const MIN_ZOOM = 0.05, MAX_ZOOM = 6;
let zoom = 1, panX = 0, panY = 0, fitted = true;

function applyTransform() {
  view.style.transform = dustLayer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  if (tiltGrid && !tiltGrid.hidden) placeGrid();
  // 100% = one image pixel per device pixel.
  $('zoomLabel').textContent = photo ? `${Math.round(zoom * devicePixelRatio * 100)}%` : '';
}

function fitToScreen() {
  if (!photo) return;
  const r = stage.getBoundingClientRect(), pad = 8;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((r.width - pad * 2) / view.width, (r.height - pad * 2) / view.height)));
  panX = panY = 0; fitted = true;
  applyTransform();
}

// Zoom keeping the viewport point (clientX, clientY) fixed; default: stage centre.
function setZoom(z, clientX, clientY) {
  if (!photo) return;
  z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  const r = stage.getBoundingClientRect();
  const cx = (clientX ?? r.left + r.width / 2) - r.left - r.width / 2;
  const cy = (clientY ?? r.top + r.height / 2) - r.top - r.height / 2;
  const px = (cx - panX) / zoom, py = (cy - panY) / zoom;
  zoom = z; panX = cx - px * zoom; panY = cy - py * zoom; fitted = false;
  applyTransform();
}

stage.addEventListener('wheel', (e) => { if (!photo) return; e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }, { passive: false });

let dragging = false, lastX = 0, lastY = 0, pinchDist = 0, pinchZoom = 1, lastTap = 0;
const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
stage.addEventListener('touchstart', (e) => {
  if (!photo || e.target.closest('.overlay')) return;
  if (e.touches.length === 1) {
    dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    // Double tap: toggle fit ↔ 100% at the tapped point.
    const now = performance.now();
    if (now - lastTap < 300) { fitted ? setZoom(1 / devicePixelRatio, lastX, lastY) : fitToScreen(); lastTap = 0; }
    else lastTap = now;
  } else if (e.touches.length === 2) {
    dragging = false; pinchDist = dist(e.touches[0], e.touches[1]); pinchZoom = zoom;
  }
}, { passive: true });
stage.addEventListener('touchmove', (e) => {
  if (!photo) return;
  if (e.touches.length === 1 && dragging) {
    e.preventDefault();
    const t = e.touches[0];
    panX += t.clientX - lastX; panY += t.clientY - lastY; lastX = t.clientX; lastY = t.clientY; fitted = false;
    applyTransform();
  } else if (e.touches.length === 2) {
    e.preventDefault();
    const [a, b] = e.touches;
    setZoom(pinchZoom * dist(a, b) / pinchDist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  }
}, { passive: false });
stage.addEventListener('touchend', (e) => { if (e.touches.length === 0) dragging = false; });
stage.addEventListener('mousedown', (e) => { if (!photo || e.target.closest('.overlay')) return; dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mousemove', (e) => {
  if (!dragging || e.buttons === 0) return;
  panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; fitted = false;
  applyTransform();
});
window.addEventListener('mouseup', () => { dragging = false; });
stage.addEventListener('dblclick', (e) => { if (photo) fitted ? setZoom(1 / devicePixelRatio, e.clientX, e.clientY) : fitToScreen(); });
$('fit').addEventListener('click', fitToScreen);
// The stage also changes size when the slider panel is resized.
new ResizeObserver(() => { if (fitted) fitToScreen(); }).observe(stage);

// ---------- resizable slider panel ----------
// Drag the grip to trade photo area for sliders; the height is remembered.
const controls = $('controls'), grip = $('grip');
const PANEL_MIN = 0, PANEL_MAX_VH = 0.6;
const setPanel = (px) => {
  const h = Math.round(Math.max(PANEL_MIN, Math.min(innerHeight * PANEL_MAX_VH, px)));
  controls.style.height = h + 'px';
  return h;
};
const applySavedPanel = () => { const saved = +store.get('fcf_panel'); if (saved > 0) setPanel(saved); };
applySavedPanel();
// Desktop / tablet landscape (same query as the CSS): sidebar layout, no grip, the CSS ignores the inline height.
// Back to the bottom sheet: re-apply the saved height, clamped to the current window.
const desk = matchMedia('(orientation: landscape) and (min-width: 900px) and (min-height: 500px)');
desk.addEventListener('change', () => { if (!desk.matches) applySavedPanel(); });
let gripY = 0, gripH = 0;
grip.addEventListener('pointerdown', (e) => {
  gripY = e.clientY; gripH = controls.getBoundingClientRect().height;
  grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
});
grip.addEventListener('pointermove', (e) => { if (grip.hasPointerCapture(e.pointerId)) setPanel(gripH + gripY - e.clientY); });
const endGrip = (e) => {
  if (!grip.hasPointerCapture?.(e.pointerId)) return;
  grip.releasePointerCapture(e.pointerId); grip.classList.remove('drag');
  store.set('fcf_panel', String(Math.max(1, Math.round(controls.getBoundingClientRect().height))));   // never '0': a collapsed panel must read back as saved
};
grip.addEventListener('pointerup', endGrip);
grip.addEventListener('pointercancel', endGrip);
// Double tap the grip: collapse ↔ default.
grip.addEventListener('dblclick', () => {
  const h = controls.getBoundingClientRect().height;
  const next = h > 8 ? setPanel(0) : setPanel(innerHeight * 0.18);
  store.set('fcf_panel', String(next || 1));
});

// Bottom tab bar: one section of sliders at a time; tapping while collapsed expands the sheet.
// v4: the film alone. Pre-film modifiers that are not the film (Texture, the lens) start at 0, the user can still add them;
// grain and halation are the film's own and start (and reset, Azzera) at its values: Grana at the measured Gold 200 strength
// (the v3 default 2.5× is ~80 % of the full-frame Gold scans, README v3.32), Halation at the stock's antihalation (1).
const V4_FILM = { grain: 3.1, halation: 1 };
if (V4) {
  document.querySelector('#tabs [data-tab="light"]').remove();   // v4: the light is the phone's exposure
  // Magenta ↔ Verde / Giallo ↔ Blu are the scanner's colour keys (the inversion's, or the Frontier's cmy): in the Scanner tab
  for (const id of ['mshift', 'yshift']) document.querySelector('[data-pane="scanner"]').append($(id).closest('.row'));
  for (const id of ['texture', 'ca', 'vignette', 'falloff']) $(id).value = 0;
  for (const [id, v] of Object.entries(V4_FILM)) $(id).value = v;
}
{
  const tabBtns = [...document.querySelectorAll('#tabs button')], panes = [...document.querySelectorAll('.pane')];
  const showTab = (t) => {
    tabBtns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    panes.forEach((p) => { p.hidden = p.dataset.pane !== t; });
    controls.scrollTop = 0;
  };
  const savedTab = store.get('fcf_tab');
  if (tabBtns.some((b) => b.dataset.tab === savedTab)) showTab(savedTab);
  tabBtns.forEach((b) => b.addEventListener('click', () => {
    showTab(b.dataset.tab); store.set('fcf_tab', b.dataset.tab);
    if (!desk.matches && controls.getBoundingClientRect().height <= 8) store.set('fcf_panel', String(setPanel(innerHeight * 0.18) || 1));
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
      const t = performance.now(), raw = await loadRaw(file, PREVIEW_LONG_SIDE, 0, { signal: abort.signal });
      while (rendering || exporting) await sleep(20);
      if (my !== loadSeq) return;
      const preview = { data: rawPreviewRGBA(raw), w: raw.w, h: raw.h, p3: true, raw };
      preview.before = new ImageData(preview.data, preview.w, preview.h, { colorSpace: 'display-p3' });
      log(`raw ${raw.fullW}x${raw.fullH}, preview ${raw.w}x${raw.h}, orientation ${raw.orientation}, baseline ${raw.baseline} EV, ${Math.round(performance.now() - t)} ms (${raw.decodedIn})`);
      $('indoor').checked = false; rotPending = 0; resetTilt();
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
      $('indoor').checked = false; rotPending = 0; resetTilt();
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
  $('exportIG').hidden = $('newPhoto').hidden = false;
}

/** Canvas, dust layer, 'before' image and fit for the current photo.preview (new photo or a turn). */
function showPreview() {
  const { preview } = photo;
  view.width = preview.w; view.height = preview.h;
  view.style.width = preview.w + 'px'; view.style.height = preview.h + 'px';
  view.style.display = 'block'; $('empty').style.display = 'none'; $('tools').hidden = false;
  drawDustLayer();
  const before = beforeImage();
  ctx.putImageData(before, 0, 0);
  drawHistogram(before);
  fitToScreen();
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
      let preview;
      if (photo.preview.raw) {
        const raw = withRotation(photo.preview.raw, rot);
        preview = { data: rawPreviewRGBA(raw), w: raw.w, h: raw.h, p3: true, raw };
        preview.before = new ImageData(preview.data, preview.w, preview.h, { colorSpace: 'display-p3' });
        uploadRaw(sf, raw);
      } else {
        // the preview's own pixels turned (exact copy, no await: an export cannot start in between)
        const pv = photo.preview, t = turnRGBA(pv.data, pv.w, pv.h, q);
        preview = { data: t.data, w: t.w, h: t.h, p3: pv.p3 };
        preview.before = new ImageData(preview.data, preview.w, preview.h, preview.p3 ? { colorSpace: 'display-p3' } : undefined);
        if (gpu) uploadFrame(preview.data, preview.w, preview.h);
      }
      Object.assign(photo, { rot, preview, dodge: null, hyper: null });   // dodging base, Hyper Tone map: rebuilt from the turned thumb
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
$('rotL').addEventListener('click', () => rotate(-1));
// Export JPEG quality (File tab): only read by exportFull, never re-renders. Double tap the label: back to the default.
{
  const q = $('quality'), out = () => { q.nextElementSibling.textContent = `${q.value}%`; };
  q.addEventListener('input', out);
  q.previousElementSibling.addEventListener('dblclick', () => { q.value = JPEG_QUALITY_DEFAULT; out(); });
  out();
}
$('rotR').addEventListener('click', () => rotate(1));

// ---------- transform: Raddrizza (tilt) ----------
// Tape-measure dial (lib/ruler.js) over the hidden #tilt range input: the angle goes into the input pass (lib/tilt.js) of the
// preview and the export. It is relative to the displayed frame, so it stays across the quarter turns (rotations about the same
// centre commute); a new photo and Azzera impostazioni set it to 0. While it is dragged, a thirds grid lies over the photo.
function placeGrid() {
  const s = stage.getBoundingClientRect(), v = view.getBoundingClientRect();
  Object.assign(tiltGrid.style, { left: `${v.left - s.left}px`, top: `${v.top - s.top}px`, width: `${v.width}px`, height: `${v.height}px` });
}
let gridOn = false;
const tiltDial = tiltRuler($('tiltRuler'), $('tilt'), $('tiltOut'), {
  onDrag: (on) => {
    gridOn = on && !!photo;
    if (gridOn) { tiltGrid.hidden = false; placeGrid(); requestAnimationFrame(() => tiltGrid.classList.toggle('on', gridOn)); }
    else tiltGrid.classList.remove('on');
  },
});
tiltGrid.addEventListener('transitionend', () => { if (!gridOn) tiltGrid.hidden = true; });
$('tilt').addEventListener('input', () => { if (photo) render(); });
$('tiltLabel').addEventListener('dblclick', () => tiltDial.set(0));
/** Back to 0 without a render (new photo: its own first render follows). */
function resetTilt() { $('tilt').value = 0; tiltDial.sync(); }

async function runAuto() {
  // render() returns early while another render / export is in flight: wait first (the engine is shared).
  while (rendering || exporting) await sleep(20);
  const on = $('indoor').checked, a = autoSetup(on);
  photo.autoEv = a.ev; photo.autoCache = a.auto ? { [autoKey(on)]: a.auto } : {}; photo.inv = null;
  $('ev').value = a.ev;
  syncOutputs();
  log(`auto: ev ${a.ev}`);
  prepareScanner();
  await render();
}

/** What the current scanner needs for this photo, measured once at the photo's auto exposure: the neutral inversion's anchors,
 * or the Frontier's AutoSetup (per Interno state). */
function prepareScanner() {
  if (neutralScan()) {
    if (photo.inv) return;
    photo.inv = v4Anchors(photo.autoEv);
    const f = (v) => v.map((x) => x.toFixed(2)).join('/');
    log(`scanner none: density black ${f(photo.inv.lo)} white ${f(photo.inv.hi)} mid ${photo.inv.xm.toFixed(2)}`);
  } else {
    const on = $('indoor').checked;
    photo.auto = photo.autoCache[autoKey(on)] ??= autoSetup(on, photo.autoEv).auto;
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
const autoKey = (on) => `${scanner}:${on}`;   // AutoSetup depends on the scanner and on Interno
async function setScanner(s) {
  scanner = s; store.set('fcf_scanner', s);
  for (const b of document.querySelectorAll('[data-scanner]')) b.setAttribute('aria-checked', String(b.dataset.scanner === s));
  $('frontierRows').hidden = scanner !== 'frontier';   // Hyper Tone / Hyper Sharpness are the Frontier's
  if (!photo || loadingPhoto) return;   // a photo still loading measures for this scanner in its own runAuto
  internoBusy++;   // an export waits for the switch (same guard as Interno)
  try {
    while (rendering || exporting) await sleep(20);   // the engine is shared
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
// is streamed to jpegli in a worker and dropped. Neither the full float image
// nor the full RGB image ever exists (in JS, wasm or on the GPU).
// Each tile keeps the frame's physical pixel size (film_format_mm scaled to the
// tile) and the same engine parameters as the preview, with an overlap margin cropped away.

// The jpegli worker. A worker whose script or wasm failed to load never answers, and an export would wait on it for ever: it
// posts 'ready' once jpegli is up and an export waits for that (ENCODER_READY_MS: generous, jpegli's ~200 KB wasm compiles
// in well under a second; unmeasured on device). After an error, and after every export, the worker is replaced: its wasm heap never
// shrinks and would keep the export's peak (hundreds of MB at 12 MP) for the whole session.
const ENCODER_READY_MS = 20000;
let encoder = null, encoderReady = null, encoderError = null, encoderDone = null;
function startEncoder() {
  encoder?.terminate();
  const w = encoder = new Worker('export-worker.js');
  let ready;
  encoderReady = new Promise((r) => { ready = r; });
  w.onmessage = ({ data }) => {
    if (data.cmd === 'ready') ready(true);
    else if (data.cmd === 'error') { encoderError = data.error; log('jpegli error: ' + data.error); encoderDone?.reject(new Error(data.error)); if (encoder === w) { w.terminate(); encoder = null; } }
    else if (data.cmd === 'done') { log(`jpegli done ${data.width}x${data.height}, heap ${data.heapMB} MB`); encoderDone?.resolve(data); }
  };
  w.onerror = (e) => {
    encoderError = e.message || 'worker error'; log('jpegli worker error: ' + encoderError);
    encoderDone?.reject(new Error(encoderError));
    if (encoder === w) { w.terminate(); encoder = null; }   // the next export starts a fresh one
  };
}
startEncoder();
/** The encoder, up and answering, or an error after ENCODER_READY_MS (the worker is then replaced). */
async function encoderUp() {
  if (!encoder) startEncoder();
  if (await Promise.race([encoderReady, sleep(ENCODER_READY_MS).then(() => false)])) return;
  startEncoder();
  throw new Error('encoder JPEG non disponibile, riprova');
}

// iOS Safari fetches a download's blob only after the user confirms the sheet,
// which can take any time: keep the URL until the next export (or a minute).
let lastDownloadUrl = null;
function download(blob, name) {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = lastDownloadUrl = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { if (lastDownloadUrl === url) { URL.revokeObjectURL(url); lastDownloadUrl = null; } }, 60000);
}

// The mat is the image's own paper white, not pure 255: what the scanner renders for a
// saturated neutral (far above scene white), in output code values. Read from the engine on a flat patch.
const MAT_PATCH = 8, MAT_SCENE = 64;
function paperWhite(u) {
  const out = syncEngine(u, { noGrain: true }).process(new Float32Array(MAT_PATCH * MAT_PATCH * 3).fill(MAT_SCENE), MAT_PATCH, MAT_PATCH);
  const px = Float32Array.from(out.subarray(0, 3)), inv = invUniform(u);
  if (inv) invertCPU(px, inv);
  if (packTo()) toSpaceCPU(px, packTo());
  return Array.from(px, q8);
}

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
    const u = ui(), dust = dustAmount(), marks = dustMarks();   // fixed for every strip
    const t0 = performance.now();
    const rawPv = photo.preview.raw, size = photo.size;
    const rot = photo.rot || 0, turned = rot & 1;
    const fw = rawPv ? rawPv.fullW : turned ? size.h : size.w, fh = rawPv ? rawPv.fullH : turned ? size.w : size.h;
    const bFrac = $('border').checked ? BORDER_FRACTION : 0;
    // IG: the posted image (iw × ih) fits inside the canvas with a bFrac mat; the film renders at IG_SUPER × that.
    const igFit = ig ? fitInside(fw, fh, IG_W, IG_H, Math.round(bFrac * IG_H)) : null;
    const scale = ig ? Math.min(1, IG_SUPER * Math.max(igFit.iw, igFit.ih) / Math.max(fw, fh))
      : Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (fw * fh)));
    if (ig) forceSRGB = true;
    const longCap = Math.round(Math.max(fw, fh) * scale);
    encoderError = null;   // from here, any error of this export's worker fails it (also one during the decode below)
    await encoderUp();   // before the decode: a dead encoder fails the export at once
    enc = encoder;       // this export's worker (encoder may be replaced by an error mid-way)
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
    const { w, h, p3 } = frame;
    const progressive = w * h > PROGRESSIVE_PIXEL_LIMIT ? 0 : 2;
    // v3.36: the mat keeps the photo's aspect (a 3:4 photo exports at exactly 3:4): bFrac of the long side on the long edges,
    // scaled by long / short across the short ones (portrait 2736x3648: 36 px left / right, 48 px top / bottom -> 2808x3744).
    // The base width moves by up to ±3 px to the value that makes the thick side a whole number (3:4 -> a multiple of 3: exact).
    const border = bFrac && !ig ? matBase(Math.round(Math.max(w, h) * bFrac), Math.max(w, h) / Math.min(w, h)) : 0;
    const borderX = w <= h ? border : Math.round(border * w / h), borderY = w <= h ? Math.round(border * h / w) : border;
    log(`export start ${w}x${h} p3=${p3} progressive=${progressive} border=${borderX}x${borderY}`);

    const longSide = Math.max(w, h);
    const strips = Math.ceil(h / EXPORT_TILE), cols = Math.ceil(w / EXPORT_TILE);

    let tileBuf = null;   // reused across tiles
    if (encoderError || encoder !== enc) throw new Error(encoderError || 'encoder JPEG terminato');
    const done = new Promise((resolve, reject) => { encoderDone = { resolve, reject }; });
    done.catch(() => {});
    const quality = +$('quality').value, distance = jpegDistance(quality);
    log(`export quality ${quality} (distance ${distance.toFixed(2)})`);
    const igFull = ig ? new Uint8Array(w * h * 3) : null;   // IG: the whole supersampled render, downscaled at the end
    if (!ig) enc.postMessage({ cmd: 'start', width: w, height: h, distance, progressive, yuv444: 1, border: borderX, borderY, mat: border ? paperWhite(u) : undefined });

    for (let s = 0; s < strips; s++) {
      const ty = s * EXPORT_TILE, ch = Math.min(EXPORT_TILE, h - ty);
      const strip = new Uint8Array(w * ch * 3);
      for (let c = 0; c < cols; c++) {
        if (encoderError) throw new Error(encoderError);
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
          let src = (ty - y0 + y) * tw + (tx - x0), dst = (y * w + tx) * 3;
          for (let x = 0; x < cw; x++) { const v = t32[src++]; strip[dst] = v; strip[dst + 1] = v >> 8; strip[dst + 2] = v >> 16; dst += 3; }
        }
      }
      dustIntoStrip(strip, w, h, ty, ch, dust, marks);
      if (ig) { igFull.set(strip, ty * w * 3); continue; }
      enc.postMessage({ cmd: 'rows', rgb: strip.buffer }, [strip.buffer]);
      log(`strip ${s + 1}/${strips} sent`);
    }
    if (ig) {
      status('Esporto IG: ridimensiono e rendo nitido…');
      const { iw, ih } = igFit, small = downscale(igFull, w, h, iw, ih);
      sharpenForScreen(small, iw, ih);
      const canvas = new Uint8Array(IG_W * IG_H * 3), matRGB = paperWhite(u);
      for (let i = 0; i < IG_W * IG_H * 3; i += 3) canvas.set(matRGB, i);
      const ox = (IG_W - iw) >> 1, oy = (IG_H - ih) >> 1;
      for (let y = 0; y < ih; y++) canvas.set(small.subarray(y * iw * 3, (y + 1) * iw * 3), ((oy + y) * IG_W + ox) * 3);
      log(`IG ${w}x${h} -> ${iw}x${ih} on ${IG_W}x${IG_H}`);
      enc.postMessage({ cmd: 'start', width: IG_W, height: IG_H, distance, progressive: 2, yuv444: 1, border: 0 });
      for (let y = 0; y < IG_H; y += 256) {
        const rows = canvas.slice(y * IG_W * 3, Math.min(IG_H, y + 256) * IG_W * 3);
        enc.postMessage({ cmd: 'rows', rgb: rows.buffer }, [rows.buffer]);
      }
    }
    status('Esporto: JPEG (jpegli)…');
    enc.postMessage({ cmd: 'finish' });
    const result = await done;
    let bytes = result.jpeg;
    bytes = insertExif(bytes, iccSegment(outSpace()));   // segments go right after SOI, JFIF dropped; Exif is inserted last so it ends up first
    try {
      const seg = await readExifSegment(photo.file);
      if (seg) { bytes = insertExif(bytes, patchExif(seg, result.width, result.height, outSpace() === 'p3')); log(`EXIF carried over (${seg.length} B)`); }
    } catch (e) { log('EXIF skipped: ' + (e?.message || e)); }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const base = (photo.file.name || 'foto').replace(/\.[^.]+$/, '');
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`export done ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    status(`Esportata: ${result.width}×${result.height}, ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    download(blob, `${base}_gold200${ig ? '_ig' : ''}${border || (ig && bFrac) ? '_bordo' : ''}.jpg`);
  } catch (e) {
    enc?.postMessage({ cmd: 'abort' });
    log('export error: ' + (e?.stack || e));
    status('Export fallito: ' + (e?.message || e) + ' (tocca qui per il log)');
  } finally {
    forceSRGB = false;
    startEncoder();   // a fresh worker: the old one's wasm heap kept this export's peak
    setBusy(null);
    exporting = false;
    if (dustStripCanvas) { dustStripCanvas.width = dustStripCanvas.height = 0; dustStripCanvas = null; }   // release the backing store
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
  texture: signPct, clarity: signPct, sharp: signPct, dust: pctOff, black: pctOff, htHi: (v) => HYPER_NAMES[v], htLo: (v) => HYPER_NAMES[v], hypersharp: pctOff,
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
// v4 DIR couplers (film stage): inter-image inhibition, same layer and between layers, 0.6 / 0.6 -> 1.0 / 1.0. Measured against
// real Gold 200 (eval/gold200, eval/V4.md): the film's chroma on the same registered pixels, 0.84 / 0.88 -> 0.91 / 0.97 of the
// film's; 1.2 overshoots the film's strongest colours. The old values had no Gold data behind them (eval/calib/CALIB.md).
// First calibration step, to be refined as more references come in. v3 keeps the engine's defaults (its look was tuned on them).
const V4_DIR = { inhibition_samelayer: 1.0, inhibition_interlayer: 1.0 };
// v4 film layer speeds (engine FilmRenderingParams.layer_speed_ev, a calibration input: set when the engine is built). Real Gold
// 200 (eval/gold200, two scenes, each at the film exposure that best explains its negative: -0.5 / -2 EV) has its red layer
// relatively faster than the datasheet curves: red +0.75 EV takes the mids' green / cool cast down (mean |a*| over tones
// 8.6 -> 4.2, hue error +14 / +8 -> +7 / +2 deg); +1 EV does slightly better in the shadows but turns the lights red (a* +5.9).
// Second calibration step; to refine with more references.
const V4_STOCK = { film_render: { layer_speed_ev: [0.75, 0, 0] } };
// v4 Frontier AutoSetup reads the colour from near-neutral pixels (engine FrontierAutoParams.neutral_sigma, density): a frame
// filled by one colour no longer pulls it towards grey (the Frontier's "subject failure"). Measured (sf-eval, v4 Frontier):
// green park ORF Y key -0.065 -> -0.018 (its grey path no longer pink), tungsten cat C +0.035 -> +0.024 (a real cast still read),
// neutral frames within 0.01. 0.03 / 0.1 bracket it (-0.014 / -0.023 on the park); 0.06 is the middle, a choice.
const V4_NEUTRAL_SIGMA = 0.06;
// v4 Frontier AutoSetup, from the real Frontier's Gold 200 frames with charts (eval/frontier_cp; their Lightroom export has every
// setting at 0, so brightness and casts are the lab's). Density: over -1..+2 EV the real machine keeps the chart's mid grey within
// 2.4 L* (full compensation): strength 1.0 (v3 0.85 drifted ~+11 L*). The level stays v3's (target_offset 0.0109): on scenes
// reconstructed from the real scans (recon.py) the lab's mid grey is 67 / 80 / 53 (grey wall / black studio / outdoors), ours
// 58 / 86 / 59; v3.47's draft target 0.16 matched the grey wall only (75 / 86 / 76: outdoor photos came out washed, user).
// Colour: k_col x strength 0.68 (v3 0.3 x 0.85). The tungsten frame keeps b* +12 / +25 / +14 over daylight (dark / mid /
// light greys) and takes the red out (a* -4); ours at v3's 0.26 kept +29 / +35 / +26 and a* +9 under a simulated 3200 K;
// 0.6 / 0.85 leave +24 / +24 / +12 and +19 / +18 / +6: 0.68 matches the mean. The light's temperature is not known (3200 K
// assumed): warmer light would mean an even stronger correction, so this is a lower bound.
const V4_AUTO = { strength: 1.0, k_col: 0.68 };
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
// 3.9 / 4.1 at -1 / +1 / +2 EV; chroma 1.06 and lightness +0.1 L* of the real. Left: the cyan hue ~18 deg greener than real.
const V4_FRONTIER = { gradation_a: 9.6, black_point: 0.023, white_point: 0.97, shoulder_start: 0.95, shoulder_sharpness: 0,
  saturation: 0.92, saturation_blue: 0.05, blue_hue_shift: 18, green_hue_shift: 20,
  hue_lightness: [0.91, 0.92, 0.46, 0.75, 0.9, 0.96], hue_saturation: [0.88, 1.06, 0.97, 1.04, 0.73, 0.64], hue_shift: [3, 1, 6, 7, -5, 12] };
// v4 Noritsu (Scanner tab): the Frontier's scanner model with a Noritsu's tone, colour and AutoSetup, fitted as V4_FRONTIER on the
// same Color Precision Gold 200 frames scanned on their Noritsu (eval/frontier_cp). It overrides every v3 Gold-look op (none of
// them is the Noritsu's). Tone: a 9.26, black 0.025, white 1.0 (opener whites than the Frontier's 0.97), grey L* rms 1.25.
// Colour: per-hue lightness / saturation / rotation (6 knots, proto_all.py then the engine): dE00 6.4-6.7 -> 4.3-4.5 over
// -1..+2 EV, chroma 1.06 of the real. Balance: the Noritsu's greys are warm in the shadows / mids, neutral in the lights (mid b*
// +13 on the chart frame, +7 outdoors, against the Frontier's +4.5 / +2): C M Y +0.02 / +0.05 / +0.075 over the Frontier's
// balance, the mean of the chart-frame fit (0.03 / 0.068 / 0.103) and the outdoor frame's about half of it.
const V4_NORITSU = { gradation_a: 9.26, black_point: 0.025, white_point: 1.0, shoulder_start: 0.95, shoulder_sharpness: 0,
  saturation: 1.0, saturation_blue: 0, blue_hue_shift: 0, green_hue_shift: 0, saturation_warm: 0, warm_hue_shift: 0,
  cool_neutral_warm: 0, highlight_neutral: 0, balance_cmy: [0.02, 0.055, 0.095],
  hue_shift: [2, -4.8, 3.1, 1.8, 1.6, 30.8], hue_lightness: [1.16, 0.99, 0.69, 0.86, 0.91, 0.94], hue_saturation: [0.84, 0.94, 0.96, 0.91, 0.62, 0.87] };
// Noritsu AutoSetup. Unlike the Frontier it barely lifts a dark frame (chart on black: mid grey 67 vs 70 on the grey wall, the
// Frontier 80 / 67) while compensating exposure fully: a highlight-anchored setup. The engine's highlight guard (95th percentile
// kept below the knee + margin) does that: margin -0.08 with the mean's target 0.15 gives, on scenes rebuilt from the real
// Noritsu scans (recon.py / autorecon.py), wall / black / outdoors 68.7 / 58.7 / 57.9 (real 69.7 / 66.9 / 54.0; the v3 setup
// 58.8 / 83.8 / 59.5). Colour: the tungsten frame keeps b* -3 / +7 / +5 (dark / mid / light) over daylight, much less than
// the Frontier: k_col 1.15 (1.0 / 1.3 leave +11 / +9 / +7 and +3 / -5 / -5), clamp_colour 0.3 (0.15 bound it).
const V4_NORITSU_AUTO = { strength: 1.0, target_offset: 0.15, highlight_margin: -0.08, k_col: 1.15, clamp_colour: 0.3 };
const SCATTER_SCALE = 0.5;   // film scatter size multiplier (engine default 1), see renderParams
// v3.32: dye-cloud blur 0.65 -> 0.45 (reference px, ~12 -> ~8 um): measured on 10 full-frame Gold 200 scans the grain has ~12 % of
// its power below 40 um wavelength and r50 ~13.5 um; ours had 3 % / 18.6 um (soft). At 0.45
// (with the engine's variance-matched kernel, filming.rs): 12 % / 14.8 um, and the preview matches the export seen at its size.
const GRAIN_BLUR = 0.45;
const GRAIN_UNIT = 0.65;   // slider 1× -> engine amount (= old slider 0.25 / old default 0.4)
const OVERLAY_ONLY = new Set(['dust']);   // drawn as a layer: no engine render
function syncOutputs() { for (const id of Object.keys(FORMAT)) $(id).nextElementSibling.textContent = FORMAT[id](+$(id).value); }

for (const id of Object.keys(FORMAT)) {
  const update = () => { syncOutputs(); if (OVERLAY_ONLY.has(id)) drawDustLayer(); else render(); };
  $(id).addEventListener('input', update);
  const zero = () => { $(id).value = 0; update(); };
  $(id).previousElementSibling.addEventListener('dblclick', zero);
  onThumbDoubleTap($(id), zero);
}
$('reseed').addEventListener('click', () => {
  if (!photo) return;
  photo.dustSeed = newDustSeed();
  if (!dustAmount()) { $('dust').value = DUST_RESEED; syncOutputs(); }
  drawDustLayer();
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
    photo.auto = photo.autoCache[autoKey(on)] ??= autoSetup(on, photo.autoEv).auto;
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
  resetTilt();
  if (photo) { drawDustLayer(); render(); }
});
$('export').addEventListener('click', () => exportFull());
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
