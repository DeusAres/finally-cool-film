// Olympus ORF decoder (12-bit Olympus-compressed Bayer: XZ, PEN, E-, OM-D up to E-M1 III).
// Dependency-free ES module; same output contract as dng.js decodeDNG:
//   decodeORF(arrayBuffer, { maxLongSide }) -> { w, h, rgb (linear Rec.2020, D65), space, exposure: 0, meta }
//
// Pipeline: TIFF ('IIRO') + Olympus MakerNote (ImageProcessing: black, WB, crop) -> Olympus lossless
// decompression (dcraw olympus_load_raw: per-column-parity adaptive Golomb-like code + median-ish
// predictor on the same-colour neighbours) -> linearize as dng.js -> dng.js developCFA, colour from the
// Adobe ColorMatrix of the model (XYZ D65 -> camera, as dcraw / LibRaw adobe_coeff, /10000).
// Not supported: 14-bit ORF of the OM-1 generation (another codec), lens corrections.

import { parseTIFF, tiffMagic, cameraColour, developCFA, PAD } from './dng.js';

/** Adobe ColorMatrix (D65) per Olympus model, x10000, from LibRaw's colordata (Adobe DNG Converter values). */
const ADOBE = {
  'E-1': [11846, -4767, -945, -7027, 15878, 1089, -2699, 4122, 8311],
  'E-3': [9487, -2875, -1115, -7533, 15606, 2010, -1618, 2100, 7389],
  'E-5': [11200, -3783, -1325, -4576, 12593, 2206, -695, 1742, 7504],
  'E-30': [8144, -1861, -1111, -7763, 15894, 1929, -1865, 2542, 7607],
  'E-300': [7828, -1761, -348, -5788, 14071, 1830, -2853, 4518, 6557],
  'E-330': [8961, -2473, -1084, -7979, 15990, 2067, -2319, 3035, 8249],
  'E-400': [6169, -1483, -21, -7107, 14761, 2536, -2904, 3580, 8568],
  'E-410': [8856, -2582, -1026, -7761, 15766, 2082, -2009, 2575, 7469],
  'E-420': [8746, -2425, -1095, -7594, 15612, 2073, -1780, 2309, 7416],
  'E-450': [8745, -2425, -1095, -7594, 15613, 2073, -1780, 2309, 7416],
  'E-500': [8136, -1968, -299, -5481, 13742, 1871, -2556, 4205, 6630],
  'E-510': [8785, -2529, -1033, -7639, 15624, 2112, -1783, 2300, 7817],
  'E-520': [8344, -2322, -1020, -7596, 15635, 2048, -1748, 2269, 7287],
  'E-600': [8453, -2198, -1092, -7609, 15681, 2008, -1725, 2337, 7824],
  'E-620': [8453, -2198, -1092, -7609, 15681, 2008, -1725, 2337, 7824],
  'E-P1': [8343, -2050, -1021, -7715, 15705, 2103, -1831, 2380, 8235],
  'E-P2': [8343, -2050, -1021, -7715, 15705, 2103, -1831, 2380, 8235],
  'E-P3': [7575, -2159, -571, -3722, 11341, 2725, -1434, 2819, 6271],
  'E-P5': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-P7': [9476, -3182, -765, -2613, 10958, 1893, -449, 1315, 5268],
  'E-PL1': [11408, -4289, -1215, -4286, 12385, 2118, -387, 1467, 7787],
  'E-PL1s': [11409, -3872, -1393, -4572, 12757, 2003, -709, 1810, 7415],
  'E-PL2': [15030, -5552, -1806, -3987, 12387, 1767, -592, 1670, 7023],
  'E-PL3': [7575, -2159, -571, -3722, 11341, 2725, -1434, 2819, 6271],
  'E-PL5': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-PL6': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-PL7': [9197, -3190, -659, -2606, 10830, 2039, -458, 1250, 5458],
  'E-PL8': [9197, -3190, -659, -2606, 10830, 2039, -458, 1250, 5458],
  'E-PL9': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-PL10': [9197, -3190, -659, -2606, 10830, 2039, -458, 1250, 5458],
  'E-PM1': [7575, -2159, -571, -3722, 11341, 2725, -1434, 2819, 6271],
  'E-PM2': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-M1': [7687, -1984, -606, -4327, 11928, 2721, -1381, 2339, 6452],
  'E-M1MarkII': [9383, -3170, -763, -2457, 10702, 2020, -384, 1236, 5552],
  'E-M1MarkIII': [11896, -5110, -1076, -3181, 11378, 2048, -519, 1224, 5166],
  'E-M1X': [11896, -5110, -1076, -3181, 11378, 2048, -519, 1224, 5166],
  'E-M5': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-M5MarkII': [9422, -3258, -711, -2655, 10898, 2015, -512, 1354, 5512],
  'E-M5MarkIII': [11896, -5110, -1076, -3181, 11378, 2048, -519, 1224, 5166],
  'E-M10': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-M10MarkII': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-M10MarkIII': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-M10MarkIIIS': [8380, -2630, -639, -2887, 10725, 2496, -627, 1427, 5438],
  'E-M10MarkIV': [9476, -3182, -765, -2613, 10958, 1893, -449, 1315, 5268],
  'OM-5': [11896, -5110, -1076, -3181, 11378, 2048, -519, 1224, 5166],
  'PEN-F': [9476, -3182, -765, -2613, 10958, 1893, -449, 1315, 5268],
  'SH-2': [10156, -3425, -1077, -2611, 11177, 1624, -385, 1592, 5080],
  'STYLUS1': [8360, -2420, -880, -3928, 12353, 1739, -1381, 2416, 5173],
  'STYLUS1,1s': [8360, -2420, -880, -3928, 12353, 1739, -1381, 2416, 5173],
  'TG-4': [11426, -4159, -1126, -2066, 10678, 1593, -120, 1327, 4998],
  'TG-5': [10899, -3833, -1082, -2112, 10736, 1575, -267, 1452, 5269],
  'TG-6': [10899, -3833, -1082, -2112, 10736, 1575, -267, 1452, 5269],
  'TG-7': [10899, -3833, -1082, -2112, 10736, 1575, -267, 1452, 5269],
  'XZ-1': [10901, -4095, -1074, -1141, 9208, 2293, -62, 1417, 5158],
  'XZ-2': [9777, -3483, -925, -2886, 11297, 1800, -602, 1663, 5134],
  'XZ-10': [9777, -3483, -925, -2886, 11297, 1800, -602, 1663, 5134],
};

