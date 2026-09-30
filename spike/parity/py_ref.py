import numpy as np, sys, time
sys.path.insert(0, 'src'); sys.path.insert(0, '../parity/stubs')
from spektrafilm import init_params, simulate
CC = [(115,82,68),(194,150,130),(98,122,157),(87,108,67),(133,128,177),(103,189,170),(214,126,44),(80,91,166),
      (193,90,99),(94,60,108),(157,188,64),(224,163,46),(56,61,150),(70,148,73),(175,54,60),(231,199,31),
      (187,86,149),(8,133,161),(243,243,242),(200,200,200),(160,160,160),(122,122,121),(85,85,85),(52,52,52)]
dec = lambda c: np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
P = 32; W = 24*P; H = 5*P
img = np.zeros((H, W, 3), np.float64)
stops = np.linspace(-6, 3, 24)
for k in range(24):
    img[0:P, k*P:(k+1)*P] = 0.18 * 2**stops[k]                     # grey ramp
    img[P:2*P, k*P:(k+1)*P] = dec(np.array(CC[k]) / 255.0)          # colour patches
img[2*P:5*P, :W//2] = 0.03; img[2*P:5*P, W//2:] = 0.6               # step edge (dark | bright)
img.astype(np.float32).tofile('../parity/input.f32')
p = init_params('kodak_gold_200', 'kodak_portra_endura')
p.io.input_color_space = 'sRGB'; p.io.input_cctf_decoding = False
p.settings.use_enlarger_lut = True; p.settings.use_scanner_lut = True
p.film_render.grain.active = False; p.film_render.halation.active = False
p.film_render.glare.active = False; p.print_render.glare.active = False
p.camera.auto_exposure = False
t = time.time(); out = simulate(img, p); print('python sim', round(time.time()-t, 1), 's', out.shape, out.dtype)
np.asarray(out, np.float32).tofile('../parity/py_out.f32')
p.film_render.dir_couplers.active = False
np.asarray(simulate(img, p), np.float32).tofile('../parity/py_out_nodir.f32')
print(W, H)
