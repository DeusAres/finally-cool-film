// Raw decode off the main thread (module worker, one per decode, started by raw.js decodeInWorker; see there).
// Protocol: in { buf: the file's bytes (transferred), opt: { maxLongSide, rot, stream } }.
//   out, preview (!stream): { r } (raw.js decodeRaw's object, its float image transferred);
//   out, export (stream): { head } (the same without pixels), then one { strip, y0 } (half floats, transferred) per 'more';
//   or { error } at any point. A multi-second decode no longer freezes the page; main terminates the worker when it is done.

import { decodeRaw, f16Rows, stripsOf } from './raw.js';

const fail = (e) => self.postMessage({ error: String(e?.message || e) || 'errore di decodifica' });

self.onmessage = async ({ data: { buf, opt } }) => {
  let r;
  try { r = await decodeRaw(buf, opt); } catch (e) { fail(e); return; }
  if (!opt.stream) { self.postMessage({ r }, [r.rgb.buffer]); return; }
  const strips = stripsOf(r);
  self.onmessage = () => {   // 'more': the next strip (main uploaded the previous one)
    try {
      const [y0, n] = strips.next().value, strip = f16Rows(r, y0, n);
      self.postMessage({ strip, y0 }, [strip.buffer]);
    } catch (e) { fail(e); }
  };
  self.postMessage({ head: { ...r, rgb: null } });
};
// A message that cannot be read here (the file's bytes under memory pressure): answer, or main would wait for ever.
self.onmessageerror = () => fail('messaggio non leggibile dal worker');