/** An Olympus ORF header (first 4 bytes: 'IIRO' / 'IIRS' / 'MMOR'): a TIFF with its own magic. */
export const isORFHeader = (h) => tiffMagic(h) > 42;

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/** IFD reader for the MakerNote, whose value offsets are relative to `base` (new-style 'OLYMPUS\0' header). */
function makerIFD(dv, le, off, base) {
  const n = dv.getUint16(off, le), tags = new Map();
  for (let i = 0; i < n; i++) {
    const e = off + 2 + 12 * i, type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] || 1) * count;
    tags.set(dv.getUint16(e, le), { type, count, at: size <= 4 ? e + 8 : base + dv.getUint32(e + 8, le), raw: dv.getUint32(e + 8, le) });
  }
  const values = (tag) => {
    const t = tags.get(tag);
    if (!t) return null;
    const out = [];
    for (let i = 0; i < t.count; i++) {
      out.push(t.type === 3 ? dv.getUint16(t.at + 2 * i, le) : t.type === 8 ? dv.getInt16(t.at + 2 * i, le)
        : t.type === 4 || t.type === 13 ? dv.getUint32(t.at + 4 * i, le) : dv.getUint8(t.at + i));
    }
    return out;
  };
  return { tags, values };
}

/** Olympus MakerNote -> ImageProcessing sub-IFD (black, WB, crop), or null. */
function imageProcessing(P, exif) {
  const mn = exif.tags.get(0x927c);
  if (!mn) return null;
  const dv = P.dv, p = mn.at, id = String.fromCharCode(...new Uint8Array(dv.buffer, p, 8));
  // new style: 'OLYMPUS\0' + byte order + version, offsets relative to the MakerNote; old style 'OLYMP\0': absolute
  const isNew = id === 'OLYMPUS\0', base = isNew ? p : 0;
  const le = isNew ? dv.getUint16(p + 8, false) === 0x4949 : P.le;
  const root = makerIFD(dv, le, p + (isNew ? 12 : 8), base);
  const ip = root.tags.get(0x2040);
  if (!ip) return null;
  // type 13 (IFD) or 4/7: the value is the sub-IFD offset, relative to the MakerNote base
  return makerIFD(dv, le, base + ip.raw, base);
}

/**
 * Olympus 12-bit lossless decompression (dcraw olympus_load_raw), into a W x H Uint16Array.
 * Bitstream MSB first from `off` + 7; per column parity an adaptive code: 3 bits (sign, low 2 bits),
 * a unary high part (12 zeros: escape to a raw field), nbits of mantissa; prediction from W, N, NW
 * same-colour neighbours (2 px away).
 */
