// UI 2 (the default since 4.25; the classic UI: its menu, or ?ui1): one big slider at a time, the tools of a group in a strip, four groups
// (Base, Scanner, Trasforma, Effetti), undo / redo and Esporta in the header, the export options in a sheet.
// Desktop (DESK, the same query as `desk` in app.js; user, 2026-11-11: "più friendly nella disposizione"): a right-hand column
// with the histogram on top, the groups as tabs and every tool of the group listed at once (Lightroom-style); the status
// line at its foot. The strip and one-slider-at-a-time stay for phones and portrait tablets.
// Built over the app's own controls: the classic panes stay in the page (hidden) and remain the one source of truth: UI 2
// sets their values and dispatches their events, reads their labels and their formatted outputs. Prototype: user, 2026-11-03.
import { store } from './util.js';
import { initMascot } from './mascot.js';
import { tiltRuler } from './ruler.js';
import { FRAME_STYLES, FRAME_NAMES } from './filmframe.js';

const $ = (id) => document.getElementById(id);

// Groups and their tools (input ids, in order). A tool whose row is in a hidden block (the scanner's own rows) is left out.
const GROUPS = [
  // Base: the camera and the film (stage boundaries, CLAUDE.md); the scanner's keys (density, colour) are the Scanner's.
  { id: 'base', name: 'Base', icon: 'base', tools: ['ev', 'temp', 'vibrance', 'grain', 'halation'] },
  { id: 'scanner', name: 'Scanner', icon: 'look', tools: ['scan', 'labD', 'nbBright', 'labGrad', 'labHi', 'labLo', 'labSat', 'labBright', 'htLo', 'htHi', 'hypersharp', 'mshift', 'yshift'] },
  { id: 'transform', name: 'Trasforma', icon: 'crop', tools: [] },
  { id: 'effects', name: 'Effetti', icon: 'fx', tools: ['texture', 'clarity', 'sharp', 'ca', 'vignette', 'falloff', 'dust'] },
];
// Short names for the strip (the full label, from the row, is the big slider's title).
const SCANS = ['scanNone', 'scanFrontier', 'scanNoritsu'];
const SHORT = { scan: 'Scanner', ev: 'Esposiz.', labD: 'Densità', nbBright: 'Luminos.', temp: 'Luce', mshift: 'Magenta', yshift: 'Giallo', vibrance: 'Vividezza',
  grain: 'Grana', labGrad: 'Gradaz.', labHi: 'Luci', labLo: 'Ombre', labSat: 'Saturaz.', labBright: 'Bright', htLo: 'HT ombre',
  htHi: 'HT luci', hypersharp: 'Hyper Sh.', halation: 'Halation', texture: 'Texture', clarity: 'Chiarezza', sharp: 'Nitidezza',
  ca: 'Aberraz.', vignette: 'Vignett.', falloff: 'Falloff', dust: 'Polvere' };
const I = {
  base: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  look: '<rect x="3" y="8" width="18" height="10" rx="2"/><path d="M6 13h12M8 5h8"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
  fx: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  ev: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  dens: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5z" fill="currentColor"/>',
  temp: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/>',
  tint: '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/>',
  drop: '<path d="M12 3.2c3.6 4.2 6 7.2 6 10.3a6 6 0 0 1-12 0c0-3.1 2.4-6.1 6-10.3z"/>',
  grain: '<circle cx="7" cy="8" r="1.2"/><circle cx="13" cy="6" r="1"/><circle cx="17" cy="11" r="1.3"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="17" r="1.1"/><circle cx="6" cy="18" r=".9"/>',
  curve: '<path d="M3 20C9 20 9 4 21 4"/>',
  hi: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor"/>',
  lo: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17" fill="currentColor"/>',
  sat: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17"/>',
  sharp: '<path d="M4 20 12 4l8 16z"/>',
  glow: '<circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>',
  lens: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>',
  level: '<path d="M3 12h18"/><path d="M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  // a film strip: the frame and its sprocket holes (Cornice)
  frame: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><rect x="7" y="8" width="10" height="8" rx="1"/><path d="M6 6h1M10.5 6h1M15 6h1M6 18h1M10.5 18h1M15 18h1"/>',
  movie: '<rect x="2.5" y="4.5" width="19" height="14" rx="2"/><rect x="4.5" y="6.5" width="7" height="5" rx="1"/><path d="M9 21h6"/>',
  open: '<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.5H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  undo: '<path d="M9 7H15a5 5 0 0 1 0 10H8"/><path d="M12 4 9 7l3 3"/>',
  redo: '<path d="M15 7H9a5 5 0 0 0 0 10h7"/><path d="M12 4l3 3-3 3"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  reset: '<path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 1.6-7.4L4 10"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  ig: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/>',
};
const ICON = { scan: 'look', ev: 'ev', labD: 'dens', nbBright: 'dens', temp: 'temp', mshift: 'tint', yshift: 'tint', vibrance: 'drop', grain: 'grain',
  labGrad: 'curve', labHi: 'hi', labLo: 'lo', labSat: 'sat', labBright: 'ev', htLo: 'lo', htHi: 'hi', hypersharp: 'sharp',
  halation: 'glow', texture: 'grain', clarity: 'sat', sharp: 'sharp', ca: 'lens', vignette: 'lens', falloff: 'lens', dust: 'fx' };
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;

