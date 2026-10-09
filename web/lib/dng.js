// DNG decoder for Adobe Project Indigo (and similar Bayer) raw files.
// Dependency-free ES module; runs in iOS Safari and node.
//
//   decodeDNG(arrayBuffer, { maxLongSide }) ->
//     { w, h, rgb: Float32Array (linear, interleaved RGB, Rec.2020 primaries, D65),
//       space: 'rec2020', exposure: BaselineExposure, meta }
//
// Pipeline: TIFF/IFD parse -> lossless JPEG (LJ92) tiles -> linearize (black/white,
// white balance from AsShotNeutral, highlight clip) -> Malvar-He-Cutler demosaic over
// the DefaultCrop only (or 2x2 superpixel binning when the target is <= half size)
// -> OpcodeList3 GainMap (lens shading) -> camera -> XYZ (ColorMatrix1/2 interpolated
// by CCT of AsShotNeutral, DNG spec; ForwardMatrix1/2 likewise when present, then
// no white estimate is needed) -> Bradford to D65 -> linear Rec.2020.
//
// Scale: the white-balanced sensor clip level of a neutral maps to 1.0 (diffuse
// white ~ 1 before BaselineExposure). Values are clamped >= 0. Blown highlights are
// clipped to neutral. Orientation is NOT applied (see meta.orientation).
//
// Unsupported (ignored): ProfileGainTableMap (52543/52544), semantic SubIFDs, XMP,
// opcodes other than GainMap, OpcodeList1/2.

// ---------------------------------------------------------------- TIFF / IFD

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

function parseTIFF(buf) {
  const dv = new DataView(buf);
  const bom = dv.getUint16(0, false);
  const le = bom === 0x4949;
  if (!le && bom !== 0x4d4d) throw new Error('DNG: not a TIFF file');
  if (dv.getUint16(2, le) !== 42) throw new Error('DNG: BigTIFF/unknown TIFF variant');

  function readIFD(off) {
    const n = dv.getUint16(off, le);
    const tags = new Map();
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
      const size = (TYPE_SIZE[type] || 1) * count;
      const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      tags.set(tag, { type, count, at });
    }
    return { tags, next: dv.getUint32(off + 2 + n * 12, le) };
  }

  function values(ifd, tag) {
    const t = ifd.tags.get(tag);
    if (!t) return null;
    const { type, count, at } = t;
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      switch (type) {
        case 1: case 7: out[i] = dv.getUint8(at + i); break;
        case 6: out[i] = dv.getInt8(at + i); break;
        case 3: out[i] = dv.getUint16(at + 2 * i, le); break;
        case 8: out[i] = dv.getInt16(at + 2 * i, le); break;
        case 4: case 13: out[i] = dv.getUint32(at + 4 * i, le); break;
        case 9: out[i] = dv.getInt32(at + 4 * i, le); break;
        case 5: { const d = dv.getUint32(at + 8 * i + 4, le); out[i] = d ? dv.getUint32(at + 8 * i, le) / d : 0; break; }
        case 10: { const d = dv.getInt32(at + 8 * i + 4, le); out[i] = d ? dv.getInt32(at + 8 * i, le) / d : 0; break; }
        case 11: out[i] = dv.getFloat32(at + 4 * i, le); break;
        case 12: out[i] = dv.getFloat64(at + 8 * i, le); break;
        default: out[i] = dv.getUint8(at + i);
      }
    }
    return out;
  }
  const one = (ifd, tag, def) => { const v = values(ifd, tag); return v ? v[0] : def; };
  const str = (ifd, tag) => {
    const t = ifd.tags.get(tag);
    if (!t) return '';
    let s = '';
    for (let i = 0; i < t.count; i++) { const c = dv.getUint8(t.at + i); if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  };
  const bytes = (ifd, tag) => {
    const t = ifd.tags.get(tag);
    return t ? new Uint8Array(buf, t.at, t.count * (TYPE_SIZE[t.type] || 1)) : null;
  };

  const ifd0 = readIFD(dv.getUint32(4, le));
  return { dv, le, ifd0, readIFD, values, one, str, bytes };
}

// ---------------------------------------------------------------- LJ92

const lutCache = new Map();
let unstuffBuf = null;

function huffLUT(b, p) {
  // b[p..p+15] = counts per code length, followed by symbols. Returns 64K LUT: (len<<8)|ssss.
  let total = 0;
  for (let i = 0; i < 16; i++) total += b[p + i];
  let key = '';
  for (let i = 0; i < 16 + total; i++) key += String.fromCharCode(b[p + i]);
  let lut = lutCache.get(key);
  if (!lut) {
    lut = new Uint16Array(65536); // 0 => invalid code
    let code = 0, s = p + 16;
    for (let len = 1; len <= 16; len++) {
      for (let k = 0; k < b[p + len - 1]; k++) {
        const sym = b[s++], shift = 16 - len, base = code << shift;
        lut.fill((len << 8) | sym, base, base + (1 << shift));
        code++;
      }
      code <<= 1;
    }
    if (lutCache.size > 16) lutCache.clear();
    lutCache.set(key, lut);
  }
  return { lut, size: 16 + total };
}

