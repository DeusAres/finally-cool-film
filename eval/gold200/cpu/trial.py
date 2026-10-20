"""trial.py NAME 'film_render json': render the 3 digital frames on CPU (sf-eval, narrowband v4 params), invert, compare to real film."""
import sys, json, subprocess, os, glob, numpy as np
from PIL import Image
from skimage import color
import mkparams
name, film = sys.argv[1], json.loads(sys.argv[2] if len(sys.argv) > 2 else '{}')
EVOFF = sys.argv[3] if len(sys.argv) > 3 else '0'
ONLY = sys.argv[4].split(',') if len(sys.argv) > 4 else ('13', '17', '18')
json.dump(mkparams.params(**film), open(f'p_{name}.json', 'w'))
LIB = os.path.dirname(subprocess.run('find /home/user/finally-cool-film/engine/target/release/build -name "libopenblas*.so*"', shell=True, capture_output=True, text=True).stdout.split()[0])
env = dict(os.environ, LD_LIBRARY_PATH=LIB)
def stats(a):
    lab = color.rgb2lab(a / 255.0); L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]; C = np.hypot(A, B)
    bands = [(A[k].mean(), B[k].mean()) if (k := (L >= lo) & (L < hi)).mean() > .01 else (np.nan, np.nan) for lo, hi in [(0, 25), (25, 50), (50, 75), (75, 101)]]
    return np.percentile(C, 50), np.percentile(C, 90), np.percentile(L, [5, 50, 95]), bands
tot = []
for f in ONLY:
    png = f'cpu_{name}_{f}.png'
    if not os.path.exists(png):
        r = subprocess.run(['/home/user/finally-cool-film/engine/target/release/sf-eval', 'image', '--params', f'p_{name}.json', '--in', f'frame{f}.npy', '--thumb', f'frame{f}.npy',
                            '--meta', 'meta.json', '--ev-offset', EVOFF, '--out', png, '--data', '/home/user/finally-cool-film/web/data'], env=env, capture_output=True, text=True)
        if r.returncode: sys.exit(r.stderr)
    np.save(f'enc_{name}_{f}.npy', (np.asarray(Image.open(png).convert('RGB')) / 255.0).astype(np.float32))
    wh = json.loads(subprocess.run(['node', 'invenc.mjs', f'enc_{name}_{f}.npy', f'pos_{name}_{f}.rgb'], capture_output=True, text=True, check=True).stdout)
    pos = np.frombuffer(open(f'pos_{name}_{f}.rgb', 'rb').read(), np.uint8).reshape(wh['h'], wh['w'], 3); Image.fromarray(pos).save(f'pos_{name}_{f}.png')
    film_img = np.asarray(Image.open(f'film{f}.png').convert('RGB')).astype(float)
    s, r = stats(pos.astype(float)), stats(film_img)
    d = [f"{s[3][i][0] - r[3][i][0]:+5.1f}/{s[3][i][1] - r[3][i][1]:+5.1f}" for i in range(4)]
    print(f"{name:10s} {f}: C50 {s[0]:5.1f} (film {r[0]:5.1f}, ratio {s[0] / r[0]:.2f})  C90 {s[1]:5.1f} ({r[1]:5.1f})  L5/50/95 {s[2].round(0)} ({r[2].round(0)}) | da/db vs film by L: {'  '.join(d)}")
    tot.append(np.nanmean([abs(s[3][i][j] - r[3][i][j]) for i in range(4) for j in range(2)]))
print(f"{name:10s} mean |da|,|db| over bands and frames: {np.mean(tot):.2f}")
