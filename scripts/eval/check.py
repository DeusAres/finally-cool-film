#!/usr/bin/env python3
"""Regression check: render eval/check/cases.json through the real app (headless Chromium, scripts/eval/render.cjs), measure each
render and compare with eval/check/baseline.json. Run it before every push that touches the look or the pipeline.

    python3 scripts/eval/check.py                 # build wasm, render, compare (exit 1 on a regression)
    python3 scripts/eval/check.py --no-build      # web/pkg already built
    python3 scripts/eval/check.py --update        # accept the current renders as the new baseline
    python3 scripts/eval/check.py --compare DIR   # also pixel-compare with the PNGs of an earlier run (refactors: expect 0);
                                                  # DIR = a copy of eval/out/check made before the change (it is overwritten)
    python3 scripts/eval/check.py --chart         # also the ColorChecker score (builds sf-eval, see build-sf-eval.sh)
    python3 scripts/eval/check.py --cases cat2_interno,wall_burn

Metrics per render (sRGB PNG of the app canvas):
  bands    mean Lab a*/b* per L* band 3-20 / 20-40 / 40-60 / 60-80 / 80-101 (colour casts by tone: magenta fur, teal shadows)
  L        mean L*
  edges    "created edges": Sobel energy of the render not explained by a global tone map of the scene-linear source (posterisation,
           halos, contour lines; 0.41 when the v3.17 recovery posterised the cat, 0.05 after the fix)
  tex      median |L* - blur(L*, 1.5 px)| on the light areas (L* > 70): highlight texture
A case with "export": "export" | "exportIG" also exports (the raw decode / jpegli / border path) and measures the JPEG,
downscaled to the preview's long side, as <case>_export (no edges: other pixels than the source luma).
Outputs go to eval/out/check/ (git-ignored): <case>.png, <case>_export.jpg, metrics.json.
"""
import argparse, json, os, socket, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, sobel
from skimage import color

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'eval', 'out', 'check')
CACHE = os.path.join(ROOT, 'eval', 'out', 'cache')
BASELINE = os.path.join(ROOT, 'eval', 'check', 'baseline.json')
BANDS = ((3, 20), (20, 40), (40, 60), (60, 80), (80, 101))
# Allowed drift vs baseline (absolute): band a*/b* and mean L* in Lab units, created edges, texture.
TOL = {'band': 1.0, 'L': 1.0, 'edges': 0.05, 'tex': 0.03, 'chart': 0.15}


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def pinned(photo):
    """A copy of the photo with a fixed mtime: the app's grain seed hashes name | size | lastModified, so a fresh checkout (other
    mtimes) would otherwise render a different grain and no two runs could be compared pixel for pixel."""
    d = os.path.join(CACHE, 'photos')
    os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, os.path.basename(photo))
    src = os.path.join(ROOT, photo)
    if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
        with open(src, 'rb') as f, open(dst, 'wb') as g:
            g.write(f.read())
    os.utime(dst, (1_700_000_000, 1_700_000_000))
    return dst


def render(port, photo, ui, out_png, query='', export=None):
    if export:
        ui = dict(ui, _export=out_png[:-4] + '_export.jpg', _exportBtn=export)
    r = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'eval', 'render.cjs'), f'http://127.0.0.1:{port}/index.html{query}',
                        pinned(photo), out_png, json.dumps(ui)], capture_output=True, text=True)
    line = next((l for l in (r.stdout + r.stderr).splitlines() if l.startswith(('OK', 'ERR'))), 'ERR no output')
    return line


def source_luma(photo):
    """log2 scene luma of the photo at the app's preview size (eval/dng2npy.mjs, cached); None if unavailable."""
    os.makedirs(CACHE, exist_ok=True)
    npy = os.path.join(CACHE, os.path.basename(photo) + '.npy')
    if not os.path.exists(npy):
        r = subprocess.run(['node', os.path.join(ROOT, 'eval', 'dng2npy.mjs'), os.path.join(ROOT, photo), npy, '2000'],
                           capture_output=True, text=True, cwd=ROOT)
        if r.returncode or not os.path.exists(npy):
            return None
    x = np.load(npy).astype(np.float64)
    return np.log2(np.maximum(x @ [0.2627, 0.6780, 0.0593], 1e-6))


PREVIEW_LONG_SIDE = 2000   # web/lib/util.js: exports are measured at the preview's size


def measure(png, Ls):
    im = Image.open(png).convert('RGB')
    im.thumbnail((PREVIEW_LONG_SIDE, PREVIEW_LONG_SIDE), Image.LANCZOS)   # a no-op for the preview renders
    lab = color.rgb2lab(np.asarray(im) / 255.0)
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    m = {'L': round(float(L.mean()), 2), 'bands': {}}
    for lo, hi in BANDS:
        k = (L >= lo) & (L < hi)
        m['bands'][f'{lo}-{hi}'] = [round(float(a[k].mean()), 2), round(float(b[k].mean()), 2), round(float(k.mean()), 3)] if k.mean() > 0.005 else None
    lit = L > 70
    m['tex'] = round(float(np.median(np.abs(L - gaussian_filter(L, 1.5))[lit])), 3) if lit.mean() > 0.005 else None
    m['edges'] = None
    if Ls is not None and Ls.shape == L.shape:
        bins = np.clip(((Ls - Ls.min()) / (Ls.max() - Ls.min()) * 400).astype(int), 0, 399)
        sums, cnt = np.bincount(bins.ravel(), L.ravel(), 400), np.bincount(bins.ravel(), minlength=400)
        F = gaussian_filter((sums / np.maximum(cnt, 1))[bins], 1.0)   # the render's global tone map of the source (bin means)
        R = gaussian_filter(L, 1.0)
        g = lambda z: np.hypot(sobel(z, 0), sobel(z, 1))
        m['edges'] = round(float(np.maximum(g(R) - 1.5 * g(F) - 2.0, 0).mean()), 3)
    return m


