import { sf, bootEngine, FILM, PAPER, BASE_PARAMS, SRGB_INPUT, inputParams, readPixels } from './lib/common.js';

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
    const io = kind === 'srgb' ? SRGB_INPUT : inputParams(kind === 'p3');
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
    const t = now();
    gpuOk = await bootEngine();
    report.boot_ms = Math.round(now() - t);
    engine('srgb');
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
    const out = await run(engine(p3 ? 'p3' : 'srgb-linear'), rgb, w, h, gpuOk);
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
