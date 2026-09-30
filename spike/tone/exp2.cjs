const E=require('./exp.cjs');
const V={
 A_default:{},
 P_pe07:{enlarger:{print_exposure:0.7}},
 P_pe05:{enlarger:{print_exposure:0.5}},
 W_levels:{scanner:{black_correction:true,white_correction:true,white_level:0.98,black_level:0.01}},
 PW_pe07_levels:{enlarger:{print_exposure:0.7},scanner:{black_correction:true,white_correction:true}},
};
(async()=>{for(const [name,f] of E.PHOTOS){const im=await E.load(f);console.log(`\n${name} p3=${im.p3}   L* p5/p25/p50/p75/p95/p99.5`);
 const ps=[5,25,50,75,95,99.5];
 console.log('  input         ',E.pct(im.Yin,ps).map(v=>v.toFixed(0).padStart(4)).join(''));
 for(const [vn,ov] of Object.entries(V)){const out=E.engine(im.p3,ov).process(im.rgb,im.w,im.h);console.log('  '+vn.padEnd(14),E.pct(E.Yout(out),ps).map(v=>v.toFixed(0).padStart(4)).join(''))}}})();
