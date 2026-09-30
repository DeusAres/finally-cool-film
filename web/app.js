import { sf, bootEngine, FILM, PAPER, BASE_PARAMS, deepMerge, inputParams, decodeRGBA, extractLinear, readPixels, toImageData, srgbToLinear } from './lib/common.js';
import { log, logText, clearLog, setBusy, takeCrashMarker } from './lib/debuglog.js';
import { readExifSegment, patchExif, insertExif } from './lib/exif.js';

const PREVIEW_LONG_SIDE = 2000;   // display canvas cap (bigger canvases make iOS compositing crash when zoomed)
const FIT_LONG_SIDE = 256;        // proxy used by the auto-lab fit
const GRAIN_AREA_UM2 = 0.2;       // engine default AgX particle area
const FILM_FORMAT_MM = 35;        // engine default; sets the physical pixel size
const EXPORT_TILE = 1024;         // export tile core size (px)
const EXPORT_PAD = 128;           // tile overlap: covers halation / DIR diffusion reach at 12 MP
const MAX_EXPORT_PIXELS = 12.5e6; // keeps native 12 MP iPhone frames; 48 MP gets downscaled (20 MP crashed the grain exporter)
const JPEG_DISTANCE = 1.0;        // butteraugli distance for jpegli
const PROGRESSIVE_PIXEL_LIMIT = 6e6; // progressive keeps all DCT coeffs in the wasm heap (~29 B/px): baseline above

const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view');
const ctx = view.getContext('2d', { colorSpace: 'display-p3' });

let gpu = false;
let engine = null;          // sf.Engine for the current photo + calibration
let engineCalib = '';       // JSON of the calibration params `engine` was built with
let photo = null;           // { file, bitmap, preview, fit, after }
let auto = { pe: 1, gamma: 1 };
let rendering = false, dirty = false, exporting = false;

// ---------- params ----------

const ui = () => ({
  ev: +$('ev').value, contrast: +$('contrast').value,
  mshift: +$('mshift').value, yshift: +$('yshift').value,
  grain: +$('grain').value, halation: +$('halation').value,
});

// Enlarger filtration is baked in at engine construction (calibration).
const calibParams = (u) => ({ enlarger: { m_filter_shift: u.mshift, y_filter_shift: u.yshift } });

