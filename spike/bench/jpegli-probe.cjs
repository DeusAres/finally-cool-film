globalThis.self = { location: { href: 'http://x/' } };
const JpegliModule = require('./jpegli.cjs');
const sharp = require('sharp');
(async () => {
  const M = await JpegliModule();
  const { data, info } = await sharp('out_ref.png').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ptr = M._malloc(data.length); M.HEAPU8.set(data, ptr);
  const lenPtr = M._malloc(4);
  for (const [q, a, b] of [[0.5,0,0],[1.0,0,0],[2.0,0,0],[1.0,1,0],[1.0,1,1],[1.0,0,1]]) {
    const out = M._jpegli_wasm_encode_rgb(ptr, info.width, info.height, q, a, b, lenPtr);
    const len = M.HEAPU32[lenPtr >> 2];
    const buf = Buffer.from(M.HEAPU8.slice(out, out + len));
    let meta = {}; try { meta = await sharp(buf).metadata(); } catch (e) { meta.err = e.message; }
    const dec = await sharp(buf).raw().toBuffer(); let s2=0; for (let i=0;i<dec.length;i++){const d=dec[i]-data[i]; s2+=d*d}; const psnr=(10*Math.log10(255*255/(s2/dec.length))).toFixed(2);
    console.log(JSON.stringify({ psnr, q, a, b, out, len, soi: buf.slice(0,2).toString('hex'), fmt: meta.format, sub: meta.chromaSubsampling, prog: meta.isProgressive, err: meta.err }));
    if (out) M._jpegli_wasm_free(out);
  }
})().catch(e => console.log('ERR', e.message));
