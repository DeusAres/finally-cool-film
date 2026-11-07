// The photo's mascot (UI 2, user 2026-11-07): a small 8-bit film canister in the photo's corner that looks at the rendered
// frame and speaks only when something is clearly off, with the tool that fixes it (a tap on its bubble opens that tool).
// The checks are measured against real Gold 200 lab scans: the 20 frames of samples/kg200 (whole frame, CIE L* a* b*). "Only
// when it matters" (user): each threshold sits past what a real lab scan does, so it speaks on 3 of those 20 (a window
// burnt by the lab: 9 % white; a night frame: 6 % black; a sunlit field: median L* 81) and stays quiet on the rest:
//   - burnt whites: share of pixels with all three channels >= 250 (real: 0 on 15 frames, 0.1-0.5 on 3) -> over WHITE_CLIP_PCT;
//   - blocked blacks: share with the brightest channel <= 6 (real: up to 1.7 but the night frame) -> over BLACK_CLIP_PCT;
//   - too dark / too light: the frame's median L* (real 40..81, 10th-90th percentile 44..71) -> under DARK_L / over LIGHT_L;
//   - a cast: mean a* / b* of the near-neutral pixels (chroma < 10, L* 20..90: pale skies count, real up to 6.2) -> beyond
//     CAST, when at least NEUTRAL_MIN of the frame is near neutral (a frame of saturated colours says nothing about the light).
// One advice at a time, in that order (what is lost first: clipped tones cannot come back). A dismissed advice stays quiet
// for this photo. No DOM outside the mascot's own elements; the host (ui2.js) gives the photo's pixels and opens tools.

const WHITE_CLIP_PCT = 3, BLACK_CLIP_PCT = 3, DARK_L = 40, LIGHT_L = 78, CAST = 7, NEUTRAL_MIN = 0.05;
const STEP = 4;   // every 4th pixel each way: a 1500 px preview gives ~140 k samples, ~5 ms

// linear RGB -> XYZ (D65): Display P3 (the canvas, outSpace 'p3') and sRGB
const M = {
  'display-p3': [[0.4866, 0.2657, 0.1982], [0.2290, 0.6917, 0.0793], [0.0000, 0.0451, 1.0439]],
  srgb: [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]],
};
const dec = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);   // both spaces use the sRGB transfer
const LUT = Float32Array.from({ length: 256 }, (_, i) => dec(i / 255));
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** Frame statistics of an ImageData: { medianL, whitePct, blackPct, castA, castB, neutralShare }. */
export function analyse(img) {
  const m = M[img.colorSpace] || M.srgb, { data, width, height } = img;
  const L = [];
  let white = 0, black = 0, n = 0, na = 0, sa = 0, sb = 0;
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = (y * width + x) * 4, r8 = data[i], g8 = data[i + 1], b8 = data[i + 2];
      n++;
      if (r8 >= 250 && g8 >= 250 && b8 >= 250) white++;
      if (Math.max(r8, g8, b8) <= 6) black++;
      const r = LUT[r8], g = LUT[g8], b = LUT[b8];
      const X = (m[0][0] * r + m[0][1] * g + m[0][2] * b) / 0.95047, Y = m[1][0] * r + m[1][1] * g + m[1][2] * b;
      const Z = (m[2][0] * r + m[2][1] * g + m[2][2] * b) / 1.08883;
      const fy = f(Y), l = 116 * fy - 16, a = 500 * (f(X) - fy), bb = 200 * (fy - f(Z));
      L.push(l);
      if (l > 20 && l < 90 && Math.hypot(a, bb) < 10) { na++; sa += a; sb += bb; }
    }
  }
  L.sort((p, q) => p - q);
  return {
    medianL: L[L.length >> 1] ?? 50, whitePct: 100 * white / n, blackPct: 100 * black / n,
    castA: na ? sa / na : 0, castB: na ? sb / na : 0, neutralShare: na / n,
  };
}

/** The first advice for statistics `s`, or null. `scanner`: 'none' | 'frontier' | 'noritsu'; `has(id)`: the tool is shown.
 * Advice: { key, text, tool }. */
