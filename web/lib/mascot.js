// The photo's mascot (UI 2, user 2026-11-07): a small 16-bit film canister (4.32; 8-bit 16 x 16 in 4.31) in the photo's corner that looks at the rendered
// frame and speaks only when something is clearly off, with the tool that fixes it (a tap on its bubble opens that tool).
// The checks are measured against real Gold 200 lab scans: the 20 frames of samples/kg200 (whole frame, CIE L* a* b*). "Only
// when it matters" (user): each threshold sits past what a real lab scan does, so it speaks on 3 of those 20 (a window
// burnt by the lab: 9 % white; a night frame: 6 % black; a sunlit field: median L* 81) and stays quiet on the rest:
//   - burnt whites: share of pixels with all three channels >= 250 (real: 0 on 15 frames, 0.1-0.5 on 3) -> over WHITE_CLIP_PCT;
//   - blocked blacks: share with the brightest channel <= 6 (real: up to 1.7 but the night frame) -> over BLACK_CLIP_PCT;
//   - too dark / too light: the frame's median L* (real 40..81, 10th-90th percentile 44..71) -> under DARK_L / over LIGHT_L;
//   - a cast, two ways (user 2026-11-07: an extreme Temperatura passed as "ok"; Nessuno's inversion takes the cast off the
//     greys, so the whole palette turns instead): the least saturated fifth's median a* / b* beyond any real scan's (real
//     |cast| up to 12.7) -> over CAST_ABS; or, against the same frame as the scanner shown gives it with every slider at its
//     default (fitAgainst: the final product judged against its own scanner, never another's look: user 2026-11-07, the
//     advice read Frontier against Nessuno, so a scanner switch or Vividezza on Noritsu "turned the colours"), a cast laid
//     over the colours beyond CAST_SHIFT. Measured on the check.py photos (4 iPhone DNGs: cat, sea, rock, sunset; an ORF; a
//     JPEG cat) x the three scanners: Temperatura -2000 gives 8.9-14.9 on Nessuno, 7.3-12.2 on Frontier / Noritsu (their
//     AutoSetup takes part of it out; the grey rock on Frontier 5.7, caught by its chroma x1.41 below), +2000 15-32; Saturazione
//     +-9 and Vividezza 100 at most 2.9. Temperatura +-1000 gives 3.5-14: a warm +1000 is mostly over, -1000 half of the time;
//   - the colours' strength: the median chroma against the same reference, over SAT_UP or under SAT_DOWN (Saturazione +9 / -9,
//     the lab's own range: x1.35-1.55 / x0.46-0.57; Vividezza 100 x0.99-1.46, so at its end it speaks on vivid frames: 4 of 18;
//     the fit's k reads Saturazione +9 as low as 1.19 on the ORF, under Vividezza's 1.22), or out of the real scans' 4.2..26.7
//     (CHROMA_MIN / CHROMA_MAX).
// One advice at a time, in that order (what is lost first: clipped tones cannot come back). It never opens its bubble by itself
// (user 2026-11-08: "troppo chiacchierona ... deve saltellare quando ha info, così non mi copre tutto lo schermo"): with an
// advice it hops now and then, mouth open, until tapped; with none it only blinks and breathes. A tap opens the advice (or a
// short "all fine"); a tap on the bubble, or its tool's button, closes it and the advice stays quiet for this photo. No DOM outside the mascot's own elements; the host (ui2.js) gives the photo's pixels and opens tools.

import { W, H, PAL, IDLE, FRAMES } from './rullino.js';

const WHITE_CLIP_PCT = 3, BLACK_CLIP_PCT = 3, DARK_L = 40, LIGHT_L = 78;
const CAST_ABS = 14, CAST_SHIFT = 6, SAT_UP = 1.3, SAT_DOWN = 0.7, CHROMA_MIN = 3, CHROMA_MAX = 30;
const STEP = 4;   // every 4th pixel each way: a 1500 px preview gives ~140 k samples, ~5 ms

// linear RGB -> XYZ (D65): Display P3 (the canvas, outSpace 'p3') and sRGB
const M = {
  'display-p3': [[0.4866, 0.2657, 0.1982], [0.2290, 0.6917, 0.0793], [0.0000, 0.0451, 1.0439]],
  srgb: [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]],
};
const dec = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);   // both spaces use the sRGB transfer
const LUT = Float32Array.from({ length: 256 }, (_, i) => dec(i / 255));
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

