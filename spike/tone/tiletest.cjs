const E=require('./exp.cjs');const sf=require('./pkg-node2/spektrafilm_wasm.js');
(async()=>{const im=await E.load('be0b6c85-image.jpg',1400);const {w,h}=im;
 const base={settings:{use_enlarger_lut:true,use_scanner_lut:true},io:{input_color_space:'ITU-R BT.2020',input_cctf_decoding:false},scanner:{black_correction:true,white_correction:true},film_render:{grain:{active:false}}};
 const eng=new sf.Engine('kodak_gold_200','kodak_portra_endura',JSON.stringify(base));
 const full=eng.process(im.rgb,w,h);
 const ev=eng.auto_exposure_ev(im.rgb,w,h),sc=2**ev,L=Math.max(w,h),T=512,P=128;const out=new Float32Array(w*h*3);
 for(let ty=0;ty<h;ty+=T)for(let tx=0;tx<w;tx+=T){const x0=Math.max(0,tx-P),y0=Math.max(0,ty-P),x1=Math.min(w,tx+T+P),y1=Math.min(h,ty+T+P),tw=x1-x0,th=y1-y0;
  const t=new Float32Array(tw*th*3);for(let y=0;y<th;y++)for(let x=0;x<tw;x++)for(let c=0;c<3;c++)t[(y*tw+x)*3+c]=im.rgb[((y0+y)*w+x0+x)*3+c]*sc;
  eng.update(JSON.stringify({camera:{auto_exposure:false,film_format_mm:35*Math.max(tw,th)/L}}));const o=eng.process(t,tw,th);
  for(let y=0;y<Math.min(T,h-ty);y++)for(let x=0;x<Math.min(T,w-tx);x++)for(let c=0;c<3;c++)out[((ty+y)*w+tx+x)*3+c]=o[((ty-y0+y)*tw+tx-x0+x)*3+c];}
 let s=0,m=0,seam=0,ns=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++){const i=(y*w+x)*3+c,d=Math.abs(full[i]-out[i])*255;s+=d;m=Math.max(m,d);if(x%T<2||x%T>T-3||y%T<2||y%T>T-3){seam+=d;ns++}}
 console.log(JSON.stringify({w,h,ev:ev.toFixed(3),mean_diff_255:(s/(w*h*3)).toFixed(3),max_diff_255:m.toFixed(1),seam_mean_255:(seam/ns).toFixed(3)}));})();
