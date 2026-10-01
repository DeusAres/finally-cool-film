import numpy as np, sys
sys.path.insert(0, 'src'); sys.path.insert(0, '../parity/stubs')
from spektrafilm import init_params, simulate
W, H = 768, 160
img = np.fromfile('../parity/input.f32', np.float32).reshape(H, W, 3).astype(np.float64)
# linear sRGB -> linear Rec.2020 (D65), from primaries
M = np.array([[0.6274039, 0.3292830, 0.0433131],[0.0690973, 0.9195404, 0.0113623],[0.0163914, 0.0880133, 0.8955953]])
img2020 = img @ M.T
img2020.astype(np.float32).tofile('../parity/input2020.f32')
p = init_params('kodak_gold_200', 'kodak_portra_endura')
p.io.input_color_space = 'ITU-R BT.2020'; p.io.input_cctf_decoding = False
p.settings.use_enlarger_lut = True; p.settings.use_scanner_lut = True
p.film_render.grain.active = False; p.film_render.halation.active = False
p.film_render.glare.active = False; p.print_render.glare.active = False
p.camera.auto_exposure = False
np.asarray(simulate(img2020, p), np.float32).tofile('../parity/py_out_2020.f32')
print('ok')
