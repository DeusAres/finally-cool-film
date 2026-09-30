use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::pipeline::Pipeline;
use spektrafilm_core::profile;
use spektrafilm_gpu::cpu_backend::CpuBackend;
use spektrafilm_gpu::wgpu_backend::WgpuBackend;
use spektrafilm_math::image::ImageBuf;
use wasm_bindgen::prelude::*;

const DATA_DIR: &str = "data";

thread_local! {
    static GPU: RefCell<Option<Rc<WgpuBackend>>> = const { RefCell::new(None) };
}

/// Initialise the WebGPU backend. Resolves to false when WebGPU is unavailable.
#[wasm_bindgen]
pub async fn init_gpu() -> bool {
    let Some(backend) = WgpuBackend::new_async().await else {
        return false;
    };
    GPU.with(|g| *g.borrow_mut() = Some(Rc::new(backend)));
    true
}

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Make a data file visible to the engine, e.g. `data/profiles/kodak_gold_200.json`.
#[wasm_bindgen]
pub fn register_file(path: &str, bytes: Vec<u8>) {
    spektrafilm_core::vfs::register(path, bytes);
}

/// Default `RuntimeParams` as JSON, for the UI to read and patch.
#[wasm_bindgen]
pub fn default_params() -> String {
    serde_json::to_string(&RuntimeParams::default()).unwrap()
}

#[wasm_bindgen]
pub struct Engine {
    pipeline: Option<Pipeline>,
    /// Full params as JSON (defaults + every override applied so far).
    params: serde_json::Value,
}

#[wasm_bindgen]
impl Engine {
    /// `overrides_json` is merged on top of the defaults (deep merge of objects).
    #[wasm_bindgen(constructor)]
    pub fn new(film: &str, paper: &str, overrides_json: &str) -> Result<Engine, JsError> {
        let mut base = serde_json::to_value(RuntimeParams::default())?;
        let overrides: serde_json::Value = serde_json::from_str(overrides_json)?;
        merge(&mut base, overrides);
        let params: RuntimeParams = serde_json::from_value(base.clone())?;

        let data_dir = Path::new(DATA_DIR);
        let film = profile::load_profile_by_name(data_dir, film)?;
        let print = profile::load_profile_by_name(data_dir, paper)?;
        let pipeline = Pipeline::new_with_spectral(film, print, params, data_dir)
            .map_err(|e| JsError::new(&e))?;
        Ok(Engine { pipeline: Some(pipeline), params: base })
    }

    /// Merge render-time overrides (print exposure, contrast morph, grain,
    /// halation, scanner…) without re-running calibration. Calibration inputs
    /// (enlarger filters/illuminant, camera EV) need a new `Engine`.
    pub fn update(&mut self, overrides_json: &str) -> Result<(), JsError> {
        let overrides: serde_json::Value = serde_json::from_str(overrides_json)?;
        let mut next = self.params.clone();
        merge(&mut next, overrides);
        let params: RuntimeParams = serde_json::from_value(next.clone())?;
        let pipeline = self.pipeline.take().expect("pipeline present");
        self.pipeline = Some(pipeline.with_params(params));
        self.params = next;
        Ok(())
    }

    fn pipeline(&self) -> &Pipeline {
        self.pipeline.as_ref().expect("pipeline present")
    }

    /// Run the full chain on interleaved RGB f32 (w*h*3). Returns interleaved RGB f32.
    pub fn process(&self, rgb: Vec<f32>, width: u32, height: u32) -> Vec<f32> {
        let image = ImageBuf::from_data(width, height, rgb);
        self.pipeline().process(image, &CpuBackend).data
    }

    /// GPU-resident run (requires `init_gpu`). Resolves to a Float32Array of
    /// display-ready (sRGB-encoded, clamped) interleaved RGB.
    pub fn process_gpu(&self, rgb: Vec<f32>, width: u32, height: u32) -> Result<js_sys::Promise, JsError> {
        let gpu = GPU
            .with(|g| g.borrow().clone())
            .ok_or_else(|| JsError::new("GPU not initialised"))?;
        let image = ImageBuf::from_data(width, height, rgb);
        self.pipeline()
            .process_resident_borrowed(&image, gpu.as_ref())
            .ok_or_else(|| JsError::new("GPU-resident path unavailable for these params"))?;
        Ok(wasm_bindgen_futures::future_to_promise(async move {
            let out = gpu
                .take_readback()
                .await
                .ok_or_else(|| JsValue::from_str("GPU readback failed"))?;
            Ok(js_sys::Float32Array::from(out.data.as_slice()).into())
        }))
    }
}

fn merge(dst: &mut serde_json::Value, src: serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
            for (k, v) in s {
                merge(d.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (d, s) => *d = s,
    }
}
