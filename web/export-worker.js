// Streaming JPEG encoder (jpegli wasm) running off the main thread.
//
// Protocol (messages are handled strictly in order):
//   { cmd: 'start', width, height, distance, progressive, yuv444, border, mat }
//   { cmd: 'rows', rgb: ArrayBuffer }        // whole rows, RGB 8-bit, top to bottom
//   { cmd: 'finish' }                        // → { cmd: 'done', jpeg: ArrayBuffer }
//   { cmd: 'abort' }
// Errors → { cmd: 'error', error }.
//
// `border` (px, optional) adds a mat of that width on all four sides, in the colour `mat`
// ([r, g, b] 8-bit, default white: the caller passes the image's paper white); it is
// synthesised row by row, so the output is (width + 2·border) × (height + 2·border)
// and the caller still sends only the image rows.
// Rows are pushed into the wasm heap a batch at a time, so the full RGB image
// never exists there. Progressive mode still keeps every DCT coefficient in
// the heap (up to ~29 B/px at 4:4:4), so callers use baseline for large frames.
// `distance` is a butteraugli distance (1.0 ≈ visually lossless), not 0-100.
importScripts('vendor/jpegli_wasm2.js');

const ROW_BATCH = 64;
const WHITE = [255, 255, 255];
const ready = JpegliModule();
let M = null, ctx = 0, width = 0, border = 0, mat = WHITE, outW = 0, outH = 0, rowPtr = 0;
let queue = Promise.resolve();

// Push the first `n` rows staged at rowPtr.
function writeBatch(n) {
  const outStride = outW * 3;
  for (let done = 0; done < n;) {
    const d = M._jpegli_wasm_write_rows(ctx, rowPtr + done * outStride, n - done);
    if (d <= 0) throw new Error('jpegli_wasm_write_rows failed');
    done += d;
  }
}

// Fill `px` pixels at ptr with the mat colour (one pixel, then doubling copies).
function fillMat(ptr, px) {
  const heap = M.HEAPU8;
  heap.set(mat, ptr);
  for (let n = 1; n < px; n *= 2) heap.copyWithin(ptr + 3 * n, ptr, ptr + 3 * Math.min(n, px - n));
}

function writeMat(rows) {
  for (let y = 0; y < rows; y += ROW_BATCH) {
    const n = Math.min(ROW_BATCH, rows - y);
    fillMat(rowPtr, n * outW);
    writeBatch(n);
  }
}

function cleanup() {
  if (rowPtr) M._free(rowPtr);
  rowPtr = 0; ctx = 0;
}

async function handle(msg) {
  M = M || await ready;
  // After an error cleanup() left ctx = rowPtr = 0: rows / finish already queued
  // for that export must not touch the heap (rowPtr 0 = the bottom of the wasm
  // heap, corrupting every later export). The error was already reported.
  if ((msg.cmd === 'rows' || msg.cmd === 'finish') && !ctx) return;
  switch (msg.cmd) {
    case 'start': {
      if (ctx) { M._jpegli_wasm_abort(ctx); cleanup(); }   // a stale export that never finished
      width = msg.width; border = msg.border | 0; mat = msg.mat ?? WHITE;
      outW = width + 2 * border; outH = msg.height + 2 * border;
      ctx = M._jpegli_wasm_start(outW, outH, msg.distance ?? 1.0, msg.progressive ?? 0, msg.yuv444 ?? 1);
      if (!ctx) throw new Error('jpegli_wasm_start failed');
      rowPtr = M._malloc(outW * 3 * ROW_BATCH);
      if (!rowPtr) throw new Error('out of memory (row buffer)');
      if (border) fillMat(rowPtr, outW * ROW_BATCH);   // side mats keep the mat colour for every batch
      writeMat(border);                          // top mat
      break;
    }
    case 'rows': {
      const rgb = new Uint8Array(msg.rgb), stride = width * 3, rows = rgb.length / stride;
      const outStride = outW * 3, side = border * 3;
      for (let y = 0; y < rows; y += ROW_BATCH) {
        const n = Math.min(ROW_BATCH, rows - y);
        if (border) {
          const heap = M.HEAPU8;                 // only the image part is rewritten: the margins were filled at start
          for (let r = 0; r < n; r++) heap.set(rgb.subarray((y + r) * stride, (y + r + 1) * stride), rowPtr + r * outStride + side);
        } else {
          M.HEAPU8.set(rgb.subarray(y * stride, (y + n) * stride), rowPtr);
        }
        writeBatch(n);
      }
      break;
    }
    case 'finish': {
      writeMat(border);                          // bottom mat
      const lenPtr = M._malloc(4);
      const out = M._jpegli_wasm_finish(ctx, lenPtr);
      const len = M.HEAPU32[lenPtr >> 2];
      M._free(lenPtr);
      if (!out) throw new Error('jpegli_wasm_finish failed');
      const jpeg = M.HEAPU8.slice(out, out + len).buffer;
      M._jpegli_wasm_free(out);
      cleanup();
      self.postMessage({ cmd: 'done', jpeg, width: outW, height: outH, heapMB: Math.round(M.HEAPU8.length / 1048576) }, [jpeg]);
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
