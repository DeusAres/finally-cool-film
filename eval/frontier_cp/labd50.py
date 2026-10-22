"""sRGB / BT.2020 <-> CIELAB D50 (Bradford), as spektrafilm-eval color.rs."""
import numpy as np
SRGB = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
BT2020 = np.array([[0.6369580, 0.1446169, 0.1688810], [0.2627002, 0.6779981, 0.0593017], [0.0, 0.0280727, 1.0609851]])
BFD = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])
D65 = np.array([0.95047, 1.0, 1.08883]); D50 = np.array([0.96422, 1.0, 0.82521])
def _cat(src, dst):
    a, b = BFD @ src, BFD @ dst
    return np.linalg.inv(BFD) @ np.diag(b / a) @ BFD
CAT_65_50, CAT_50_65 = _cat(D65, D50), _cat(D50, D65)
def dec(c): c = np.asarray(c, float); return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def enc(c): c = np.clip(np.asarray(c, float), 0, None); return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)
def xyz2lab(xyz, wp=D50):
    t = np.asarray(xyz, float) / wp
    f = np.where(t > (6 / 29) ** 3, np.cbrt(t), t / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)
def lab2xyz(lab, wp=D50):
    lab = np.asarray(lab, float); fy = (lab[..., 0] + 16) / 116; fx = fy + lab[..., 1] / 500; fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1)
    return wp * np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29))
def lin2lab(rgb, M=SRGB): return xyz2lab(np.asarray(rgb, float) @ (CAT_65_50 @ M).T)
def enc2lab(rgb8_or_1, M=SRGB, scale=255.0): return lin2lab(dec(np.asarray(rgb8_or_1, float) / scale), M)
def lab2lin(lab, M=BT2020): return lab2xyz(lab) @ (np.linalg.inv(M) @ CAT_50_65).T
def de76(a, b): return np.linalg.norm(np.asarray(a) - np.asarray(b), axis=-1)
