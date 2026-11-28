#!/usr/bin/env python3
"""App icons from the mascot (web/lib/rullino.js, IDLE frame): favicon and home-screen icons, pixel art scaled by whole
pixels (nearest neighbour, no blur). Run after a change to the sprite:  python3 scripts/icons/make_icons.py

  web/icons/favicon-32.png, favicon-64.png    the sprite on transparency, cropped to its pixels (browser tab)
  web/icons/apple-touch-icon.png (180)         on the app's background (--bg #0e0d0c): iOS fills transparency with black
"""
import json, os, re
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
BG = (14, 13, 12, 255)   # index.html --bg
PAD = 0.12               # home-screen icons: margin around the sprite, share of the side (a choice: iOS rounds the corners)

src = open(os.path.join(ROOT, 'web', 'lib', 'rullino.js')).read()
pal = json.loads(re.search(r'export const PAL = (\{.*?\});', src).group(1))
rows = re.findall(r'"([^"]+)"', re.search(r'export const IDLE = \[(.*?)\];', src, re.S).group(1))
h, w = len(rows), len(rows[0])
sprite = Image.new('RGBA', (w, h), (0, 0, 0, 0))
for y, row in enumerate(rows):
    for x, c in enumerate(row):
        if c != '.':
            sprite.putpixel((x, y), tuple(int(pal[c][i:i + 2], 16) for i in (1, 3, 5)) + (255,))
sprite = sprite.crop(sprite.getbbox())
side = max(sprite.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(sprite, ((side - sprite.width) // 2, (side - sprite.height) // 2))


def scaled(img, size):
    """Nearest-neighbour by the largest whole factor that fits, centred on a transparent `size` square."""
    k = max(1, size // img.width)
    big = img.resize((img.width * k, img.height * k), Image.NEAREST)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(big, ((size - big.width) // 2, (size - big.height) // 2))
    return out


out = os.path.join(ROOT, 'web', 'icons')
os.makedirs(out, exist_ok=True)
for s in (32, 64):
    # a small favicon cannot hold a whole factor of the sprite: downscale the 4x version with a box filter instead
    (scaled(square, s) if s >= side else square.resize((s, s), Image.BOX)).save(os.path.join(out, f'favicon-{s}.png'))
for name, s in (('apple-touch-icon', 180),):
    inner = round(s * (1 - 2 * PAD))
    bg = Image.new('RGBA', (s, s), BG)
    spr = scaled(square, inner)
    bg.alpha_composite(spr, ((s - inner) // 2, (s - inner) // 2))
    bg.convert('RGB').save(os.path.join(out, f'{name}.png'))
print('icons written to', os.path.normpath(out), 'sprite', sprite.size)