export function advise(s, scanner, has) {
  const lab = scanner !== 'none', pct = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
  const pick = (...ids) => ids.find((id) => has(id)) || null;
  const bright = lab ? pick('labD', 'ev') : pick('nbBright', 'ev'), brightName = bright === 'labD' ? 'Densità' : bright === 'nbBright' ? 'Luminosità' : 'Esposizione';
  if (s.whitePct > WHITE_CLIP_PCT) {
    const t = lab ? pick('labHi', 'labD', 'ev') : bright;
    const how = t === 'labHi' ? 'a mettere Tono luci su Soft o ad abbassare Densità' : `ad abbassare ${brightName}`;
    return { key: 'white', text: `Bianchi bruciati sul ${pct(s.whitePct)} della foto. Prova ${how}.`, tool: t };
  }
  if (s.blackPct > BLACK_CLIP_PCT) {
    const t = lab ? pick('labLo', 'htLo', 'labD') : bright;
    const how = t === 'labLo' ? 'a mettere Tono ombre su Soft' : t === 'htLo' ? 'HT ombre' : `ad alzare ${brightName}`;
    return { key: 'black', text: `Neri chiusi sul ${pct(s.blackPct)} della foto. Prova ${how}.`, tool: t };
  }
  const lvl = `luce media ${Math.round(s.medianL)}; le scansioni Gold vere di solito 44-71`;
  if (s.medianL < DARK_L) return { key: 'dark', text: `Un po' scura per una Gold (${lvl}). Prova ad alzare ${brightName}.`, tool: bright };
  if (s.medianL > LIGHT_L) return { key: 'light', text: `Molto chiara (${lvl}). Prova ad abbassare ${brightName}.`, tool: bright };
  if (s.neutralShare >= NEUTRAL_MIN && Math.max(Math.abs(s.castA), Math.abs(s.castB)) > CAST) {
    const byA = Math.abs(s.castA) >= Math.abs(s.castB);
    const t = pick(byA ? 'mshift' : 'yshift');
    // the opposite end of the slider (Magenta ↔ Verde / Giallo ↔ Blu)
    const [what, fix] = byA ? (s.castA > 0 ? ['magenta', 'Magenta ↔ Verde verso il Verde'] : ['verde', 'Magenta ↔ Verde verso il Magenta'])
      : (s.castB > 0 ? ['gialla', 'Giallo ↔ Blu verso il Blu'] : ['blu', 'Giallo ↔ Blu verso il Giallo']);
    if (t) return { key: 'cast', text: `I grigi hanno una dominante ${what}. Sposta ${fix}.`, tool: t };
  }
  return null;
}

// --- the sprite: 16 x 16, original design (a generic film canister: metal caps, a label, eyes, the film leader on its side)
const PAL = { k: '#1d1b1a', g: '#8d939a', l: '#c9ced3', o: '#e08a3c', c: '#f2e3c4', w: '#ffffff', b: '#1d1b1a', f: '#5a3a26', r: '#f2a0a0' };
const BODY = [
  '.....kkkkk......',
  '....kllllk......',
  '..kkkkkkkkkk....',
  '..kggggggggk....',
  '..kkkkkkkkkk....',
  '..kccccccccfff..',
  '..kcwwccwwcfff..',
  '..kcwbccwbckff..',
  '..kccccccccfff..',
  '..korccccrokfk..',
  '..koocbbcoock...',
  '..koooooooook...',
  '..kkkkkkkkkk....',
  '..kggggggggk....',
  '..kkkkkkkkkk....',
  '................',
];
const BLINK = { 6: '..kckkcckkcfff..', 7: '..kccccccccfkf..' };   // eyes shut (rows 6 / 7)
const WIGGLE = { 5: '..kccccccccfffk.', 8: '..kccccccccffk..' };   // the film leader's tip moves

function paint(cx, frame) {
  cx.clearRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) {
    const row = (frame.blink && BLINK[y]) || (frame.wiggle && WIGGLE[y]) || BODY[y];
    for (let x = 0; x < 16; x++) {
      const p = PAL[row[x]];
      if (p) { cx.fillStyle = p; cx.fillRect(x, y, 1, 1); }
    }
  }
}

