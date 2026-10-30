"""Render the chart with a candidate Frontier model, fit the nuisances (density key, C/M/Y keys) to the real frame's SG greys,
then compare every SG patch: chroma ratio and hue shift vs the real Frontier, by hue family.
python3 colour.py NAME 'model overrides json' [frame ev, default 0]"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy.optimize import least_squares
import sim
from sgref import REF
name, model = sys.argv[1], json.loads(sys.argv[2]); ev = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
SCAN = os.environ.get('SCAN', 'Frontier')
FR = {-3: 'minus3EV', -1: 'minus1EV', 0: '0EV', 1: 'plus1EV', 2: 'plus2EV', 3: 'plus3EV', 4: 'plus4EV'}   # -3 / +3 / +4: from the tool's PDFs
real = json.load(open('real.json')); names = real['names']; rl = np.array(real['frames'][f'Gold-{FR[int(ev)]}-{SCAN}']['sg_lab'])
ref = np.array([REF[n] for n in names]); neu = np.hypot(ref[:, 1], ref[:, 2]) < 3; mid = neu & (ref[:, 0] > 25) & (ref[:, 0] < 85)
def render(keys):
    d, c, m, y = keys
    r = sim.run(f'{name}_tmp', {"scanner": {"frontier": {"density": d, "cmy": [c, m, y], "model": model}}}, [ev])
    return np.array(r[f'{ev:+g}']['sg_lab'])
cache = {}
def res(k):
    key = tuple(np.round(k, 4))
    if key not in cache: cache[key] = render(k)
    lab = cache[key]
    return np.concatenate([(lab[mid] - rl[mid]).ravel()])
k = np.array([1.5, 0, 0, 0.0])
for it in range(6):   # Gauss-Newton with finite differences (renders are 3 s)
    r0 = res(k); J = np.stack([(res(k + h) - r0) / 0.05 for h in np.eye(4) * 0.05], 1)
    step = np.linalg.lstsq(J, -r0, rcond=None)[0]; k = k + np.clip(step, -0.5, 0.5)
    if np.abs(step).max() < 0.005: break
lab = cache[tuple(np.round(k, 4))] if tuple(np.round(k, 4)) in cache else render(k)
json.dump({'keys': k.tolist(), 'sg_lab': lab.tolist()}, open(f'col_{name}_{ev:+g}.json', 'w'))
C = lambda x: np.hypot(x[:, 1], x[:, 2]); H = lambda x: np.degrees(np.arctan2(x[:, 2], x[:, 1]))
chrom = (C(ref) > 15) & ~np.isin(names, ['I4', 'M3'])
from de00 import de00
print(f'  dE00 chromatic mean {de00(rl, lab)[chrom].mean():.2f}')
dh = (H(lab) - H(rl) + 180) % 360 - 180
print(f'{name} ev {ev:+g}: keys [density, c, m, y] {np.round(k, 3)}  greys rms {np.sqrt(np.mean(res(k) ** 2)):.2f}')
print(f'  all chromatic ({chrom.sum()}): chroma sim/real median {np.median(C(lab)[chrom] / C(rl)[chrom]):.3f}, dE76 mean {np.linalg.norm(lab - rl, axis=1)[chrom].mean():.1f}, dL mean {(lab - rl)[chrom, 0].mean():+.1f}')
hr = H(rl)
for lo, hi, nm in [(-30, 20, 'magenta-red'), (20, 60, 'red-orange/skin'), (60, 100, 'yellow'), (100, 160, 'green'), (160, 220, 'cyan'), (220, 290, 'blue'), (290, 330, 'violet')]:
    s = chrom & (((hr - lo) % 360) < (hi - lo))
    if s.sum(): print(f'  {nm:16s} n {s.sum():2d}  C ratio {np.median(C(lab)[s] / C(rl)[s]):.2f}  dh {np.median(dh[s]):+5.1f} deg  dL {np.median((lab - rl)[s, 0]):+5.1f}')
print('  greys (ref L, real L a b | sim L a b):')
for i in np.where(neu)[0][np.argsort(ref[neu, 0])][::3]:
    print(f'   {ref[i, 0]:5.1f} | {rl[i, 0]:5.1f} {rl[i, 1]:+5.1f} {rl[i, 2]:+5.1f} | {lab[i, 0]:5.1f} {lab[i, 1]:+5.1f} {lab[i, 2]:+5.1f}')
