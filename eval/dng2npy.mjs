// DNG -> linear Rec.2020 float32 .npy (HxWx3), using the app's own decoder (web/lib/dng.js).
// Also writes <out>.thumb.npy and <out>.json (baseline, under, indoor) for `sf-eval image --meta`.
// usage: node eval/dng2npy.mjs <in.dng> <out.npy> [maxLongSide] [--interno]
// --interno: meta gets under (U), gains (as-shot light vs D55, Rec.2020) and grain from web/lib/interno.js, as the app's toggle.
import { readFileSync, writeFileSync } from 'node:fs';
import { isRaw, loadRaw, rawThumb } from '../web/lib/raw.js';
import { readExposure } from '../web/lib/exif.js';
import { internoParams } from '../web/lib/interno.js';
import { THUMB_PX } from '../web/lib/common.js';

const args = process.argv.slice(2), withInterno = args.includes('--interno');
const [input, output, maxLongSide] = args.filter((a) => !a.startsWith('--'));
if (!input || !output) {
  console.error('usage: node eval/dng2npy.mjs <in.dng> <out.npy> [maxLongSide]');
  process.exit(1);
}

// Same steps as the app's raw path (web/app.js): loadRaw (decode + EXIF orientation via rawThumb's index
// mapping), thumb for AutoSetup (rawThumb at THUMB_PX), Interno from EXIF (readExposure).
const buf = readFileSync(input);
const file = new File([buf], input.split('/').pop());
const raw = await loadRaw(file, maxLongSide ? +maxLongSide : 2000);   // app preview size = 2000
if (!(await isRaw(file))) throw new Error('not a DNG');
const { w, h, rgb } = rawThumb(raw, 1e9);       // scale 1: oriented full copy, sensor values (no baseline)
const thumb = rawThumb(raw, THUMB_PX);
const exp = await readExposure(file);
// app.js underExposure(), CAMERA = { iso: 200, N: 2.8, tMax: 1/30 }, MAX_UNDER_EV = 2 (app.js is DOM-bound, not importable).
const evCam = Math.log2(2.8 ** 2 * 30) - Math.log2(2);
let ev100 = null;
if (exp) ev100 = Math.log2(exp.N ** 2 / exp.t) - Math.log2(exp.iso / 100);
if (ev100 === null && exp?.bv != null) ev100 = exp.bv + 5;
const under = ev100 !== null ? Math.min(2, Math.max(0, evCam - ev100)) : 0;
const meta = { baseline: raw.baseline, orientation: raw.orientation, under, indoor: under >= 1, ev100 };
if (withInterno) {
  const ip = internoParams({ under, isRaw: true, cctK: raw.cct });
  Object.assign(meta, { cct: raw.cct, interno: true, under: ip.under, gains: ip.gains, grain: ip.grain });
}
writeFileSync(output.replace(/\.npy$/, '') + '.json', JSON.stringify(meta));

// npy v1.0: magic, version, u16 header length, dict padded so the data starts 64-byte aligned.
function npy(path, w, h, rgb) {
let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${h}, ${w}, 3), }`;
header += ' '.repeat((64 - ((10 + header.length + 1) % 64)) % 64) + '\n';
const head = Buffer.alloc(10 + header.length);
head.write('\x93NUMPY', 0, 'latin1');
head.writeUInt8(1, 6);
head.writeUInt16LE(header.length, 8);
head.write(header, 10, 'latin1');
writeFileSync(path, Buffer.concat([head, Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)]));
}
npy(output, w, h, rgb);
npy(output.replace(/\.npy$/, '') + '.thumb.npy', thumb.w, thumb.h, thumb.rgb);
console.log(`${output}: ${w}x${h}, ${JSON.stringify(meta)}`);
