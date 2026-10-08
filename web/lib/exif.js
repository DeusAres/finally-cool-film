// EXIF carry-over (adapted from the grain project's exporter).
// jpegli writes pixels only, so date, camera, lens and GPS would be lost. The
// original APP1/Exif segment is copied into the output with three patches:
// Orientation → 1 (pixels are already upright), ColorSpace → sRGB for an sRGB
// export, "uncalibrated" for a Display P3 one (the ICC profile says which),
// PixelX/YDimension → the exported size. Anything unexpected → no EXIF rather
// than a broken file.

/** The original APP1/Exif segment (FFE1 + length + payload) of a JPEG file, or null. */
export async function readExifSegment(file) {
  if (!file || !/jpe?g$/i.test(file.type || file.name || '')) return null;
  const buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xFF) {
    const m = buf[p + 1];
    if (m === 0xDA || m === 0xD9) break;                   // SOS / EOI: no more headers
    const len = (buf[p + 2] << 8) | buf[p + 3];
    if (m === 0xE1 && len > 8 && p + 2 + len <= buf.length &&
        buf[p + 4] === 0x45 && buf[p + 5] === 0x78 && buf[p + 6] === 0x69 && buf[p + 7] === 0x66 &&
        buf[p + 8] === 0 && buf[p + 9] === 0) {
      return buf.slice(p, p + 2 + len);
    }
    p += 2 + len;
  }
  return null;
}

export function patchExif(seg, w, h, p3 = false) {
  const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const T = 10;                                            // TIFF header offset inside the segment
  const le = dv.getUint16(T) === 0x4949;
  const u16 = (o) => dv.getUint16(T + o, le), u32 = (o) => dv.getUint32(T + o, le);
  const set = (entry, v) => {
    const type = u16(entry + 2);
    if (type === 3) dv.setUint16(T + entry + 8, v, le);
    else if (type === 4) dv.setUint32(T + entry + 8, v, le);
  };
  const walk = (ifd, fn) => {
    if (!ifd || T + ifd + 2 > seg.length) return;
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (T + e + 12 > seg.length) return;
      fn(u16(e), e);
    }
  };
  let exifIfd = 0;
  walk(u32(4), (tag, e) => {
    if (tag === 0x0112) set(e, 1);
    else if (tag === 0x8769) exifIfd = u32(e + 8);
  });
  walk(exifIfd, (tag, e) => {
    if (tag === 0xA001) set(e, p3 ? 0xFFFF : 1);
    else if (tag === 0xA002) set(e, w);
    else if (tag === 0xA003) set(e, h);
  });
  return seg;
}

export function insertExif(jpeg, seg) {
  const j = new Uint8Array(jpeg);
  let at = 2;                                              // after SOI…
  if (j[2] === 0xFF && j[3] === 0xE0) at = 4 + ((j[4] << 8) | j[5]); // …and after JFIF APP0 if present
  const out = new Uint8Array(j.length + seg.length);
  out.set(j.subarray(0, at), 0);
  out.set(seg, at);
  out.set(j.subarray(at), at + seg.length);
  return out;
}

/**
 * Capture exposure from EXIF: { t (s), N, iso, bv (APEX brightness, or null) } or null when
 * exposure time / aperture / ISO are unavailable. JPEG: APP1 Exif segment; DNG/TIFF (ExifIFD sits ~1 MB in for iPhone DNGs, so 2 MB are read): the file
 * start is the TIFF structure. Never throws.
 */
export async function readExposure(file) {
  try {
    if (!file) return null;
    let buf, T;
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isTiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2A && head[3] === 0) ||
                   (head[0] === 0x4D && head[1] === 0x4D && head[2] === 0 && head[3] === 0x2A);
    if (isTiff) { buf = new Uint8Array(await file.slice(0, 2097152).arrayBuffer()); T = 0; }
    else { buf = await readExifSegment(file); T = 10; }
    if (!buf) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const le = dv.getUint16(T) === 0x4949;
    const u16 = (o) => dv.getUint16(T + o, le), u32 = (o) => dv.getUint32(T + o, le);
    const TYPE_SIZE = { 1: 1, 3: 2, 4: 4, 5: 8, 9: 4, 10: 8 };
    const readIfd = (ifd) => {
      const out = {};
      if (!ifd || T + ifd + 2 > buf.length) return out;
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (T + e + 12 > buf.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4), size = (TYPE_SIZE[type] || 0) * count;
        if (!size || count < 1) continue;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        if (T + at + size > buf.length) continue;
        let v;
        if (type === 3) v = u16(at);
        else if (type === 4) v = u32(at);
        else if (type === 5) { const d = u32(at + 4); v = d ? u32(at) / d : NaN; }
        else if (type === 10) { const d = dv.getInt32(T + at + 4, le); v = d ? dv.getInt32(T + at, le) / d : NaN; }
        else continue;
        out[tag] = v;
      }
      return out;
    };
    const ifd0 = u32(4), main = readIfd(ifd0);
    // ExifIFD pointer is a LONG in IFD0 (readIfd handles it as type 4)
    const ex = readIfd(main[0x8769]);
    const t = ex[0x829A], N = ex[0x829D], iso = ex[0x8827], bv = ex[0x9203];
    if (!(t > 0) || !(N > 0) || !(iso > 0)) return null;
    return { t, N, iso, bv: Number.isFinite(bv) ? bv : null };
  } catch { return null; }
}
