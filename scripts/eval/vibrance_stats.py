#!/usr/bin/env python3
"""Vividezza check: compare renders of the same case at Vividezza 0 and > 0 (PNGs from scripts/eval/render.cjs: Display P3 primaries,
sRGB transfer, as the app's canvas) against the Kodak Gold 200 chroma ceiling (kg200_chroma_ceiling.py, the same table as lens-gpu.js).

    python3 scripts/eval/vibrance_stats.py REF.png TEST.png [TEST2.png ...]

Per image (OkLCh after the same 1.5 px blur, pixels with L 0.15-0.97 and no clipped channel, as the ceiling was measured on the scans):
  C       mean chroma
  >ceil   % of pixels whose chroma exceeds the ceiling of their hue (the scans' own p99, so ~1 % is the scans' level)
  skin dh mean signed / mean |hue shift| (deg) vs REF on the pixels in the skin band (OkLCh 25-48 deg, C > 0.02) of REF
  skin dC mean chroma change on them
  grey    pixels with C < 0.015 in REF: mean C in REF -> TEST, and the % of them that got C > 0.03 (a cast)
  dL      mean |L change| (luminance kept: ~0 up to film / grain differences)
"""
import os, sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from kg200_chroma_ceiling import ceil_at, load_render  # noqa: E402


def table(name):
    """A constant array of web/lib/lens-gpu.js (VIB_CEIL, VIB_FILM)."""
    src = open(os.path.join(os.path.dirname(__file__), '..', '..', 'web', 'lib', 'lens-gpu.js')).read()
    s = src[src.index(f'export const {name} = [') + len(name) + 17:]
    return np.array([float(v) for v in s[:s.index(']')].split(',')])


def ceiling_table():
    return table('VIB_CEIL')


load = load_render


def stats(ref, test, tab):
    L0, C0, h0, ok0 = ref
    L, C, h, ok = test
    m = ok & ok0
    over = (C > ceil_at(h, tab)) & ok
    skin = m & (h0 >= 25) & (h0 <= 48) & (C0 > 0.02)
    dh = (h - h0 + 180) % 360 - 180
    grey = m & (C0 < 0.015)
    return {'C': C[ok].mean(), 'over': 100 * over.sum() / ok.sum(), 'skin_dh': dh[skin].mean(), 'skin_adh': np.abs(dh[skin]).mean(),
            'skin_dC': (C - C0)[skin].mean(), 'skin_px': 100 * skin.mean(), 'grey_C0': C0[grey].mean(), 'grey_C': C[grey].mean(),
            'grey_cast': 100 * (C[grey] > 0.03).mean(), 'dL': np.abs(L - L0)[m].mean()}


def main():
    tab = ceiling_table()
    ref = load(sys.argv[1])
    print(f"{'image':40s} {'C':>7s} {'>ceil%':>7s} {'skin dh':>8s} {'|dh|':>6s} {'skin dC':>8s} {'grey C0->C':>13s} {'cast%':>6s} {'|dL|':>6s}")
    for p in sys.argv[1:]:
        s = stats(ref, ref if p == sys.argv[1] else load(p), tab)
        print(f"{os.path.basename(os.path.dirname(p)) + '/' + os.path.basename(p):40s} {s['C']:7.4f} {s['over']:7.2f} {s['skin_dh']:+8.2f} "
              f"{s['skin_adh']:6.2f} {s['skin_dC']:+8.4f} {s['grey_C0']:.4f}->{s['grey_C']:.4f} {s['grey_cast']:6.2f} {s['dL']:6.4f}")


if __name__ == '__main__':
    main()
