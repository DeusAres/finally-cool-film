import { sf, bootEngine, FILM, PAPER, BASE_PARAMS, deepMerge, inputParams, decodeRGBA, extractLinear, to8, clipMask, writeClipAlpha, withAlpha } from './lib/common.js';
import { transferChart, readTransfer, buildTone, autoTone } from './lib/tone.js';
import { LIN8 } from './lib/color.js';
import { log, logText, prevLogText, setBusy, takeCrashMarker } from './lib/debuglog.js';
import { readExifSegment, patchExif, insertExif } from './lib/exif.js';
import { iccSegment } from './lib/icc.js';
import { extractLens, lensGeometry, lensActive } from './lib/lens.js';
import { INPUT_WGSL, inputUniform } from './lib/lens-gpu.js';
import { dustField, drawDust, compositeDust } from './lib/dust.js';
import { GRAIN_WGSL, grainParams, outputColourCPU } from './lib/grain.js';

const PREVIEW_LONG_SIDE = 2000;   // display canvas cap (bigger canvases make iOS compositing crash when zoomed)
const GRAIN_AREA_UM2 = 0.2;       // engine default AgX particle area
const FILM_FORMAT_MM = 35;        // engine default; sets the physical pixel size
const EXPORT_TILE = 1024;         // export tile core size (px)
const EXPORT_PAD = 128;           // tile overlap: covers halation / DIR diffusion reach at 12 MP
const MAX_EXPORT_PIXELS = 12.5e6; // keeps native 12 MP iPhone frames; 48 MP gets downscaled (20 MP crashed the grain exporter)
const JPEG_DISTANCE = 1.0;        // butteraugli distance for jpegli
const PROGRESSIVE_PIXEL_LIMIT = 6e6; // progressive keeps all DCT coeffs in the wasm heap (~29 B/px): baseline above
const BORDER_FRACTION = 0.01;     // white mat, fraction of the long side, all four sides (as in grain pro)

const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view');
const ctx = view.getContext('2d', { colorSpace: 'display-p3' });

let gpu = false;
let engine = null;          // sf.Engine for the current photo + calibration
let engineCalib = '';       // JSON of the calibration params `engine` was built with
let photo = null;           // { file, bitmap, preview, after }
let transfer = null, transferKey = '';   // measured grey transfer of the pipeline (per calibration)
let tone = null, toneKey = '';           // LUTs for the current transfer + look + ev
let rendering = false, dirty = false, exporting = false, renderCount = 0;

// ---------- params ----------

const ui = () => ({
  ev: +$('ev').value, look: +$('look').value, rolloff: +$('rolloff').value,
  mshift: +$('mshift').value, yshift: +$('yshift').value,
  grain: +$('grain').value, halation: +$('halation').value, texture: +$('texture').value,
  ca: +$('ca').value, vignette: +$('vignette').value, falloff: +$('falloff').value,
});
// CA slider is quadratic: realistic (subtle) amounts get most of the travel.
const lensOf = (u) => ({ ca: u.ca * u.ca, vignette: u.vignette, falloff: u.falloff });

// Enlarger filtration is baked in at engine construction (calibration).
const calibParams = (u) => ({ enlarger: { m_filter_shift: u.mshift, y_filter_shift: u.yshift } });

// Everything else is read at render time and goes through `engine.update`.
// Tone is handled by tone.js on the input (scene reconstruction) and output
// (white point), so the engine runs at fixed exposure with no auto-exposure,
// no print-curve morph and no scanner levels: the paper's real black stays.
const outP3 = () => !!photo?.preview.p3;

