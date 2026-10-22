"""Sample the ColorChecker SG (140) and the Kodak grey scale (20) on the Color Precision chart scans.
Grid corners read off Gold-0EV-Frontier.png (sg_check.jpg shows the boxes); other frames ECC-registered to it."""
import sys, json, os, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labd50 import enc2lab
A1, N1, A10, N10 = np.array([323, 622]), np.array([1308, 610]), np.array([325, 1297]), np.array([1313, 1290])
def sg_xy(col, row):   # col 0..13 (A..N), row 0..9
    u, v = col / 13, row / 9
    return (1 - u) * (1 - v) * A1 + u * (1 - v) * N1 + (1 - u) * v * A10 + u * v * N10
NAMES = [f"{'ABCDEFGHIJKLMN'[c]}{r + 1}" for c in range(14) for r in range(10)]
SG = [sg_xy(c, r) for c in range(14) for r in range(10)]
KODAK = [np.array([425 + 43 * i, 1597]) for i in range(20)]
def grad(x):
    gx = cv2.Sobel(x, cv2.CV_32F, 1, 0); gy = cv2.Sobel(x, cv2.CV_32F, 0, 1); return np.sqrt(gx * gx + gy * gy)
def small(im, s=0.25):
    return grad(cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255, None, fx=s, fy=s, interpolation=cv2.INTER_AREA))
ref = cv2.imread(sys.argv[1]); gref = small(ref)
if '--check' in sys.argv:
    v = ref.copy()
    for p in SG + KODAK: x, y = map(int, p); cv2.rectangle(v, (x - 14, y - 14), (x + 14, y + 14), (0, 255, 0), 2)
    cv2.imwrite('sg_check.jpg', v[400:1700, 100:1500]); sys.exit()
out = {}
for f in sys.argv[2:]:
    im = cv2.imread(f); g = small(im)
    h, w = max(g.shape[0], gref.shape[0]), max(g.shape[1], gref.shape[1])
    Aa = np.zeros((h, w), np.float32); Aa[:gref.shape[0], :gref.shape[1]] = gref
    Bb = np.zeros((h, w), np.float32); Bb[:g.shape[0], :g.shape[1]] = g
    warp = np.eye(2, 3, dtype=np.float32)
    cc, warp = cv2.findTransformECC(Aa, Bb, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-6), None, 5)
    warp[:, 2] *= 4
    def samp(p, r):
        X, Y = (warp @ np.array([p[0], p[1], 1.0])).round().astype(int)
        return im[Y - r:Y + r, X - r:X + r, ::-1].reshape(-1, 3).astype(float).mean(0)
    sg = np.array([samp(p, 14) for p in SG]); kd = np.array([samp(p, 12) for p in KODAK])
    out[os.path.basename(f)[:-4]] = {'ecc': float(cc), 'sg_rgb': sg.tolist(), 'sg_lab': enc2lab(sg).tolist(), 'kodak_rgb': kd.tolist(), 'kodak_lab': enc2lab(kd).tolist()}
json.dump({'names': NAMES, 'frames': out}, sys.stdout)
