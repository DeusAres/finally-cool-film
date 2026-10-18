// Tape-measure dial (Raddrizza, iPhone Photos style): a ruler of ticks that slides under a fixed centre needle.
// Small tick every 1°, big tick with its number every 5°, the ticks between 0 and the value in the accent colour; the ends fade out
// (CSS mask). Drag (touch / mouse / pen), wheel or trackpad, arrow keys (0.1°, Shift 1°), PageUp / PageDown (5°), Home / End;
// a drag snaps to 0 within ±SNAP (with a short vibration where supported); a double tap / double click resets to 0.
// The value lives in a hidden <input type=range> (`input`): every change is written there and announced with an 'input' event, so the
// app (and scripts/eval/render.cjs) treat it like any other slider; setting input.value from outside + 'input' redraws the dial.

const PX_PER_DEG = 10, BIG = 5, SNAP = 0.5;
const fmt = (v) => (v === 0 ? '0°' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`);

/** `el`: the dial element (gets a canvas); `input`: the hidden range input (min, max, step); `onDrag(active)`: drag start / end. */
export function tiltRuler(el, input, out, { onDrag = () => {} } = {}) {
  const min = +input.min, max = +input.max, step = +input.step || 0.1;
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d');
  el.prepend(canvas);
  const css = getComputedStyle(document.documentElement);
  const color = (n, d) => css.getPropertyValue(n).trim() || d;
  const C = { fg: color('--fg', '#efe9e1'), muted: color('--muted', '#8f877d'), accent: color('--accent', '#e8a33d') };
  let value = +input.value || 0;

  function draw() {
    const w = el.clientWidth, h = el.clientHeight, dpr = devicePixelRatio || 1;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, base = h - 6, lo = Math.min(0, value), hi = Math.max(0, value);
    const first = Math.max(min, Math.ceil(value - cx / PX_PER_DEG) - 1), last = Math.min(max, Math.floor(value + cx / PX_PER_DEG) + 1);
    g.font = '500 10px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    for (let d = first; d <= last; d++) {
      const x = Math.round(cx + (d - value) * PX_PER_DEG) + 0.5, big = d % BIG === 0, on = d !== 0 && d >= lo && d <= hi;
      const len = big ? 14 : 7;
      g.strokeStyle = on ? C.accent : big ? C.fg : C.muted;
      g.globalAlpha = big || on ? 0.95 : 0.7;
      g.lineWidth = big ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, base); g.lineTo(x, base - len); g.stroke();
      if (big) {
        g.fillStyle = on ? C.accent : C.muted;
        g.globalAlpha = Math.min(1, Math.max(0.15, (Math.abs(x - cx) - 6) / 14));   // the number under the needle's head fades
        g.fillText(d < 0 ? `−${-d}` : String(d), x, base - len - 5);
      }
    }
    g.globalAlpha = 1;
  }

  function show() {
    out.textContent = fmt(value);
    out.classList.toggle('on', value !== 0);
    el.setAttribute('aria-valuenow', String(value));
    el.setAttribute('aria-valuetext', fmt(value).replace('−', '-'));
    draw();
  }

  /** Set the value (clamped, on the step grid); `snap`: a drag near 0 lands on 0. Fires 'input' when it changed. */
  function set(v, snap = false) {
    v = Math.min(max, Math.max(min, v));
    v = Math.round(v / step) * step;
    v = +v.toFixed(3) || 0;   // no -0, no float dust
    if (snap && Math.abs(v) < SNAP) v = 0;
    if (v === value) return;
    if (v === 0 && snap) navigator.vibrate?.(8);
    value = v;
    input.value = String(v);
    show();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Redraw from input.value (outside changes: reset, new photo; render.cjs sets the value and fires 'input'). */
  function sync() { if (+input.value !== value) { value = +input.value || 0; show(); } }
  input.addEventListener('input', sync);

  // Drag: the tape follows the finger (drag left -> higher values under the needle). Taps (short, still) count for the double tap.
  let drag = null, lastTap = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, v: value, t: e.timeStamp, moved: false };
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) { drag.moved = true; el.classList.add('drag'); onDrag(true); }
    set(drag.v - dx / PX_PER_DEG, true);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = !drag.moved && e.type === 'pointerup' && e.timeStamp - drag.t < 300;
    if (drag.moved) { el.classList.remove('drag'); onDrag(false); }
    drag = null;
    if (!tap) { lastTap = 0; return; }
    if (lastTap && e.timeStamp - lastTap < 400) { lastTap = 0; set(0); } else lastTap = e.timeStamp;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // Wheel / trackpad: 1° per mouse-wheel notch (100 px), trackpads in proportion; horizontal swipes move the tape like a drag.
  let wheelEnd = 0;
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    let d = horiz ? e.deltaX : -e.deltaY;
    if (e.deltaMode === 1) d *= 33; else if (e.deltaMode === 2) d *= 300;
    set(value + (horiz ? d / PX_PER_DEG : d / 100));
    onDrag(true); clearTimeout(wheelEnd); wheelEnd = setTimeout(() => onDrag(false), 700);
  }, { passive: false });

  el.addEventListener('keydown', (e) => {
    const k = e.key, s = e.shiftKey ? 1 : step;
    const v = k === 'ArrowRight' || k === 'ArrowUp' ? value + s : k === 'ArrowLeft' || k === 'ArrowDown' ? value - s
      : k === 'PageUp' ? value + BIG : k === 'PageDown' ? value - BIG : k === 'Home' ? min : k === 'End' ? max
        : k === '0' || k === 'Delete' || k === 'Backspace' ? 0 : null;
    if (v === null) return;
    e.preventDefault();
    set(v);
  });

  new ResizeObserver(draw).observe(el);
  show();
  return { set, sync, get: () => value };
}