function renderParams(u, { noGrain = false } = {}) {
  return {
    camera: { auto_exposure: false, film_format_mm: FILM_FORMAT_MM },
    // P3 photos end up in Display P3 (same transfer curve as sRGB, so tones are
    // identical): the engine's sRGB-only gamut compression was squeezing
    // saturated reds / oranges / yellows by ~20% (measured). The engine renders
    // them into Rec.2020 (film colours fit there) and the output pass converts
    // to P3 with a soft gamut compression (grain.js toP3); plain P3 output
    // hard-clipped dark warm browns (B = 0, hue swung red).
    io: outP3() ? { output_color_space: 'ITU-R BT.2020', output_gamut_compress: { algorithm: 'off' } } : { output_color_space: 'sRGB', output_gamut_compress: { algorithm: 'cam16ucs' } },
    // The engine's scanner unsharp mask works in pixels (0.7 px: crisper at
    // preview size than on a 12 MP export) and inflated pixel-level detail
    // ×1.3–1.6 (measured): a phone's crunch, not film. Texture comes from the
    // film-adjacency clarity in the input pass instead (lens-gpu.js), in µm.
    scanner: { black_correction: false, white_correction: false, unsharp_mask: [0, 0] },
    film_render: {
      // On the GPU path grain is ours (grain.js, in the output pass); the engine's is the CPU fallback.
      grain: { active: !gpu && !noGrain && u.grain > 0, agx_particle_area_um2: GRAIN_AREA_UM2 * Math.max(u.grain, 0.01) },
      halation: { active: u.halation > 0, halation_amount: u.halation },
      // Viewing glare: same mean (E = percent whatever the roughness), but no
      // random per-pixel field: that field is seeded by the pixel's index in
      // the region, so every export tile drew a different one (measured: the
      // same pixel varied ~0.3 levels between tiles, and seams showed at tile
      // boundaries). Our grain supplies the texture.
      glare: { roughness: 0 },
    },
    print_render: { glare: { roughness: 0 } },
  };
}

function ensureEngine(u) {
  const calib = JSON.stringify(calibParams(u));
  if (engine && calib === engineCalib) return engine;
  engine?.free();
  engine = new sf.Engine(FILM, PAPER, JSON.stringify(deepMerge(BASE_PARAMS, inputParams(photo.preview.p3), calibParams(u))));
  engineCalib = calib;
  return engine;
}

const run = (img) => (gpu ? engine.process_gpu(img.rgb, img.w, img.h) : Promise.resolve(engine.process(img.rgb, img.w, img.h)));

// ---------- tone ----------
// Measure the pipeline's grey transfer once per calibration (one render of a
// 81-patch grey chart), then build the scene-reconstruction / white-point LUTs
// for the current Contrasto (look), Esposizione (midtone ev) and Alte luci (rolloff). See tone.js.

async function ensureTone(u) {
  ensureEngine(u);
  if (transferKey !== engineCalib) {
    const t = performance.now(), chart = transferChart();
    engine.update(JSON.stringify(renderParams(u, { noGrain: true })));
    transfer = readTransfer(await run(chart), chart.w);
    transferKey = engineCalib;
    log(`transfer measured ${Math.round(performance.now() - t)} ms: white Y ${transfer.white.toFixed(3)}, black ${transfer.floor.toFixed(4)}`);
  }
  const key = `${transferKey}|${u.look}|${u.ev}|${u.rolloff}`;
  if (key !== toneKey) { tone = buildTone(transfer, { look: u.look, ev: u.ev, rolloff: u.rolloff }); toneKey = key; }
}

// ---------- lens ----------
// Applied to the light reaching the film (engine input), in frame coordinates.

/** Scene-light engine input for a region of the frame currently loaded in the lens stage. */
// GPU: the whole input stage (lens, tone, matrix) runs inside the engine's
// chain from the frame texture (sf.set_frame), see lens-gpu.js. CPU fallback
// below (no WebGPU): float input built here, float output converted here.

