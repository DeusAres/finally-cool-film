// Area check: the sliders. One photo loaded once in the app (headless Chromium, WebGPU on SwiftShader), each slider moved from its
// default to a test value and back; per move, from the canvas: mean L*, a*, b*, chroma, the 5th / 95th L* percentiles,
// high-frequency energy (|L - box3(L)|), corner / centre L. Every slider must move the image the way its name says (DIRECTION)
// and by the size it did (the baseline eval/check/sliders_baseline.json, written with --update).
//   node scripts/eval/areas/sliders.cjs <baseUrl> <photo> [--update]
const { chromium } = (() => { for (const m of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch (e) { /* next */ } } throw new Error('playwright not found'); })();
const fs = require('fs'), path = require('path');
const [baseUrl, photo] = process.argv.slice(2), update = process.argv.includes('--update');
const BASE = path.join(__dirname, '..', '..', '..', 'eval', 'check', 'sliders_baseline.json');
// [slider, test value, scanner, metric, sign]: the metric's change (test - default) must have this sign (the slider's meaning)
const DIRECTION = [
  ['labD', 4, 'frontier', 'L', +1],            // Densità +: a brighter print
  ['labGrad', 3, 'frontier', 'spread', +1],    // Gradazione Hard: more contrast (p95 - p5)
  ['labHi', -1, 'frontier', 'p95', -1],        // Tono luci Soft: lights held down
  ['labLo', -1, 'frontier', 'p5', +1],         // Tono ombre Soft: lifted blacks
  ['labSat', 6, 'frontier', 'C', +1],          // Saturazione +
  ['labBright', 4, 'frontier', 'C', +1],       // Bright +: primaries more saturated
  ['htHi', 5, 'frontier', 'p95', -1],          // Hyper Tone luci: lights recovered (darker)
  ['htLo', 5, 'frontier', 'p5', +1],           // Hyper Tone ombre: shadows opened
  ['hypersharp', 1, 'frontier', 'hf', +1],     // Hyper Sharpness: more fine detail
  ['mshift', 20, 'frontier', 'a', -1],         // Magenta <-> Verde +: greener
  ['yshift', 20, 'frontier', 'b', -1],         // Giallo <-> Blu +: bluer
  ['nbBright', 3, 'none', 'L', +1],            // Luminosità (Nessuno) +: brighter
  ['mshift', 20, 'none', 'a', -1],
  ['yshift', 20, 'none', 'b', -1],
  ['temp', 1500, 'none', 'b', +1],             // Temperatura luce: warmer light (right)
  ['vibrance', 60, 'none', 'C', +1],           // Vividezza +
  ['grain', 4, 'none', 'hf', +1],              // Grana +
  ['texture', 0.8, 'none', 'hf', +1],          // Texture +
  ['sharp', 0.8, 'none', 'hf', +1],            // Nitidezza +
  ['vignette', 1, 'none', 'corner', -1],       // Vignettatura: darker corners
  ['halation', 3, 'none', 'a', +1],            // Halation: red glow around the lights
];
const METRICS = () => {
  const c = document.getElementById('view'), x = c.getContext('2d'), { width: w, height: h } = c;
  const d = x.getImageData(0, 0, w, h, { colorSpace: 'srgb' }).data, S = 2;   // every other pixel
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const W = Math.ceil(w / S), H = Math.ceil(h / S), Ls = new Float32Array(W * H);
  let sL = 0, sa = 0, sb = 0, sC = 0, n = 0, cor = 0, nc = 0, cen = 0, ncen = 0;
  for (let y = 0, j = 0; y < h; y += S) for (let xx = 0; xx < w; xx += S, j++) {
    const i = (y * w + xx) * 4, r = lin(d[i]), g = lin(d[i + 1]), b = lin(d[i + 2]);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const L = 116 * f(Y) - 16, a = 500 * (f(X) - f(Y)), bb = 200 * (f(Y) - f(Z));
    Ls[j] = L; sL += L; sa += a; sb += bb; sC += Math.hypot(a, bb); n++;
    const ex = Math.min(xx, w - xx) / w, ey = Math.min(y, h - y) / h;
    if (ex < 0.08 && ey < 0.08) { cor += L; nc++; } else if (ex > 0.35 && ey > 0.35) { cen += L; ncen++; }
  }
  const sorted = Float32Array.from(Ls).sort(), p = (q) => sorted[Math.floor(q * (sorted.length - 1))];
  let hf = 0, nh = 0;
  for (let y = 1; y < H - 1; y++) for (let xx = 1; xx < W - 1; xx++) {
    const j = y * W + xx; let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += Ls[j + dy * W + dx];
    hf += Math.abs(Ls[j] - m / 9); nh++;
  }
  return { L: sL / n, a: sa / n, b: sb / n, C: sC / n, p5: p(0.05), p95: p(0.95), spread: p(0.95) - p(0.05), hf: hf / nh, corner: cor / nc - cen / ncen };
};
(async () => {
  const t0 = Date.now(), browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(baseUrl);
  await page.evaluate(() => { window.__n = 0; new MutationObserver(() => { if (/\(render \d+/.test(document.getElementById('status').textContent)) window.__n++; }).observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true }); });
  await page.setInputFiles('#pick', photo);
  await page.waitForFunction(() => !document.querySelector('#export')?.disabled, null, { timeout: 900000 });
  let seen = await page.evaluate(() => window.__n);
  // the full preview's size (the status line reads `${w}×${h} · ...`): a reduced render while a slider moves (app.js LOW_SCALE)
  // shows a smaller size, and its rest render (full) follows; the metrics are read only once a full-size render is the last one
  const full = await page.evaluate(() => document.getElementById('status').textContent.split(' ')[0]);
  const settle = async () => {
    for (;;) {
      await page.waitForTimeout(1500);
      const [n, st] = await page.evaluate(() => [window.__n, document.getElementById('status').textContent]);
      if (n === seen && st.startsWith(full + ' ')) break;
      seen = n;
    }
  };
  const set = async (id, v) => { await page.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]); await page.waitForFunction((s) => window.__n > s, seen, { timeout: 900000 }).catch(() => {}); await settle(); };
  // the canvas read only once it stops changing: two reads 2 s apart equal (a late render, e.g. a rest render after a
  // reduced one or the scanner's own re-read, otherwise lands between the 'before' and the move: runs differed by 4 L*)
  const stable = async () => {
    let m = await page.evaluate(METRICS);
    for (;;) { await page.waitForTimeout(2000); const n = await page.evaluate(METRICS); if (JSON.stringify(n) === JSON.stringify(m)) return n; m = n; }
  };
  const scan = async (s) => { await page.evaluate((b) => document.getElementById(b).click(), s === 'none' ? 'scanNone' : 'scanFrontier'); await page.waitForTimeout(500); await settle(); };
  const got = {}; let cur = null;
  for (const [id, v, s, m] of DIRECTION) {
    if (s !== cur) { await scan(s); cur = s; }
    const def = await page.evaluate((id) => document.getElementById(id).value, id);
    const a = await stable(); await set(id, v); const b = await stable(); await set(id, def);
    got[`${id}@${s}`] = Object.fromEntries(Object.keys(a).map((k) => [k, +(b[k] - a[k]).toFixed(4)]));
  }
  await browser.close();
  let bad = 0;
  for (const [id, v, s, m, sg] of DIRECTION) {
    const dlt = got[`${id}@${s}`][m];
    if (Math.sign(dlt) !== sg) { bad++; console.log(`  ${id} (${s}) -> ${v}: ${m} moved ${dlt} (expected ${sg > 0 ? 'up' : 'down'})`); }
  }
  if (update || !fs.existsSync(BASE)) { fs.writeFileSync(BASE, JSON.stringify(got, null, 1)); console.log(`sliders: baseline written (${BASE})`); }
  else {
    // the size of each slider's effect on its own metric: within TOL of the baseline (the render is deterministic; 3 %: a choice)
    const base = JSON.parse(fs.readFileSync(BASE)), TOL = 0.03;
    for (const [id, v, s, m] of DIRECTION) {
      const k = `${id}@${s}`, g = got[k][m], o = base[k]?.[m];
      if (o === undefined || Math.abs(g - o) > TOL * Math.max(Math.abs(o), 1e-3)) { bad++; console.log(`  ${k} ${m}: effect ${o} -> ${g}`); }
    }
  }
  if (errs.length) { bad++; console.log('  page errors: ' + errs.join(' | ')); }
  console.log(`sliders: ${bad ? `${bad} problem(s)` : 'OK'} (${DIRECTION.length} moves, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('sliders: ERR ' + (e?.stack || e)); process.exit(2); });
