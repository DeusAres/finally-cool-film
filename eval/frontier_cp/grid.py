"""Split-patch grid of the SG: each patch shows the real scan (left half) and one or more renders (right part), sRGB.
python3 grid.py OUT.png FRAME col_A.json [col_B.json ...]"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw
from labd50 import lab2xyz, enc, SRGB, CAT_50_65
out, frame, sims = sys.argv[1], sys.argv[2], sys.argv[3:]
real = json.load(open('real.json')); names = real['names']
def lab2srgb8(lab): lin = lab2xyz(np.asarray(lab)) @ (np.linalg.inv(SRGB) @ CAT_50_65).T; return (np.clip(enc(np.clip(lin, 0, 1)), 0, 1) * 255).round().astype(np.uint8)
cols = [np.array(real['frames'][frame]['sg_lab'])] + [np.array(json.load(open(s))['sg_lab']) for s in sims]
P, G = 64, 6; n = len(cols)
img = Image.new('RGB', (14 * (P + G) + G, 10 * (P + G) + G + 22), (40, 40, 40)); d = ImageDraw.Draw(img)
for i, nm in enumerate(names):
    c, r = 'ABCDEFGHIJKLMN'.index(nm[0]), int(nm[1:]) - 1; x, y = G + c * (P + G), G + r * (P + G)
    for k, lab in enumerate(cols):
        x0 = x + (0 if k == 0 else P // 2 + (k - 1) * (P // 2) // (n - 1)); x1 = x + (P // 2 if k == 0 else P // 2 + k * (P // 2) // (n - 1))
        d.rectangle([x0, y, x1 - 1, y + P - 1], fill=tuple(int(v) for v in lab2srgb8(lab[i])))
d.text((G, 10 * (P + G) + G + 4), f'left half: real {frame}   right: ' + ' | '.join(os.path.basename(s) for s in sims), fill=(230, 230, 230))
img.save(out)