const median = (arr) => { const s = Float32Array.from(arr).sort(); return s.length ? s[s.length >> 1] : 0; };
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/** Frame statistics of an ImageData: { medianL, lo (p5 L*), hi (p95 L*), whitePct, blackPct, castA, castB (the cast:
 * median a* / b* of the least saturated fifth of the pixels at L* 15..95), chroma (median C*), L, A, B (the samples' L* a* b*,
 * for fitAgainst) }. */
export function analyse(img) {
  const m = M[img.colorSpace] || M.srgb, { data, width, height } = img;
  const n = Math.ceil(width / STEP) * Math.ceil(height / STEP);
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n);
  let white = 0, black = 0, k = 0;
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP, k++) {
      const i = (y * width + x) * 4, r8 = data[i], g8 = data[i + 1], b8 = data[i + 2];
      if (r8 >= 250 && g8 >= 250 && b8 >= 250) white++;
      if (Math.max(r8, g8, b8) <= 6) black++;
      const r = LUT[r8], g = LUT[g8], b = LUT[b8];
      const X = (m[0][0] * r + m[0][1] * g + m[0][2] * b) / 0.95047, Y = m[1][0] * r + m[1][1] * g + m[1][2] * b;
      const Z = (m[2][0] * r + m[2][1] * g + m[2][2] * b) / 1.08883;
      const fy = f(Y);
      L[k] = 116 * fy - 16; A[k] = 500 * (f(X) - fy); B[k] = 200 * (fy - f(Z)); C[k] = Math.hypot(A[k], B[k]);
    }
  }
  const Ls = L.slice().sort();
  // the cast: whatever the frame's colours, its least saturated fifth carries the light's (a strong cast leaves no pixel
  // "neutral" by a fixed chroma, which is how a fixed cut missed an extreme Temperatura: user 2026-11-07)
  const mid = []; for (let i = 0; i < n; i++) if (L[i] > 15 && L[i] < 95) mid.push(i);
  const cq = quantile(Float32Array.from(mid, (i) => C[i]).sort(), 0.2);
  const low = mid.filter((i) => C[i] <= cq);
  return {
    medianL: quantile(Ls, 0.5) ?? 50, lo: quantile(Ls, 0.05) ?? 0, hi: quantile(Ls, 0.95) ?? 100,
    whitePct: 100 * white / n, blackPct: 100 * black / n,
    castA: median(low.map((i) => A[i])), castB: median(low.map((i) => B[i])), chroma: median(C), L, A, B,
  };
}

/** The frame `s` against `ref`, the same frame as its scanner gives it with every slider at its default (the same pixels: same
 * scanner, Interno, crop and turn), pixel by pixel over those at L* 15..95 in both: a* b* = k x the reference's + (tA, tB).
 * k (least squares) takes the colours' scale out, (tA, tB) is the cast laid over them: the median of what k leaves (the median:
 * Vividezza lifts the dull colours more than the vivid ones, which a mean offset reads as a cast). A saturation scales, a light
 * of another colour shifts, so neither reads as the other; the frame's mean a* b* moves with both (Saturazione +-9 moved it up
 * to 14, more than Temperatura -2000 on a lab scanner, 6-12). Null when the frames differ in size. */
export function fitAgainst(s, ref) {
  if (!ref || ref.L.length !== s.L.length) return null;
  const idx = [];
  for (let i = 0; i < s.L.length; i++) if (s.L[i] > 15 && s.L[i] < 95 && ref.L[i] > 15 && ref.L[i] < 95) idx.push(i);
  if (!idx.length) return null;
  let xa = 0, xb = 0, ya = 0, yb = 0;
  for (const i of idx) { xa += ref.A[i]; xb += ref.B[i]; ya += s.A[i]; yb += s.B[i]; }
  xa /= idx.length; xb /= idx.length; ya /= idx.length; yb /= idx.length;
  let sxy = 0, sxx = 0;
  for (const i of idx) {
    const da = ref.A[i] - xa, db = ref.B[i] - xb;
    sxy += da * (s.A[i] - ya) + db * (s.B[i] - yb); sxx += da * da + db * db;
  }
  const k = sxx > 0 ? sxy / sxx : 1;
  return { k, tA: median(idx.map((i) => s.A[i] - k * ref.A[i])), tB: median(idx.map((i) => s.B[i] - k * ref.B[i])) };
}

