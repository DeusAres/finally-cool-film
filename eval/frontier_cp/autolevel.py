"""Auto (no operator keys) on the reconstructed frame: SG mid-grey L* at -1..+2 EV vs the real Frontier (67.9 / 66.8 / 69.2 / 68.6).
python3 autolevel.py NAME 'auto params json' ['model overrides json']"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sim
from sgref import REF
sys.path.insert(0, os.path.join(sim.ROOT, 'eval'))
from appconst import app_const
V4 = json.loads(os.environ["MODEL"]) if "MODEL" in os.environ else app_const('V4_FRONTIER')
REAL = json.loads(os.environ.get("REAL", "[67.9, 66.8, 69.2, 68.6]"))
name, auto = sys.argv[1], json.loads(sys.argv[2]); model = dict(V4, **(json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}))
model['auto'] = dict(app_const('V4_AUTO'), neutral_sigma=app_const('V4_NEUTRAL_SIGMA'), **auto)
n = json.load(open('real.json'))['names']; ref = np.array([REF[k] for k in n]); mid = (np.hypot(ref[:, 1], ref[:, 2]) < 3) & (abs(ref[:, 0] - 49.7) < 0.3)
r = sim.run(f'al_{name}', {"scanner": {"frontier": {"model": model}}}, [-1, 0, 1, 2])
L = [np.array(v['sg_lab'])[mid, 0].mean() for v in r.values()]
print(f'{name:12s} mid grey ' + ' '.join(f'{l:5.1f}' for l in L) + f'  | real ' + ' '.join(f'{l:5.1f}' for l in REAL) + f'  rms {np.sqrt(np.mean((np.array(L) - REAL) ** 2)):.2f}  '
      + ' '.join(v['auto'].split('=')[-1].strip()[:28] for v in r.values()))
