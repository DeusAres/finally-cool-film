// UI 2 (preview: File > "Nuova interfaccia", or ?ui2): one big slider at a time, the tools of a group in a strip, four groups
// (Base, Scanner, Trasforma, Effetti), undo / redo and Esporta in the header, the export options in a sheet.
// Built over the app's own controls: the classic panes stay in the page (hidden) and remain the one source of truth: UI 2
// sets their values and dispatches their events, reads their labels and their formatted outputs. Prototype: user, 2026-11-03.
import { store } from './util.js';

const $ = (id) => document.getElementById(id);

// Groups and their tools (input ids, in order). A tool whose row is in a hidden block (the scanner's own rows) is left out.
const GROUPS = [
  { id: 'base', name: 'Base', icon: 'base', tools: ['ev', 'labD', 'nbBright', 'temp', 'mshift', 'yshift', 'vibrance', 'grain'] },
  { id: 'scanner', name: 'Scanner', icon: 'look', tools: ['labGrad', 'labHi', 'labLo', 'labSat', 'labBright', 'htLo', 'htHi', 'hypersharp'] },
  { id: 'transform', name: 'Trasforma', icon: 'crop', tools: [] },
  { id: 'effects', name: 'Effetti', icon: 'fx', tools: ['halation', 'texture', 'clarity', 'sharp', 'ca', 'vignette', 'falloff', 'dust'] },
];
// Short names for the strip (the full label, from the row, is the big slider's title).
const SHORT = { ev: 'Esposiz.', labD: 'Densità', nbBright: 'Luminos.', temp: 'Luce', mshift: 'Magenta', yshift: 'Giallo', vibrance: 'Vividezza',
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
  rotl: '<path d="M4 4v5h5"/><path d="M5 9a8 8 0 1 1 1.5 8.5"/>',
  rotr: '<path d="M20 4v5h-5"/><path d="M19 9a8 8 0 1 0-1.5 8.5"/>',
  open: '<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.5H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  undo: '<path d="M9 7H15a5 5 0 0 1 0 10H8"/><path d="M12 4 9 7l3 3"/>',
  redo: '<path d="M15 7H9a5 5 0 0 0 0 10h7"/><path d="M12 4l3 3-3 3"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  reset: '<path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 1.6-7.4L4 10"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  ig: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/>',
};
const ICON = { ev: 'ev', labD: 'dens', nbBright: 'dens', temp: 'temp', mshift: 'tint', yshift: 'tint', vibrance: 'drop', grain: 'grain',
  labGrad: 'curve', labHi: 'hi', labLo: 'lo', labSat: 'sat', labBright: 'ev', htLo: 'lo', htHi: 'hi', hypersharp: 'sharp',
  halation: 'glow', texture: 'grain', clarity: 'sat', sharp: 'sharp', ca: 'lens', vignette: 'lens', falloff: 'lens', dust: 'fx' };
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;

// Motion: tab / tool changes slide SLIDE_PX with a BLUR_PX blur, SLIDE_MS (a tool within a group: TOOL_MS, half the move),
// eased out; "Riduci movimento" keeps only the fade. Choices (user: "scorrimento con uso del blur", short).
const SLIDE_PX = 36, BLUR_PX = 8, SLIDE_MS = 200, TOOL_MS = 120;
// Export: border 0..BORDER_MAX % of the long side (0 = off), swatches; the app reads #borderPct / #borderColor (app.js).
const BORDER_MAX = 10, BORDER_STEP = 0.5, SWATCHES = ['#ffffff', '#f3ead8', '#d9d4cc', '#111111'];

/** Haptic tick. Android: navigator.vibrate. iOS Safari has no vibrate API; since iOS 18 toggling a `switch` checkbox plays the
 * system tick (unverified on the user's phone: a known trick), so a hidden one is clicked through its label. */
const haptic = (() => {
  let label = null;
  return () => {
    if (navigator.vibrate) { navigator.vibrate(5); return; }
    if (!label) {
      label = document.createElement('label');
      label.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;overflow:hidden;opacity:0';
      label.innerHTML = '<input type="checkbox" switch tabindex="-1">';
      document.body.append(label);
    }
    label.click();
  };
})();

