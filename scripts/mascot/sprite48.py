"""Rullino, the film-canister mascot: 48x48, 16-bit style (SNES-era sprite conventions).

Original character, no brand trade dress. Teal label with a coral stripe, cream face panel, metal caps,
amber film leader with sprocket holes. One light from the top-left.

The sprite is built as data in three steps, all deterministic:
  1. geometry: caps and body are cylinders seen slightly from above, drawn column by column;
     each column takes one step of its material ramp from an explicit run string (highlight stripe on
     the left third, core shadow to the right, 1 px reflected light before the right outline);
  2. sel-out: every silhouette pixel becomes a dark step of its own ramp (lit outline top/left,
     darkest outline bottom/right);
  3. hand-made char maps: spool knob, face (eyes, blink, mouths, cheeks), film leader, AA touch-ups.

Usage: python3 scripts/mascot/sprite48.py [out_dir]   (default: eval/out of the repo)
Writes web/lib/rullino.js (the app's sprite data: the only copy, generated, do not edit by hand) and, in out_dir, the previews
rullino48.gif, rullino48_frames.png, rullino48_frames.json.
"""
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFont

W = H = 48

# ---- palette: char -> colour. Ramps go light -> dark, hue-shifted (warm highlights, cool saturated shadows).
PAL = {
    # metal caps (cool grey, warm white top, blue-violet shadow)
    'a': '#fbf7ea', 'b': '#d3d7db', 'c': '#9da5b6', 'd': '#69708f', 'e': '#3a3a5a',
    # teal label
    'f': '#b9f3c6', 'g': '#6dd7bb', 'h': '#33aaa2', 'i': '#217683', 'j': '#1a4264',
    # coral stripe
    'k': '#ffd09c', 'l': '#ff8866', 'm': '#d94f55', 'n': '#87294e',
    # cream face panel
    'o': '#fffbec', 'p': '#f6e5c6', 'q': '#e0c3a3', 'r': '#b38f8a',
    # film leader (orange-mask amber)
    's': '#ffc47c', 't': '#d97f3e', 'u': '#a6532f', 'v': '#6c2f33', 'w': '#391a2c',
    # eyes: ink, iris glow, catch light
    'x': '#2a1d3c', 'y': '#5b4f9e', 'W': '#ffffff',
    # mouth: lip line, interior, tongue; cheek blush
    'z': '#552238', 'Z': '#8c2645', 'T': '#ff8a98', 'B': '#ff9c9c',
}
RAMPS = {  # material -> ramp chars light..dark (shading steps 0..4)
    'metal': 'abcde', 'teal': 'fghij', 'coral': 'klmnn', 'cream': 'opqrr', 'film': 'stuvw',
}
OUTLINE = {  # material -> (lit-side outline top/left, shadow-side outline bottom/right)
    'metal': 'de', 'teal': 'ij', 'coral': 'mn', 'cream': 'qr', 'film': 'vw',
}
MAT = {c: m for m, r in RAMPS.items() for c in r}

# Column shading runs, one digit per column = ramp step (0 highlight .. 4 darkest). Outer columns are
# replaced by sel-out. Highlight stripe on the left third, core shadow right, '2' = reflected light.
RUN_BODY = '1100001111111222222233333324'      # 28 px
RUN_CAP = '211001111111222222223333333324'     # 30 px, narrow 2 px specular stripe (metal)
assert len(RUN_BODY) == 28 and len(RUN_CAP) == 30


class Grid:
    def __init__(self):
        self.g = [[None] * W for _ in range(H)]
    def put(self, x, y, c):
        if 0 <= x < W and 0 <= y < H: self.g[y][x] = c
    def get(self, x, y):
        return self.g[y][x] if 0 <= x < W and 0 <= y < H else None
    def stamp(self, x0, y0, rows):
        """Paste a char map: ' ' keeps what is there, '.' clears, anything else is a palette char."""
        for dy, row in enumerate(rows):
            for dx, c in enumerate(row):
                if c != ' ': self.put(x0 + dx, y0 + dy, None if c == '.' else c)
    def rows(self):
        return [''.join(c or '.' for c in r) for r in self.g]


# ---- layout (rows/cols of the 48x48 frame; the character spans rows ~3..44, cols 6..47)
CX, CA = 19.0, 15.0         # canister axis (pixel-edge coords) and cap half-width; body is 1 px narrower
BX0, BX1 = 5, 32            # body columns (28 px)
CX0, CX1 = 4, 33            # caps: one px wider than the body on each side
CAP_B, RIM_H = 3, 2         # ellipse half-height (view ~11 deg from above: 3/15), top-cap rim height
TOP_Y, BOT_Y = 9, 37        # centre row of the top-cap ellipse; row of the bottom-cap lip at the sides
FACE_X, FACE_Y = 9, 20     # face panel top-left at the centre of the arc (20 x 13)


