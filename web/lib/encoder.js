// The JPEG encoder (jpegli in a worker, export-worker.js) and the download, for the export (from app.js, 4.45).
import { sleep } from './util.js';
import { log } from './debuglog.js';

export const JPEG_QUALITY_DEFAULT = 90;   // export slider default: jpegli quality 90 = distance 1.0 (visually lossless), the pre-v3.15 fixed setting
/** jpegli's quality -> butteraugli distance (jpegli_quality_to_distance): 90 -> 1.0, 100 -> 0.1 (largest files). */
export const jpegDistance = (q) => (q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25);
export const PROGRESSIVE_PIXEL_LIMIT = 6e6; // progressive keeps all DCT coeffs in the wasm heap (~29 B/px): baseline above

// A worker whose script or wasm failed to load never answers, and an export would wait on it for ever: it posts 'ready' once
// jpegli is up and an export waits for that (ENCODER_READY_MS: generous, jpegli's ~200 KB wasm compiles in well under a second;
// unmeasured on device). After an error, and after every export, the worker is replaced: its wasm heap never shrinks and would
// keep the export's peak (hundreds of MB at 12 MP) for the whole session.
const ENCODER_READY_MS = 20000;
let encoder = null, encoderReady = null, encoderError = null, encoderDone = null;
/** A fresh worker (the old one terminated). */
export function startEncoder() {
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
/** An export's encoder: the worker up and answering (else an error after ENCODER_READY_MS, the worker replaced). From here any
 * error of this worker fails the export (also one during the export's decode). `post(msg, transfer)`; `check()` throws if the
 * worker failed or was replaced; `result()`: the promise of its 'done' (call once, before 'finish'). */
export async function openEncoder() {
  encoderError = null;
  if (!encoder) startEncoder();
  if (!(await Promise.race([encoderReady, sleep(ENCODER_READY_MS).then(() => false)]))) {
    startEncoder();
    throw new Error('encoder JPEG non disponibile, riprova');
  }
  const enc = encoder;
  return {
    post: (msg, transfer) => enc.postMessage(msg, transfer),
    check() { if (encoderError || encoder !== enc) throw new Error(encoderError || 'encoder JPEG terminato'); },
    failed: () => encoderError,
    result() { const done = new Promise((resolve, reject) => { encoderDone = { resolve, reject }; }); done.catch(() => {}); return done; },
  };
}

// iOS Safari fetches a download's blob only after the user confirms the sheet,
// which can take any time: keep the URL until the next export (or a minute).
let lastDownloadUrl = null;
export function download(blob, name) {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = lastDownloadUrl = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { if (lastDownloadUrl === url) { URL.revokeObjectURL(url); lastDownloadUrl = null; } }, 60000);
}
