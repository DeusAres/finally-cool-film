const fs=require('fs');const sharp=require('./nodetest/node_modules/sharp');const sf=require('./pkg-node2/spektrafilm_wasm.js');
const D='/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const U='/root/.claude/uploads/42d188f6-730a-5c80-916c-9e420e41aad8/';
const PHOTOS=process.env.SET==='2'?[['kayak','be0b6c85-image.jpg'],['mare','d176393f-image.jpg'],['campo','26ebbbfb-image.jpg'],['nuvola','84cff04a-image.jpg']]:[['cortile','98160cd0-image.png'],['facciata','e237ea8d-image.jpg'],['chiesa','be043384-image.jpg'],['campo','7aa2e60e-image.png']];
const M=[[0.75383303,0.19859737,0.0475696],[0.04574385,0.94177722,0.01247893],[-0.00121034,0.01760172,0.98360862]];
const lin=c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4, enc=v=>v<=0.0031308?12.92*v:1.055*Math.max(v,0)**(1/2.4)-0.055;
const Lstar=Y=>Y>0.008856?116*Math.cbrt(Y)-16:903.3*Y;
exports.load=async(f,long=900)=>{const img=sharp(U+f).resize(long,long,{fit:'inside'});const m=await sharp(U+f).metadata();const p3=!!(m.icc&&m.icc.toString('latin1').replace(/\0/g,'').includes('Display P3'));
 const {data,info}=await img.removeAlpha().raw().toBuffer({resolveWithObject:true});const n=info.width*info.height,rgb=new Float32Array(n*3),Yin=new Float32Array(n);
 for(let i=0;i<n;i++){const r=lin(data[3*i]/255),g=lin(data[3*i+1]/255),b=lin(data[3*i+2]/255);
  if(p3){for(let c=0;c<3;c++)rgb[3*i+c]=M[c][0]*r+M[c][1]*g+M[c][2]*b;Yin[i]=0.2290*r+0.6917*g+0.0793*b}else{rgb[3*i]=data[3*i]/255;rgb[3*i+1]=data[3*i+1]/255;rgb[3*i+2]=data[3*i+2]/255;Yin[i]=0.2126*r+0.7152*g+0.0722*b}}
 return {rgb,w:info.width,h:info.height,p3,Yin,src:data};};
exports.engine=(p3,ov)=>{const base={settings:{use_enlarger_lut:true,use_scanner_lut:true},io:p3?{input_color_space:'ITU-R BT.2020',input_cctf_decoding:false}:{input_color_space:'sRGB',input_cctf_decoding:true}};
 const merge=(a,b)=>{for(const k in b){if(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k]))a[k]=merge(a[k]||{},b[k]);else a[k]=b[k]}return a};
 return new sf.Engine('kodak_gold_200','kodak_portra_endura',JSON.stringify(merge(base,ov||{})));};
exports.pct=(Y,ps=[5,25,50,75,95])=>{const L=Array.from(Y,Lstar).sort((a,b)=>a-b);return ps.map(p=>L[Math.floor(p/100*(L.length-1))])};
exports.Yout=(out)=>{const n=out.length/3,Y=new Float32Array(n);for(let i=0;i<n;i++)Y[i]=0.2126*lin(Math.min(1,Math.max(0,out[3*i])))+0.7152*lin(Math.min(1,Math.max(0,out[3*i+1])))+0.0722*lin(Math.min(1,Math.max(0,out[3*i+2])));return Y};
exports.PHOTOS=PHOTOS;exports.sharp=sharp;
