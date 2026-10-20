import sys, subprocess, numpy as np
from skimage import color
name = sys.argv[1]
for f in ('13', '17'):
    p = np.load(f'pairs_{name}_{f}.npy'); idx = np.random.default_rng(0).choice(len(p), min(len(p), 200000), replace=False)
    np.save('tmp_pairs.npy', p[idx]); subprocess.run(['node', 'samecontent.mjs', 'tmp_pairs.npy', 'tmp_pairs.rgb'], check=True)
    q = np.frombuffer(open('tmp_pairs.rgb', 'rb').read(), np.uint8).reshape(-1, 2, 3) / 255.0
    E, F = color.rgb2lab(q[:, 0][None])[0], color.rgb2lab(q[:, 1][None])[0]
    CE, CF = np.hypot(E[:, 1], E[:, 2]), np.hypot(F[:, 1], F[:, 2])
    out = []
    for lo, hi in [(0, 25), (25, 50), (50, 75), (75, 101)]:
        k = (F[:, 0] >= lo) & (F[:, 0] < hi)
        out.append(f"{(E[k,1]-F[k,1]).mean():+5.1f}/{(E[k,2]-F[k,2]).mean():+5.1f}" if k.mean() > .01 else '   -   ')
    hueok = (CF > 15) & (CE > 15)
    dh = np.degrees(np.angle(np.exp(1j * (np.arctan2(E[hueok, 2], E[hueok, 1]) - np.arctan2(F[hueok, 2], F[hueok, 1])))))
    print(f"{name} {f}: chroma engine/film median {np.median(CE):.1f}/{np.median(CF):.1f} (ratio {np.median(CE)/np.median(CF):.2f}) | "
          f"dL {np.mean(E[:,0]-F[:,0]):+.1f} | da/db (engine - film) by film L 0-25/25-50/50-75/75+: {'  '.join(out)} | hue diff median {np.median(dh):+.0f} deg")
