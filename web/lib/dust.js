// Dust, fibres and scratches on the negative — procedural, no textures.
//
// What the print shows: anything sitting on the NEGATIVE blocks the enlarger's
// light, so that spot of paper gets no exposure and stays paper white. Dust and
// scratches on a print from a negative are therefore light marks, and their
// opacity is simply how much light they block. Compositing is a mix towards
// paper white, applied after the whole film/print chain, as a separate layer:
// toggling it, changing the amount or reseeding re-renders nothing.
//
// The field is a list of vector primitives generated from a seed, in µm on a
// 36 mm-long-side frame (the engine's own physical scale), so the preview and
// every export tile draw exactly the same marks at any resolution:
//   - specks: irregular clusters of 2–4 ellipses, heavy-tailed sizes (lots of
//     tiny grit, a few big flakes); some out of focus (dust on the base side,
//     ~0.1 mm from the emulsion) drawn as soft radial falloffs;
//   - fibres / hairs: smooth random walks (curvature is itself a random walk,
//     so they bend and occasionally curl), thin, sometimes soft;
//   - scratches: rare, long, along the film's travel (the frame's long side),
//     nearly straight with a slow wobble, broken into dashes where the
//     pressure lifted.
// Each primitive has a rank in [0, 1): the amount slider draws those with
// rank < amount, so raising it only ADDS marks; reseeding gives a new roll.
// Marks thinner than ~0.8 px are drawn 0.8 px wide with proportionally lower
// opacity (same light blocked), so they read the same at preview and 12 MP.

const FRAME_UM = 36000;              // long side of the frame
const PAPER = [252, 250, 246];       // paper base, as the print shows it

// Counts at amount 1 (a frame that has been handled carelessly).
const N_SPECKS = 320, N_FIBRES = 18, N_SCRATCHES = 3;

