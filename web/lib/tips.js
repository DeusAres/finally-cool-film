// Tooltips on the controls' labels: what a control does and where it acts (scene → film → lab / scanner → output). Mouse:
// hover; touch: a long press (a tap is left to the label's own gestures: double tap = 0, a chip's tap = choose). One bubble,
// placed above the label (below it near the top of the screen). No DOM state elsewhere: app.js calls attachTips once.

const TIPS = {
  // Scanner
  scanNone: 'La Gold come l’ha registrata, invertita in modo neutro: nero, bianco e grigio medio presi dalla foto, nessun look di scanner.',
  scanFrontier: 'Frontier SP-3000, tarato su scansioni vere della Gold: contrasto deciso, i suoi colori, l’AutoSetup del laboratorio.',
  scanNoritsu: 'Noritsu, tarato su scansioni vere della Gold: bianchi più aperti, ombre calde, colori più pieni del Frontier.',
  nbBright: 'Luminosità della scansione neutra: sposta il grigio medio di ¼ EV a passo. Nero e bianco restano dove sono.',
  labD: 'Densità del laboratorio, dopo l’AutoSetup: + stampa più densa (più scura), − più chiara. ¼ EV a passo.',
  labGrad: 'Gradazione: il contrasto della stampa, da Soft3 a Hard2 come sul Frontier.',
  labHi: 'Tono luci: Hard apre le luci, Soft le trattiene.',
  labLo: 'Tono ombre: Soft solleva i neri, Hard li approfondisce (i più scuri si chiudono).',
  labSat: 'Saturazione dello scanner: 5 % a passo.',
  labBright: 'Bright: satura verdi, ciani, blu e magenta; grigi e pelle non si muovono.',
  htHi: 'Hyper Tone luci: abbassa le grandi zone chiare durante la scansione, seguendo i bordi. I mezzitoni restano.',
  htLo: 'Hyper Tone ombre: schiarisce le grandi zone scure durante la scansione, seguendo i bordi. I mezzitoni restano.',
  hypersharp: 'Hyper Sharpness: la nitidezza dello scanner, solo sulle strutture; la grana resta com’è.',
  mshift: 'Filtro colore della scansione: verso magenta o verso verde.',
  yshift: 'Filtro colore della scansione: verso giallo o verso blu.',
  // Colore (scene, before the film)
  temp: 'Colore della luce sulla scena, prima della pellicola: la Gold è da luce diurna (5500 K) e reagisce a una luce più calda o più fredda.',
  vibrance: 'Vividezza, sulla scena: più colore ai toni spenti, quasi niente a quelli saturi, la pelle quasi ferma. Mai oltre ciò che la Gold registra.',
  // Pellicola
  grain: 'Grana della Gold 200: 3.1 è quella misurata sulla pellicola vera.',
  halation: 'Halation: l’alone rosso attorno alle luci forti. 1 = lo strato antialone della Gold.',
  texture: 'Texture: contrasto del dettaglio fine, sulla scena prima della pellicola.',
  clarity: 'Chiarezza: contrasto locale dei mezzitoni, sulla scena prima della pellicola.',
  sharp: 'Nitidezza del dettaglio, sulla scena prima della pellicola.',
  // Obiettivo
  ca: 'Aberrazione cromatica dell’obiettivo: frange colorate verso i bordi.',
  vignette: 'Vignettatura dell’obiettivo: angoli più scuri, in luce prima della pellicola.',
  falloff: 'Forma della vignettatura: 0 = calo ottico morbido (cos⁴), 1 = taglio meccanico più netto.',
  dust: 'Polvere e piccoli segni sulla scansione.',
  // File / Trasforma
  quality: 'Qualità del JPEG esportato.',
  border: 'Bordo bianco attorno alla foto esportata.',
  tilt: 'Raddrizza: ruota fino a ±45° con ritaglio automatico.',
  // v3 (index.html?v3)
  ev: 'Esposizione: luce sulla pellicola, in EV.',
  contrast: 'Contrasto della stampa.',
  highlight: 'Alte luci: recupero delle luci della stampa.',
  whites: 'Bianchi: quanto sono aperti i bianchi della stampa.',
  black: 'Nostalgia: neri sollevati e lattiginosi.',
  indoor: 'Interno / luce scarsa: negativo sottoesposto di 2 EV, come in interni senza flash.',
  hlc: 'Contrasto luci: contrasto locale dentro le luci.',
  shadows: 'Ombre: schiarisce le grandi zone scure senza toccare il cielo.',
  v3dodge: 'Luci auto: schiarisce e scurisce le grandi zone come l’Hyper Tone del Frontier, dosato sulla foto.',
};

const HOVER_MS = 400;        // mouse: rest on a label this long (a pass over it shows nothing)
const PRESS_MS = 450;        // touch: hold this long (shorter than iOS's own long-press menu, which the CSS turns off anyway)
const MOVE_PX = 10;          // a touch that moves more is a scroll, not a press
const SHOW_MS = 4000;        // a touch tooltip goes after this, or at the next touch
const GAP_PX = 8;            // between the label and the bubble
const CLICK_AFTER_MS = 500;  // the click a press's release may still fire arrives within this (none at all on some browsers)

/** Attach the tooltips to every control label / chip in `root` that has a text in TIPS. */
export function attachTips(root = document) {
  const bubble = document.createElement('div');
  bubble.className = 'tip'; bubble.setAttribute('role', 'tooltip'); bubble.hidden = true;
  document.body.append(bubble);
  let timer = 0, hideTimer = 0;
  const hide = () => { clearTimeout(timer); clearTimeout(hideTimer); bubble.hidden = true; };
  const show = (el, text) => {
    bubble.textContent = text; bubble.hidden = false;
    const r = el.getBoundingClientRect(), b = bubble.getBoundingClientRect();
    const x = Math.min(Math.max(GAP_PX, r.left), innerWidth - b.width - GAP_PX);
    const y = r.top - b.height - GAP_PX >= GAP_PX ? r.top - b.height - GAP_PX : r.bottom + GAP_PX;
    bubble.style.left = `${x}px`; bubble.style.top = `${y}px`;
  };
  for (const el of root.querySelectorAll('label[for], label[id], button[id]')) {
    const id = el.htmlFor || (el.id === 'tiltLabel' ? 'tilt' : el.id), text = TIPS[id];
    if (!text) continue;
    el.classList.add('has-tip');
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { clearTimeout(timer); timer = setTimeout(() => show(el, text), HOVER_MS); } });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    let suppress = 0;   // until then, a click on the label is the release of a tooltip press: not a tap on the control
    el.addEventListener('click', (c) => { if (performance.now() < suppress) { c.preventDefault(); c.stopImmediatePropagation(); } }, { capture: true });
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') { hide(); return; }
      const x0 = e.clientX, y0 = e.clientY;
      let shown = false;
      clearTimeout(timer);
      timer = setTimeout(() => { shown = true; show(el, text); hideTimer = setTimeout(hide, SHOW_MS); }, PRESS_MS);
      const move = (m) => { if (Math.hypot(m.clientX - x0, m.clientY - y0) > MOVE_PX) clearTimeout(timer); };
      const end = (u) => {
        clearTimeout(timer);
        if (shown && u.type === 'pointerup') suppress = performance.now() + CLICK_AFTER_MS;
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end);
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    });
  }
  // the next touch anywhere, a scroll, or the page going away closes a tooltip
  addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !bubble.hidden) hide(); }, { capture: true });
  addEventListener('scroll', hide, { capture: true, passive: true });
  addEventListener('blur', hide);
}