// Motion: a group / tool change slides the content the way the selection moved (FLOW +1, user: from a tab on the left to one
// on the right the content goes left -> right, "si vede che si sposta"; -1 would be the carousel convention), by a share of
// the panel's width (groups SLIDE_W, a tool's title + slider TOOL_W) with a blur (BLUR_PX, half for a tool), eased out;
// "Riduci movimento" keeps only the fade. Choices.
const DESK = matchMedia('(orientation: landscape) and (min-width: 900px) and (min-height: 500px)');
const FLOW = 1, SLIDE_W = 0.35, TOOL_W = 0.25, BLUR_PX = 6, SLIDE_MS = 260, TOOL_MS = 200;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
// Bordo (Trasforma since 4.35, user: a ruler with ticks and a preview; it was in the export sheet): 0..10 % of the long side
// (#borderPct: its max and step), ticks every BORDER_TICK %, a number every 1 %, BORDER_PX px per 1 % (the tilt dial's 10 px per tick);
// swatches; the app reads #borderPct / #borderColor (app.js). The Cornice (filmframe.js) sits next to it: #frame.
const BORDER_TICK = 0.25, BORDER_PX = 40, SWATCHES = ['#ffffff', '#f3ead8', '#d9d4cc', '#111111'];

/** Haptic tick. Android: navigator.vibrate (also during a slider drag). iOS has no vibrate API, and a `switch` checkbox toggled
 * by script no longer ticks (WebKit plays its haptic only on a real tap, bug 285120; the user's iPhone, 4.25 test: a real
 * switch ticks, a scripted one does not, a real but invisible one does). So on iOS every tappable control carries an
 * invisible native switch under the finger (tapTicks): the tap itself toggles it and iOS ticks. A slider drag cannot tick. */
const haptic = () => navigator.vibrate?.(5);
const TICK = '<input type="checkbox" switch class="u2hx" tabindex="-1" aria-hidden="true">';
/** Horizontal strips: a native switch takes a sideways drag as its own (it slides the switch), so the strip would not
 * scroll (the user's iPhone, 4.26). Their buttons get no switch and no tick. */
const SCROLLERS = '.u2tools, #cropFormats';
/** Give every button under `root` its invisible switch (the tap lands on it, bubbles to the button's handler). */
function tapTicks(root) {
  const btns = [...(root.querySelectorAll ? root.querySelectorAll('button') : []), ...(root.tagName === 'BUTTON' ? [root] : [])];
  for (const b of btns) if (!b.closest(SCROLLERS) && !b.querySelector(':scope > .u2hx')) b.insertAdjacentHTML('beforeend', TICK);
}

/**
 * Start UI 2. `api`: { baseOf(id): the value a tool resets to; snapshot(): the edit state; restore(s) (async: a 90° turn);
 * openTab(name): the classic tab whose side effects a group needs ('transform': the crop overlay, else 'film'); rotate(q):
 * a quarter turn (resolves when done); exportFull(ig) }.
 */
