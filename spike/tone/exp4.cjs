const E=require('./exp.cjs');
const cfg=(pe,g)=>({scanner:{black_correction:true,white_correction:true},enlarger:{print_exposure:pe},print_render:{density_curves_morph:{active:true,gamma_factor:g}}});
const pctOf=(im,small,pe,g,ps)=>E.pct(E.Yout(E.engine(im.p3,cfg(pe,g)).process(small.rgb,small.w,small.h)),ps);
function fitPE(small,g,target){let lo=-3,hi=1.5;for(let i=0;i<8;i++){const mid=(lo+hi)/2;const m=pctOf(small,small,2**mid,g,[50])[0];if(m>target)lo=mid;else hi=mid}return 2**((lo+hi)/2)}
function fit(small){const [t25,t50,t75]=E.pct(small.Yin,[25,50,75]);let best=null;
 for(const g of [0.4,0.5,0.6,0.7,0.8,0.9,1.0]){const pe=fitPE(small,g,t50);const [a,,b]=pctOf(small,small,pe,g,[25,50,75]);const err=Math.abs((b-a)-(t75-t25));if(!best||err<best.err)best={g,pe,err}}return best}
(async()=>{const tiles=[];let y=0;const T=300,S=E.sharp;
 for(const [name,f] of E.PHOTOS){const im=await E.load(f,900),small=await E.load(f,256);const b=fit(small);const ps=[5,25,50,75,95];
  const out=E.engine(im.p3,cfg(b.pe,b.g)).process(im.rgb,im.w,im.h);const outD=E.engine(im.p3,{}).process(im.rgb,im.w,im.h);console.log('   default',E.pct(E.Yout(outD),ps).map(v=>v.toFixed(0).padStart(4)).join(''));
  console.log(`${name.padEnd(9)} gamma=${b.g} print_exposure=${b.pe.toFixed(3)}`);
  console.log('   input  ',E.pct(im.Yin,ps).map(v=>v.toFixed(0).padStart(4)).join(''));
  console.log('   fit    ',E.pct(E.Yout(out),ps).map(v=>v.toFixed(0).padStart(4)).join(''));
  const to8=o=>Buffer.from(Array.from(o,v=>Math.max(0,Math.min(255,Math.round(v*255)))));
  let x=0,rowH=0;for(const buf of [Buffer.from(im.src),to8(outD),to8(out)]){const t=await S(buf,{raw:{width:im.w,height:im.h,channels:3}}).resize(T,T,{fit:'inside'}).png().toBuffer();const md=await S(t).metadata();tiles.push({input:t,left:x,top:y});x+=md.width+6;rowH=Math.max(rowH,md.height)}y+=rowH+6;}
 await S({create:{width:3*(T+6),height:y,channels:3,background:'#000'}}).composite(tiles).png().toFile(process.env.OUT||'sheet2.png');})();