def arc(x, b=CAP_B):
    """Depth of the cylinder's front arc at column x (0 at the sides, b at the centre). Every band on
    the canister (cap lips, rim edges, stripe, panel) uses this one curve, so they stay parallel."""
    u = (x + 0.5 - CX) / CA
    return int(b * math.sqrt(max(0.0, 1 - u * u)) + 0.5)


def ucol(x):
    return (x + 0.5 - CX) / CA


def cap_rim(G, x0, x1, ylip, rim, run):
    """Side band of a metal cap: lip (highlight line where lit), `rim`-1 rows shaded by `run`, dark edge."""
    for x, s in zip(range(x0, x1 + 1), run):
        u, y = ucol(x), ylip + arc(x)
        G.put(x, y, 'a' if u < -0.15 else 'b' if u < 0.5 else 'c')
        for yy in range(y + 1, y + rim):
            G.put(x, yy, 'bcdee'[int(s)])                     # one step darker than the top face
        G.put(x, y + rim, 'd' if u < -0.6 else 'e')


def top_face(G, yc):
    """Top of the upper cap: a flat light ellipse. A short specular arc runs just inside the back edge
    on the lit (left) side; the right end turns one step darker."""
    for x in range(CX0, CX1 + 1):
        u = ucol(x)
        for y in range(yc - arc(x), yc + arc(x)):
            G.put(x, y, 'c' if u > 0.75 else 'b')
        if -0.8 < u < -0.3: G.put(x, yc - arc(x) + 1, 'a')


def knob(G, yc):
    """Spool end sticking out of the middle of the top cap: a short cylinder, darker than the cap so it
    separates from the light top face, hollow core on top, shadow cast to the lower right."""
    G.stamp(15, yc - 6, [
        ' dddddd ',
        'dbbbbbbd',
        'dbbddbcd',   # dd = hollow of the spool core
        'cabbbbce',   # front lip of the knob top
        'cacccdde',
        'cacccdde',
        'cccccdee',
        ' cdddee ',   # contact shadow on the cap face
    ])


def canister(G, sq):
    """Caps + teal body + coral stripe. sq = 1 squashes everything above the bottom cap down a row."""
    ty = TOP_Y + sq
    for x, s in zip(range(BX0, BX1 + 1), RUN_BODY):
        u, a = ucol(x), arc(x)
        y0 = ty + a + RIM_H + 1                         # first row under the top cap
        for y in range(y0, BOT_Y + a):
            G.put(x, y, 'fghij'[int(s)])
        G.put(x, y0, 'i' if u > -0.75 else 'h')         # contact shadow under the top cap
        for y in (y0 + 2, y0 + 3):                      # coral stripe, parallel to the cap lips
            G.put(x, y, 'klmnn'[int(s)])
    for x, y, c in ((6, ty + 6, 'k'), (31, ty + 6, 'm')):  # hand AA: stripe arc steps at both ends
        G.put(x, y, c)
    cap_rim(G, CX0, CX1, BOT_Y, RIM_H + 2, RUN_CAP)     # bottom cap: only its side shows
    top_face(G, ty)
    cap_rim(G, CX0, CX1, ty, RIM_H, RUN_CAP)
    knob(G, ty)


def face_panel(G, sq):
    """Cream panel, 20 x 13, rounded corners; its top/bottom edges follow the cylinder arc and it is
    shaded like the cylinder but flatter (it faces us)."""
    run = '20000111111111112223'
    corner = {0: 2, 1: 1}  # rows from the edge -> px cut at each end (radius-2 corner)
    for dx, s in enumerate(run):
        x = FACE_X + dx
        y0 = FACE_Y + sq - (CAP_B - arc(x))
        for dy in range(13):
            e = min(dy, 12 - dy)
            cut = corner.get(e, 0)
            if dx < cut or dx > 19 - cut: continue
            c = 'opqr'[int(s)]
            if dy == 0 and s == '1': c = 'o'            # top edge catches light
            if dy == 12: c = 'q' if s in '01' else 'r'  # bottom edge in shade
            if dx == 0 or (e == 0 and dx == 2) or (e == 1 and dx == 1): c = 'q'   # left edge: soft AA
            G.put(x, y0 + dy, c)


