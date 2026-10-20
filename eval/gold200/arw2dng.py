"""Sony ARW -> uncompressed CFA DNG that web/lib/dng.js reads: the same sensor data (visible area, black / white levels,
2x2 Bayer pattern), LibRaw's colour matrix (XYZ D65 -> camera, the Adobe convention of DNG ColorMatrix1) and the camera's
as-shot white balance (AsShotNeutral). So a digital capture goes through the app exactly as a phone DNG does.

    python3 eval/gold200/arw2dng.py IN.ARW OUT.dng
"""
import sys, numpy as np, rawpy, tifffile

D65 = 21   # DNG CalibrationIlluminant code
rational = lambda vals: sum(([int(round(v * 1e6)), 1000000] for v in vals), [])

with rawpy.imread(sys.argv[1]) as r:
    cfa = r.raw_image_visible.astype(np.uint16).copy()
    pat, desc = r.raw_pattern, r.color_desc.decode()
    cfapat = bytes('RGB'.index(desc[pat[y, x]]) for y in range(2) for x in range(2))   # G2 is reported as 'G'
    black = [float(r.black_level_per_channel[pat[y, x]]) for y in range(2) for x in range(2)]
    white = int(r.white_level)
    cm = np.asarray(r.rgb_xyz_matrix)[:3]
    wb = np.asarray(r.camera_whitebalance[:3], float)
    orientation = {0: 1, 3: 3, 5: 8, 6: 6}.get(r.sizes.flip, 1)
tags = [
    (50706, 'B', 4, (1, 4, 0, 0), True),                 # DNGVersion
    (50708, 's', 0, 'Sony (converted from ARW)', True),   # UniqueCameraModel
    (254, 'I', 1, 0, True),                               # NewSubFileType: main image
    (274, 'H', 1, orientation, True),
    (33421, 'H', 2, (2, 2), True), (33422, 'B', 4, cfapat, True),
    (50713, 'H', 2, (2, 2), True), (50714, '2I', 4, rational(black), True),
    (50717, 'I', 1, white, True),
    (50721, '2i', 9, rational(cm.ravel()), True), (50778, 'H', 1, D65, True),
    (50728, '2I', 3, rational(wb[1] / wb), True),         # AsShotNeutral = 1 / WB gains (green = 1)
]
tifffile.imwrite(sys.argv[2], cfa, photometric=32803, compression=None, extratags=tags, metadata=None)
print(sys.argv[2], cfa.shape[::-1], 'pattern', list(cfapat), 'orientation', orientation)
