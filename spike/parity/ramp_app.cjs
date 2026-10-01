const fs=require('fs');const sf=require('../pkg-node2/spektrafilm_wasm.js');
const D='/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const stops=[];for(let e=-6;e<=4;e+=0.5)stops.push(e);
const W=stops.length*16,H=16,rgb=new Float32Array(W*H*3);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const v=0.18*2**stops[x>>4];for(let c=0;c<3;c++)rgb[(y*W+x)*3+c]=v}
const lin=c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
function lab([r,g,b]){r=lin(r);g=lin(g);b=lin(b);let X=(0.4124*r+0.3576*g+0.1805*b)/0.95047,Y=0.2126*r+0.7152*g+0.0722*b,Z=(0.0193*r+0.1192*g+0.9505*b)/1.08883;const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;return[116*f(Y)-16,500*(f(X)-f(Y)),200*(f(Y)-f(Z))]}
const base={io:{input_color_space:'sRGB',input_cctf_decoding:false},settings:{use_enlarger_lut:true,use_scanner_lut:true},film_render:{grain:{active:false},halation:{active:false},glare:{active:false}},print_render:{glare:{active:false}},camera:{auto_exposure:false}};
const V={
 'spektra default':{},
 'app: levels':{scanner:{black_correction:true,white_correction:true}},
 'app: levels+gamma0.6':{scanner:{black_correction:true,white_correction:true},print_render:{density_curves_morph:{active:true,gamma_factor:0.6}}},
 'app: levels+gamma0.8':{scanner:{black_correction:true,white_correction:true},print_render:{density_curves_morph:{active:true,gamma_factor:0.8}}},
};
const merge=(a,b)=>{for(const k in b){if(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k]))a[k]=merge(a[k]||{},b[k]);else a[k]=b[k]}return a};
for(const [n,o] of Object.entries(V)){const out=new sf.Engine('kodak_gold_200','kodak_portra_endura',JSON.stringify(merge(JSON.parse(JSON.stringify(base)),o))).process(rgb,W,H);
 console.log('\n'+n+'   EV:  L*  a*  b*');let line='';
 stops.forEach((e,k)=>{if(e%1)return;const i=(8*W+k*16+8)*3;const [L,a,b]=lab([out[i],out[i+1],out[i+2]]);line+=`${e>=0?'+':''}${e}: ${L.toFixed(0)} ${a.toFixed(1)} ${b.toFixed(1)} | `});console.log(line)}
