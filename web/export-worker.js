// Streaming JPEG encoder (jpegli wasm) running off the main thread.
//
// Protocol (messages are handled strictly in order):
//   { cmd: 'start', width, height, distance, progressive, yuv444 }
//   { cmd: 'rows', rgb: ArrayBuffer }        // whole rows, RGB 8-bit, top to bottom
//   { cmd: 'finish' }                        // → { cmd: 'done', jpeg: ArrayBuffer }
//   { cmd: 'abort' }
// Errors → { cmd: 'error', error }.
//
// Rows are pushed into the wasm heap a batch at a time, so the full RGB image
// never exists there. Progressive mode still keeps every DCT coefficient in
// the heap (up to ~29 B/px at 4:4:4), so callers use baseline for large frames.
// `distance` is a butteraugli distance (1.0 ≈ visually lossless), not 0-100.
importScripts('vendor/jpegli_wasm2.js');

const ROW_BATCH = 64;
const ready = JpegliModule();
let M = null, ctx = 0, width = 0, rowPtr = 0;
let queue = Promise.resolve();

function cleanup() {
  if (rowPtr) M._free(rowPtr);
  rowPtr = 0; ctx = 0;
}

async function handle(msg) {
  M = M || await ready;
  switch (msg.cmd) {
    case 'start': {
      width = msg.width;
      ctx = M._jpegli_wasm_start(msg.width, msg.height, msg.distance ?? 1.0, msg.progressive ?? 0, msg.yuv444 ?? 1);
      if (!ctx) throw new Error('jpegli_wasm_start failed');
      rowPtr = M._malloc(width * 3 * ROW_BATCH);
      break;
    }
    case 'rows': {
      const rgb = new Uint8Array(msg.rgb), stride = width * 3, rows = rgb.length / stride;
      for (let y = 0; y < rows; y += ROW_BATCH) {
        const n = Math.min(ROW_BATCH, rows - y);
        M.HEAPU8.set(rgb.subarray(y * stride, (y + n) * stride), rowPtr);
        for (let done = 0; done < n;) {
          const d = M._jpegli_wasm_write_rows(ctx, rowPtr + done * stride, n - done);
          if (d <= 0) throw new Error('jpegli_wasm_write_rows failed');
          done += d;
        }
      }
      break;
    }
    case 'finish': {
      const lenPtr = M._malloc(4);
      const out = M._jpegli_wasm_finish(ctx, lenPtr);
      const len = M.HEAPU32[lenPtr >> 2];
      M._free(lenPtr);
      if (!out) throw new Error('jpegli_wasm_finish failed');
      const jpeg = M.HEAPU8.slice(out, out + len).buffer;
      M._jpegli_wasm_free(out);
      cleanup();
      self.postMessage({ cmd: 'done', jpeg, heapMB: Math.round(M.HEAPU8.length / 1048576) }, [jpeg]);
      break;
    }
    case 'abort': {
      if (ctx) M._jpegli_wasm_abort(ctx);
      cleanup();
      break;
    }
  }
}

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch((e) => {
    try { if (ctx) M._jpegli_wasm_abort(ctx); } catch {}
    cleanup();
    self.postMessage({ cmd: 'error', error: String(e?.message || e) });
  });
};
