"""Prototype: an extra hue rotation with N knots (30 + i * 360 / N deg, opponent hue) on top of rendered SG patches (colour.py
col_*.json), FREE = the knots let move; fit on the first frame, test the others. N=12 FREE=4,5,6 python3 proto_rot.py col.json:FRAME ..."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy.optimize import minimize
from labd50 import lab2xyz, xyz2lab, SRGB, CAT_50_65, CAT_65_50
from sgref import REF
from de00 import de00
N = int(os.environ.get('N', 12)); REG = float(os.environ.get('REG', 0.0005))
real = json.load(open('real.json')); names = real['names']; ref = np.array([REF[n] for n in names])
chrom = (np.hypot(ref[:, 1], ref[:, 2]) > 15) & ~np.isin(names, ['I4', 'M3'])
sets = [(lab2xyz(np.array(json.load(open(f))['sg_lab'])) @ (np.linalg.inv(SRGB) @ CAT_50_65).T, np.array(real['frames'][fr]['sg_lab']), fr)
        for f, fr in (a.split(':') for a in sys.argv[1:])]
KN = 30 + np.arange(N) * 360 / N; SP = 360 / N; LUMA = np.array([0.2126, 0.7152, 0.0722])
sm = lambda t: (lambda u: u * u * (3 - 2 * u))(np.clip(t, 0, 1))
def knots(h, g):
    w = sm(1 - np.abs((h[:, None] - KN[None, :] + 180) % 360 - 180) / SP); return (w * g[None, :]).sum(1) / w.sum(1)
def apply(lin, rot):
    l = lin @ LUMA; o1 = (lin[:, 0] - lin[:, 1]) / np.sqrt(2); o2 = (lin[:, 0] + lin[:, 1] - 2 * lin[:, 2]) / np.sqrt(6)
    h = np.degrees(np.arctan2(o2, o1)) % 360; t = np.radians(knots(h, rot)); m = lin.mean(1)
    p1, p2 = np.cos(t) * o1 - np.sin(t) * o2, np.sin(t) * o1 + np.cos(t) * o2
    out = np.stack([m + p1 / np.sqrt(2) + p2 / np.sqrt(6), m - p1 / np.sqrt(2) + p2 / np.sqrt(6), m - 2 * p2 / np.sqrt(6)], 1)
    out = out + (l - out @ LUMA)[:, None]
    return xyz2lab(np.clip(out, 0, None) @ (CAT_65_50 @ SRGB).T), h
err = lambda p, s: de00(s[1], apply(s[0], p)[0])[chrom].mean()
FREE = [int(i) for i in os.environ['FREE'].split(',')] if os.environ.get('FREE') else list(range(N))
full = lambda q: (lambda v: (v.__setitem__(FREE, q), v)[1])(np.zeros(N))
fit = minimize(lambda q: err(full(q), sets[0]) + REG * np.sum(q ** 2), np.zeros(len(FREE)), method='Powell', options={'maxfev': 30000})
p = full(fit.x); print('N', N, 'extra rot', np.round(p, 1))
H = lambda x: np.degrees(np.arctan2(x[:, 2], x[:, 1])) % 360
for s in sets:
    lab0 = apply(s[0], np.zeros(N))[0]; lab1, h = apply(s[0], p)
    d = lambda lab, k: ((H(lab) - H(s[1]) + 180) % 360 - 180)[names.index(k)]
    print(f'{s[2]:24s} dE00 {err(np.zeros(N), s):.2f} -> {err(p, s):.2f}   dh D9 {d(lab0,"D9"):+.0f}->{d(lab1,"D9"):+.0f} F9 {d(lab0,"F9"):+.0f}->{d(lab1,"F9"):+.0f} B8 {d(lab0,"B8"):+.0f}->{d(lab1,"B8"):+.0f} C8 {d(lab0,"C8"):+.0f}->{d(lab1,"C8"):+.0f}')
if os.environ.get('OPP'):
    print('opp hue of D9 F9 B8 C8 (render):', [round(float(apply(sets[0][0], np.zeros(N))[1][names.index(k)])) for k in ['D9', 'F9', 'B8', 'C8']])
