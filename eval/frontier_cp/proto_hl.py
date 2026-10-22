"""Prototype: per-hue rotation (deg) and per-hue lightness gain (weighted by relative chroma, as the engine's hue_lightness), 6 knots on
the opponent hue, on rendered SG patches. Fit on the first frame, test on the others. python3 proto_hl.py col.json:FRAME ..."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy.optimize import minimize
from labd50 import lab2xyz, xyz2lab, SRGB, CAT_50_65, CAT_65_50
from sgref import REF
from de00 import de00
real = json.load(open('real.json')); names = real['names']; ref = np.array([REF[n] for n in names])
chrom = (np.hypot(ref[:, 1], ref[:, 2]) > 15) & ~np.isin(names, ['I4', 'M3'])
sets = []
for a in sys.argv[1:]:
    f, fr = a.split(':'); sim = np.array(json.load(open(f))['sg_lab']); rl = np.array(real['frames'][fr]['sg_lab'])
    sets.append((lab2xyz(sim) @ (np.linalg.inv(SRGB) @ CAT_50_65).T, rl, fr))
KN = np.arange(30, 360, 60)
ss = lambda a, b, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - a) / (b - a), 0, 1))
def interp(h, g):
    d = (h[:, None] - KN[None, :] + 180) % 360 - 180; w = ss(0, 1, 1 - np.abs(d) / 60)
    return (w * g[None, :]).sum(1) / w.sum(1)
def apply(lin, p):
    rot, lg = p[:6], p[6:]
    o1 = (lin[:, 0] - lin[:, 1]) / np.sqrt(2); o2 = (lin[:, 0] + lin[:, 1] - 2 * lin[:, 2]) / np.sqrt(6)
    h = np.degrees(np.arctan2(o2, o1)) % 360; l = lin @ [0.2126, 0.7152, 0.0722]; c = np.hypot(o1, o2)
    # rotate the opponent chroma by rot(h) degrees, keep luma (as frontier.rs rotate_hue: back to RGB keeping l)
    t = np.radians(interp(h, rot)); n1 = o1 * np.cos(t) - o2 * np.sin(t); n2 = o1 * np.sin(t) + o2 * np.cos(t)
    # opponent -> RGB with the same mean, then rescale to keep luma
    m = lin.mean(1); r = m + n1 / np.sqrt(2) + n2 / np.sqrt(6); g = m - n1 / np.sqrt(2) + n2 / np.sqrt(6); b = m - 2 * n2 / np.sqrt(6)
    out = np.stack([r, g, b], 1); lo = out @ [0.2126, 0.7152, 0.0722]; out = out * (l / np.maximum(lo, 1e-6))[:, None]
    out = out * (1 + (interp(h, lg) - 1) * ss(0.19, 0.66, c / np.maximum(l, 1e-6)))[:, None]
    return xyz2lab(np.clip(out, 0, None) @ (CAT_65_50 @ SRGB).T)
err = lambda p, s: de00(s[1], apply(s[0], p))[chrom].mean()
p0 = np.r_[np.zeros(6), np.ones(6)]
fit = minimize(lambda p: err(p, sets[0]) + float(os.environ.get("RREG", 0.002)) * np.sum(p[:6] ** 2) + 0.5 * np.sum((p[6:] - 1) ** 2), p0, method='Powell', options={'maxfev': 20000})
p = fit.x; print('rot R Y G C B M', np.round(p[:6], 1), ' light', np.round(p[6:], 3))
for s in sets: print(f'{s[2]:24s} dE00 {err(p0, s):.2f} -> {err(p, s):.2f}')