const SHORT_OF = { labSat: 'Saturazione', vibrance: 'Vividezza', temp: 'Temperatura luce' };

/** The first advice for statistics `s` (analyse), or null. `scanner`: 'none' | 'frontier' | 'noritsu'; `has(id)`: the tool
 * is shown; `ref`: the statistics of the same frame as this scanner gives it with every slider at its default, or null;
 * `modified(id)`: moved from its default. Advice: { key, text, tool }. */
export function advise(s, scanner, has, ref = null, modified = () => false) {
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
  // colour: what the sliders did against this scanner's own default (fitAgainst), and the frame against the real scans
  const mod = (id) => has(id) && modified(id), fit = fitAgainst(s, ref);
  const shifted = !!fit && Math.hypot(fit.tA, fit.tB) > CAST_SHIFT, absCast = Math.hypot(s.castA, s.castB) > CAST_ABS;
  if (shifted || absCast) {
    const [ca, cb] = shifted ? [fit.tA, fit.tB] : [s.castA, s.castB];
    const byA = Math.abs(ca) > Math.abs(cb), own = byA ? 'mshift' : 'yshift';
    const what = byA ? (ca > 0 ? 'il magenta' : 'il verde') : (cb > 0 ? 'il giallo-arancio' : 'il blu');
    // a cast the sliders made: the slider that made it (on the blue-yellow axis the light's colour first), else the axis' own
    const t = (shifted && (byA ? [own, 'temp'] : ['temp', own]).find(mod)) || pick(own, 'temp');
    const how = t === 'temp' ? 'riporta Temperatura luce verso 0' : t === 'mshift' ? 'sposta Magenta ↔ Verde dall\'altra parte' : 'sposta Giallo ↔ Blu dall\'altra parte';
    const vs = shifted ? 'rispetto alla stessa scansione senza ritocchi' : 'più di qualunque scansione Gold vera';
    if (t) return { key: 'cast', text: `I colori virano verso ${what} (${vs}). Se non è voluto, ${how}.`, tool: t };
  }
  // the colours' strength: the slider that moved it (Temperatura too: on a near-grey frame a light's colour scales the little
  // colour there is), else the saturation of the scanner shown
  const ratio = fit && ref.chroma > 1 ? s.chroma / ref.chroma : 1, vsRef = `x${ratio.toFixed(1)} rispetto alla scansione senza ritocchi`;
  const satTool = () => ['labSat', 'vibrance', 'temp'].find(mod) || pick('labSat', 'vibrance');
  const name = (t, verb) => (t === 'temp' ? 'riporta Temperatura luce verso 0' : `${verb} ${SHORT_OF[t] || 'la saturazione'}`);
  if (ratio > SAT_UP || s.chroma > CHROMA_MAX) {
    const t = satTool();
    return { key: 'sat', text: `Colori molto più carichi del normale (${ratio > SAT_UP ? vsRef : 'oltre ogni scansione Gold vera'}). La Gold è calda ma non fluo: ${name(t, 'abbassa')}.`, tool: t };
  }
  if (ratio < SAT_DOWN || s.chroma < CHROMA_MIN) {
    const t = satTool();
    return { key: 'sat', text: `Colori molto spenti (${ratio < SAT_DOWN ? vsRef : 'meno di qualunque scansione Gold vera'}): ${name(t, 'alza')}.`, tool: t };
  }
  return null;
}

// --- the sprite: Rullino, 48 x 48, 16-bit style (original design: a generic film canister, metal caps, a label with a face, the
// film leader on its side). The pixels are generated data (lib/rullino.js, from scripts/mascot/sprite48.py).
const rows = (name) => (name === 'idle' ? IDLE : IDLE.map((r, y) => FRAMES[name][y] ?? r));
const SPRITE = Object.fromEntries(['idle', ...Object.keys(FRAMES)].map((n) => [n, rows(n)]));

