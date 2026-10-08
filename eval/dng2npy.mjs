// DNG -> linear Rec.2020 float32 .npy (HxWx3), using the app's own decoder (web/lib/dng.js).
// usage: node eval/dng2npy.mjs <in.dng> <out.npy> [maxLongSide]
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeDNG } from '../web/lib/dng.js';

const [input, output, maxLongSide] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node eval/dng2npy.mjs <in.dng> <out.npy> [maxLongSide]');
  process.exit(1);
}

const buf = readFileSync(input);
const { w, h, rgb, space } = await decodeDNG(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  maxLongSide ? { maxLongSide: +maxLongSide } : {},
);
if (space !== 'rec2020') throw new Error(`unexpected decoder space ${space}`);

// npy v1.0: magic, version, u16 header length, dict padded so the data starts 64-byte aligned.
let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${h}, ${w}, 3), }`;
header += ' '.repeat((64 - ((10 + header.length + 1) % 64)) % 64) + '\n';
const head = Buffer.alloc(10 + header.length);
head.write('\x93NUMPY', 0, 'latin1');
head.writeUInt8(1, 6);
head.writeUInt16LE(header.length, 8);
head.write(header, 10, 'latin1');
writeFileSync(output, Buffer.concat([head, Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)]));
console.log(`${output}: ${w}x${h}`);