function olympusDecompress(u8, off, end, W, H) {
  const out = new Uint16Array(W * H);
  let pos = off + 7, buf = 0, vb = 0, errors = 0;
  const peek = (n) => {
    while (vb < n) { buf = ((buf << 8) | (pos < end ? u8[pos++] : 0)) >>> 0; vb += 8; }
    return (buf >>> (vb - n)) & ((1 << n) - 1);
  };
  const bits = (n) => { if (!n) return 0; const v = peek(n); vb -= n; return v; };
  const carry = [new Int32Array(3), new Int32Array(3)];
  for (let row = 0; row < H; row++) {
    carry[0].fill(0); carry[1].fill(0);
    const o = row * W;
    for (let col = 0; col < W; col++) {
      const c = carry[col & 1];
      const i = c[2] < 3 ? 2 : 0;
      let nbits = 2 + i;
      while ((c[0] & 0xffff) >>> (nbits + i)) nbits++;
      const s3 = bits(3), low = s3 & 3, sign = s3 & 4 ? -1 : 0;
      // unary high part: count leading zeros of the next 12 bits (12 zeros = escape, 12 bits consumed)
      const look = peek(12), lz = Math.clz32(look) - 20;
      vb -= lz === 12 ? 12 : lz + 1;
      const high = lz === 12 ? bits(16 - nbits) >> 1 : lz;
      c[0] = (high << nbits) | bits(nbits);
      const diff = (c[0] ^ sign) + c[1];
      c[1] = (diff * 3 + c[1]) >> 5;
      c[2] = c[0] > 16 ? 0 : c[2] + 1;
      let pred;
      if (row < 2 && col < 2) pred = 0;
      else if (row < 2) pred = out[o + col - 2];
      else if (col < 2) pred = out[o - 2 * W + col];
      else {
        const w = out[o + col - 2], n = out[o - 2 * W + col], nw = out[o - 2 * W + col - 2];
        if ((w < nw && nw < n) || (n < nw && nw < w)) {
          pred = Math.abs(w - nw) > 32 || Math.abs(n - nw) > 32 ? w + n - nw : (w + n) >> 1;
        } else pred = Math.abs(w - nw) > Math.abs(n - nw) ? w : n;
      }
      const v = pred + ((diff << 2) | low);
      if (v >>> 12) { errors++; out[o + col] = v < 0 ? 0 : 4095; } else out[o + col] = v;
    }
  }
  return { out, errors };
}

/**
 * Raw level where the sensor saturates. Olympus sensors clip below the 12-bit maximum (XZ-1 at ISO 100: 3971 of
 * 4095), seen as a pile of pixels at the top of the histogram, far denser than the bins just below it. Returns the
 * bottom of that pile, or `white` when there is none (nothing clipped). Without it a blown highlight stops at ~0.97
 * of the per-channel sensor white, the highlight recovery (dng.js satLift) only half engages and the raw R/B WB
 * gains turn it magenta.
 */
function clipLevel(raw, white) {
  const h = new Uint32Array(white + 1);
  for (let i = 0; i < raw.length; i++) h[raw[i]]++;   // decoder output is <= white
  let top = white;
  while (top > 0 && !h[top]) top--;
  if (top < 0.75 * white) return white;
  let ref = 0;
  for (let v = top - 24; v < top - 8; v++) ref += h[v];
  const thr = ref / 2 + 4;   // 8x the mean density of the 16 bins below
  let lo = top, pile = 0;
  while (lo > top - 8 && h[lo] > thr) pile += h[lo--];
  return pile >= 64 ? lo + 1 : white;
}

