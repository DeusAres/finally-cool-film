# CPU calibration loop (sf-eval), used for v4 calibration step 2 (eval/V4.md)

Run from a WORK directory holding frameNN.npy (eval/dng2npy.mjs of arw2dng.py's DNGs, 1200 px), meta.json
(`{"baseline": 0}`), filmNN.png (invert_scan.mjs of film_scan.py's T, as PNG) and TNN.npy. Needs sf-eval built
(scripts/eval/build-sf-eval.sh). mkparams.py mirrors the app's v4 render params by hand: keep it in step with web/app.js.

    python3 trial.py NAME 'film_render json' [EV_OFFSET] [13,17]   # engine render + v4 inversion, global stats vs film
    python3 register.py NAME 6 [13,17]                              # align to the film scan, write registered pairs
    python3 qq.py NAME 13                                           # per-channel normalised-density QQ distance
    python3 samecontent.py NAME                                     # Lab stats on the same registered pixels
