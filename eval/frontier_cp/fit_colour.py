"""Fit the Frontier colour controls to the real Frontier SG at 0 EV, keys (density, C, M, Y) fixed from the tone-fitted grey match.
python3 fit_colour.py NAME 'base model json' 'keys json' p1,p2,..."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy.optimize import minimize
import sim
from sgref import REF
from de00 import de00
name, base, keys, FREE = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4].split(',')
real = json.load(open('real.json')); names = real['names']; rl = np.array(real['frames']['Gold-0EV-Frontier']['sg_lab'])
ref = np.array([REF[n] for n in names]); chrom = (np.hypot(ref[:, 1], ref[:, 2]) > 15) & ~np.isin(names, ['I4', 'M3'])   # I4, M3 differ on this Calibrite chart (both scanners agree, far from X-Rite)
log = open(f'fitc_{name}.log', 'w')
def f(v):
    m = dict(base); m.update(zip(FREE, map(float, v)))
    r = sim.run(f'fc_{name}', {"scanner": {"frontier": {"density": keys[0], "cmy": keys[1:], "model": m}}}, [0.0])
    lab = np.array(r['+0']['sg_lab']); e = de00(rl, lab)[chrom].mean()
    print(f'{e:.3f} ' + ' '.join(f'{k}={x:.4f}' for k, x in zip(FREE, v)), file=log, flush=True)
    return e
x0 = [base.get(k, {'saturation': 1.01, 'saturation_blue': 0.15, 'blue_hue_shift': 17, 'green_hue_shift': 24, 'saturation_warm': 0, 'warm_hue_shift': 0}[k]) for k in FREE]
steps = {'saturation': 0.15, 'saturation_blue': 0.2, 'blue_hue_shift': 10, 'green_hue_shift': 10, 'saturation_warm': 0.2, 'warm_hue_shift': 5}
simplex = [x0] + [[x + (steps[k] if j == i else 0) for j, (k, x) in enumerate(zip(FREE, x0))] for i in range(len(FREE))]
res = minimize(f, x0, method='Nelder-Mead', options={'initial_simplex': simplex, 'xatol': 0.01, 'fatol': 0.02, 'maxfev': 120})
m = dict(base); m.update(zip(FREE, map(float, res.x)))
print(json.dumps({'de00': res.fun, 'model': m}), file=log, flush=True)
