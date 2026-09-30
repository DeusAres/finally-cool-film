// JPEG encoding off the main thread with jpegli (wasm).
// jpegli_wasm_encode_rgb(rgbPtr, w, h, distance, progressive, yuv444, outLenPtr) -> outPtr
// `distance` is a butteraugli distance (1.0 ≈ visually lossless), not a 0-100 quality.
importScripts('vendor/jpegli_wasm2.js');

const ready = JpegliModule();

self.onmessage = async ({ data }) => {
  const { id, rgb, width, height, distance = 1.0, progressive = 1, yuv444 = 1 } = data;
  try {
    const M = await ready;
    const src = M._malloc(rgb.byteLength);
    const lenPtr = M._malloc(4);
    M.HEAPU8.set(new Uint8Array(rgb), src);
    const out = M._jpegli_wasm_encode_rgb(src, width, height, distance, progressive, yuv444, lenPtr);
    M._free(src);
    if (!out) throw new Error('jpegli encode failed');
    const len = M.HEAPU32[lenPtr >> 2];
    const jpeg = M.HEAPU8.slice(out, out + len).buffer;
    M._jpegli_wasm_free(out);
    M._free(lenPtr);
    self.postMessage({ id, jpeg }, [jpeg]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
