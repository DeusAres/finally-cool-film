"""Fit the Frontier gradation to the real Frontier (or Noritsu) Gold 200 chart scans.
Per frame (-1..+2 EV) a free density offset (the operator's / post exposure); the Kodak card a free illumination offset (it sits
lower in the frame and reads ~0.5 EV darker than the SG on both scanners)."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy.optimize import least_squares
from curve import gradation, APP
from sgref import REF
from labd50 import dec
from sim import RAMP_LOG
SCAN = sys.argv[1] if len(sys.argv) > 1 else 'Frontier'
FREE = (sys.argv[2] if len(sys.argv) > 2 else 'gradation_a,shoulder_start,shoulder_sharpness,black_point,white_point').split(',')
FIXED = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
APP = dict(APP, **FIXED)
FR = {'-1': f'Gold-minus1EV-{SCAN}', '+0': f'Gold-0EV-{SCAN}', '+1': f'Gold-plus1EV-{SCAN}', '+2': f'Gold-plus2EV-{SCAN}'}
real = json.load(open('real.json')); ext = json.load(open('sim_ext.json')); names = real['names']
def Lstar(Y): Y = np.clip(Y, 1e-6, None); return np.where(Y > 0.008856, 116 * np.cbrt(Y) - 16, 903.3 * Y)
def logY_of_L(L): f = (L + 16) / 116; return np.log10(np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)))
ref = np.array([REF[n] for n in names]); neu = np.hypot(ref[:, 1], ref[:, 2]) < 3
lv = {}
for i in np.where(neu)[0]: lv.setdefault(round(ref[i, 0] / 2), []).append(i)
groups = sorted(lv.values(), key=lambda g: ref[g[0], 0])
sg_logY = np.array([logY_of_L(ref[g, 0].mean()) for g in groups])
kd_logY = -(0.05 + 0.1 * np.arange(20))
data = {}
for k, fname in FR.items():
    fr = real['frames'][fname]; sgL = np.array(fr['sg_lab'])[:, 0]; kdL = np.array(fr['kodak_lab'])[:, 0]
    D = (np.array(ext[k]['ramp_enc'])[:, 1] - 0.5) * 2.4
    data[k] = (np.array([sgL[g].mean() for g in groups]), kdL, D)
def predict(p, D, logY, d):
    return Lstar(dec(gradation(p)(0.5 + (np.interp(logY, RAMP_LOG, D) + d) / p['range_density'])))
def unpack(v):
    p = dict(APP); p.update(zip(FREE, v[:len(FREE)])); return p, v[len(FREE):len(FREE) + 4], v[-1]
def resid(v):
    p, ds, kap = unpack(v); r = []
    for (k, (sgL, kdL, D)), d in zip(data.items(), ds):
        r += list(predict(p, D, sg_logY, d) - sgL) + list(0.7 * (predict(p, D, kd_logY + kap, d) - kdL))
    return np.array(r)
def report(v, title):
    p, ds, kap = unpack(v); r = resid(v)
    print(f'== {title}: rms {np.sqrt(np.mean(r ** 2)):.2f} L*  kodak offset {kap:+.2f} logY  density offsets {np.round(ds, 3)}')
    print('   ' + ', '.join(f'{k} {p[k]:.4g}' for k in FREE))
    sgL, kdL, D = data['+0']
    print('   0EV SG:    ' + ' '.join(f'{a:5.1f}' for a in sgL)); print('   fit:       ' + ' '.join(f'{a:5.1f}' for a in predict(p, D, sg_logY, ds[1])))
    print('   0EV Kodak: ' + ' '.join(f'{a:5.1f}' for a in kdL)); print('   fit:       ' + ' '.join(f'{a:5.1f}' for a in predict(p, D, kd_logY + kap, ds[1])))
    return p
x0 = np.array([APP[k] for k in FREE] + [0.0] * 4 + [-0.2])
nf = len(FREE)
base = least_squares(lambda v: resid(np.concatenate([x0[:nf], v])), x0[nf:], loss='soft_l1', f_scale=3)
report(np.concatenate([x0[:nf], base.x]), 'current v4 curve (only the nuisances fitted)')
lo = [{'gradation_a': 2, 'shoulder_start': 0.05, 'shoulder_sharpness': 0, 'black_point': 0, 'white_point': 0.85, 'range_density': 0.8, 'mid_grey_out': 0.3}[k] for k in FREE] + [-1] * 4 + [-1]
hi = [{'gradation_a': 14, 'shoulder_start': 0.95, 'shoulder_sharpness': 6, 'black_point': 0.08, 'white_point': 1.0, 'range_density': 3, 'mid_grey_out': 0.6}[k] for k in FREE] + [1] * 4 + [0.5]
fit = least_squares(resid, np.clip(np.concatenate([x0[:nf], base.x]), lo, hi), bounds=(lo, hi), loss='soft_l1', f_scale=3)
p = report(fit.x, f'fitted to the {SCAN}')
json.dump({k: p[k] for k in FREE}, open(f'tone_{SCAN}.json', 'w'))