export function initUI2(api) {
  document.body.classList.add('ui2');
  // Home-screen app (standalone, black-translucent status bar): iOS sizes 100dvh short of the screen by the top inset (the
  // user's iPhone 17 Pro Max: ~62 pt of empty bar under the tabs); the page takes the whole screen there.
  const fitScreen = () => {
    if (!(navigator.standalone || matchMedia('(display-mode: standalone)').matches)) return;
    // the whole screen, whatever 100dvh and innerHeight report there (the panel then sits on the bottom edge)
    document.documentElement.style.height = document.body.style.height = `${innerWidth < innerHeight ? screen.height : screen.width}px`;
  };
  fitScreen(); addEventListener('resize', fitScreen);
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  const controls = $('controls');
  // header: open / menu, undo, redo, Esporta
  document.querySelector('header').insertAdjacentHTML('beforeend', `<div class="u2head">
    <button class="u2ib" id="u2movie" aria-label="Modalità Movie: tutto a destra, spazio libero a sinistra" title="Movie">${svg('movie')}</button>
    <button class="u2ib" id="u2menu" aria-label="Foto e impostazioni">${svg('open')}</button>
    <button class="u2ib" id="u2undo" aria-label="Annulla">${svg('undo')}</button>
    <button class="u2ib" id="u2redo" aria-label="Ripeti">${svg('redo')}</button>
    <button class="u2ib u2pri" id="u2export">${svg('share')}<span>Esporta</span></button></div>`);
  controls.insertAdjacentHTML('beforebegin', `<div id="u2">
    <div class="u2slot" id="u2slot"></div>
    <nav class="u2nav">${GROUPS.map((g) => `<button data-g="${g.id}">${svg(g.icon)}<span>${g.name}</span></button>`).join('')}</nav></div>`);
  const slot = $('u2slot');
  // the status line (render times, messages; a tap opens the log, as in the classic UI) on the photo's top left, small
  const st = $('status'), u2 = $('u2');
  // desktop: the histogram on top of the column and the status line at its foot; elsewhere both on the photo
  const place = () => {
    if (DESK.matches) { u2.prepend($('histo')); u2.append(st); } else { $('stage').append($('histo'), st); }
    document.body.classList.toggle('u2desk', DESK.matches);
  };
  place();
  DESK.addEventListener('change', () => { place(); draw(false); });
  // Movie (desktop; user, 2026-11-11): the photo and the column move to the right, the left of the window stays empty for
  // picture-in-picture windows (a film playing while editing). The photo refits on its own (app.js observes #stage's size).
  const movie = (on) => { document.body.classList.toggle('u2movie', on); $('u2movie').setAttribute('aria-pressed', on); store.set('fcf_movie', on ? '1' : '0'); };
  movie(store.get('fcf_movie') === '1');
  $('u2movie').onclick = () => movie(!document.body.classList.contains('u2movie'));
  new MutationObserver(() => st.classList.toggle('msg', !/^\d+×\d+ · /.test(st.textContent)))
    .observe(st, { childList: true, characterData: true, subtree: true });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // --- undo / redo: a snapshot after every finished edit (slider release, a tap)
  let hist = [api.snapshot()], at = 0;
  const syncUndo = () => { $('u2undo').disabled = at === 0; $('u2redo').disabled = at === hist.length - 1; };
  const commit = () => {
    const s = api.snapshot();
    if (JSON.stringify(s) === JSON.stringify(hist[at])) return;
    hist = hist.slice(0, at + 1); hist.push(s); at = hist.length - 1; syncUndo();
  };
  const go = async (d) => { const n = at + d; if (n < 0 || n >= hist.length) return; at = n; syncUndo(); await api.restore(hist[at]); draw(false); };
  $('u2undo').onclick = () => go(-1);
  $('u2redo').onclick = () => go(1);
  syncUndo();

  // --- tools
  const rowOf = (id) => $(id)?.closest('.row');
  const scanName = () => $(SCANS.find((b) => $(b)?.getAttribute('aria-checked') === 'true') || SCANS[0])?.textContent.trim() ?? '';
  const visible = (id) => { if (id === 'scan') return !!$(SCANS[0]); const r = rowOf(id); return r && !r.hidden && !r.closest('#labRows[hidden],#neutralRows[hidden],#frontierRows[hidden]'); };
  const labelOf = (id) => rowOf(id).querySelector('label').textContent.trim();
  const valueOf = (id) => $(id).nextElementSibling?.textContent ?? '';
  const modified = (id) => id !== 'scan' && Math.abs(+$(id).value - api.baseOf(id)) > 1e-9;
  let group = 'base', sel = { base: 'ev', scanner: 'scan', transform: 'tilt', effects: 'texture' };

  function toolsOf(g) { return GROUPS.find((x) => x.id === g).tools.filter(visible); }
  function chips(ids, cur) {
    return `<div class="u2tools">${ids.map(([id, name, icon, val, mod]) => `<button class="u2t${id === cur ? ' on' : ''}${mod ? ' mod' : ''}" data-t="${id}">
      ${svg(icon)}<span>${name}</span><span class="v">${val}</span></button>`).join('')}</div>`;
  }
  function sliderPane(id) {
    if (id === 'scan') return `<div class="u2tool" data-id="scan"><div class="u2top"><span class="u2name">Scanner</span></div>
      <div class="u2seg">${SCANS.filter($).map((b) => `<button data-scan="${b}" class="${$(b).getAttribute('aria-checked') === 'true' ? 'on' : ''}">${$(b).textContent.trim()}</button>`).join('')}</div></div>`;
    const el = $(id), min = +el.min, max = +el.max, base = api.baseOf(id), z = (base - min) / (max - min) * 100;
    const auto = id === 'ev' && $('auto') ? '<button class="u2auto">Auto</button>' : '';
    return `<div class="u2tool" data-id="${id}"><div class="u2top"><span class="u2name">${labelOf(id)}</span><span class="u2val">${valueOf(id)}</span>${auto}
      <button class="u2reset"${modified(id) ? '' : ' disabled'}>${svg('reset')}Azzera</button></div>
      <div class="u2track"><span class="u2zero" style="left:${z}%"></span><input type="range" class="u2range" min="${min}" max="${max}" step="${el.step || 'any'}" value="${el.value}"></div></div>`;
  }
  function body(g) {
    if (g === 'transform') {
      if (DESK.matches) return `<div class="u2list">${Object.keys(TR).map((t) => `<div class="u2tool u2tr" data-tr="${t}"></div>`).join('')}</div>`;
      const t = sel.transform;
      const strip = chips([['tilt', 'Raddrizza', 'level', $('tiltOut').textContent, +$('tilt').value !== 0],
        ['crop', 'Ritaglia', 'crop', $('cropOut').textContent, $('cropOut').textContent !== 'Libero'],
        ['border', 'Bordo', 'photo', $('borderOut').textContent, +$('borderPct').value > 0],
        ['frame', 'Cornice', 'frame', +$('frame').value ? FRAME_NAMES[FRAME_STYLES[+$('frame').value]] : '', +$('frame').value > 0]], t);
      return `<div class="u2tool u2tr" data-tr="${t}"></div>${strip}`;
    }
    const ids = toolsOf(g);
    if (DESK.matches) return ids.length ? `<div class="u2list">${ids.map(sliderPane).join('')}</div>` : '<div class="u2tool u2none">Nessun controllo per questo scanner</div>';
    if (!ids.includes(sel[g])) sel[g] = ids[0];
    return (sel[g] ? sliderPane(sel[g]) : '<div class="u2tool u2none">Nessun controllo per questo scanner</div>') +
      chips(ids.map((id) => [id, SHORT[id] || labelOf(id), ICON[id] || 'base', id === 'scan' ? scanName() : modified(id) ? valueOf(id) : '', modified(id)]), sel[g]);
  }

  // the transform blocks of the classic pane (ruler, crop formats) move into UI 2 and back on demand: their listeners stay
  const park = document.querySelector('[data-pane="transform"]');
  const TR = { tilt: '.tilt', crop: '.crop', border: '.bordo', frame: '.cornice' };
  const trBlocks = Object.fromEntries(Object.entries(TR).map(([t, q]) => [t, park.querySelector(q)]));
  const parkAll = () => park.append(...Object.values(trBlocks));
  const cropOverlay = () => document.body.classList.toggle('u2nocrop', sel.transform === 'border' || sel.transform === 'frame');

  function wire(g, pg) {
    const q = (sel) => pg.querySelector(sel);
    pg.querySelectorAll('.u2t').forEach((b) => b.onclick = () => {
      const t = b.dataset.t;
      if (sel[g] === t) return;
      const ids = [...pg.querySelectorAll('.u2t')].map((x) => x.dataset.t), dir = Math.sign(ids.indexOf(t) - ids.indexOf(sel[g]));
      sel[g] = t; haptic(); swapTool(pg, g, dir);
    });
    if (g === 'transform' && DESK.matches) {
      // all four blocks at once; the one last touched decides the crop box (hidden while editing Bordo / Cornice)
      pg.querySelectorAll('.u2tr').forEach((h) => {
        h.append(trBlocks[h.dataset.tr]);
        h.onpointerdown = () => { sel.transform = h.dataset.tr; cropOverlay(); };
      });
      cropOverlay();
      return;
    }
    if (g === 'transform') {
      const host = q('.u2tr');
      parkAll();   // all back first, then the selected one in
      host.append(trBlocks[sel.transform] || trBlocks.tilt);
      cropOverlay();
      return;
    }
    if (DESK.matches) pg.querySelectorAll('.u2tool[data-id]').forEach((t) => wireOne(t, t.dataset.id, null));
    else wireTool(g, pg);
  }
  // `old` out and `nu` in, sliding `dir` (+1: the selection moved right) by `w` of the panel's width
  function slide(old, nu, dir, w, blur, ms) {
    const dx = reduce.matches ? 0 : FLOW * dir * w * slot.clientWidth, b = reduce.matches ? 0 : blur;
    const opt = { duration: reduce.matches ? 120 : ms, easing: EASE, fill: 'forwards' };
    old.animate([{ transform: 'none', filter: 'none', opacity: 1 }, { transform: `translateX(${dx}px)`, filter: `blur(${b}px)`, opacity: 0 }], opt);
    return nu.animate([{ transform: `translateX(${-dx}px)`, filter: `blur(${b}px)`, opacity: 0 }, { transform: 'none', filter: 'none', opacity: 1 }], opt);
  }
  // within a group: the title and slider slide, the strip keeps its place and scroll
  function swapTool(pg, g, dir) {
    pg.querySelectorAll('.u2t').forEach((b) => b.classList.toggle('on', b.dataset.t === sel[g]));
    pg.querySelector(`.u2t[data-t="${sel[g]}"]`)?.scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
    const old = pg.querySelector('.u2tool'), tmp = document.createElement('div');
    tmp.innerHTML = g === 'transform' ? '<div class="u2tool u2tr"></div>' : sliderPane(sel[g]);
    const nu = tmp.firstElementChild;
    old.after(nu); old.classList.add('u2out');
    if (g === 'transform') { parkAll(); nu.append(trBlocks[sel.transform] || trBlocks.tilt); cropOverlay(); }
    else wireTool(g, pg);
    slide(old, nu, dir, TOOL_W, BLUR_PX / 2, TOOL_MS).onfinish = () => old.remove();
  }
  function wireTool(g, pg) {
    wireOne(pg.querySelector('.u2tool:not(.u2out)'), sel[g], pg.querySelector(`.u2t[data-t="${sel[g]}"]`));
  }
  // one tool's pane `t` (its title, value, reset, slider; or the scanner's segments); `chip`: its strip button, if any
  function wireOne(t, id, chip) {
    if (!t) return;
    const q = (s) => t.querySelector(s);
    t.querySelectorAll('[data-scan]').forEach((b) => b.onclick = () => { $(b.dataset.scan).click(); haptic(); setTimeout(() => { draw(false); commit(); }, 60); });
    const r = q('.u2range');
    if (!r) return;
    const el = $(id), min = +el.min, max = +el.max, base = api.baseOf(id);
    const step = +el.step || (max - min) / 100, stepped = (max - min) / step <= 12;   // a stepped slider ticks at each step
    let last = +el.value;
    r.oninput = () => {
      const v = +r.value;
      // ticks (Android only, see haptic): crossing the base value, each step of a stepped slider, the ends
      if ((last - base) * (v - base) < 0 || (v === base && last !== base) || (stepped && v !== last) || ((v === min || v === max) && v !== last)) {
        haptic();
      }
      last = v;
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      q('.u2val').textContent = valueOf(id);
      q('.u2reset').disabled = !modified(id);
      t.classList.toggle('mod', modified(id));
      if (chip) { chip.classList.toggle('mod', modified(id)); chip.querySelector('.v').textContent = modified(id) ? valueOf(id) : ''; }
    };
    r.onchange = () => { el.dispatchEvent(new Event('change', { bubbles: true })); commit(); };
    const reset = () => { r.value = base; r.oninput(); commit(); haptic(); };
    q('.u2reset').onclick = reset;
    r.ondblclick = reset;   // a double click on the slider resets it (desktop editors' convention)
    t.classList.toggle('mod', modified(id));
    const a = q('.u2auto');
    if (a) a.onclick = async () => { $('auto').click(); haptic(); setTimeout(() => { draw(false); commit(); }, 400); };
  }

  // draw the current group; `dir` -1 / +1 slides that way, 0 fades
  let busy = null;
  function draw(anim = true, dir = 0, ms = SLIDE_MS) {
    const html = body(group);
    if (!anim) {
      const y = slot.firstElementChild?.scrollTop || 0;
      slot.innerHTML = `<div class="u2page">${html}</div>`; slot.firstElementChild.scrollTop = y;
      wire(group, slot.firstElementChild); syncNav(); return;
    }
    const old = slot.firstElementChild, nu = document.createElement('div');
    nu.className = 'u2page'; nu.innerHTML = html;
    slot.append(nu); wire(group, nu); syncNav();
    if (!old) return;
    old.classList.add('u2out');
    const an = slide(old, nu, dir, SLIDE_W, BLUR_PX, ms);
    clearTimeout(busy);
    an.onfinish = () => { old.remove(); nu.style.filter = ''; };
    busy = setTimeout(() => old.isConnected && old.remove(), ms + 60);
  }
  function syncNav() { document.querySelectorAll('.u2nav button').forEach((b) => b.classList.toggle('on', b.dataset.g === group)); }
  document.querySelectorAll('.u2nav button').forEach((b) => b.onclick = () => {
    const g = b.dataset.g;
    if (g === group) return;
    const dir = Math.sign(GROUPS.findIndex((x) => x.id === g) - GROUPS.findIndex((x) => x.id === group));
    if (group === 'transform') parkAll();
    group = g; haptic();
    api.openTab(g === 'transform' ? 'transform' : 'film');
    draw(true, dir);
  });
  // the scanner's own rows show / hide with the scanner: redraw (the classic code toggles their `hidden`)
  const mo = new MutationObserver(() => draw(false));
  for (const id of ['labRows', 'neutralRows', 'frontierRows']) if ($(id)) mo.observe($(id), { attributes: true, attributeFilter: ['hidden'] });
  // a crop / tilt edit, a classic reset: values in the strip follow, and the edit is committed
  for (const id of ['tilt']) $(id)?.addEventListener('change', commit);
  ['cropFormats', 'cropBox'].forEach((id) => $(id)?.addEventListener('pointerup', () => setTimeout(() => { commit(); if (group === 'transform') refreshTransformChips(); }, 30)));
  $('tiltRuler')?.addEventListener('pointerup', () => setTimeout(() => { commit(); refreshTransformChips(); }, 30));
  function refreshTransformChips() {
    if (group !== 'transform') return;
    const v = (t) => slot.lastElementChild?.querySelector(`.u2t[data-t="${t}"] .v`);
    if (v('tilt')) v('tilt').textContent = $('tiltOut').textContent;
    if (v('crop')) v('crop').textContent = $('cropOut').textContent;
    if (v('border')) v('border').textContent = $('borderOut').textContent;
    if (v('frame')) v('frame').textContent = +$('frame').value ? FRAME_NAMES[FRAME_STYLES[+$('frame').value]] : '';
  }

  // --- Bordo and Cornice (Trasforma): the dial, the swatches, the frame's styles; remembered across photos
  {
    const bp = $('borderPct'), bc = $('borderColor'), fr = $('frame'), legacy = store.get('fcf_border');
    bp.value = store.get('fcf_borderPct') ?? (legacy === '0' ? 0 : 1);
    bc.value = store.get('fcf_borderColor') || SWATCHES[0];
    fr.value = Math.max(0, FRAME_STYLES.indexOf(store.get('fcf_frame')));
    const pct = (v) => (v ? `${+v.toFixed(2)}%` : 'off');
    tiltRuler($('borderRuler'), bp, $('borderOut'), { fmt: pct, tickLabel: (d) => (d ? `${d}` : 'off'), tick: BORDER_TICK, big: 1, px: BORDER_PX, snap: BORDER_TICK / 2 });
    const sw = $('borderSwatches');
    sw.className = 'u2sws';
    sw.innerHTML = `${SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
      <label class="u2pick"><input type="color" value="${bc.value}" aria-label="Altro colore"></label><span class="u2hex"></span>`;
    const syncB = () => {
      sw.classList.toggle('off', !+bp.value);
      sw.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x.dataset.c === bc.value));
      sw.querySelector('.u2hex').textContent = bc.value.toUpperCase();
      refreshTransformChips();
    };
    const setC = (c) => { bc.value = c; store.set('fcf_borderColor', c); bc.dispatchEvent(new Event('input')); syncB(); };
    sw.querySelectorAll('[data-c]').forEach((x) => x.onclick = () => { setC(x.dataset.c); haptic(); });
    sw.querySelector('input').oninput = (e) => setC(e.target.value);
    bp.addEventListener('input', () => { store.set('fcf_borderPct', bp.value); syncB(); });
    const fc = $('frameChips');
    fc.className = 'u2seg';
    fc.innerHTML = FRAME_STYLES.map((st, i) => `<button role="radio" data-f="${i}">${FRAME_NAMES[st]}</button>`).join('');
    const syncF = () => { fc.querySelectorAll('[data-f]').forEach((x) => { const on = +x.dataset.f === +fr.value; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); refreshTransformChips(); };
    fc.querySelectorAll('[data-f]').forEach((x) => x.onclick = () => {
      if (+fr.value === +x.dataset.f) return;
      fr.value = x.dataset.f; store.set('fcf_frame', FRAME_STYLES[+fr.value]); haptic();
      fr.dispatchEvent(new Event('input')); syncF();
    });
    fr.addEventListener('input', syncF);
    syncB(); syncF();
  }

  // --- menu (open, reset all, classic UI, credits)
  $('u2menu').onclick = () => sheet(`<h2>Foto<button class="u2x" data-close>✕</button></h2>
    <button class="u2go u2gopri" id="u2open">${svg('photo')}<span><b>Apri foto</b><i>DNG, ORF, JPEG, HEIC</i></span></button>
    <button class="u2go" id="u2resetall">${svg('reset')}<span><b>Azzera tutte le modifiche</b><i>torna alla pellicola com'è</i></span></button>
    <button class="u2go" id="u2classic">${svg('base')}<span><b>Interfaccia classica</b><i>quella di prima (si torna da File)</i></span></button>
    <p class="u2credits">${document.querySelector('.credits')?.innerHTML || ''}</p>`, (s) => {
    s.querySelector('#u2open').onclick = () => { close(); $('pick').click(); };
    s.querySelector('#u2resetall').onclick = () => { $('resetAll').click(); commit(); draw(false); close(); };
    s.querySelector('#u2classic').onclick = () => { store.set('fcf_ui2', '0'); location.replace(location.pathname + location.search.replace(/[?&]ui2\b/, '')); };
  });

  // --- export sheet (the Bordo moved to Trasforma, 4.35)
  $('u2export').onclick = () => {
    if ($('export').disabled) return;
    const q = $('quality');
    sheet(`<h2>Esporta<button class="u2x" data-close>✕</button></h2>
      <div class="u2sl"><div class="u2top"><span>Qualità JPEG</span><span class="u2val" id="u2q">${q.value}%</span></div>
        <input type="range" id="u2qr" min="${q.min}" max="${q.max}" step="1" value="${q.value}"></div>
      <button class="u2go u2gopri" id="u2full">${svg('photo')}<span><b>Foto intera</b><i>risoluzione piena</i></span></button>
      <button class="u2go" id="u2ig">${svg('ig')}<span><b>Instagram</b><i>1080 × 1440 · 3:4, tutta la foto dentro</i></span></button>
      <div class="u2prog" id="u2prog" hidden><div class="u2st" id="u2st"></div><div class="u2bar"><i id="u2bar"></i></div></div>`, (s) => {
      const sync = () => {
        s.querySelector('#u2q').textContent = q.value + '%';
      };
      s.querySelector('#u2qr').oninput = (e) => { q.value = e.target.value; q.dispatchEvent(new Event('input')); sync(); };
      const run = (ig) => {
        s.querySelector('#u2full').disabled = s.querySelector('#u2ig').disabled = true;
        s.querySelector('#u2prog').hidden = false; haptic();
        const st = $('status'), bar = s.querySelector('#u2bar'), lab = s.querySelector('#u2st');
        const watch = new MutationObserver(() => {
          const t = st.textContent, m = t.match(/tile (\d+)\/(\d+)/);
          lab.textContent = t.replace(/^Esporto[^:]*: ?/, '') || t;
          if (m) bar.style.width = `${Math.round(m[1] / m[2] * 90)}%`;
          else if (/JPEG|ridimensiono/.test(t)) bar.style.width = '95%';
        });
        watch.observe(st, { childList: true, characterData: true, subtree: true });
        Promise.resolve(api.exportFull(ig)).finally(() => { watch.disconnect(); bar.style.width = '100%'; haptic(); setTimeout(close, 700); });
      };
      s.querySelector('#u2full').onclick = () => run(false);
      s.querySelector('#u2ig').onclick = () => run(true);
      sync();
    });
  };

  // --- a bottom sheet over a scrim
  let open = null;
  function close() { if (!open) return; const o = open; open = null; o.classList.remove('in'); setTimeout(() => o.remove(), 220); }
  function sheet(html, init) {
    close();
    const el = document.createElement('div');
    el.className = 'u2modal';
    el.innerHTML = `<div class="u2scrim" data-close></div><div class="u2sheet"><div class="u2hdl"></div>${html}</div>`;
    document.body.append(el); open = el;
    el.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
    init(el);
    requestAnimationFrame(() => el.classList.add('in'));
  }

  // the tick switches: on every button UI 2 shows, now and whenever it adds some (pages, sheets)
  tapTicks(document.querySelector('.u2head')); tapTicks($('u2'));
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.target.tagName === 'BUTTON') tapTicks(m.target);   // a button whose content was rewritten (the crop formats)
      for (const n of m.addedNodes) if (n.nodeType === 1 && !n.classList?.contains('u2hx')) tapTicks(n);
    }
  })
    .observe(document.body, { childList: true, subtree: true });
  draw(false);
  // a new photo: the history starts again from its state
  // --- the mascot (mascot.js): advice on the rendered frame, a tap on it opens the tool
  function openTool(id) {
    const g = GROUPS.find((x) => x.tools.includes(id))?.id;
    if (!g || !visible(id)) return;
    if (g !== group) {
      const dir = Math.sign(GROUPS.findIndex((x) => x.id === g) - GROUPS.findIndex((x) => x.id === group));
      if (group === 'transform') parkAll();
      group = g; sel[g] = id; api.openTab('film'); draw(true, dir);
    } else if (sel[g] !== id) {
      sel[g] = id; draw(false);
    }
    if (DESK.matches) {
      const t = slot.lastElementChild?.querySelector(`.u2tool[data-id="${id}"]`);
      t?.scrollIntoView({ block: 'nearest', behavior: reduce.matches ? 'auto' : 'smooth' });
      t?.animate([{ background: '#3a3127' }, { background: 'transparent' }], { duration: 1200, easing: 'ease-out' });
    }
    haptic();
  }
  const SCAN_KIND = { scanNone: 'none', scanFrontier: 'frontier', scanNoritsu: 'noritsu' };
  const mascot = initMascot($('stage'), {
    scanner: () => SCAN_KIND[SCANS.find((b) => $(b)?.getAttribute('aria-checked') === 'true')] || 'none',
    has: visible, openTool, name: (id) => SHORT[id] || labelOf(id), modified,
    renderDefault: api.renderDefault,
  });
  return {
    photoLoaded() { hist = [api.snapshot()]; at = 0; syncUndo(); draw(false); mascot.reset(); },
    rendered(img, look) { mascot.update(img, look); },
    // an edit made outside UI 2's own controls (the 90° turns, app.js): the strip follows, undo / redo gets it
    edited() { commit(); refreshTransformChips(); },
  };
}