// Decodes one LJ92 stream; writes samples sequentially (row-major, components
// interleaved) into `out`. Returns { w, h, nc, n } (frame width/height/components).
function decodeLJ92(b, start, end, out) {
  let p = start;
  if (b[p] !== 0xff || b[p + 1] !== 0xd8) throw new Error('LJ92: missing SOI');
  p += 2;
  const tables = [];
  let P = 0, H = 0, W = 0, NC = 0, ri = 0, psv = 1, pt = 0;
  const compTable = [];
  for (;;) {
    if (p + 4 > end) throw new Error('LJ92: truncated header');
    if (b[p] !== 0xff) throw new Error('LJ92: bad marker');
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    const L = (b[p + 2] << 8) | b[p + 3];
    const q0 = p + 4;
    if (m === 0xc4) {
      for (let q = q0; q < p + 2 + L;) {
        const th = b[q] & 15;
        const t = huffLUT(b, q + 1);
        tables[th] = t.lut;
        q += 1 + t.size;
      }
    } else if (m === 0xc3) {
      P = b[q0]; H = (b[q0 + 1] << 8) | b[q0 + 2]; W = (b[q0 + 3] << 8) | b[q0 + 4]; NC = b[q0 + 5];
    } else if (m === 0xdd) {
      ri = (b[q0] << 8) | b[q0 + 1];
    } else if (m === 0xda) {
      const ns = b[q0];
      for (let i = 0; i < ns; i++) compTable[i] = tables[b[q0 + 2 + 2 * i] >> 4];
      psv = b[q0 + 1 + 2 * ns];
      pt = b[q0 + 3 + 2 * ns] & 15;
      p += 2 + L;
      break;
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('LJ92: unsupported SOF ' + m.toString(16));
    }
    p += 2 + L;
  }
  if (!NC || !W || !H) throw new Error('LJ92: missing SOF3');
  if (NC > 4 || compTable.length < NC) throw new Error('LJ92: unsupported scan');
  for (let c = 0; c < NC; c++) if (!compTable[c]) throw new Error('LJ92: missing Huffman table');
  if (ri && ri % W) throw new Error('LJ92: restart interval not row-aligned');
  const rowRestart = ri ? ri / W : 0;

  const rowLen = W * NC;
  const initPred = 1 << (P - pt - 1);
  const mask = (1 << P) - 1;
  const t0 = compTable[0], t1 = compTable[1] || t0, t2 = compTable[2] || t0, t3 = compTable[3] || t0;
  // un-stuff the entropy-coded segment (drop 0xFF00 stuffing; remember RSTn positions)
  if (!unstuffBuf || unstuffBuf.length < end - p + 16) unstuffBuf = new Uint8Array(((end - p) * 1.25 | 0) + 16);
  const u = unstuffBuf, rst = [];
  let n = 0;
  for (let q = p; q < end; q++) {
    const v = b[q];
    if (v !== 0xff) { u[n++] = v; continue; }
    const nx = b[q + 1];
    if (nx === 0) { u[n++] = 0xff; q++; }
    else if (nx >= 0xd0 && nx <= 0xd7) { rst.push(n); q++; }
    else if (nx !== 0xff) break; // EOI / other marker
  }
  u.fill(0, n, n + 16);
  let acc = 0, bits = 0, q = 0, nRst = 0;
  let firstRow = true;

  for (let row = 0; row < H; row++) {
    if (rowRestart && row && row % rowRestart === 0) {
      bits = 0; acc = 0; q = nRst < rst.length ? rst[nRst++] : q;
      firstRow = true;
    }
    const rb = row * rowLen;
    for (let i = 0, c = 0; i < rowLen; i++, c = c + 1 === NC ? 0 : c + 1) {
      if (bits < 16) { acc = (acc << 16) | (u[q] << 8) | u[q + 1]; q += 2; bits += 16; }
      const lut = c === 0 ? t0 : c === 1 ? t1 : c === 2 ? t2 : t3;
      const e = lut[(acc >>> (bits - 16)) & 0xffff];
      if (!e) throw new Error('LJ92: invalid Huffman code');
      bits -= e >> 8;
      const s = e & 255;
      let diff = 0;
      if (s === 16) diff = 32768;
      else if (s) {
        if (bits < s) { acc = (acc << 16) | (u[q] << 8) | u[q + 1]; q += 2; bits += 16; }
        diff = (acc >>> (bits - s)) & ((1 << s) - 1);
        bits -= s;
        if (diff < (1 << (s - 1))) diff -= (1 << s) - 1;
      }
      const idx = rb + i;
      let pred;
      if (i < NC) pred = firstRow ? initPred : out[idx - rowLen];
      else if (firstRow) pred = out[idx - NC];
      else {
        const ra = out[idx - NC], rbv = out[idx - rowLen], rc = out[idx - rowLen - NC];
        switch (psv) {
          case 1: pred = ra; break;
          case 2: pred = rbv; break;
          case 3: pred = rc; break;
          case 4: pred = ra + rbv - rc; break;
          case 5: pred = ra + ((rbv - rc) >> 1); break;
          case 6: pred = rbv + ((ra - rc) >> 1); break;
          case 7: pred = (ra + rbv) >> 1; break;
          default: pred = ra;
        }
      }
      out[idx] = (pred + diff) & mask;
    }
    firstRow = false;
  }
  if (pt) for (let i = 0, n = H * rowLen; i < n; i++) out[i] <<= pt;
  return { w: W, h: H, nc: NC, n: H * rowLen };
}

