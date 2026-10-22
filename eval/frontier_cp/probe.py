"""One render with fixed keys; per hue family: lightness relative to the grey of the same reference L* (key-independent),
chroma ratio and hue shift vs the real Frontier 0 EV. python3 probe.py NAME 'overrides json (full sf-eval params)'"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sim
from sgref import REF
from de00 import de00
name, ov = sys.argv[1], json.loads(sys.argv[2])
real = json.load(open('real.json')); names = real['names']; rl = np.array(real['frames']['Gold-0EV-Frontier']['sg_lab'])
ref = np.array([REF[n] for n in names]); C = lambda x: np.hypot(x[:, 1], x[:, 2]); H = lambda x: np.degrees(np.arctan2(x[:, 2], x[:, 1])) % 360
neu = C(ref) < 3; chrom = (C(ref) > 15) & ~np.isin(names, ['I4', 'M3'])
base = {"scanner": {"frontier": {"density": 1.5, "cmy": [0.01, 0.04, 0.04]}}}
def merge(d, s):
    for k, v in s.items(): d[k] = merge(d.get(k, {}), v) if isinstance(v, dict) and isinstance(d.get(k), dict) else v
    return d
lab = np.array(sim.run(f'pr_{name}', merge(base, ov), [0.0])['+0']['sg_lab'])
def rel(x):   # L* minus the grey ramp's L* at the patch's reference L*
    o = np.argsort(ref[neu, 0]); return x[:, 0] - np.interp(ref[:, 0], ref[neu, 0][o], x[neu, 0][o])
dl = rel(lab) - rel(rl); hr = H(rl); dh = (H(lab) - H(rl) + 180) % 360 - 180
out = f'{name:14s} dE00 {de00(rl, lab)[chrom].mean():.2f} |'
for lo, hi, nm in [(330, 20, 'mag'), (20, 60, 'red'), (60, 100, 'yel'), (100, 160, 'grn'), (160, 220, 'cyn'), (220, 290, 'blu'), (290, 330, 'vio')]:
    s = chrom & (((hr - lo) % 360) < ((hi - lo) % 360))
    out += f' {nm} {np.median(dl[s]):+5.1f}/{np.median(C(lab)[s] / C(rl)[s]):.2f}/{np.median(dh[s]):+4.0f}'
print(out); json.dump({'sg_lab': lab.tolist()}, open(f'col_pr_{name}.json', 'w'))
