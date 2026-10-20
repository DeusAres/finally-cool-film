"""Real Gold 200 transmittance from the gold200 dataset's RGB-LED scans (see README.md).

    python3 eval/gold200/film_scan.py DATASET_DIR OUT_DIR

Per frame and LED: the LED's own photosites (black subtracted), divided by the clear-base shot (flat field, smoothed) scaled
to the frame's own clear border (the inter-frame gap, left and right): T = 1 at the film base. Picture area only, 1/3 size,
oriented as the matching digital capture (the scans were shot through the base: mirrored). Writes OUT_DIR/T<frame>.npy.
"""
import glob, sys, numpy as np, rawpy
from scipy.ndimage import gaussian_filter, zoom

LEDS = ('red', 'green', 'blue')
# Picture area inside the scan (fractions of height / width), measured on the three frames' edge profiles.
PICTURE = (slice(0.09, 0.97), slice(0.07, 0.955))
# The clear border strips (px of the half-size plane): inside the inter-frame gap, mid height.
BORDER = (slice(15, 95), slice(-50, -15))
# Digital capture orientation of each frame: (quarter turns, mirror) after the mirror of the through-base scan.
ORIENT = {'13': (0, True), '17': (1, True), '18': (1, True)}


def led_plane(path, led):
    with rawpy.imread(path) as r:
        a = r.raw_image_visible.astype(np.float32); pat = r.raw_pattern; desc = r.color_desc.decode()
        bl = np.array(r.black_level_per_channel, np.float32)
        planes = [a[y::2, x::2] - bl[pat[y, x]] for y in range(2) for x in range(2) if desc[pat[y, x]] == 'RGB'[led]]
    h, w = min(p.shape[0] for p in planes), min(p.shape[1] for p in planes)
    return np.mean([p[:h, :w] for p in planes], 0)


def main(root, out):
    base = [gaussian_filter(led_plane(glob.glob(f'{root}/clear-base/clear-base-{n}-*.ARW')[0], c), 8) for c, n in enumerate(LEDS)]
    for fr, (turns, mirror) in ORIENT.items():
        T = []
        for c, n in enumerate(LEDS):
            s = led_plane(glob.glob(f'{root}/film-scans/frame{fr}/frame{fr}-{n}-*.ARW')[0], c)
            H = s.shape[0]
            k = np.median(np.concatenate([(s[H // 4:3 * H // 4, b] / base[c][H // 4:3 * H // 4, b]).ravel() for b in BORDER]))
            T.append(s / (k * base[c]))
        T = np.stack(T, -1); H, W = T.shape[:2]
        T = T[int(PICTURE[0].start * H):int(PICTURE[0].stop * H), int(PICTURE[1].start * W):int(PICTURE[1].stop * W)]
        T = zoom(T, (1 / 3, 1 / 3, 1), order=1)
        T = np.rot90(T, turns)
        if mirror:
            T = T[:, ::-1]
        np.save(f'{out}/T{fr}.npy', T.astype(np.float32))
        d = -np.log10(np.clip(T, 1e-4, None))
        print(fr, T.shape, 'density p0.5 / p99.8 R G B', [np.percentile(d[..., c], [.5, 99.8]).round(2).tolist() for c in range(3)])


if __name__ == '__main__':
    main(*sys.argv[1:3])