// ---------------------------------------------------------------- colour math

const mul3 = (A, B) => {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
};
const mulv = (A, v) => [0, 1, 2].map(i => A[i * 3] * v[0] + A[i * 3 + 1] * v[1] + A[i * 3 + 2] * v[2]);
const diag = v => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error('DNG: singular colour matrix');
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
          B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
          C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

const XYZ_TO_REC2020 = [1.7166512, -0.3556708, -0.2533663, -0.6666844, 1.6164812, 0.0157685, 0.0176399, -0.0427706, 0.9421031];
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const D65 = [0.95047, 1, 1.08883];
const D50 = [0.96422, 1, 0.82521];

// EXIF LightSource -> CCT (as in the DNG SDK)
const ILLUM_TEMP = { 1: 5500, 2: 4150, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6430, 13: 5000,
  14: 4150, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 };

// Robertson isotemperature lines: [mired, u, v, slope]
const ROBERTSON = [
  [0, 0.18006, 0.26352, -0.24341], [10, 0.18066, 0.26589, -0.25479], [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539], [40, 0.18293, 0.27407, -0.30470], [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156], [70, 0.18611, 0.28342, -0.37915], [80, 0.18740, 0.28668, -0.40955],
  [90, 0.18880, 0.28997, -0.44278], [100, 0.19032, 0.29326, -0.47888], [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471], [175, 0.20525, 0.31647, -0.84901], [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168], [250, 0.22511, 0.33439, -1.4512], [275, 0.23247, 0.33904, -1.7298],
  [300, 0.24010, 0.34308, -2.0637], [325, 0.24792, 0.34655, -2.4681], [350, 0.25591, 0.34951, -2.9641],
  [375, 0.26400, 0.35200, -3.5814], [400, 0.27218, 0.35407, -4.3633], [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262], [475, 0.29685, 0.35823, -8.5955], [500, 0.30505, 0.35907, -11.324],
  [525, 0.31320, 0.35968, -15.628], [550, 0.32129, 0.36011, -23.325], [575, 0.32931, 0.36038, -40.770],
  [600, 0.33724, 0.36051, -116.45]];

function xyToCCT(x, y) {
  const den = -2 * x + 12 * y + 3;
  const u = 4 * x / den, v = 6 * y / den;
  let dPrev = 0;
  for (let i = 0; i < ROBERTSON.length; i++) {
    const [mr, ui, vi, ti] = ROBERTSON[i];
    const d = ((v - vi) - ti * (u - ui)) / Math.sqrt(1 + ti * ti);
    if (i > 0 && (d <= 0) !== (dPrev <= 0)) {
      const m0 = ROBERTSON[i - 1][0];
      const mired = m0 + (mr - m0) * dPrev / (dPrev - d);
      return 1e6 / Math.max(mired, 1e-3);
    }
    dPrev = d;
  }
  return 1e6 / 600;
}

// DNG spec interpolation of a matrix pair by CCT (weight in 1/T, the lower-temperature
// illuminant first). A single matrix is used as is.
function blendByCCT(m1, m2, T1, T2, T) {
  if (!m2 || T1 === T2) return m1;
  let [A, B, lo, hi] = T1 < T2 ? [m1, m2, T1, T2] : [m2, m1, T2, T1];
  if (T <= lo) return A;
  if (T >= hi) return B;
  const g = (1 / T - 1 / hi) / (1 / lo - 1 / hi);
  return A.map((a, i) => g * a + (1 - g) * B[i]);
}

