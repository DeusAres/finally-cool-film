"""v4 against real Gold 200: the gold200 dataset's digital captures through the app (?v4) next to the same scenes' film,
both inverted by the same neutral inversion (web/lib/invert.js). See README.md.

    python3 eval/gold200/compare.py WORK_DIR      # WORK_DIR: frame<NN>.dng (arw2dng.py) and T<NN>.npy (film_scan.py)

Prints chroma and per-tone a*/b* of each pair (the framing differs: global statistics, not pixel matches) and writes
WORK_DIR/compare.jpg (film | v4).
"""
import json, os, socket, subprocess, sys, time
import numpy as np
from PIL import Image, ImageDraw
from skimage import color

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'eval'))
import check   # render(), the P3 reading of the app's canvas PNG
FRAMES = ('13', '17', '18')
BANDS = ((0, 25), (25, 50), (50, 75), (75, 101))


def stats(rgb8):
    lab = color.rgb2lab(rgb8 / 255.0); L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    bands = [(a[k].mean(), b[k].mean()) if (k := (L >= lo) & (L < hi)).mean() > .01 else (np.nan, np.nan) for lo, hi in BANDS]
    return np.percentile(np.hypot(a, b), 50), np.percentile(L, [5, 50, 95]), bands


def main(work):
    port = check.free_port()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', '-d', os.path.join(ROOT, 'web'), '--bind', '127.0.0.1', str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rows = []
    try:
        time.sleep(1)
        for f in FRAMES:
            png = os.path.join(work, f'v4_{f}.png')
            print(f, check.render(port, os.path.join(work, f'frame{f}.dng'), {}, png, '?v4'))
            lab = check.lab_of(png)   # Display P3 canvas -> Lab
            v4 = (np.clip(color.lab2rgb(lab), 0, 1) * 255 + .5).astype(np.uint8)
            wh = json.loads(subprocess.run(['node', os.path.join(ROOT, 'eval', 'gold200', 'invert_scan.mjs'), os.path.join(work, f'T{f}.npy'),
                                            os.path.join(work, f'film{f}.rgb'), '--linear'], capture_output=True, text=True, check=True).stdout)
            film = np.frombuffer(open(os.path.join(work, f'film{f}.rgb'), 'rb').read(), np.uint8).reshape(wh['h'], wh['w'], 3)
            (cf, lf, bf), (cv, lv, bv) = stats(film.astype(float)), stats(v4.astype(float))
            d = '  '.join(f'{bv[i][0] - bf[i][0]:+5.1f}/{bv[i][1] - bf[i][1]:+5.1f}' for i in range(len(BANDS)))
            print(f'  chroma p50 v4 {cv:.1f} / film {cf:.1f} (ratio {cv / cf:.2f})  L p5/50/95 v4 {lv.round(0)} film {lf.round(0)}'
                  f'  | a*/b* v4 - film by L* 0-25 / 25-50 / 50-75 / 75+: {d}')
            pair = [Image.fromarray(film), Image.fromarray(v4)]
            for im in pair:
                im.thumbnail((2000, 360))
            r = Image.new('RGB', (pair[0].width + pair[1].width + 10, 382), 'white')
            r.paste(pair[0], (0, 22)); r.paste(pair[1], (pair[0].width + 10, 22))
            ImageDraw.Draw(r).text((4, 5), f'frame {f}: Gold 200 (RGB-LED scan, neutral inversion) | v4 (digital capture)', fill='black')
            rows.append(r)
    finally:
        srv.terminate()
    sheet = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows)), 'white')
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(os.path.join(work, 'compare.jpg'), quality=90)


if __name__ == '__main__':
    main(sys.argv[1])
