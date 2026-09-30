import init, * as sf from './pkg/spektrafilm_wasm.js';

const FILM = 'kodak_gold_200';
const PAPER = 'kodak_portra_endura';
const DATA_FILES = [
  'profiles/kodak_gold_200.json',
  'profiles/kodak_portra_endura.json',
  'luts/spectral_upsampling/irradiance_xy_tc.npy',
  'filters/neutral_print_filters.json',
];
// LUT mode for enlarger + scanner: ~3x faster, max 1/255 off the full spectral path.
const BASE_PARAMS = { settings: { use_enlarger_lut: true, use_scanner_lut: true } };
const SRGB_INPUT = { io: { input_color_space: 'sRGB', input_cctf_decoding: true } };
const REC2020_LINEAR_INPUT = { io: { input_color_space: 'ITU-R BT.2020', input_cctf_decoding: false } };
// Linear Display P3 → linear Rec.2020 (both D65), derived from the primaries.
const P3_TO_REC2020 = [
  [0.75383303, 0.19859737, 0.0475696],
  [0.04574385, 0.94177722, 0.01247893],
  [-0.00121034, 0.01760172, 0.98360862],
];

const $ = (id) => document.getElementById(id);
const report = { ua: navigator.userAgent, when: new Date().toISOString() };
const engines = {};
let gpuOk = false;

const status = (msg) => { $('status').textContent = msg; };
const renderReport = () => { $('report').textContent = JSON.stringify(report, null, 1); };
const now = () => performance.now();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

function engine(kind) {
  if (!engines[kind]) {
    const io = kind === 'p3' ? REC2020_LINEAR_INPUT : SRGB_INPUT;
    const t = now();
    engines[kind] = new sf.Engine(FILM, PAPER, JSON.stringify({ ...BASE_PARAMS, ...io }));
    report[`engine_init_ms_${kind}`] = Math.round(now() - t);
  }
  return engines[kind];
}

async function adapterInfo() {
  if (!navigator.gpu) return { webgpu: false };
  const a = await navigator.gpu.requestAdapter();
  if (!a) return { webgpu: true, adapter: null };
  const info = a.info || {};
  return {
    webgpu: true,
    vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    maxComputeInvocationsPerWorkgroup: a.limits.maxComputeInvocationsPerWorkgroup,
    maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize,
    maxBufferSize: a.limits.maxBufferSize,
  };
}

async function boot() {
  try {
    report.gpu = await adapterInfo();
    status(report.gpu.webgpu ? 'WebGPU presente, carico il motore…' : 'WebGPU NON disponibile: userò la CPU (lenta).');
    let t = now();
    await init();
    report.wasm_load_ms = Math.round(now() - t);
    t = now();
    await Promise.all(DATA_FILES.map(async (p) => {
      const r = await fetch('data/' + p);
      if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
      sf.register_file('data/' + p, new Uint8Array(await r.arrayBuffer()));
    }));
    report.data_load_ms = Math.round(now() - t);
    engine('srgb');
    gpuOk = report.gpu.webgpu && await sf.init_gpu();
    report.gpu_backend = gpuOk;
    status(gpuOk ? 'Pronto (WebGPU).' : 'Pronto (solo CPU).');
    $('bench').disabled = false;
    $('pick').disabled = false;
  } catch (e) {
    report.boot_error = String(e?.message || e);
    status('Errore: ' + report.boot_error);
  }
  renderReport();
}

async function run(eng, rgb, w, h, useGpu) {
  return useGpu ? await eng.process_gpu(rgb, w, h) : eng.process(rgb, w, h);
}

// Deterministic test image: hue sweep × lightness ramp, plus skin-ish and neutral patches.
function syntheticImage(mp) {
  const w = Math.round(Math.sqrt(mp * 1e6 * 1.5)), h = Math.round(w / 1.5);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = 1 - y / h;
    for (let x = 0; x < w; x++) {
      const hue = (x / w) * 6, c = v * 0.8, k = c * (1 - Math.abs((hue % 2) - 1));
      let r = 0, g = 0, b = 0;
      if (hue < 1) [r, g, b] = [c, k, 0]; else if (hue < 2) [r, g, b] = [k, c, 0];
      else if (hue < 3) [r, g, b] = [0, c, k]; else if (hue < 4) [r, g, b] = [0, k, c];
      else if (hue < 5) [r, g, b] = [k, 0, c]; else [r, g, b] = [c, 0, k];
      if (y > h * 0.8) { const n = x / w; [r, g, b] = x < w * 0.2 ? [0.85, 0.62, 0.5] : [n, n, n]; }
      const i = (y * w + x) * 3;
      rgb[i] = r + v * 0.15; rgb[i + 1] = g + v * 0.15; rgb[i + 2] = b + v * 0.15;
    }
  }
  return { rgb, w, h };
}

