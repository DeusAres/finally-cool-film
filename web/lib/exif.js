// EXIF carry-over (adapted from the grain project's exporter) and the export's marker.
// jpegli writes pixels only, so date, camera, lens and GPS would be lost. The
// original's tags (JPEG, HEIC or raw) are rebuilt into a fresh APP1/Exif segment with
// three patches: Orientation → 1 (pixels are already upright), ColorSpace → sRGB for an
// sRGB export, "uncalibrated" for a Display P3 one (the ICC profile says which),
// PixelX/YDimension → the exported size. Anything unexpected → no carried tags rather
// than a broken file.
// Marker (user's ask: find the exports in iPhone Photos search): the description goes in
// EXIF ImageDescription and in an XMP packet (dc:description, dc:subject keywords). Which
// of these Photos search indexes is not documented by Apple: unverified, hence all three.

import { tiffMagic } from './dng.js';

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];   // TIFF field type → bytes per element
const SWAP = [0, 1, 1, 2, 4, 4, 1, 1, 2, 4, 4, 4, 8];         // byte-swap unit (rationals swap per 32-bit half)

/** Wrap a TIFF block into a full APP1/Exif segment (FFE1 + length + "Exif\0\0" + TIFF), or null if too big. */
function exifSegment(tiff) {
  const len = tiff.length + 8;
  if (len > 0xFFFF) return null;
  const seg = new Uint8Array(len + 2);
  seg.set([0xFF, 0xE1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  return seg;
}

/** Read the entries of one IFD of a TIFF (any byte order) as {tag,type,count,data(LE bytes)}; bad entries are skipped. */
function readIfd(buf, dv, le, off) {
  const out = [];
  if (!off || off + 2 > buf.length) return out;
  const n = dv.getUint16(off, le);
  for (let k = 0; k < n; k++) {
    const e = off + 2 + k * 12;
    if (e + 12 > buf.length) break;
    const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
    if (type < 1 || type > 12) continue;
    const size = TYPE_SIZE[type] * count;
    const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    if (size > 0x8000 || at + size > buf.length) continue;
    const data = buf.slice(at, at + size);
    if (!le && SWAP[type] > 1) for (let i = 0; i < size; i += SWAP[type]) data.subarray(i, i + SWAP[type]).reverse();
    out.push({ tag, type, count, data });
  }
  return out;
}

/** Serialise IFDs ({ifd0, exif, gps} entry lists) into a little-endian TIFF block. */
function buildTiff({ ifd0, exif, gps }) {
  const lists = [ifd0, exif, gps];
  const ptr = (list, tag, val) => list.push({ tag, type: 4, count: 1, data: new Uint8Array(4), val });
  if (exif.length) ptr(ifd0, 0x8769, 1);
  if (gps.length) ptr(ifd0, 0x8825, 2);
  for (const l of lists) l.sort((a, b) => a.tag - b.tag);
  const ifdSize = (l) => (l.length ? 2 + l.length * 12 + 4 : 0);
  const starts = []; let pos = 8;
  for (const l of lists) { starts.push(pos); pos += ifdSize(l); }
  const total = pos + lists.reduce((s, l) => s + l.reduce((t, e) => t + ((e.data.length + 1) & ~1), 0), 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true);
  let dataPos = pos;
  lists.forEach((l, i) => {
    if (!l.length) return;
    let o = starts[i];
    dv.setUint16(o, l.length, true); o += 2;
    for (const e of l) {
      dv.setUint16(o, e.tag, true); dv.setUint16(o + 2, e.type, true); dv.setUint32(o + 4, e.count, true);
      if (e.val) dv.setUint32(o + 8, starts[e.val], true);
      else if (e.data.length <= 4) out.set(e.data, o + 8);
      else { dv.setUint32(o + 8, dataPos, true); out.set(e.data, dataPos); dataPos += (e.data.length + 1) & ~1; }
      o += 12;
    }
  });
  return out;
}

const num = (type, v) => { const d = new Uint8Array(type === 3 ? 2 : 4); d[0] = v & 255; d[1] = (v >> 8) & 255; return { tag: 0, type, count: 1, data: d }; };
const IFD0_KEEP = new Set([0x010F, 0x0110, 0x0132, 0x013B, 0x8298]);   // Make Model DateTime Artist Copyright (Software is ours)
const EXIF_DROP = new Set([0x927C, 0xA005, 0x8769, 0x9286]);                  // MakerNote, Interop ptr, nested ptr, UserComment

const ascii = (tag, s) => { const d = new TextEncoder().encode(s.replace(/[^ -~]/g, '?') + '\0'); return { tag, type: 2, count: d.length, data: d }; };
export const MARKER = 'finallycoolfilm';   // the search word: one token no other app writes; also our Software tag

/** The {ifd0, exif, gps} entries of a TIFF-structured block (DNG, a HEIC's Exif item, a JPEG's Exif payload); empty if it is not one. */
function tiffTags(buf) {
  const none = { ifd0: [], exif: [], gps: [] };
  if (!buf || buf.length < 16) return none;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const m = dv.getUint16(0);
  const magic = dv.getUint16(2, m === 0x4949);   // 42; Olympus ORF 0x4f52 'RO' / 0x5352 'RS'
  if ((m !== 0x4949 && m !== 0x4D4D) || (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352)) return none;
  const le = m === 0x4949;
  const all0 = readIfd(buf, dv, le, dv.getUint32(4, le));
  const ptrOf = (tag) => { const e = all0.find((x) => x.tag === tag); return e && e.type === 4 ? new DataView(e.data.buffer).getUint32(0, true) : 0; };
  return {
    ifd0: all0.filter((e) => IFD0_KEEP.has(e.tag)),
    exif: readIfd(buf, dv, le, ptrOf(0x8769)).filter((e) => !EXIF_DROP.has(e.tag)),
    gps: readIfd(buf, dv, le, ptrOf(0x8825)),
  };
}

/** APP1/Exif segment: the original's tags (IFD0 subset + ExifIFD + GPS IFD; none for a PNG) + our description and Software. */
function exifSegmentOf(tiff, desc) {
  // ours: ImageDescription, Software, Orientation (patched to 1 again below), ColorSpace and PixelX/YDimension (set by patchExif)
  const mark = () => ({
    ifd0: [ascii(0x010E, desc), ascii(0x0131, MARKER), { ...num(3, 1), tag: 0x0112 }],
    exif: [[0xA001, 3], [0xA002, 4], [0xA003, 4]].map(([tag, type]) => ({ ...num(type, 1), tag })),
  });
  const { ifd0, exif, gps } = tiffTags(tiff), ours = mark(), mine = new Set([...ours.ifd0, ...ours.exif].map((e) => e.tag));
  const merged = { ifd0: [...ifd0.filter((e) => !mine.has(e.tag)), ...ours.ifd0], exif: [...exif.filter((e) => !mine.has(e.tag)), ...ours.exif], gps };
  return exifSegment(buildTiff(merged)) || exifSegment(buildTiff({ ...mark(), gps: [] }));   // over 64 KB: the marker alone
}

/** HEIC/HEIF: the TIFF block of the Exif item of `meta` (iinf → item_type 'Exif', iloc → offset/length), or null. */
async function exifFromHeic(file) {
  const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
  const dv = new DataView(head.buffer);
  const box = (start, end, fn) => {
    for (let p = start; p + 8 <= end;) {
      let size = dv.getUint32(p), hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;
      if (fn(String.fromCharCode(head[p + 4], head[p + 5], head[p + 6], head[p + 7]), p + hdr, p + size)) return;
      p += size;
    }
  };
  let exifId = -1, loc = null;
  box(0, head.length, (t, s, e) => {
    if (t !== 'meta') return false;
    box(s + 4, e, (t2, s2, e2) => {
      if (t2 === 'iinf') {
        const v = head[s2]; let p = s2 + 4; const n = v === 0 ? dv.getUint16(p) : dv.getUint32(p); p += v === 0 ? 2 : 4;
        box(p, e2, (t3, s3, e3) => {
          if (t3 !== 'infe' || head[s3] < 2) return false;
          const id = head[s3] === 2 ? dv.getUint16(s3 + 4) : dv.getUint32(s3 + 4);
          const ty = s3 + 4 + (head[s3] === 2 ? 4 : 6);
          if (String.fromCharCode(head[ty], head[ty + 1], head[ty + 2], head[ty + 3]) === 'Exif') exifId = id;
          return false;
        });
        void n;
      } else if (t2 === 'iloc') {
        const v = head[s2], offSz = head[s2 + 4] >> 4, lenSz = head[s2 + 4] & 15, baseSz = head[s2 + 5] >> 4, idxSz = v ? head[s2 + 5] & 15 : 0;
        let p = s2 + 6; const cnt = v < 2 ? dv.getUint16(p) : dv.getUint32(p); p += v < 2 ? 2 : 4;
        const rd = (n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + head[p++]; return x; };
        for (let i = 0; i < cnt; i++) {
          const id = v < 2 ? rd(2) : rd(4); const cm = v ? rd(2) & 15 : 0; rd(2);
          const base = rd(baseSz), ec = rd(2);
          for (let j = 0; j < ec; j++) {
            if (v && idxSz) rd(idxSz);
            const o = rd(offSz), l = rd(lenSz);
            if (id === exifId && cm === 0 && !loc) loc = [base + o, l];
          }
        }
      }
      return false;
    });
    return true;
  });
  if (!loc || loc[1] < 12 || loc[1] > 0x10000) return null;
  const item = new Uint8Array(await file.slice(loc[0], loc[0] + loc[1]).arrayBuffer());
  const skip = 4 + new DataView(item.buffer).getUint32(0);               // exif_tiff_header_offset
  return skip < item.length ? item.subarray(skip) : null;
}

/** The TIFF block holding an input's EXIF, or null: JPEG (APP1/Exif payload), DNG/TIFF (the file itself), HEIC (Exif item). */
async function readTiff(file) {
  if (!file) return null;
  const id = `${file.type || ''} ${file.name || ''}`;
  // TIFF-based raws (DNG, ORF, TIFF) by header too: phone raws are often named without an extension (Indigo's IDG_...).
  const h = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (tiffMagic(h) || /image\/(x-adobe-dng|x-olympus-orf|tiff)/i.test(file.type || '') || /\.(dng|orf|tiff?)$/i.test(file.name || '')) {
    return new Uint8Array(await file.slice(0, 8 << 20).arrayBuffer());
  }
  if (/hei[cf]/i.test(id)) return exifFromHeic(file);
  if (!/jpe?g/i.test(id)) return null;
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
      return buf.subarray(p + 10, p + 2 + len);
    }
    p += 2 + len;
  }
  return null;
}

