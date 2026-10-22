"""Prototype: per-hue saturation (6 knots on the opponent hue, periodic smooth interpolation) on rendered SG patches.
Fit on one frame, test on the others. python3 proto_hs.py col_0.json:FRAME0 col_m1.json:FRAMEm1 ..."""
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
    lin = lab2xyz(sim) @ (np.linalg.inv(SRGB) @ CAT_50_65).T; sets.append((lin, rl, fr))
KN = np.arange(30, 360, 60)   # red, yellow, green, cyan, blue, magenta
def gain(h, g):
    d = (h[:, None] - KN[None, :] + 180) % 360 - 180; w = np.clip(1 - np.abs(d) / 60, 0, 1); w = w * w * (3 - 2 * w)
    return (w * g[None, :]).sum(1) / w.sum(1)
def apply(lin, g):
    o1 = (lin[:, 0] - lin[:, 1]) / np.sqrt(2); o2 = (lin[:, 0] + lin[:, 1] - 2 * lin[:, 2]) / np.sqrt(6)
    h = np.degrees(np.arctan2(o2, o1)) % 360; l = lin @ [0.2126, 0.7152, 0.0722]
    out = np.clip(l[:, None] + gain(h, g)[:, None] * (lin - l[:, None]), 0, None)
    return xyz2lab(out @ (CAT_65_50 @ SRGB).T)
err = lambda g, s: de00(s[1], apply(s[0], g))[chrom].mean()
fit = minimize(lambda g: err(g, sets[0]) + 0.5 * np.sum((g - 1) ** 2), np.ones(6), method='Nelder-Mead', options={'maxfev': 4000})
g = fit.x; print('gains R Y G C B M', np.round(g, 3))
for s in sets: print(f'{s[2]:24s} dE00 {err(np.ones(6), s):.2f} -> {err(g, s):.2f}')
