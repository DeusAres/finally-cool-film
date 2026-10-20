// Raw decode off the main thread (module worker, one per decode, started by raw.js decodeInWorker).
// Protocol: in { buf: ArrayBuffer of the file, opt: { maxLongSide, rot, f16 } }; out { r } (raw.js decodeRaw's object, its
// rgb or f16 buffer transferred) or { error }. A multi-second decode no longer freezes the page, and a parser stuck on a
// corrupt file stalls only this worker.

import { decodeRaw } from './raw.js';

self.onmessage = async ({ data: { buf, opt } }) => {
  try {
    const r = await decodeRaw(buf, opt);
    self.postMessage({ r }, [(r.f16 ?? r.rgb).buffer]);
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) || 'errore di decodifica' });
  }
};
