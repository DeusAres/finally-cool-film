// Area check: geometry (Raddrizza, Ritaglia, quarter turns, film frame / mat margins). Pure functions of web/lib, no browser,
// no engine: invariants that must hold for every input (a broken transform fails here in milliseconds).
// node scripts/eval/areas/geometry.mjs   (exit 1 on a failure)
import { FULL, cropPx, turnCrop, tiltScale, frameMap } from '../../../web/lib/tilt.js';
import { resizedCrop, fitCrop } from '../../../web/lib/cropui.js';
import { FRAME_STYLES, frameMargins } from '../../../web/lib/filmframe.js';

let fails = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { fails++; console.log('FAIL', what); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const inside = (c, e = 1e-9) => c.x >= -e && c.y >= -e && c.w > 0 && c.h > 0 && c.x + c.w <= 1 + e && c.y + c.h <= 1 + e;
const same = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const FRAMES = [[1500, 2000], [2000, 1500], [3648, 2736], [1000, 1000], [4032, 1816]];   // portrait, landscape, 4:3 raw, square, pano-ish
const CROPS = [FULL, { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }, { x: 0, y: 0.125, w: 1, h: 0.75 }, { x: 0.7, y: 0.6, w: 0.3, h: 0.4 }];

// quarter turns: four the same way, or one each way, give the crop back; the area is kept
for (const c of CROPS) {
  let t = c; for (let i = 0; i < 4; i++) t = turnCrop(t, 1);
  ok(same(t, c), `turnCrop x4 ${JSON.stringify(c)}`);
  ok(same(turnCrop(turnCrop(c, 1), -1), c), `turnCrop +1 -1 ${JSON.stringify(c)}`);
  ok(inside(turnCrop(c, 1)) && near(turnCrop(c, 1).w * turnCrop(c, 1).h, c.w * c.h), `turnCrop inside / area ${JSON.stringify(c)}`);
}
// crops in px: inside the frame, at least 1 px; FULL is the whole frame
for (const [W, H] of FRAMES) {
  const f = cropPx(W, H, FULL); ok(f.ox === 0 && f.oy === 0 && f.w === W && f.h === H, `cropPx FULL ${W}x${H}`);
  for (const c of CROPS) { const p = cropPx(W, H, c); ok(p.ox >= 0 && p.oy >= 0 && p.w >= 1 && p.h >= 1 && p.ox + p.w <= W && p.oy + p.h <= H, `cropPx ${W}x${H} ${JSON.stringify(c)}`); }
}
// Raddrizza: no tilt = no transform; any tilt: every output pixel (its corners included) reads inside the source (no empty corner)
for (const [W, H] of FRAMES) {
  ok(tiltScale(W, H, 0) === 1 && frameMap(W, H, 0) === null, `tilt 0 ${W}x${H}`);
  for (const deg of [-45, -10, -0.5, 0.25, 3, 17, 45]) {
    for (const c of [FULL, CROPS[1]]) {
      const m = frameMap(W, H, deg, c), p = cropPx(W, H, c), o = [0, 0];
      for (const [x, y] of [[0, 0], [p.w - 1, 0], [0, p.h - 1], [p.w - 1, p.h - 1], [p.w / 2, p.h / 2]]) {
        m(x, y, o);
        ok(o[0] >= -0.5 && o[1] >= -0.5 && o[0] <= W - 0.5 && o[1] <= H - 0.5, `tilt ${deg} ${W}x${H} crop ${JSON.stringify(c)} corner ${x},${y} -> ${o.map((v) => v.toFixed(2))}`);
      }
    }
  }
}
// crop box: a corner drag stays inside the frame, keeps the minimum side, keeps the ratio when locked, leaves the opposite corner
for (const A of [0.75, 1, 4 / 3, 2.2]) {
  for (const c of CROPS) {
    for (const h of ['nw', 'ne', 'sw', 'se']) {
      for (const [dx, dy] of [[0.3, 0.2], [-0.5, -0.5], [2, -2], [-0.9, 0.05]]) {
        for (const locked of [false, true]) {
          const r = resizedCrop(c, h, dx, dy, A, 0.05, locked), what = `resizedCrop A ${A} ${JSON.stringify(c)} ${h} ${dx},${dy} lock ${locked}`;
          ok(inside(r, 1e-9), what + ' inside');
          if (!locked) ok(r.w * A >= 0.05 - 1e-9 || near(r.w * A, (h[1] === 'w' ? c.x + c.w : 1 - c.x) * A), what + ' min side');
          if (locked) ok(near((r.w * A) / r.h, (c.w * A) / c.h, 1e-6), what + ' ratio');
          const fx = h[1] === 'w' ? c.x + c.w : c.x, fy = h[0] === 'n' ? c.y + c.h : c.y, gx = h[1] === 'w' ? r.x + r.w : r.x, gy = h[0] === 'n' ? r.y + r.h : r.y;
          ok(near(fx, gx, 1e-9) && near(fy, gy, 1e-9), what + ' fixed corner');
        }
      }
    }
    // a format: the exact ratio, inside the frame
    for (const ratio of [1, 4 / 5, 5 / 4, 2 / 3, 16 / 9]) {
      const f = fitCrop(c, ratio, A);
      ok(inside(f, 1e-9) && near((f.w * A) / f.h, ratio, 1e-9), `fitCrop A ${A} ${JSON.stringify(c)} ratio ${ratio.toFixed(3)} -> ${JSON.stringify(f)}`);
    }
  }
}
// film frame margins: none = 0, the others symmetric-looking (>= 0, whole px)
for (const [W, H] of FRAMES) for (const s of FRAME_STYLES) {
  const m = frameMargins(s, W, H);
  ok(Number.isInteger(m.mx) && Number.isInteger(m.my) && m.mx >= 0 && m.my >= 0 && (s !== 'none' || (m.mx === 0 && m.my === 0)), `frameMargins ${s} ${W}x${H} ${JSON.stringify(m)}`);
}
console.log(`geometry: ${checks - fails}/${checks} ok`);
process.exit(fails ? 1 : 0);
