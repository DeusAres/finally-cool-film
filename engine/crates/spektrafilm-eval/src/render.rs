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

impl EngineRenderer {
    /// What the lab does for a frame: run the core Frontier AutoSetup on `thumb`
    /// (scene-linear, as the app's thumbnail) and render with its result.
    /// Returns `[density_ev, c, m, y]`.
    pub fn apply_autosetup(&mut self, thumb: ImageBuf) -> Option<[f32; 4]> {
        let auto = self.0.frontier_auto_setup(thumb)?;
        let mut params = self.0.params.clone();
        params.scanner.frontier.auto = auto;
        self.0 = self.0.clone().with_params(params);
        Some(auto)
    }
}

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
    let space = params.io.output_color_space.as_str();
    if !(space.eq_ignore_ascii_case("srgb") || space == "ITU-R BT.2020") || !params.io.output_cctf_encoding {
        return Err("the harness measures sRGB or BT.2020 primaries with the sRGB transfer (io.output_color_space)".into());
    }
    let film = profile::load_profile_by_name(data_dir, FILM).map_err(|e| e.to_string())?;
    let print = profile::load_profile_by_name(data_dir, PAPER).map_err(|e| e.to_string())?;
    let pipeline = Pipeline::new_with_spectral(film, print, params, data_dir)?;
    Ok(EngineRenderer(pipeline))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chart, color};

    /// The Frontier look is rendered in one working space; the output primaries only
    /// enter as a final matrix. The same chart through sRGB and BT.2020 output must
    /// give the same Lab for in-gamut patches.
    #[test]
    fn output_space_does_not_change_the_colour() {
        let dir = default_data_dir();
        if !dir.join("profiles/kodak_gold_200.json").exists() {
            return;
        }
        let srgb = build(json!({}), &dir).unwrap();
        let wide = build(json!({"io": {"output_color_space": "ITU-R BT.2020"}}), &dir).unwrap();
        let (s_srgb, s_wide) = (color::Rgb::srgb(), color::Rgb::rec2020());
        let mut worst = 0f64;
        let scenes = chart::CC24.iter().map(|(_, lab)| chart::lab_scene(*lab)).chain((-8..=8).map(|i| chart::grey_scene(f64::from(i) / 2.0)));
        for scene in scenes {
            let a = chart::measure(&srgb, scene, &s_srgb);
            let b = chart::measure(&wide, scene, &s_wide);
            // in-gamut for sRGB: no channel clipped at 0 or 1
            if a.rgb.iter().any(|&v| v < 0.004 || v > 0.996) {
                continue;
            }
            worst = worst.max(color::de00(a.lab, b.lab));
        }
        assert!(worst < 1.0, "sRGB vs BT.2020 output differ by dE00 {worst}");
    }
}
