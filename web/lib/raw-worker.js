// Raw decode off the main thread (module worker, started by raw.js): the decoders are DOM-free; a multi-second decode no
// longer freezes the page, and a parser stuck on a corrupt file stalls only this worker.

import { decodeDNG } from './dng.js';
import { decodeORF, isORFHeader } from './orf.js';

self.onmessage = async ({ data: { id, file, opt } }) => {
  try {
    const buf = await file.arrayBuffer();
    const d = await (isORFHeader(new Uint8Array(buf, 0, 4)) ? decodeORF : decodeDNG)(buf, opt);
    self.postMessage({ id, d }, [d.rgb.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
