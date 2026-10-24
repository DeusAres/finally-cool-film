"""Render the SG + Kodak grey scale through the v4 Frontier on CPU (sf-eval image), measured as measure_real.py measures.
python3 sim.py NAME 'overrides json' EV [EV ...]  -> sim_NAME.json {ev: {sg_lab, kodak_lab}}"""
import sys, os, json, subprocess, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labd50 import lab2lin, lin2lab, dec, BT2020, SRGB
from sgref import REF
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../..'))
NAMES = [f"{'ABCDEFGHIJKLMN'[c]}{r + 1}" for c in range(14) for r in range(10)]
# Geometry: the real frame at half size (3128 px -> 1564 = 36 mm), SG pitch 37.9 px, patches 30 px, measured over the central 14.
W, H, PITCH, PATCH, R = 1564, 1041, 38, 30, 7
# Choices: the SG body is its own black (A2, L* 8); the surround a neutral L* 70 (the wall's true colour is unknown);
# Kodak Q-13 steps 0.05 + 0.10 i reflection density (nominal, unverified).
# SIM_SURROUND: surround L* or "L,a,b" (70 = the colour / tone fits; the real wall reads ~55, 2.5, 0); SIM_DATA: another web/data.
_S = [float(v) for v in os.environ.get("SIM_SURROUND", "70").split(",")]
SURROUND, BODY = (_S + [0.0, 0.0])[:3], 8.05   # surround Lab (L or "L,a,b"); the SG body is its own black
BOARD = os.environ.get("SIM_BOARD") == "1"   # the real frame's white board: bottom right, ~10 % of the frame, L* 92 (a choice)
RAMP_LOG = np.linspace(-2.8, 0.1, 59)
def lab_lin(L): return lab2lin(np.array([L, 0, 0]))
def scene():
    img = np.tile(lab2lin(np.array(SURROUND)), (H, W, 1))
    if BOARD: img[int(0.68 * H):, int(0.62 * W):int(0.95 * W)] = lab_lin(92.0)
    x0, y0 = 120, 250
    img[y0 - 40:y0 + 10 * PITCH + 20, x0 - 40:x0 + 14 * PITCH + 20] = lab_lin(BODY)
    cen = {}
    for c in range(14):
        for r in range(10):
            n = f"{'ABCDEFGHIJKLMN'[c]}{r + 1}"; x, y = x0 + c * PITCH, y0 + r * PITCH
            img[y:y + PATCH, x:x + PATCH] = lab2lin(REF[n]); cen[n] = (x + PATCH // 2, y + PATCH // 2)
    ky, kx = 760, 180
    img[ky - 30:ky + 60, kx - 20:kx + 20 * 22 + 20] = lab_lin(85)   # the card around the steps
    kd = []
    for i in range(20):
        refl = 10 ** -(0.05 + 0.1 * i); img[ky:ky + 30, kx + 22 * i:kx + 22 * i + 22] = refl * np.ones(3) * (lab_lin(100)[1])
        kd.append((kx + 22 * i + 11, ky + 15))
    ramp = []   # dense neutral ramp for the tone fit: log10 reflectance RAMP_LOG, 8 x 8 patches right of the SG
    for i, lg in enumerate(RAMP_LOG):
        x, y = 820 + (i % 8) * PITCH, y0 + (i // 8) * PITCH
        img[y:y + PATCH, x:x + PATCH] = 10 ** lg * lab_lin(100)[1]; ramp.append((x + PATCH // 2, y + PATCH // 2))
    return img.astype(np.float32), cen, kd, ramp
def openblas():
    return os.path.dirname(subprocess.run(f'find {ROOT}/engine/target/release/build -name "libopenblas*.so*"', shell=True, capture_output=True, text=True).stdout.split()[0])
def sf_image(params_json, npy, png, gains=None):
    """sf-eval image: the scene .npy through the params; gains r,g,b (scene-linear, before the film) also run AutoSetup on the
    frame (None: the params' keys as given). Returns sf-eval's stderr (it prints the AutoSetup keys)."""
    cmd = [f'{ROOT}/engine/target/release/sf-eval', 'image', '--params', params_json, '--in', npy, '--out', png, '--output-space', 'bt2020',
           '--data', os.environ.get('SIM_DATA', f'{ROOT}/web/data')]
    if gains is not None:
        cmd += ['--under', '0', '--gains', ','.join(str(g) for g in gains)]
    r = subprocess.run(cmd, env=dict(os.environ, LD_LIBRARY_PATH=openblas()), capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr)
    return r.stderr
def png_lin(png):   # the BT.2020 render as linear sRGB, clipped as an sRGB export is
    from PIL import Image
    return np.clip(dec(np.asarray(Image.open(png).convert('RGB')).astype(float) / 255) @ (np.linalg.inv(SRGB) @ BT2020).T, 0, 1)
def run(name, overrides, evs, gains=(1.0, 1.0, 1.0)):   # gains: the illuminant, per channel (tungsten: 1.486, 1, 0.439)
    import mkfrontier
    from PIL import Image
    img, cen, kd, ramp = scene(); np.save(f'scene_{name}.npy', img)
    json.dump(mkfrontier.params(overrides), open(f'p_{name}.json', 'w'))
    res = {}
    for ev in evs:
        k = 2 ** ev; out = f'sim_{name}_{ev:+g}.png'
        err = sf_image(f'p_{name}.json', f'scene_{name}.npy', out, [k * g for g in gains])
        enc = np.asarray(Image.open(out).convert('RGB')).astype(float) / 255
        lin = png_lin(out)
        m = lambda p: lin[p[1] - R:p[1] + R, p[0] - R:p[0] + R].reshape(-1, 3).mean(0)
        res[f'{ev:+g}'] = {'auto': err.strip().split('autosetup')[-1], 'sg_lab': lin2lab(np.array([m(cen[n]) for n in NAMES])).tolist(),
                           'kodak_lab': lin2lab(np.array([m(p) for p in kd])).tolist(),
                           'ramp_enc': [enc[p[1] - R:p[1] + R, p[0] - R:p[0] + R].reshape(-1, 3).mean(0).tolist() for p in ramp],
                           'ramp_lab': lin2lab(np.array([m(p) for p in ramp])).tolist()}
    json.dump(res, open(f'sim_{name}.json', 'w'))
    return res
if __name__ == '__main__':
    run(sys.argv[1], json.loads(sys.argv[2]), [float(e) for e in sys.argv[3:]] or [0.0])