function paint(cx, name) {
  cx.clearRect(0, 0, W, H);
  SPRITE[name].forEach((row, y) => {
    for (let x = 0; x < W; x++) {
      const p = PAL[row[x]];
      if (p) { cx.fillStyle = p; cx.fillRect(x, y, 1, 1); }
    }
  });
}

// idle: one frame per beat, slowly (breathing every other beat, the leader flicks now and then, a blink every ~6 s: never in step,
// it looks alive, not looped); talking: the mouth follows the text as it types, shut on spaces
const BEAT_MS = 700, TYPE_MS = 28;
const BLINK = ['blink_half', 'blink', 'blink_half'];
const TALK = ['talk_half', 'talk_open', 'talk_half', 'talk_closed'];
const idleFrame = (t) => (t % 9 < 3 ? BLINK[t % 9] : t % 5 === 0 ? 'wiggle' : t % 2 ? 'breathe' : 'idle');

const CSS = `
#u2mascot { position: absolute; left: 8px; bottom: 34px; z-index: 6; display: flex; align-items: flex-end; gap: 6px; pointer-events: none; }
#u2mascot canvas { width: 48px; height: 48px; image-rendering: pixelated; pointer-events: auto; cursor: pointer; filter: drop-shadow(0 1px 1px #0008); }
/* an advice waiting: two hops (pixel steps, no easing) every 2.4 s (a choice: noticeable, not a fidget) */
#u2mascot.alert canvas { animation: u2alert 2.4s infinite step-end; }
@keyframes u2alert { 0% { transform: none; } 4% { transform: translateY(-5px); } 9% { transform: none; } 13% { transform: translateY(-3px); } 18%, 100% { transform: none; } }
#u2bubble { pointer-events: auto; max-width: min(62vw, 260px); margin-bottom: 26px; padding: 8px 10px; border-radius: 4px;
  background: #f6efe1; color: #2a2522; font: 12px/1.35 ui-monospace, Menlo, monospace; box-shadow: 0 0 0 2px #2a2522, 0 3px 0 2px #0006;
  position: relative; }
#u2bubble::after { content: ''; position: absolute; left: -8px; bottom: 6px; border: 4px solid transparent; border-right-color: #2a2522;
  border-bottom-color: #2a2522; }
#u2bubble[hidden] { display: none; }
#u2bubble .rest { color: transparent; }
#u2bubble button { margin-top: 6px; display: block; font: inherit; font-weight: 600; color: #2a2522; background: #e0b04a; border: 0;
  border-radius: 3px; padding: 3px 8px; box-shadow: 0 2px 0 #8a6a2a; }
@media (prefers-reduced-motion: reduce) { #u2mascot.alert canvas { animation: none; } }
`;

/** The mascot in `stage` (the photo's container). host: { scanner(): 'none'|'frontier'|'noritsu', has(id), openTool(id),
 * name(id): the tool's short name, modified(id), renderDefault(key): Promise of the frame as the scanner shown gives it with
 * every slider at its default (ImageData; null when `key` is no longer what is shown) }.
 * Returns { update(img, look): analyse a newly rendered frame (debounced; look: { key: what its default render depends on,
 * the scanner, Interno and the frame; atDefault: its sliders were all at their default }), reset(): a new photo }. */
