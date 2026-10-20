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
// 36 mm-long-side frame (util.js FRAME_UM; the engine's grain uses 35, see app.js FILM_FORMAT_MM), so the preview and
// every export tile draw exactly the same marks at any resolution:
//   - specks: irregular clusters of 1–3 ellipses, mostly tiny grit (a few µm to
//     ~30 µm, i.e. 1–3 px on a 12 MP scan), a light tail of bigger flakes up to
//     ~0.2 mm across; some out of focus (dust on the base side, ~0.1 mm from the
//     emulsion) drawn as faint soft radial falloffs;
//   - fibres / hairs: rare, thin (4–9 µm), mostly short (median ~0.3 mm, at most
//     2.5 mm) and curly: smooth random walks whose curvature is itself a random walk;
//   - scratches: rare (most frames at the default amount have none), along the
//     film's travel (the frame's long side), heading wandering slightly with
//     rare kinks, width and intensity varying along the line so it breaks into
//     dashes with gaps, tapering ends, the odd faint parallel companion, white
//     or tinted (top dye layers only); plus a few short broken handling hairlines.
// Each primitive has a rank in [0, 1) (scratches up to 2.5, so not all appear
// even at amount 1): the amount slider draws those with rank < amount, so
// raising it only ADDS marks; reseeding gives a new roll. Ranks of the more
// conspicuous marks (bigger specks, longer fibres / hairlines) are skewed up, so
// low amounts show mostly small grit and big marks only turn up near 1.
// Marks thinner than ~0.8 px are drawn 0.8 px wide with proportionally lower
// opacity (same light blocked), so they read the same at preview and 12 MP.

import { FRAME_UM } from './util.js';

const PAPER = [252, 250, 246];       // white of the marks after inversion (scanner white)

