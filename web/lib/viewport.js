// Zoom & pan of the preview (CSS transform; the canvas stays centred in the stage): wheel, mouse drag, touch drag and pinch,
// double tap / double click between fit and 100 % (one image pixel per device pixel). From app.js (4.45).
// `layers`: the canvas and the overlays moved with it; `label`: the zoom percentage; `margins()`: the frame + mat around the
// image (a fit includes them); `active()`: a photo is open; `onChange()`: after every move (the crop box follows it);
// `cover()`: px of the stage's bottom under a see-through panel (UI 2 on the phone, 0 elsewhere). A fit takes the whole stage:
// an image that fits above the panel is centred there (as without it), a taller one starts at the top and goes on under it.
const MIN_ZOOM = 0.05, MAX_ZOOM = 6;

export function initViewport({ stage, view, layers, label, margins, active, onChange, cover = () => 0 }) {
  let zoom = 1, panX = 0, panY = 0, fitted = true;

  function applyTransform() {
    for (const l of layers) l.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    onChange();
    label.textContent = active() ? `${Math.round(zoom * devicePixelRatio * 100)}%` : '';
  }

  function fitToScreen() {
    if (!active()) return;
    const r = stage.getBoundingClientRect(), pad = 8, m = margins();
    const fw = view.width + 2 * m.mx, fh = view.height + 2 * m.my;   // the image with its film frame
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((r.width - pad * 2) / fw, (r.height - pad * 2) / fh)));
    const c = cover(), above = r.height - c, h = fh * zoom;   // the canvas is centred in the stage: panY moves it from there
    panX = 0; panY = h <= above - pad * 2 ? -c / 2 : pad + h / 2 - r.height / 2; fitted = true;
    applyTransform();
  }

  // Zoom keeping the viewport point (clientX, clientY) fixed; default: stage centre.
  function setZoom(z, clientX, clientY) {
    if (!active()) return;
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const r = stage.getBoundingClientRect();
    const cx = (clientX ?? r.left + r.width / 2) - r.left - r.width / 2;
    const cy = (clientY ?? r.top + r.height / 2) - r.top - r.height / 2;
    const px = (cx - panX) / zoom, py = (cy - panY) / zoom;
    zoom = z; panX = cx - px * zoom; panY = cy - py * zoom; fitted = false;
    applyTransform();
  }

  stage.addEventListener('wheel', (e) => { if (!active()) return; e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }, { passive: false });

  let dragging = false, lastX = 0, lastY = 0, pinchDist = 0, pinchZoom = 1, lastTap = 0;
  const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  stage.addEventListener('touchstart', (e) => {
    if (!active() || e.target.closest('.overlay')) return;
    if (e.touches.length === 1) {
      dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      // Double tap: toggle fit ↔ 100% at the tapped point.
      const now = performance.now();
      if (now - lastTap < 300) { fitted ? setZoom(1 / devicePixelRatio, lastX, lastY) : fitToScreen(); lastTap = 0; }
      else lastTap = now;
    } else if (e.touches.length === 2) {
      dragging = false; pinchDist = dist(e.touches[0], e.touches[1]); pinchZoom = zoom;
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!active()) return;
    if (e.touches.length === 1 && dragging) {
      e.preventDefault();
      const t = e.touches[0];
      panX += t.clientX - lastX; panY += t.clientY - lastY; lastX = t.clientX; lastY = t.clientY; fitted = false;
      applyTransform();
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      setZoom(pinchZoom * dist(a, b) / pinchDist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    }
  }, { passive: false });
  stage.addEventListener('touchend', (e) => { if (e.touches.length === 0) dragging = false; });
  stage.addEventListener('mousedown', (e) => { if (!active() || e.target.closest('.overlay')) return; dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging || e.buttons === 0) return;
    panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; fitted = false;
    applyTransform();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  stage.addEventListener('dblclick', (e) => { if (active()) fitted ? setZoom(1 / devicePixelRatio, e.clientX, e.clientY) : fitToScreen(); });
  // The stage also changes size when the slider panel is resized.
  new ResizeObserver(() => { if (fitted) fitToScreen(); }).observe(stage);

  return { fit: fitToScreen, isFitted: () => fitted };
}
