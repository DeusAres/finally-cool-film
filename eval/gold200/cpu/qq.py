"""qq.py NAME FRAME: register enc_NAME_FRAME to the film and print the per-channel normalised-density QQ distance."""
import sys, subprocess, numpy as np
name, f = sys.argv[1], sys.argv[2]
qs = np.arange(2, 99, 2)
p = np.load(f'pairs_{name}_{f}.npy'); E, F = p[:, :3].astype(float), p[:, 3:].astype(float)
norm = lambda X: (X - np.percentile(X, 0.5, 0)) / (np.percentile(X, 99.8, 0) - np.percentile(X, 0.5, 0))
ne, nf = norm(E), norm(F)
d = [np.mean(np.abs(np.percentile(ne[:, c], qs) - np.percentile(nf[:, c], qs))) for c in range(3)]
mid = [np.percentile(ne[:, c], 50) - np.percentile(nf[:, c], 50) for c in range(3)]
print(f'{name} {f}: QQ dist R/G/B {d[0]:.3f}/{d[1]:.3f}/{d[2]:.3f} mean {np.mean(d):.3f} | median diff {mid[0]:+.2f}/{mid[1]:+.2f}/{mid[2]:+.2f}')
