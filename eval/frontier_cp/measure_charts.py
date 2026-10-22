# Sample Kodak 20-step gray scale + SpyderCheckr24 patches on Color Precision chart scans.
# Patch coordinates were read off Charts/Gold-0EV-Frontier.png (reference); usage: python3 -I measure_charts.py REF.png FRAMES... > charts_measure.json
# every other image is registered to that reference with ECC (affine, on gradient magnitude).
import sys, json, glob, os, numpy as np, cv2
REF = sys.argv[1]; files = sys.argv[2:]
KODAK = [(425 + 43*i, 1597) for i in range(20)]            # step centres, A(=0)..19
SPY_X = [2425, 2550, 2675, 2797]; SPY_Y = [465, 590, 717, 845, 970, 1095]
SPY = [(x, y) for y in SPY_Y for x in SPY_X]                 # row-major: E1 F1 G1 H1, E2 ...
def lin(c): c = c/255.0; return np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
M = np.array([[0.4124564,0.3575761,0.1804375],[0.2126729,0.7151522,0.0721750],[0.0193339,0.1191920,0.9503041]])
WP = np.array([0.95047, 1.0, 1.08883])
def lab(rgb8):
    xyz = M @ lin(np.asarray(rgb8, float)); t = xyz/WP
    f = np.where(t > (6/29)**3, np.cbrt(t), t/(3*(6/29)**2) + 4/29)
    return [116*f[1]-16, 500*(f[0]-f[1]), 200*(f[1]-f[2])]
def grad(x):
    gx = cv2.Sobel(x, cv2.CV_32F, 1, 0); gy = cv2.Sobel(x, cv2.CV_32F, 0, 1); return np.sqrt(gx*gx+gy*gy)
def small(im, s=0.25):
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32)/255
    return grad(cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA))
ref = cv2.imread(REF); gref = small(ref)
out = {}
for f in files:
    im = cv2.imread(f); g = small(im)
    h = max(g.shape[0], gref.shape[0]); w = max(g.shape[1], gref.shape[1])
    A = np.zeros((h, w), np.float32); A[:gref.shape[0], :gref.shape[1]] = gref
    B = np.zeros((h, w), np.float32); B[:g.shape[0], :g.shape[1]] = g
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        cc, warp = cv2.findTransformECC(A, B, warp, cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-6), None, 5)
    except cv2.error: cc = float('nan')
    warp[:, 2] *= 4   # warp maps ref coords -> this image coords
    def samp(x, y, r):
        X, Y = warp @ np.array([x, y, 1.0]); X, Y = int(round(X)), int(round(Y))
        p = im[Y-r:Y+r, X-r:X+r, ::-1].reshape(-1, 3).astype(float)
        return p.mean(0).tolist(), p.std(0).mean()
    k = [samp(x, y, 12) for x, y in KODAK]; s = [samp(x, y, 28) for x, y in SPY]
    out[os.path.basename(os.path.dirname(f)) + '/' + os.path.basename(f)] = {
        'ecc': float(cc),
        'kodak_rgb': [v for v, _ in k], 'kodak_lab': [lab(v) for v, _ in k],
        'spy_rgb': [v for v, _ in s], 'spy_lab': [lab(v) for v, _ in s]}
json.dump(out, sys.stdout, indent=0)
