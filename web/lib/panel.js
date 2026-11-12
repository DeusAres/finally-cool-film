// The classic UI's slider panel (a bottom sheet on phones): drag the grip to trade photo area for sliders, the height is
// remembered; double tap the grip: collapse <-> default. From app.js (4.45).
import { store, DESK } from './util.js';

const PANEL_MIN = 0, PANEL_MAX_VH = 0.6;
export const PANEL_DEFAULT_VH = 0.18;   // the default height (double tap, a tab tapped while collapsed), a share of the window

export function initPanel(controls, grip) {
  const setPanel = (px) => {
    const h = Math.round(Math.max(PANEL_MIN, Math.min(innerHeight * PANEL_MAX_VH, px)));
    controls.style.height = h + 'px';
    return h;
  };
  const applySavedPanel = () => { const saved = +store.get('fcf_panel'); if (saved > 0) setPanel(saved); };
  applySavedPanel();
  // Desktop / tablet landscape (DESK, the CSS's query): sidebar layout, no grip, the CSS ignores the inline height.
  // Back to the bottom sheet: re-apply the saved height, clamped to the current window.
  DESK.addEventListener('change', () => { if (!DESK.matches) applySavedPanel(); });
  let gripY = 0, gripH = 0;
  grip.addEventListener('pointerdown', (e) => {
    gripY = e.clientY; gripH = controls.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
  });
  grip.addEventListener('pointermove', (e) => { if (grip.hasPointerCapture(e.pointerId)) setPanel(gripH + gripY - e.clientY); });
  const endGrip = (e) => {
    if (!grip.hasPointerCapture?.(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId); grip.classList.remove('drag');
    store.set('fcf_panel', String(Math.max(1, Math.round(controls.getBoundingClientRect().height))));   // never '0': a collapsed panel must read back as saved
  };
  grip.addEventListener('pointerup', endGrip);
  grip.addEventListener('pointercancel', endGrip);
  grip.addEventListener('dblclick', () => {
    const h = controls.getBoundingClientRect().height;
    const next = h > 8 ? setPanel(0) : setPanel(innerHeight * PANEL_DEFAULT_VH);
    store.set('fcf_panel', String(next || 1));
  });
  return setPanel;
}
