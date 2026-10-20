"""Align the engine's negative scan (enc_<name>_<f>.npy) to the real film's (T<f>.npy) and compare densities pixel by pixel."""
import sys, numpy as np, cv2
from scipy.ndimage import gaussian_filter
name = sys.argv[1]
SIG = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
dec = lambda e: np.where(e <= 0.04045, e / 12.92, ((e + 0.055) / 1.055) ** 2.4)
res = {}
for f in (sys.argv[3].split(',') if len(sys.argv) > 3 else ('13', '17', '18')):
    T = np.load(f'T{f}.npy').astype(np.float64)
    if f != '13': T = np.rot90(T, 1)[:, ::-1]              # film 17/18: landscape scan through the base: turn and mirror
    dfilm = -np.log10(np.clip(T, 1e-4, None))
    deng = -np.log10(np.clip(dec(np.load(f'enc_{name}_{f}.npy').astype(np.float64)), 1e-4, None))
    # features on the positive-looking green density (both are negatives: density ~ scene light)
    g8 = lambda d: cv2.normalize(gaussian_filter(d[..., 1], 1.0), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    a, b = g8(deng), g8(dfilm)
    sift = cv2.SIFT_create(4000)
    ka, da = sift.detectAndCompute(a, None); kb, db = sift.detectAndCompute(b, None)
    m = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [x for x, y in m if x.distance < 0.75 * y.distance]
    H, inl = cv2.findHomography(np.float32([ka[g.queryIdx].pt for g in good]), np.float32([kb[g.trainIdx].pt for g in good]), cv2.RANSAC, 3.0)
    warped = np.stack([cv2.warpPerspective(deng[..., c].astype(np.float32), H, (b.shape[1], b.shape[0]), flags=cv2.INTER_LINEAR, borderValue=np.nan) for c in range(3)], -1)
    # compare on smoothed densities (focus / grain / small misregistration), valid overlap, away from edges
    sm = lambda d: np.stack([gaussian_filter(np.nan_to_num(d[..., c]), SIG) for c in range(3)], -1)
    valid = gaussian_filter(np.isfinite(warped[..., 1]).astype(float), SIG) > 0.999
    X, Y = sm(warped)[valid], sm(dfilm)[valid]
    np.save(f'pairs_{name}_{f}.npy', np.concatenate([X, Y], 1).astype(np.float32))
    res[f] = (X, Y)
    print(f"{f}: matches {len(good)}, inliers {int(inl.sum())}, overlap {valid.mean():.2f}")
    A = np.hstack([X, np.ones((len(X), 1))]); M, *_ = np.linalg.lstsq(A, Y, rcond=None)
    print('   film = engine @ M (rows: engine R G B, offset):', np.round(M, 3).tolist())
    for c, n in enumerate('RGB'):
        A = np.vstack([X[:, c], np.ones(len(X))]).T; (s, o), *_ = np.linalg.lstsq(A, Y[:, c], rcond=None)
        r = np.corrcoef(X[:, c], Y[:, c])[0, 1]
        print(f"   {n}: film = {o:+.3f} + {s:.3f} x engine   r {r:.3f}   engine range {np.percentile(X[:, c], [1, 99]).round(2)}  film range {np.percentile(Y[:, c], [1, 99]).round(2)}")