/** 8-bit render of a region of `frame` into `target` (RGBA, w×h×4 bytes). */
async function renderRegion(frame, x0, y0, w, h, target, lens, grain = 0, texture = 0) {
  if (gpu) {
    return engine.process_frame(INPUT_WGSL, inputUniform(frame.w, frame.h, frame.p3, x0, y0, w, h, 1, lens, texture),
      tone.packed, w, h, tone.out8,
      GRAIN_WGSL, grainParams(w, x0, y0, Math.max(frame.w, frame.h), grain, photo.grainSeed, outP3(), tone.out8[0], tone.balance), target);
  }
  const rgb = lensActive(lens)
    ? extractLens(frame.data, frame.w, frame.h, frame.p3, x0, y0, w, h, 1, lensGeometry(frame.w, frame.h, lens), tone)
    : extractLinear(frame.data, frame.w, frame.p3, x0, y0, w, h, 1, tone);
  const out = engine.process(rgb, w, h), d32 = new Uint32Array(target.buffer, target.byteOffset, w * h);
  // Same colour steps as the GPU output pass: grey balance, and Rec.2020 → P3 for P3 photos.
  const px = new Float32Array(3), p3 = outP3();
  for (let p = 0, j = 0; p < w * h; p++, j += 3) {
    px[0] = out[j]; px[1] = out[j + 1]; px[2] = out[j + 2];
    outputColourCPU(px, p3, tone.balance);
    d32[p] = (to8(px[0], tone.out8) | (to8(px[1], tone.out8) << 8) | (to8(px[2], tone.out8) << 16) | 0xff000000) >>> 0;
  }
}

// ---------- auto ----------
// Starting Esposizione / Contrasto from the photo's own luminance (tone.js autoTone).

function autoFromPhoto() {
  const { data, p3 } = photo.preview;
  const [kr, kg, kb] = p3 ? [0.2290, 0.6917, 0.0793] : [0.2126, 0.7152, 0.0722];   // P3 / sRGB luminance
  const Ys = new Float32Array(Math.ceil(data.length / 32));
  for (let i = 0, k = 0; i < data.length; i += 32, k++) Ys[k] = kr * LIN8[data[i]] + kg * LIN8[data[i + 1]] + kb * LIN8[data[i + 2]];
  return autoTone(Ys);
}

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
      await ensureTone(u);
      engine.update(JSON.stringify(renderParams(u)));
      const cs = outP3() ? 'display-p3' : 'srgb';
      if (photo.after?.width !== pv.w || photo.after?.height !== pv.h || photo.after.colorSpace !== cs) photo.after = new ImageData(pv.w, pv.h, { colorSpace: cs });
      await renderRegion(pv, 0, 0, pv.w, pv.h, new Uint8Array(photo.after.data.buffer), lensOf(u), u.grain, u.texture);
      const t1 = performance.now();
      if (!showingBefore) { ctx.putImageData(photo.after, 0, 0); drawHistogram(photo.after); }
      const t2 = performance.now(), ms = (v) => Math.round(v);
      status(`${pv.w}×${pv.h} · ${ms(t2 - t0)} ms (render ${ms(t1 - t0)} · display ${ms(t2 - t1)})${gpu ? '' : ' CPU'}`);
      log(`render #${n} ${ms(t1 - t0)}+${ms(t2 - t1)} ms`);
    } while (dirty && !exporting);
  } catch (e) {
    log('render error: ' + (e?.stack || e));
    status('Errore: ' + (e?.message || e));
  } finally {
    rendering = false;
    if (!exporting) setBusy(null);
  }
}