/** The export's APP1/Exif segment: the input's tags (if readable; `log` says why not) with `desc` as ImageDescription. */
export async function exportExif(file, desc, log) {
  let tiff = null;
  try { tiff = await readTiff(file); } catch (e) { log('EXIF not read: ' + (e?.message || e)); }
  return exifSegmentOf(tiff, desc);
}

/** APP1/XMP segment with `desc` as dc:description and `keywords` as dc:subject (what Photos / Lightroom show as caption and keywords). */
export function xmpSegment(desc, keywords) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(desc)}</rdf:li></rdf:Alt></dc:description>` +
    `<dc:subject><rdf:Bag>${keywords.map((k) => `<rdf:li>${esc(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta>';
  const body = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmp), len = body.length + 2;
  const seg = new Uint8Array(len + 2);
  seg.set([0xFF, 0xE1, len >> 8, len & 255]);
  seg.set(body, 4);
  return seg;
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
  // IFD0's next-IFD link to 0: IFD1 is the original's thumbnail (the unprocessed photo, maybe the other orientation), which
  // galleries and upload pickers would show for this export. Its bytes stay in the segment, unreferenced.
  const ifd0 = u32(4), next = ifd0 + 2 + u16(ifd0) * 12;
  if (T + next + 4 <= seg.length) dv.setUint32(T + next, 0, le);
  let exifIfd = 0;
  walk(ifd0, (tag, e) => {
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

/** Insert an APP segment right after SOI (Exif must precede everything for iOS Photos), dropping a JFIF APP0 (Exif and JFIF must not coexist). */
export function insertExif(jpeg, seg) {
  const j = new Uint8Array(jpeg);
  let from = 2;
  if (j[2] === 0xFF && j[3] === 0xE0 && j[6] === 0x4A && j[7] === 0x46) from = 4 + ((j[4] << 8) | j[5]);
  const out = new Uint8Array(2 + seg.length + j.length - from);
  out.set(j.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(j.subarray(from), 2 + seg.length);
  return out;
}
