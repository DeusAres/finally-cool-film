// Tooltips on the controls' labels: what a control does and where it acts (scene → film → lab / scanner → output). Mouse:
// hover; touch: a long press (a tap is left to the label's own gestures: double tap = 0, a chip's tap = choose). One bubble,
// placed above the label (below it near the top of the screen). No DOM state elsewhere: app.js calls attachTips once.

const TIPS = {
  // Scanner
  scanNone: 'La pellicola così com’è, senza il gusto di un laboratorio: colori e luci come li ha registrati la Gold.',
  scanFrontier: 'Come una scansione fatta da un laboratorio con un Frontier: più contrasto, colori un po’ più sobri.',
  scanNoritsu: 'Come una scansione Noritsu: bianchi più aperti, ombre più calde, colori più pieni.',
  nbBright: 'Schiarisce o scurisce i toni di mezzo. I bianchi e i neri restano dove sono.',
  labD: 'Come chiedere al laboratorio una stampa più chiara (−) o più scura (+).',
  labGrad: 'Il contrasto della stampa: Soft più morbido, Hard più deciso.',
  labHi: 'Le luci: Hard le apre di più, Soft le tiene più basse.',
  labLo: 'Le ombre: Soft le schiarisce, Hard le rende più profonde.',
  labSat: 'Quanto sono intensi i colori.',
  labBright: 'Ravviva verdi, azzurri, blu e viola, senza toccare la pelle e i grigi.',
  htHi: 'Recupera i cieli e le zone molto chiare senza toccare il resto.',
  htLo: 'Apre le zone grandi in ombra senza toccare il resto.',
  hypersharp: 'Rende più nitidi i contorni, lasciando stare la grana.',
  mshift: 'Sposta i colori verso il magenta o verso il verde, come un filtro.',
  yshift: 'Sposta i colori verso il giallo (più caldo) o il blu (più freddo).',
  // Colore
  temp: 'Il colore della luce quando hai scattato: a destra luce più calda (tramonto, lampadine), a sinistra più fredda (ombra, cielo coperto).',
  vibrance: 'Ravviva i colori spenti senza esagerare quelli già vivi né la pelle.',
  // Pellicola
  grain: 'La grana della pellicola. 3.1 è quella vera della Gold 200.',
  halation: 'L’alone rossastro che la pellicola fa attorno alle luci forti. 1 è quello vero.',
  texture: 'Fa risaltare i dettagli piccoli (pelle, foglie, muri).',
  clarity: 'Più incisività nei toni di mezzo, come in Lightroom.',
  sharp: 'Più o meno nitidezza dell’immagine di partenza.',
  ev: 'Quanta luce prende la pellicola. Auto è come il telefono. Nelle foto scure (interni, sera) dare più luce rende i colori più puliti senza schiarire la foto.',
  auto: 'Rimette l’esposizione come l’avrebbe misurata il telefono.',
  // Obiettivo
  ca: 'Le frange colorate ai bordi, tipiche di un obiettivo vero.',
  vignette: 'Gli angoli un po’ più scuri, come con un obiettivo vero.',
  falloff: 'Come scuriscono gli angoli: 0 morbido e graduale, 1 più netto.',
  dust: 'Polvere e piccoli segni, come su un negativo vero.',
  // File / Trasforma
  quality: 'La qualità del JPEG quando esporti. Più alta = file più grande.',
  border: 'Aggiunge una cornice bianca alla foto esportata.',
  tilt: 'Raddrizza la foto fino a 45°, ritagliando i bordi.',
  cropLabel: 'Trascina gli angoli del riquadro per ritagliare, o il riquadro per spostarlo. Fuori da Trasforma la foto diventa il ritaglio: vignettatura, grana, polvere ed export seguono quello.',
  cropLock: 'Bloccato: il riquadro tiene le sue proporzioni mentre lo ridimensioni.',
  cropReset: 'Torna alla foto intera.',
  // v3 (index.html?v3)
  contrast: 'Il contrasto della stampa.',
  highlight: 'Recupera le luci troppo chiare.',
  whites: 'Quanto sono luminosi i bianchi.',
  black: 'Neri più chiari e un po’ lattiginosi, effetto vecchia stampa.',
  indoor: 'Simula una foto fatta in casa con poca luce: la pellicola riceve 2 stop in meno.',
  hlc: 'Contrasto nelle zone chiare.',
  shadows: 'Schiarisce le zone scure grandi senza toccare il cielo.',
  v3dodge: 'Schiarisce e scurisce da solo le zone grandi, come faceva il laboratorio.',
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
