#!/usr/bin/env python3
"""Kodak Gold 200 chroma ceiling per hue, measured on the real scans in samples/kg200/ (the Vividezza / vibrance slider's limit,
web/lib/lens-gpu.js VIB_CEIL).

    python3 scripts/eval/kg200_chroma_ceiling.py            # print the table (+ the JS array to paste into lens-gpu.js)
    python3 scripts/eval/kg200_chroma_ceiling.py --json OUT # also write the per-bin stats
    python3 scripts/eval/kg200_chroma_ceiling.py --film SCENE.npy:RENDER.png:EV [...]   # + the film transfer table VIB_FILM

Method (reproducible, no free parameters beyond the constants below):
  1. every JPEG in samples/kg200 (untagged = sRGB) -> linear sRGB, a light Gaussian blur (BLUR_PX on the full scan) so the
     statistic is the colour of areas, not of single grain / JPEG chroma specks;
  2. pixels kept: Oklab L in [L_MIN, L_MAX] and no channel clipped (8-bit 2..253): clipped channels have a wrong hue / chroma;
  3. OkLCh hue in BINS bins of 360 / BINS deg; per bin the PCT percentile of chroma C (all scans pooled);
  4. bins with fewer than MIN_PX pixels are filled by circular linear interpolation from the nearest reliable bins;
  5. circular smoothing ([1 2 1] / 4, SMOOTH passes): the ceiling is the smoothed percentile, so one odd bin cannot open a spike
     or a notch (the table is read with linear interpolation between bin centres 5, 15, ... 355 deg).
The ceiling is measured on final scans (film + Frontier scanner, display sRGB) but the slider applies it to the scene before the film.
The film does not keep chroma: Gold 200 + the Frontier lift warm / green chroma ~1.5x and leave blues ~1x (measured below), so a
scene pushed to the scans' ceiling came out up to 1.5x above it. --film measures that transfer on the app's own renders at Vividezza 0
(check.py cases, default sliders): for each chromatic pixel, the scene chroma that would come out exactly at the ceiling is
C_scene x ceiling(h_out) / C_out (locally linear transfer); per SCENE hue bin its FILM_PCT percentile / the scan ceiling, capped at 1
(the scene limit is never above the scans' own), filled and smoothed as above = VIB_FILM. The slider limits the scene to
VIB_CEIL x VIB_FILM. Inputs per render: SCENE.npy = eval/dng2npy.mjs of the DNG at the preview size (linear Rec.2020, no baseline),
RENDER.png = render.cjs output (Display P3), EV = the scene exposure the app used (auto Esposizione + DNG baseline: the app's log line
"auto: ev X" plus the baseline in the .json next to the npy). Still an approximation (exposure, scanner settings and the scene itself
move the transfer); check the output with scripts/eval/vibrance_stats.py.
"""
import argparse, glob, json, os

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BINS, PCT, BLUR_PX, L_MIN, L_MAX, MIN_PX, SMOOTH = 36, 99.0, 1.5, 0.15, 0.97, 2000, 2
FILM_PCT, FILM_MIN_PX = 25.0, 2000   # --film: a low percentile of the transfer = the stronger film gains count


def srgb_to_linear(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


# Björn Ottosson's Oklab (linear sRGB -> LMS -> cube root -> Lab).
M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
               [0.2119034982, 0.6806995451, 0.1073969566],
               [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
               [1.9779984951, -2.4285922050, 0.4505937099],
               [0.0259040371, 0.7827717662, -0.8086757660]])


def rgb_to_xyz(prim, w=(0.3127, 0.3290)):
    """Linear RGB -> XYZ of a D65 space from its xy primaries (as web/lib/color.js)."""
    P = np.array([[x / y, 1, (1 - x - y) / y] for x, y in prim]).T
    W = np.array([w[0] / w[1], 1, (1 - w[0] - w[1]) / w[1]])
    return P * np.linalg.solve(P, W)


SRGB_XY, P3_XY, REC2020_XY = [(0.64, 0.33), (0.30, 0.60), (0.15, 0.06)], [(0.68, 0.32), (0.265, 0.69), (0.15, 0.06)], [(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)]
P3_TO_SRGB = np.linalg.inv(rgb_to_xyz(SRGB_XY)) @ rgb_to_xyz(P3_XY)
REC2020_TO_SRGB = np.linalg.inv(rgb_to_xyz(SRGB_XY)) @ rgb_to_xyz(REC2020_XY)


def oklab(lin):
    return np.cbrt(lin @ M1.T) @ M2.T


def lch(lin):
    lab = oklab(lin)
    return lab[..., 0], np.hypot(lab[..., 1], lab[..., 2]), np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360


