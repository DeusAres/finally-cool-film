const fs=require('fs');const sf=require('../pkg-node2/spektrafilm_wasm.js');
const D='/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const W=768,H=160,P=32;const rd=f=>new Float32Array(fs.readFileSync(__dirname+'/'+f).buffer.slice(0));
const in709=rd('input.f32'),in2020=rd('input2020.f32'),py709=rd('py_out.f32'),py2020=rd('py_out_2020.f32');
const prm=cs=>JSON.stringify({io:{input_color_space:cs,input_cctf_decoding:false},settings:{use_enlarger_lut:true,use_scanner_lut:true},film_render:{grain:{active:false},halation:{active:false},glare:{active:false}},print_render:{glare:{active:false}},camera:{auto_exposure:false}});
const rs2020=new sf.Engine('kodak_gold_200','kodak_portra_endura',prm('ITU-R BT.2020')).process(in2020,W,H);
const lin=c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
function lab([r,g,b]){r=lin(r);g=lin(g);b=lin(b);let X=(0.4124*r+0.3576*g+0.1805*b)/0.95047,Y=0.2126*r+0.7152*g+0.0722*b,Z=(0.0193*r+0.1192*g+0.9505*b)/1.08883;const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;return[116*f(Y)-16,500*(f(X)-f(Y)),200*(f(Y)-f(Z))]}
const de=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const patch=(img,row,k)=>{const s=[0,0,0];let n=0;for(let y=row*P+8;y<row*P+24;y++)for(let x=k*P+8;x<k*P+24;x++){for(let c=0;c<3;c++)s[c]+=img[(y*W+x)*3+c];n++}return s.map(v=>v/n)};
const names=['dark skin','light skin','blue sky','foliage','blue flower','bluish green','orange','purplish blue','moderate red','purple','yellow green','orange yellow','blue','green','red','yellow','magenta','cyan','white','n8','n6.5','n5','n3.5','black'];
let rows=[];for(let k=0;k<24;k++){rows.push([names[k],de(lab(patch(py2020,1,k)),lab(patch(rs2020,1,k))),de(lab(patch(py709,1,k)),lab(patch(py2020,1,k)))])}
const st=i=>{const v=rows.map(r=>r[i]);return 'mean '+(v.reduce((a,b)=>a+b)/v.length).toFixed(2)+' max '+Math.max(...v).toFixed(2)+' ('+rows[v.indexOf(Math.max(...v))][0]+')'};
console.log('ΔE76 Rust vs Python, Rec.2020 input:',st(1));
console.log('ΔE76 Python: sRGB input vs same scene as Rec.2020 input:',st(2));
for(const r of rows) if(r[2]>2) console.log('  ',r[0].padEnd(14),r[2].toFixed(1));