const CSS = `
#u2mascot { position: absolute; left: 8px; bottom: 34px; z-index: 6; display: flex; align-items: flex-end; gap: 6px; pointer-events: none; }
#u2mascot canvas { width: 48px; height: 48px; image-rendering: pixelated; pointer-events: auto; cursor: pointer; filter: drop-shadow(0 1px 1px #0008); }
#u2mascot.hop canvas { animation: u2hop 0.5s steps(3) 2; }
@keyframes u2hop { 50% { transform: translateY(-4px); } }
#u2bubble { pointer-events: auto; max-width: min(62vw, 260px); margin-bottom: 26px; padding: 8px 10px; border-radius: 4px;
  background: #f6efe1; color: #2a2522; font: 12px/1.35 ui-monospace, Menlo, monospace; box-shadow: 0 0 0 2px #2a2522, 0 3px 0 2px #0006;
  position: relative; }
#u2bubble::after { content: ''; position: absolute; left: -8px; bottom: 6px; border: 4px solid transparent; border-right-color: #2a2522;
  border-bottom-color: #2a2522; }
#u2bubble[hidden] { display: none; }
#u2bubble button { margin-top: 6px; display: block; font: inherit; font-weight: 600; color: #2a2522; background: #e0b04a; border: 0;
  border-radius: 3px; padding: 3px 8px; box-shadow: 0 2px 0 #8a6a2a; }
@media (prefers-reduced-motion: reduce) { #u2mascot.hop canvas { animation: none; } }
`;

/** The mascot in `stage` (the photo's container). host: { scanner(): 'none'|'frontier'|'noritsu', has(id), openTool(id),
 * name(id): the tool's short name }.
 * Returns { update(img): analyse a newly rendered frame (debounced), reset(): a new photo }. */
export function initMascot(stage, host) {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  stage.insertAdjacentHTML('beforeend', '<div id="u2mascot" hidden><canvas width="16" height="16" aria-label="Consigli sulla foto" role="button"></canvas><div id="u2bubble" hidden></div></div>');
  const box = stage.querySelector('#u2mascot'), cv = box.querySelector('canvas'), cx = cv.getContext('2d'), bubble = box.querySelector('#u2bubble');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  // a few frames, slowly: the leader wiggles every ~0.7 s, a blink every few seconds (never in step: it looks alive, not looped)
  let frame = { blink: false, wiggle: false }, tick = 0;
  paint(cx, frame);
  setInterval(() => {
    if (box.hidden || document.hidden || reduce.matches) return;
    tick++;
    frame = { wiggle: tick % 2 === 1, blink: tick % 7 === 0 };
    paint(cx, frame);
  }, 700);

  let advice = null, dismissed = new Set(), timer = 0, quietOk = 0;
  const show = (a) => {
    if (!a) { bubble.hidden = true; return; }
    bubble.innerHTML = '';
    bubble.append(a.text);
    if (a.tool) {
      const b = document.createElement('button');
      b.textContent = `Apri ${host.name?.(a.tool) || ''}`.trim();
      b.onclick = (e) => { e.stopPropagation(); dismissed.add(a.key); bubble.hidden = true; host.openTool(a.tool); };
      bubble.append(b);
    }
    bubble.hidden = false;
    box.classList.remove('hop'); void box.offsetWidth; box.classList.add('hop');
  };
  bubble.onclick = () => { if (advice) dismissed.add(advice.key); bubble.hidden = true; };
  // a tap on the mascot: the current advice again, or a short "all fine" when there is none
  cv.onclick = () => {
    if (advice) { dismissed.delete(advice.key); show(advice); return; }
    show({ key: 'ok', text: 'Tutto ok: luci, ombre e colore nella media delle Gold vere.' });
    clearTimeout(quietOk); quietOk = setTimeout(() => { if (!advice) bubble.hidden = true; }, 2500);
  };
  return {
    update(img) {
      clearTimeout(timer);
      // after the edits settle: a slider drag renders many frames, the advice follows the last one
      timer = setTimeout(() => {
        box.hidden = false;
        advice = advise(analyse(img), host.scanner(), host.has);
        if (advice && !dismissed.has(advice.key)) show(advice); else bubble.hidden = true;
      }, 600);
    },
    reset() { dismissed = new Set(); advice = null; bubble.hidden = true; },
  };
}
