const fs=require('fs');const sf=require('../pkg-node2/spektrafilm_wasm.js');
const D='/home/user/finally-cool-film/web/data/';
for (const p of ['profiles/kodak_gold_200.json','profiles/kodak_portra_endura.json','luts/spectral_upsampling/irradiance_xy_tc.npy','filters/neutral_print_filters.json']) sf.register_file('data/'+p, fs.readFileSync(D+p));
const W=768,H=160,P=32;
const rd=f=>new Float32Array(fs.readFileSync(__dirname+'/'+f).buffer.slice(0));
const input=rd('input.f32'), py=rd('py_out.f32'), pyNoDir=rd('py_out_nodir.f32');
const params=dir=>JSON.stringify({io:{input_color_space:'sRGB',input_cctf_decoding:false},settings:{use_enlarger_lut:true,use_scanner_lut:true},
  film_render:{grain:{active:false},halation:{active:false},glare:{active:false},dir_couplers:{active:dir}},print_render:{glare:{active:false}},camera:{auto_exposure:false}});
const rs=new sf.Engine('kodak_gold_200','kodak_portra_endura',params(true)).process(input,W,H);
const rsNoDir=new sf.Engine('kodak_gold_200','kodak_portra_endura',params(false)).process(input,W,H);
// sRGB-encoded → Lab (D65)
const lin=c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
function lab([r,g,b]){r=lin(r);g=lin(g);b=lin(b);let X=(0.4124*r+0.3576*g+0.1805*b)/0.95047,Y=0.2126*r+0.7152*g+0.0722*b,Z=(0.0193*r+0.1192*g+0.9505*b)/1.08883;
 const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;return[116*f(Y)-16,500*(f(X)-f(Y)),200*(f(Y)-f(Z))]}
function de2000(a,b){const [L1,a1,b1]=a,[L2,a2,b2]=b,rad=Math.PI/180;const C1=Math.hypot(a1,b1),C2=Math.hypot(a2,b2),Cm=(C1+C2)/2,G=0.5*(1-Math.sqrt(Cm**7/(Cm**7+25**7)));
 const a1p=(1+G)*a1,a2p=(1+G)*a2,C1p=Math.hypot(a1p,b1),C2p=Math.hypot(a2p,b2);const h=(x,y)=>{const t=Math.atan2(y,x)/rad;return t<0?t+360:t};const h1=h(a1p,b1),h2=h(a2p,b2);
 const dL=L2-L1,dC=C2p-C1p;let dh=h2-h1;if(C1p*C2p===0)dh=0;else if(dh>180)dh-=360;else if(dh<-180)dh+=360;const dH=2*Math.sqrt(C1p*C2p)*Math.sin(dh/2*rad);
 const Lm=(L1+L2)/2,Cpm=(C1p+C2p)/2;let hm=h1+h2;if(C1p*C2p!==0){hm=Math.abs(h1-h2)>180?(h1+h2+(h1+h2<360?360:-360))/2:(h1+h2)/2}
 const T=1-0.17*Math.cos((hm-30)*rad)+0.24*Math.cos(2*hm*rad)+0.32*Math.cos((3*hm+6)*rad)-0.2*Math.cos((4*hm-63)*rad);const dT=30*Math.exp(-(((hm-275)/25)**2));
 const RC=2*Math.sqrt(Cpm**7/(Cpm**7+25**7)),SL=1+0.015*(Lm-50)**2/Math.sqrt(20+(Lm-50)**2),SC=1+0.045*Cpm,SH=1+0.015*Cpm*T,RT=-Math.sin(2*dT*rad)*RC;
 return Math.sqrt((dL/SL)**2+(dC/SC)**2+(dH/SH)**2+RT*(dC/SC)*(dH/SH))}
const patch=(img,row,k)=>{const s=[0,0,0];let n=0;for(let y=row*P+8;y<row*P+24;y++)for(let x=k*P+8;x<k*P+24;x++){for(let c=0;c<3;c++)s[c]+=img[(y*W+x)*3+c];n++}return s.map(v=>v/n)};
const names=['dark skin','light skin','blue sky','foliage','blue flower','bluish green','orange','purplish blue','moderate red','purple','yellow green','orange yellow','blue','green','red','yellow','magenta','cyan','white','n8','n6.5','n5','n3.5','black'];
let des=[];console.log('--- colour patches: ΔE2000 Rust(wasm) vs Python reference');
for(let k=0;k<24;k++){const a=lab(patch(py,1,k)),b=lab(patch(rs,1,k));const d=de2000(a,b);des.push(d);}
console.log('mean',(des.reduce((a,b)=>a+b)/24).toFixed(2),'max',Math.max(...des).toFixed(2),'('+names[des.indexOf(Math.max(...des))]+')');
let dr=[];for(let k=0;k<24;k++)dr.push(de2000(lab(patch(py,0,k)),lab(patch(rs,0,k))));
console.log('grey ramp ΔE2000 mean',(dr.reduce((a,b)=>a+b)/24).toFixed(2),'max',Math.max(...dr).toFixed(2));
let md=0;for(let i=0;i<py.length;i++)md=Math.max(md,Math.abs(py[i]-rs[i]));console.log('max abs pixel diff (0-1)',md.toFixed(4));
console.log('--- grey ramp through the chain (Python ref): EV → L*, a*, b*, C*');
for(const k of [0,3,6,9,12,15,18,21,23]){const [L,a,b]=lab(patch(py,0,k));console.log(((-6+9*k/23).toFixed(1)).padStart(5),L.toFixed(1).padStart(6),a.toFixed(2).padStart(7),b.toFixed(2).padStart(7),Math.hypot(a,b).toFixed(2).padStart(6))}
console.log('--- edge profile (L* along row), DIR on vs off, Python ref and Rust');
const row=Math.round(3.5*P),edge=W/2;const Lrow=(img,x)=>lab([0,1,2].map(c=>img[(row*W+x)*3+c]))[0];
console.log(' dx   py_dir  py_noDIR  rs_dir  rs_noDIR');
for(const dx of [-40,-20,-10,-6,-3,-1,0,1,3,6,10,20,40])console.log(String(dx).padStart(4),[py,pyNoDir,rs,rsNoDir].map(im=>Lrow(im,edge+dx).toFixed(1).padStart(8)).join(''));
