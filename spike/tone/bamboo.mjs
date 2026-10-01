import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('./nodetest/node_modules/sharp'); const sf = require('./pkg-node2/spektrafilm_wasm.js');
const NEW = await import('/home/user/finally-cool-film/web/lib/tone.js'); const OLD = await import('./tone_prev.mjs');
const { P3_TO_REC2020: M, LIN8 } = await import('/home/user/finally-cool-film/web/lib/color.js');
const D = '/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const files = process.argv.slice(2);
const params = p3 => JSON.stringify({ settings: { use_enlarger_lut: true, use_scanner_lut: true }, camera: { auto_exposure: false }, io: { input_color_space: p3 ? 'ITU-R BT.2020' : 'sRGB', input_cctf_decoding: false } });
const T = {}; for (const p3 of [true, false]) { const e = new sf.Engine('kodak_gold_200','kodak_portra_endura', params(p3)); e.update(JSON.stringify({ film_render: { grain: { active: false } } })); const c = NEW.transferChart(); T[p3] = NEW.readTransfer(e.process(c.rgb, c.w, c.h), c.w); e.free(); }
const L = y => y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const tiles = []; let y0 = 0; const TS = 330;
for (const f of files) {
  const meta = await sharp(f).metadata(); const p3 = !!(meta.icc && meta.icc.toString('latin1').replace(/\0/g, '').includes('Display P3'));
  const { data, info } = await sharp(f).resize(900, 900, { fit: 'inside' }).keepIccProfile().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, kk = p3 ? [0.2290, 0.6917, 0.0793] : [0.2126, 0.7152, 0.0722];
  const Yin = new Float32Array(n); for (let i = 0; i < n; i++) Yin[i] = kk[0]*LIN8[data[3*i]] + kk[1]*LIN8[data[3*i+1]] + kk[2]*LIN8[data[3*i+2]];
  const render = (mk) => { const rgb = new Float32Array(n * 3), px = new Float32Array(3);
    for (let i = 0; i < n; i++) { mk(data[3*i], data[3*i+1], data[3*i+2], px);
      if (p3) for (let c = 0; c < 3; c++) rgb[3*i+c] = M[c][0]*px[0] + M[c][1]*px[1] + M[c][2]*px[2]; else rgb.set(px, 3*i); }
    const e = new sf.Engine('kodak_gold_200','kodak_portra_endura', params(p3)); const out = e.process(rgb, info.width, info.height); e.free(); return out; };
  const fin = (out, out8) => { const o = Buffer.alloc(n * 3); for (let i = 0; i < n * 3; i++) o[i] = out8[Math.max(0, Math.min(4095, Math.round(out[i] * 4095)))]; return o; };
  const user = { ev: 1.5, look: 0.35, rolloff: 0.6 }, auto = NEW.autoTone(Yin);
  const to = OLD.buildTone(T[p3], user); const oldO = fin(render((r,g,b,px) => { px[0]=to.lut8[r]; px[1]=to.lut8[g]; px[2]=to.lut8[b]; }), to.out8);
  const mkNew = (t) => (r,g,b,px) => NEW.applyTone(t, LIN8[r], LIN8[g], LIN8[b], px, 0);
  const tn = NEW.buildTone(T[p3], user), newO = fin(render(mkNew(tn)), tn.out8);
  const ta = NEW.buildTone(T[p3], { ...auto, rolloff: 0.6 }), autoO = fin(render(mkNew(ta)), ta.out8);
  const stats = o => { const Ys = [], C = []; for (let i = 0; i < n; i += 3) { const r = lin(o[3*i]/255), g = lin(o[3*i+1]/255), b = lin(o[3*i+2]/255); Ys.push(0.2126*r+0.7152*g+0.0722*b); const mx = Math.max(o[3*i],o[3*i+1],o[3*i+2]), mn = Math.min(o[3*i],o[3*i+1],o[3*i+2]); C.push(mx ? (mx-mn)/mx : 0); }
    Ys.sort((a,b)=>a-b); const q = p => L(Ys[Math.floor(p*(Ys.length-1))]).toFixed(0); let w = 0; for (const v of Ys) if (L(v) > 95) w++;
    return `L* p25/50/75/90 ${q(.25)}/${q(.5)}/${q(.75)}/${q(.9)} >L95 ${(100*w/Ys.length).toFixed(1)}% sat ${(100*C.reduce((a,b)=>a+b)/C.length).toFixed(1)}`; };
  console.log(f.split('/').pop(), 'p3', p3, 'auto', JSON.stringify(auto)); console.log('  in      ', stats(data)); console.log('  OLD +1.5', stats(oldO)); console.log('  NEW +1.5', stats(newO)); console.log('  NEW auto', stats(autoO));
  let x = 0, rowH = 0; for (const buf of [data, oldO, newO, autoO]) { const t = await (process.env.CROP ? sharp(Buffer.from(buf), { raw: { width: info.width, height: info.height, channels: 3 } }).extract({ left: 300, top: 260, width: TS, height: TS }) : sharp(Buffer.from(buf), { raw: { width: info.width, height: info.height, channels: 3 } }).resize(TS, TS, { fit: 'inside' })).png().toBuffer(); const md = await sharp(t).metadata(); tiles.push({ input: t, left: x, top: y0 }); x += TS + 6; rowH = Math.max(rowH, md.height); }
  y0 += rowH + 6;
}
await sharp({ create: { width: 4 * (TS + 6), height: y0, channels: 3, background: '#000' } }).composite(tiles).png().toFile('bamboo_cmp.png');