// ---------- histogram (overlay, top left) ----------
// RGB + luminance of what is on screen, from the 8-bit display pixels (every
// other pixel in both directions is plenty). Square-root scale against the
// tallest bin that is not a clipped end: a dark or sky-heavy frame keeps a
// readable shape instead of one spike and a flat line.
const histo = $('histo'), hctx = histo.getContext('2d');
function drawHistogram(img) {
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
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

/** Composite the dust layer into an RGB strip (rows y0.. of a w×h export). */
function dustIntoStrip(strip, w, h, y0, rows) {
  const a = dustAmount();
  if (!a) return;
  const c = document.createElement('canvas');
  c.width = w; c.height = rows;
  const x = c.getContext('2d', { willReadFrequently: true });
  drawDust(x, dustMarks(), a, w, h, 0, y0);
  compositeDust(strip, x.getImageData(0, 0, w, rows).data);
  c.width = c.height = 0;
}

let showingBefore = false;
function showBefore(on) {
  if (!photo?.after) return;
  showingBefore = on;
  drawDustLayer();
  const img = on ? photo.preview.before : photo.after;
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
window.addEventListener('resize', () => { if (fitted) fitToScreen(); });
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
try { const saved = +localStorage.getItem('fcf_panel'); if (saved > 0) setPanel(saved); } catch {}
let gripY = 0, gripH = 0;
grip.addEventListener('pointerdown', (e) => {
  gripY = e.clientY; gripH = controls.getBoundingClientRect().height;
  grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
});
grip.addEventListener('pointermove', (e) => { if (grip.hasPointerCapture(e.pointerId)) setPanel(gripH + gripY - e.clientY); });
const endGrip = (e) => {
  if (!grip.hasPointerCapture?.(e.pointerId)) return;
  grip.releasePointerCapture(e.pointerId); grip.classList.remove('drag');
  try { localStorage.setItem('fcf_panel', String(Math.round(controls.getBoundingClientRect().height))); } catch {}
};
grip.addEventListener('pointerup', endGrip);
grip.addEventListener('pointercancel', endGrip);
// Double tap the grip: collapse ↔ default.
grip.addEventListener('dblclick', () => {
  const h = controls.getBoundingClientRect().height;
  const next = h > 8 ? setPanel(0) : setPanel(innerHeight * 0.18);
  try { localStorage.setItem('fcf_panel', String(next || 1)); } catch {}
});

// ---------- photo ----------

async function loadPhoto(file) {
  if (!file) return;
  status('Decodifica…');
  try {
    log(`photo: ${file.name} ${file.type} ${(file.size / 1e6).toFixed(1)} MB`);
    const bitmap = await createImageBitmap(file);
    // A render or export in flight still uses the current photo, engine and GPU frame.
    while (rendering || exporting) await new Promise((r) => setTimeout(r, 20));
    const preview = decodeRGBA(bitmap, PREVIEW_LONG_SIDE);
    preview.before = new ImageData(preview.data, preview.w, preview.h, preview.p3 ? { colorSpace: 'display-p3' } : undefined);
    log(`decoded ${bitmap.width}x${bitmap.height}, preview ${preview.w}x${preview.h}, p3=${preview.p3}`);
    photo?.bitmap.close();   // full-resolution decode of the previous photo
    photo = { file, bitmap, preview, dustSeed: newDustSeed(), grainSeed: fileSeed(file) };
    if (gpu) {
      preview.clip = clipMask(bitmap, preview.w, preview.h);   // full-res clipping, see common.js
      sf.set_frame(withAlpha(preview.data, preview.clip), preview.w, preview.h);
    }
    engine?.free(); engine = null;
    view.width = preview.w; view.height = preview.h;
    view.style.width = preview.w + 'px'; view.style.height = preview.h + 'px';
    view.style.display = 'block'; $('empty').style.display = 'none'; $('tools').hidden = false;
    drawDustLayer();
    ctx.putImageData(preview.before, 0, 0);
    drawHistogram(preview.before);
    fitToScreen();
    await runAuto();
    $('export').disabled = false; $('auto').disabled = false; $('newPhoto').hidden = false;
  } catch (e) {
    log('load error: ' + (e?.stack || e));
    status('Errore: ' + (e?.message || e));
  }
}

async function runAuto() {
  const a = autoFromPhoto();
  $('ev').value = a.ev; $('look').value = a.look;
  syncOutputs();
  log(`auto: ev ${a.ev}, look ${a.look}`);
  await render();
}

// ---------- export ----------
// Full resolution rendered in tiles, one strip of tiles at a time; each strip
// is streamed to jpegli in a worker and dropped. Neither the full float image
// nor the full RGB image ever exists (in JS, wasm or on the GPU).
// Each tile keeps the frame's physical pixel size (film_format_mm scaled to the
// tile) and uses the same tone LUTs as the preview, with an overlap margin cropped away.

const encoder = new Worker('export-worker.js');
let encoderError = null, encoderDone = null;
encoder.onmessage = ({ data }) => {
  if (data.cmd === 'error') { encoderError = data.error; log('jpegli error: ' + data.error); encoderDone?.reject(new Error(data.error)); }
  else if (data.cmd === 'done') { log(`jpegli done ${data.width}x${data.height}, heap ${data.heapMB} MB`); encoderDone?.resolve(data); }
};
encoder.onerror = (e) => { encoderError = e.message || 'worker error'; log('jpegli worker error: ' + encoderError); encoderDone?.reject(new Error(encoderError)); };

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportFull() {
  if (!photo || exporting) return;
  exporting = true;
  $('export').disabled = true;
  setBusy('export');
  // A preview render in flight shares the engine and the GPU frame: let it finish first.
  while (rendering) await new Promise((r) => setTimeout(r, 20));
  const u = ui();
  const t0 = performance.now();
  try {
    const { bitmap } = photo;
    const scale = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (bitmap.width * bitmap.height)));
    const longCap = Math.max(bitmap.width, bitmap.height) * scale;
    status('Esporto: decodifica…');
    const { data, w, h, p3 } = decodeRGBA(bitmap, longCap);
    const progressive = w * h > PROGRESSIVE_PIXEL_LIMIT ? 0 : 2;
    const border = $('border').checked ? Math.round(Math.max(w, h) * BORDER_FRACTION) : 0;
    log(`export start ${w}x${h} p3=${p3} progressive=${progressive} border=${border}`);

    await ensureTone(u);
    const frame = { data, w, h, p3 };
    if (gpu) { writeClipAlpha(data); sf.set_frame(data, w, h); }
    const longSide = Math.max(w, h);
    const strips = Math.ceil(h / EXPORT_TILE), cols = Math.ceil(w / EXPORT_TILE);

    let tileBuf = null;   // reused across tiles
    encoderError = null;
    const done = new Promise((resolve, reject) => { encoderDone = { resolve, reject }; });
    done.catch(() => {});
    encoder.postMessage({ cmd: 'start', width: w, height: h, distance: JPEG_DISTANCE, progressive, yuv444: 1, border });

    for (let s = 0; s < strips; s++) {
      const ty = s * EXPORT_TILE, ch = Math.min(EXPORT_TILE, h - ty);
      const strip = new Uint8Array(w * ch * 3);
      for (let c = 0; c < cols; c++) {
        if (encoderError) throw new Error(encoderError);
        const tx = c * EXPORT_TILE;
        status(`Esporto ${w}×${h}: tile ${s * cols + c + 1}/${strips * cols}…`);
        const x0 = Math.max(0, tx - EXPORT_PAD), y0 = Math.max(0, ty - EXPORT_PAD);
        const tw = Math.min(w, tx + EXPORT_TILE + EXPORT_PAD) - x0, th = Math.min(h, ty + EXPORT_TILE + EXPORT_PAD) - y0;
        engine.update(JSON.stringify(deepMerge(renderParams(u), {
          camera: { film_format_mm: FILM_FORMAT_MM * Math.max(tw, th) / longSide },
        })));
        const tile = (tileBuf = tileBuf?.length >= tw * th * 4 ? tileBuf : new Uint8Array(tw * th * 4)).subarray(0, tw * th * 4);
        await renderRegion(frame, x0, y0, tw, th, tile, lensOf(u), u.grain, u.texture);
        const cw = Math.min(EXPORT_TILE, w - tx);
        for (let y = 0; y < ch; y++) {   // RGBA tile → RGB strip
          let src = ((ty - y0 + y) * tw + (tx - x0)) * 4, dst = (y * w + tx) * 3;
          for (let x = 0; x < cw; x++, src += 4) { strip[dst++] = tile[src]; strip[dst++] = tile[src + 1]; strip[dst++] = tile[src + 2]; }
        }
      }
      dustIntoStrip(strip, w, h, ty, ch);
      encoder.postMessage({ cmd: 'rows', rgb: strip.buffer }, [strip.buffer]);
      log(`strip ${s + 1}/${strips} sent`);
    }
    status('Esporto: JPEG (jpegli)…');
    encoder.postMessage({ cmd: 'finish' });
    const result = await done;
    let bytes = result.jpeg;
    if (outP3()) bytes = insertExif(bytes, iccSegment());   // generic segment insert: the JPEG is Display P3
    try {
      const seg = await readExifSegment(photo.file);
      if (seg) { bytes = insertExif(bytes, patchExif(seg, result.width, result.height)); log(`EXIF carried over (${seg.length} B)`); }
    } catch (e) { log('EXIF skipped: ' + (e?.message || e)); }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const base = (photo.file.name || 'foto').replace(/\.[^.]+$/, '');
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`export done ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    status(`Esportata: ${result.width}×${result.height}, ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    download(blob, `${base}_gold200${border ? '_bordo' : ''}.jpg`);
  } catch (e) {
    encoder.postMessage({ cmd: 'abort' });
    log('export error: ' + (e?.stack || e));
    status('Export fallito: ' + (e?.message || e) + ' (tocca qui per il log)');
  } finally {
    setBusy(null);
    exporting = false;
    if (gpu) sf.set_frame(withAlpha(photo.preview.data, photo.preview.clip), photo.preview.w, photo.preview.h);   // back to the preview frame
    $('export').disabled = false;
    engine?.update(JSON.stringify(renderParams(ui())));   // back to preview params
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
$('status').addEventListener('click', () => openLog('Log'));
$('logClose').addEventListener('click', () => { $('logPanel').style.display = 'none'; });
$('logCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(fullLog()); $('logCopy').textContent = 'Copiato ✓'; } catch { $('logCopy').textContent = 'Seleziona il testo'; }
});

// ---------- wiring ----------

function status(msg) { $('status').textContent = msg; }

const FORMAT = {
  ev: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`,
  look: (v) => `${Math.round(v * 100)}`,
  rolloff: (v) => `${Math.round(v * 100)}`,
  mshift: (v) => `${v > 0 ? '+' : ''}${v}`,
  yshift: (v) => `${v > 0 ? '+' : ''}${v}`,
  grain: (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`),
  halation: (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`),
  ca: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}`),
  vignette: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}`),
  falloff: (v) => `${Math.round(v * 100)}`,
  texture: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}`),
  dust: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}`),
};
const DEFAULTS = { ev: 0, look: 0.35, rolloff: 0.6, mshift: 0, yshift: 0, grain: 1, halation: 1, texture: 0.5, ca: 0, vignette: 0, falloff: 0.4, dust: 0 };
const OVERLAY_ONLY = new Set(['dust']);   // drawn as a layer: no engine render
function syncOutputs() { for (const id of Object.keys(FORMAT)) $(id).nextElementSibling.textContent = FORMAT[id](+$(id).value); }

for (const id of Object.keys(FORMAT)) {
  const update = () => { syncOutputs(); if (OVERLAY_ONLY.has(id)) drawDustLayer(); else render(); };
  $(id).addEventListener('input', update);
  // Double-tap the label to reset a slider.
  $(id).previousElementSibling.addEventListener('dblclick', () => { $(id).value = DEFAULTS[id]; update(); });
}
$('reseed').addEventListener('click', () => {
  if (!photo) return;
  photo.dustSeed = newDustSeed();
  if (!dustAmount()) { $('dust').value = 0.5; syncOutputs(); }
  drawDustLayer();
});
$('pick').addEventListener('change', (e) => loadPhoto(e.target.files[0]));
$('newPhoto').addEventListener('click', () => $('pick').click());
$('auto').addEventListener('click', () => runAuto());
$('export').addEventListener('click', exportFull);
try { $('border').checked = localStorage.getItem('fcf_border') === '1'; } catch {}
$('border').addEventListener('change', () => { try { localStorage.setItem('fcf_border', $('border').checked ? '1' : '0'); } catch {} });
syncOutputs();

// Build stamp: replaced at deploy (scripts/stamp-version.sh) with the commit and
// its time; it lives in app.js itself, so a stale cached app.js shows a stale stamp.
const BUILD = '__BUILD__';
$('ver').textContent = BUILD.startsWith('__') ? 'dev' : BUILD;

const crashed = takeCrashMarker();
if (crashed) openLog(`La sessione precedente si è interrotta durante: ${crashed}. Copia il log e mandamelo.`, true);
log(`boot ${BUILD} ${navigator.userAgent}`);

bootEngine().then(async (ok) => {
  gpu = ok;
  log(`engine ready, gpu=${gpu}`);
  status(gpu ? 'Pronto. Scegli una foto.' : 'WebGPU non disponibile: userò la CPU (lento).');
}).catch((e) => { log('boot error: ' + (e?.stack || e)); status('Errore avvio: ' + (e?.message || e)); });
