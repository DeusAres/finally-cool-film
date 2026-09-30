const E=require('./exp.cjs');
const LEVELS={scanner:{black_correction:true,white_correction:true}};
function autoPE(im,small){// bisection in log2(print_exposure) so output median L* == input median L*
  const target=E.pct(im.Yin,[50])[0];let lo=-3,hi=1.5,iters=0;
  for(;iters<8;iters++){const mid=(lo+hi)/2;const out=E.engine(im.p3,{...LEVELS,enlarger:{print_exposure:2**mid}}).process(small.rgb,small.w,small.h);
    const m=E.pct(E.Yout(out),[50])[0]; if(m>target) lo=mid; else hi=mid;}   // too bright → raise print exposure (darker print)
  return 2**((lo+hi)/2);}
(async()=>{const sheet=[];for(const [name,f] of E.PHOTOS){const im=await E.load(f,900),small=await E.load(f,256);
 const pe=autoPE(small,small);const ps=[5,25,50,75,95];
 const outA=E.engine(im.p3,{}).process(im.rgb,im.w,im.h), outB=E.engine(im.p3,{...LEVELS,enlarger:{print_exposure:pe}}).process(im.rgb,im.w,im.h);
 console.log(`${name.padEnd(9)} auto print_exposure=${pe.toFixed(3)} (${Math.log2(pe).toFixed(2)} EV)`);
 console.log('   input   ',E.pct(im.Yin,ps).map(v=>v.toFixed(0).padStart(4)).join(''));
 console.log('   default ',E.pct(E.Yout(outA),ps).map(v=>v.toFixed(0).padStart(4)).join(''));
 console.log('   auto    ',E.pct(E.Yout(outB),ps).map(v=>v.toFixed(0).padStart(4)).join(''));
 const to8=o=>Buffer.from(Array.from(o,v=>Math.max(0,Math.min(255,Math.round(v*255)))));
 sheet.push({im,bufs:[Buffer.from(im.src),to8(outA),to8(outB)]});}
 // contact sheet: rows = photos, cols = original | default | auto   (each tile 300px long side)
 const S=E.sharp;const tiles=[];let y=0;const T=300;
 for(const {im,bufs} of sheet){let x=0;let rowH=0;for(const b of bufs){const t=await S(b,{raw:{width:im.w,height:im.h,channels:3}}).resize(T,T,{fit:'inside'}).png().toBuffer();const md=await S(t).metadata();tiles.push({input:t,left:x,top:y});x+=md.width+6;rowH=Math.max(rowH,md.height)}y+=rowH+6}
 await S({create:{width:3*(T+6),height:y,channels:3,background:'#000'}}).composite(tiles).png().toFile('sheet.png');})();
