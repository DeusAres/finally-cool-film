"""Our v4 Frontier at Auto on the reconstructed real frames (recon.py): grey patches' L* vs the real scan's.
python3 autorecon.py NAME 'auto params json' ['model overrides json']"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labd50 import lin2lab
import sim, mkfrontier
# MODEL: the model overrides (default: app.js V4_FRONTIER); SCAN=Noritsu: the Noritsu reconstructions
sys.path.insert(0, os.path.join(sim.ROOT, 'eval'))
from appconst import app_const
V4 = json.loads(os.environ['MODEL']) if 'MODEL' in os.environ else app_const('V4_FRONTIER')
name, auto = sys.argv[1], json.loads(sys.argv[2]); model = dict(V4, **(json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}))
model['auto'] = dict(app_const('V4_AUTO'), neutral_sigma=app_const('V4_NEUTRAL_SIGMA'), **auto)
json.dump(mkfrontier.params({"scanner": {"frontier": {"model": model}}}), open(f'p_ar_{name}.json', 'w'))
out = []
for s in ['Charts', 'Studio', 'Daylight']:
    tag = '' if os.environ.get('SCAN', 'Frontier') == 'Frontier' else '_' + os.environ['SCAN']
    meta = json.load(open(f'recon_{s}{tag}.json')); png = f'ar_{name}_{s}.png'
    err = sim.sf_image(f'p_ar_{name}.json', f'recon_{s}{tag}.npy', png, (1, 1, 1))
    lin = sim.png_lin(png)
    L = np.array([lin2lab(lin[y - 3:y + 3, x - 3:x + 3].reshape(-1, 3).mean(0))[0] for x, y in meta['pts']])
    refL, realL = np.array(meta['refL']), np.array(meta['realL'])
    mid = np.argmin(np.abs(refL - 49.7)) if s == 'Daylight' else np.abs(refL - 49.7) < 0.5
    out.append((s, np.mean(L[mid]), np.mean(realL[mid]), np.sqrt(np.mean((L - realL) ** 2)), err.split('autosetup')[-1].strip()[:40]))
print(f'{name:10s} ' + ' | '.join(f'{s} mid {a:5.1f} (real {b:5.1f}) greys rms {c:4.1f}' for s, a, b, c, _ in out), ' ', ' '.join(o[4] for o in out))
