"""Port of frontier.rs Gradation (contrast 0, highlights 0): normalized density x -> encoded output."""
import numpy as np
# The app's v3 model (params.rs defaults + app.js renderParams overrides), the starting point of the fit.
APP = dict(range_density=1.5923, gradation_a=6.2, mid_grey_out=0.4683, shoulder_start=0.6928, shoulder_sharpness=1.7142, black_point=0.012, white_point=0.9908)
def _make(a, m, p):
    s0 = 1 / (1 + np.exp(a * m)); s1 = 1 / (1 + np.exp(-a * (1 - m))); ys = min(max(p['shoulder_start'], 0), 0.999); sh = p['shoulder_sharpness']
    def shoulder(y):
        t = (y - ys) / (1 - ys); f = t if sh < 1e-6 else (1 - np.exp(-sh * t)) / sh
        return np.where(y <= ys, y, ys + (1 - ys) * f)
    one = shoulder(np.array(1.0))
    def curve(x):
        x = np.clip(x, 0, 1); y = (1 / (1 + np.exp(-a * (x - m))) - s0) / (s1 - s0)
        return p['black_point'] + (p['white_point'] - p['black_point']) * shoulder(y) / one
    return curve
def gradation(p):
    a = p['gradation_a']; lo, hi = -2.0, 3.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _make(a, mid, p)(0.5) > p['mid_grey_out']: lo = mid
        else: hi = mid
    return _make(a, 0.5 * (lo + hi), p)
