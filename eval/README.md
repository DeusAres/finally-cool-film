# eval: measurement harness

`sf-eval` renders the SCHEMA.md chart (or a real photo) through the engine on the CPU
backend, with the web app's settings, and measures what the pipeline returns (no inversion).

    cd engine
    cargo build -p spektrafilm-eval --release
    echo '{}' > /tmp/o.json              # overrides, deep-merged on the app params
    target/release/sf-eval chart --params /tmp/o.json --out ../eval/out/run1 \
        --spec ../eval/gold200_spec.json  # writes report.json + chart.png (~1 s)
    cargo test -p spektrafilm-eval       # colour maths: Sharma de00 vectors, Lab round trip

Without `--spec`, `score` is null and `pass` is null (measured values only). Params are the
app's (`web/app.js` renderParams), grain off, sRGB output; `--data <dir>` overrides `web/data`.

Real photo (DNG), mirroring the app's raw path at default sliders:

    node eval/dng2npy.mjs photo.dng /tmp/p.npy 2000   # also /tmp/p.thumb.npy, /tmp/p.json
    engine/target/eval/sf-eval image --params eval/calib/best_overrides.json --in /tmp/p.npy \
        --meta /tmp/p.json --thumb /tmp/p.thumb.npy --neutral /tmp/p_neutral.jpg --out /tmp/p.jpg  # .jpg = q90

Mirrored (app JS imported: `loadRaw`, `rawThumb`, `THUMB_PX`): decoder, EXIF orientation,
BaselineExposure, Auto exposure (engine metering on the 256 px thumb, clamp, 0.1 rounding), Interno
(EXIF; only if >= 1 EV as the app preselects it), Frontier AutoSetup on that thumb then re-render with `auto`.
Only the Interno values are re-stated in dng2npy.mjs (`internoParams()` from `web/lib/interno.js`, with `--interno`). Without `--meta` the .npy is rendered as is.
Not in the reference render: grain, dust, lens (CA/vignette/falloff), Texture/Chiarezza, Display P3 output (this is sRGB), border.

The output stage is the `Renderer` trait in `crates/spektrafilm-eval/src/render.rs`; today it
is `Pipeline::process` unchanged (scan_film gives the negative).
