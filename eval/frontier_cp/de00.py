"""CIEDE2000 colour difference of Lab arrays (N x 3)."""
import numpy as np
def de00(a, b):   # CIEDE2000
    L1, a1, b1 = a.T; L2, a2, b2 = b.T
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2); Cm = (C1 + C2) / 2; G = 0.5 * (1 - np.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
    a1p, a2p = a1 * (1 + G), a2 * (1 + G); C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1, h2 = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dL, dC = L2 - L1, C2p - C1p; dh = h2 - h1; dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dH = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2)); Lm, Cpm = (L1 + L2) / 2, (C1p + C2p) / 2
    hs = h1 + h2; hm = np.where(np.abs(h1 - h2) > 180, (hs + 360) / 2, hs / 2) % 360
    T = 1 - 0.17 * np.cos(np.radians(hm - 30)) + 0.24 * np.cos(np.radians(2 * hm)) + 0.32 * np.cos(np.radians(3 * hm + 6)) - 0.2 * np.cos(np.radians(4 * hm - 63))
    SL = 1 + 0.015 * (Lm - 50) ** 2 / np.sqrt(20 + (Lm - 50) ** 2); SC = 1 + 0.045 * Cpm; SH = 1 + 0.015 * Cpm * T
    RT = -2 * np.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * np.sin(np.radians(60 * np.exp(-(((hm - 275) / 25) ** 2))))
    return np.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))