EYE = {  # 4 x 6, top-left light: 2x2 catch light, iris glow at the bottom
    'open':   ['.xx.', 'xWWx', 'xWxx', 'xxxx', 'xyyx', '.xx.'],
    'half':   ['    ', '    ', 'xxxx', 'xWxx', 'xyyx', '.xx.'],
    'closed': ['    ', '    ', '    ', 'x..x', '.xx.', '    '],
}
MOUTH = {  # 4 wide, rows from 7 rows under the panel top (eye bottoms), centred on the axis
    'smile':  ['    ', 'z..z', '.zz.'],
    'closed': ['    ', '    ', '.zz.'],
    'half':   ['    ', '    ', 'zzzz', 'zTTz', '.zz.'],
    'open':   ['.zz.', 'zZZz', 'zZZz', 'zTTz', '.zz.'],
}


def face(G, sq, eyes, mouth):
    y0 = FACE_Y + sq
    for ex in (12, 22):
        if eyes != 'open':  # lids: refill the eye box with the panel colour of each column
            G.stamp(ex, y0 + 2, [''.join(G.get(ex + i, y0 + 1) for i in range(4))] * 6)
        G.stamp(ex, y0 + 2, [r.replace('.', ' ') for r in EYE[eyes]])
    G.stamp(10, y0 + 8, ['BB']); G.stamp(26, y0 + 8, ['BB'])
    G.stamp(17, y0 + 7, [r.replace('.', ' ') for r in MOUTH[mouth]])


LEADER = [  # from x BX1+1, row 21: film strip out of the felt slit, full width near the canister,
    # then the cut tongue with a rounded tip. Perforations 1x2 (KS holes are taller than wide across the strip).
    'vvvvvvvvvvvv...',
    'ssssssssssssv..',
    'twttwttwttwttv.',
    'twttwttwttwtttw',
    'tttttttttttttuw',
    'ttttttttttttuw.',
    'ttttttuwwwwww..',
    'tttttuw........',
    'twttwuw........',
    'twttwuw........',
    'uuuuuw.........',
    'wwwwww.........',
]


def leader(G, sq, wig):
    """Film tongue out of the felt slit on the right. wig = 1 bends the tongue tip up a row."""
    y0 = 21 + sq
    for y in range(y0 - 1, y0 + 13): G.put(BX1, y, 'w')  # felt light trap
    for r, row in enumerate(LEADER):
        for i, c in enumerate(row):
            if c != '.': G.put(BX1 + 1 + i, y0 + r - (1 if wig and i >= 10 else 0), c)


def selout(G):
    """Outline every pixel that touches transparency with a darker step of its own ramp:
    darkest when the empty side is below or (only) right, one step lighter when it is above/left.
    Top-edge stair steps on the right count as top, so the top rim stays one clean colour."""
    out = []
    for y in range(H):
        for x in range(W):
            c = G.get(x, y)
            if c is None or c not in MAT: continue
            lit, dark = OUTLINE[MAT[c]]
            if G.get(x, y + 1) is None: out.append((x, y, dark))
            elif G.get(x - 1, y) is None or G.get(x, y - 1) is None: out.append((x, y, lit))
            elif G.get(x + 1, y) is None: out.append((x, y, dark))
    for x, y, c in out: G.put(x, y, c)


def frame(sq=0, eyes='open', mouth='smile', wig=0):
    G = Grid()
    canister(G, sq)
    selout(G)
    leader(G, sq, wig)
    face_panel(G, sq)
    face(G, sq, eyes, mouth)
    return G


def rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def to_image(G):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    px = im.load()
    for y in range(H):
        for x in range(W):
            c = G.get(x, y)
            if c: px[x, y] = rgb(PAL[c]) + (255,)
    return im


KEY = {  # key frames for the web app and the sheet
    'idle': dict(mouth='smile'),
    'blink_half': dict(eyes='half', mouth='smile'),
    'blink': dict(eyes='closed', mouth='smile'),
    'talk_closed': dict(mouth='closed'),
    'talk_half': dict(mouth='half'),
    'talk_open': dict(mouth='open'),
    'wiggle': dict(mouth='smile', wig=1),
    'breathe': dict(mouth='smile', sq=1),
}

BG = (58, 54, 64)   # preview background: mid-dark slate, like a dim photo corner


def sheet(path, z=6):
    names = list(KEY)
    sh = Image.new('RGB', (len(names) * (W * z + 8) + 8, H * z + 16), BG)
    for i, n in enumerate(names):
        im = to_image(frame(**KEY[n])).resize((W * z, H * z), Image.NEAREST)
        sh.paste(im, (8 + i * (W * z + 8), 8), im)
    sh.save(path)


INK, PAPER, PAPER_SH = (42, 34, 46), (250, 244, 228), (222, 208, 190)


TAIL = [  # from (x0 - 5, y1): stepped tail toward the mascot's head; I = ink, P = paper
    '.......PPPPP',
    '.....IPPPPII',
    '...IPPPPII',
    '.IPPPII',
    'IPII',
    'II',
]


