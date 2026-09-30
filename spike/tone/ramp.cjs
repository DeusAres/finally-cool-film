const fs=require('fs');const sf=require('./pkg-node2/spektrafilm_wasm.js');
const D='/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const stops=[-6,-5,-4,-3,-2,-1,0,1,2,3];// EV relative to 0.18
const W=stops.length*64,H=64,rgb=new Float32Array(W*H*3);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const v=0.18*2**stops[Math.floor(x/64)];const i=(y*W+x)*3;rgb[i]=rgb[i+1]=rgb[i+2]=v;}
const off={grain:{active:false},halation:{active:false},dir_couplers:{active:true}};
const mk=o=>new sf.Engine('kodak_gold_200','kodak_portra_endura',JSON.stringify(Object.assign({io:{input_color_space:'sRGB',input_cctf_decoding:false},settings:{use_enlarger_lut:true,use_scanner_lut:true},film_render:off,scanner:{unsharp_mask:[0,0]}},o)));
const enc=v=>v<=0.0031308?12.92*v:1.055*v**(1/2.4)-0.055;
for (const [name,o] of [['autoexp OFF',{camera:{auto_exposure:false}}]]){
  const out=mk(o).process(rgb,W,H);
  console.log(name);console.log(' EV   in(sRGB 8bit)  out(8bit R,G,B)');
  stops.forEach((s,k)=>{const i=((32*W)+k*64+32)*3;console.log(String(s).padStart(3),'  ',String(Math.round(enc(0.18*2**s)*255)).padStart(4),'        ',[0,1,2].map(c=>Math.round(out[i+c]*255)).join(','))});
}