// Counts at amount 1 (a frame that has been handled carelessly).
const N_SPECKS = 450, N_FIBRES = 8, N_SCRATCHES = 3, N_HAIRLINES = 5;

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
  // Rank skewed towards 1 for conspicuous marks (size ≫ ref): they only turn
  // up as the amount rises; small ones keep a uniform rank and come first.
  // `k` > 1 makes a whole class rarer at low amounts (P(rank < a) = a^k for small marks).
  const rankFor = (size, ref, k = 1) => Math.pow(R(), 1 / (k + Math.pow(size / ref, 1.3)));
  const marks = [];

  for (let i = 0; i < N_SPECKS; i++) {
    const r = pareto(4, 1.6, 75);                   // µm radius: median ~6, 17 % above 12, 2 % above 50
    const soft = R() < 0.25;
    const parts = [];
    for (let k = 0, n = 1 + ((R() * 3) | 0); k < n; k++) {
      parts.push({ dx: between(-0.6, 0.6) * r, dy: between(-0.6, 0.6) * r,
        rx: r * between(0.4, 0.9), ry: r * between(0.3, 0.8), rot: R() * Math.PI });
    }
    marks.push({ kind: 'speck', rank: rankFor(r, 22), x: R() * L, y: R() * S, parts, soft,
      alpha: soft ? between(0.15, 0.32) : between(0.5, 0.9), blur: soft ? r * between(0.5, 1.1) : 0 });
  }

  for (let i = 0; i < N_FIBRES; i++) {
    // Lint: mostly short and curly, thin. Curvature (rad/µm) is a mean-reverting
    // random walk with the odd tight curl; the step scales with the length so
    // short fibres bend as much as long ones.
    const len = pareto(200, 1.5, 2500), step = Math.min(20, Math.max(5, len / 40)), n = Math.ceil(len / step);
    let x = R() * L, y = R() * S, a = R() * Math.PI * 2, curv = between(-0.006, 0.006);
    const pts = [[x, y]];
    for (let k = 0; k < n; k++) {
      curv += (R() - 0.5) * 0.004; curv *= 0.96;
      if (R() < 0.03) curv += between(-0.02, 0.02);
      a += curv * step; x += Math.cos(a) * step; y += Math.sin(a) * step;
      pts.push([x, y]);
    }
    const soft = R() < 0.35;
    marks.push({ kind: 'fibre', rank: rankFor(len, 500, 2.5), pts, width: between(4, 9), soft,
      alpha: soft ? between(0.2, 0.4) : between(0.35, 0.7) });
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
  // intensity below a threshold leaves gaps (pressure lifted), so the line
  // breaks into dashes of varying strength instead of running continuous.
  const line = (x, y, heading, len, step, wander, width, alpha, gapLevel, color, rank) => {
    const n = Math.max(3, Math.round(len / step)), pts = [], w = [], a = [];
    const pw = profile(n, between(8, 30)), pa = profile(n, between(6, 30)), pf = profile(n, between(2, 5));
    let h = heading;
    for (let i = 0; i <= n; i++) {
      h += (R() - 0.5) * wander; h = heading + (h - heading) * 0.99;
      if (R() < 0.004) h += (R() - 0.5) * wander * 20;          // grit jumps: a small kink
      x += Math.cos(h) * step; y += Math.sin(h) * step;
      const t = i / n, taper = Math.min(1, t / 0.08, (1 - t) / 0.08);
      const lvl = 0.5 * pa(i) + 0.5 * pf(i);                  // slow pressure + faster flicker
      pts.push([x, y]);
      w.push(width * (0.5 + 0.7 * pw(i)) * Math.max(0.2, taper));
      a.push(alpha * Math.max(0, Math.min(1, (lvl - gapLevel) / 0.2)) * Math.max(0, taper));
    }
    return { kind: 'scratch', rank, pts, w, a, color };
  };

  for (let i = 0; i < N_SCRATCHES; i++) {
    // Along the film's travel (x = the frame's long side), a little off axis.
    // Rank up to 2.5: about one scratch per frame at amount 1, none on most
    // frames at the default amount.
    const len = between(0.12, 0.65) * L, x0 = between(-0.1, 1) * (L - len * 0.8), y0 = R() * S;
    const heading = between(-0.015, 0.015), rank = R() * 2.5, color = tint();
    const width = between(2.5, 6), alpha = between(0.3, 0.6), gap = between(0.4, 0.55);
    marks.push(line(x0, y0, heading, len, 50, 0.008, width, alpha, gap, color, rank));
    // The same grit sometimes drags a companion: close, parallel, shorter, fainter.
    if (R() < 0.35) {
      const off = between(40, 220) * (R() < 0.5 ? -1 : 1), start = between(0, 0.5) * len;
      marks.push(line(x0 + start, y0 + off, heading + between(-0.002, 0.002), len * between(0.2, 0.5), 50, 0.008,
        width * between(0.4, 0.8), alpha * between(0.4, 0.7), gap + 0.05, color, rank));
    }
  }
  for (let i = 0; i < N_HAIRLINES; i++) {
    // Handling scratches: short, any direction, very thin, gently curved, broken.
    const len = pareto(150, 1.6, 1500);
    marks.push(line(R() * L, R() * S, R() * Math.PI * 2, len, 15, 0.03,
      between(2, 5), between(0.3, 0.55), between(0.2, 0.4), tint(), rankFor(len, 400, 2)));
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
        ctx.moveTo(m.pts[0][0], m.pts[0][1]);
        for (let i = 1; i < m.pts.length; i++) ctx.lineTo(m.pts[i][0], m.pts[i][1]);
        ctx.stroke();
      };
      // Out of focus: a slightly wider, faint core with a soft halo (not a thick rope).
      if (m.soft) { stroke(w * 2.2, a * 0.22); stroke(w, a * 0.45); }
      else stroke(w, a);
    }
  }
  ctx.restore();
}

/** Mix an RGB strip (w×h, row stride w*3) towards an RGBA overlay of the same size (its colour, by its alpha). */
export function compositeDust(rgb, overlay) {
  for (let p = 0, j = 0; p < overlay.length; p += 4, j += 3) {
    const a = overlay[p + 3];
    if (!a) continue;
    const t = a / 255;   // towards the mark's own colour (PAPER, or a tinted scratch), as the preview canvas shows it
    rgb[j] += (overlay[p] - rgb[j]) * t;
    rgb[j + 1] += (overlay[p + 1] - rgb[j + 1]) * t;
    rgb[j + 2] += (overlay[p + 2] - rgb[j + 2]) * t;
  }
}
