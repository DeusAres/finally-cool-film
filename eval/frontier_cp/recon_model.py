"""Our AutoSetup level on any real Frontier scan, also frames without grey patches (Landscape, Night).
The scan is turned back into a scene through OUR v4 Frontier's neutral tone curve at zero keys (a grey ramp rendered by sf-eval;
the curve is fitted to the real machine's, grey L* rms 1.2): rendered with zero keys that scene gives the real scan back, so the
density key our AutoSetup then computes on it is our level error on that frame, in EV (+ = we print it brighter than the lab).
Exposure does not enter: AutoSetup compensates it in full (autolevel.py), and the scene's absolute scale is the curve's.
python3 recon_model.py NAME 'auto params json' [SET/FRAME ...]   (default: the 0 EV frame of each set)
SCAN=Noritsu: the Noritsu frames, through app.js V4_NORITSU / V4_NORITSU_AUTO.
EVS=-1,0,1,2: the exposure response instead. Each SET's 0 EV frame is rebuilt once and exposed by 2^ev, as the camera did; our
render's mean L* is compared with the real frame at that EV (the lab compensates in full when the real column is flat).
python3 recon_model.py NAME 'auto params json' SET [SET ...]"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
from labd50 import lin2lab, enc2lab
from recon import scene_from_scan, R
import sim, mkfrontier
sys.path.insert(0, os.path.join(sim.ROOT, 'eval'))
from appconst import app_const
EV = np.arange(-8.0, 5.01, 0.125)   # ramp: exposure in EV over mid grey 0.18
def ramp_curve(name, model):
    """Rendered L* of a neutral grey at each EV of the ramp, zero keys (no AutoSetup)."""
    P = 16; img = np.zeros((P, P * len(EV), 3), np.float32)
    for i, e in enumerate(EV): img[:, i * P:(i + 1) * P] = 0.18 * 2 ** e
    np.save(f'rm_ramp_{name}.npy', img)
    json.dump(mkfrontier.params({"scanner": {"frontier": {"model": model}}}), open(f'p_rm_{name}.json', 'w'))
    sim.sf_image(f'p_rm_{name}.json', f'rm_ramp_{name}.npy', f'rm_ramp_{name}.png')
    lin = sim.png_lin(f'rm_ramp_{name}.png')
    return np.array([lin2lab(lin[4:12, i * P + 4:(i + 1) * P - 4].reshape(-1, 3).mean(0))[0] for i in range(len(EV))])
def exposure_response(name, sets, L_to_Y, scan):
    evs = [float(e) for e in os.environ['EVS'].split(',')]
    tag_ev = {-1: 'minus1EV', 0: '0EV', 1: 'plus1EV', 2: 'plus2EV'}
    for s in sets:
        im0 = np.asarray(Image.open(f'{R}/{s}/Gold-0EV-{scan}.png').convert('RGB')).astype(float)
        np.save(f'rm_{name}_{s}_ev.npy', scene_from_scan(im0, L_to_Y))
        row = []
        for ev in evs:
            png = f'rm_{name}_{s}_{ev:+g}.png'
            sim.sf_image(f'p_rma_{name}.json', f'rm_{name}_{s}_ev.npy', png, (2 ** ev,) * 3)
            ours = lin2lab(sim.png_lin(png).reshape(-1, 3))[:, 0].mean()
            real = enc2lab(np.asarray(Image.open(f'{R}/{s}/Gold-{tag_ev[int(ev)]}-{scan}.png').convert('RGB')).astype(float)[::4, ::4].reshape(-1, 3))[:, 0].mean()
            row.append(f'{ev:+g} EV ours {ours:5.1f} real {real:5.1f}')
        print(f'{name:10s} {s:10s} ' + ' | '.join(row))
def main():
    name, auto = sys.argv[1], json.loads(sys.argv[2])
    scan = os.environ.get('SCAN', 'Frontier'); nor = scan == 'Noritsu'
    frames = sys.argv[3:] or [f'{s}/Gold-0EV-{scan}' for s in ['Charts', 'Studio', 'Daylight', 'Landscape', 'Night']]
    model = dict(app_const('V4_NORITSU' if nor else 'V4_FRONTIER'))
    L = ramp_curve(name, model)
    ok = np.r_[True, np.diff(L) > 1e-3]   # the curve's flat ends (black / white point) carry no information
    Lk, Ek = L[ok], EV[ok]
    L_to_Y = lambda l: 0.18 * 2 ** np.interp(l, Lk, Ek)   # beyond the ends: clamped (a choice; the clipped share is printed)
    model['auto'] = dict(app_const('V4_NORITSU_AUTO' if nor else 'V4_AUTO'), neutral_sigma=app_const('V4_NEUTRAL_SIGMA'), **auto)
    json.dump(mkfrontier.params({"scanner": {"frontier": {"model": model}}}), open(f'p_rma_{name}.json', 'w'))
    if os.environ.get('EVS'):
        return exposure_response(name, sys.argv[3:], L_to_Y, scan)
    for f in frames:
        im = np.asarray(Image.open(f'{R}/{f}.png').convert('RGB')).astype(float)
        scene = scene_from_scan(im, L_to_Y); tag = f'{name}_' + f.replace('/', '_')
        np.save(f'rm_{tag}.npy', scene)   # per name: runs in parallel do not share files
        err = sim.sf_image(f'p_rma_{name}.json', f'rm_{tag}.npy', f'rm_{tag}.png', (1, 1, 1))
        key = json.loads(err.split('autosetup [density_ev, c, m, y] =')[-1].strip().splitlines()[0])
        lin = sim.png_lin(f'rm_{tag}.png'); Lr = lin2lab(lin.reshape(-1, 3))[:, 0]
        Ls = enc2lab(im[::4, ::4].reshape(-1, 3))[:, 0]
        clip = np.mean(Ls >= Lk[-1] - 0.5)
        print(f'{name:10s} {f:28s} key {key[0]:+.2f} EV  mean L* ours {Lr.mean():5.1f} real {Ls.mean():5.1f}  (scan at white {clip:.1%})')
if __name__ == '__main__':
    main()