export function initMascot(stage, host) {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  stage.insertAdjacentHTML('beforeend', `<div id="u2mascot" hidden><canvas width="${W}" height="${H}" aria-label="Consigli sulla foto" role="button"></canvas><div id="u2bubble" hidden></div></div>`);
  const box = stage.querySelector('#u2mascot'), cv = box.querySelector('canvas'), cx = cv.getContext('2d'), bubble = box.querySelector('#u2bubble');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let beat = 0, talking = 0;
  paint(cx, 'idle');
  setInterval(() => {
    if (box.hidden || document.hidden || reduce.matches || talking) return;
    const f = idleFrame(++beat);
    paint(cx, waiting() && (f === 'idle' || f === 'breathe') ? 'talk_half' : f);   // an advice waiting: an "oh!" face between blinks
  }, BEAT_MS);

  // refs: defaultKey -> Promise of the statistics of the photo as that scanner gives it with every slider at its default (the
  // final render itself when it is that, else one off-screen render): the reference of the colour checks, per scanner, so that
  // a scanner's own look is never read as an edit (user 2026-11-07: the advice judged Frontier against Nessuno)
  let advice = null, dismissed = new Set(), timer = 0, quietOk = 0, refs = new Map(), seq = 0;
  let shown = null;   // the key of the advice in the open bubble
  const waiting = () => advice && !dismissed.has(advice.key) && bubble.hidden;
  const alert = () => box.classList.toggle('alert', !!waiting());
  // the text types out with the mouth moving, then the tool's button (reduced motion: all at once, mouth still)
  const show = (a) => {
    clearInterval(talking); talking = 0; shown = a?.key ?? null;
    if (!a) { bubble.hidden = true; paint(cx, 'idle'); alert(); return; }
    bubble.innerHTML = '';
    // the untyped rest is there but transparent: the bubble has its final size from the first letter (no reflow while it types)
    const text = document.createTextNode(''), rest = document.createElement('span'), button = a.tool && document.createElement('button');
    rest.className = 'rest';
    bubble.append(text, rest);
    if (button) {
      button.textContent = `Apri ${host.name?.(a.tool) || ''}`.trim();
      button.onclick = (e) => { e.stopPropagation(); dismissed.add(a.key); show(null); host.openTool(a.tool); };
      button.style.visibility = 'hidden';   // in place from the start, shown once the text is typed
      bubble.append(button);
    }
    const done = () => { clearInterval(talking); talking = 0; text.data = a.text; rest.textContent = ''; if (button) button.style.visibility = ''; paint(cx, 'idle'); };
    bubble.hidden = false; alert();
    if (reduce.matches) { done(); return; }
    let n = 0;
    talking = setInterval(() => {
      if (++n >= a.text.length) { done(); return; }
      text.data = a.text.slice(0, n); rest.textContent = a.text.slice(n);
      paint(cx, a.text[n - 1] === ' ' ? 'talk_closed' : TALK[(n >> 1) % TALK.length]);
    }, TYPE_MS);
  };
  bubble.onclick = () => { if (advice) dismissed.add(advice.key); show(null); };
  // a tap on the mascot: the current advice again, or a short "all fine" when there is none
  cv.onclick = () => {
    if (!bubble.hidden) { if (advice) dismissed.add(advice.key); show(null); return; }   // a second tap closes it
    if (advice) { dismissed.delete(advice.key); show(advice); return; }
    const ok = { key: 'ok', text: 'Tutto ok: luci, ombre, dominante e saturazione dentro quello che fanno le scansioni Gold vere.' };
    show(ok);
    clearTimeout(quietOk); quietOk = setTimeout(() => { if (!advice) show(null); }, 2500 + TYPE_MS * ok.text.length);   // 2.5 s to read it once typed
  };
  // the reference of a frame rendered with `look` ({ key, atDefault }, taken when its render started)
  const reference = (look, st) => {
    const map = refs, { key } = look;
    if (look.atDefault) map.set(key, Promise.resolve(st));   // this frame is the default one: its own reference
    if (!map.has(key)) {
      const p = host.renderDefault(key).then((img) => (img ? analyse(img) : null), () => null);
      map.set(key, p);
      p.then((r) => { if (!r && map.get(key) === p) map.delete(key); });   // not rendered (the frame moved on): asked again later
    }
    return map.get(key);
  };
  let last = null, lastLook = null;
  const api = {
    update(img, look) {
      last = img; lastLook = look;
      clearTimeout(timer);
      // after the edits settle: a slider drag renders many frames, the advice follows the last one
      timer = setTimeout(async () => {
        const my = ++seq, st = analyse(img), ref = look ? await reference(look, st) : null;
        if (my !== seq) return;   // a newer frame or photo came while the reference rendered
        box.hidden = false;
        advice = advise(st, host.scanner(), host.has, ref, host.modified);
        if (!advice || dismissed.has(advice.key)) { if (shown !== 'ok') show(null); }   // an open bubble whose advice is gone closes
        else if (!bubble.hidden && shown !== advice.key) show(advice);   // open on another advice: this one
        alert();
      }, 600);
    },
    // a new photo: its references start again (its first render is already on screen when the load ends)
    reset() { seq++; dismissed = new Set(); advice = null; refs = new Map(); show(null); if (last) api.update(last, lastLook); },
  };
  return api;
}