// Everything else is read at render time and goes through `engine.update`.
// Scanner levels map paper black/white to the output range (lab-scan style).
function renderParams(u, { pe, gamma }, { noGrain = false } = {}) {
  return {
    camera: { auto_exposure: true, film_format_mm: FILM_FORMAT_MM },
    scanner: { black_correction: true, white_correction: true },
    enlarger: { print_exposure: pe * 2 ** -u.ev },
    print_render: { density_curves_morph: { active: true, gamma_factor: gamma * 2 ** (u.contrast * 0.5) } },
    film_render: {
      grain: { active: !noGrain && u.grain > 0, agx_particle_area_um2: GRAIN_AREA_UM2 * Math.max(u.grain, 0.01) },
      halation: { active: u.halation > 0, halation_amount: u.halation },
    },
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

// ---------- auto-lab ----------
// Like a lab printer metering each negative: choose print exposure so the
// output median lightness matches the photo's, and paper contrast so the
// p25–p75 spread matches. Runs on a small proxy, grain off.

const Lstar = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);

function percentiles(lums, ps) {
  const hist = new Uint32Array(1001);
  for (const L of lums) hist[Math.max(0, Math.min(1000, Math.round(L * 10)))]++;
  const res = [];
  let acc = 0, k = 0;
  const targets = ps.map((p) => p / 100 * lums.length);
  for (let b = 0; b <= 1000 && k < ps.length; b++) {
    acc += hist[b];
    while (k < ps.length && acc >= targets[k]) { res.push(b / 10); k++; }
  }
  while (res.length < ps.length) res.push(100);
  return res;
}

function outputL(out) {
  const n = out.length / 3, L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = srgbToLinear(Math.min(1, Math.max(0, out[3 * i])));
    const g = srgbToLinear(Math.min(1, Math.max(0, out[3 * i + 1])));
    const b = srgbToLinear(Math.min(1, Math.max(0, out[3 * i + 2])));
    L[i] = Lstar(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return L;
}

function inputL(img) {
  // Input is linear Rec.2020 (P3 path) or linear sRGB.
  const [kr, kg, kb] = img.p3 ? [0.2627, 0.6780, 0.0593] : [0.2126, 0.7152, 0.0722];
  const n = img.w * img.h, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = Lstar(Math.max(0, kr * img.rgb[3 * i] + kg * img.rgb[3 * i + 1] + kb * img.rgb[3 * i + 2]));
  return L;
}

async function autoLab() {
  const fit = photo.fit, u = { ...ui(), ev: 0, contrast: 0 };
  ensureEngine(u);
  const [t25, t50, t75] = percentiles(inputL(fit), [25, 50, 75]);
  const measure = async (pe, gamma) => {
    engine.update(JSON.stringify(renderParams(u, { pe, gamma }, { noGrain: true })));
    return percentiles(outputL(await run(fit)), [25, 50, 75]);
  };
  let best = null;
  for (const gamma of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    let lo = -3, hi = 1.5;                         // log2(print_exposure)
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      const [, m] = await measure(2 ** mid, gamma);
      if (m > t50) lo = mid; else hi = mid;        // too bright → more print exposure
    }
    const pe = 2 ** ((lo + hi) / 2);
    const [a, , b] = await measure(pe, gamma);
    const err = Math.abs((b - a) - (t75 - t25));
    if (!best || err < best.err) best = { pe, gamma, err };
  }
  auto = { pe: best.pe, gamma: best.gamma };
}

// ---------- preview ----------

async function render() {
  if (!photo || exporting) return;
  if (rendering) { dirty = true; return; }
  rendering = true;
  try {
    do {
      dirty = false;
      const u = ui();
      ensureEngine(u);
      engine.update(JSON.stringify(renderParams(u, auto)));
      const t = performance.now();
      const out = await run(photo.preview);
      photo.after = toImageData(out, photo.preview.w, photo.preview.h);
      if (!showingBefore) ctx.putImageData(photo.after, 0, 0);
      status(`${photo.preview.w}×${photo.preview.h} · ${Math.round(performance.now() - t)} ms${gpu ? '' : ' (CPU)'}`);
    } while (dirty);
  } catch (e) {
    log('render error: ' + (e?.stack || e));
    status('Errore: ' + (e?.message || e));
  } finally {
    rendering = false;
  }
}

let showingBefore = false;
function showBefore(on) {
  if (!photo?.after) return;
  showingBefore = on;
  ctx.putImageData(on ? photo.preview.before : photo.after, 0, 0);
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
  view.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
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

// ---------- photo ----------

async function loadPhoto(file) {
  if (!file) return;
  status('Decodifica…');
  try {
    log(`photo: ${file.name} ${file.type} ${(file.size / 1e6).toFixed(1)} MB`);
    const bitmap = await createImageBitmap(file);
    const preview = readPixels(bitmap, PREVIEW_LONG_SIDE);
    const fit = readPixels(bitmap, FIT_LONG_SIDE);
    log(`decoded ${bitmap.width}x${bitmap.height}, preview ${preview.w}x${preview.h}, p3=${preview.p3}`);
    photo = { file, bitmap, preview, fit };
    engine?.free(); engine = null;
    view.width = preview.w; view.height = preview.h;
    view.style.width = preview.w + 'px'; view.style.height = preview.h + 'px';
    view.style.display = 'block'; $('empty').style.display = 'none'; $('tools').hidden = false;
    ctx.putImageData(preview.before, 0, 0);
    fitToScreen();
    await runAuto();
    $('export').disabled = false; $('auto').disabled = false; $('newPhoto').hidden = false;
  } catch (e) {
    log('load error: ' + (e?.stack || e));
    status('Errore: ' + (e?.message || e));
  }
}

async function runAuto() {
  for (const [id, v] of [['ev', 0], ['contrast', 0]]) $(id).value = v;
  syncOutputs();
  status('Analisi (auto-lab)…');
  const t = performance.now();
  await autoLab();
  const ms = Math.round(performance.now() - t);
  log(`auto-lab ${ms} ms: print ${Math.log2(auto.pe).toFixed(2)} EV, gamma ${auto.gamma}`);
  await render();
  status($('status').textContent + ` · auto-lab ${ms} ms`);
}

// ---------- export ----------
// Full resolution rendered in tiles, one strip of tiles at a time; each strip
// is streamed to jpegli in a worker and dropped. Neither the full float image
// nor the full RGB image ever exists (in JS, wasm or on the GPU).
// Each tile keeps the frame's physical pixel size (film_format_mm scaled to the
// tile) and the frame's auto-exposure, with an overlap margin cropped away.

const encoder = new Worker('export-worker.js');
let encoderError = null, encoderDone = null;
encoder.onmessage = ({ data }) => {
  if (data.cmd === 'error') { encoderError = data.error; log('jpegli error: ' + data.error); encoderDone?.reject(new Error(data.error)); }
  else if (data.cmd === 'done') { log(`jpegli done, heap ${data.heapMB} MB`); encoderDone?.resolve(data.jpeg); }
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
  const u = ui();
  const t0 = performance.now();
  try {
    const { bitmap } = photo;
    const scale = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (bitmap.width * bitmap.height)));
    const longCap = Math.max(bitmap.width, bitmap.height) * scale;
    status('Esporto: decodifica…');
    const { data, w, h, p3 } = decodeRGBA(bitmap, longCap);
    const progressive = w * h > PROGRESSIVE_PIXEL_LIMIT ? 0 : 2;
    log(`export start ${w}x${h} p3=${p3} progressive=${progressive}`);

    ensureEngine(u);
    const exposure = 2 ** engine.auto_exposure_ev(photo.preview.rgb, photo.preview.w, photo.preview.h);
    const longSide = Math.max(w, h);
    const strips = Math.ceil(h / EXPORT_TILE), cols = Math.ceil(w / EXPORT_TILE);

    encoderError = null;
    const done = new Promise((resolve, reject) => { encoderDone = { resolve, reject }; });
    done.catch(() => {});
    encoder.postMessage({ cmd: 'start', width: w, height: h, distance: JPEG_DISTANCE, progressive, yuv444: 1 });

    for (let s = 0; s < strips; s++) {
      const ty = s * EXPORT_TILE, ch = Math.min(EXPORT_TILE, h - ty);
      const strip = new Uint8Array(w * ch * 3);
      for (let c = 0; c < cols; c++) {
        if (encoderError) throw new Error(encoderError);
        const tx = c * EXPORT_TILE;
        status(`Esporto ${w}×${h}: tile ${s * cols + c + 1}/${strips * cols}…`);
        const x0 = Math.max(0, tx - EXPORT_PAD), y0 = Math.max(0, ty - EXPORT_PAD);
        const tw = Math.min(w, tx + EXPORT_TILE + EXPORT_PAD) - x0, th = Math.min(h, ty + EXPORT_TILE + EXPORT_PAD) - y0;
        engine.update(JSON.stringify(deepMerge(renderParams(u, auto), {
          camera: { auto_exposure: false, film_format_mm: FILM_FORMAT_MM * Math.max(tw, th) / longSide },
        })));
        const out = await run({ rgb: extractLinear(data, w, p3, x0, y0, tw, th, exposure), w: tw, h: th });
        const cw = Math.min(EXPORT_TILE, w - tx);
        for (let y = 0; y < ch; y++) {
          let src = ((ty - y0 + y) * tw + (tx - x0)) * 3, dst = (y * w + tx) * 3;
          for (let i = 0; i < cw * 3; i++) strip[dst++] = Math.max(0, Math.min(255, Math.round(out[src++] * 255)));
        }
      }
      encoder.postMessage({ cmd: 'rows', rgb: strip.buffer }, [strip.buffer]);
      log(`strip ${s + 1}/${strips} sent`);
    }
    status('Esporto: JPEG (jpegli)…');
    encoder.postMessage({ cmd: 'finish' });
    let bytes = await done;
    try {
      const seg = await readExifSegment(photo.file);
      if (seg) { bytes = insertExif(bytes, patchExif(seg, w, h)); log(`EXIF carried over (${seg.length} B)`); }
    } catch (e) { log('EXIF skipped: ' + (e?.message || e)); }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const base = (photo.file.name || 'foto').replace(/\.[^.]+$/, '');
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`export done ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    status(`Esportata: ${w}×${h}, ${(blob.size / 1e6).toFixed(1)} MB in ${secs} s`);
    download(blob, `${base}_gold200.jpg`);
  } catch (e) {
    encoder.postMessage({ cmd: 'abort' });
    log('export error: ' + (e?.stack || e));
    status('Export fallito: ' + (e?.message || e) + ' (tocca qui per il log)');
  } finally {
    setBusy(null);
    exporting = false;
    $('export').disabled = false;
    engine?.update(JSON.stringify(renderParams(ui(), auto)));   // back to preview params
  }
}

// ---------- log panel ----------

function openLog(title) {
  $('logTitle').textContent = title;
  $('logText').textContent = logText() || '(vuoto)';
  $('logPanel').style.display = 'flex';
}
$('status').addEventListener('click', () => openLog('Log'));
$('logClose').addEventListener('click', () => { $('logPanel').style.display = 'none'; });
$('logCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(logText()); $('logCopy').textContent = 'Copiato ✓'; } catch { $('logCopy').textContent = 'Seleziona il testo'; }
});

// ---------- wiring ----------

function status(msg) { $('status').textContent = msg; }

const FORMAT = {
  ev: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`,
  contrast: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`,
  mshift: (v) => `${v > 0 ? '+' : ''}${v}`,
  yshift: (v) => `${v > 0 ? '+' : ''}${v}`,
  grain: (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`),
  halation: (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`),
};
const DEFAULTS = { ev: 0, contrast: 0, mshift: 0, yshift: 0, grain: 1, halation: 1 };
function syncOutputs() { for (const id of Object.keys(FORMAT)) $(id).nextElementSibling.textContent = FORMAT[id](+$(id).value); }

for (const id of Object.keys(FORMAT)) {
  $(id).addEventListener('input', () => { syncOutputs(); render(); });
  // Double-tap the label to reset a slider.
  $(id).previousElementSibling.addEventListener('dblclick', () => { $(id).value = DEFAULTS[id]; syncOutputs(); render(); });
}
$('pick').addEventListener('change', (e) => loadPhoto(e.target.files[0]));
$('newPhoto').addEventListener('click', () => $('pick').click());
$('auto').addEventListener('click', () => runAuto());
$('export').addEventListener('click', exportFull);
syncOutputs();

const crashed = takeCrashMarker();
if (crashed) openLog(`La sessione precedente si è interrotta durante: ${crashed}. Copia il log e mandamelo.`);
else clearLog();
log(`boot ${navigator.userAgent}`);

bootEngine().then((ok) => {
  gpu = ok;
  log(`engine ready, gpu=${gpu}`);
  status(gpu ? 'Pronto. Scegli una foto.' : 'WebGPU non disponibile: userò la CPU (lento).');
}).catch((e) => { log('boot error: ' + (e?.stack || e)); status('Errore avvio: ' + (e?.message || e)); });
