"""Prototype of the engine's per-hue colour (hue_shift, hue_lightness, hue_saturation: 6 knots each, the order of frontier.rs encode)
on rendered SG patches; fit on the first frame, test on the others. python3 proto_all.py col.json:FRAME ..."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy.optimize import minimize
from labd50 import lab2xyz, xyz2lab, SRGB, CAT_50_65, CAT_65_50
from sgref import REF
from de00 import de00
real = json.load(open('real.json')); names = real['names']; ref = np.array([REF[n] for n in names])
chrom = (np.hypot(ref[:, 1], ref[:, 2]) > 15) & ~np.isin(names, ['I4', 'M3'])
sets = [(lab2xyz(np.array(json.load(open(f))['sg_lab'])) @ (np.linalg.inv(SRGB) @ CAT_50_65).T, np.array(real['frames'][fr]['sg_lab']), fr)
        for f, fr in (a.split(':') for a in sys.argv[1:])]
KN = np.arange(30, 360, 60); LUMA = np.array([0.2126, 0.7152, 0.0722])
sm = lambda t: (lambda u: u * u * (3 - 2 * u))(np.clip(t, 0, 1))
def knots(h, g):
    w = sm(1 - np.abs((h[:, None] - KN[None, :] + 180) % 360 - 180) / 60); return (w * g[None, :]).sum(1) / w.sum(1)
def opp(lin):
    o1 = (lin[:, 0] - lin[:, 1]) / np.sqrt(2); o2 = (lin[:, 0] + lin[:, 1] - 2 * lin[:, 2]) / np.sqrt(6); return o1, o2, np.degrees(np.arctan2(o2, o1)) % 360
def apply(lin, p):
    rot, lg, sg = p[:6], p[6:12], p[12:]
    l = lin @ LUMA; o1, o2, h = opp(lin); m = lin.mean(1); t = np.radians(knots(h, rot))
    p1, p2 = np.cos(t) * o1 - np.sin(t) * o2, np.sin(t) * o1 + np.cos(t) * o2
    out = np.stack([m + p1 / np.sqrt(2) + p2 / np.sqrt(6), m - p1 / np.sqrt(2) + p2 / np.sqrt(6), m - 2 * p2 / np.sqrt(6)], 1)
    out = out + (l - out @ LUMA)[:, None]   # luma kept, as rotate_hue
    o1, o2, h = opp(out); w = sm((np.hypot(o1, o2) / np.maximum(l, 1e-6) - 0.19) / (0.66 - 0.19))
    out = out * (1 + w * (knots(h, lg) - 1))[:, None]
    l2 = out @ LUMA; o1, o2, h = opp(out); out = l2[:, None] + knots(h, sg)[:, None] * (out - l2[:, None])
    return xyz2lab(np.clip(out, 0, None) @ (CAT_65_50 @ SRGB).T)
err = lambda p, s: de00(s[1], apply(s[0], p))[chrom].mean()
p0 = np.r_[np.zeros(6), np.ones(12)]
reg = lambda p: 0.0002 * np.sum(p[:6] ** 2) + 0.5 * np.sum((p[6:] - 1) ** 2)
fit = minimize(lambda p: err(p, sets[0]) + reg(p), p0, method='Powell', options={'maxfev': 40000})
p = fit.x; print('shift', np.round(p[:6], 1), ' light', np.round(p[6:12], 2), ' sat', np.round(p[12:], 2))
for s in sets: print(f'{s[2]:24s} dE00 {err(p0, s):.2f} -> {err(p, s):.2f}')
json.dump({'hue_shift': np.round(p[:6], 1).tolist(), 'hue_lightness': np.round(p[6:12], 2).tolist(), 'hue_saturation': np.round(p[12:], 2).tolist()}, open('proto_all_out.json', 'w'))