async function bench() {
  $('bench').disabled = true;
  const sizes = [0.5, 1, 2].concat($('bench4').checked ? [4] : []);
  const tbody = $('benchTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('benchTable').hidden = false;
  report.bench = [];
  const eng = engine('srgb');
  const modes = gpuOk ? ['gpu'] : [];
  if (!gpuOk || $('benchCpu').checked) modes.push('cpu');
  for (const mode of modes) {
    for (const mp of mode === 'cpu' ? [0.5] : sizes) {
      status(`Benchmark ${mode.toUpperCase()} ${mp} MP…`);
      await new Promise((r) => setTimeout(r, 30));
      const { rgb, w, h } = syntheticImage(mp);
      const times = [];
      try {
        for (let i = 0; i < (mode === 'cpu' ? 1 : 4); i++) {
          const t = now();
          await run(eng, rgb, w, h, mode === 'gpu');
          times.push(Math.round(now() - t));
        }
        const row = { mode, mp, w, h, first_ms: times[0], median_ms: median(times.slice(1).length ? times.slice(1) : times) };
        report.bench.push(row);
        tbody.insertAdjacentHTML('beforeend', `<tr><td>${mode} ${mp}</td><td>${row.first_ms}</td><td>${row.median_ms}</td></tr>`);
      } catch (e) {
        report.bench.push({ mode, mp, error: String(e?.message || e) });
        tbody.insertAdjacentHTML('beforeend', `<tr><td>${mode} ${mp}</td><td colspan="2">errore</td></tr>`);
        break;
      }
      renderReport();
    }
  }
  status('Benchmark finito.');
  $('bench').disabled = false;
  renderReport();
}

// Returns linear Rec.2020 (from Display P3) when the canvas supports P3, else sRGB-encoded.
function readPixels(bitmap, longSide) {
  const s = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  let ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
  const p3 = ctx.getContextAttributes?.().colorSpace === 'display-p3';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const src = (p3 ? ctx.getImageData(0, 0, w, h, { colorSpace: 'display-p3' }) : ctx.getImageData(0, 0, w, h)).data;
  const rgb = new Float32Array(w * h * 3);
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  const M = P3_TO_REC2020;
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    if (p3) {
      const r = lin[src[i]], g = lin[src[i + 1]], b = lin[src[i + 2]];
      rgb[j] = M[0][0] * r + M[0][1] * g + M[0][2] * b;
      rgb[j + 1] = M[1][0] * r + M[1][1] * g + M[1][2] * b;
      rgb[j + 2] = M[2][0] * r + M[2][1] * g + M[2][2] * b;
    } else {
      rgb[j] = src[i] / 255; rgb[j + 1] = src[i + 1] / 255; rgb[j + 2] = src[i + 2] / 255;
    }
  }
  const before = new ImageData(new Uint8ClampedArray(src), w, h, p3 ? { colorSpace: 'display-p3' } : undefined);
  return { rgb, w, h, p3, before };
}

async function onPhoto(file) {
  if (!file) return;
  status('Decodifica foto…');
  try {
    let t = now();
    const bitmap = await createImageBitmap(file);
    const { rgb, w, h, p3, before } = readPixels(bitmap, +$('longSide').value);
    const decode_ms = Math.round(now() - t);
    status(`Sviluppo ${w}×${h}…`);
    await new Promise((r) => setTimeout(r, 30));
    t = now();
    const out = await run(engine(p3 ? 'p3' : 'srgb'), rgb, w, h, gpuOk);
    const process_ms = Math.round(now() - t);
    const after = new ImageData(w, h);
    for (let i = 0, j = 0; i < after.data.length; i += 4, j += 3) {
      after.data[i] = out[j] * 255; after.data[i + 1] = out[j + 1] * 255; after.data[i + 2] = out[j + 2] * 255; after.data[i + 3] = 255;
    }
    const canvas = $('out');
    canvas.width = w; canvas.height = h; canvas.hidden = false;
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    let showAfter = true;
    ctx.putImageData(after, 0, 0);
    canvas.onclick = () => { showAfter = !showAfter; ctx.putImageData(showAfter ? after : before, 0, 0);
      $('photoInfo').textContent = showAfter ? 'DOPO (tocca per originale)' : 'PRIMA (tocca per pellicola)'; };
    (report.photos ||= []).push({ type: file.type, bytes: file.size, src: `${bitmap.width}x${bitmap.height}`,
      w, h, p3_input: p3, decode_ms, process_ms, backend: gpuOk ? 'gpu' : 'cpu' });
    $('photoInfo').textContent = `${w}×${h} · ${process_ms} ms · input ${p3 ? 'Display P3' : 'sRGB'} — tocca per prima/dopo`;
    status('Fatto.');
  } catch (e) {
    (report.photos ||= []).push({ error: String(e?.message || e) });
    status('Errore: ' + (e?.message || e));
  }
  renderReport();
}

$('bench').onclick = bench;
$('pick').onchange = (e) => onPhoto(e.target.files[0]);
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('report').textContent); $('copy').textContent = 'Copiato ✓'; }
  catch { $('copy').textContent = 'Copia non riuscita: seleziona il testo'; }
};
boot();
