"""Our v4 Frontier at Auto on the reconstructed real frames (recon.py): grey patches' L* vs the real scan's.
python3 autorecon.py NAME 'auto params json' ['model overrides json']"""
import sys, os, json, subprocess, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
from labd50 import dec, lin2lab, SRGB, BT2020
import sim, mkfrontier
# the v4 model of app.js V4_FRONTIER (keep in step)
V4 = {"gradation_a": 9.6, "black_point": 0.023, "white_point": 0.97, "shoulder_start": 0.95, "shoulder_sharpness": 0, "saturation": 0.92,
      "saturation_blue": 0.05, "blue_hue_shift": 18, "green_hue_shift": 20, "hue_lightness": [0.91, 0.92, 0.46, 0.75, 0.9, 0.96],
      "hue_saturation": [0.88, 1.06, 0.97, 1.04, 0.73, 0.64], "hue_shift": [3, 1, 6, 7, -5, 12]}
name, auto = sys.argv[1], json.loads(sys.argv[2]); model = dict(V4, **(json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}))
model['auto'] = dict({"k_col": 0.68, "neutral_sigma": 0.06}, **auto)
json.dump(mkfrontier.params({"scanner": {"frontier": {"model": model}}}), open(f'p_ar_{name}.json', 'w'))
out = []
for s in ['Charts', 'Studio', 'Daylight']:
    meta = json.load(open(f'recon_{s}.json')); png = f'ar_{name}_{s}.png'
    r = subprocess.run([f'{sim.ROOT}/engine/target/release/sf-eval', 'image', '--params', f'p_ar_{name}.json', '--in', f'recon_{s}.npy', '--out', png,
                        '--output-space', 'bt2020', '--under', '0', '--gains', '1,1,1', '--data', f'{sim.ROOT}/web/data'], env=dict(os.environ, LD_LIBRARY_PATH=sim.openblas()), capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr)
    lin = np.clip(dec(np.asarray(Image.open(png).convert('RGB')).astype(float) / 255) @ (np.linalg.inv(SRGB) @ BT2020).T, 0, 1)
    L = np.array([lin2lab(lin[y - 3:y + 3, x - 3:x + 3].reshape(-1, 3).mean(0))[0] for x, y in meta['pts']])
    refL, realL = np.array(meta['refL']), np.array(meta['realL'])
    mid = np.argmin(np.abs(refL - 49.7)) if s == 'Daylight' else np.abs(refL - 49.7) < 0.5
    out.append((s, np.mean(L[mid]), np.mean(realL[mid]), np.sqrt(np.mean((L - realL) ** 2)), r.stderr.split('autosetup')[-1].strip()[:40]))
print(f'{name:10s} ' + ' | '.join(f'{s} mid {a:5.1f} (real {b:5.1f}) greys rms {c:4.1f}' for s, a, b, c, _ in out), ' ', ' '.join(o[4] for o in out))
