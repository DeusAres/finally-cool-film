#!/usr/bin/env python3
"""Grain statistics of photos (real scans or app exports), measured on their flat areas, to calibrate the grain against
real Kodak Gold 200 scans (samples/kg200).

    python3 scripts/eval/grainstats.py [--um-px X | --frame-mm 36] img.jpg ...

Per image, on 32x32 patches whose local structure is flat (smoothed gradient in the lowest 25 %), the high-pass residual
(image - gaussian(4 px)) gives:
  L std     grain strength in L* units, per L* band of the patch (10-30 / 30-50 / 50-70 / 70-90)
  C/L       chroma grain (a*, b* residual std) over luma grain: how coloured the grain is
  r50 um    clump size: lag (in um on the frame) where the radial autocorrelation of the L residual falls to 0.5
Pixel pitch: --um-px, or the frame's long side (default 36 mm) over the image's long side (lab scans are full frames).
"""
import argparse, os, sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, sobel
from skimage import color

BANDS = ((10, 30), (30, 50), (50, 70), (70, 90))
P = 32


def acf_r50(res):
    """Lag (px) where the mean radial autocorrelation of residual patches falls to 0.5 (linear interpolation)."""
    f = np.fft.fft2(res - res.mean(axis=(1, 2), keepdims=True))
    ac = np.fft.ifft2(np.abs(f) ** 2).real.mean(0)
    ac /= ac[0, 0]
    r = [1.0] + [0.5 * (ac[0, k] + ac[k, 0]) for k in range(1, 6)]
    for k in range(1, len(r)):
        if r[k] < 0.5:
            return k - 1 + (r[k - 1] - 0.5) / (r[k - 1] - r[k])
    return float(len(r))


def stats(path, um_px):
    rgb = np.asarray(Image.open(path).convert('RGB')) / 255.0
    lab = color.rgb2lab(rgb)
    hp = lab - np.stack([gaussian_filter(lab[..., c], 4) for c in range(3)], -1)
    Ls = gaussian_filter(lab[..., 0], 6)
    g = gaussian_filter(np.hypot(sobel(Ls, 0), sobel(Ls, 1)), 6)
    H, W = Ls.shape
    rows = []
    for y in range(0, H - P, P):
        for x in range(0, W - P, P):
            rows.append((g[y:y + P, x:x + P].mean(), y, x, Ls[y:y + P, x:x + P].mean()))
    rows = np.array(rows)
    flat = rows[rows[:, 0] <= np.percentile(rows[:, 0], 25)]
    out = {'file': os.path.basename(path), 'um_px': round(um_px, 2), 'bands': {}}
    allres = []
    for lo, hi in BANDS:
        sel = flat[(flat[:, 3] >= lo) & (flat[:, 3] < hi)]
        if len(sel) < 6:
            out['bands'][f'{lo}-{hi}'] = None
            continue
        res = np.stack([hp[int(y):int(y) + P, int(x):int(x) + P] for _, y, x, _ in sel])
        sl = res[..., 0].std(axis=(1, 2)).mean()
        sc = np.hypot(res[..., 1].std(axis=(1, 2)), res[..., 2].std(axis=(1, 2))).mean()
        out['bands'][f'{lo}-{hi}'] = (round(float(sl), 2), round(float(sc / max(sl, 1e-6)), 2), len(sel))
        allres.append(res[..., 0])
    out['r50_um'] = round(acf_r50(np.concatenate(allres)) * um_px, 1) if allres else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('imgs', nargs='+')
    ap.add_argument('--um-px', type=float)
    ap.add_argument('--frame-mm', type=float, default=36.0)
    a = ap.parse_args()
    for p in a.imgs:
        w, h = Image.open(p).size
        um = a.um_px or a.frame_mm * 1000 / max(w, h)
        s = stats(p, um)
        b = ' | '.join(f"L{k} std {v[0]:.2f} C/L {v[1]:.2f} n{v[2]}" if v else f'L{k} -' for k, v in s['bands'].items())
        print(f"{s['file']:22s} {s['um_px']:5.1f} um/px  r50 {s['r50_um']} um | {b}")


if __name__ == '__main__':
    sys.exit(main())