function rng(seed) {                 // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Marks for a frame with the given aspect (long / short side), from `seed`. */
export function dustField(seed, aspect) {
  const R = rng(seed), L = FRAME_UM, S = FRAME_UM / aspect;
  const between = (a, b) => a + (b - a) * R();
  const pareto = (min, alpha, max) => Math.min(max, min / Math.pow(1 - R(), 1 / alpha));
  const marks = [];

  for (let i = 0; i < N_SPECKS; i++) {
    const r = pareto(5, 1.5, 260);                  // µm radius
    const soft = R() < 0.3;
    const parts = [];
    for (let k = 0, n = 2 + ((R() * 3) | 0); k < n; k++) {
      parts.push({ dx: between(-0.8, 0.8) * r, dy: between(-0.8, 0.8) * r,
        rx: r * between(0.35, 0.9), ry: r * between(0.25, 0.8), rot: R() * Math.PI });
    }
    marks.push({ kind: 'speck', rank: R(), x: R() * L, y: R() * S, parts, soft,
      alpha: soft ? between(0.25, 0.6) : between(0.55, 0.95), blur: soft ? r * between(0.8, 1.6) : 0 });
  }

  for (let i = 0; i < N_FIBRES; i++) {
    const len = pareto(400, 1.3, 6000), step = 25, n = Math.max(4, Math.ceil(len / step));
    let x = R() * L, y = R() * S, a = R() * Math.PI * 2, curv = between(-0.02, 0.02);
    const pts = [[x, y]];
    for (let k = 0; k < n; k++) {
      curv += between(-0.012, 0.012); curv *= 0.97; // curvature random walk, mean-reverting
      if (R() < 0.01) curv += between(-0.15, 0.15); // the odd curl
      a += curv; x += Math.cos(a) * step; y += Math.sin(a) * step;
      pts.push([x, y]);
    }
    const soft = R() < 0.35;
    marks.push({ kind: 'fibre', rank: R(), pts, width: between(5, 14), soft,
      alpha: soft ? between(0.25, 0.5) : between(0.5, 0.85) });
  }

  for (let i = 0; i < N_SCRATCHES; i++) {
    // Along the film's travel = the frame's long side (x here).
    const x0 = between(-0.1, 0.4) * L, x1 = x0 + between(0.35, 1.1) * L;
    const y0 = R() * S, slope = between(-0.006, 0.006);
    const wob = between(5, 25), wobLen = between(4000, 15000), ph = R() * 6.283;
    const pts = [], dash = [];
    let on = R() < 0.8, run = 0;
    for (let x = x0; x <= x1; x += 40) {
      pts.push([x, y0 + (x - x0) * slope + wob * Math.sin(ph + (x / wobLen) * 6.283)]);
      if ((run += 40) > between(300, 4000)) { on = R() < (on ? 0.7 : 0.8); run = 0; }
      dash.push(on);
    }
    marks.push({ kind: 'scratch', rank: R() * 1.6, pts, dash, width: between(3, 9), alpha: between(0.45, 0.8) });
  }
  return marks;
}

/**
 * Draw `marks` (amount 0..1) into a 2D context showing the region (x0, y0) of
 * a W×H image whose long side is the frame's long side. Paper colour on a
 * transparent canvas; alpha = light blocked.
 */
export function drawDust(ctx, marks, amount, W, H, x0 = 0, y0 = 0) {
  const portrait = H > W;
  const s = Math.max(W, H) / FRAME_UM;              // px per µm
  ctx.save();
  // µm frame coords (x along the long side) → image px of the region.
  if (portrait) ctx.setTransform(0, s, s, 0, -x0, -y0);   // swap axes: long side vertical
  else ctx.setTransform(s, 0, 0, s, -x0, -y0);
  const col = (a) => `rgba(${PAPER[0]},${PAPER[1]},${PAPER[2]},${a})`;
  const minW = 0.8 / s;                              // 0.8 px in µm

  for (const m of marks) {
    if (m.rank >= amount) continue;
    if (m.kind === 'speck') {
      for (const p of m.parts) {
        const cx = m.x + p.dx, cy = m.y + p.dy;
        if (m.soft) {
          const r = Math.max(p.rx, p.ry) + m.blur;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, col(m.alpha));
          g.addColorStop(0.45, col(m.alpha * 0.55));
          g.addColorStop(1, col(0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.fill();
        } else {
          // Tiny grit: keep the light it blocks when it is below a pixel.
          const area = Math.PI * p.rx * p.ry, minA = Math.PI * minW * minW / 4;
          const k = area < minA ? area / minA : 1;
          ctx.fillStyle = col(m.alpha * k);
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.max(p.rx, minW / 2), Math.max(p.ry, minW / 2), p.rot, 0, 6.2832);
          ctx.fill();
        }
      }
    } else {
      const w = Math.max(m.width, minW), a = m.alpha * Math.min(1, m.width / minW);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const stroke = (width, alpha) => {
        ctx.lineWidth = width; ctx.strokeStyle = col(alpha);
        ctx.beginPath();
        let pen = false;
        m.pts.forEach(([x, y], i) => {
          const on = !m.dash || m.dash[i];
          if (on && pen) ctx.lineTo(x, y); else if (on) ctx.moveTo(x, y);
          pen = on;
        });
        ctx.stroke();
      };
      if (m.soft) { stroke(w * 3.5, a * 0.18); stroke(w * 1.8, a * 0.3); }
      stroke(w, m.soft ? a * 0.5 : a);
    }
  }
  ctx.restore();
}

/** Mix an RGB strip (w×h, row stride w*3) towards paper white by the alpha of an RGBA overlay of the same size. */
export function compositeDust(rgb, overlay) {
  for (let p = 0, j = 0; p < overlay.length; p += 4, j += 3) {
    const a = overlay[p + 3];
    if (!a) continue;
    const t = a / 255;
    rgb[j] += (PAPER[0] - rgb[j]) * t;
    rgb[j + 1] += (PAPER[1] - rgb[j + 1]) * t;
    rgb[j + 2] += (PAPER[2] - rgb[j + 2]) * t;
  }
}
