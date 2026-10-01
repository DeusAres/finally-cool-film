import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('./nodetest/node_modules/sharp'); const sf = require('./pkg-node2/spektrafilm_wasm.js');
const T_ = await import('/home/user/finally-cool-film/web/lib/tone.js');
const TO = await import('./tone_old.mjs');
const { P3_TO_REC2020: M } = await import('/home/user/finally-cool-film/web/lib/color.js');
const D = '/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const U = '/root/.claude/uploads/42d188f6-730a-5c80-916c-9e420e41aad8/';
const PHOTOS = [['cortile','98160cd0-image.png'],['facciata','e237ea8d-image.jpg'],['chiesa','be043384-image.jpg'],['campo','7aa2e60e-image.png'],['kayak','be0b6c85-image.jpg'],['mare','d176393f-image.jpg'],['nuvola','84cff04a-image.jpg']];
const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const params = p3 => JSON.stringify({ settings: { use_enlarger_lut: true, use_scanner_lut: true }, camera: { auto_exposure: false },
  io: { input_color_space: p3 ? 'ITU-R BT.2020' : 'sRGB', input_cctf_decoding: false } });
const T = {};
for (const p3 of [true, false]) {   // measure the transfer, grain off (as the app does)
  const e = new sf.Engine('kodak_gold_200', 'kodak_portra_endura', params(p3)); e.update(JSON.stringify({ film_render: { grain: { active: false } } }));
  const c = T_.transferChart(); T[p3] = T_.readTransfer(e.process(c.rgb, c.w, c.h), c.w); e.free();
}
console.log('paper white Y', T[true].white.toFixed(3), 'black floor', T[true].floor.toFixed(4), '(sRGB code', Math.round(255*(1.055*T[true].floor**(1/2.4)-0.055)), ')');
const L = y => y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
const pct = (arr, ps) => { const s = Float32Array.from(arr).sort(); return ps.map(p => L(s[Math.floor(p / 100 * (s.length - 1))]).toFixed(0)).join('/'); };
const tiles = []; let y = 0; const TS = 300;
for (const [name, f] of PHOTOS) {
  const meta = await sharp(U + f).metadata(); const p3 = !!(meta.icc && meta.icc.toString('latin1').replace(/\0/g, '').includes('Display P3'));
  const { data, info } = await sharp(U + f).resize(800, 800, { fit: 'inside' }).keepIccProfile().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, Yin = new Float32Array(n);
  const [kr, kg, kb] = p3 ? [0.2290, 0.6917, 0.0793] : [0.2126, 0.7152, 0.0722];
  for (let i = 0; i < n; i++) Yin[i] = kr * lin(data[3*i]/255) + kg * lin(data[3*i+1]/255) + kb * lin(data[3*i+2]/255);
  const auto = T_.autoTone(Yin);
  const render = (tone) => {
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const r = tone.lut8[data[3*i]], g = tone.lut8[data[3*i+1]], b = tone.lut8[data[3*i+2]];
      if (p3) for (let c = 0; c < 3; c++) rgb[3*i+c] = M[c][0]*r + M[c][1]*g + M[c][2]*b; else { rgb[3*i] = r; rgb[3*i+1] = g; rgb[3*i+2] = b; } }
    const e = new sf.Engine('kodak_gold_200', 'kodak_portra_endura', params(p3)); const out = e.process(rgb, info.width, info.height); e.free();
    const o8 = Buffer.alloc(n * 3); for (let i = 0; i < n * 3; i++) o8[i] = tone.out8[Math.max(0, Math.min(4095, Math.round(out[i] * 4095)))];
    return o8; };
  const up = { look: auto.look, ev: auto.ev + 1 };
  const outFlat = render(TO.buildTone(T[p3], up)), outAuto = render(T_.buildTone(T[p3], { ...up, rolloff: 0.6 }));
  const Yo = o => { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = 0.2126*lin(o[3*i]/255)+0.7152*lin(o[3*i+1]/255)+0.0722*lin(o[3*i+2]/255); return r; };
  const clip = o => { let c = 0; for (let i = 0; i < n; i++) if (o[3*i] >= 250 && o[3*i+1] >= 250 && o[3*i+2] >= 250) c++; return (100 * c / n).toFixed(2) + '%'; };
  const minc = o => { let m = 255; for (let i = 0; i < n*3; i++) m = Math.min(m, o[i]); return m; };
  console.log(`${name.padEnd(9)} ev=${up.ev} look=${up.look} | L* p50/75/90/97/99.5 in ${pct(Yin,[50,75,90,97,99.5])} OLD ${pct(Yo(outFlat),[50,75,90,97,99.5])} NEW ${pct(Yo(outAuto),[50,75,90,97,99.5])} | ~white(≥250) in ${clip(data)} OLD ${clip(outFlat)} NEW ${clip(outAuto)}`);
  let x = 0, rowH = 0;
  for (const [buf, conv] of [[data, true], [outFlat, false], [outAuto, false]]) {
    let img = sharp(Buffer.from(buf), { raw: { width: info.width, height: info.height, channels: 3 } });
    const t = await img.resize(TS, TS, { fit: 'inside' }).png().toBuffer(); const md = await sharp(t).metadata();
    tiles.push({ input: t, left: x, top: y }); x += TS + 6; rowH = Math.max(rowH, md.height); }
  y += rowH + 6;
}
await sharp({ create: { width: 3 * (TS + 6), height: y, channels: 3, background: '#000' } }).composite(tiles).png().toFile('rolloff.png');