function buildColour(P, ifd, neutral) {
  const cm1 = P.values(ifd, 50721), cm2 = P.values(ifd, 50722);
  if (!cm1) throw new Error('DNG: no ColorMatrix1');
  const cc1 = P.values(ifd, 50723) || diag([1, 1, 1]);
  const cc2 = P.values(ifd, 50724) || diag([1, 1, 1]);
  const ab = P.values(ifd, 50727) || [1, 1, 1];
  const AB = diag(ab);
  const M1 = mul3(mul3(AB, cc1), cm1);
  const M2 = cm2 ? mul3(mul3(AB, cc2), cm2) : null;
  const fm1 = P.values(ifd, 50964), fm2 = P.values(ifd, 50965);   // ForwardMatrix1/2: camera -> XYZ D50
  const T1 = ILLUM_TEMP[P.one(ifd, 50778, 21)] || 6504, T2 = ILLUM_TEMP[P.one(ifd, 50779, 21)] || 6504;
  const interp = T => blendByCCT(M1, M2, T1, T2, T);
  // DNG SDK NeutralToXY: iterate CCT <-> matrix until the white point converges.
  let x = 0.3457, y = 0.3585, cct = 5003;
  for (let it = 0; it < 30; it++) {
    cct = xyToCCT(x, y);
    const XYZ = mulv(inv3(interp(cct)), neutral);
    const s = XYZ[0] + XYZ[1] + XYZ[2];
    const nx = XYZ[0] / s, ny = XYZ[1] / s;
    const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-7;
    x = nx; y = ny;
    if (done) break;
  }
  cct = xyToCCT(x, y);
  const maxN = Math.max(...neutral);
  let M;
  if (fm1) {
    // ForwardMatrix: white-balanced camera (neutral -> 1,1,1) straight to XYZ D50, so no
    // white estimate is needed. Our WB'd input is camera / neutral * maxN.
    const FM = blendByCCT(fm1, fm2, T1, T2, cct);
    M = mul3(mul3(mul3(XYZ_TO_REC2020, adaptBradford(D50, D65)), FM), diag([1 / maxN, 1 / maxN, 1 / maxN]));
  } else {
    const camToXYZ = inv3(interp(cct));
    const W = mulv(camToXYZ, neutral);
    const k = 1 / W[1];
    // camera WB'd RGB (clip=1) -> Rec.2020
    M = mul3(mul3(mul3(XYZ_TO_REC2020, adaptBradford([W[0] * k, 1, W[2] * k], D65)), camToXYZ), diag(neutral.map(n => n * k / maxN)));
  }
  return { M, cct, whiteXY: [x, y] };
}

/** Bradford chromatic adaptation matrix from white `from` to white `to` (XYZ). */
function adaptBradford(from, to) {
  const src = mulv(BRADFORD, from), dst = mulv(BRADFORD, to);
  return mul3(mul3(inv3(BRADFORD), diag([dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]])), BRADFORD);
}

// ---------------------------------------------------------------- GainMap (opcode 9)

function parseGainMaps(bytes) {
  if (!bytes || bytes.length < 4) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); // opcode lists are big-endian
  const n = dv.getUint32(0);
  const maps = [];
  let p = 4;
  for (let k = 0; k < n && p + 16 <= bytes.length; k++) {
    const id = dv.getUint32(p), size = dv.getUint32(p + 12), q = p + 16;
    if (id === 9) {
      const u = j => dv.getUint32(q + 4 * j);
      const g = {
        top: u(0), left: u(1), bottom: u(2), right: u(3), plane: u(4), planes: u(5),
        rowPitch: u(6) || 1, colPitch: u(7) || 1, nv: u(8), nh: u(9),
        spV: dv.getFloat64(q + 40), spH: dv.getFloat64(q + 48),
        orV: dv.getFloat64(q + 56), orH: dv.getFloat64(q + 64), mapPlanes: u(18),
      };
      const cnt = g.nv * g.nh * g.mapPlanes;
      g.gains = new Float32Array(cnt);
      for (let i = 0; i < cnt; i++) g.gains[i] = dv.getFloat32(q + 76 + 4 * i);
      maps.push(g);
    }
    p = q + size;
  }
  return maps;
}

