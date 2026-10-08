//! The pipeline under test, configured as the web app configures it.
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::pipeline::Pipeline;
use spektrafilm_core::profile;
use spektrafilm_gpu::cpu_backend::CpuBackend;
use spektrafilm_math::image::ImageBuf;

const FILM: &str = "kodak_gold_200";
const PAPER: &str = "kodak_portra_endura";

/// Default data directory: `web/data` of this checkout.
pub fn default_data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/data")
}

/// Everything after the engine: maps scene-linear Rec.2020 to the sRGB-encoded
/// image that gets measured or saved. The harness takes the result as is (no
/// inversion, no tone curve), so a scanner stage added to the engine, or a
/// different `Renderer` wrapped around it, is measured without further change.
pub trait Renderer {
    fn render(&self, scene: ImageBuf) -> ImageBuf;
}

/// `Pipeline::process` on the CPU backend, output returned unmodified.
pub struct EngineRenderer(Pipeline);

impl Renderer for EngineRenderer {
    fn render(&self, scene: ImageBuf) -> ImageBuf {
        self.0.process(scene, &CpuBackend)
    }
}

/// Params of `web/app.js` (`renderParams`, `calibParams`) and `web/lib/common.js`
/// (`BASE_PARAMS`, Rec.2020 linear input; no DIR-diffusion override, as v2) with the app's slider defaults. Grain is
/// off: the app's grain is a GPU output pass, and noise would only blur the
/// patch means. Output is sRGB, as SCHEMA.md measures.
fn app_params() -> Value {
    json!({
        "settings": { "use_enlarger_lut": true, "use_scanner_lut": true },
        "io": {
            "input_color_space": "ITU-R BT.2020", "input_cctf_decoding": false,
            "output_color_space": "sRGB", "output_gamut_compress": { "algorithm": "off" },
            "scan_film": true
        },
        "enlarger": { "m_filter_shift": 0, "y_filter_shift": 0 },
        "camera": { "auto_exposure": false, "film_format_mm": 35 },
        "scanner": { "model": "frontier", "black_correction": false, "white_correction": false, "unsharp_mask": [0, 0] },
        "film_render": {
            "grain": { "active": false },
            "halation": { "active": true, "halation_amount": 1.0 },
            "glare": { "roughness": 0 }
        },
        "print_render": { "glare": { "roughness": 0 } }
    })
}

/// Deep-merge objects, as `Engine::new` in spektrafilm-wasm does.
fn merge(dst: &mut Value, src: Value) {
    match (dst, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (k, v) in s {
                merge(d.entry(k).or_insert(Value::Null), v);
            }
        }
        (d, s) => *d = s,
    }
}

/// App params + `overrides` (a JSON file's content, or `{}`) on the engine defaults.
pub fn build(overrides: Value, data_dir: &Path) -> Result<EngineRenderer, String> {
    let mut params = serde_json::to_value(RuntimeParams::default()).map_err(|e| e.to_string())?;
    merge(&mut params, app_params());
    merge(&mut params, overrides);
    let params: RuntimeParams = serde_json::from_value(params).map_err(|e| format!("params: {e}"))?;
    if !params.io.output_color_space.eq_ignore_ascii_case("srgb") || !params.io.output_cctf_encoding {
        return Err("the harness measures sRGB-encoded output (io.output_color_space = sRGB)".into());
    }
    let film = profile::load_profile_by_name(data_dir, FILM).map_err(|e| e.to_string())?;
    let print = profile::load_profile_by_name(data_dir, PAPER).map_err(|e| e.to_string())?;
    let pipeline = Pipeline::new_with_spectral(film, print, params, data_dir)?;
    Ok(EngineRenderer(pipeline))
}
