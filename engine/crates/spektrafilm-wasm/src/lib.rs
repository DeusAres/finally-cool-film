use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::pipeline::Pipeline;
use spektrafilm_core::profile;
use spektrafilm_core::stages;
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

fn gpu() -> Result<Rc<WgpuBackend>, JsError> {
    GPU.with(|g| g.borrow().clone()).ok_or_else(|| JsError::new("GPU not initialised"))
}

/// Upload the photo (8-bit RGBA, sRGB / Display P3 encoded) for `process_frame`.
#[wasm_bindgen]
pub fn set_frame(rgba: &[u8], width: u32, height: u32) -> Result<(), JsError> {
    gpu()?.set_frame(rgba, width, height);
    Ok(())
}

/// Start a width × height frame for `process_frame`, filled by `set_frame_rows`.
#[wasm_bindgen]
pub fn alloc_frame(width: u32, height: u32) -> Result<(), JsError> {
    gpu()?.alloc_frame(width, height);
    Ok(())
}

/// Upload whole rows (8-bit RGBA, as `set_frame`) of the frame from row `y0`:
/// a big frame goes up a strip at a time, so the wasm heap (which never
/// shrinks) only ever holds one strip.
#[wasm_bindgen]
pub fn set_frame_rows(rgba: &[u8], y0: u32) -> Result<(), JsError> {
    gpu()?.set_frame_rows(rgba, y0);
    Ok(())
}

/// Start a half-float (scene-linear raw) frame, filled by `set_frame_rows_f16`.
#[wasm_bindgen]
pub fn alloc_frame_f16(width: u32, height: u32) -> Result<(), JsError> {
    gpu()?.alloc_frame_f16(width, height);
    Ok(())
}

/// Upload whole rows of a half-float frame (RGBA, f16 bits) from row `y0`.
#[wasm_bindgen]
pub fn set_frame_rows_f16(rgba: &[u16], y0: u32) -> Result<(), JsError> {
    gpu()?.set_frame_rows_f16(rgba, y0);
    Ok(())
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

    /// Auto-exposure EV the pipeline would apply to this image (same metering
    /// as `camera.auto_exposure`). Lets tiled renders share one frame-wide value.
    pub fn auto_exposure_ev(&self, rgb: Vec<f32>, width: u32, height: u32) -> f32 {
        let params = &self.pipeline().params;
        let rgb_to_xyz = stages::filming::input_colorspace_to_xyz(&params.io.input_color_space);
        let image = ImageBuf::from_data(width, height, rgb);
        stages::filming::measure_autoexposure_ev(&image, &rgb_to_xyz, &params.camera.auto_exposure_method)
    }

    /// Frontier AutoSetup. `rgba` is a thumbnail (at most 256 px on the long
    /// side) of linear f32 RGBA in the engine's input space (w*h*4). It is
    /// rendered to the negative on the CPU and analysed; resolves to
    /// `[density_ev, c, m, y]`, to be passed back as `scanner.frontier.auto`.
    /// Needs a negative film (the scanner model need not be active).
    pub fn frontier_auto_setup(&self, rgba: Vec<f32>, width: u32, height: u32) -> Result<js_sys::Float32Array, JsError> {
        let n = width as usize * height as usize;
        if rgba.len() != n * 4 {
            return Err(JsError::new("thumbnail must be width*height*4 floats"));
        }
        let mut rgb = Vec::with_capacity(n * 3);
        for px in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        let out = self
            .pipeline()
            .frontier_auto_setup(ImageBuf::from_data(width, height, rgb))
            .ok_or_else(|| JsError::new("frontier_auto_setup needs a negative film"))?;
        Ok(js_sys::Float32Array::from(out.as_slice()))
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

    /// Whole frame-to-screen run on the GPU, nothing but 8-bit pixels crossing
    /// to JS: the input region (width × height) is computed from the frame
    /// last given to `set_frame` by the `input_wgsl` pass (lens, tone, colour
    /// matrix; see `WgpuBackend::set_input_pass`), the film chain runs, and its
    /// output is packed to RGBA through `lut` (4096 entries) into `out`
    /// (width × height × 4 bytes), by `output_wgsl` when not empty (bindings:
    /// see `WgpuBackend::set_output_pack`) with `output_params`. Resolves to
    /// undefined.
    #[allow(clippy::too_many_arguments)]
    pub fn process_frame(
        &self,
        input_wgsl: &str,
        uniform: Vec<f32>,
        tone: Vec<f32>,
        width: u32,
        height: u32,
        lut: &[u8],
        output_wgsl: &str,
        output_params: Vec<f32>,
        out: js_sys::Uint8Array,
    ) -> Result<js_sys::Promise, JsError> {
        if lut.len() != 4096 {
            return Err(JsError::new("lut must have 4096 entries"));
        }
        if out.length() as usize != width as usize * height as usize * 4 {
            return Err(JsError::new("output buffer size mismatch"));
        }
        let gpu = gpu()?;
        gpu.set_input_pass(input_wgsl, uniform, tone);
        gpu.set_output_pack(lut, (!output_wgsl.is_empty()).then_some(output_wgsl), output_params);
        // Dimensions only: the input pass fills the chain input on the GPU.
        let image = ImageBuf { width, height, data: Vec::new() };
        if self.pipeline().process_resident_borrowed(&image, gpu.as_ref()).is_none() {
            gpu.cancel_io();
            return Err(JsError::new("GPU-resident path unavailable for these params"));
        }
        Ok(wasm_bindgen_futures::future_to_promise(async move {
            // Not get_mapped_range_as_array_buffer: in wgpu 24 it leaves a mapped
            // view registered and the unmap that follows panics. get_mapped_range
            // copies into the wasm heap, so take it 1 MiB at a time (each view
            // dropped before the next): the heap never holds the whole frame.
            gpu.take_readback_packed(|buf| {
                const STRIP: u64 = 1 << 20; // multiple of 8, as map offsets must be
                let len = out.length() as u64;
                let mut off = 0;
                while off < len {
                    let end = (off + STRIP).min(len);
                    let view = buf.slice(off..end).get_mapped_range();
                    out.subarray(off as u32, end as u32).copy_from(&view);
                    drop(view);
                    off = end;
                }
            })
                .await
                .ok_or_else(|| JsValue::from_str("GPU readback failed"))?;
            Ok(JsValue::UNDEFINED)
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