const CSS = `
body.ui2 #tabs, body.ui2 #controls, body.ui2 #grip, body.ui2 header .ver { display: none !important; }
body.ui2 header { display: flex; align-items: center; gap: 4px; height: 40px; }
body.ui2 header h1 { flex: 1; font-size: 11px; }
.u2head { display: flex; align-items: center; gap: 2px; }
.u2ib { height: 34px; min-width: 38px; border: 0; background: none; color: var(--fg); border-radius: 10px; display: grid; place-items: center; padding: 0 8px; }
.u2ib svg { width: 22px; height: 22px; }
.u2ib:disabled { color: #514a43; }
.u2pri { background: var(--accent); color: #1a1307; display: flex; gap: 6px; font-weight: 600; font-size: 15px; margin-left: 4px; }
body.ui2 #histo { left: auto; right: 8px; }
#u2 { flex: none; background: var(--card); border-top: 1px solid var(--line); }
.u2slot { position: relative; overflow: hidden; height: 196px; }
.u2page { position: absolute; inset: 0; padding-top: 10px; display: flex; flex-direction: column; }
.u2tool { padding: 2px 16px 0; height: 102px; position: relative; }
.u2tool.u2out { position: absolute; left: 0; right: 0; top: 10px; }
.u2top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.u2name { font-size: 15px; font-weight: 600; }
.u2val { font: 500 15px ui-monospace, Menlo, monospace; color: var(--accent); }
.u2reset { margin-left: auto; border: 0; background: none; color: var(--muted); font: inherit; font-size: 13px; display: flex; gap: 4px; align-items: center; padding: 4px 0 4px 8px; }
.u2reset svg { width: 15px; height: 15px; }
.u2reset:disabled { opacity: .35; }
.u2auto { border: 1px solid #3a342e; background: #24211d; color: var(--fg); border-radius: 999px; padding: 3px 10px; font-size: 13px; font-weight: 600; }
.u2track { position: relative; height: 40px; }
.u2zero { position: absolute; top: 12px; width: 2px; height: 16px; margin-left: -1px; background: #6b635a; pointer-events: none; }
.u2track input, .u2sl input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 40px; background: transparent; margin: 0; position: relative; }
.u2track input::-webkit-slider-runnable-track, .u2sl input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: #3a342e; }
.u2track input::-webkit-slider-thumb, .u2sl input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; margin-top: -12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.5); }
.u2none { color: var(--muted); font-size: 14px; display: grid; place-items: center; }
.u2tools { display: flex; gap: 6px; overflow-x: auto; padding: 2px 12px 8px; scrollbar-width: none; -webkit-mask: linear-gradient(90deg, transparent, #000 12px, #000 88%, transparent); }
.u2tools::-webkit-scrollbar { display: none; }
.u2t { flex: none; position: relative; width: 66px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0 5px; border: 0; border-radius: 12px; background: none; color: var(--muted); font: 11.5px -apple-system, system-ui, sans-serif; }
.u2t svg { width: 24px; height: 24px; }
.u2t.on { background: #2a2520; color: var(--fg); }
.u2t.mod::after { content: ""; position: absolute; top: 6px; right: 12px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.u2t .v { font: 10.5px ui-monospace, Menlo, monospace; color: var(--accent); height: 12px; white-space: nowrap; max-width: 64px; overflow: hidden; text-overflow: ellipsis; }
.u2seg { display: flex; margin: 6px 0 0; background: #0f0e0d; border-radius: 11px; padding: 3px; }
.u2seg button { flex: 1; border: 0; background: none; color: var(--muted); padding: 7px 0; border-radius: 9px; font: 500 14px -apple-system, system-ui, sans-serif; }
.u2seg button.on { background: #2f2923; color: var(--fg); }
.u2tr { padding-top: 0; overflow: hidden; }
.u2tr .crop { padding: 0; } .u2tr .tilthead { margin: 0; min-height: 34px; } .u2tr .iconbtn { width: 32px; height: 32px; }
.u2tr #cropFormats { padding: 2px 40px 0; } .u2tr #cropFormats button { height: 58px; gap: 4px; }
.u2tr .tilt, .u2tr .crop, .u2tr .bordo, .u2tr .cornice { margin: 0; }
.u2tr #borderRuler { height: 40px; } .u2tr .bordo .u2sws { margin: 4px 0 0; padding: 4px 4px; gap: 8px; }
.u2tr .bordo .u2sws button, .u2tr .bordo .u2pick { width: 26px; height: 26px; } .u2tr .bordo .u2sws button.on { outline-offset: 2px; } .u2tr .u2hex { font-size: 11px; color: var(--muted); }
/* Bordo / Cornice: no crop box over the preview (it darkens what is outside it: the mat, the frame) */
body.u2nocrop #cropUI { display: none !important; }
.u2nav { display: flex; border-top: 1px solid var(--line); padding: 2px 6px max(4px, calc(env(safe-area-inset-bottom) - 16px)); }
body.ui2 #status { position: absolute; left: 8px; top: 8px; max-width: calc(100% - 150px); padding: 3px 8px; border-radius: 6px;
  background: rgba(14,13,12,.55); color: var(--muted); font: 10.5px ui-monospace, Menlo, monospace; min-height: 0; z-index: 3; cursor: pointer; }
/* desktop: the column (see DESK) */
body.u2desk { grid-template-columns: minmax(0, 1fr) clamp(320px, 25vw, 380px); grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "head head" "stage u2"; }
/* Movie: an empty column on the left (46 % of the window: the user's sketch, room for a PiP player), the photo and the panel on the right */
body.u2desk.u2movie { grid-template-columns: minmax(0, 46vw) minmax(0, 1fr) clamp(320px, 25vw, 380px); grid-template-areas: "head head head" ". stage u2"; }
#u2movie { display: none; } body.u2desk #u2movie { display: grid; } body.u2movie #u2movie { color: var(--accent); }
body.u2desk #u2 { grid-area: u2; display: flex; flex-direction: column; min-height: 0; border-top: 0; border-left: 1px solid var(--line); }
body.u2desk #histo { position: static; flex: none; width: auto; height: 104px; margin: 12px 16px 8px; background: #000; }
body.u2desk .u2nav { order: -1; flex: none; border-top: 0; border-bottom: 1px solid var(--line); padding: 0 6px; }
body.u2desk #histo { order: -2; }
body.u2desk .u2nav button { flex-direction: row; justify-content: center; gap: 6px; font-size: 13px; padding: 10px 0; }
body.u2desk .u2nav button svg { width: 18px; height: 18px; }
body.u2desk .u2slot { flex: 1; height: auto; min-height: 0; }
body.u2desk .u2page { overflow-y: auto; padding: 0 0 12px; scrollbar-width: thin; }
body.u2desk .u2list .u2tr { height: auto; overflow: visible; padding: 10px 16px 8px; }
.u2list .u2tool { height: auto; padding: 10px 16px 2px; border-bottom: 1px solid #262320; }
.u2list .u2name { font-size: 13.5px; font-weight: 500; color: #cfc6bb; } .u2list .u2tool.mod .u2name { color: var(--fg); }
.u2list .u2val { font-size: 13px; order: 3; } .u2list .u2top { margin-bottom: 0; } .u2list .u2auto { order: 1; padding: 1px 9px; font-size: 12px; }
.u2list .u2reset { visibility: hidden; order: 2; padding: 0 8px; } .u2list .u2tool:hover .u2reset:not(:disabled) { visibility: visible; }
.u2list .u2track { height: 30px; } .u2list .u2zero { top: 8px; height: 14px; }
.u2list .u2track input { height: 30px; cursor: pointer; }
.u2list .u2track input::-webkit-slider-thumb { width: 16px; height: 16px; margin-top: -6px; }
.u2list .u2seg { margin: 8px 0 10px; }
body.u2desk #status { position: static; flex: none; order: 2; max-width: none; border-radius: 0; margin: 0; padding: 6px 16px;
  border-top: 1px solid var(--line); background: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.ui2 #status.msg { color: var(--fg); background: rgba(14,13,12,.8); font-size: 12px; }
body.ui2 #status:empty { display: none; }
.u2nav button { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; border: 0; background: none; color: var(--muted); font: 11px -apple-system, system-ui, sans-serif; padding: 5px 0; }
.u2nav button svg { width: 23px; height: 23px; }
.u2nav button.on { color: var(--accent); }
.u2modal { position: fixed; inset: 0; z-index: 50; }
.u2scrim { position: absolute; inset: 0; background: rgba(0,0,0,.55); opacity: 0; transition: opacity .2s; }
.u2sheet { position: absolute; left: 0; right: 0; bottom: 0; background: #1b1916; border-radius: 18px 18px 0 0; border-top: 1px solid #34302a;
  padding: 8px 16px calc(18px + env(safe-area-inset-bottom)); transform: translateY(100%); transition: transform .22s cubic-bezier(.2,.8,.2,1); max-height: 88vh; overflow-y: auto; }
.u2modal.in .u2scrim { opacity: 1; } .u2modal.in .u2sheet { transform: none; }
.u2hdl { width: 38px; height: 5px; border-radius: 3px; background: #4a443d; margin: 0 auto 10px; }
.u2sheet h2 { font-size: 18px; margin: 0 0 6px; display: flex; align-items: center; }
.u2x { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; border: 0; background: #2a2622; color: var(--muted); font-size: 16px; }
.u2sl { padding: 10px 0 8px; border-bottom: 1px solid #2a2622; }
.u2sl .u2top { margin: 0; } .u2sl .u2top span:first-child { font-size: 15px; } .u2sl .u2val { margin-left: auto; }
.u2ticks { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: -6px; }
.u2sws { display: flex; gap: 10px; align-items: center; margin: 10px 0 4px; transition: opacity .15s; }
.u2sws.off { opacity: .3; pointer-events: none; }
.u2sws button, .u2pick { width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid #4a443d; padding: 0; position: relative; overflow: hidden; }
.u2sws button.on { outline: 2px solid var(--accent); outline-offset: 3px; }
.u2pick { background: conic-gradient(red, #ff0, lime, cyan, blue, #f0f, red); border: 0; }
.u2pick input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; }
.u2sws span { margin-left: auto; font: 12px ui-monospace, Menlo, monospace; color: var(--muted); }
.u2go { display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 10px; padding: 13px 16px; border-radius: 14px; border: 1px solid #3a342e; background: #24211d; color: var(--fg); text-align: left; font: inherit; }
.u2go svg { width: 26px; height: 26px; flex: none; }
.u2go b { display: block; font-size: 16px; } .u2go i { display: block; font-style: normal; font-size: 12.5px; opacity: .75; }
.u2gopri { background: var(--accent); border-color: var(--accent); color: #1a1307; }
.u2go:disabled { opacity: .45; }
.u2prog { margin-top: 14px; } .u2st { font-size: 13px; color: var(--muted); margin-bottom: 8px; min-height: 17px; }
.u2bar { height: 8px; border-radius: 4px; background: #2f2a25; overflow: hidden; } .u2bar i { display: block; height: 100%; width: 3%; background: var(--accent); transition: width .3s; }
.u2hx { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
body.ui2 button:has(> .u2hx) { position: relative; }
.u2credits { font-size: 11.5px; color: var(--muted); margin: 16px 0 0; }
.u2credits a { color: var(--muted); }
`;
