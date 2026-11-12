#!/usr/bin/env python3
"""Area check: the grain. A flat wedge (two rows of 8 uniform patches: a grey ramp and a green ramp, generated here, fixed mtime
for a fixed grain seed) rendered by the app (headless, scripts/eval/render.cjs) with Nessuno and with the Frontier; per patch the
grainstats.py measures at the preview pitch: L std of the high-pass residual (strength), C std (colour), r50 (clump size, px),
fine share (std of the 1 px residual / the 4 px one). Compared with eval/check/grain_baseline.json: a grain change shows here in
~1 min, without the full photo set.
    python3 scripts/eval/areas/grain.py [--update]"""
import json, os, socket, subprocess, sys, functools, http.server, threading
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from skimage import color
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'eval'))
from grainstats import acf_r50, P
BASE = os.path.join(ROOT, 'eval', 'check', 'grain_baseline.json')
OUT = os.path.join(ROOT, 'eval', 'out', 'areas')
W, H, COLS = 2000, 1500, 8
# the wedge's patches (sRGB 8-bit): a grey ramp (the tones the grain was fitted by) and a green ramp (grass, foliage)
GREYS = [[v, v, v] for v in (28, 50, 75, 100, 128, 160, 195, 225)]
GREENS = [[int(v * 0.55), v, int(v * 0.35)] for v in (40, 70, 100, 130, 160, 190, 215, 240)]
SCANNERS = {'nessuno': {}, 'frontier': {'_click': ['scanFrontier']}}
# a metric moves "beyond the tolerance" when it differs from the baseline by more than this share (the render is deterministic:
# the same code gives the same pixels, so any real change shows; 2 % keeps float noise across Chromium builds out, a choice)
TOL = 0.02

def wedge(path):
    a = np.zeros((H, W, 3), np.uint8)
    for r, row in enumerate((GREYS, GREENS)):
        for i, c in enumerate(row):
            a[r * H // 2:(r + 1) * H // 2, i * W // COLS:(i + 1) * W // COLS] = c
    Image.fromarray(a).save(path, quality=98, subsampling=0)
    os.utime(path, (1_700_000_000, 1_700_000_000))

def measure(png):
    lab = color.rgb2lab(np.asarray(Image.open(png).convert('RGB')) / 255.0)
    hp = lab - np.stack([gaussian_filter(lab[..., c], 4) for c in range(3)], -1)
    hp1 = lab - np.stack([gaussian_filter(lab[..., c], 1) for c in range(3)], -1)
    h, w = lab.shape[:2]; out = []
    for r in range(2):
        for i in range(COLS):
            y0, y1, x0, x1 = r * h // 2 + 16, (r + 1) * h // 2 - 16, i * w // COLS + 16, (i + 1) * w // COLS - 16
            ps = [(y, x) for y in range(y0, y1 - P, P) for x in range(x0, x1 - P, P)]
            res = np.stack([hp[y:y + P, x:x + P] for y, x in ps]); r1 = np.stack([hp1[y:y + P, x:x + P] for y, x in ps])
            out.append({'L': round(float(lab[y0:y1, x0:x1, 0].mean()), 2),
                        'Lstd': round(float(np.median(res[..., 0].std(axis=(1, 2)))), 4),
                        'Cstd': round(float(np.median(np.hypot(res[..., 1].std(axis=(1, 2)), res[..., 2].std(axis=(1, 2))))), 4),
                        'r50': round(float(acf_r50(res[..., 0])), 4),
                        'fine': round(float(np.median(r1[..., 0].std(axis=(1, 2)) / res[..., 0].std(axis=(1, 2)))), 4)})
    return out

def main():
    update = '--update' in sys.argv
    os.makedirs(OUT, exist_ok=True)
    src = os.path.join(OUT, 'grain_wedge.jpg'); wedge(src)
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'web')))
    srv.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    got = {}
    for name, ui in SCANNERS.items():
        png = os.path.join(OUT, f'grain_{name}.png')
        r = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'eval', 'render.cjs'), f'http://127.0.0.1:{port}/index.html', src, png, json.dumps(ui)],
                           capture_output=True, text=True)
        if not os.path.exists(png) or 'OK' not in r.stdout + r.stderr:
            print(f'{name}: render failed\n{(r.stdout + r.stderr)[-800:]}'); sys.exit(2)
        got[name] = measure(png)
    srv.shutdown()
    if update or not os.path.exists(BASE):
        json.dump(got, open(BASE, 'w'), indent=1); print(f'grain: baseline written ({BASE})'); return
    base, bad = json.load(open(BASE)), 0
    for name, rows in got.items():
        for k, (g, b) in enumerate(zip(rows, base[name])):
            for m in ('Lstd', 'Cstd', 'r50', 'fine'):
                if abs(g[m] - b[m]) > TOL * max(abs(b[m]), 1e-6):
                    bad += 1; print(f'  {name} patch {k} (L {b["L"]:.0f}) {m}: {b[m]} -> {g[m]} ({(g[m] / b[m] - 1) * 100:+.1f} %)')
    print(f'grain: {"OK" if not bad else f"{bad} metric(s) moved"} ({sum(len(r) for r in got.values())} patches, Nessuno + Frontier)')
    sys.exit(1 if bad else 0)

main()