def measure(files):
    per_bin = [[] for _ in range(BINS)]
    for f in files:
        rgb8 = np.asarray(Image.open(f).convert('RGB'))
        ok = np.all((rgb8 >= 2) & (rgb8 <= 253), axis=-1)
        lin = srgb_to_linear(rgb8 / 255.0)
        lin = np.stack([gaussian_filter(lin[..., k], BLUR_PX) for k in range(3)], -1)
        L, C, h = lch(lin)
        k = ok & (L >= L_MIN) & (L <= L_MAX)
        b = (h[k] / (360 / BINS)).astype(int) % BINS
        for i in range(BINS):
            per_bin[i].append(C[k][b == i].astype(np.float32))
    per_bin = [np.concatenate(v) for v in per_bin]
    n = np.array([len(v) for v in per_bin])
    raw = np.array([np.percentile(v, PCT) if len(v) else np.nan for v in per_bin])
    p50 = np.array([np.median(v) if len(v) else np.nan for v in per_bin])
    return n, raw, p50, fill_smooth(raw, n >= MIN_PX)


def fill_smooth(raw, good):
    """Circular linear interpolation over the unreliable bins, then SMOOTH passes of [1 2 1] / 4."""
    x = np.arange(BINS)
    v = raw.copy()
    if not good.all():
        xs, ys = x[good], raw[good]
        v[~good] = np.interp(x[~good], np.r_[xs - BINS, xs, xs + BINS], np.r_[ys, ys, ys])
    for _ in range(SMOOTH):
        v = 0.25 * np.roll(v, 1) + 0.5 * v + 0.25 * np.roll(v, -1)
    return v


def ceil_at(h, tab):
    """Table read as the shader does: linear between bin centres."""
    x = h / (360 / BINS) - 0.5; i0 = np.floor(x).astype(int) % BINS; f = x - np.floor(x)
    return tab[i0] * (1 - f) + tab[(i0 + 1) % BINS] * f


def load_render(png):
    """OkLCh of a render.cjs PNG (Display P3 primaries, sRGB transfer) + mask of usable pixels, measured as the scans (same blur:
    the colour of areas, not of single grain specks)."""
    rgb8 = np.asarray(Image.open(png).convert('RGB'))
    lin = srgb_to_linear(rgb8 / 255.0) @ P3_TO_SRGB.T
    L, C, h = lch(np.stack([gaussian_filter(lin[..., k], BLUR_PX) for k in range(3)], -1))
    return L, C, h, np.all((rgb8 >= 2) & (rgb8 <= 253), axis=-1) & (L >= L_MIN) & (L <= L_MAX)


def film_transfer(specs, ceil):
    need = [[] for _ in range(BINS)]
    for spec in specs:
        npy, png, ev = spec.rsplit(':', 2)
        Ls, Cs, hs = lch(np.maximum(np.load(npy).astype(np.float64) * 2 ** float(ev), 0) @ REC2020_TO_SRGB.T)
        L, C, h, ok = load_render(png)
        k = ok & (C > 0.03) & (Cs > 0.02) & (Ls > 0.25) & (Ls < 1.0)   # chromatic, not in the toe / above white
        r = (Cs * ceil_at(h, ceil) / C)[k]
        b = (hs[k] / (360 / BINS)).astype(int) % BINS
        for i in range(BINS):
            need[i].append(r[b == i])
    need = [np.concatenate(v) for v in need]
    n = np.array([len(v) for v in need])
    raw = np.array([min(1.0, np.percentile(v, FILM_PCT) / ceil[i]) if len(v) >= FILM_MIN_PX else np.nan for i, v in enumerate(need)])
    return n, raw, np.minimum(fill_smooth(raw, n >= FILM_MIN_PX), 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json')
    ap.add_argument('--film', nargs='+', metavar='SCENE.npy:RENDER.png:EV')
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(ROOT, 'samples', 'kg200', '*.jp*g')))
    n, raw, p50, ceil = measure(files)
    print(f'{len(files)} scans, {n.sum()} px; OkLCh chroma p{PCT:g} per {360 // BINS} deg hue bin (blur {BLUR_PX} px, L {L_MIN}-{L_MAX})')
    print(' hue     n      p50    p99raw  ceiling')
    for i in range(BINS):
        print(f'{i * 360 // BINS:4d}  {n[i]:8d}  {p50[i]:.4f}  {raw[i]:.4f}  {ceil[i]:.4f}' + ('' if n[i] >= MIN_PX else '  (filled)'))
    print('\nconst VIB_CEIL = [' + ', '.join(f'{v:.4f}' for v in ceil) + '];')
    out = {'files': [os.path.basename(f) for f in files], 'bins': BINS, 'pct': PCT, 'n': n.tolist(),
           'p50': p50.tolist(), 'p99_raw': raw.tolist(), 'ceiling': ceil.tolist()}
    if a.film:
        fn, fraw, film = film_transfer(a.film, ceil)
        print(f'\nfilm transfer ({len(a.film)} renders): scene hue, n px, raw factor (p{FILM_PCT:g}, cap 1), VIB_FILM')
        for i in range(BINS):
            print(f'{i * 360 // BINS:4d}  {fn[i]:8d}  ' + (f'{fraw[i]:.3f}' if fn[i] >= FILM_MIN_PX else '  -  ') + f'  {film[i]:.3f}')
        print('\nconst VIB_FILM = [' + ', '.join(f'{v:.3f}' for v in film) + '];')
        out.update({'film_inputs': a.film, 'film_n': fn.tolist(), 'film_raw': fraw.tolist(), 'film': film.tolist()})
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
