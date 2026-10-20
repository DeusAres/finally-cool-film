// A negative scan -> the v4 neutral inversion (web/lib/invert.js, anchors from every 4th pixel as the app's thumb) -> sRGB
// (web/lib/output.js), written as raw RGB8. Input: .npy float32 h x w x 3, either transmittance (--linear: the real film's
// T<frame>.npy) or display-encoded (the engine's scan PNG / 255).
//     node eval/gold200/invert_scan.mjs IN.npy OUT.rgb [--linear]     -> prints {"w", "h"}
import fs from 'node:fs';
import { invertAnchors, invertUniform, invertCPU } from '../../web/lib/invert.js';
import { toSpaceCPU } from '../../web/lib/output.js';
import { linearToSrgb } from '../../web/lib/color.js';

const [src, dst, flag] = process.argv.slice(2);
const b = fs.readFileSync(src), hl = b.readUInt16LE(8), hdr = b.toString('latin1', 10, 10 + hl);
const [h, w] = hdr.match(/\((\d+), (\d+), 3\)/).slice(1).map(Number);
let enc = new Float32Array(b.buffer.slice(b.byteOffset + 10 + hl, b.byteOffset + 10 + hl + h * w * 12));
if (flag === '--linear') enc = enc.map((v) => linearToSrgb(Math.min(1, Math.max(1e-6, v))));
const thumb = [];
for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * 3; thumb.push(enc[i], enc[i + 1], enc[i + 2]); }
const u = invertUniform(invertAnchors(Float32Array.from(thumb)));
const out = Buffer.alloc(w * h * 3), px = new Float32Array(3);
for (let i = 0; i < w * h; i++) {
  px[0] = enc[3 * i]; px[1] = enc[3 * i + 1]; px[2] = enc[3 * i + 2];
  invertCPU(px, u); toSpaceCPU(px, 'srgb');
  for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(255 * Math.min(1, Math.max(0, px[c])));
}
fs.writeFileSync(dst, out);
console.log(JSON.stringify({ w, h }));
