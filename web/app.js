import { sf, bootEngine, FILM, PAPER, BASE_PARAMS, deepMerge, inputParams, readPixels, toImageData, srgbToLinear } from './lib/common.js';

const PREVIEW_LONG_SIDE = 1600;   // ~2 MP on a 3:4 photo: ~80 ms on iPhone WebGPU
const FIT_LONG_SIDE = 256;        // proxy used by the auto-lab fit
const GRAIN_AREA_UM2 = 0.2;       // engine default AgX particle area
const JPEG_DISTANCE = 1.0;        // butteraugli distance for jpegli

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d', { colorSpace: 'display-p3' });

let gpu = false;
let engine = null;          // sf.Engine for the current photo + calibration
let engineCalib = '';       // JSON of the calibration params `engine` was built with
let photo = null;           // { file, bitmap, preview, fit }
let auto = { pe: 1, gamma: 1 };
let busy = false, dirty = false;
let lastJpeg = null;

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
  // Input luminance in its own space: Rec.2020 linear (P3 path) or sRGB encoded.
  const n = img.w * img.h, L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let r = img.rgb[3 * i], g = img.rgb[3 * i + 1], b = img.rgb[3 * i + 2];
    if (img.p3) { L[i] = Lstar(Math.max(0, 0.2627 * r + 0.6780 * g + 0.0593 * b)); continue; }
    r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
    L[i] = Lstar(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
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
  if (!photo) return;
  if (busy) { dirty = true; return; }
  busy = true;
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
    status('Errore: ' + (e?.message || e));
  } finally {
    busy = false;
  }
}

let showingBefore = false;
function showBefore(on) {
  if (!photo?.after) return;
  showingBefore = on;
  ctx.putImageData(on ? photo.preview.before : photo.after, 0, 0);
  $('badge').style.display = on ? 'block' : 'none';
}
view.addEventListener('pointerdown', (e) => { e.preventDefault(); showBefore(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) view.addEventListener(ev, () => showBefore(false));
view.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- photo ----------

async function loadPhoto(file) {
  if (!file) return;
  status('Decodifica…');
  try {
    const bitmap = await createImageBitmap(file);
    const preview = readPixels(bitmap, PREVIEW_LONG_SIDE);
    const fit = readPixels(bitmap, FIT_LONG_SIDE);
    photo = { file, bitmap, preview, fit };
    engine?.free(); engine = null;
    view.width = preview.w; view.height = preview.h;
    view.style.display = 'block'; $('empty').style.display = 'none';
    ctx.putImageData(preview.before, 0, 0);
    await runAuto();
    $('export').disabled = false; $('auto').disabled = false; $('newPhoto').hidden = false;
  } catch (e) {
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
  await render();
  status($('status').textContent + ` · auto-lab ${ms} ms (stampa ${Math.log2(auto.pe).toFixed(2)} EV, contrasto ${auto.gamma})`);
}

// ---------- export ----------

const worker = new Worker('export-worker.js');
let jobId = 0;
const encode = (rgb, width, height) => new Promise((resolve, reject) => {
  const id = ++jobId;
  const onMsg = ({ data }) => {
    if (data.id !== id) return;
    worker.removeEventListener('message', onMsg);
    data.error ? reject(new Error(data.error)) : resolve(new Blob([data.jpeg], { type: 'image/jpeg' }));
  };
  worker.addEventListener('message', onMsg);
  worker.postMessage({ id, rgb: rgb.buffer, width, height, distance: JPEG_DISTANCE, progressive: 1, yuv444: 1 }, [rgb.buffer]);
});

async function exportFull() {
  $('export').disabled = true;
  try {
    const t0 = performance.now();
    status('Esporto: decodifica a piena risoluzione…');
    let full = readPixels(photo.bitmap);
    status(`Esporto: sviluppo ${full.w}×${full.h}…`);
    ensureEngine(ui());
    engine.update(JSON.stringify(renderParams(ui(), auto)));
    let out;
    try {
      out = await run(full);
    } catch (e) {
      // Very large frames can exceed GPU/tab memory: fall back to half size.
      full = readPixels(photo.bitmap, Math.max(photo.bitmap.width, photo.bitmap.height) / 2);
      status(`Memoria insufficiente, ripiego su ${full.w}×${full.h}…`);
      out = await run(full);
    }
    const { w, h } = full;
    full = null;
    const rgb8 = new Uint8Array(w * h * 3);
    for (let i = 0; i < rgb8.length; i++) rgb8[i] = Math.max(0, Math.min(255, Math.round(out[i] * 255)));
    out = null;
    status('Esporto: JPEG (jpegli)…');
    const blob = await encode(rgb8, w, h);
    const base = (photo.file.name || 'foto').replace(/\.[^.]+$/, '');
    lastJpeg = new File([blob], `${base}_gold200.jpg`, { type: 'image/jpeg' });
    status(`Pronto: ${w}×${h}, ${(blob.size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    $('saveBar').style.display = 'flex';
  } catch (e) {
    status('Export fallito: ' + (e?.message || e));
  } finally {
    $('export').disabled = false;
    render();   // restore preview params (export may have changed nothing, but keep in sync)
  }
}

async function save() {
  if (!lastJpeg) return;
  if (navigator.canShare?.({ files: [lastJpeg] })) {
    try { await navigator.share({ files: [lastJpeg] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(lastJpeg), download: lastJpeg.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

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
$('auto').addEventListener('click', () => runAuto());
$('export').addEventListener('click', exportFull);
$('save').addEventListener('click', save);
$('dismiss').addEventListener('click', () => { $('saveBar').style.display = 'none'; });
syncOutputs();

$('newPhoto').addEventListener('click', () => $('pick').click());

bootEngine().then((ok) => {
  gpu = ok;
  status(gpu ? 'Pronto. Scegli una foto.' : 'WebGPU non disponibile: userò la CPU (lento).');
}).catch((e) => status('Errore avvio: ' + (e?.message || e)));