def chart_score():
    lib = subprocess.run([os.path.join(ROOT, 'scripts', 'eval', 'build-sf-eval.sh')], capture_output=True, text=True, check=True).stdout.strip()
    env = dict(os.environ, LD_LIBRARY_PATH=lib)
    out = os.path.join(OUT, 'chart')
    subprocess.run([os.path.join(ROOT, 'engine', 'target', 'release', 'sf-eval'), 'chart', '--params', os.path.join(ROOT, 'eval', 'calib', 'look_v3.22.json'),
                    '--out', out, '--spec', os.path.join(ROOT, 'eval', 'gold200_spec.json'), '--data', os.path.join(ROOT, 'web', 'data')],
                   env=env, capture_output=True, check=True)
    return round(json.load(open(os.path.join(out, 'report.json')))['score'], 2)


def diffs(case, cur, base):
    """List of human-readable regressions of `cur` vs `base` for one case."""
    out = []
    if abs(cur['L'] - base['L']) > TOL['L']:
        out.append(f"L {base['L']} -> {cur['L']}")
    for band, v in cur['bands'].items():
        w = base['bands'].get(band)
        if v and w and (abs(v[0] - w[0]) > TOL['band'] or abs(v[1] - w[1]) > TOL['band']):
            out.append(f"L*{band} a/b {w[0]:+.1f}/{w[1]:+.1f} -> {v[0]:+.1f}/{v[1]:+.1f}")
    for k in ('edges', 'tex'):
        if cur.get(k) is not None and base.get(k) is not None and abs(cur[k] - base[k]) > TOL[k]:
            out.append(f"{k} {base[k]} -> {cur[k]}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--update', action='store_true')
    ap.add_argument('--compare')
    ap.add_argument('--chart', action='store_true')
    ap.add_argument('--cases')
    ap.add_argument('--jobs', type=int, default=2)
    a = ap.parse_args()

    cases = json.load(open(os.path.join(ROOT, 'eval', 'check', 'cases.json')))['cases']
    if a.cases:
        cases = {k: v for k, v in cases.items() if k in a.cases.split(',')}
    os.makedirs(OUT, exist_ok=True)
    if not a.no_build:
        subprocess.run([os.path.join(ROOT, 'scripts', 'build-web.sh')], check=True, capture_output=True)

    port = free_port()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', '-d', os.path.join(ROOT, 'web'), '--bind', '127.0.0.1', str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        t0 = time.time()
        with ThreadPoolExecutor(a.jobs) as ex:
            res = dict(zip(cases, ex.map(lambda kv: render(port, kv[1]['photo'], kv[1]['ui'], os.path.join(OUT, kv[0] + '.png'), kv[1].get('query', ''), kv[1].get('export')), cases.items())))
        print(f'renders: {len(cases)} in {time.time() - t0:.0f} s')
    finally:
        srv.terminate()

    luma = {}
    metrics, bad = {}, []
    for k, c in cases.items():
        if not res[k].startswith('OK'):
            bad.append(f'{k}: {res[k]}')
            continue
        if c['photo'] not in luma:
            luma[c['photo']] = source_luma(c['photo'])
        metrics[k] = measure(os.path.join(OUT, k + '.png'), luma[c['photo']])
        if c.get('export'):
            metrics[k + '_export'] = measure(os.path.join(OUT, k + '_export.jpg'), None)
    if a.chart:
        metrics['_chart'] = chart_score()
    json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w'), indent=1)

    base = json.load(open(BASELINE)) if os.path.exists(BASELINE) else {}
    for k, m in metrics.items():
        if k == '_chart':
            if '_chart' in base and abs(m - base['_chart']) > TOL['chart']:
                bad.append(f"chart score {base['_chart']} -> {m}")
            print(f'{k:18s} score {m}')
            continue
        d = diffs(k, m, base[k]) if k in base else ['(no baseline)']
        b = ' '.join(f"{v[0]:+.1f}/{v[1]:+.1f}" if v else '  -  ' for v in m['bands'].values())
        print(f"{k:18s} L {m['L']:5.1f} edges {m['edges']} tex {m['tex']} | a/b by tone {b}" + (' | ' + '; '.join(d) if d else ''))
        if d and k in base:
            bad.append(f"{k}: {'; '.join(d)}")
    if a.compare:
        for k in metrics:
            p, q = os.path.join(OUT, k + '.png'), os.path.join(a.compare, k + '.png')
            if k != '_chart' and os.path.exists(q):
                x, y = np.asarray(Image.open(p)).astype(int), np.asarray(Image.open(q)).astype(int)
                dm = int(np.abs(x - y).max()) if x.shape == y.shape else -1
                print(f'pixels {k:18s} max diff {dm}')
                if dm:
                    bad.append(f'{k}: pixels differ from {a.compare} (max {dm})')

    if a.update:
        base.update(metrics)
        json.dump(base, open(BASELINE, 'w'), indent=1, sort_keys=True)
        print(f'baseline updated: {BASELINE}')
        return 0
    if bad:
        print('\nREGRESSIONS / ERRORS:\n  ' + '\n  '.join(bad))
        return 1
    print('\nOK: no regression')
    return 0


if __name__ == '__main__':
    sys.exit(main())