// Prepares per-row gain evaluation for an output grid whose pixel (y, x) is centred at
// image coordinate (oy + step*(y+0.5), ox + step*(x+0.5)) of an imgW x imgH image.
function gainEvaluator(maps, imgW, imgH, ox, oy, step, outW) {
  const prepped = maps.map(g => {
    const i0s = new Int32Array(outW), i1s = new Int32Array(outW), colW = new Float32Array(outW);
    let any = false;
    for (let x = 0; x < outW; x++) {
      const cx = ox + step * (x + 0.5);
      const ix = Math.floor(cx);
      if (ix < g.left || ix >= g.right || (step === 1 && (ix - g.left) % g.colPitch)) {
        i0s[x] = i1s[x] = g.nh + 1; continue; // not covered
      }
      let f = (cx / imgW - g.orH) / g.spH;
      f = Math.min(Math.max(f, 0), g.nh - 1);
      const i0 = Math.min(Math.floor(f), Math.max(g.nh - 2, 0));
      i0s[x] = i0; i1s[x] = Math.min(i0 + 1, g.nh - 1); colW[x] = g.nh > 1 ? f - i0 : 0; any = true;
    }
    // runs of columns sharing one map cell: gain is linear in x within a run
    const segs = [];
    for (let x = 0; x < outW;) {
      if (i0s[x] > g.nh) { x++; continue; }
      let e = x + 1;
      while (e < outW && i0s[e] === i0s[x] && i1s[e] === i1s[x] && step * (e - x) === Math.floor(ox + step * (e + 0.5)) - Math.floor(ox + step * (x + 0.5)) && g.colPitch === 1) e++;
      segs.push({ xs: x, xe: e, i0: i0s[x], i1: i1s[x], w0: colW[x], dw: e - x > 1 ? (colW[e - 1] - colW[x]) / (e - 1 - x) : 0 });
      x = e;
    }
    const rows = [];
    for (let mp = 0; mp < g.mapPlanes; mp++) rows.push(new Float32Array(g.nh));
    return { g, segs, any, rows };
  });
  const gR = new Float32Array(outW), gG = new Float32Array(outW), gB = new Float32Array(outW);
  const planesOut = [gR, gG, gB];
  const mulRow = (dst, row, segs) => {
    for (let k = 0; k < segs.length; k++) {
      const sg = segs[k], a = row[sg.i0], d = row[sg.i1] - a, xe = sg.xe;
      let gv = a + d * sg.w0;
      const dg = d * sg.dw;
      for (let x = sg.xs; x < xe; x++) { dst[x] *= gv; gv += dg; }
    }
  };
  return function evalRow(y) {
    gR.fill(1); gG.fill(1); gB.fill(1);
    const cy = oy + step * (y + 0.5);
    const iy = Math.floor(cy);
    for (let k = 0; k < prepped.length; k++) {
      const pp = prepped[k], g = pp.g;
      if (!pp.any || iy < g.top || iy >= g.bottom || (step === 1 && (iy - g.top) % g.rowPitch)) continue;
      let f = (cy / imgH - g.orV) / g.spV;
      f = Math.min(Math.max(f, 0), g.nv - 1);
      const r0 = Math.min(Math.floor(f), Math.max(g.nv - 2, 0)), wv = g.nv > 1 ? f - r0 : 0;
      const r1 = Math.min(r0 + 1, g.nv - 1);
      const nh = g.nh, mps = g.mapPlanes, gains = g.gains;
      for (let mp = 0; mp < mps; mp++) {
        const row = pp.rows[mp];
        for (let h = 0; h < nh; h++) {
          const a = gains[(r0 * nh + h) * mps + mp], b = gains[(r1 * nh + h) * mps + mp];
          row[h] = a + (b - a) * wv;
        }
      }
      for (let pl = g.plane; pl < Math.min(g.plane + g.planes, 3); pl++)
        mulRow(planesOut[pl], pp.rows[Math.min(pl - g.plane, mps - 1)], pp.segs);
    }
    return planesOut;
  };
}

// ---------------------------------------------------------------- resample

