# Parità colore: motore wasm vs spektrafilm Python (riferimento)

Target sintetico 768×160 (rampa di grigi −6…+3 EV, 24 patch tipo ColorChecker, bordo a gradino),
Kodak Gold 200 → Portra Endura, LUT mode, grana/halation/glare off, auto-exposure off.

- `py_ref.py`: gira spektrafilm Python (upstream `andreavolpato/spektrafilm`, deps: numpy, scipy, colour-science,
  scikit-image, matplotlib, opt-einsum, numba, pyfftw, OpenImageIO; `exiv2`/`rawpy`/`lensfunpy` sostituiti da stub vuoti).
- `compare.cjs`: stesso target nel motore wasm (CPU), ΔE2000 per patch, cast della rampa, profilo del bordo.

Risultato (2026-09-30):

| Misura | Valore |
|---|---|
| ΔE2000 24 patch colore, wasm vs Python | media 0.00, max 0.00 |
| ΔE2000 rampa di grigi | media 0.00, max 0.00 |
| Diff max pixel | 1.74 solo sul pixel del bordo: Python restituisce valori negativi dal ringing dell'unsharp, il wasm clampa a 0 |
| Cast rampa (Python) | C* ≤ 1.7: ombre −2.5 EV a* −1.5 b* +0.8 (verde-giallo), neri −6 EV b* −1.7 (freddi) |
| Effetto di bordo DIR | lato chiaro +0.8 L*, lato scuro −0.4 L* entro ~20 px (a 45 µm/px), assente con DIR off |
