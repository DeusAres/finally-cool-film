"""Reconstruct a scene-linear frame from a real Frontier scan, using the frame's own grey patches (known reflectance) to map
scan L* -> scene reflectance, so our AutoSetup sees what the lab's saw. Writes recon_SET.npy (Rec.2020 linear, 0.18 = mid grey
at the metered exposure) and recon_SET.json (grey patch centres in the npy, their reference L*, the real scan's L*)."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
from labd50 import enc2lab, dec, SRGB, BT2020
from sgref import REF
R = os.environ.get('CP_SLIDER', 'slider')   # the Color Precision tool's slider/ folder (Charts, Studio, Daylight, ...)
SPY_C = [(2425, 465), (2425, 590), (2425, 717), (2425, 845), (2425, 970), (2425, 1095)]   # Charts frame, Spyder grey column E1-E6
SPY_D = [(2465, 807), (2465, 927), (2465, 1047), (2465, 1167), (2465, 1287), (2465, 1407)]   # Daylight frame
def curve(realL, refL):   # monotone map scan L* -> reference L*
    o = np.argsort(realL); x, y = np.maximum.accumulate(np.asarray(realL)[o]), np.asarray(refL)[o]
    def f(L):   # linear inside; beyond the patches, the end slopes (choice: no data there)
        L = np.asarray(L, float); out = np.interp(L, x, y)
        lo, hi = L < x[0], L > x[-1]
        s0 = (y[1] - y[0]) / max(x[1] - x[0], 1e-6); s1 = (y[-1] - y[-2]) / max(x[-1] - x[-2], 1e-6)
        out = np.where(lo, y[0] + (L - x[0]) * s0, out); return np.where(hi, y[-1] + (L - x[-1]) * s1, out)
    return f
def Yof(L): f = (L + 16) / 116; return np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29))
S = 4   # the scan is read at 1/4 size (782 x 520)
def scene_from_scan(im, L_to_Y):
    """Scene-linear Rec.2020 frame from an 8-bit sRGB scan: each pixel keeps the scan's chromaticity, its luminance is L_to_Y(scan L*)."""
    small = im[::S, ::S][: im.shape[0] // S, : im.shape[1] // S]
    lab = enc2lab(small.reshape(-1, 3)).reshape(small.shape); Y = L_to_Y(lab[..., 0])
    lin = dec(small / 255.0); ly = lin @ [0.2126, 0.7152, 0.0722]
    scene = lin * (Y / np.maximum(ly, 1e-5))[..., None]   # scan chromaticity, reconstructed luminance
    return np.clip(scene @ (np.linalg.inv(BT2020) @ SRGB).T, 0, None).astype(np.float32)
def build(setname, scanner='Frontier'):
    real = json.load(open('real.json')); studio = json.load(open('real_studio.json')); names = real['names']
    ref = np.array([REF[n] for n in names]); neu = np.hypot(ref[:, 1], ref[:, 2]) < 3
    ch = json.load(open('charts_measure.json'))   # Spyder (and Kodak) patches of the Charts frames: measure_charts.py
    # Spyder grey reference L*: the Charts frame's Spyder greys read through that frame's SG grey curve
    cf = curve(np.array(real['frames']['Gold-0EV-Frontier']['sg_lab'])[neu, 0], ref[neu, 0])
    spy_ref = cf(np.array(ch['Charts/Gold-0EV-Frontier.png']['spy_lab'])[[0, 4, 8, 12, 16, 20], 0])
    im = np.asarray(Image.open(f'{R}/{setname}/Gold-0EV-{scanner}.png').convert('RGB')).astype(float)
    if setname == 'Charts':
        fr = real['frames'][f'Gold-0EV-{scanner}']
        A1, N1, A10, N10 = (np.array(c) for c in ([323, 622], [1308, 610], [325, 1297], [1313, 1290]))
        P = [(1 - c / 13) * (1 - r / 9) * A1 + c / 13 * (1 - r / 9) * N1 + (1 - c / 13) * r / 9 * A10 + c / 13 * r / 9 * N10 for c in range(14) for r in range(10)]
        pts, refL, realL = P, ref[:, 0], np.array(fr['sg_lab'])[:, 0]; sel = neu
    elif setname == 'Studio':
        fr = studio['frames'][f'Gold-0EV-{scanner}']
        A1, N1, A10, N10 = (np.array(c) for c in ([112, 1096], [812, 1034], [140, 1590], [826, 1505]))
        pts = [(1 - c / 13) * (1 - r / 9) * A1 + c / 13 * (1 - r / 9) * N1 + (1 - c / 13) * r / 9 * A10 + c / 13 * r / 9 * N10 for c in range(14) for r in range(10)]
        refL, realL = ref[:, 0], np.array(fr['sg_lab'])[:, 0]; sel = neu
    else:
        pts = [np.array(p) for p in SPY_D]; refL = spy_ref
        realL = np.array([enc2lab(im[y - 25:y + 25, x - 25:x + 25].reshape(-1, 3).mean(0))[0] for x, y in SPY_D]); sel = np.ones(6, bool)
    m = curve(realL[sel], refL[sel])
    scene = scene_from_scan(im, lambda L: Yof(m(L)))
    tag = '' if scanner == 'Frontier' else '_' + scanner
    np.save(f'recon_{setname}{tag}.npy', scene)
    pts_s = [(int(p[0]) // S, int(p[1]) // S) for p, k in zip(pts, sel) if k]
    json.dump({'pts': pts_s, 'refL': list(map(float, np.asarray(refL)[sel])), 'realL': list(map(float, np.asarray(realL)[sel]))}, open(f'recon_{setname}{tag}.json', 'w'))
    print(setname, scene.shape, 'grey refL', np.round(np.asarray(refL)[sel][:8], 1), 'realL', np.round(np.asarray(realL)[sel][:8], 1))
if __name__ == '__main__':
    for s_ in sys.argv[1:] or ['Charts', 'Studio', 'Daylight']: build(s_, os.environ.get('SCAN', 'Frontier'))