/**
 * Start UI 2. `api`: { baseOf(id): the value a tool resets to; snapshot(): the edit state; restore(s); openTab(name): the
 * classic tab whose side effects a group needs ('transform': the crop overlay, else 'film'); exportFull(ig) }.
 */
export function initUI2(api) {
  document.body.classList.add('ui2');
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  const controls = $('controls');
  // header: open / menu, undo, redo, Esporta
  document.querySelector('header').insertAdjacentHTML('beforeend', `<div class="u2head">
    <button class="u2ib" id="u2menu" aria-label="Foto e impostazioni">${svg('open')}</button>
    <button class="u2ib" id="u2undo" aria-label="Annulla">${svg('undo')}</button>
    <button class="u2ib" id="u2redo" aria-label="Ripeti">${svg('redo')}</button>
    <button class="u2ib u2pri" id="u2export">${svg('share')}<span>Esporta</span></button></div>`);
  controls.insertAdjacentHTML('beforebegin', `<div id="u2">
    <div class="u2slot" id="u2slot"></div>
    <nav class="u2nav">${GROUPS.map((g) => `<button data-g="${g.id}">${svg(g.icon)}<span>${g.name}</span></button>`).join('')}</nav></div>`);
  const slot = $('u2slot');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // --- undo / redo: a snapshot after every finished edit (slider release, a tap)
  let hist = [api.snapshot()], at = 0;
  const syncUndo = () => { $('u2undo').disabled = at === 0; $('u2redo').disabled = at === hist.length - 1; };
  const commit = () => {
    const s = api.snapshot();
    if (JSON.stringify(s) === JSON.stringify(hist[at])) return;
    hist = hist.slice(0, at + 1); hist.push(s); at = hist.length - 1; syncUndo();
  };
  const go = (d) => { const n = at + d; if (n < 0 || n >= hist.length) return; at = n; api.restore(hist[at]); syncUndo(); draw(false); };
  $('u2undo').onclick = () => go(-1);
  $('u2redo').onclick = () => go(1);
  syncUndo();

  // --- tools
  const rowOf = (id) => $(id)?.closest('.row');
  const visible = (id) => { const r = rowOf(id); return r && !r.hidden && !r.closest('#labRows[hidden],#neutralRows[hidden],#frontierRows[hidden]'); };
  const labelOf = (id) => rowOf(id).querySelector('label').textContent.trim();
  const valueOf = (id) => $(id).nextElementSibling?.textContent ?? '';
  const modified = (id) => Math.abs(+$(id).value - api.baseOf(id)) > 1e-9;
  let group = 'base', sel = { base: 'ev', scanner: 'htLo', transform: 'tilt', effects: 'halation' };

  function toolsOf(g) { return GROUPS.find((x) => x.id === g).tools.filter(visible); }
  function chips(ids, cur) {
    return `<div class="u2tools">${ids.map(([id, name, icon, val, mod]) => `<button class="u2t${id === cur ? ' on' : ''}${mod ? ' mod' : ''}" data-t="${id}">
      ${svg(icon)}<span>${name}</span><span class="v">${val}</span></button>`).join('')}</div>`;
  }
  function sliderPane(id) {
    const el = $(id), min = +el.min, max = +el.max, base = api.baseOf(id), z = (base - min) / (max - min) * 100;
    const auto = id === 'ev' && $('auto') ? '<button class="u2auto">Auto</button>' : '';
    return `<div class="u2tool"><div class="u2top"><span class="u2name">${labelOf(id)}</span><span class="u2val">${valueOf(id)}</span>${auto}
      <button class="u2reset"${modified(id) ? '' : ' disabled'}>${svg('reset')}Azzera</button></div>
      <div class="u2track"><span class="u2zero" style="left:${z}%"></span><input type="range" class="u2range" min="${min}" max="${max}" step="${el.step || 'any'}" value="${el.value}"></div></div>`;
  }
  function body(g) {
    if (g === 'transform') {
      const t = sel.transform;
      const strip = chips([['tilt', 'Raddrizza', 'level', $('tiltOut').textContent, +$('tilt').value !== 0],
        ['crop', 'Ritaglia', 'crop', $('cropOut').textContent, $('cropOut').textContent !== 'Libero'],
        ['rotL', '90° sx', 'rotl', '', false], ['rotR', '90° dx', 'rotr', '', false]], t);
      return `<div class="u2tool u2tr" data-tr="${t}"></div>${strip}`;
    }
    const ids = toolsOf(g);
    if (!ids.includes(sel[g])) sel[g] = ids[0];
    const seg = g === 'scanner' ? `<div class="u2seg">${['scanNone', 'scanFrontier', 'scanNoritsu'].filter($).map((b) =>
      `<button data-scan="${b}" class="${$(b).getAttribute('aria-checked') === 'true' ? 'on' : ''}">${$(b).textContent.trim()}</button>`).join('')}</div>` : '';
    return seg + (sel[g] ? sliderPane(sel[g]) : '<div class="u2tool u2none">Nessun controllo per questo scanner</div>') +
      chips(ids.map((id) => [id, SHORT[id] || labelOf(id), ICON[id] || 'base', modified(id) ? valueOf(id) : '', modified(id)]), sel[g]);
  }

  // the transform blocks of the classic pane (ruler, crop formats) move into UI 2 and back on demand: their listeners stay
  const tiltBlock = document.querySelector('[data-pane="transform"] .tilt'), cropBlock = document.querySelector('[data-pane="transform"] .crop');
  const park = document.querySelector('[data-pane="transform"]');

  function wire(g, pg) {
    const q = (sel) => pg.querySelector(sel);
    pg.querySelectorAll('.u2t').forEach((b) => b.onclick = () => {
      const t = b.dataset.t;
      if (t === 'rotL' || t === 'rotR') { $(t).click(); haptic(); setTimeout(commit, 50); return; }
      if (sel[g] === t) return;
      sel[g] = t; haptic(); draw(true, 0, TOOL_MS);
    });
    pg.querySelectorAll('[data-scan]').forEach((b) => b.onclick = () => { $(b.dataset.scan).click(); haptic(); setTimeout(() => { draw(false); commit(); }, 60); });
    if (g === 'transform') {
      const host = q('.u2tr');
      park.append(tiltBlock, cropBlock);   // both back first, then the selected one in
      host.append(sel.transform === 'crop' ? cropBlock : tiltBlock);
      return;
    }
    const id = sel[g], r = q('.u2range');
    if (!r) return;
    const el = $(id), min = +el.min, max = +el.max, base = api.baseOf(id);
    const step = +el.step || (max - min) / 100, stepped = (max - min) / step <= 12;   // a stepped slider ticks at each step
    let last = +el.value;
    r.oninput = () => {
      const v = +r.value;
      // ticks: crossing the base value, each step of a stepped slider, the ends
      if ((last - base) * (v - base) < 0 || (v === base && last !== base) || (stepped && v !== last) || ((v === min || v === max) && v !== last)) haptic();
      last = v;
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      q('.u2val').textContent = valueOf(id);
      q('.u2reset').disabled = !modified(id);
      const chip = q(`.u2t[data-t="${id}"]`);
      chip.classList.toggle('mod', modified(id)); chip.querySelector('.v').textContent = modified(id) ? valueOf(id) : '';
    };
    r.onchange = () => { el.dispatchEvent(new Event('change', { bubbles: true })); commit(); };
    q('.u2reset').onclick = () => { r.value = base; r.oninput(); commit(); haptic(); };
    const a = q('.u2auto');
    if (a) a.onclick = async () => { $('auto').click(); haptic(); setTimeout(() => { draw(false); commit(); }, 400); };
  }

  // draw the current group; `dir` -1 / +1 slides that way, 0 fades
  let busy = null;
  function draw(anim = true, dir = 0, ms = SLIDE_MS) {
    const html = body(group);
    if (!anim) { slot.innerHTML = `<div class="u2page">${html}</div>`; wire(group, slot.firstElementChild); syncNav(); return; }
    const old = slot.firstElementChild, nu = document.createElement('div');
    nu.className = 'u2page'; nu.innerHTML = html;
    slot.append(nu); wire(group, nu); syncNav();
    if (!old) return;
    const dx = reduce.matches ? 0 : dir ? SLIDE_PX * dir : SLIDE_PX / 2, blur = reduce.matches ? 0 : BLUR_PX;
    old.classList.add('u2out');
    const opt = { duration: reduce.matches ? 120 : ms, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' };
    old.animate([{ transform: 'none', filter: 'none', opacity: 1 }, { transform: `translateX(${-dx}px)`, filter: `blur(${blur}px)`, opacity: 0 }], opt);
    const an = nu.animate([{ transform: `translateX(${dx}px)`, filter: `blur(${blur}px)`, opacity: 0 }, { transform: 'none', filter: 'none', opacity: 1 }], opt);
    clearTimeout(busy);
    an.onfinish = () => { old.remove(); nu.style.filter = ''; };
    busy = setTimeout(() => old.isConnected && old.remove(), ms + 60);
  }
  function syncNav() { document.querySelectorAll('.u2nav button').forEach((b) => b.classList.toggle('on', b.dataset.g === group)); }
  document.querySelectorAll('.u2nav button').forEach((b) => b.onclick = () => {
    const g = b.dataset.g;
    if (g === group) return;
    const dir = Math.sign(GROUPS.findIndex((x) => x.id === g) - GROUPS.findIndex((x) => x.id === group));
    if (group === 'transform') park.append(tiltBlock, cropBlock);
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
  }

  // --- menu (open, reset all, classic UI, credits)
  $('u2menu').onclick = () => sheet(`<h2>Foto<button class="u2x" data-close>✕</button></h2>
    <button class="u2go u2gopri" id="u2open">${svg('photo')}<span><b>Apri foto</b><i>DNG, ORF, JPEG, HEIC</i></span></button>
    <button class="u2go" id="u2resetall">${svg('reset')}<span><b>Azzera tutte le modifiche</b><i>torna alla pellicola com'è</i></span></button>
    <button class="u2go" id="u2classic">${svg('base')}<span><b>Interfaccia classica</b><i>la nuova è in prova</i></span></button>
    <p class="u2credits">${document.querySelector('.credits')?.innerHTML || ''}</p>`, (s) => {
    s.querySelector('#u2open').onclick = () => { close(); $('pick').click(); };
    s.querySelector('#u2resetall').onclick = () => { $('resetAll').click(); commit(); draw(false); close(); };
    s.querySelector('#u2classic').onclick = () => { store.set('fcf_ui2', null); location.replace(location.pathname + location.search.replace(/[?&]ui2\b/, '')); };
  });

  // --- export sheet
  if (!$('borderPct')) {
    const legacy = store.get('fcf_border');
    document.body.insertAdjacentHTML('beforeend', `<input type="range" id="borderPct" hidden min="0" max="${BORDER_MAX}" step="${BORDER_STEP}"
      value="${store.get('fcf_borderPct') ?? (legacy === '0' ? 0 : 1)}"><input type="color" id="borderColor" hidden value="${store.get('fcf_borderColor') || SWATCHES[0]}">`);
  }
  $('u2export').onclick = () => {
    if ($('export').disabled) return;
    const q = $('quality'), bp = $('borderPct'), bc = $('borderColor');
    sheet(`<h2>Esporta<button class="u2x" data-close>✕</button></h2>
      <div class="u2sl"><div class="u2top"><span>Qualità JPEG</span><span class="u2val" id="u2q">${q.value}%</span></div>
        <input type="range" id="u2qr" min="${q.min}" max="${q.max}" step="1" value="${q.value}"></div>
      <div class="u2sl"><div class="u2top"><span>Bordo</span><span class="u2val" id="u2b"></span></div>
        <input type="range" id="u2br" min="0" max="${BORDER_MAX}" step="${BORDER_STEP}" value="${bp.value}">
        <div class="u2ticks"><span>off</span><span>${BORDER_MAX / 2}%</span><span>${BORDER_MAX}%</span></div>
        <div class="u2sws" id="u2sws">${SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}"></button>`).join('')}
          <label class="u2pick"><input type="color" id="u2cp" value="${bc.value}"></label><span id="u2hex"></span></div></div>
      <button class="u2go u2gopri" id="u2full">${svg('photo')}<span><b>Foto intera</b><i>risoluzione piena</i></span></button>
      <button class="u2go" id="u2ig">${svg('ig')}<span><b>Instagram</b><i>1080 × 1440 · 3:4, tutta la foto dentro</i></span></button>
      <div class="u2prog" id="u2prog" hidden><div class="u2st" id="u2st"></div><div class="u2bar"><i id="u2bar"></i></div></div>`, (s) => {
      const sync = () => {
        s.querySelector('#u2q').textContent = q.value + '%';
        const b = +bp.value; s.querySelector('#u2b').textContent = b ? b + '%' : 'off';
        s.querySelector('#u2sws').classList.toggle('off', !b);
        s.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x.dataset.c === bc.value));
        s.querySelector('#u2hex').textContent = bc.value.toUpperCase();
      };
      s.querySelector('#u2qr').oninput = (e) => { q.value = e.target.value; q.dispatchEvent(new Event('input')); sync(); };
      s.querySelector('#u2br').oninput = (e) => { const was = +bp.value; bp.value = e.target.value; if (!was !== !+bp.value || +bp.value === BORDER_MAX) haptic(); store.set('fcf_borderPct', bp.value); sync(); };
      const setC = (c) => { bc.value = c; store.set('fcf_borderColor', c); sync(); };
      s.querySelectorAll('[data-c]').forEach((x) => x.onclick = () => { setC(x.dataset.c); haptic(); });
      s.querySelector('#u2cp').oninput = (e) => setC(e.target.value);
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

  draw(false);
  // a new photo: the history starts again from its state
  return { photoLoaded() { hist = [api.snapshot()]; at = 0; syncUndo(); draw(false); } };
}

const CSS = `
body.ui2 #tabs, body.ui2 #controls, body.ui2 #grip, body.ui2 header .ver { display: none !important; }
body.ui2 header { display: flex; align-items: center; gap: 4px; }
body.ui2 header h1 { flex: 1; font-size: 11px; }
.u2head { display: flex; align-items: center; gap: 2px; }
.u2ib { height: 38px; min-width: 40px; border: 0; background: none; color: var(--fg); border-radius: 10px; display: grid; place-items: center; padding: 0 8px; }
.u2ib svg { width: 22px; height: 22px; }
.u2ib:disabled { color: #514a43; }
.u2pri { background: var(--accent); color: #1a1307; display: flex; gap: 6px; font-weight: 600; font-size: 15px; margin-left: 4px; }
body.ui2 #histo { left: auto; right: 8px; }
#u2 { flex: none; background: var(--card); border-top: 1px solid var(--line); }
.u2slot { position: relative; overflow: hidden; height: 208px; }
.u2page { position: absolute; inset: 0; padding-top: 10px; }
.u2tool { padding: 2px 16px 6px; min-height: 76px; }
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
.u2seg { display: flex; margin: 0 16px 8px; background: #0f0e0d; border-radius: 11px; padding: 3px; }
.u2seg button { flex: 1; border: 0; background: none; color: var(--muted); padding: 7px 0; border-radius: 9px; font: 500 14px -apple-system, system-ui, sans-serif; }
.u2seg button.on { background: #2f2923; color: var(--fg); }
.u2tr { padding-top: 0; }
.u2tr .tilt, .u2tr .crop { margin: 0; }
.u2nav { display: flex; border-top: 1px solid var(--line); padding: 4px 6px calc(6px + env(safe-area-inset-bottom)); }
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
.u2credits { font-size: 11.5px; color: var(--muted); margin: 16px 0 0; }
.u2credits a { color: var(--muted); }
`;