// Area (box) downscale of interleaved RGB float image.
function areaResize(src, sw, sh, dw, dh) {
  const axis = (sn, dn) => {
    // per destination sample: list of (index, weight)
    const scale = sn / dn, idx = [], wts = [], start = new Int32Array(dn + 1);
    for (let d = 0; d < dn; d++) {
      start[d] = idx.length;
      const a = d * scale, b = a + scale;
      for (let s = Math.floor(a); s < Math.min(Math.ceil(b), sn); s++) {
        const w = Math.min(b, s + 1) - Math.max(a, s);
        if (w > 1e-6) { idx.push(s); wts.push(w / scale); }
      }
    }
    start[dn] = idx.length;
    return { idx: Int32Array.from(idx), wts: Float32Array.from(wts), start };
  };
  const ax = axis(sw, dw), ay = axis(sh, dh);
  const tmp = new Float32Array(dw * sh * 3);
  const xIdx = ax.idx, xW = ax.wts, xSt = ax.start;
  for (let y = 0; y < sh; y++) {
    const so = y * sw * 3, to = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = xSt[x], ke = xSt[x + 1]; k < ke; k++) {
        const i = so + xIdx[k] * 3, w = xW[k];
        r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w;
      }
      tmp[to + x * 3] = r; tmp[to + x * 3 + 1] = g; tmp[to + x * 3 + 2] = b;
    }
  }
  const out = new Float32Array(dw * dh * 3);
  const rowLen = dw * 3;
  for (let y = 0; y < dh; y++) {
    const oo = y * rowLen;
    for (let k = ay.start[y], ke = ay.start[y + 1]; k < ke; k++) {
      const so = ay.idx[k] * rowLen, w = ay.wts[k];
      for (let i = 0; i < rowLen; i++) out[oo + i] += tmp[so + i] * w;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Malvar-He-Cutler
// One CFA phase of one row: every other pixel starting at x0, CFA index i, output row offset ob.
// Fused with per-column gains (gR/gG/gB) and the 3x3 colour matrix M; clamps >= 0.

function mhcGreen(a, w, rgb, i, ob, x0, n, swap, gR, gG, gB, M) {
  const w2 = 2 * w;
  const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
  for (let x = x0; x < n; x += 2, i += 2) {
    const C0 = a[i], c5 = 5 * C0;
    const N2 = a[i - w2], S2 = a[i + w2], W2 = a[i - 2], E2 = a[i + 2];
    const dg = a[i - w - 1] + a[i - w + 1] + a[i + w - 1] + a[i + w + 1];
    const hv = (c5 + 4 * (a[i - 1] + a[i + 1]) - (W2 + E2) - dg + 0.5 * (N2 + S2)) * 0.125;
    const vv = (c5 + 4 * (a[i - w] + a[i + w]) - (N2 + S2) - dg + 0.5 * (W2 + E2)) * 0.125;
    let r = swap ? vv : hv, b = swap ? hv : vv;
    r = (r > 0 ? r : 0) * gR[x]; b = (b > 0 ? b : 0) * gB[x];
    const g = C0 * gG[x];
    const R = m0 * r + m1 * g + m2 * b, G = m3 * r + m4 * g + m5 * b, B = m6 * r + m7 * g + m8 * b;
    const o = ob + x * 3;
    rgb[o] = R > 0 ? R : 0; rgb[o + 1] = G > 0 ? G : 0; rgb[o + 2] = B > 0 ? B : 0;
  }
}

function mhcRB(a, w, rgb, i, ob, x0, n, swap, gR, gG, gB, M) {
  const w2 = 2 * w;
  const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
  for (let x = x0; x < n; x += 2, i += 2) {
    const C0 = a[i];
    const ax2 = a[i - w2] + a[i + w2] + a[i - 2] + a[i + 2];
    let g = (4 * C0 + 2 * (a[i - w] + a[i + w] + a[i - 1] + a[i + 1]) - ax2) * 0.125;
    let oo = (6 * C0 + 2 * (a[i - w - 1] + a[i - w + 1] + a[i + w - 1] + a[i + w + 1]) - 1.5 * ax2) * 0.125;
    g = (g > 0 ? g : 0) * gG[x];
    oo = oo > 0 ? oo : 0;
    const r = (swap ? oo : C0) * gR[x], b = (swap ? C0 : oo) * gB[x];
    const R = m0 * r + m1 * g + m2 * b, G = m3 * r + m4 * g + m5 * b, B = m6 * r + m7 * g + m8 * b;
    const o = ob + x * 3;
    rgb[o] = R > 0 ? R : 0; rgb[o + 1] = G > 0 ? G : 0; rgb[o + 2] = B > 0 ? B : 0;
  }
}

// ---------------------------------------------------------------- main

const PAD = 2;

export async function decodeDNG(arrayBuffer, { maxLongSide, _stage } = {}) {
  const buf = ArrayBuffer.isView(arrayBuffer)
    ? arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength)
    : arrayBuffer;
  const P = parseTIFF(buf);
  const ifd0 = P.ifd0;

  // locate the raw CFA IFD (IFD0 or a SubIFD)
  let raw = null;
  const isRaw = ifd => P.one(ifd, 254, 0) === 0 && P.one(ifd, 262, 0) === 32803;
  if (isRaw(ifd0)) raw = ifd0;
  else for (const off of P.values(ifd0, 330) || []) { const s = P.readIFD(off); if (isRaw(s)) { raw = s; break; } }
  if (!raw) throw new Error('DNG: no CFA raw image found');

  const W = P.one(raw, 256), H = P.one(raw, 257);
  const bps = P.one(raw, 258, 16), comp = P.one(raw, 259, 1);
  const cfaDim = P.values(raw, 33421) || [2, 2];
  const cfaPat = P.values(raw, 33422);
  if (cfaDim[0] !== 2 || cfaDim[1] !== 2 || !cfaPat) throw new Error('DNG: only 2x2 Bayer CFA supported');
  const colorAt = (y, x) => cfaPat[(y & 1) * 2 + (x & 1)];

  // levels
  const blDim = P.values(raw, 50713) || [1, 1];
  const blv = P.values(raw, 50714) || [0];
  const blackAt = (y, x) => blv[((y % blDim[0]) * blDim[1] + (x % blDim[1])) % blv.length];
  const white = (P.values(raw, 50717) || [(1 << bps) - 1])[0];
  const dH = P.values(raw, 50715), dVv = P.values(raw, 50716);
  const linTable = P.values(raw, 50712);
  const aa = P.values(raw, 50829) || [0, 0, H, W]; // top, left, bottom, right
  const [aT, aL] = aa;
  const aW = aa[3] - aa[1], aH = aa[2] - aa[0];
  const cOrig = P.values(raw, 50719) || [0, 0]; // x, y (relative to active area)
  const cSize = P.values(raw, 50720) || [aW, aH];
  let cx = Math.round(cOrig[0]), cy = Math.round(cOrig[1]);
  let cw = Math.min(Math.round(cSize[0]), aW - cx), ch = Math.min(Math.round(cSize[1]), aH - cy);

  const neutral = (P.values(ifd0, 50728) || [1, 1, 1]).slice(0, 3);
  const maxN = Math.max(...neutral);
  const wb = neutral.map(n => maxN / n); // >= 1, min = 1
  const baseline = P.one(ifd0, 50730, 0);

  // ---- decode + linearize into padded Uint16 CFA (WB'd, clip -> 65535)
  const PW = aW + 2 * PAD, PH = aH + 2 * PAD;
  const cfa = _stage === 'raw' ? null : new Uint16Array(PW * PH);
  const rawOut = _stage === 'raw' ? new Uint16Array(W * H) : null;
  const u8 = new Uint8Array(buf);
  const lin = linTable ? Uint16Array.from(linTable) : null;
  // per-phase black & scale (black repeat dims dividing 2 are exact; DeltaH/V added per pixel)
  const scaleC = [0, 1, 2].map(c => wb[c] * 65535 / (white - blackAt(0, 0)));
  const put = (tile, tw, th, x0, y0) => {
    const xe = Math.min(x0 + tw, W), ye = Math.min(y0 + th, H);
    if (rawOut) {
      for (let y = y0; y < ye; y++) rawOut.set(tile.subarray((y - y0) * tw, (y - y0) * tw + xe - x0), y * W + x0);
      return;
    }
    for (let y = Math.max(y0, aT); y < Math.min(ye, aT + aH); y++) {
      const ay = y - aT;
      const dv = dVv ? dVv[ay] || 0 : 0;
      const po = (ay + PAD) * PW + PAD - aL;
      const to = (y - y0) * tw - x0;
      const b0 = blackAt(ay, 0) + dv, b1 = blackAt(ay, 1) + dv;
      const s0 = scaleC[colorAt(ay, 0)] * (white - blackAt(0, 0)) / (white - b0);
      const s1 = scaleC[colorAt(ay, 1)] * (white - blackAt(0, 0)) / (white - b1);
      const xs = Math.max(x0, aL), xe2 = Math.min(xe, aL + aW);
      if (!lin && !dH) {
        // hot path: per-phase constants, Uint16Array store truncates (+0.5 rounds)
        let x = xs;
        if ((x - aL) & 1) { const f = (tile[to + x] - b1) * s1; cfa[po + x] = f <= 0 ? 0 : f >= 65535 ? 65535 : f + 0.5; x++; }
        for (; x + 1 < xe2; x += 2) {
          const f0 = (tile[to + x] - b0) * s0, f1 = (tile[to + x + 1] - b1) * s1;
          cfa[po + x] = f0 <= 0 ? 0 : f0 >= 65535 ? 65535 : f0 + 0.5;
          cfa[po + x + 1] = f1 <= 0 ? 0 : f1 >= 65535 ? 65535 : f1 + 0.5;
        }
        if (x < xe2) { const f = (tile[to + x] - b0) * s0; cfa[po + x] = f <= 0 ? 0 : f >= 65535 ? 65535 : f + 0.5; }
        continue;
      }
      for (let x = xs; x < xe2; x++) {
        let v = tile[to + x];
        if (lin) v = lin[v < lin.length ? v : lin.length - 1];
        const odd = (x - aL) & 1;
        const f = (v - (odd ? b1 : b0) - (dH ? dH[x - aL] || 0 : 0)) * (odd ? s1 : s0);
        cfa[po + x] = f <= 0 ? 0 : f >= 65535 ? 65535 : f + 0.5;
      }
    }
  };

  const tw = P.one(raw, 322, 0), th = P.one(raw, 323, 0);
  let offs, cnts, segW, segH;
  if (tw) { offs = P.values(raw, 324); cnts = P.values(raw, 325); segW = tw; segH = th; }
  else { offs = P.values(raw, 273); cnts = P.values(raw, 279); segW = W; segH = P.one(raw, 278, H); }
  const across = Math.ceil(W / segW);
  const tileBuf = new Uint16Array(segW * segH * 2);
  for (let t = 0; t < offs.length; t++) {
    const x0 = (t % across) * segW, y0 = Math.floor(t / across) * segH;
    if (comp === 7) {
      const r = decodeLJ92(u8, offs[t], offs[t] + cnts[t], tileBuf);
      if (r.n < segW * segH && r.n < segW * Math.min(segH, H - y0)) throw new Error('LJ92: tile size mismatch');
    } else if (comp === 1 && bps === 16) {
      const n = Math.min(cnts[t] >> 1, tileBuf.length);
      const dv = new DataView(buf, offs[t], n * 2);
      for (let i = 0; i < n; i++) tileBuf[i] = dv.getUint16(2 * i, P.le);
    } else throw new Error('DNG: unsupported compression ' + comp + '/' + bps + ' bit');
    put(tileBuf, segW, segH, x0, y0);
  }

  const meta = {
    make: P.str(ifd0, 271), model: P.str(ifd0, 272), uniqueModel: P.str(ifd0, 50708),
    orientation: P.one(ifd0, 274, 1), baselineExposure: baseline, asShotNeutral: neutral,
    blackLevel: blv, whiteLevel: white, cfaPattern: cfaPat, rawW: W, rawH: H, crop: [cx, cy, cw, ch],
  };
  const exifOff = P.one(ifd0, 34665, 0);
  if (exifOff) {
    const ex = P.readIFD(exifOff);
    meta.exposureTime = P.one(ex, 33434, undefined);
    meta.fNumber = P.one(ex, 33437, undefined);
    meta.iso = P.one(ex, 34855, undefined);
    meta.focalLength = P.one(ex, 37386, undefined);
    meta.dateTimeOriginal = P.str(ex, 36867) || undefined;
  }
  if (rawOut) return { w: W, h: H, raw: rawOut, meta };

  // reflect-101 padding (preserves CFA phase)
  for (let y = PAD; y < PH - PAD; y++) {
    const o = y * PW;
    for (let k = 1; k <= PAD; k++) { cfa[o + PAD - k] = cfa[o + PAD + k]; cfa[o + PW - 1 - PAD + k] = cfa[o + PW - 1 - PAD - k]; }
  }
  for (let k = 1; k <= PAD; k++) {
    cfa.copyWithin((PAD - k) * PW, (PAD + k) * PW, (PAD + k + 1) * PW);
    cfa.copyWithin((PH - 1 - PAD + k) * PW, (PH - 1 - PAD - k) * PW, (PH - PAD - k) * PW);
  }

  // ---- colour
  const camera = _stage === 'camera';
  const col = buildColour(P, ifd0, neutral);
  const s = 1 / 65535;
  const M = camera ? diag([s, s, s]) : col.M.map(v => v * s);
  meta.cct = col.cct; meta.whiteXY = col.whiteXY; meta.cameraToRec2020 = col.M;
  const maps = camera ? [] : parseGainMaps(P.bytes(raw, 51022) || P.bytes(ifd0, 51022));
  meta.gainMaps = maps.length;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = M;

  const halfW = cw >> 1, halfH = ch >> 1;
  const target = maxLongSide && maxLongSide < Math.max(cw, ch) ? maxLongSide : 0;
  const useBin = target && target <= Math.max(halfW, halfH);
  let outW, outH, rgb;

  if (useBin) {
    // 2x2 superpixel binning over the crop
    outW = halfW; outH = halfH;
    rgb = new Float32Array(outW * outH * 3);
    const gain = gainEvaluator(maps, aW, aH, cx, cy, 2, outW);
    // within a 2x2 block at even offsets: positions of R, B, and the two G
    const pos = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([dy, dx]) => ({ c: colorAt(cy + dy, cx + dx), o: dy * PW + dx }));
    const oR = pos.find(q => q.c === 0).o, oB = pos.find(q => q.c === 2).o;
    const gs = pos.filter(q => q.c === 1).map(q => q.o);
    const oG1 = gs[0], oG2 = gs[1];
    for (let y = 0; y < outH; y++) {
      const [gR, gG, gB] = gain(y);
      let i = (cy + 2 * y + PAD) * PW + cx + PAD, o = y * outW * 3;
      for (let x = 0; x < outW; x++, i += 2, o += 3) {
        const r = cfa[i + oR] * gR[x], g = (cfa[i + oG1] + cfa[i + oG2]) * 0.5 * gG[x], b = cfa[i + oB] * gB[x];
        const R = m0 * r + m1 * g + m2 * b, G = m3 * r + m4 * g + m5 * b, B = m6 * r + m7 * g + m8 * b;
        rgb[o] = R > 0 ? R : 0; rgb[o + 1] = G > 0 ? G : 0; rgb[o + 2] = B > 0 ? B : 0;
      }
    }
  } else {
    // Malvar-He-Cutler demosaic over the crop, fused with gain map + colour matrix
    outW = cw; outH = ch;
    rgb = new Float32Array(outW * outH * 3);
    const gain = gainEvaluator(maps, aW, aH, cx, cy, 1, outW);
    const a = cfa, w = PW;
    for (let y = 0; y < outH; y++) {
      const [gR, gG, gB] = gain(y);
      const Y = cy + y;
      const rowBase = (Y + PAD) * PW + PAD;
      for (let ph = 0; ph < 2; ph++) {
        const X0 = cx + ph;
        const c = colorAt(Y, X0);
        // green sites: swap=1 when R is vertical; R/B sites: swap=1 at blue
        const swap = c === 1 ? (colorAt(Y, X0 + 1) === 0 ? 0 : 1) : (c === 2 ? 1 : 0);
        (c === 1 ? mhcGreen : mhcRB)(a, w, rgb, rowBase + X0, y * outW * 3, ph, outW, swap, gR, gG, gB, M);
      }
    }
  }

  if (target && Math.max(outW, outH) > target) {
    const k = target / Math.max(outW, outH);
    const dw = Math.max(1, Math.round(outW * k)), dh = Math.max(1, Math.round(outH * k));
    rgb = areaResize(rgb, outW, outH, dw, dh);
    outW = dw; outH = dh;
  }

  return { w: outW, h: outH, rgb, space: camera ? 'camera' : 'rec2020', exposure: baseline, meta };
}
