"""Prototype of a lightness-by-hue-and-chroma op on rendered SG patches (python3 proto.py col_X.json): per-patch table by opponent
hue, then a fit of strength / hue band / chroma ramp (and a saturation factor) on the mean dE00 against the real Frontier."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labd50 import lab2xyz, xyz2lab, SRGB, CAT_50_65, CAT_65_50
from sgref import REF
from de00 import de00
real = json.load(open('real.json')); names = real['names']; rl = np.array(real['frames']['Gold-0EV-Frontier']['sg_lab'])
sim = np.array(json.load(open(sys.argv[1]))['sg_lab'])
ref = np.array([REF[n] for n in names]); C = lambda x: np.hypot(x[:, 1], x[:, 2])
chrom = (C(ref) > 15) & ~np.isin(names, ['I4', 'M3']); neu = C(ref) < 3
lin = lab2xyz(sim) @ (np.linalg.inv(SRGB) @ CAT_50_65).T
o1 = (lin[:, 0] - lin[:, 1]) / np.sqrt(2); o2 = (lin[:, 0] + lin[:, 1] - 2 * lin[:, 2]) / np.sqrt(6)
h = np.degrees(np.arctan2(o2, o1)) % 360; l = lin @ [0.2126, 0.7152, 0.0722]; rc = np.hypot(o1, o2) / np.maximum(l, 1e-4)
def rel(x):
    o = np.argsort(ref[neu, 0]); return x[:, 0] - np.interp(ref[:, 0], ref[neu, 0][o], x[neu, 0][o])
dl = rel(sim) - rel(rl)
for i in np.argsort(h):
    if chrom[i]: print(f'{names[i]:4s} h {h[i]:5.0f} rc {rc[i]:5.2f} dL {dl[i]:+5.1f}  Csim/real {C(sim)[i] / C(rl)[i]:.2f}')
from scipy.optimize import minimize
ss = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))
def apply(p, lin=lin):
    k, a, b, c0, c1 = p
    w = ss(a - 15, a + 15, h) * (1 - ss(b - 15, b + 15, h)) * ss(c0, c0 + max(c1, 0.02), rc)
    return xyz2lab((lin * (1 - np.clip(k, 0, 0.95) * w)[:, None]) @ (CAT_65_50 @ SRGB).T)
f = lambda p: de00(rl, apply(p))[chrom].mean()
print('before', round(f([0, 0, 0, 1, 1]), 3))
best = min((minimize(f, x0, method='Nelder-Mead', options={'maxfev': 2000}) for x0 in ([0.4, 115, 240, 0.3, 0.3], [0.5, 110, 230, 0.2, 0.4], [0.3, 120, 250, 0.4, 0.2])), key=lambda r: r.fun)
print('after', round(best.fun, 3), np.round(best.x, 3))
def apply2(p):
    s = p[5]; l2 = lin @ [0.2126, 0.7152, 0.0722]
    li = np.clip(l2[:, None] + s * (lin - l2[:, None]), 0, None)
    return apply(p[:5], li)
f2 = lambda p: de00(rl, apply2(p))[chrom].mean()
b2 = minimize(f2, list(best.x) + [1.0], method='Nelder-Mead', options={'maxfev': 4000})
print('with sat factor', round(b2.fun, 3), np.round(b2.x, 3))
# robustness: same params on the other frames' sims are checked in the engine; here per-family after
lab = apply2(b2.x); dl2 = rel(lab) - rel(rl); H = lambda x: np.degrees(np.arctan2(x[:, 2], x[:, 1])) % 360; hr = H(rl)
for lo, hi, nm in [(330, 20, 'mag'), (20, 60, 'red'), (60, 100, 'yel'), (100, 160, 'grn'), (160, 220, 'cyn'), (220, 290, 'blu'), (290, 330, 'vio')]:
    s_ = chrom & (((hr - lo) % 360) < ((hi - lo) % 360)); print(nm, f'{np.median(dl2[s_]):+.1f} {np.median(C(lab)[s_] / C(rl)[s_]):.2f}')
