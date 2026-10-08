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

Real photo (DNG, using the app's decoder `web/lib/dng.js`):

    node eval/dng2npy.mjs photo.dng /tmp/photo.npy 2000   # linear Rec.2020, HxWx3 f32
    engine/target/release/sf-eval image --params /tmp/o.json --in /tmp/photo.npy --out /tmp/photo.png

The output stage is the `Renderer` trait in `crates/spektrafilm-eval/src/render.rs`; today it
is `Pipeline::process` unchanged (scan_film gives the negative).
