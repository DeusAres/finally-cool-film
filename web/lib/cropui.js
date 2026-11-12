// Ritaglia (Trasforma): the crop box over the preview, its formats and lock (from app.js, 4.45).
// While the Trasforma tab is open (editing) the whole turned frame renders and #cropUI lies on the canvas: the crop box
// (thirds grid), the cut-away part darkened, not removed (user). A corner resizes it (the opposite corner stays put), the box
// drags. A format (Libero, Originale, the usual print / screen ratios, user) or the lock (the box's own ratio) keeps its
// proportions; ⟲ turns the format (portrait <-> landscape). Moving it only moves the box (no render); leaving the tab renders
// the crop as the output frame (lib/tilt.js). Azzera impostazioni and a new photo: the whole frame, Libero; a quarter turn turns
// the box with the photo (app.js rotate). The crop is in fractions of the turned frame.
import { FULL } from './tilt.js';

const CROP_MIN_PX = 48;   // the smallest box side on screen (CSS px): the corner marks still fit inside (a choice)
// Libero, Originale (the frame's ratio), then [short, long] sides, shown short:long in portrait and long:short in landscape
// (the usual prints and screens: a choice)
const CROP_FORMATS = ['free', 'orig', [1, 1], [4, 5], [3, 4], [2, 3], [9, 16]];
const CROP_SHAPE_PX = 30;   // a format button's shape, its long side
const clamp01 = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** `c` resized from corner `h` ('nw' | 'ne' | 'sw' | 'se') by (dx, dy) (fractions of the frame), the opposite corner fixed. In
 * frame-height units (x × A, A = the frame's aspect) so that a locked box keeps its shape on screen. `min`: the smallest side. */
export function resizedCrop(c, h, dx, dy, A, min, locked) {
  const west = h[1] === 'w', north = h[0] === 'n';
  const ax = (west ? c.x + c.w : c.x) * A, ay = north ? c.y + c.h : c.y;          // the fixed corner
  const roomW = west ? ax : A - ax, roomH = north ? ay : 1 - ay;                  // up to the frame's edge
  let w = Math.min(roomW, Math.max(min, (west ? -1 : 1) * dx * A + c.w * A));
  let hh = Math.min(roomH, Math.max(min, (north ? -1 : 1) * dy + c.h));
  if (locked) {
    const r = (c.w * A) / c.h;
    if (w / hh > r) hh = w / r; else w = hh * r;                                  // follow the larger pull
    const k = Math.min(1, roomW / w, roomH / hh);                                 // then back inside the frame
    w *= k; hh *= k;
  }
  return { x: (west ? ax - w : ax) / A, y: north ? ay - hh : ay, w: w / A, h: hh };
}
/** `c` re-fitted to the ratio `r` (W / H in px) in a frame of aspect A: as large as the frame allows, centred where it was. */
export function fitCrop(c, r, A) {
  const cx = (c.x + c.w / 2) * A, cy = c.y + c.h / 2;   // frame-height units, as resizedCrop
  const h = Math.min(1, A / r), w = h * r;
  return { x: clamp01(cx - w / 2, 0, A - w) / A, y: clamp01(cy - h / 2, 0, 1 - h), w: w / A, h };
}

/** The crop UI. `stage`, `view`: the preview's stage and canvas; `active()`: a photo is open; `aspect()`: the turned frame's
 * W / H (Raddrizza keeps it); `onEdit()`: the tab opened / left (the output frame changes: render); `onMove()`: the box moved
 * (the histogram follows it). */
export function initCropUI({ stage, view, active, aspect, onEdit, onMove }) {
  const $ = (id) => document.getElementById(id);
  let crop = FULL, editing = false, format = 'free', portrait = false;   // format: 'free' | 'orig' | 'lock' | [short, long]
  const locked = () => format !== 'free';
  const frameAspect = () => (active() ? aspect() : 1);   // no photo: shapes only
  const formatName = (f) => (f === 'free' ? 'Libero' : f === 'orig' ? 'Originale' : portrait ? `${f[0]}:${f[1]}` : `${f[1]}:${f[0]}`);

  function place() {
    const ui = $('cropUI'), on = editing && active();
    ui.hidden = !on;
    if (!on) return;
    const s = stage.getBoundingClientRect(), v = view.getBoundingClientRect();
    Object.assign(ui.style, { left: `${v.left - s.left}px`, top: `${v.top - s.top}px`, width: `${v.width}px`, height: `${v.height}px` });
    Object.assign($('cropBox').style, { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` });
  }
  /** Trasforma tab shown (`on`) or left: the whole frame with the box over it, or the crop rendered as the frame. */
  function setEditing(on) {
    if (on === editing) return;
    editing = on;
    place();
    if (active()) onEdit();   // the output frame changes size: render resizes the canvas (sizeView)
  }
  $('cropBox').addEventListener('pointerdown', (e) => {
    if (!active()) return;
    e.preventDefault(); e.stopPropagation();
    const box = e.currentTarget, h = e.target.dataset.h, v = view.getBoundingClientRect(), start = { ...crop }, x0 = e.clientX, y0 = e.clientY;
    box.setPointerCapture(e.pointerId);
    const move = (m) => {
      const dx = (m.clientX - x0) / v.width, dy = (m.clientY - y0) / v.height;
      crop = h ? resizedCrop(start, h, dx, dy, v.width / v.height, CROP_MIN_PX / v.height, locked())
        : { ...start, x: clamp01(start.x + dx, 0, 1 - start.w), y: clamp01(start.y + dy, 0, 1 - start.h) };
      place();
      onMove();
    };
    const end = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', end); box.removeEventListener('pointercancel', end); };
    box.addEventListener('pointermove', move); box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  });
  /** W / H of the format `f` in the current orientation (null: free). */
  function formatRatio(f) {
    if (f === 'free') return null;
    if (f === 'lock') return (crop.w * frameAspect()) / crop.h;
    const r = f === 'orig' ? Math.min(frameAspect(), 1 / frameAspect()) : f[0] / f[1];   // short / long
    return portrait ? r : 1 / r;
  }
  /** A format's button: its shape (CROP_SHAPE_PX on the long side, in the current orientation; Libero a dashed square) and name. */
  function drawFormat(b, g, chosen) {
    const r = g === 'free' ? 1 : formatRatio(g) ?? 1, s = CROP_SHAPE_PX;
    b.setAttribute('aria-checked', String(g === chosen));
    b.innerHTML = `<i style="width:${Math.round(r >= 1 ? s : s * r)}px;height:${Math.round(r >= 1 ? s / r : s)}px"></i>${formatName(g)}`;
  }
  /** The chips, the lock and the label show the format. */
  function showFormat() {
    for (const b of document.querySelectorAll('[data-crop-format]')) drawFormat(b, CROP_FORMATS[+b.dataset.cropFormat], format);
    $('cropLock').setAttribute('aria-pressed', String(locked()));
    $('cropOut').textContent = format === 'lock' ? 'Bloccato' : formatName(format);
    $('cropTurn').disabled = Array.isArray(format) && format[0] === format[1];   // a square has nothing to turn
  }
  /** Choose a format (`f` as in CROP_FORMATS, or 'lock'): the box takes its ratio (in the box's own orientation). */
  function setFormat(f) {
    format = f;
    if (active()) portrait = crop.h > crop.w * frameAspect();
    if (active() && f !== 'free' && f !== 'lock') crop = fitCrop(crop, formatRatio(f), frameAspect());
    showFormat();
    place();
    onMove();
  }
  CROP_FORMATS.forEach((f, i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button' });
    b.setAttribute('role', 'radio'); b.dataset.cropFormat = i;
    b.addEventListener('click', () => { setFormat(f); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); });
    $('cropFormats').append(b);
  });
  $('cropLock').addEventListener('click', () => setFormat(locked() ? 'free' : 'lock'));
  $('cropTurn').addEventListener('click', () => {   // the box's proportions turned (portrait <-> landscape) about its centre
    if (!active()) return;
    crop = fitCrop(crop, crop.h / (crop.w * frameAspect()), frameAspect());
    setFormat(format);
  });
  const whole = () => { crop = FULL; setFormat('free'); };
  $('cropReset').addEventListener('click', whole);
  $('cropLabel').addEventListener('dblclick', whole);   // as Raddrizza's label: back to the start
  showFormat();   // Libero (no onMove: app.js builds this before its histogram)

  return {
    crop: () => crop, editing: () => editing, setEditing, place, reset: whole,
    /** Turn the box with the photo (a quarter turn, tilt.js turnCrop). */
    turn: (f) => { crop = f(crop); },
    /** UI 2's undo / redo: the box, its format and orientation. */
    state: () => ({ crop: { ...crop }, cropFormat: format, cropPortrait: portrait }),
    restore(st) { crop = { ...st.crop }; portrait = st.cropPortrait; format = st.cropFormat; showFormat(); place(); onMove(); },
  };
}
