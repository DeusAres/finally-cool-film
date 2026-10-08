// Dust, fibres and scratches on the negative — procedural, no textures.
//
// What the scan shows: anything sitting on the NEGATIVE blocks the scanner's
// light, so that spot reads dark on the negative and, once inverted the way a
// lab scanner does, appears white. Dust and scratches on a scan of a negative
// are therefore light marks, and their opacity is simply how much light they
// block. Compositing is a mix towards white, applied after the whole film/scan
// chain, as a separate layer:
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
//     heading wandering as a mean-reverting random walk with rare kinks, width and
//     intensity varying along the line, tapering ends, faint parallel companions,
//     white or tinted (top dye layers only); plus short thin handling hairlines.
// Each primitive has a rank in [0, 1): the amount slider draws those with
// rank < amount, so raising it only ADDS marks; reseeding gives a new roll.
// Marks thinner than ~0.8 px are drawn 0.8 px wide with proportionally lower
// opacity (same light blocked), so they read the same at preview and 12 MP.

import { FRAME_UM } from './util.js';

const PAPER = [252, 250, 246];       // white of the marks after inversion (scanner white)

// Counts at amount 1 (a frame that has been handled carelessly).
const N_SPECKS = 320, N_FIBRES = 18, N_SCRATCHES = 4, N_HAIRLINES = 10;

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

  // 1D smooth noise for profiles along a path: random knots every `k` steps, cosine-interpolated.
  const profile = (n, k) => {
    const knots = Array.from({ length: Math.ceil(n / k) + 2 }, () => R());
    return (i) => { const t = i / k, j = Math.floor(t), f = (1 - Math.cos((t - j) * Math.PI)) / 2; return knots[j] + (knots[j + 1] - knots[j]) * f; };
  };
  // Tint: base-side scratches appear white after inversion; one that only strips
  // the negative's top dye layers lets more blue (yellow layer gone) or blue+green
  // light through, so the scan shows extra yellow / red there.
  const tint = () => { const r = R(); return r < 0.72 ? PAPER : r < 0.88 ? [253, 246, 214] : [252, 226, 214]; };

  // A drawn line: heading wanders (mean-reverting random walk, rare kinks),
  // width and intensity follow their own slow profiles, ends taper, and
  // intensity below a threshold leaves gaps (pressure lifted).
  const line = (x, y, heading, len, step, wander, width, alpha, gapLevel, color, rank) => {
    const n = Math.max(3, Math.round(len / step)), pts = [], w = [], a = [];
    const pw = profile(n, between(8, 30)), pa = profile(n, between(6, 40)), pf = profile(n, between(2, 6));
    let h = heading;
    for (let i = 0; i <= n; i++) {
      h += (R() - 0.5) * wander; h = heading + (h - heading) * 0.995;
      if (R() < 0.004) h += (R() - 0.5) * wander * 25;          // grit jumps: a small kink
      x += Math.cos(h) * step; y += Math.sin(h) * step;
      const t = i / n, taper = Math.min(1, t / 0.04, (1 - t) / 0.04);
      const lvl = 0.55 * pa(i) + 0.45 * pf(i);                // slow pressure + faster flicker
      pts.push([x, y]);
      w.push(width * (0.55 + 0.7 * pw(i)) * Math.max(0.2, taper));
      a.push(alpha * Math.max(0, Math.min(1, (lvl - gapLevel) / 0.25)) * Math.max(0, taper));
    }
    return { kind: 'scratch', rank, pts, w, a, color };
  };

  for (let i = 0; i < N_SCRATCHES; i++) {
    // Along the film's travel (x = the frame's long side), a little off axis.
    const x0 = between(-0.15, 0.5) * L, len = between(0.35, 1.2) * L, y0 = R() * S;
    const heading = between(-0.012, 0.012), rank = R() * 1.4, color = tint();
    const width = between(3, 8), alpha = between(0.5, 0.85), gap = between(0.1, 0.4);
    marks.push(line(x0, y0, heading, len, 60, 0.004, width, alpha, gap, color, rank));
    // The same grit often drags companions: close, parallel, shorter, fainter.
    for (let k = 0, nk = R() < 0.55 ? 1 + ((R() * 2) | 0) : 0; k < nk; k++) {
      const off = between(40, 220) * (R() < 0.5 ? -1 : 1), start = between(0, 0.5) * len;
      marks.push(line(x0 + start, y0 + off, heading + between(-0.002, 0.002), len * between(0.2, 0.7), 60, 0.004,
        width * between(0.4, 0.8), alpha * between(0.4, 0.8), gap + 0.1, color, rank));
    }
  }
  for (let i = 0; i < N_HAIRLINES; i++) {
    // Handling scratches: short, any direction, very thin, gently curved.
    marks.push(line(R() * L, R() * S, R() * Math.PI * 2, pareto(400, 1.4, 5000), 30, 0.02,
      between(1.5, 4), between(0.3, 0.6), between(0, 0.25), tint(), R()));
  }
  return marks;
}

/**
 * Draw `marks` (amount 0..1) into a 2D context showing the region (x0, y0) of
 * a W×H image whose long side is the frame's long side. White (PAPER) on a
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
    } else if (m.kind === 'scratch') {
      // Segment by segment: width and intensity vary along the line. Butt caps,
      // so joints do not double up; a faint wider pass gives the soft edge.
      ctx.lineCap = 'butt';
      const c = `${m.color[0]},${m.color[1]},${m.color[2]}`;
      for (const [k, scale] of [[2.6, 0.16], [1, 1]]) {
        for (let i = 1; i < m.pts.length; i++) {
          const wi = m.w[i] * k, ai = m.a[i] * scale * Math.min(1, wi / minW);
          if (ai < 0.004) continue;
          ctx.lineWidth = Math.max(wi, minW);
          ctx.strokeStyle = `rgba(${c},${ai})`;
          ctx.beginPath(); ctx.moveTo(m.pts[i - 1][0], m.pts[i - 1][1]); ctx.lineTo(m.pts[i][0], m.pts[i][1]); ctx.stroke();
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

/** Mix an RGB strip (w×h, row stride w*3) towards white by the alpha of an RGBA overlay of the same size. */
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