export async function decodeORF(arrayBuffer, { maxLongSide } = {}) {
  const buf = ArrayBuffer.isView(arrayBuffer)
    ? arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength)
    : arrayBuffer;
  const P = parseTIFF(buf), ifd0 = P.ifd0, u8 = new Uint8Array(buf);
  const model = P.str(ifd0, 272), make = P.str(ifd0, 271);
  const W = P.one(ifd0, 256), H = P.one(ifd0, 257), comp = P.one(ifd0, 259, 1);
  const offs = P.values(ifd0, 273), cnts = P.values(ifd0, 279);
  if (!W || !H || !offs || offs.length !== 1) throw new Error('ORF: raw strip not found');
  // dcraw: Olympus-compressed when the strip is far smaller than 16 bit/px
  // Olympus-compressed (dcraw: 16 bps tag, strip far smaller than 12-bit packed); packed/unpacked ORF not handled
  if (comp !== 1 || cnts[0] * 2 >= W * H * 3) throw new Error(`ORF: formato non supportato (${model})`);
  // a cut-short file (interrupted copy / download) would decode its missing rows from zero bytes, without errors
  if (offs[0] + cnts[0] > u8.length) throw new Error('ORF: file incompleto (troncato)');
  const exifOff = P.one(ifd0, 34665, 0), exif = exifOff ? P.readIFD(exifOff) : null;
  const ip = exif && imageProcessing(P, exif);
  if (!ip) throw new Error('ORF: MakerNote Olympus mancante');
  const validBits = (ip.values(0x0611) || [12])[0];
  if (validBits !== 12) throw new Error(`ORF a ${validBits} bit non supportato (${model})`);
  const adobe = ADOBE[model.replace(/\s+/g, '')];
  if (!adobe) throw new Error(`ORF: modello non supportato (${model})`);

  // levels and white balance (ImageProcessing: BlackLevel2 per CFA position, WB_RBLevels / 256)
  const bl = ip.values(0x0600) || [0, 0, 0, 0];
  const rb = ip.values(0x0100) || [256, 256, 256, 256];
  const white = (1 << validBits) - 1;
  const cfaPat = [0, 1, 1, 2];   // RGGB (dcraw's default for Olympus)
  const colorAt = (y, x) => cfaPat[(y & 1) * 2 + (x & 1)];
  const black = [bl[0], (bl[1] + bl[2]) / 2, bl[3]];
  const wb = [rb[0] / 256, 1, rb[1] / 256];
  const neutral = wb.map((g) => 1 / g);
  const wbMax = Math.max(...wb);

  // crop as the camera's JPEG (ImageProcessing 0x0612..0x0615: left, top, width, height)
  let cx = (ip.values(0x0612) || [0])[0], cy = (ip.values(0x0613) || [0])[0];
  let cw = (ip.values(0x0614) || [W])[0], ch = (ip.values(0x0615) || [H])[0];
  if (cx + cw > W || cy + ch > H || cw < W / 2 || ch < H / 2) { cx = 0; cy = 0; cw = W; ch = H; }
  cx &= ~1; cy &= ~1;   // keep the CFA phase of the crop origin

  const { out: raw, errors } = olympusDecompress(u8, offs[0], offs[0] + cnts[0], W, H);
  if (errors > W * H * 1e-4) throw new Error('ORF: dati compressi non validi');

  // linearize into the padded CFA, as dng.js put(): (v - black) * wb[c] / wbMax, sensor white = 65535
  const PW = W + 2 * PAD, PH = H + 2 * PAD, cfa = new Uint16Array(PW * PH);
  // clipped photosites (>= the measured clip level) go to exactly the channel's sensor white, the level the
  // highlight recovery expects; the scale of everything below is unchanged (white = 2^bits - 1)
  const scale = [0, 1, 2].map((c) => (wb[c] / wbMax) * 65535 / (white - black[c]));
  const clip = clipLevel(raw, white), sat = wb.map((g) => Math.ceil((g / wbMax) * 65535));
  for (let y = 0; y < H; y++) {
    const po = (y + PAD) * PW + PAD, ro = y * W;
    for (let x = 0; x < W; x++) {
      const v = raw[ro + x], c = colorAt(y, x), f = (v - black[c]) * scale[c];
      cfa[po + x] = v >= clip ? sat[c] : f <= 0 ? 0 : f >= 65535 ? 65535 : f + 0.5;
    }
  }

  const col = cameraColour({ cm1: adobe.map((v) => v / 10000) }, neutral);
  const meta = {
    make, model, orientation: P.one(ifd0, 274, 1), asShotNeutral: neutral, blackLevel: bl, whiteLevel: white, clipLevel: clip,
    cfaPattern: cfaPat, rawW: W, rawH: H, crop: [cx, cy, cw, ch], cct: col.cct, whiteXY: col.whiteXY,
    cameraToRec2020: col.M, gainMaps: 0, decodeErrors: errors,
  };
  if (exif) {
    meta.exposureTime = P.one(exif, 33434, undefined);
    meta.fNumber = P.one(exif, 33437, undefined);
    meta.iso = P.one(exif, 34855, undefined);
    meta.focalLength = P.one(exif, 37386, undefined);
    meta.dateTimeOriginal = P.str(exif, 36867) || undefined;
  }
  const res = developCFA({ cfa, PW, PH, aW: W, aH: H, cx, cy, cw, ch, colorAt, wb, M: col.M, maps: [], maxLongSide });
  return { ...res, space: 'rec2020', exposure: 0, meta };
}
