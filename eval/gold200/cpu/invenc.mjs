// Encoded negative scan (npy float32 h x w x 3, display-encoded) -> v4 neutral inversion (invert.js) -> sRGB (output.js), raw RGB8.
import fs from 'node:fs';
const L = '/home/user/finally-cool-film/web/lib/';
const { invertAnchors, invertUniform, invertCPU } = await import(L + 'invert.js');
const { toSpaceCPU } = await import(L + 'output.js');
const [src, dst] = process.argv.slice(2);
const b = fs.readFileSync(src), hl = b.readUInt16LE(8), hdr = b.toString('latin1', 10, 10 + hl);
const [h, w] = hdr.match(/\((\d+), (\d+), 3\)/).slice(1).map(Number);
const enc = new Float32Array(b.buffer.slice(b.byteOffset + 10 + hl, b.byteOffset + 10 + hl + h * w * 12));
const thumb = [];
for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * 3; thumb.push(enc[i], enc[i + 1], enc[i + 2]); }
const u = invertUniform(invertAnchors(Float32Array.from(thumb), { shared: true }));
const out = Buffer.alloc(w * h * 3), px = new Float32Array(3);
for (let i = 0; i < w * h; i++) {
  px[0] = enc[3 * i]; px[1] = enc[3 * i + 1]; px[2] = enc[3 * i + 2];
  invertCPU(px, u); toSpaceCPU(px, 'srgb');
  for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(255 * Math.min(1, Math.max(0, px[c])));
}
fs.writeFileSync(dst, out);
console.log(JSON.stringify({ w, h }));
