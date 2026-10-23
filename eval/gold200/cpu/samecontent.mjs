// pairs_<name>_<f>.npy: rows [engine dR dG dB, film dR dG dB] on the same registered pixels. Invert both with anchors from
// those same pixels (invert.js), output sRGB pairs as raw RGB8 for Lab stats.
import fs from 'node:fs';
const L = '/home/user/finally-cool-film/web/lib/';
const { invertAnchors, invertUniform, invertCPU } = await import(L + 'invert.js');
const { toSpaceCPU } = await import(L + 'output.js');
const { linearToSrgb } = await import(L + 'color.js');
const [src, dst] = process.argv.slice(2);
const b = fs.readFileSync(src), hl = b.readUInt16LE(8), hdr = b.toString('latin1', 10, 10 + hl);
const n = +hdr.match(/\((\d+), 6\)/)[1];
const P = new Float32Array(b.buffer.slice(b.byteOffset + 10 + hl, b.byteOffset + 10 + hl + n * 24));
const out = Buffer.alloc(n * 6);
for (const side of [0, 1]) {
  const enc = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) enc[3 * i + c] = linearToSrgb(10 ** -P[6 * i + 3 * side + c]);
  const u = invertUniform(invertAnchors(enc, { shared: true })), px = new Float32Array(3);
  for (let i = 0; i < n; i++) {
    px.set(enc.subarray(3 * i, 3 * i + 3)); invertCPU(px, u); toSpaceCPU(px, 'srgb');
    for (let c = 0; c < 3; c++) out[6 * i + 3 * side + c] = Math.round(255 * Math.min(1, Math.max(0, px[c])));
  }
}
fs.writeFileSync(dst, out);
