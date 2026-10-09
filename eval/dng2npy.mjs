// DNG -> linear Rec.2020 float32 .npy (HxWx3), using the app's own decoder (web/lib/dng.js).
// Also writes <out>.thumb.npy and <out>.json (baseline; with --interno: under, gains, grain) for `sf-eval image --meta`.
// usage: node eval/dng2npy.mjs <in.dng> <out.npy> [maxLongSide] [--interno]
// --interno: meta gets under (fixed INTERNO_EV), gains [1,1,1] and grain from web/lib/interno.js, as the app's toggle.
import { readFileSync, writeFileSync } from 'node:fs';
import { isRaw, loadRaw, rawThumb } from '../web/lib/raw.js';
import { internoParams } from '../web/lib/interno.js';
import { THUMB_PX } from '../web/lib/common.js';

const args = process.argv.slice(2), withInterno = args.includes('--interno');
const [input, output, maxLongSide] = args.filter((a) => !a.startsWith('--'));
if (!input || !output) {
  console.error('usage: node eval/dng2npy.mjs <in.dng> <out.npy> [maxLongSide]');
  process.exit(1);
}

// Same steps as the app's raw path (web/app.js): loadRaw (decode + EXIF orientation via rawThumb's index
// mapping), thumb for AutoSetup (rawThumb at THUMB_PX).
const buf = readFileSync(input);
const file = new File([buf], input.split('/').pop());
const raw = await loadRaw(file, maxLongSide ? +maxLongSide : 2000);   // app preview size = 2000
if (!(await isRaw(file))) throw new Error('not a DNG');
const { w, h, rgb } = rawThumb(raw, 1e9);       // scale 1: oriented full copy, sensor values (no baseline)
const thumb = rawThumb(raw, THUMB_PX);
const meta = { baseline: raw.baseline, orientation: raw.orientation };
if (withInterno) {
  const ip = internoParams();
  Object.assign(meta, { interno: true, under: ip.under, gains: ip.gains, grain: ip.grain });
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