def bubble(c, x0, y0, x1, y1):
    """Speech bubble drawn in sprite pixels (same grid as the mascot): 1 px ink outline, notched
    corners, a shade row along the bottom, a hand-drawn stepped tail at the bottom left."""
    d = ImageDraw.Draw(c)
    d.rectangle((x0 + 1, y0, x1 - 1, y1), fill=INK); d.rectangle((x0, y0 + 1, x1, y1 - 1), fill=INK)
    d.rectangle((x0 + 1, y0 + 1, x1 - 1, y1 - 1), fill=PAPER)
    d.rectangle((x0 + 1, y1 - 1, x1 - 1, y1 - 1), fill=PAPER_SH)
    for dy, row in enumerate(TAIL):
        for dx, ch in enumerate(row):
            if ch != '.': c.putpixel((x0 - 5 + dx, y1 + dy), (INK if ch == 'I' else PAPER) + (255,))


def gif(path, z=6):
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
    text = 'I colori virano verso il blu!'
    seq = []  # (frame kwargs, duration ms, typed text)
    idle = [dict(), dict(sq=1), dict(sq=1, wig=1), dict(wig=1), dict(), dict(sq=1, eyes='half'),
            dict(sq=1, eyes='closed', wig=1), dict(eyes='half', wig=1)]
    for kw in idle: seq.append((dict(mouth='smile', **kw), 180, ''))
    cyc = ['half', 'open', 'half', 'closed']
    for i in range(1, len(text) + 1):
        talking = i < len(text) and text[i - 1] != ' '
        seq.append((dict(mouth=cyc[i % 4] if talking else 'closed', wig=(i // 4) % 2, sq=(i // 6) % 2), 70, text[:i]))
    for kw in idle: seq.append((dict(mouth='smile', **kw), 180, text))
    for kw in idle[:4]: seq.append((dict(mouth='smile', **kw), 180, ''))
    lw, lh = 128, 54                       # canvas in sprite pixels, shown x z
    frames, durs = [], []
    for kw, d, t in seq:
        lo = Image.new('RGBA', (lw, lh), BG + (255,))
        lo.alpha_composite(to_image(frame(**kw)), (1, 4))
        if t: bubble(lo, 50, 3, 125, 17)
        c = lo.convert('RGB').resize((lw * z, lh * z), Image.NEAREST)
        if t: ImageDraw.Draw(c).text((56 * z, 6 * z + 3), t, fill=INK, font=font)
        frames.append(c.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)); durs.append(d)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durs, loop=0, disposal=1)


def export_json(path):
    used = sorted({c for n in KEY for r in frame(**KEY[n]).rows() for c in r if c != '.'})
    data = {'w': W, 'h': H, 'transparent': '.', 'palette': [PAL[c] for c in used],
            'chars': {c: PAL[c] for c in used},
            'frames': {n: frame(**kw).rows() for n, kw in KEY.items()},
            'notes': 'one frame = 48 strings of 48 chars; "." transparent; chars map to colours via "chars". '
                     'Idle: idle/breathe bob + wiggle, blink = idle->blink_half->blink->blink_half. '
                     'Talk: talk_half, talk_open, talk_half, talk_closed while text types.'}
    with open(path, 'w') as f: json.dump(data, f, indent=1)
    return used


def export_js(path):
    """The app's copy: the palette, the idle frame in full, every other frame as the rows that differ from it."""
    fr = {n: frame(**kw).rows() for n, kw in KEY.items()}
    used = sorted({c for rows in fr.values() for r in rows for c in r if c != '.'})
    idle = fr['idle']
    diff = {n: {y: r for y, r in enumerate(rows) if r != idle[y]} for n, rows in fr.items() if n != 'idle'}
    js = ['// Generated by scripts/mascot/sprite48.py: do not edit by hand (change the generator and run it).',
          '// Rullino, 48 x 48, "." transparent; FRAMES[name] = the rows that differ from IDLE.',
          f'export const W = {W}, H = {H};',
          'export const PAL = ' + json.dumps({c: PAL[c] for c in used}) + ';',
          'export const IDLE = [', *[f'  {json.dumps(r)},' for r in idle], '];',
          'export const FRAMES = {']
    for n, d in diff.items():
        js.append(f'  {n}: {{')
        js += [f'    {y}: {json.dumps(r)},' for y, r in d.items()]
        js.append('  },')
    js.append('};')
    with open(path, 'w') as f: f.write('\n'.join(js) + '\n')


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'eval', 'out')
    export_js(os.path.join(ROOT, 'web', 'lib', 'rullino.js'))
    sheet(os.path.join(out, 'rullino48_frames.png'))
    used = export_json(os.path.join(out, 'rullino48_frames.json'))
    gif(os.path.join(out, 'rullino48.gif'))
    print('colours used:', len(used))
