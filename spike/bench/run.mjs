import fs from 'node:fs';
import sharp from 'sharp';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sf = require('../pkg-node/spektrafilm_wasm.js');

const D = '../spektrafilm-rs/data/';
for (const p of ['profiles/kodak_gold_200.json', 'profiles/kodak_portra_endura.json',
                 'luts/spectral_upsampling/irradiance_xy_tc.npy', 'filters/neutral_print_filters.json'])
  sf.register_file('data/' + p, fs.readFileSync(D + p));

const [,, input, output, longSide = '1024'] = process.argv;
const { data, info } = await sharp(input).resize(+longSide, +longSide, { fit: 'inside' })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true });
const rgb = new Float32Array(data.length);
for (let i = 0; i < data.length; i++) rgb[i] = data[i] / 255;

let t = performance.now();
const eng = new sf.Engine('kodak_gold_200', 'kodak_portra_endura',
  JSON.stringify(Object.assign({ io: { input_color_space: 'sRGB', input_cctf_decoding: true } }, JSON.parse(process.env.OV || '{}'))));
const tInit = performance.now() - t;
const times = [];
let out;
for (let i = 0; i < 3; i++) { t = performance.now(); out = eng.process(rgb, info.width, info.height); times.push(performance.now() - t); }
const px = Buffer.alloc(out.length);
let nan = 0;
for (let i = 0; i < out.length; i++) { const v = out[i]; if (!Number.isFinite(v)) nan++; px[i] = Math.max(0, Math.min(255, Math.round(v * 255))); }
await sharp(px, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toFile(output);
console.log(JSON.stringify({ size: `${info.width}x${info.height}`, mp: (info.width*info.height/1e6).toFixed(2),
  init_ms: tInit.toFixed(0), process_ms: times.map(x => x.toFixed(0)), out_len: out.length, nan }));
