/// wgpu compute backend — dispatches WGSL shaders on GPU via Metal/Vulkan/DX12.

#[cfg(feature = "wgpu-backend")]
use std::borrow::Cow;

#[cfg(feature = "wgpu-backend")]
use spektrafilm_math::image::ImageBuf;

#[cfg(feature = "wgpu-backend")]
use crate::{ComputeBackend, Lut3D, cpu_backend};

/// 1-D workgroup size. WebGPU only guarantees 256 invocations per workgroup
/// (common mobile ceiling), so wasm builds rewrite the shaders down to 256.
#[cfg(feature = "wgpu-backend")]
const WG_1D: u32 = if cfg!(target_arch = "wasm32") { 256 } else { 1024 };

#[cfg(feature = "wgpu-backend")]
fn wgsl_for_target(src: &'static str) -> Cow<'static, str> {
    if WG_1D == 1024 {
        Cow::Borrowed(src)
    } else {
        Cow::Owned(src.replace("@workgroup_size(1024)", &format!("@workgroup_size({WG_1D})")))
    }
}

/// Every buffer a frame creates goes through these. On native, dropping a
/// `wgpu::Buffer` frees it. On the web (wgpu 24 webgpu backend) `Drop` is a
/// no-op: GPU memory is only reclaimed on `destroy()` or when the JS GC
/// collects the GPUBuffer. And even with `destroy()`, WebKit frees in its GPU
/// process asynchronously, so allocating ~10 full-frame buffers per render
/// (~400 MB/frame at 3 MP while a slider moves) outruns it until iOS kills
/// the tab. So on wasm a frame's buffers are POOLED: at frame end
/// (`release_frame_buffers`) they become free for the next frame, which
/// takes same-size/same-usage ones back (cleared on the GPU first, so they
/// read exactly like fresh zero-initialised buffers). Pooled buffers the
/// next frame does not reuse (size changed: another photo, export tiles)
/// are destroyed then. Small init-with-contents buffers (uniforms, LUTs,
/// kernels) are created and destroyed per frame.
#[cfg(feature = "wgpu-backend")]
trait TrackedCreate {
    fn create_buffer_t(&self, desc: &wgpu::BufferDescriptor<'_>) -> wgpu::Buffer;
    /// Like `create_buffer_t` for a buffer the frame overwrites completely
    /// before reading any of it: a reused one is not zeroed.
    fn create_buffer_overwritten_t(&self, desc: &wgpu::BufferDescriptor<'_>) -> wgpu::Buffer;
    fn create_buffer_init_t(&self, desc: &wgpu::util::BufferInitDescriptor<'_>) -> wgpu::Buffer;
}

#[cfg(all(feature = "wgpu-backend", target_arch = "wasm32"))]
#[derive(Default)]
struct BufferPool {
    queue: Option<wgpu::Queue>,
    /// Created with contents or not poolable: destroyed at frame end.
    transient: Vec<wgpu::Buffer>,
    /// Poolable buffers handed out during the current frame.
    used: Vec<wgpu::Buffer>,
    /// Left by the previous frame, available for reuse.
    free: Vec<wgpu::Buffer>,
    /// While `batching`, reused buffers that must read as zero are queued here
    /// and cleared inside the frame's command encoder (`flush_pending_clears`)
    /// instead of one submit each.
    batching: bool,
    pending_clears: Vec<wgpu::Buffer>,
}

#[cfg(all(feature = "wgpu-backend", target_arch = "wasm32"))]
thread_local! {
    static POOL: std::cell::RefCell<BufferPool> = std::cell::RefCell::new(BufferPool::default());
}

#[cfg(feature = "wgpu-backend")]
impl TrackedCreate for wgpu::Device {
    fn create_buffer_t(&self, desc: &wgpu::BufferDescriptor<'_>) -> wgpu::Buffer {
        create_buffer_pooled(self, desc, true)
    }
    fn create_buffer_overwritten_t(&self, desc: &wgpu::BufferDescriptor<'_>) -> wgpu::Buffer {
        create_buffer_pooled(self, desc, false)
    }
    fn create_buffer_init_t(&self, desc: &wgpu::util::BufferInitDescriptor<'_>) -> wgpu::Buffer {
        use wgpu::util::DeviceExt;
        let buf = self.create_buffer_init(desc);
        #[cfg(target_arch = "wasm32")]
        POOL.with(|p| p.borrow_mut().transient.push(buf.clone()));
        buf
    }
}

#[cfg(feature = "wgpu-backend")]
fn create_buffer_pooled(device: &wgpu::Device, desc: &wgpu::BufferDescriptor<'_>, zero: bool) -> wgpu::Buffer {
    #[cfg(target_arch = "wasm32")]
    {
        let poolable = !desc.mapped_at_creation && desc.usage.contains(wgpu::BufferUsages::COPY_DST);
        return POOL.with(|p| {
            let mut p = p.borrow_mut();
            if poolable {
                if let Some(i) = p.free.iter().position(|b| b.size() == desc.size && b.usage() == desc.usage) {
                    let buf = p.free.swap_remove(i);
                    // A fresh WebGPU buffer reads as zero; a reused one is cleared to match.
                    if zero {
                        if p.batching {
                            p.pending_clears.push(buf.clone());
                        } else if let Some(q) = p.queue.as_ref() {
                            let mut enc = device.create_command_encoder(&Default::default());
                            enc.clear_buffer(&buf, 0, None);
                            q.submit(Some(enc.finish()));
                        }
                    }
                    p.used.push(buf.clone());
                    return buf;
                }
            }
            let buf = device.create_buffer(desc);
            if poolable { p.used.push(buf.clone()) } else { p.transient.push(buf.clone()) }
            buf
        });
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = zero;
        device.create_buffer(desc)
    }
}

/// Start queueing the zeroing of reused pooled buffers (wasm; no-op elsewhere).
#[cfg(feature = "wgpu-backend")]
fn pool_batching(on: bool) {
    #[cfg(target_arch = "wasm32")]
    POOL.with(|p| p.borrow_mut().batching = on);
    #[cfg(not(target_arch = "wasm32"))]
    let _ = on;
}

/// Encode the queued clears at the head of `encoder` and stop batching.
#[cfg(feature = "wgpu-backend")]
fn flush_pending_clears(encoder: &mut wgpu::CommandEncoder) {
    #[cfg(target_arch = "wasm32")]
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        for b in p.pending_clears.drain(..) {
            encoder.clear_buffer(&b, 0, None);
        }
        p.batching = false;
    });
    #[cfg(not(target_arch = "wasm32"))]
    let _ = encoder;
}

/// End of frame (wasm; see `TrackedCreate`): destroy the transient buffers and
/// the pooled ones this frame did not reuse; this frame's become the pool.
#[cfg(all(feature = "wgpu-backend", target_arch = "wasm32"))]
fn release_frame_buffers() {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        for b in p.transient.drain(..) {
            b.destroy();
        }
        for b in p.free.drain(..) {
            b.destroy();
        }
        p.free = std::mem::take(&mut p.used);
    });
}

/// Readback left in flight by `run_film_chain` on wasm, where the GPU cannot
/// be waited on synchronously. Collected with `WgpuBackend::take_readback`.
#[cfg(all(feature = "wgpu-backend", target_arch = "wasm32"))]
struct PendingReadback {
    buffer: wgpu::Buffer,
    width: u32,
    height: u32,
    mapped: futures_channel::oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    /// True when the buffer holds packed 8-bit RGBA (see `set_output_pack`).
    packed: bool,
}

/// Web front/back ends of the film chain, so a browser frame never crosses
/// the JS↔wasm boundary as floats:
/// - `frame`: the photo as an 8-bit sRGB-encoded texture, uploaded once;
/// - `input`: a caller-supplied WGSL pass that fills the chain input from
///   that texture (lens, tone, colour matrix), replacing the upload;
/// - `pack`: an 8-bit LUT; the chain output is packed to RGBA through it, by
///   PACK_WGSL or a caller-supplied shader with the same bindings (e.g. one
///   that also adds procedural grain), with caller params.
/// `input` and `pack` apply to the next `run_film_chain` only.
#[cfg(feature = "wgpu-backend")]
#[derive(Default)]
struct WebIo {
    frame: Option<wgpu::Texture>,
    input: Option<InputPass>,
    pack: Option<OutputPass>,
    input_pipe: Option<(String, wgpu::ComputePipeline)>,
    pack_pipe: Option<(String, wgpu::ComputePipeline)>,
}

#[cfg(feature = "wgpu-backend")]
struct OutputPass {
    lut: Vec<u32>,
    wgsl: Option<String>,
    params: Vec<f32>,
}

#[cfg(feature = "wgpu-backend")]
struct InputPass {
    wgsl: String,
    uniform: Vec<f32>,
    tone: Vec<f32>,
}

/// Chain output (interleaved RGB f32, display-encoded) → RGBA8 through a
/// 4096-entry LUT, index round(v * 4095), alpha 255. Bindings (shared with
/// caller-supplied output shaders): 0 src, 1 lut, 2 dst, 3 params, where
/// params[0] = pixel count, params[1] = invocations per dispatch row
/// (pixel index = id.x + id.y * params[1]), params[4..] = caller params.
#[cfg(feature = "wgpu-backend")]
const PACK_WGSL: &str = r#"
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
fn q(v: f32) -> u32 { return lut[u32(clamp(v * 4095.0 + 0.5, 0.0, 4095.0))]; }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  dst[i] = q(src[3u * i]) | (q(src[3u * i + 1u]) << 8u) | (q(src[3u * i + 2u]) << 16u) | 0xff000000u;
}
"#;

/// Borrow a `&[Scalar]` as `&[f32]` for GPU upload.
/// Zero-copy in f32 mode; allocates a converted Vec in f64 mode.
#[cfg(all(feature = "wgpu-backend", not(feature = "precision-f64")))]
#[inline]
fn scalars_to_f32(v: &[spektrafilm_math::precision::Scalar]) -> std::borrow::Cow<'_, [f32]> {
    std::borrow::Cow::Borrowed(v)
}

/// FIR Gaussian-blur half-width `ceil(3σ)`, hard-capped so a pathological σ
/// can never build a multi-thousand-tap kernel that hangs the GPU (a
/// monster kernel froze the display once). Callers that need a blur wider
/// than this must downsample first (the diffusion filter does). 256 → at
/// most a 513-tap separable kernel; well above any legitimate σ here
/// (halation tops out at tens of pixels).
const MAX_BLUR_RADIUS: u32 = 256;

#[inline]
fn fir_blur_radius(sigma: f32) -> u32 {
    ((3.0_f32 * sigma).ceil() as u32).min(MAX_BLUR_RADIUS)
}

#[cfg(all(feature = "wgpu-backend", feature = "precision-f64"))]
#[inline]
fn scalars_to_f32(v: &[spektrafilm_math::precision::Scalar]) -> std::borrow::Cow<'static, [f32]> {
    std::borrow::Cow::Owned(v.iter().map(|&s| s as f32).collect())
}

/// Convert a `Vec<f32>` from GPU readback into `Vec<Scalar>`.
/// Zero-copy (identity) in f32 mode; allocates in f64 mode.
#[cfg(all(feature = "wgpu-backend", not(feature = "precision-f64")))]
#[inline]
fn f32_to_scalars(v: Vec<f32>) -> Vec<spektrafilm_math::precision::Scalar> {
    v
}

/// Sanitize NaN values in spectral inputs before GPU upload.
///
/// **Why this exists**: profile JSON has NaN values for `channel_density` /
/// `base_density` at UV/IR wavelengths where the dye/base density isn't
/// measured. Python's `density_to_light` zeros NaN values out (correctly
/// excluding those wavelengths from the einsum). WGSL on Metal compiles with
/// fast-math semantics and optimizes away `x != x` NaN checks, so we cannot
/// rely on in-shader NaN handling. We sanitize CPU-side instead:
///
/// - `channel_density` NaN → 0
/// - `base_density` NaN OR any of its row in channel_density is NaN → +1000
///   (so `pow(10, -1000) ≈ 0` zeros the whole wavelength's contribution)
///
/// This preserves Python's wavelength-skipping semantics exactly.
#[cfg(feature = "wgpu-backend")]
fn sanitize_spectral_inputs(
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    n_wl: usize,
) -> (Vec<f32>, Vec<f32>) {
    let mut cd = Vec::with_capacity(n_wl * 3);
    let mut bd = Vec::with_capacity(n_wl);
    for wl in 0..n_wl {
        let r = channel_density[wl][0];
        let g = channel_density[wl][1];
        let b = channel_density[wl][2];
        let base = if wl < base_density.len() {
            base_density[wl]
        } else {
            f64::NAN
        };
        let row_has_nan = r.is_nan() || g.is_nan() || b.is_nan() || base.is_nan();
        cd.push(if r.is_nan() { 0.0 } else { r as f32 });
        cd.push(if g.is_nan() { 0.0 } else { g as f32 });
        cd.push(if b.is_nan() { 0.0 } else { b as f32 });
        bd.push(if row_has_nan { 1000.0 } else { base as f32 });
    }
    (cd, bd)
}

#[cfg(all(feature = "wgpu-backend", feature = "precision-f64"))]
#[inline]
fn f32_to_scalars(v: Vec<f32>) -> Vec<spektrafilm_math::precision::Scalar> {
    v.into_iter().map(|x| x as f64).collect()
}

#[cfg(feature = "wgpu-backend")]
pub struct WgpuBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Cache compiled compute pipelines keyed by shader source pointer.
    /// `&'static str` is fine because all our shader sources come from `include_str!`.
    pipeline_cache: std::sync::Mutex<std::collections::HashMap<usize, CachedPipeline>>,
    #[cfg(target_arch = "wasm32")]
    pending_readback: std::sync::Mutex<Option<PendingReadback>>,
    io: std::sync::Mutex<WebIo>,
    /// Read-only tables that rarely change between frames (spectral data,
    /// curves, LUTs), kept on the GPU while their contents are unchanged.
    static_bufs: std::sync::Mutex<std::collections::HashMap<&'static str, StaticBuf>>,
}

#[cfg(feature = "wgpu-backend")]
struct StaticBuf {
    bytes: Vec<u8>,
    buf: wgpu::Buffer,
}

#[cfg(feature = "wgpu-backend")]
struct CachedPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

#[cfg(feature = "wgpu-backend")]
impl WgpuBackend {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new() -> Option<Self> {
        pollster::block_on(Self::new_async())
    }

    pub async fn new_async() -> Option<Self> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..Default::default()
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await?;

        // The default `Limits` cap storage buffer bindings at 128 MB,
        // which a 6-channel ≥ 14 MP image exceeds (image_bytes =
        // width × height × 3 × 4). Bump every relevant limit up to the
        // adapter's hardware ceiling so we can render arbitrary
        // megapixel counts (within RAM).
        let adapter_info = adapter.get_info();
        let adapter_limits = adapter.limits();
        let mut limits = wgpu::Limits::default();
        limits.max_storage_buffer_binding_size = adapter_limits.max_storage_buffer_binding_size;
        limits.max_buffer_size = adapter_limits.max_buffer_size;
        limits.max_compute_workgroups_per_dimension =
            adapter_limits.max_compute_workgroups_per_dimension;
        limits.max_bind_groups = adapter_limits.max_bind_groups.max(limits.max_bind_groups);
        limits.max_texture_dimension_2d = adapter_limits.max_texture_dimension_2d;
        // Our per-pixel shaders use `@workgroup_size(1024)` so the
        // dispatch grid stays under the 65535-per-dimension limit even
        // for 30+ MP images. The default Limits cap workgroup
        // invocations at 256, so we have to lift that here too.
        limits.max_compute_invocations_per_workgroup =
            adapter_limits.max_compute_invocations_per_workgroup;
        limits.max_compute_workgroup_size_x = adapter_limits.max_compute_workgroup_size_x;
        limits.max_compute_workgroup_size_y = adapter_limits.max_compute_workgroup_size_y;
        limits.max_compute_workgroup_size_z = adapter_limits.max_compute_workgroup_size_z;
        // MAPPABLE_PRIMARY_BUFFERS lets the input/output STORAGE buffers also
        // be MAP_WRITE / MAP_READ, so they map directly for a zero-copy
        // upload/readback. On unified-memory GPUs this skips the slow
        // Private↔Shared staging blits (~0.5 GB/s) that otherwise dominate the
        // per-frame cost. No-op (falls back to the blit path) if unsupported.
        let opt_feats = if adapter_info.device_type == wgpu::DeviceType::IntegratedGpu {
            wgpu::Features::MAPPABLE_PRIMARY_BUFFERS & adapter.features()
        } else {
            wgpu::Features::empty()
        };
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("spektrafilm"),
                    required_features: opt_feats,
                    required_limits: limits,
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .ok()?;

        tracing::info!(
            adapter = adapter_info.name,
            backend = ?adapter_info.backend,
            "wgpu backend initialized"
        );

        #[cfg(target_arch = "wasm32")]
        POOL.with(|p| p.borrow_mut().queue = Some(queue.clone()));
        Some(Self {
            device,
            queue,
            pipeline_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            #[cfg(target_arch = "wasm32")]
            pending_readback: std::sync::Mutex::new(None),
            io: std::sync::Mutex::new(WebIo::default()),
            static_bufs: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// Storage buffer holding `bytes`, reused from an earlier frame when the
    /// contents under `label` are byte-identical (exact comparison).
    fn static_storage(&self, label: &'static str, bytes: &[u8]) -> wgpu::Buffer {
        self.static_storage_by(label, bytes.len(), |old| old == bytes, || bytes.to_vec())
    }

    /// As `static_storage` for `data` narrowed to f32 (`v as f32`), without
    /// materialising the f32 copy when nothing changed.
    fn static_storage_f64(&self, label: &'static str, data: &[f64]) -> wgpu::Buffer {
        self.static_storage_by(
            label,
            data.len() * 4,
            |old| data.iter().zip(old.chunks_exact(4)).all(|(v, c)| (*v as f32).to_ne_bytes() == c),
            || data.iter().flat_map(|&v| (v as f32).to_ne_bytes()).collect(),
        )
    }

    fn static_storage_by(
        &self,
        label: &'static str,
        len: usize,
        same: impl FnOnce(&[u8]) -> bool,
        make: impl FnOnce() -> Vec<u8>,
    ) -> wgpu::Buffer {
        use wgpu::util::DeviceExt;
        let mut cache = self.static_bufs.lock().unwrap();
        if let Some(e) = cache.get(label) {
            if e.bytes.len() == len && same(&e.bytes) {
                return e.buf.clone();
            }
        }
        let bytes = make();
        let buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        if let Some(old) = cache.insert(label, StaticBuf { bytes, buf: buf.clone() }) {
            // Buffer drop is a no-op on WebGPU: free the replaced one explicitly.
            #[cfg(target_arch = "wasm32")]
            old.buf.destroy();
            #[cfg(not(target_arch = "wasm32"))]
            drop(old);
        }
        buf
    }

    /// Upload the frame the `set_input_pass` shader samples: 8-bit RGBA,
    /// sRGB-encoded (Display P3 shares the curve), decoded to linear by the sampler.
    pub fn set_frame(&self, rgba: &[u8], width: u32, height: u32) {
        self.alloc_frame(width, height);
        self.set_frame_rows(rgba, 0);
    }

    /// New (zeroed) width × height frame texture, filled by `set_frame_rows`.
    pub fn alloc_frame(&self, width: u32, height: u32) {
        let mut io = self.io.lock().unwrap();
        if let Some(t) = io.frame.take() {
            t.destroy();
        }
        let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
        io.frame = Some(self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("frame"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        }));
    }

    /// Write whole rows of the frame from row `y0` on (as many as `rgba`
    /// holds): uploading in strips keeps a big frame out of the wasm heap.
    pub fn set_frame_rows(&self, rgba: &[u8], y0: u32) {
        let io = self.io.lock().unwrap();
        let tex = io.frame.as_ref().expect("alloc_frame before set_frame_rows");
        let width = tex.width();
        let rows = (rgba.len() / (width as usize * 4)) as u32;
        if rows == 0 {
            return;
        }
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d { x: 0, y: y0, z: 0 }, aspect: wgpu::TextureAspect::All },
            &rgba[..rows as usize * width as usize * 4],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(rows) },
            wgpu::Extent3d { width, height: rows, depth_or_array_layers: 1 },
        );
    }

    /// Fill the next chain input on the GPU with `wgsl` (entry `main`,
    /// workgroup 16×16 over the region): binding 0 the frame texture, 1 a
    /// linear clamp sampler, 2 `uniform` (its fields 14/15 are the region
    /// width/height), 3 the chain input (RGB f32), 4 `tone` (storage, read).
    pub fn set_input_pass(&self, wgsl: &str, uniform: Vec<f32>, tone: Vec<f32>) {
        self.io.lock().unwrap().input = Some(InputPass { wgsl: wgsl.to_owned(), uniform, tone });
    }

    /// Pack the next chain output to RGBA8 through `lut` (4096 entries); read
    /// it with `take_readback_packed`.
    /// With `wgsl`, that shader replaces PACK_WGSL (same bindings, see there)
    /// and gets `params` from params[4] on.
    pub fn set_output_pack(&self, lut: &[u8], wgsl: Option<&str>, params: Vec<f32>) {
        self.io.lock().unwrap().pack = Some(OutputPass {
            lut: lut.iter().map(|&v| v as u32).collect(),
            wgsl: wgsl.map(str::to_owned),
            params,
        });
    }

    /// Drop pending `set_input_pass` / `set_output_pack` requests (the run they
    /// were meant for did not happen).
    pub fn cancel_io(&self) {
        let mut io = self.io.lock().unwrap();
        io.input = None;
        io.pack = None;
    }

    fn encode_input_pass(&self, encoder: &mut wgpu::CommandEncoder, req: &InputPass, out: &wgpu::Buffer, w: u32, h: u32) {
        let mut io = self.io.lock().unwrap();
        if io.input_pipe.as_ref().is_none_or(|(src, _)| *src != req.wgsl) {
            let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("input_pass"),
                source: wgpu::ShaderSource::Wgsl(Cow::Owned(req.wgsl.clone())),
            });
            let pipe = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("input_pass"),
                layout: None,
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            io.input_pipe = Some((req.wgsl.clone(), pipe));
        }
        let pipe = &io.input_pipe.as_ref().unwrap().1;
        let frame = io.frame.as_ref().expect("set_frame before an input pass");
        let view = frame.create_view(&Default::default());
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let uni = self.device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("input_uniform"),
            contents: bytemuck::cast_slice(&req.uniform),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let tone = self.static_storage("input_tone", bytemuck::cast_slice(&req.tone));
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipe.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: uni.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: tone.as_entire_binding() },
            ],
        });
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipe);
        pass.set_bind_group(0, &bg, &[]);
        pass.dispatch_workgroups(w.div_ceil(16), h.div_ceil(16), 1);
    }

    /// Encode the RGBA8 pack of `src` (n pixels); returns the packed buffer.
    fn encode_pack_pass(&self, encoder: &mut wgpu::CommandEncoder, req: &OutputPass, src: &wgpu::Buffer, n: u32) -> wgpu::Buffer {
        let mut io = self.io.lock().unwrap();
        let wgsl = req.wgsl.as_deref().unwrap_or(PACK_WGSL);
        if io.pack_pipe.as_ref().is_none_or(|(s, _)| s != wgsl) {
            let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("pack_rgba8"),
                source: wgpu::ShaderSource::Wgsl(Cow::Owned(wgsl.to_owned())),
            });
            let pipe = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("pack_rgba8"),
                layout: None,
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            io.pack_pipe = Some((wgsl.to_owned(), pipe));
        }
        let pipe = &io.pack_pipe.as_ref().unwrap().1;
        let groups = n.div_ceil(256);
        let gx = groups.min(65535);
        let gy = groups.div_ceil(gx);
        // Every pixel of `dst` is written by the pack pass.
        let dst = self.device.create_buffer_overwritten_t(&wgpu::BufferDescriptor {
            label: Some("packed"),
            size: n as u64 * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let lut_buf = self.static_storage("pack_lut", bytemuck::cast_slice(&req.lut));
        let mut params = vec![n as f32, (gx * 256) as f32, 0.0, 0.0];
        params.extend_from_slice(&req.params);
        let dims = self.device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("pack_params"),
            contents: bytemuck::cast_slice(&params),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipe.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: src.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: lut_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: dst.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: dims.as_entire_binding() },
            ],
        });
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipe);
        pass.set_bind_group(0, &bg, &[]);
        pass.dispatch_workgroups(gx, gy, 1);
        drop(pass);
        dst
    }

    /// Await a packed (`set_output_pack`) readback and hand `out` the mapped
    /// buffer, to copy from before it is unmapped. `get_mapped_range` copies
    /// into the wasm heap (which never shrinks), so `out` should take it in
    /// strips (`buffer.slice(a..b)`, offsets multiple of 8, views dropped
    /// before returning) rather than the whole frame at once.
    #[cfg(target_arch = "wasm32")]
    pub async fn take_readback_packed<F: FnOnce(&wgpu::Buffer)>(&self, out: F) -> Option<()> {
        let pending = self.pending_readback.lock().unwrap().take()?;
        if !pending.packed {
            return None;
        }
        if !matches!(pending.mapped.await, Ok(Ok(()))) {
            release_frame_buffers();
            return None;
        }
        out(&pending.buffer);
        pending.buffer.unmap();
        release_frame_buffers();
        Some(())
    }

    /// Await the readback left in flight by the last `run_film_chain` (wasm only).
    #[cfg(target_arch = "wasm32")]
    pub async fn take_readback(&self) -> Option<ImageBuf> {
        let pending = self.pending_readback.lock().unwrap().take()?;
        if pending.packed {
            return None;
        }
        if !matches!(pending.mapped.await, Ok(Ok(()))) {
            release_frame_buffers();
            return None;
        }
        let slice = pending.buffer.slice(..);
        let out: Vec<f32> = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
        pending.buffer.unmap();
        release_frame_buffers();
        Some(ImageBuf::from_data(pending.width, pending.height, out))
    }

    /// Get or compile + cache a pipeline keyed by shader source pointer.
    /// All shader sources come from `include_str!` so the pointer is stable.
    fn get_or_compile_pipeline<F>(
        &self,
        shader_source: &'static str,
        layout_entries_fn: F,
    ) -> std::sync::MutexGuard<'_, std::collections::HashMap<usize, CachedPipeline>>
    where
        F: FnOnce() -> Vec<wgpu::BindGroupLayoutEntry>,
    {
        let key = shader_source.as_ptr() as usize;
        let mut cache = self.pipeline_cache.lock().unwrap();
        if !cache.contains_key(&key) {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("compute_shader"),
                    source: wgpu::ShaderSource::Wgsl(wgsl_for_target(shader_source)),
                });
            let entries = layout_entries_fn();
            let bind_group_layout =
                self.device
                    .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                        label: Some("compute_layout"),
                        entries: &entries,
                    });
            let pipeline_layout =
                self.device
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("compute_pipeline_layout"),
                        bind_group_layouts: &[&bind_group_layout],
                        push_constant_ranges: &[],
                    });
            let pipeline = self
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("compute_pipeline"),
                    layout: Some(&pipeline_layout),
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                });
            cache.insert(
                key,
                CachedPipeline {
                    bind_group_layout,
                    pipeline,
                },
            );
        }
        cache
    }

    /// Generic GPU compute dispatch helper.
    ///
    /// `shader_source` must be a `'static str` (typically from `include_str!`) so
    /// the cache can key by pointer identity.
    fn dispatch_compute(
        &self,
        shader_source: &'static str,
        bindings: &[GpuBuffer],
        n_pixels: u32,
        output_idx: usize,
    ) -> Vec<f32> {
        let t_start = web_time::Instant::now();
        let layout_entries: Vec<wgpu::BindGroupLayoutEntry> = bindings
            .iter()
            .enumerate()
            .map(|(i, b)| wgpu::BindGroupLayoutEntry {
                binding: i as u32,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: b.binding_type,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            })
            .collect();
        let entries_for_compile = layout_entries.clone();
        let cache = self.get_or_compile_pipeline(shader_source, || entries_for_compile);
        let key = shader_source.as_ptr() as usize;
        let cached = cache.get(&key).expect("pipeline just inserted");
        let pipeline = &cached.pipeline;
        let bind_group_layout = &cached.bind_group_layout;
        let t_compile = t_start.elapsed();

        // Create GPU buffers
        let gpu_buffers: Vec<wgpu::Buffer> = bindings
            .iter()
            .map(|b| {
                self.device
                    .create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                        label: Some("buffer"),
                        contents: &b.data,
                        usage: b.usage,
                    })
            })
            .collect();

        let bind_entries: Vec<wgpu::BindGroupEntry> = gpu_buffers
            .iter()
            .enumerate()
            .map(|(i, buf)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource: buf.as_entire_binding(),
            })
            .collect();

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compute_bind_group"),
            layout: &bind_group_layout,
            entries: &bind_entries,
        });

        // Readback buffer
        let output_size = bindings[output_idx].data.len() as u64;
        let readback = self.device.create_buffer_t(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: output_size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Dispatch
        let workgroup_size = WG_1D;
        let num_workgroups = (n_pixels + workgroup_size - 1) / workgroup_size;

        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("compute_pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(num_workgroups, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&gpu_buffers[output_idx], 0, &readback, 0, output_size);
        self.queue.submit(Some(encoder.finish()));

        // Read back
        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            tx.send(r).unwrap();
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();

        let data = slice.get_mapped_range();
        let result: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
        drop(data);
        readback.unmap();
        let _t_total = t_start.elapsed();
        let _ = t_compile;
        result
    }

    /// GPU separable Gaussian blur via two FIR passes (horizontal then vertical).
    /// Kernel weights are computed on CPU and uploaded as a storage buffer.
    /// Two ping-pong image buffers minimize allocations.
    pub fn gaussian_blur_gpu(&self, img: &ImageBuf, sigma: f32) -> ImageBuf {
        let radius = fir_blur_radius(sigma);
        let kernel_size = (2 * radius + 1) as usize;

        // Pre-compute normalized Gaussian kernel on CPU.
        let sigma_f64 = sigma as f64;
        let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
        let mut kernel = Vec::with_capacity(kernel_size);
        let r_i32 = radius as i32;
        for i in 0..kernel_size {
            let x = (i as i32 - r_i32) as f64;
            kernel.push((-x * x / two_sigma_sq).exp());
        }
        let sum: f64 = kernel.iter().sum();
        let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

        let w = img.width;
        let h = img.height;
        let n_pixels = (w as usize) * (h as usize);
        let img_bytes = n_pixels * 3 * 4;

        let make_buf = |label: &str| {
            self.device.create_buffer_t(&wgpu::BufferDescriptor {
                label: Some(label),
                size: img_bytes as u64,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let buf_in = make_buf("blur_in");
        let buf_mid = make_buf("blur_mid");
        let buf_out = make_buf("blur_out");

        let input_f32 = scalars_to_f32(&img.data);
        self.queue
            .write_buffer(&buf_in, 0, bytemuck::cast_slice(&input_f32));

        let kernel_buf = self
            .device
            .create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                label: Some("gaussian_kernel"),
                contents: bytemuck::cast_slice(&kernel_f32),
                usage: wgpu::BufferUsages::STORAGE,
            });

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct Params {
            width: u32,
            height: u32,
            radius: u32,
            _pad: u32,
        }
        let params = Params {
            width: w,
            height: h,
            radius,
            _pad: 0,
        };
        let params_buf = self
            .device
            .create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                label: Some("gaussian_params"),
                contents: bytemuck::bytes_of(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let layout = &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ];
        let h_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
            layout,
        );
        let v_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
            layout,
        );

        let bg_h = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg_blur_h"),
            layout: &h_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_in.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: buf_mid.as_entire_binding(),
                },
            ],
        });
        let bg_v = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg_blur_v"),
            layout: &v_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_mid.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: buf_out.as_entire_binding(),
                },
            ],
        });

        let readback = self.device.create_buffer_t(&wgpu::BufferDescriptor {
            label: Some("blur_readback"),
            size: img_bytes as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let wg_x = w.div_ceil(16);
        let wg_y = h.div_ceil(16);
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("blur_h"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&h_pipe.pipeline);
            pass.set_bind_group(0, &bg_h, &[]);
            pass.dispatch_workgroups(wg_x, wg_y, 1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("blur_v"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&v_pipe.pipeline);
            pass.set_bind_group(0, &bg_v, &[]);
            pass.dispatch_workgroups(wg_x, wg_y, 1);
        }
        encoder.copy_buffer_to_buffer(&buf_out, 0, &readback, 0, img_bytes as u64);
        self.queue.submit(Some(encoder.finish()));

        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            tx.send(r).unwrap();
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();
        let data = slice.get_mapped_range();
        let out_f32: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
        drop(data);
        readback.unmap();

        ImageBuf::from_data(w, h, f32_to_scalars(out_f32))
    }

    /// Blur `img` with every sigma in `sigmas`, all within a single command
    /// buffer. One upload, N pairs of H/V dispatches, one submit, one
    /// readback that fans out into N output `ImageBuf`s.
    ///
    /// Used by halation (multi-bounce blurs of the same source) and any
    /// caller that needs the same input at several radii.
    pub fn gaussian_blur_multi_gpu(&self, img: &ImageBuf, sigmas: &[f32]) -> Vec<ImageBuf> {
        assert!(!sigmas.is_empty(), "gaussian_blur_multi_gpu: empty sigmas");

        let w = img.width;
        let h = img.height;
        let n_pixels = (w as usize) * (h as usize);
        let img_bytes = n_pixels * 3 * 4;

        let make_buf = |label: &str| {
            self.device.create_buffer_t(&wgpu::BufferDescriptor {
                label: Some(label),
                size: img_bytes as u64,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };

        // Input is uploaded once. Mid is shared between the H and V passes
        // of each sigma — wgpu inserts a barrier between compute passes so
        // pass N's H write of `mid` waits on pass N-1's V read.
        let buf_in = make_buf("blur_multi_in");
        let buf_mid = make_buf("blur_multi_mid");

        let input_f32 = scalars_to_f32(&img.data);
        self.queue
            .write_buffer(&buf_in, 0, bytemuck::cast_slice(&input_f32));

        // One output buffer per sigma.
        let bufs_out: Vec<_> = (0..sigmas.len())
            .map(|i| make_buf(&format!("blur_multi_out_{i}")))
            .collect();

        // Pipelines (cached across calls).
        let layout = &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ];
        let h_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
            layout,
        );
        let v_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
            layout,
        );

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct Params {
            width: u32,
            height: u32,
            radius: u32,
            _pad: u32,
        }

        // Pre-build per-sigma kernel/params/bind groups. The struct owns
        // the kernel/params buffers so they outlive the encoder.
        #[allow(dead_code)]
        struct PerSigma {
            params_buf: wgpu::Buffer,
            kernel_buf: wgpu::Buffer,
            bg_h: wgpu::BindGroup,
            bg_v: wgpu::BindGroup,
        }

        let per_sigma: Vec<PerSigma> = sigmas
            .iter()
            .enumerate()
            .map(|(i, &sigma)| {
                let radius = fir_blur_radius(sigma);
                let kernel_size = (2 * radius + 1) as usize;
                let sigma_f64 = sigma as f64;
                let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
                let r_i32 = radius as i32;
                let mut kernel = Vec::with_capacity(kernel_size);
                for k in 0..kernel_size {
                    let x = (k as i32 - r_i32) as f64;
                    kernel.push((-x * x / two_sigma_sq).exp());
                }
                let sum: f64 = kernel.iter().sum();
                let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

                let kernel_buf =
                    self.device
                        .create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                            label: Some(&format!("blur_multi_kernel_{i}")),
                            contents: bytemuck::cast_slice(&kernel_f32),
                            usage: wgpu::BufferUsages::STORAGE,
                        });

                let params = Params {
                    width: w,
                    height: h,
                    radius,
                    _pad: 0,
                };
                let params_buf =
                    self.device
                        .create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                            label: Some(&format!("blur_multi_params_{i}")),
                            contents: bytemuck::bytes_of(&params),
                            usage: wgpu::BufferUsages::UNIFORM,
                        });

                let bg_h = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(&format!("bg_blur_multi_h_{i}")),
                    layout: &h_pipe.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: params_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: buf_in.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: kernel_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: buf_mid.as_entire_binding(),
                        },
                    ],
                });
                let bg_v = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(&format!("bg_blur_multi_v_{i}")),
                    layout: &v_pipe.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: params_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: buf_mid.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: kernel_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: bufs_out[i].as_entire_binding(),
                        },
                    ],
                });

                PerSigma {
                    params_buf,
                    kernel_buf,
                    bg_h,
                    bg_v,
                }
            })
            .collect();

        // One readback buffer per sigma — wgpu caps a single buffer at
        // ~256 MB on Metal, so a 4×6 MP combined readback would overflow.
        // Per-sigma buffers stay well under the cap (72 MB at 6 MP).
        let readbacks: Vec<_> = (0..sigmas.len())
            .map(|i| {
                self.device.create_buffer_t(&wgpu::BufferDescriptor {
                    label: Some(&format!("blur_multi_readback_{i}")),
                    size: img_bytes as u64,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();

        let wg_x = w.div_ceil(16);
        let wg_y = h.div_ceil(16);
        let mut encoder = self.device.create_command_encoder(&Default::default());
        for (i, ps) in per_sigma.iter().enumerate() {
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some(&format!("blur_multi_h_{i}")),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&h_pipe.pipeline);
                pass.set_bind_group(0, &ps.bg_h, &[]);
                pass.dispatch_workgroups(wg_x, wg_y, 1);
            }
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some(&format!("blur_multi_v_{i}")),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&v_pipe.pipeline);
                pass.set_bind_group(0, &ps.bg_v, &[]);
                pass.dispatch_workgroups(wg_x, wg_y, 1);
            }
            encoder.copy_buffer_to_buffer(&bufs_out[i], 0, &readbacks[i], 0, img_bytes as u64);
        }
        // `per_sigma` and `bufs_out` are alive until the function returns,
        // which is after `queue.submit()` — so all referenced buffers stay
        // valid for the encoded work.
        self.queue.submit(Some(encoder.finish()));

        // Map every readback, then poll once.
        for rb in &readbacks {
            let slice = rb.slice(..);
            slice.map_async(wgpu::MapMode::Read, |r| r.unwrap());
        }
        self.device.poll(wgpu::Maintain::Wait);

        let mut out_imgs = Vec::with_capacity(sigmas.len());
        for rb in &readbacks {
            let slice = rb.slice(..);
            let data = slice.get_mapped_range();
            let chunk: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
            out_imgs.push(ImageBuf::from_data(w, h, f32_to_scalars(chunk)));
            drop(data);
            rb.unmap();
        }

        out_imgs
    }

    /// GPU-resident pipeline: runs the front pass (hanatos LUT lookup or
    /// mallett matmul), highlight boost, camera diffusion/lens blur,
    /// halation, density curves, DIR, grain, print spectral, enlarger
    /// diffusion, scan spectral, glare, gamut compression, scanner lens blur,
    /// and unsharp as a single command buffer with ping-pong image storage.
    /// Only one upload at the start and one readback at the end.
    pub fn run_film_chain(&self, p: &crate::FilmChainParams<'_>) -> ImageBuf {
        let t_start = web_time::Instant::now();
        // Pull all references into locals so the existing body below
        // doesn't need a rewrite — only the param sources change.
        let image = p.image;
        let film_log_exposure = p.film_log_exposure;
        let film_density_curves_normalized = p.film_density_curves_normalized;
        let film_gamma = p.film_gamma;
        let film_channel_density = p.film_channel_density;
        let film_base_density = p.film_base_density;
        let print_illuminant = p.print_illuminant;
        let print_sensitivity = p.print_sensitivity;
        let print_normalization_factor = p.print_normalization_factor;
        let print_log_exposure = p.print_log_exposure;
        let print_density_curves = p.print_density_curves;
        let print_gamma = p.print_gamma;
        let preflash = p.preflash;
        let print_channel_density = p.print_channel_density;
        let print_base_density = p.print_base_density;
        let viewing_illuminant = p.viewing_illuminant;
        let scan_normalization = p.scan_normalization;
        let scan_xyz_to_rgb = p.scan_xyz_to_rgb;

        let n_pixels = image.pixel_count() as u32;
        let img_bytes = n_pixels as usize * 3 * 4;
        pool_batching(true);

        // Ping-pong image buffers (each holds H*W*3 f32 values).
        let make_img_buf = |label: &str| {
            // Fully written (input pass / front pass / upload) before any read.
            self.device.create_buffer_overwritten_t(&wgpu::BufferDescriptor {
                label: Some(label),
                size: img_bytes as u64,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let mappable = self
            .device
            .features()
            .contains(wgpu::Features::MAPPABLE_PRIMARY_BUFFERS);

        // buf_a is the input/ping-pong buffer. The dominant per-frame cost was
        // the input upload: `queue.write_buffer` stages CPU→GPU through a slow
        // (~0.5 GB/s) blit on this unified-memory GPU. With
        // MAPPABLE_PRIMARY_BUFFERS we create buf_a already mapped (MAP_WRITE)
        // and memcpy the input straight into its (shared) memory — no staging.
        let (input_req, pack_req) = {
            let mut io = self.io.lock().unwrap();
            (io.input.take(), io.pack.take())
        };
        let input_f32 = scalars_to_f32(&image.data);
        let buf_a = if input_req.is_some() {
            make_img_buf("img_a")   // filled by the input pass
        } else if mappable {
            let buf = self.device.create_buffer_t(&wgpu::BufferDescriptor {
                label: Some("img_a"),
                size: img_bytes as u64,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::MAP_WRITE,
                mapped_at_creation: true,
            });
            buf.slice(..)
                .get_mapped_range_mut()
                .copy_from_slice(bytemuck::cast_slice(&input_f32));
            buf.unmap();
            buf
        } else {
            let buf = make_img_buf("img_a");
            self.queue
                .write_buffer(&buf, 0, bytemuck::cast_slice(&input_f32));
            buf
        };

        // buf_b holds the final RGB. With MAPPABLE_PRIMARY_BUFFERS we add
        // MAP_READ so it can be mapped directly for a zero-copy readback,
        // skipping the slow Private→Shared blit on unified memory.
        let buf_b = {
            let mut usage = wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC;
            if mappable {
                usage |= wgpu::BufferUsages::MAP_READ;
            }
            self.device.create_buffer_overwritten_t(&wgpu::BufferDescriptor {
                label: Some("img_b"),
                size: img_bytes as u64,
                usage,
                mapped_at_creation: false,
            })
        };

        // Static (LUT) buffers — uploaded once.
        let mk_storage = |label: &'static str, bytes: &[u8]| self.static_storage(label, bytes);
        let mk_uniform = |label: &str, bytes: &[u8]| {
            self.device
                .create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        };

        // ── Pre-compute every static GPU-side buffer ─────────────────────
        // Filming density curves — already normalized by caller.
        let film_log_exp_f32: Vec<f32> = film_log_exposure.iter().map(|&v| v as f32).collect();
        let film_curves_f32: Vec<f32> = film_density_curves_normalized
            .iter()
            .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
            .collect();
        let film_log_exp_buf = mk_storage("film_log_exp", bytemuck::cast_slice(&film_log_exp_f32));
        let film_curves_buf = mk_storage("film_curves", bytemuck::cast_slice(&film_curves_f32));

        // Film spectral data (for printing pass).
        let (film_cd_f32, mut film_bd_f32) = sanitize_spectral_inputs(
            film_channel_density,
            film_base_density,
            film_channel_density.len(),
        );
        film_bd_f32.resize(film_channel_density.len(), 0.0);
        let film_cd_buf = mk_storage("film_cd", bytemuck::cast_slice(&film_cd_f32));
        let film_bd_buf = mk_storage("film_bd", bytemuck::cast_slice(&film_bd_f32));

        let print_illu_f32: Vec<f32> = print_illuminant.iter().map(|&v| v as f32).collect();
        let print_sens_f32: Vec<f32> = print_sensitivity
            .iter()
            .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
            .collect();
        let print_illu_buf = mk_storage("print_illu", bytemuck::cast_slice(&print_illu_f32));
        let print_sens_buf = mk_storage("print_sens", bytemuck::cast_slice(&print_sens_f32));

        // Print density curves (RAW, no normalization for print path).
        let print_log_exp_f32: Vec<f32> = print_log_exposure.iter().map(|&v| v as f32).collect();
        let print_curves_f32: Vec<f32> = print_density_curves
            .iter()
            .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
            .collect();
        let print_log_exp_buf =
            mk_storage("print_log_exp", bytemuck::cast_slice(&print_log_exp_f32));
        let print_curves_buf = mk_storage("print_curves", bytemuck::cast_slice(&print_curves_f32));

        // Spectral dye-density data for the scanning pass. For scan_film we
        // scan the developed film directly, so feed the film's spectral
        // densities; otherwise the print's. (print_spectral uses
        // sensitivity, not these — this buffer feeds only scan_spectral.)
        let (scan_cd_src, scan_bd_src): (&[[f64; 3]], &[f64]) = if p.scan_film {
            (film_channel_density, film_base_density)
        } else {
            (print_channel_density, print_base_density)
        };
        let (scan_cd_f32, mut scan_bd_f32) =
            sanitize_spectral_inputs(scan_cd_src, scan_bd_src, scan_cd_src.len());
        scan_bd_f32.resize(scan_cd_src.len(), 0.0);
        let scan_cd_buf = mk_storage("scan_cd", bytemuck::cast_slice(&scan_cd_f32));
        let scan_bd_buf = mk_storage("scan_bd", bytemuck::cast_slice(&scan_bd_f32));

        let view_illu_f32: Vec<f32> = viewing_illuminant.iter().map(|&v| v as f32).collect();
        let view_illu_buf = mk_storage("view_illu", bytemuck::cast_slice(&view_illu_f32));
        let cmf_x_buf = mk_storage(
            "cmf_x",
            bytemuck::cast_slice(&spektrafilm_math::spectral::CMF_X),
        );
        let cmf_y_buf = mk_storage(
            "cmf_y",
            bytemuck::cast_slice(&spektrafilm_math::spectral::CMF_Y),
        );
        let cmf_z_buf = mk_storage(
            "cmf_z",
            bytemuck::cast_slice(&spektrafilm_math::spectral::CMF_Z),
        );

        // ── Param structs ────────────────────────────────────────────────
        // Front pass (hanatos LUT lookup or mallett matmul). Both shaders
        // share this uniform layout; `lut_size` is hanatos-only (0 for
        // mallett, where the field is a pad).
        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct FrontParams {
            width: u32,
            height: u32,
            lut_size: u32,
            _pad: u32,
            col0: [f32; 4],
            col1: [f32; 4],
            col2: [f32; 4],
        }
        let (m, front_lut_size) = match &p.front {
            crate::FrontPass::Hanatos2025 {
                tc_lut,
                rgb_to_adapted_xyz,
            } => (rgb_to_adapted_xyz, tc_lut.size as u32),
            crate::FrontPass::Mallett2019 { matrix } => (matrix, 0u32),
        };
        let front_params = FrontParams {
            width: image.width,
            height: image.height,
            lut_size: front_lut_size,
            _pad: 0,
            col0: [m[0][0] as f32, m[1][0] as f32, m[2][0] as f32, 0.0],
            col1: [m[0][1] as f32, m[1][1] as f32, m[2][1] as f32, 0.0],
            col2: [m[0][2] as f32, m[1][2] as f32, m[2][2] as f32, 0.0],
        };
        let front_params_buf = mk_uniform("front_params", bytemuck::bytes_of(&front_params));

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct DensityParams {
            width: u32,
            height: u32,
            k: u32,
            uniform_grid: u32,
            gamma_inv: [f32; 3],
            _pad: f32,
        }
        let film_density_params = DensityParams {
            width: image.width,
            height: image.height,
            k: film_log_exposure.len() as u32,
            uniform_grid: if is_uniform(film_log_exposure) { 1 } else { 0 },
            gamma_inv: [(1.0 / film_gamma) as f32; 3],
            _pad: 0.0,
        };
        let film_density_params_buf =
            mk_uniform("film_dens_params", bytemuck::bytes_of(&film_density_params));

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct PrintParams {
            width: u32,
            height: u32,
            n_wavelengths: u32,
            normalization_factor: f32,
            preflash: [f32; 3],
            _pad: f32,
        }
        let has_enlarger_diffusion = p.enlarger_diffusion.is_some();
        let print_exposure_scale = p.print_exposure_scale as f32;
        let print_norm_for_shader = if has_enlarger_diffusion && print_exposure_scale != 0.0 {
            (print_normalization_factor / p.print_exposure_scale) as f32
        } else {
            print_normalization_factor as f32
        };
        let print_params = PrintParams {
            width: image.width,
            height: image.height,
            n_wavelengths: film_channel_density.len() as u32,
            normalization_factor: print_norm_for_shader,
            preflash: [preflash[0] as f32, preflash[1] as f32, preflash[2] as f32],
            _pad: 0.0,
        };
        let print_params_buf = mk_uniform("print_params", bytemuck::bytes_of(&print_params));

        let print_density_params = DensityParams {
            width: image.width,
            height: image.height,
            k: print_log_exposure.len() as u32,
            uniform_grid: if is_uniform(print_log_exposure) { 1 } else { 0 },
            gamma_inv: [(1.0 / print_gamma) as f32; 3],
            _pad: 0.0,
        };
        let print_density_params_buf = mk_uniform(
            "print_dens_params",
            bytemuck::bytes_of(&print_density_params),
        );

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct ScanParams {
            width: u32,
            height: u32,
            n_wavelengths: u32,
            normalization: f32,
            col0: [f32; 4],
            col1: [f32; 4],
            col2: [f32; 4],
            bw: [f32; 4],
        }
        let s = scan_xyz_to_rgb;
        // B&W/slide luminance remap (m, q); z=1 enables it in the shader.
        // w=1 skips the shader's [0,1] clamp — required when the gamut
        // compression pass follows (it needs the out-of-gamut values).
        let skip_clamp = if p.gamut.is_some() { 1.0 } else { 0.0 };
        let bw = match p.bw_xyz_remap {
            Some((m, q)) => [m as f32, q as f32, 1.0, skip_clamp],
            None => [1.0, 0.0, 0.0, skip_clamp],
        };
        let scan_params = ScanParams {
            width: image.width,
            height: image.height,
            n_wavelengths: scan_cd_src.len() as u32,
            normalization: scan_normalization as f32,
            col0: [s[0][0] as f32, s[1][0] as f32, s[2][0] as f32, 0.0],
            col1: [s[0][1] as f32, s[1][1] as f32, s[2][1] as f32, 0.0],
            col2: [s[0][2] as f32, s[1][2] as f32, s[2][2] as f32, 0.0],
            bw,
        };
        let scan_params_buf = mk_uniform("scan_params", bytemuck::bytes_of(&scan_params));

        // ── Pre-compile pipelines (cached after first call) ──────────────
        // Each shader's bindings layout is fixed and known here.
        let density_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/density_curve_interp.wgsl"),
            &[
                wgpu::BufferBindingType::Uniform,
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: false },
            ],
        );
        let print_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/print_spectral.wgsl"),
            &[
                wgpu::BufferBindingType::Uniform,
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: false },
            ],
        );
        let scan_pipe = self.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/scan_spectral.wgsl"),
            &[
                wgpu::BufferBindingType::Uniform,
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: true },
                wgpu::BufferBindingType::Storage { read_only: false },
            ],
        );

        // ── Build bind groups (per dispatch, but no buffer creation) ─────
        let workgroup_size = WG_1D;

        // Front pass: hanatos (params + rgb_in + tc_lut + raw_out) or mallett
        // (params + rgb_in + raw_out). The tc_lut buffer rides along in the
        // tuple to outlive the encoder on the hanatos arm.
        let (front_pipe, bg_front, _front_tc_lut) = match &p.front {
            crate::FrontPass::Hanatos2025 { tc_lut, .. } => {
                let tc_lut_buf = self.static_storage_f64("tc_lut", &tc_lut.data);
                let pipe = self.cached_pipeline(
                    include_str!("../../spektrafilm-shaders/wgsl/hanatos2025_rgb_to_raw.wgsl"),
                    &[
                        wgpu::BufferBindingType::Uniform,
                        wgpu::BufferBindingType::Storage { read_only: true },
                        wgpu::BufferBindingType::Storage { read_only: true },
                        wgpu::BufferBindingType::Storage { read_only: false },
                    ],
                );
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("bg_hanatos"),
                    layout: &pipe.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: front_params_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: buf_a.as_entire_binding(),
                        }, // rgb_in
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: tc_lut_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: buf_b.as_entire_binding(),
                        }, // raw_out
                    ],
                });
                (pipe, bg, Some(tc_lut_buf))
            }
            crate::FrontPass::Mallett2019 { .. } => {
                let pipe = self.cached_pipeline(
                    include_str!("../../spektrafilm-shaders/wgsl/mallett_rgb_to_raw.wgsl"),
                    &[
                        wgpu::BufferBindingType::Uniform,
                        wgpu::BufferBindingType::Storage { read_only: true },
                        wgpu::BufferBindingType::Storage { read_only: false },
                    ],
                );
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("bg_mallett"),
                    layout: &pipe.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: front_params_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: buf_a.as_entire_binding(),
                        }, // rgb_in
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: buf_b.as_entire_binding(),
                        }, // raw_out
                    ],
                });
                (pipe, bg, None)
            }
        };
        // After the front pass: log10 + density curve interp into normalized
        // film curves. The front pass outputs raw (not log_raw), so a small
        // log10 shader transforms buf_b in-place, then density_curve_interp
        // reads buf_b → buf_a.

        let bg_log10 = {
            let pipe = self.cached_pipeline(
                include_str!("../../spektrafilm-shaders/wgsl/log10_inplace.wgsl"),
                &[
                    wgpu::BufferBindingType::Uniform,
                    wgpu::BufferBindingType::Storage { read_only: false },
                ],
            );
            #[repr(C)]
            #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
            struct Log10Params {
                // WGSL struct: `n: u32 + _pad: vec3<u32>`. vec3 has 16-byte alignment,
                // so the struct is 32 bytes total. We pad on the Rust side accordingly.
                n_pixels: u32,
                _pad: [u32; 7],
            }
            let log10_params_buf = mk_uniform(
                "log10_params",
                bytemuck::bytes_of(&Log10Params {
                    n_pixels,
                    _pad: [0; 7],
                }),
            );
            let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("bg_log10"),
                layout: &pipe.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: log10_params_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: buf_b.as_entire_binding(),
                    },
                ],
            });
            // Return both the buffer (to keep it alive) and the bind group.
            (pipe, bg, log10_params_buf)
        };

        let bg_density_film = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg_density_film"),
            layout: &density_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: film_density_params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_b.as_entire_binding(),
                }, // log_raw
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: film_log_exp_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: film_curves_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: buf_a.as_entire_binding(),
                }, // density_cmy
            ],
        });
        let bg_print = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg_print"),
            layout: &print_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: print_params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_a.as_entire_binding(),
                }, // density_cmy
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: film_cd_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: film_bd_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: print_illu_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: print_sens_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: buf_b.as_entire_binding(),
                }, // log_raw_print
            ],
        });
        let bg_density_print = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg_density_print"),
            layout: &density_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: print_density_params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_b.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: print_log_exp_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: print_curves_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: buf_a.as_entire_binding(),
                },
            ],
        });
        let bg_scan = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg_scan"),
            layout: &scan_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: scan_params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_a.as_entire_binding(),
                }, // density_print
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: scan_cd_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: scan_bd_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: view_illu_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: cmf_x_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: cmf_y_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: cmf_z_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: buf_b.as_entire_binding(),
                }, // final rgb
            ],
        });

        // Readback buffer (for the final image only) — only needed when we
        // can't map buf_b directly. Skipping it on the mappable path also
        // avoids allocating a second full-image buffer per frame.
        let readback_bytes = if pack_req.is_some() { n_pixels as u64 * 4 } else { img_bytes as u64 };
        let readback = (!mappable || pack_req.is_some()).then(|| {
            // Fully overwritten by the copy below.
            self.device.create_buffer_overwritten_t(&wgpu::BufferDescriptor {
                label: Some("readback"),
                size: readback_bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        });

        // ── Halation auxiliary buffers + bind groups (only if active) ────
        // Allocated up-front so they live for the encoder. The two ping-pong
        // buffers `buf_a` / `buf_b` are reused as blur input/mid; the new
        // `buf_c` and `buf_d` hold the scatter outputs and the halation
        // accumulator. None of this is touched when `p.halation` is `None`.
        let halation_state = p.halation.as_ref().map(|hp| {
            build_halation_state(
                &self.device,
                hp,
                image.width,
                image.height,
                &buf_a,
                &buf_b,
                self,
            )
        });

        // ── Highlight boost state ────────────────────────────────────────
        // Runs on raw film exposure immediately after the front pass.
        let highlight_state = p.highlight_boost.as_ref().map(|hp| {
            build_highlight_boost_state(&self.device, hp, n_pixels, &buf_b, self)
        });

        // ── Camera diffusion filter state ────────────────────────────────
        // Applied on the raw film exposure (buf_b) right after hanatos and
        // before halation, matching the CPU filming order. Owns its own
        // downsampled scratch buffers.
        let diffusion_state = p.diffusion.as_ref().map(|plan| {
            build_diffusion_state(&self.device, plan, image.width, image.height, &buf_b, self)
        });

        let camera_lens_blur_state = p.camera_lens_blur_px.and_then(|sigma| {
            (sigma > 0.0).then(|| {
                build_simple_blur_state(
                    &self.device,
                    sigma,
                    image.width,
                    image.height,
                    &buf_b,
                    &buf_a,
                    "camera_lens",
                    self,
                )
            })
        });

        // ── Unsharp mask state ───────────────────────────────────────────
        // Last pass before readback. Blurs buf_b → buf_c (via buf_a mid),
        // then combines: buf_b_out = (1+amount)*buf_b - amount*buf_c.
        // Since the combine writes back to buf_b in-place we need to
        // route via a temporary buffer to satisfy wgpu aliasing rules.
        let unsharp_state = p.unsharp.as_ref().map(|up| {
            build_unsharp_state(
                &self.device,
                up,
                image.width,
                image.height,
                &buf_a,
                &buf_b,
                self,
            )
        });

        // ── Output gamut compression state ───────────────────────────────
        // Single per-pixel dispatch in place on buf_b, after glare and
        // before unsharp (the CPU scanning order). The C_max table is
        // baked once at pipeline construction; only the upload happens here.
        let gamut_state = p
            .gamut
            .as_ref()
            .map(|gp| build_gamut_state(&self.device, gp, &buf_b, n_pixels, self));

        // ── Glare state ──────────────────────────────────────────────────
        // Applied in place on buf_b (the scan_spectral output) just before
        // readback. Generates per-pixel lognormal noise into a scratch
        // buffer, optionally blurs it, then adds `g * rgb_offset[c]` to
        // the image. Uses buf_a (free after scan_spectral consumed
        // density_cmy) and one fresh scratch buffer.
        let glare_state = p.glare.as_ref().map(|gp| {
            build_glare_state(
                &self.device,
                gp,
                image.width,
                image.height,
                &buf_a,
                &buf_b,
                self,
            )
        });

        let scanner_lens_blur_state = p.scanner_lens_blur_px.and_then(|sigma| {
            (sigma > 0.0).then(|| {
                build_simple_blur_state(
                    &self.device,
                    sigma,
                    image.width,
                    image.height,
                    &buf_b,
                    &buf_a,
                    "scanner_lens",
                    self,
                )
            })
        });

        // ── Grain state ──────────────────────────────────────────────────
        // Applied in place on buf_a (density_cmy) after DIR couplers,
        // before print_spectral. Optionally followed by a Gaussian
        // post-blur (uses buf_b as mid, since log_raw_corrected in buf_b
        // is no longer needed after DIR's final density_curve_0).
        let grain_state = p.grain.as_ref().map(|gp| {
            build_grain_state(
                &self.device,
                gp,
                image.width,
                image.height,
                &buf_a,
                &buf_b,
                self,
            )
        });

        // ── DIR couplers state ────────────────────────────────────────────
        // Allocated lazily when the DIR stage is active. Reads buf_a
        // (density_cmy from film density curve) and buf_b (log_raw),
        // produces a corrected buf_a via re-interpolation of
        // `density_curves_0` against `log_raw - correction`. Uses three
        // owned scratch buffers (correction, mid, accumulator). buf_a is
        // reused as blur mid since density_cmy is no longer needed once
        // the matmul has consumed it (the final density_curve_interp
        // overwrites buf_a anyway).
        let dir_state = p.dir_couplers.as_ref().map(|dp| {
            build_dir_state(
                &self.device,
                dp,
                image.width,
                image.height,
                &buf_a,
                &buf_b,
                self,
            )
        });

        let enlarger_log_to_linear_state = p.enlarger_diffusion.as_ref().map(|_| {
            build_log_to_linear_state(&self.device, n_pixels, print_exposure_scale, &buf_b, self)
        });
        let enlarger_diffusion_state = p.enlarger_diffusion.as_ref().map(|plan| {
            build_diffusion_state(&self.device, plan, image.width, image.height, &buf_b, self)
        });
        let enlarger_linear_to_log_state = p
            .enlarger_diffusion
            .as_ref()
            .map(|_| build_linear_to_log_state(&self.device, n_pixels, &buf_b, self));
        let post_scan_state =
            build_post_scan_state(&self.device, n_pixels, p.output_cctf_encoding, &buf_b, self);

        // ── Single command buffer chaining everything ────────────────────
        let mut encoder = self.device.create_command_encoder(&Default::default());
        flush_pending_clears(&mut encoder);
        if let Some(req) = input_req.as_ref() {
            self.encode_input_pass(&mut encoder, req, &buf_a, image.width, image.height);
        }
        let dispatch = |encoder: &mut wgpu::CommandEncoder,
                        pipe: &wgpu::ComputePipeline,
                        bg: &wgpu::BindGroup,
                        n: u32| {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, bg, &[]);
            pass.dispatch_workgroups((n + workgroup_size - 1) / workgroup_size, 1, 1);
        };

        // 1. Front pass (hanatos or mallett): buf_a (rgb in) → buf_b (raw)
        dispatch(&mut encoder, &front_pipe.pipeline, &bg_front, n_pixels);
        // 1a. Highlight boost on raw, before optical scatter.
        if let Some(hs) = highlight_state.as_ref() {
            hs.encode_passes(&mut encoder);
        }
        // 1a. Camera diffusion filter in-place on buf_b (raw), before
        //     halation — mirrors the CPU filming order.
        if let Some(ds) = diffusion_state.as_ref() {
            ds.encode_passes(&mut encoder, &buf_b);
        }
        // 1b. Camera lens blur on raw, after camera diffusion and before halation.
        if let Some(bs) = camera_lens_blur_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            bs.encode_passes(&mut encoder, wg_xy, &buf_b);
        }
        // 1b. Halation in-place on buf_b. Uses buf_a as blur scratch (the
        //     input RGB image is no longer needed), buf_c / buf_d for the
        //     scatter outputs and halation accumulator.
        if let Some(hs) = halation_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            hs.encode_passes(&mut encoder, n_pixels, workgroup_size, wg_xy);
        }
        // 2. log10 in-place on buf_b: raw → log_raw (3 channels per thread).
        let (log10_pipe, log10_bg, _keepalive) = &bg_log10;
        dispatch(&mut encoder, &log10_pipe.pipeline, log10_bg, n_pixels);
        // 3. Density curve (film, normalized): buf_b (log_raw) → buf_a (density_cmy)
        dispatch(
            &mut encoder,
            &density_pipe.pipeline,
            &bg_density_film,
            n_pixels,
        );
        // 3b. DIR couplers (operates on buf_a, mutates buf_b → log_raw_corrected,
        //     re-interps density curve back into buf_a).
        if let Some(ds) = dir_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            ds.encode_passes(&mut encoder, n_pixels, workgroup_size, wg_xy);
        }
        // 3c. Grain (in-place on buf_a, optional post-blur via buf_b mid).
        if let Some(gs) = grain_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            gs.encode_passes(&mut encoder, n_pixels, workgroup_size, wg_xy);
        }
        // 4 + 5. Printing: print_spectral (buf_a → buf_b) then the print
        //     density curve (buf_b → buf_a). Skipped for scan_film — the
        //     scan pass consumes the film density already in buf_a.
        if !p.scan_film {
            // 4. Print spectral: buf_a → buf_b (log_raw_print)
            dispatch(&mut encoder, &print_pipe.pipeline, &bg_print, n_pixels);
            if let (Some(l2l), Some(ds), Some(l2g)) = (
                enlarger_log_to_linear_state.as_ref(),
                enlarger_diffusion_state.as_ref(),
                enlarger_linear_to_log_state.as_ref(),
            ) {
                l2l.encode_passes(&mut encoder, n_pixels);
                ds.encode_passes(&mut encoder, &buf_b);
                l2g.encode_passes(&mut encoder, n_pixels);
            }
            // 5. Density curve (print, raw curves): buf_b → buf_a (density_print)
            dispatch(
                &mut encoder,
                &density_pipe.pipeline,
                &bg_density_print,
                n_pixels,
            );
        }
        // 6. Scan spectral: buf_a → buf_b (final rgb, clamped, NOT sRGB-encoded)
        dispatch(&mut encoder, &scan_pipe.pipeline, &bg_scan, n_pixels);
        // 6b. Glare (in place on buf_b).
        if let Some(gs) = glare_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            gs.encode_passes(&mut encoder, n_pixels, workgroup_size, wg_xy);
        }
        // 6c. Output gamut compression (in place on buf_b) — after glare,
        //     before unsharp, mirroring the CPU scanning order.
        if let Some(gs) = gamut_state.as_ref() {
            gs.encode_passes(&mut encoder, n_pixels, workgroup_size);
        }
        // 6d. Scanner lens blur — after glare/gamut, before unsharp.
        if let Some(bs) = scanner_lens_blur_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            bs.encode_passes(&mut encoder, wg_xy, &buf_b);
        }
        // 6d. Unsharp mask — last in-flight pass. Writes the final image
        //     back to buf_b so the readback path below is unchanged.
        if let Some(us) = unsharp_state.as_ref() {
            let wg_xy = (image.width.div_ceil(16), image.height.div_ceil(16));
            us.encode_passes(
                &mut encoder,
                n_pixels,
                workgroup_size,
                wg_xy,
                &buf_b,
                img_bytes as u64,
            );
        }
        // 6e. Final clamp + optional sRGB encode. This mirrors
        // Pipeline::apply_post_scan so the resident WGSL path can return
        // display-ready pixels without a CPU full-frame post pass.
        post_scan_state.encode_passes(&mut encoder, n_pixels);

        // Zero-copy path: when buf_b is mappable, skip the blit and map it
        // directly below. Otherwise stage it into the MAP_READ readback buffer.
        // With an output pack, the packed RGBA8 is what gets staged.
        let packed = pack_req.as_ref().map(|req| self.encode_pack_pass(&mut encoder, req, &buf_b, n_pixels));
        if let Some(rb) = readback.as_ref() {
            encoder.copy_buffer_to_buffer(packed.as_ref().unwrap_or(&buf_b), 0, rb, 0, readback_bytes);
        }
        // Everything since function entry: CPU-side param prep, buffer
        // creation/uploads, and command encoding.
        let cpu_setup_ms = t_start.elapsed().as_secs_f32() * 1000.0;
        self.queue.submit(Some(encoder.finish()));

        // Single sync point at the end. Map buf_b directly on the zero-copy
        // path, or the staging buffer otherwise.
        #[cfg(target_arch = "wasm32")]
        {
            // The browser cannot block on the GPU: start the map and hand back
            // an empty image; the caller awaits `take_readback` for the pixels.
            let map_target = readback.unwrap_or(buf_b);
            let (tx, rx) = futures_channel::oneshot::channel();
            map_target.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                let _ = tx.send(r);
            });
            *self.pending_readback.lock().unwrap() = Some(PendingReadback {
                buffer: map_target,
                width: image.width,
                height: image.height,
                mapped: rx,
                packed: pack_req.is_some(),
            });
            let _ = cpu_setup_ms;
            return ImageBuf { width: image.width, height: image.height, data: Vec::new() };
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let map_target = readback.as_ref().unwrap_or(&buf_b);
            let slice = map_target.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |r| {
                tx.send(r).unwrap();
            });
            self.device.poll(wgpu::Maintain::Wait);
            rx.recv().unwrap().unwrap();
            let gpu_wait_ms = t_start.elapsed().as_secs_f32() * 1000.0 - cpu_setup_ms;
            let data = slice.get_mapped_range();
            let out_f32: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
            drop(data);
            map_target.unmap();

            let out = ImageBuf::from_data(image.width, image.height, f32_to_scalars(out_f32));
            tracing::debug!(
                cpu_setup_ms = format!("{cpu_setup_ms:.1}"),
                gpu_wait_ms = format!("{gpu_wait_ms:.1}"),
                readback_ms = format!(
                    "{:.1}",
                    t_start.elapsed().as_secs_f32() * 1000.0 - cpu_setup_ms - gpu_wait_ms
                ),
                "film chain timings"
            );
            out
        }
    }

    /// Get-or-compile a pipeline by shader source + binding layout. Cached by
    /// shader source pointer.
    fn cached_pipeline(
        &self,
        shader_source: &'static str,
        binding_types: &[wgpu::BufferBindingType],
    ) -> CachedPipelineRef {
        let entries: Vec<wgpu::BindGroupLayoutEntry> = binding_types
            .iter()
            .enumerate()
            .map(|(i, &ty)| wgpu::BindGroupLayoutEntry {
                binding: i as u32,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            })
            .collect();
        let entries_for_compile = entries;
        let mut cache = self.pipeline_cache.lock().unwrap();
        let key = shader_source.as_ptr() as usize;
        if !cache.contains_key(&key) {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("compute_shader"),
                    source: wgpu::ShaderSource::Wgsl(wgsl_for_target(shader_source)),
                });
            let bind_group_layout =
                self.device
                    .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                        label: Some("compute_layout"),
                        entries: &entries_for_compile,
                    });
            let pipeline_layout =
                self.device
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("compute_pipeline_layout"),
                        bind_group_layouts: &[&bind_group_layout],
                        push_constant_ranges: &[],
                    });
            let pipeline = self
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("compute_pipeline"),
                    layout: Some(&pipeline_layout),
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                });
            cache.insert(
                key,
                CachedPipeline {
                    bind_group_layout,
                    pipeline,
                },
            );
        }
        // Drop the guard but the underlying Arc keeps the entries alive.
        // Return cloned handles.
        let cached = cache.get(&key).unwrap();
        CachedPipelineRef {
            pipeline: cached.pipeline.clone(),
            layout: cached.bind_group_layout.clone(),
        }
    }
}

#[cfg(feature = "wgpu-backend")]
#[derive(Clone)]
struct CachedPipelineRef {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

#[cfg(feature = "wgpu-backend")]
struct GpuBuffer {
    data: Vec<u8>,
    binding_type: wgpu::BufferBindingType,
    usage: wgpu::BufferUsages,
}

#[cfg(feature = "wgpu-backend")]
impl GpuBuffer {
    fn uniform(data: &[u8]) -> Self {
        Self {
            data: data.to_vec(),
            binding_type: wgpu::BufferBindingType::Uniform,
            usage: wgpu::BufferUsages::UNIFORM,
        }
    }
    fn storage_ro(data: &[u8]) -> Self {
        Self {
            data: data.to_vec(),
            binding_type: wgpu::BufferBindingType::Storage { read_only: true },
            usage: wgpu::BufferUsages::STORAGE,
        }
    }
    fn storage_rw(data: &[u8]) -> Self {
        Self {
            data: data.to_vec(),
            binding_type: wgpu::BufferBindingType::Storage { read_only: false },
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        }
    }
}

#[cfg(feature = "wgpu-backend")]
impl ComputeBackend for WgpuBackend {
    fn colorspace_convert(&self, img: &ImageBuf, matrix: &[[f32; 3]; 3]) -> ImageBuf {
        cpu_backend::CpuBackend.colorspace_convert(img, matrix)
    }
    fn cctf_encode_srgb(&self, img: &ImageBuf) -> ImageBuf {
        cpu_backend::CpuBackend.cctf_encode_srgb(img)
    }
    fn cctf_decode_srgb(&self, img: &ImageBuf) -> ImageBuf {
        cpu_backend::CpuBackend.cctf_decode_srgb(img)
    }
    fn gaussian_blur(&self, img: &ImageBuf, sigma: f32) -> ImageBuf {
        if sigma <= 0.0 {
            return img.clone();
        }
        // For very small sigmas the FIR overhead dominates; CPU path is fine.
        // For practical halation/glare sigmas (1-40 pixels) the GPU is much faster.
        self.gaussian_blur_gpu(img, sigma)
    }
    fn gaussian_blur_multi(&self, img: &ImageBuf, sigmas: &[f32]) -> Vec<ImageBuf> {
        if sigmas.is_empty() {
            return Vec::new();
        }
        self.gaussian_blur_multi_gpu(img, sigmas)
    }
    fn table_lookup(&self, img: &ImageBuf, table_x: &[f32], table_y: &[[f32; 3]]) -> ImageBuf {
        cpu_backend::CpuBackend.table_lookup(img, table_x, table_y)
    }
    fn lut3d_interp(&self, img: &ImageBuf, lut: &Lut3D) -> ImageBuf {
        cpu_backend::CpuBackend.lut3d_interp(img, lut)
    }

    fn scan_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        normalization: f64,
        cat: &[[f64; 3]; 3],
        xyz_to_rgb: &[[f64; 3]; 3],
    ) -> ImageBuf {
        // GPU live-preview path collapses CAT and XYZ→RGB into a single
        // matrix — small precision drop acceptable for preview, matches
        // the same trade-off as `hanatos2025_rgb_to_raw`.
        let combined: [[f64; 3]; 3] = {
            let mut out = [[0.0f64; 3]; 3];
            for i in 0..3 {
                for j in 0..3 {
                    out[i][j] = xyz_to_rgb[i][0] * cat[0][j]
                        + xyz_to_rgb[i][1] * cat[1][j]
                        + xyz_to_rgb[i][2] * cat[2][j];
                }
            }
            out
        };
        let xyz_to_rgb = &combined;
        let n_wl = channel_density.len();
        let n_pixels = density_cmy.pixel_count() as u32;

        // Pack uniform params — mat3x3 in WGSL std140 is 3 columns of vec4.
        // GPU shaders are f32-only: cast precision-preserved inputs at the shader boundary.
        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct Params {
            width: u32,
            height: u32,
            n_wavelengths: u32,
            normalization: f32,
            col0: [f32; 4],
            col1: [f32; 4],
            col2: [f32; 4],
            bw: [f32; 4],
        }

        let params = Params {
            width: density_cmy.width,
            height: density_cmy.height,
            n_wavelengths: n_wl as u32,
            normalization: normalization as f32,
            col0: [
                xyz_to_rgb[0][0] as f32,
                xyz_to_rgb[1][0] as f32,
                xyz_to_rgb[2][0] as f32,
                0.0,
            ],
            col1: [
                xyz_to_rgb[0][1] as f32,
                xyz_to_rgb[1][1] as f32,
                xyz_to_rgb[2][1] as f32,
                0.0,
            ],
            col2: [
                xyz_to_rgb[0][2] as f32,
                xyz_to_rgb[1][2] as f32,
                xyz_to_rgb[2][2] as f32,
                0.0,
            ],
            // Standalone scan path carries no B&W remap (the resident chain
            // is the only caller that sets it). Identity / disabled.
            // w=1: skip the shader clamp — the per-stage CPU callers
            // (glare, gamut compression, blur/unsharp) expect the
            // unclamped scan RGB, exactly like `scan_spectral_cpu` returns;
            // the final encode+clip happens at the end of the scanning stage.
            bw: [1.0, 0.0, 0.0, 1.0],
        };

        // GPU shaders are f32-only — narrow f64 inputs at the shader boundary.
        // Metal's compiler runs fast-math (no-NaN assumption), so we sanitize CPU-side:
        // any wavelength with a NaN input has its `base_density` bumped to +1000 so
        // `pow(10, -d) ≈ 0`, zeroing that wavelength's contribution exactly the same
        // way Python's `density_to_light` zeros NaN-bearing wavelengths.
        let (cd_flat, mut bd) = sanitize_spectral_inputs(channel_density, base_density, n_wl);
        let illu_f32: Vec<f32> = illuminant.iter().map(|&v| v as f32).collect();
        bd.resize(n_wl, 0.0);
        let input_f32 = scalars_to_f32(&density_cmy.data);
        let output_bytes = vec![0u8; n_pixels as usize * 3 * 4];

        let result = self.dispatch_compute(
            include_str!("../../spektrafilm-shaders/wgsl/scan_spectral.wgsl"),
            &[
                GpuBuffer::uniform(bytemuck::bytes_of(&params)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&input_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&cd_flat)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&bd)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&illu_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&spektrafilm_math::spectral::CMF_X)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&spektrafilm_math::spectral::CMF_Y)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&spektrafilm_math::spectral::CMF_Z)),
                GpuBuffer::storage_rw(&output_bytes),
            ],
            n_pixels,
            8, // output buffer index
        );

        ImageBuf::from_data(
            density_cmy.width,
            density_cmy.height,
            f32_to_scalars(result),
        )
    }

    fn print_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        sensitivity: &[[f64; 3]],
        normalization_factor: f64,
        preflash: [f64; 3],
    ) -> ImageBuf {
        let n_wl = channel_density.len();
        let n_pixels = density_cmy.pixel_count() as u32;

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct Params {
            width: u32,
            height: u32,
            n_wavelengths: u32,
            normalization_factor: f32,
            preflash: [f32; 3],
            _pad: f32,
        }

        let params = Params {
            width: density_cmy.width,
            height: density_cmy.height,
            n_wavelengths: n_wl as u32,
            normalization_factor: normalization_factor as f32,
            preflash: [preflash[0] as f32, preflash[1] as f32, preflash[2] as f32],
            _pad: 0.0,
        };

        // GPU shaders are f32-only — narrow f64 inputs at the shader boundary.
        // See `sanitize_spectral_inputs` for the NaN-handling story (Metal fast-math).
        let (cd_flat, mut bd) = sanitize_spectral_inputs(channel_density, base_density, n_wl);
        let sens_flat: Vec<f32> = sensitivity
            .iter()
            .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
            .collect();
        bd.resize(n_wl, 0.0);
        let illu_f32: Vec<f32> = illuminant.iter().map(|&v| v as f32).collect();
        let input_f32 = scalars_to_f32(&density_cmy.data);
        let output_bytes = vec![0u8; n_pixels as usize * 3 * 4];

        let result = self.dispatch_compute(
            include_str!("../../spektrafilm-shaders/wgsl/print_spectral.wgsl"),
            &[
                GpuBuffer::uniform(bytemuck::bytes_of(&params)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&input_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&cd_flat)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&bd)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&illu_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&sens_flat)),
                GpuBuffer::storage_rw(&output_bytes),
            ],
            n_pixels,
            6, // output buffer index
        );

        ImageBuf::from_data(
            density_cmy.width,
            density_cmy.height,
            f32_to_scalars(result),
        )
    }

    fn hanatos2025_rgb_to_raw(
        &self,
        image: &ImageBuf,
        tc_lut: &spektrafilm_math::spectral::TcLut,
        color_space: &str,
        ref_illuminant: &[f32],
        cat16: bool,
    ) -> ImageBuf {
        // GPU live-preview path collapses the two-step CAT02 adaptation
        // into a single matmul — small visible-spectrum precision drop
        // that's acceptable for preview. The CPU path keeps the two-step
        // for export bit-parity with Python.
        let rgb_to_adapted_xyz = spektrafilm_math::spectral::build_rgb_to_adapted_xyz(
            color_space,
            ref_illuminant,
            cat16,
        );
        let rgb_to_adapted_xyz = &rgb_to_adapted_xyz;
        let n_pixels = image.pixel_count() as u32;
        let lut_size = tc_lut.size as u32;

        // Pack uniform: mat3x3 in std140 = 3 vec4 columns. f32 only on GPU.
        // WGSL columns are read as columns of the matrix; storing row-major as
        // [col[0], col[1], col[2]] where col[j][i] = mat[i][j].
        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct Params {
            width: u32,
            height: u32,
            lut_size: u32,
            _pad: u32,
            col0: [f32; 4],
            col1: [f32; 4],
            col2: [f32; 4],
        }

        let m = rgb_to_adapted_xyz;
        let params = Params {
            width: image.width,
            height: image.height,
            lut_size,
            _pad: 0,
            col0: [m[0][0] as f32, m[1][0] as f32, m[2][0] as f32, 0.0],
            col1: [m[0][1] as f32, m[1][1] as f32, m[2][1] as f32, 0.0],
            col2: [m[0][2] as f32, m[1][2] as f32, m[2][2] as f32, 0.0],
        };

        // TC LUT data is f64 on disk; narrow to f32 at the GPU boundary.
        let tc_lut_f32: Vec<f32> = tc_lut.data.iter().map(|&v| v as f32).collect();
        let input_f32 = scalars_to_f32(&image.data);
        let output_bytes = vec![0u8; n_pixels as usize * 3 * 4];

        let result = self.dispatch_compute(
            include_str!("../../spektrafilm-shaders/wgsl/hanatos2025_rgb_to_raw.wgsl"),
            &[
                GpuBuffer::uniform(bytemuck::bytes_of(&params)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&input_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&tc_lut_f32)),
                GpuBuffer::storage_rw(&output_bytes),
            ],
            n_pixels,
            3, // output buffer index
        );

        ImageBuf::from_data(image.width, image.height, f32_to_scalars(result))
    }

    fn density_curve_interp(
        &self,
        log_raw: &ImageBuf,
        log_exposure: &[f64],
        density_curves: &[[f64; 3]],
        gamma_factor: f64,
    ) -> ImageBuf {
        let n_pixels = log_raw.pixel_count() as u32;
        let k = log_exposure.len() as u32;

        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct Params {
            width: u32,
            height: u32,
            k: u32,
            uniform_grid: u32,
            gamma_inv: [f32; 3],
            _pad: f32,
        }
        // Detect uniformly-spaced log_exposure (typical case) to use the fast path.
        let uniform = is_uniform(log_exposure);
        let gamma_inv = if gamma_factor.abs() > 1e-12 {
            (1.0 / gamma_factor) as f32
        } else {
            1.0
        };
        let params = Params {
            width: log_raw.width,
            height: log_raw.height,
            k,
            uniform_grid: if uniform { 1 } else { 0 },
            gamma_inv: [gamma_inv; 3],
            _pad: 0.0,
        };

        let log_exp_f32: Vec<f32> = log_exposure.iter().map(|&v| v as f32).collect();
        let curves_f32: Vec<f32> = density_curves
            .iter()
            .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
            .collect();
        let input_f32 = scalars_to_f32(&log_raw.data);
        let output_bytes = vec![0u8; n_pixels as usize * 3 * 4];

        let result = self.dispatch_compute(
            include_str!("../../spektrafilm-shaders/wgsl/density_curve_interp.wgsl"),
            &[
                GpuBuffer::uniform(bytemuck::bytes_of(&params)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&input_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&log_exp_f32)),
                GpuBuffer::storage_ro(bytemuck::cast_slice(&curves_f32)),
                GpuBuffer::storage_rw(&output_bytes),
            ],
            n_pixels,
            4, // output buffer index
        );

        ImageBuf::from_data(log_raw.width, log_raw.height, f32_to_scalars(result))
    }

    fn try_run_film_chain(&self, params: &crate::FilmChainParams<'_>) -> Option<ImageBuf> {
        Some(self.run_film_chain(params))
    }

    fn resident_chain_applies_post_scan(&self) -> bool {
        true
    }

    fn is_gpu(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "wgpu (GPU)"
    }
}

/// Pre-built halation passes — owns the per-sigma kernel buffers, params
/// buffers, and bind groups so they live long enough for the encoder.
///
/// The CPU equivalent is `spektrafilm_model::diffusion::apply_halation_um`.
/// All passes operate on the resident image buffer (passed in as `buf_b`),
/// using `buf_a` as blur intermediate and two newly-allocated buffers
/// `buf_c` / `buf_d` for scatter outputs and the halation accumulator.
#[cfg(feature = "wgpu-backend")]
struct HalationState {
    // Owns all the auxiliary buffers + bind groups; only `encode_passes` is
    // called from the hot path.
    buf_c: wgpu::Buffer,
    buf_d: wgpu::Buffer,
    scatter_blurs: Vec<BlurJob>, // [core, tail]
    scatter_mix: DispatchJob,
    halation_blurs: Vec<BlurJob>,          // one per bounce
    halation_accumulate: Vec<DispatchJob>, // one add_scaled per bounce
    halation_final_add: DispatchJob,
    halation_renormalize: Option<DispatchJob>,
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
}

#[cfg(feature = "wgpu-backend")]
struct BlurJob {
    _kernel_buf: wgpu::Buffer,
    _params_buf: wgpu::Buffer,
    bg_h: wgpu::BindGroup,
    bg_v: wgpu::BindGroup,
}

#[cfg(feature = "wgpu-backend")]
struct DispatchJob {
    _params_buf: wgpu::Buffer,
    pipeline: CachedPipelineRef,
    bg: wgpu::BindGroup,
}

#[cfg(feature = "wgpu-backend")]
fn build_halation_state(
    device: &wgpu::Device,
    hp: &crate::HalationGpuParams,
    width: u32,
    height: u32,
    buf_a: &wgpu::Buffer,
    buf_b: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> HalationState {
    let n_pixels = (width as usize) * (height as usize);
    let img_bytes = (n_pixels * 3 * 4) as u64;

    let mk_buf = |label: &str| {
        device.create_buffer_t(&wgpu::BufferDescriptor {
            label: Some(label),
            size: img_bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    };
    let buf_c = mk_buf("halation_c"); // scatter core / blur output
    let buf_d = mk_buf("halation_d"); // scatter tail / accumulator

    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );

    // Helper: build a single H/V blur job from source → output, using buf_a
    // (the freed RGB upload) as blur scratch (mid).
    let make_blur_job =
        |sigma: f32, src: &wgpu::Buffer, out: &wgpu::Buffer, label: &str| -> BlurJob {
            let sigma = sigma.max(0.01);
            let radius = fir_blur_radius(sigma);
            let kernel_size = (2 * radius + 1) as usize;
            let sigma_f64 = sigma as f64;
            let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
            let r_i32 = radius as i32;
            let mut kernel = Vec::with_capacity(kernel_size);
            for k in 0..kernel_size {
                let x = (k as i32 - r_i32) as f64;
                kernel.push((-x * x / two_sigma_sq).exp());
            }
            let sum: f64 = kernel.iter().sum();
            let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

            let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("halation_blur_kernel_{label}")),
                contents: bytemuck::cast_slice(&kernel_f32),
                usage: wgpu::BufferUsages::STORAGE,
            });
            #[repr(C)]
            #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
            struct BlurParams {
                width: u32,
                height: u32,
                radius: u32,
                _pad: u32,
            }
            let params = BlurParams {
                width,
                height,
                radius,
                _pad: 0,
            };
            let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("halation_blur_params_{label}")),
                contents: bytemuck::bytes_of(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(&format!("halation_blur_h_{label}")),
                layout: &blur_pipe_h.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: src.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: kernel_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: buf_a.as_entire_binding(),
                    }, // mid
                ],
            });
            let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(&format!("halation_blur_v_{label}")),
                layout: &blur_pipe_v.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: buf_a.as_entire_binding(),
                    }, // mid
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: kernel_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: out.as_entire_binding(),
                    },
                ],
            });
            BlurJob {
                _kernel_buf: kernel_buf,
                _params_buf: params_buf,
                bg_h,
                bg_v,
            }
        };

    // ── Scatter blurs (core → buf_c, tail → buf_d) ─────────────────────
    let scatter_blurs = vec![
        make_blur_job(hp.scatter_core_px, buf_b, &buf_c, "scatter_core"),
        make_blur_job(hp.scatter_tail_px, buf_b, &buf_d, "scatter_tail"),
    ];

    // ── Scatter mix: result = (1-sa)*result + sa*((1-atw)*core + atw*tail)
    let scatter_mix_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/scatter_mix.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct ScatterMixParams {
        n_pixels: u32,
        scatter_amount: f32,
        _pad0: u32,
        _pad1: u32,
        // vec4<f32>: per-channel tail weights, .w padding for 16-byte alignment
        tail_weight: [f32; 4],
    }
    let scatter_mix_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("halation_scatter_mix_params"),
        contents: bytemuck::bytes_of(&ScatterMixParams {
            n_pixels: n_pixels as u32,
            scatter_amount: hp.scatter_amount,
            _pad0: 0,
            _pad1: 0,
            tail_weight: [
                hp.scatter_tail_weight[0],
                hp.scatter_tail_weight[1],
                hp.scatter_tail_weight[2],
                0.0,
            ],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let scatter_mix_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("halation_scatter_mix_bg"),
        layout: &scatter_mix_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: scatter_mix_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_c.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_d.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: buf_b.as_entire_binding(),
            },
        ],
    });
    let scatter_mix_job = DispatchJob {
        _params_buf: scatter_mix_params,
        pipeline: scatter_mix_pipe,
        bg: scatter_mix_bg,
    };

    // ── Halation bounces ──────────────────────────────────────────────
    let n = hp.halation_n_bounces as usize;
    // Pre-compute normalized decay weights.
    let mut decay = vec![0.0f32; n];
    for k in 0..n {
        decay[k] = hp.halation_bounce_decay.powi(k as i32);
    }
    let decay_sum: f32 = decay.iter().sum();
    if decay_sum > 0.0 {
        for d in &mut decay {
            *d /= decay_sum;
        }
    }

    // Each bounce blurs buf_b → buf_c at sigma_k, then accumulates into
    // buf_d. First bounce sets `clear_first` so we don't need a separate
    // zero pass.
    let add_scaled_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/add_scaled.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct AddScaledParams {
        n_pixels: u32,
        scale: f32,
        clear_first: u32,
        _pad: u32,
    }

    let mut halation_blurs = Vec::with_capacity(n);
    let mut halation_accumulate = Vec::with_capacity(n);
    for (k, &wk) in decay.iter().enumerate() {
        let sigma_k = hp.halation_first_sigma_px * ((k as f32) + 1.0).sqrt();
        halation_blurs.push(make_blur_job(
            sigma_k,
            buf_b,
            &buf_c,
            &format!("bounce_{k}"),
        ));

        let acc_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("halation_acc_params_{k}")),
            contents: bytemuck::bytes_of(&AddScaledParams {
                n_pixels: n_pixels as u32,
                scale: wk,
                clear_first: if k == 0 { 1 } else { 0 },
                _pad: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let acc_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("halation_acc_bg_{k}")),
            layout: &add_scaled_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: acc_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_c.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: buf_d.as_entire_binding(),
                },
            ],
        });
        halation_accumulate.push(DispatchJob {
            _params_buf: acc_params,
            pipeline: add_scaled_pipe.clone(),
            bg: acc_bg,
        });
    }

    // Final add: result[c] += a_tot[c] * accumulator[c]. Per-channel
    // because halation_strength varies dramatically across channels
    // (Portra zeros out blue entirely). Uses the per-channel variant
    // of add_scaled.
    let final_add_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/add_scaled_per_channel.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct AddScaledPerChannelParams {
        n_pixels: u32,
        _pad0: u32,
        _pad1: u32,
        _pad2: u32,
        scale: [f32; 4],
    }
    let final_add_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("halation_final_add_params"),
        contents: bytemuck::bytes_of(&AddScaledPerChannelParams {
            n_pixels: n_pixels as u32,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            scale: [
                hp.halation_a_tot[0],
                hp.halation_a_tot[1],
                hp.halation_a_tot[2],
                0.0,
            ],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let final_add_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("halation_final_add_bg"),
        layout: &final_add_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: final_add_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_d.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_b.as_entire_binding(),
            },
        ],
    });
    let halation_final_add = DispatchJob {
        _params_buf: final_add_params,
        pipeline: final_add_pipe,
        bg: final_add_bg,
    };

    // Per-channel renormalize: `result[c] /= 1 + a_tot[c]`. Uses the
    // pre-computed inverse factor passed in `inv_factor.xyz`.
    let halation_renormalize = if hp.halation_renormalize {
        let renorm_pipe = backend.cached_pipeline(
            include_str!("../../spektrafilm-shaders/wgsl/halation_renormalize.wgsl"),
            &[
                wgpu::BufferBindingType::Uniform,
                wgpu::BufferBindingType::Storage { read_only: false },
            ],
        );
        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct RenormParams {
            n_pixels: u32,
            _pad: u32,
            // f32x4: .xyz used, .w padding to align next vec4. Two u32
            // header fields above push this to offset 16, matching the
            // WGSL std140 layout.
            _gap: [u32; 2],
            inv_factor: [f32; 4],
        }
        let inv = [
            1.0 / (1.0 + hp.halation_a_tot[0]),
            1.0 / (1.0 + hp.halation_a_tot[1]),
            1.0 / (1.0 + hp.halation_a_tot[2]),
            0.0,
        ];
        let renorm_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("halation_renorm_params"),
            contents: bytemuck::bytes_of(&RenormParams {
                n_pixels: n_pixels as u32,
                _pad: 0,
                _gap: [0, 0],
                inv_factor: inv,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let renorm_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("halation_renorm_bg"),
            layout: &renorm_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: renorm_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_b.as_entire_binding(),
                },
            ],
        });
        Some(DispatchJob {
            _params_buf: renorm_params,
            pipeline: renorm_pipe,
            bg: renorm_bg,
        })
    } else {
        None
    };

    HalationState {
        buf_c,
        buf_d,
        scatter_blurs,
        scatter_mix: scatter_mix_job,
        halation_blurs,
        halation_accumulate,
        halation_final_add,
        halation_renormalize,
        blur_pipe_h,
        blur_pipe_v,
    }
}

#[cfg(feature = "wgpu-backend")]
impl HalationState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        n_pixels: u32,
        workgroup_size: u32,
        wg_xy: (u32, u32),
    ) {
        let _ = (&self.buf_c, &self.buf_d); // owned, just keepalive
        let dispatch_blur = |enc: &mut wgpu::CommandEncoder, job: &BlurJob| {
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("halation_blur_h"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_h.pipeline);
                pass.set_bind_group(0, &job.bg_h, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("halation_blur_v"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_v.pipeline);
                pass.set_bind_group(0, &job.bg_v, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
        };
        let dispatch_linear = |enc: &mut wgpu::CommandEncoder, job: &DispatchJob| {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("halation_linear"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&job.pipeline.pipeline);
            pass.set_bind_group(0, &job.bg, &[]);
            pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
        };

        // Scatter
        if !self.scatter_blurs.is_empty() {
            for j in &self.scatter_blurs {
                dispatch_blur(encoder, j);
            }
            dispatch_linear(encoder, &self.scatter_mix);
        }

        // Halation bounces
        for (blur_job, acc_job) in self
            .halation_blurs
            .iter()
            .zip(self.halation_accumulate.iter())
        {
            dispatch_blur(encoder, blur_job);
            dispatch_linear(encoder, acc_job);
        }
        if !self.halation_blurs.is_empty() {
            dispatch_linear(encoder, &self.halation_final_add);
            if let Some(rn) = &self.halation_renormalize {
                dispatch_linear(encoder, rn);
            }
        }
    }
}

/// A 16×16-workgroup compute pass that writes an `out_w × out_h` image
/// (downsample / upsample).
#[cfg(feature = "wgpu-backend")]
struct GridJob {
    pipeline: CachedPipelineRef,
    bg: wgpu::BindGroup,
    out_w: u32,
    out_h: u32,
}

/// Pre-built camera diffusion-filter passes for the resident chain. Operates
/// on `buf_b` (raw film exposure, after hanatos / before halation):
/// downsample buf_b → small, blur the small image at each Gaussian component
/// accumulating per-channel, upsample the scattered field, then mix
/// `buf_b = (1-p_s)·buf_b + p_s·scattered`. Owns all scratch buffers so they
/// outlive the encoder. CPU equivalent: `apply_diffusion_filter_blur`.
#[cfg(feature = "wgpu-backend")]
struct DiffusionState {
    small_w: u32,
    small_h: u32,
    n_full: u32,
    n_small: u32,
    // Owned buffers (keepalive for the bind groups + clear/copy targets).
    _small_in: wgpu::Buffer,
    _small_mid: wgpu::Buffer,
    _small_out: wgpu::Buffer,
    small_acc: wgpu::Buffer,
    _upsampled: wgpu::Buffer,
    buf_mix: wgpu::Buffer,
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
    downsample: GridJob,
    blur_jobs: Vec<BlurJob>,
    accumulate: Vec<DispatchJob>,
    upsample: GridJob,
    mix1: DispatchJob,
    mix2: DispatchJob,
}

#[cfg(feature = "wgpu-backend")]
fn build_diffusion_state(
    device: &wgpu::Device,
    plan: &crate::DiffusionGpuPlan,
    width: u32,
    height: u32,
    buf_b: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> DiffusionState {
    let small_w = plan.small_w;
    let small_h = plan.small_h;
    let n_full = (width as usize) * (height as usize);
    let n_small = (small_w as usize) * (small_h as usize);
    let full_bytes = (n_full * 3 * 4) as u64;
    let small_bytes = (n_small * 3 * 4) as u64;

    let mk = |label: &str, bytes: u64| {
        device.create_buffer_t(&wgpu::BufferDescriptor {
            label: Some(label),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    };
    let small_in = mk("diff_small_in", small_bytes);
    let small_mid = mk("diff_small_mid", small_bytes);
    let small_out = mk("diff_small_out", small_bytes);
    let small_acc = mk("diff_small_acc", small_bytes);
    let upsampled = mk("diff_upsampled", full_bytes);
    let buf_mix = mk("diff_mix", full_bytes);

    // ── Downsample buf_b → small_in ───────────────────────────────────
    let grid_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct DownParams {
        in_w: u32,
        in_h: u32,
        out_w: u32,
        out_h: u32,
        factor: u32,
        _p0: u32,
        _p1: u32,
        _p2: u32,
    }
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct UpParams {
        in_w: u32,
        in_h: u32,
        out_w: u32,
        out_h: u32,
        inv_factor: f32,
        _p0: u32,
        _p1: u32,
        _p2: u32,
    }
    let down_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/downsample_area.wgsl"),
        grid_layout,
    );
    let down_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("diff_down_params"),
        contents: bytemuck::bytes_of(&DownParams {
            in_w: width,
            in_h: height,
            out_w: small_w,
            out_h: small_h,
            factor: plan.d,
            _p0: 0,
            _p1: 0,
            _p2: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let down_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("diff_down_bg"),
        layout: &down_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: down_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_b.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: small_in.as_entire_binding(),
            },
        ],
    });
    let downsample = GridJob {
        pipeline: down_pipe,
        bg: down_bg,
        out_w: small_w,
        out_h: small_h,
    };

    // ── Per-component blurs (small_in → small_out via small_mid) ──────
    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct BlurParams {
        width: u32,
        height: u32,
        radius: u32,
        _pad: u32,
    }
    let add_pc_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/add_scaled_per_channel.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct AddPcParams {
        n_pixels: u32,
        _p0: u32,
        _p1: u32,
        _p2: u32,
        scale: [f32; 4],
    }

    let mut blur_jobs = Vec::with_capacity(plan.sigmas.len());
    let mut accumulate = Vec::with_capacity(plan.sigmas.len());
    for (i, (&sigma, coeff)) in plan.sigmas.iter().zip(plan.coeffs.iter()).enumerate() {
        let sigma = sigma.max(0.01);
        let radius = fir_blur_radius(sigma);
        let kernel_size = (2 * radius + 1) as usize;
        let two_sigma_sq = 2.0 * (sigma as f64) * (sigma as f64);
        let r_i32 = radius as i32;
        let mut kernel = Vec::with_capacity(kernel_size);
        for k in 0..kernel_size {
            let x = (k as i32 - r_i32) as f64;
            kernel.push((-x * x / two_sigma_sq).exp());
        }
        let ksum: f64 = kernel.iter().sum();
        let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / ksum) as f32).collect();
        let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("diff_kernel_{i}")),
            contents: bytemuck::cast_slice(&kernel_f32),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let bp = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("diff_blur_params_{i}")),
            contents: bytemuck::bytes_of(&BlurParams {
                width: small_w,
                height: small_h,
                radius,
                _pad: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("diff_blur_h_{i}")),
            layout: &blur_pipe_h.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: bp.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: small_in.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: small_mid.as_entire_binding(),
                },
            ],
        });
        let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("diff_blur_v_{i}")),
            layout: &blur_pipe_v.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: bp.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: small_mid.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: small_out.as_entire_binding(),
                },
            ],
        });
        blur_jobs.push(BlurJob {
            _kernel_buf: kernel_buf,
            _params_buf: bp,
            bg_h,
            bg_v,
        });

        // Accumulate small_out (per-channel coeff) → small_acc.
        let ap = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("diff_acc_params_{i}")),
            contents: bytemuck::bytes_of(&AddPcParams {
                n_pixels: n_small as u32,
                _p0: 0,
                _p1: 0,
                _p2: 0,
                scale: [coeff[0], coeff[1], coeff[2], 0.0],
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let abg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("diff_acc_bg_{i}")),
            layout: &add_pc_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: ap.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: small_out.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: small_acc.as_entire_binding(),
                },
            ],
        });
        accumulate.push(DispatchJob {
            _params_buf: ap,
            pipeline: add_pc_pipe.clone(),
            bg: abg,
        });
    }

    // ── Upsample small_acc → upsampled (full res) ────────────────────
    let up_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/upsample_bilinear.wgsl"),
        grid_layout,
    );
    let up_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("diff_up_params"),
        contents: bytemuck::bytes_of(&UpParams {
            in_w: small_w,
            in_h: small_h,
            out_w: width,
            out_h: height,
            inv_factor: 1.0 / plan.d as f32,
            _p0: 0,
            _p1: 0,
            _p2: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let up_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("diff_up_bg"),
        layout: &up_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: up_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: small_acc.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: upsampled.as_entire_binding(),
            },
        ],
    });
    let upsample = GridJob {
        pipeline: up_pipe,
        bg: up_bg,
        out_w: width,
        out_h: height,
    };

    // ── Mix: buf_mix = (1-p_s)*buf_b + p_s*upsampled (then copied to buf_b)
    let add_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/add_scaled.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct AddScaledParams {
        n_pixels: u32,
        scale: f32,
        clear_first: u32,
        _pad: u32,
    }
    let mk_add = |label: &str, src: &wgpu::Buffer, scale: f32, clear: u32| -> DispatchJob {
        let pb = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::bytes_of(&AddScaledParams {
                n_pixels: n_full as u32,
                scale,
                clear_first: clear,
                _pad: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &add_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: pb.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: src.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: buf_mix.as_entire_binding(),
                },
            ],
        });
        DispatchJob {
            _params_buf: pb,
            pipeline: add_pipe.clone(),
            bg,
        }
    };
    let mix1 = mk_add("diff_mix1", buf_b, 1.0 - plan.p_s, 1);
    let mix2 = mk_add("diff_mix2", &upsampled, plan.p_s, 0);

    DiffusionState {
        small_w,
        small_h,
        n_full: n_full as u32,
        n_small: n_small as u32,
        _small_in: small_in,
        _small_mid: small_mid,
        _small_out: small_out,
        small_acc,
        _upsampled: upsampled,
        buf_mix,
        blur_pipe_h,
        blur_pipe_v,
        downsample,
        blur_jobs,
        accumulate,
        upsample,
        mix1,
        mix2,
    }
}

#[cfg(feature = "wgpu-backend")]
impl DiffusionState {
    /// Encode the diffusion onto `buf_b` (in place: result copied back).
    fn encode_passes(&self, encoder: &mut wgpu::CommandEncoder, buf_b: &wgpu::Buffer) {
        let grid = |g: &GridJob, enc: &mut wgpu::CommandEncoder| {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("diff_grid"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&g.pipeline.pipeline);
            pass.set_bind_group(0, &g.bg, &[]);
            pass.dispatch_workgroups(g.out_w.div_ceil(16), g.out_h.div_ceil(16), 1);
        };
        let blur_small = |job: &BlurJob, enc: &mut wgpu::CommandEncoder| {
            let wg = (self.small_w.div_ceil(16), self.small_h.div_ceil(16));
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("diff_blur_h"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_h.pipeline);
                pass.set_bind_group(0, &job.bg_h, &[]);
                pass.dispatch_workgroups(wg.0, wg.1, 1);
            }
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("diff_blur_v"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_v.pipeline);
                pass.set_bind_group(0, &job.bg_v, &[]);
                pass.dispatch_workgroups(wg.0, wg.1, 1);
            }
        };
        let linear = |job: &DispatchJob, n: u32, enc: &mut wgpu::CommandEncoder| {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("diff_linear"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&job.pipeline.pipeline);
            pass.set_bind_group(0, &job.bg, &[]);
            pass.dispatch_workgroups(n.div_ceil(WG_1D), 1, 1);
        };

        // Zero the accumulator (add_scaled_per_channel has no clear).
        encoder.clear_buffer(&self.small_acc, 0, None);
        grid(&self.downsample, encoder);
        for (b, a) in self.blur_jobs.iter().zip(self.accumulate.iter()) {
            blur_small(b, encoder);
            linear(a, self.n_small, encoder);
        }
        grid(&self.upsample, encoder);
        linear(&self.mix1, self.n_full, encoder);
        linear(&self.mix2, self.n_full, encoder);
        encoder.copy_buffer_to_buffer(&self.buf_mix, 0, buf_b, 0, (self.n_full as u64) * 3 * 4);
    }
}

#[cfg(feature = "wgpu-backend")]
struct SimpleBlurState {
    _dst: wgpu::Buffer,
    blur: BlurJob,
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
    n_bytes: u64,
}

#[cfg(feature = "wgpu-backend")]
fn build_simple_blur_state(
    device: &wgpu::Device,
    sigma: f32,
    width: u32,
    height: u32,
    src: &wgpu::Buffer,
    mid: &wgpu::Buffer,
    label: &str,
    backend: &WgpuBackend,
) -> SimpleBlurState {
    let n_bytes = (width as u64) * (height as u64) * 3 * 4;
    let dst = device.create_buffer_t(&wgpu::BufferDescriptor {
        label: Some(&format!("{label}_blur_dst")),
        size: n_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });

    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );

    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct BlurParams {
        width: u32,
        height: u32,
        radius: u32,
        _pad: u32,
    }
    let sigma = sigma.max(0.01);
    let radius = fir_blur_radius(sigma);
    let kernel_size = (2 * radius + 1) as usize;
    let two_sigma_sq = 2.0 * (sigma as f64) * (sigma as f64);
    let r_i32 = radius as i32;
    let mut kernel = Vec::with_capacity(kernel_size);
    for k in 0..kernel_size {
        let x = (k as i32 - r_i32) as f64;
        kernel.push((-x * x / two_sigma_sq).exp());
    }
    let ksum: f64 = kernel.iter().sum();
    let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / ksum) as f32).collect();
    let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some(&format!("{label}_blur_kernel")),
        contents: bytemuck::cast_slice(&kernel_f32),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some(&format!("{label}_blur_params")),
        contents: bytemuck::bytes_of(&BlurParams {
            width,
            height,
            radius,
            _pad: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(&format!("{label}_blur_h_bg")),
        layout: &blur_pipe_h.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: src.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: kernel_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: mid.as_entire_binding(),
            },
        ],
    });
    let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(&format!("{label}_blur_v_bg")),
        layout: &blur_pipe_v.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: mid.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: kernel_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: dst.as_entire_binding(),
            },
        ],
    });

    SimpleBlurState {
        _dst: dst,
        blur: BlurJob {
            _kernel_buf: kernel_buf,
            _params_buf: params_buf,
            bg_h,
            bg_v,
        },
        blur_pipe_h,
        blur_pipe_v,
        n_bytes,
    }
}

#[cfg(feature = "wgpu-backend")]
impl SimpleBlurState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        wg_xy: (u32, u32),
        dst_main: &wgpu::Buffer,
    ) {
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("simple_blur_h"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.blur_pipe_h.pipeline);
            pass.set_bind_group(0, &self.blur.bg_h, &[]);
            pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("simple_blur_v"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.blur_pipe_v.pipeline);
            pass.set_bind_group(0, &self.blur.bg_v, &[]);
            pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
        }
        encoder.copy_buffer_to_buffer(&self._dst, 0, dst_main, 0, self.n_bytes);
    }
}

#[cfg(feature = "wgpu-backend")]
struct HighlightBoostState {
    _buffers: Vec<wgpu::Buffer>,
    reductions: Vec<(DispatchJob, u32)>,
    boost: DispatchJob,
    n_values: u32,
}

#[cfg(feature = "wgpu-backend")]
fn build_highlight_boost_state(
    device: &wgpu::Device,
    hp: &crate::HighlightBoostGpuParams,
    n_pixels: u32,
    img: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> HighlightBoostState {
    let n_values = n_pixels * 3;
    let mut counts = Vec::new();
    let mut values = n_values;
    loop {
        let blocks = values.div_ceil(2048).max(1);
        counts.push(blocks);
        if blocks == 1 {
            break;
        }
        values = blocks;
    }

    let reduce_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/max_reduce.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    let boost_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/highlight_boost.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );

    let buffers: Vec<wgpu::Buffer> = counts
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            device.create_buffer_t(&wgpu::BufferDescriptor {
                label: Some(&format!("highlight_reduce_{i}")),
                size: (c as u64) * 4,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        })
        .collect();

    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct ReduceParams {
        n_values: u32,
        _pad: [u32; 7],
    }

    let mut reductions = Vec::with_capacity(counts.len());
    for (i, &blocks) in counts.iter().enumerate() {
        let pass_values = if i == 0 { n_values } else { counts[i - 1] };
        let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("highlight_reduce_params_{i}")),
            contents: bytemuck::bytes_of(&ReduceParams {
                n_values: pass_values,
                _pad: [0; 7],
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let input = if i == 0 { img } else { &buffers[i - 1] };
        let output = &buffers[i];
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("highlight_reduce_bg_{i}")),
            layout: &reduce_pipe.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: input.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        reductions.push((
            DispatchJob {
                _params_buf: params_buf,
                pipeline: reduce_pipe.clone(),
                bg,
            },
            blocks,
        ));
    }

    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct BoostParams {
        n_values: u32,
        boost_ev: f32,
        boost_range: f32,
        protect_ev: f32,
    }
    let boost_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("highlight_boost_params"),
        contents: bytemuck::bytes_of(&BoostParams {
            n_values,
            boost_ev: hp.boost_ev,
            boost_range: hp.boost_range,
            protect_ev: hp.protect_ev,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let final_max = buffers.last().expect("highlight reduction has output");
    let boost_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("highlight_boost_bg"),
        layout: &boost_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: boost_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: final_max.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: img.as_entire_binding(),
            },
        ],
    });

    HighlightBoostState {
        _buffers: buffers,
        reductions,
        boost: DispatchJob {
            _params_buf: boost_params,
            pipeline: boost_pipe,
            bg: boost_bg,
        },
        n_values,
    }
}

#[cfg(feature = "wgpu-backend")]
impl HighlightBoostState {
    fn encode_passes(&self, encoder: &mut wgpu::CommandEncoder) {
        for (job, blocks) in &self.reductions {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("highlight_reduce"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&job.pipeline.pipeline);
            pass.set_bind_group(0, &job.bg, &[]);
            pass.dispatch_workgroups(*blocks, 1, 1);
        }
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("highlight_boost"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.boost.pipeline.pipeline);
        pass.set_bind_group(0, &self.boost.bg, &[]);
        pass.dispatch_workgroups(self.n_values.div_ceil(WG_1D), 1, 1);
    }
}

#[cfg(feature = "wgpu-backend")]
struct InplaceUnaryState {
    job: DispatchJob,
}

#[cfg(feature = "wgpu-backend")]
impl InplaceUnaryState {
    fn encode_passes(&self, encoder: &mut wgpu::CommandEncoder, n_pixels: u32) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("inplace_unary"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.job.pipeline.pipeline);
        pass.set_bind_group(0, &self.job.bg, &[]);
        pass.dispatch_workgroups(n_pixels.div_ceil(WG_1D), 1, 1);
    }
}

#[cfg(feature = "wgpu-backend")]
fn build_log_to_linear_state(
    device: &wgpu::Device,
    n_pixels: u32,
    scale: f32,
    img: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> InplaceUnaryState {
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct Params {
        n_pixels: u32,
        scale: f32,
        _pad: [u32; 2],
    }
    let pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/log_to_linear_scaled.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("print_log_to_linear_params"),
        contents: bytemuck::bytes_of(&Params {
            n_pixels,
            scale,
            _pad: [0; 2],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("print_log_to_linear_bg"),
        layout: &pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: img.as_entire_binding(),
            },
        ],
    });
    InplaceUnaryState {
        job: DispatchJob {
            _params_buf: params_buf,
            pipeline: pipe,
            bg,
        },
    }
}

#[cfg(feature = "wgpu-backend")]
fn build_linear_to_log_state(
    device: &wgpu::Device,
    n_pixels: u32,
    img: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> InplaceUnaryState {
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct Params {
        n_pixels: u32,
        _pad: [u32; 7],
    }
    let pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/linear_to_log10_outer.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("print_linear_to_log_params"),
        contents: bytemuck::bytes_of(&Params {
            n_pixels,
            _pad: [0; 7],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("print_linear_to_log_bg"),
        layout: &pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: img.as_entire_binding(),
            },
        ],
    });
    InplaceUnaryState {
        job: DispatchJob {
            _params_buf: params_buf,
            pipeline: pipe,
            bg,
        },
    }
}

#[cfg(feature = "wgpu-backend")]
fn build_post_scan_state(
    device: &wgpu::Device,
    n_pixels: u32,
    output_cctf_encoding: bool,
    img: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> InplaceUnaryState {
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct Params {
        n_pixels: u32,
        output_cctf_encoding: u32,
        _pad: [u32; 2],
    }
    let pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/post_scan.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("post_scan_params"),
        contents: bytemuck::bytes_of(&Params {
            n_pixels,
            output_cctf_encoding: u32::from(output_cctf_encoding),
            _pad: [0; 2],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("post_scan_bg"),
        layout: &pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: img.as_entire_binding(),
            },
        ],
    });
    InplaceUnaryState {
        job: DispatchJob {
            _params_buf: params_buf,
            pipeline: pipe,
            bg,
        },
    }
}

/// Pre-built DIR coupler passes — owns scratch buffers, kernel buffers,
/// and bind groups so they live for the encoder.
///
/// CPU equivalent: `spektrafilm_model::couplers::apply_density_correction`.
/// Encodes per-pixel matmul → two Gaussian blurs of the correction →
/// weighted lerp via `add_scaled` → in-place subtract from log_raw via
/// `add_scaled(scale=-1)` → re-interpolation of `density_curves_0`.
#[cfg(feature = "wgpu-backend")]
struct DirState {
    _buf_correction: wgpu::Buffer, // matmul output → tail_part (after blur2)
    _buf_gaussian: wgpu::Buffer,   // gaussian_part output (after blur1)
    _buf_mix: wgpu::Buffer,        // weighted lerp output → final correction
    matmul: DispatchJob,
    blur_gaussian: BlurJob,
    blur_tail: BlurJob,
    lerp_clear: DispatchJob,      // buf_mix = (1-w) * buf_gaussian
    lerp_accumulate: DispatchJob, // buf_mix += w * buf_correction (tail_part)
    subtract: DispatchJob,        // buf_b -= buf_mix
    density_curve_0: DispatchJob, // re-interp density curves
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
    /// Buffers we own that the bind groups reference (log_exp, curves) —
    /// kept alive for the encoder's lifetime.
    _owned: Vec<wgpu::Buffer>,
}

#[cfg(feature = "wgpu-backend")]
fn build_dir_state(
    device: &wgpu::Device,
    dp: &crate::DirCouplersGpuParams<'_>,
    width: u32,
    height: u32,
    buf_a: &wgpu::Buffer,
    buf_b: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> DirState {
    let n_pixels = (width as usize) * (height as usize);
    let img_bytes = (n_pixels * 3 * 4) as u64;

    let mk_buf = |label: &str| {
        device.create_buffer_t(&wgpu::BufferDescriptor {
            label: Some(label),
            size: img_bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    };
    // buf_correction holds the matmul output, then is overwritten by the
    // tail blur (in-place via the V pass of a separable blur — H and V
    // are separate compute passes so wgpu does NOT see the input/output
    // as aliasing). buf_gaussian holds the first blur's output.
    // buf_mix holds the weighted lerp result that ultimately gets
    // subtracted from log_raw.
    let buf_correction = mk_buf("dir_correction");
    let buf_gaussian = mk_buf("dir_gaussian");
    let buf_mix = mk_buf("dir_mix");

    // ── 1. dir_matmul ─────────────────────────────────────────────────
    let matmul_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/dir_matmul.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct DirMatmulParams {
        n_pixels: u32,
        positive: u32,
        _pad0: u32,
        _pad1: u32,
        density_max: [f32; 4],
        m_row0: [f32; 4],
        m_row1: [f32; 4],
        m_row2: [f32; 4],
    }
    let m = &dp.couplers_matrix_scaled;
    let matmul_params = DirMatmulParams {
        n_pixels: n_pixels as u32,
        positive: if dp.is_positive { 1 } else { 0 },
        _pad0: 0,
        _pad1: 0,
        density_max: [dp.density_max[0], dp.density_max[1], dp.density_max[2], 0.0],
        m_row0: [m[0][0], m[0][1], m[0][2], 0.0],
        m_row1: [m[1][0], m[1][1], m[1][2], 0.0],
        m_row2: [m[2][0], m[2][1], m[2][2], 0.0],
    };
    let matmul_params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_matmul_params"),
        contents: bytemuck::bytes_of(&matmul_params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let matmul_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dir_matmul_bg"),
        layout: &matmul_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: matmul_params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_a.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_correction.as_entire_binding(),
            },
        ],
    });
    let matmul = DispatchJob {
        _params_buf: matmul_params_buf,
        pipeline: matmul_pipe,
        bg: matmul_bg,
    };

    // ── 2. Two Gaussian blurs of the correction ───────────────────────
    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );

    // Blur reads `buf_correction`, uses `buf_a` as mid (free after matmul),
    // writes to `output`. Two blurs: gaussian → buf_correction (overwrite),
    // tail → buf_acc. Wait — we can't blur buf_correction in-place because
    // the V pass reads mid, and our first blur uses buf_a as mid, output to
    // … hmm we'd need a 3rd buffer or sequential reuse.
    //
    // Sequential reuse: blur1 reads buf_correction → writes mid into buf_a
    // → writes output into buf_acc. Then buf_correction is still untouched
    // and ready for blur2. Blur2 reads buf_correction → mid into buf_a →
    // output into… we already wrote buf_acc. Solution: swap roles. The
    // gaussian part can go into buf_acc, tail into buf_correction
    // (overwriting the matmul output — fine, we don't need it after both
    // blurs are done).
    //
    // After blur2 buf_acc = gaussian_part, buf_correction = tail_part.
    // The weighted lerp writes the result into buf_acc (`buf_acc *=
    // (1-w)` then `buf_acc += w * buf_correction`).
    let make_blur_job =
        |sigma: f32, src: &wgpu::Buffer, out: &wgpu::Buffer, label: &str| -> BlurJob {
            let sigma = sigma.max(0.01);
            let radius = fir_blur_radius(sigma);
            let kernel_size = (2 * radius + 1) as usize;
            let sigma_f64 = sigma as f64;
            let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
            let r_i32 = radius as i32;
            let mut kernel = Vec::with_capacity(kernel_size);
            for k in 0..kernel_size {
                let x = (k as i32 - r_i32) as f64;
                kernel.push((-x * x / two_sigma_sq).exp());
            }
            let sum: f64 = kernel.iter().sum();
            let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

            let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("dir_blur_kernel_{label}")),
                contents: bytemuck::cast_slice(&kernel_f32),
                usage: wgpu::BufferUsages::STORAGE,
            });
            #[repr(C)]
            #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
            struct BlurParams {
                width: u32,
                height: u32,
                radius: u32,
                _pad: u32,
            }
            let params = BlurParams {
                width,
                height,
                radius,
                _pad: 0,
            };
            let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("dir_blur_params_{label}")),
                contents: bytemuck::bytes_of(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(&format!("dir_blur_h_{label}")),
                layout: &blur_pipe_h.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: src.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: kernel_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: buf_a.as_entire_binding(),
                    }, // mid
                ],
            });
            let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(&format!("dir_blur_v_{label}")),
                layout: &blur_pipe_v.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: buf_a.as_entire_binding(),
                    }, // mid
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: kernel_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: out.as_entire_binding(),
                    },
                ],
            });
            BlurJob {
                _kernel_buf: kernel_buf,
                _params_buf: params_buf,
                bg_h,
                bg_v,
            }
        };
    // Blur1: correction → buf_gaussian (gaussian_part)
    let blur_gaussian = make_blur_job(
        dp.diffusion_size_px,
        &buf_correction,
        &buf_gaussian,
        "gaussian",
    );
    // Blur2: correction → correction (in place; H writes mid via buf_a,
    // V reads mid and writes buf_correction in a separate compute pass
    // so wgpu does not see input/output aliasing).
    let blur_tail = make_blur_job(
        dp.diffusion_tail_px,
        &buf_correction,
        &buf_correction,
        "tail",
    );

    // ── 3. Weighted lerp via two add_scaled passes ────────────────────
    // buf_mix = (1-w) * buf_gaussian   (clear_first writes scale*src into dst)
    // buf_mix += w * buf_correction  (tail_part)
    let add_scaled_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/add_scaled.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct AddScaledParams {
        n_pixels: u32,
        scale: f32,
        clear_first: u32,
        _pad: u32,
    }
    let w = dp.diffusion_tail_weight;
    let lerp_clear_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_lerp_clear_params"),
        contents: bytemuck::bytes_of(&AddScaledParams {
            n_pixels: n_pixels as u32,
            scale: 1.0 - w,
            clear_first: 1,
            _pad: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    // src = buf_gaussian (read), dst = buf_mix (write). With clear_first=1
    // this is `buf_mix = (1-w) * buf_gaussian`. Different buffers, no
    // aliasing.
    let lerp_clear_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dir_lerp_clear_bg"),
        layout: &add_scaled_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: lerp_clear_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_gaussian.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_mix.as_entire_binding(),
            },
        ],
    });
    let lerp_clear = DispatchJob {
        _params_buf: lerp_clear_params,
        pipeline: add_scaled_pipe.clone(),
        bg: lerp_clear_bg,
    };

    let lerp_acc_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_lerp_acc_params"),
        contents: bytemuck::bytes_of(&AddScaledParams {
            n_pixels: n_pixels as u32,
            scale: w,
            clear_first: 0,
            _pad: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let lerp_acc_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dir_lerp_acc_bg"),
        layout: &add_scaled_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: lerp_acc_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_correction.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_mix.as_entire_binding(),
            },
        ],
    });
    let lerp_accumulate = DispatchJob {
        _params_buf: lerp_acc_params,
        pipeline: add_scaled_pipe.clone(),
        bg: lerp_acc_bg,
    };

    // ── 4. Subtract: buf_b -= buf_mix ────────────────────────────────
    let subtract_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_subtract_params"),
        contents: bytemuck::bytes_of(&AddScaledParams {
            n_pixels: n_pixels as u32,
            scale: -1.0,
            clear_first: 0,
            _pad: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let subtract_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dir_subtract_bg"),
        layout: &add_scaled_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: subtract_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_mix.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_b.as_entire_binding(),
            },
        ],
    });
    let subtract = DispatchJob {
        _params_buf: subtract_params,
        pipeline: add_scaled_pipe,
        bg: subtract_bg,
    };

    // ── 5. Final density curve re-interp using density_curves_0 ───────
    let density_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/density_curve_interp.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    let log_exp_f32: Vec<f32> = dp.log_exposure.iter().map(|&v| v as f32).collect();
    let curves_f32: Vec<f32> = dp
        .density_curves_0
        .iter()
        .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
        .collect();
    let log_exp_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_density_log_exp"),
        contents: bytemuck::cast_slice(&log_exp_f32),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let curves_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_density_curves_0"),
        contents: bytemuck::cast_slice(&curves_f32),
        usage: wgpu::BufferUsages::STORAGE,
    });
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct DensityParams {
        width: u32,
        height: u32,
        k: u32,
        uniform_grid: u32,
        gamma_inv: [f32; 3],
        _pad: f32,
    }
    let density_params = DensityParams {
        width,
        height,
        k: dp.log_exposure.len() as u32,
        uniform_grid: if is_uniform(dp.log_exposure) { 1 } else { 0 },
        gamma_inv: [(1.0 / dp.gamma_factor) as f32; 3],
        _pad: 0.0,
    };
    let density_params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("dir_density_params"),
        contents: bytemuck::bytes_of(&density_params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let density_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("dir_density_bg"),
        layout: &density_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: density_params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_b.as_entire_binding(),
            }, // input: corrected log_raw
            wgpu::BindGroupEntry {
                binding: 2,
                resource: log_exp_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: curves_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: buf_a.as_entire_binding(),
            }, // output: corrected density_cmy
        ],
    });
    // Keep log_exp_buf / curves_buf alive via the DispatchJob's
    // _params_buf isn't ideal — pack them into the state instead.
    let density_curve_0 = DispatchJob {
        _params_buf: density_params_buf,
        pipeline: density_pipe,
        bg: density_bg,
    };

    // The two storage buffers (log_exp, curves) need to outlive the
    // encoder. Stuff them somewhere — extend DirState with a small
    // owner Vec.
    DirState {
        _buf_correction: buf_correction,
        _buf_gaussian: buf_gaussian,
        _buf_mix: buf_mix,
        matmul,
        blur_gaussian,
        blur_tail,
        lerp_clear,
        lerp_accumulate,
        subtract,
        density_curve_0,
        blur_pipe_h,
        blur_pipe_v,
        _owned: vec![log_exp_buf, curves_buf],
    }
}

#[cfg(feature = "wgpu-backend")]
impl DirState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        n_pixels: u32,
        workgroup_size: u32,
        wg_xy: (u32, u32),
    ) {
        let dispatch_linear = |enc: &mut wgpu::CommandEncoder, job: &DispatchJob| {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("dir_linear"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&job.pipeline.pipeline);
            pass.set_bind_group(0, &job.bg, &[]);
            pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
        };
        let dispatch_blur = |enc: &mut wgpu::CommandEncoder, job: &BlurJob| {
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("dir_blur_h"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_h.pipeline);
                pass.set_bind_group(0, &job.bg_h, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("dir_blur_v"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_v.pipeline);
                pass.set_bind_group(0, &job.bg_v, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
        };

        dispatch_linear(encoder, &self.matmul);
        dispatch_blur(encoder, &self.blur_gaussian); // buf_correction → buf_acc
        dispatch_blur(encoder, &self.blur_tail); // buf_correction → buf_correction (overwrite)
        dispatch_linear(encoder, &self.lerp_clear); // buf_acc *= (1-w)
        dispatch_linear(encoder, &self.lerp_accumulate); // buf_acc += w * buf_correction
        dispatch_linear(encoder, &self.subtract); // buf_b -= buf_acc
        dispatch_linear(encoder, &self.density_curve_0); // buf_b → buf_a (corrected)
    }
}

/// Pre-built unsharp mask pass — owns the blur and the combine dispatch.
///
/// CPU equivalent: `spektrafilm_model::diffusion::apply_unsharp_mask`.
/// The combine shader writes to a temp buffer (avoids same-pass
/// aliasing); `encode_passes` then `copy_buffer_to_buffer`s the result
/// back into buf_b so the rest of the pipeline doesn't need to know
/// about the temporary.
#[cfg(feature = "wgpu-backend")]
struct UnsharpState {
    blur: BlurJob,
    combine: DispatchJob,
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
    out_buf: wgpu::Buffer, // combine target; copied back to buf_b at the end
}

#[cfg(feature = "wgpu-backend")]
fn build_unsharp_state(
    device: &wgpu::Device,
    up: &crate::UnsharpGpuParams,
    width: u32,
    height: u32,
    buf_a: &wgpu::Buffer,
    buf_b: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> UnsharpState {
    let n_pixels = (width as usize) * (height as usize);
    let img_bytes = (n_pixels * 3 * 4) as u64;

    // Output buffer for the combine pass. Cleared each render — fine,
    // it's only used between the combine dispatch and the copy_buffer.
    let out_buf = device.create_buffer_t(&wgpu::BufferDescriptor {
        label: Some("unsharp_out"),
        size: img_bytes,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });

    // ── Blur (buf_b → buf_a (mid) → out_buf as the blurred destination
    // tmp). We re-use out_buf for two purposes: it first holds the
    // blurred image, then the combine overwrites it with the final
    // sharpened image.
    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );

    let sigma = up.sigma_px.max(0.01);
    let radius = fir_blur_radius(sigma);
    let kernel_size = (2 * radius + 1) as usize;
    let sigma_f64 = sigma as f64;
    let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
    let r_i32 = radius as i32;
    let mut kernel = Vec::with_capacity(kernel_size);
    for k in 0..kernel_size {
        let x = (k as i32 - r_i32) as f64;
        kernel.push((-x * x / two_sigma_sq).exp());
    }
    let sum: f64 = kernel.iter().sum();
    let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

    let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("unsharp_blur_kernel"),
        contents: bytemuck::cast_slice(&kernel_f32),
        usage: wgpu::BufferUsages::STORAGE,
    });
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct BlurParams {
        width: u32,
        height: u32,
        radius: u32,
        _pad: u32,
    }
    let params = BlurParams {
        width,
        height,
        radius,
        _pad: 0,
    };
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("unsharp_blur_params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    // Need a separate buffer for blur output since out_buf is the
    // combine destination. Use a small fresh allocation.
    let blur_dst = device.create_buffer_t(&wgpu::BufferDescriptor {
        label: Some("unsharp_blur_dst"),
        size: img_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("unsharp_blur_h_bg"),
        layout: &blur_pipe_h.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_b.as_entire_binding(),
            }, // src
            wgpu::BindGroupEntry {
                binding: 2,
                resource: kernel_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: buf_a.as_entire_binding(),
            }, // mid
        ],
    });
    let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("unsharp_blur_v_bg"),
        layout: &blur_pipe_v.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_a.as_entire_binding(),
            }, // mid
            wgpu::BindGroupEntry {
                binding: 2,
                resource: kernel_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: blur_dst.as_entire_binding(),
            }, // blurred output
        ],
    });
    let blur = BlurJob {
        _kernel_buf: kernel_buf,
        _params_buf: params_buf,
        bg_h,
        bg_v,
    };

    // ── Combine: out = (1+amount)*orig - amount*blurred
    let combine_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/unsharp_combine.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct CombineParams {
        n_pixels: u32,
        amount: f32,
        _pad0: u32,
        _pad1: u32,
    }
    let combine_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("unsharp_combine_params"),
        contents: bytemuck::bytes_of(&CombineParams {
            n_pixels: n_pixels as u32,
            amount: up.amount,
            _pad0: 0,
            _pad1: 0,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let combine_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("unsharp_combine_bg"),
        layout: &combine_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: combine_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_b.as_entire_binding(),
            }, // a = original
            wgpu::BindGroupEntry {
                binding: 2,
                resource: blur_dst.as_entire_binding(),
            }, // b = blurred
            wgpu::BindGroupEntry {
                binding: 3,
                resource: out_buf.as_entire_binding(),
            }, // out = sharpened
        ],
    });
    let combine = DispatchJob {
        _params_buf: combine_params,
        pipeline: combine_pipe,
        bg: combine_bg,
    };

    // Drop blur_dst's strong ref into UnsharpState via an owned vec.
    // We need to keep it alive for the encoder lifetime; tucking it
    // into the BlurJob is awkward, so use a separate field.
    let mut state = UnsharpState {
        blur,
        combine,
        blur_pipe_h,
        blur_pipe_v,
        out_buf,
    };
    // Leak the blur output into the combine's owned buffers list by
    // creating it inside the state; here we tuck it into a global
    // owner. Simpler: keep it alive via a sidecar field.
    // (Reusing _params_buf would be confusing; just attach as another
    // implicit slot.)
    let _ = blur_dst; // moved into bind groups, lives via wgpu's Arc
    // wgpu::Buffer is Arc-backed under the hood — the bind groups keep
    // it alive. Nothing to leak here.
    let _ = &mut state;
    state
}

#[cfg(feature = "wgpu-backend")]
impl UnsharpState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        n_pixels: u32,
        workgroup_size: u32,
        wg_xy: (u32, u32),
        buf_b: &wgpu::Buffer,
        img_bytes: u64,
    ) {
        // Blur H + V.
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("unsharp_blur_h"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.blur_pipe_h.pipeline);
            pass.set_bind_group(0, &self.blur.bg_h, &[]);
            pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("unsharp_blur_v"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.blur_pipe_v.pipeline);
            pass.set_bind_group(0, &self.blur.bg_v, &[]);
            pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
        }
        // Combine.
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("unsharp_combine"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.combine.pipeline.pipeline);
            pass.set_bind_group(0, &self.combine.bg, &[]);
            pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
        }
        // Copy sharpened result back into buf_b so the downstream
        // readback sees it without needing to know we used a temp.
        encoder.copy_buffer_to_buffer(&self.out_buf, 0, buf_b, 0, img_bytes);
    }
}

/// Pre-built glare pass — owns the noise-gen dispatch, optional blur,
/// and the additive RGB apply.
///
/// CPU equivalent:
/// `spektrafilm_model::glare::{compute_random_glare_amount,
/// add_glare_with_amount}`. Operates on buf_b (the RGB output of
/// scan_spectral) in place; the lognormal noise is held in a fresh
/// scratch buffer, blurred via the existing 3-channel separable
/// Gaussian.
#[cfg(feature = "wgpu-backend")]
struct GlareState {
    _scratch: wgpu::Buffer,
    gen_dispatch: DispatchJob,
    blur: Option<BlurJob>,
    apply_dispatch: DispatchJob,
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
}

#[cfg(feature = "wgpu-backend")]
fn build_glare_state(
    device: &wgpu::Device,
    gp: &crate::GlareGpuParams,
    width: u32,
    height: u32,
    buf_a: &wgpu::Buffer,
    buf_b: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> GlareState {
    let n_pixels = (width as usize) * (height as usize);
    let img_bytes = (n_pixels * 3 * 4) as u64;

    let scratch = device.create_buffer_t(&wgpu::BufferDescriptor {
        label: Some("glare_scratch"),
        size: img_bytes,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });

    // ── Noise generation ──────────────────────────────────────────────
    let gen_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/glare_gen.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct GenParams {
        n_pixels: u32,
        base_seed: u32,
        mu: f32,
        sigma: f32,
    }
    let gen_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("glare_gen_params"),
        contents: bytemuck::bytes_of(&GenParams {
            n_pixels: n_pixels as u32,
            base_seed: gp.base_seed,
            mu: gp.mu,
            sigma: gp.sigma,
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let gen_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("glare_gen_bg"),
        layout: &gen_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: gen_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: scratch.as_entire_binding(),
            },
        ],
    });
    let gen_dispatch = DispatchJob {
        _params_buf: gen_params,
        pipeline: gen_pipe,
        bg: gen_bg,
    };

    // ── Optional blur (separable, in place on scratch via buf_a mid) ──
    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );
    let blur = if gp.blur_px > 0.0 {
        let sigma = gp.blur_px.max(0.01);
        let radius = fir_blur_radius(sigma);
        let kernel_size = (2 * radius + 1) as usize;
        let sigma_f64 = sigma as f64;
        let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
        let r_i32 = radius as i32;
        let mut kernel = Vec::with_capacity(kernel_size);
        for k in 0..kernel_size {
            let x = (k as i32 - r_i32) as f64;
            kernel.push((-x * x / two_sigma_sq).exp());
        }
        let sum: f64 = kernel.iter().sum();
        let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

        let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("glare_blur_kernel"),
            contents: bytemuck::cast_slice(&kernel_f32),
            usage: wgpu::BufferUsages::STORAGE,
        });
        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct BlurParams {
            width: u32,
            height: u32,
            radius: u32,
            _pad: u32,
        }
        let params = BlurParams {
            width,
            height,
            radius,
            _pad: 0,
        };
        let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("glare_blur_params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glare_blur_h_bg"),
            layout: &blur_pipe_h.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: scratch.as_entire_binding(),
                }, // src (read)
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: buf_a.as_entire_binding(),
                }, // mid
            ],
        });
        let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glare_blur_v_bg"),
            layout: &blur_pipe_v.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_a.as_entire_binding(),
                }, // mid (read)
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: scratch.as_entire_binding(),
                }, // back into scratch (separate pass — no aliasing)
            ],
        });
        Some(BlurJob {
            _kernel_buf: kernel_buf,
            _params_buf: params_buf,
            bg_h,
            bg_v,
        })
    } else {
        None
    };

    // ── Apply: image[c] += glare_amount * rgb_offset[c] ───────────────
    let apply_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/glare_apply.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct ApplyParams {
        n_pixels: u32,
        _pad0: u32,
        _pad1: u32,
        _pad2: u32,
        offset: [f32; 4],
    }
    let apply_params = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("glare_apply_params"),
        contents: bytemuck::bytes_of(&ApplyParams {
            n_pixels: n_pixels as u32,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
            offset: [gp.rgb_offset[0], gp.rgb_offset[1], gp.rgb_offset[2], 0.0],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let apply_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("glare_apply_bg"),
        layout: &apply_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: apply_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: scratch.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_b.as_entire_binding(),
            },
        ],
    });
    let apply_dispatch = DispatchJob {
        _params_buf: apply_params,
        pipeline: apply_pipe,
        bg: apply_bg,
    };

    GlareState {
        _scratch: scratch,
        gen_dispatch,
        blur,
        apply_dispatch,
        blur_pipe_h,
        blur_pipe_v,
    }
}

#[cfg(feature = "wgpu-backend")]
impl GlareState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        n_pixels: u32,
        workgroup_size: u32,
        wg_xy: (u32, u32),
    ) {
        // 1. Noise generation.
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("glare_gen"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.gen_dispatch.pipeline.pipeline);
            pass.set_bind_group(0, &self.gen_dispatch.bg, &[]);
            pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
        }
        // 2. Optional blur.
        if let Some(b) = &self.blur {
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("glare_blur_h"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_h.pipeline);
                pass.set_bind_group(0, &b.bg_h, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("glare_blur_v"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_v.pipeline);
                pass.set_bind_group(0, &b.bg_v, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
        }
        // 3. Apply onto buf_b.
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("glare_apply"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.apply_dispatch.pipeline.pipeline);
            pass.set_bind_group(0, &self.apply_dispatch.bg, &[]);
            pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
        }
    }
}

/// Pre-built output gamut compression pass — a single per-pixel dispatch
/// in place on `buf_b` (the scan output), between glare and unsharp,
/// matching the CPU scanning order. Owns the uniform + `C_max` table
/// buffers so they outlive the encoder.
///
/// CPU equivalent: `OutputGamutCompress::compress`.
#[cfg(feature = "wgpu-backend")]
struct GamutState {
    _cmax_buf: wgpu::Buffer,
    dispatch: DispatchJob,
}

#[cfg(feature = "wgpu-backend")]
fn build_gamut_state(
    device: &wgpu::Device,
    gp: &crate::GamutGpuParams<'_>,
    buf_b: &wgpu::Buffer,
    n_pixels: u32,
    backend: &WgpuBackend,
) -> GamutState {
    let pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gamut_compress.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: true },
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct GamutParams {
        n_pixels: u32,
        mode: u32,
        n_l: u32,
        n_h: u32,
        knee: [f32; 4],
        lightness: [f32; 4],
        lspace: [f32; 4],
    }
    let lightness = match gp.lightness {
        Some([t, l, p]) => [t, l, p, 1.0],
        None => [0.0, 1.0, 1.0, 0.0],
    };
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("gamut_params"),
        contents: bytemuck::bytes_of(&GamutParams {
            n_pixels,
            mode: gp.mode,
            n_l: gp.n_l,
            n_h: gp.n_h,
            knee: [gp.knee[0], gp.knee[1], gp.knee[2], 0.0],
            lightness,
            lspace: [gp.l_white, gp.l_min, gp.l_max, 0.0],
        }),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    // aces_rgc carries no table — bind a 1-element placeholder (the shader
    // never reads it on that mode; wgpu requires a non-empty binding).
    let cmax_buf = if gp.cmax.is_empty() {
        backend.static_storage("gamut_cmax", bytemuck::cast_slice(&[0.0f32]))
    } else {
        backend.static_storage_f64("gamut_cmax", gp.cmax)
    };
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("gamut_bg"),
        layout: &pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: cmax_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf_b.as_entire_binding(),
            },
        ],
    });
    GamutState {
        _cmax_buf: cmax_buf,
        dispatch: DispatchJob {
            _params_buf: params_buf,
            pipeline: pipe,
            bg,
        },
    }
}

#[cfg(feature = "wgpu-backend")]
impl GamutState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        n_pixels: u32,
        workgroup_size: u32,
    ) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("gamut_compress"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.dispatch.pipeline.pipeline);
        pass.set_bind_group(0, &self.dispatch.bg, &[]);
        pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
    }
}

/// Pre-built grain pass — owns the grain compute bind group plus the
/// optional post-blur pipeline state.
///
/// CPU equivalent: `spektrafilm_model::grain::apply_grain_to_density`.
/// Operates in place on `buf_a` (density_cmy). When `grain_blur > 0.4`,
/// follows up with a separable Gaussian blur that uses `buf_b` as mid
/// (free at this point — DIR's `density_curve_0` already overwrote
/// buf_b's role).
#[cfg(feature = "wgpu-backend")]
struct GrainState {
    grain_dispatch: DispatchJob,
    blur: Option<BlurJob>,
    blur_pipe_h: CachedPipelineRef,
    blur_pipe_v: CachedPipelineRef,
}

#[cfg(feature = "wgpu-backend")]
fn build_grain_state(
    device: &wgpu::Device,
    gp: &crate::GrainGpuParams,
    width: u32,
    height: u32,
    buf_a: &wgpu::Buffer,
    buf_b: &wgpu::Buffer,
    backend: &WgpuBackend,
) -> GrainState {
    let n_pixels = (width as usize) * (height as usize);

    let grain_pipe = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/grain.wgsl"),
        &[
            wgpu::BufferBindingType::Uniform,
            wgpu::BufferBindingType::Storage { read_only: false },
        ],
    );
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct GrainParams {
        n_pixels: u32,
        base_seed: u32,
        n_sub_layers: u32,
        monochrome: u32,
        density_min: [f32; 4],
        density_max: [f32; 4],
        n_particles_per_pixel: [f32; 4],
        grain_uniformity: [f32; 4],
    }
    let params = GrainParams {
        n_pixels: n_pixels as u32,
        base_seed: gp.base_seed,
        n_sub_layers: gp.n_sub_layers.max(1),
        monochrome: gp.monochrome as u32,
        density_min: [gp.density_min[0], gp.density_min[1], gp.density_min[2], 0.0],
        density_max: [gp.density_max[0], gp.density_max[1], gp.density_max[2], 0.0],
        n_particles_per_pixel: [
            gp.n_particles_per_pixel[0],
            gp.n_particles_per_pixel[1],
            gp.n_particles_per_pixel[2],
            0.0,
        ],
        grain_uniformity: [
            gp.grain_uniformity[0],
            gp.grain_uniformity[1],
            gp.grain_uniformity[2],
            0.0,
        ],
    };
    let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
        label: Some("grain_params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("grain_bg"),
        layout: &grain_pipe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: buf_a.as_entire_binding(),
            },
        ],
    });
    let grain_dispatch = DispatchJob {
        _params_buf: params_buf,
        pipeline: grain_pipe,
        bg,
    };

    // Optional post-blur: blur buf_a → buf_a in place (H writes mid=buf_b,
    // V reads buf_b writes buf_a, separate compute passes so no aliasing).
    let blur_layout = &[
        wgpu::BufferBindingType::Uniform,
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: true },
        wgpu::BufferBindingType::Storage { read_only: false },
    ];
    let blur_pipe_h = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_h.wgsl"),
        blur_layout,
    );
    let blur_pipe_v = backend.cached_pipeline(
        include_str!("../../spektrafilm-shaders/wgsl/gaussian_blur_v.wgsl"),
        blur_layout,
    );
    let blur = if gp.grain_blur > 0.4 {
        let sigma = gp.grain_blur.max(0.01);
        let radius = fir_blur_radius(sigma);
        let kernel_size = (2 * radius + 1) as usize;
        let sigma_f64 = sigma as f64;
        let two_sigma_sq = 2.0 * sigma_f64 * sigma_f64;
        let r_i32 = radius as i32;
        let mut kernel = Vec::with_capacity(kernel_size);
        for k in 0..kernel_size {
            let x = (k as i32 - r_i32) as f64;
            kernel.push((-x * x / two_sigma_sq).exp());
        }
        let sum: f64 = kernel.iter().sum();
        let kernel_f32: Vec<f32> = kernel.into_iter().map(|v| (v / sum) as f32).collect();

        let kernel_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("grain_blur_kernel"),
            contents: bytemuck::cast_slice(&kernel_f32),
            usage: wgpu::BufferUsages::STORAGE,
        });
        #[repr(C)]
        #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct BlurParams {
            width: u32,
            height: u32,
            radius: u32,
            _pad: u32,
        }
        let params = BlurParams {
            width,
            height,
            radius,
            _pad: 0,
        };
        let params_buf = device.create_buffer_init_t(&wgpu::util::BufferInitDescriptor {
            label: Some("grain_blur_params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bg_h = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grain_blur_h_bg"),
            layout: &blur_pipe_h.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_a.as_entire_binding(),
                }, // src
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: buf_b.as_entire_binding(),
                }, // mid
            ],
        });
        let bg_v = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grain_blur_v_bg"),
            layout: &blur_pipe_v.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: buf_b.as_entire_binding(),
                }, // mid
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: kernel_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: buf_a.as_entire_binding(),
                }, // dst (in place)
            ],
        });
        Some(BlurJob {
            _kernel_buf: kernel_buf,
            _params_buf: params_buf,
            bg_h,
            bg_v,
        })
    } else {
        None
    };

    GrainState {
        grain_dispatch,
        blur,
        blur_pipe_h,
        blur_pipe_v,
    }
}

#[cfg(feature = "wgpu-backend")]
impl GrainState {
    fn encode_passes(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        n_pixels: u32,
        workgroup_size: u32,
        wg_xy: (u32, u32),
    ) {
        // Grain compute.
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("grain_compute"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.grain_dispatch.pipeline.pipeline);
            pass.set_bind_group(0, &self.grain_dispatch.bg, &[]);
            pass.dispatch_workgroups((n_pixels + workgroup_size - 1) / workgroup_size, 1, 1);
        }
        // Optional post-blur.
        if let Some(b) = &self.blur {
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("grain_blur_h"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_h.pipeline);
                pass.set_bind_group(0, &b.bg_h, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("grain_blur_v"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.blur_pipe_v.pipeline);
                pass.set_bind_group(0, &b.bg_v, &[]);
                pass.dispatch_workgroups(wg_xy.0, wg_xy.1, 1);
            }
        }
    }
}

/// Detects whether a 1D sequence is uniformly spaced (within tight tolerance).
#[cfg(feature = "wgpu-backend")]
fn is_uniform(xs: &[f64]) -> bool {
    if xs.len() < 3 {
        return true;
    }
    let step = (xs[xs.len() - 1] - xs[0]) / (xs.len() as f64 - 1.0);
    let tol = step.abs() * 1e-9 + 1e-12;
    for i in 1..xs.len() {
        let expected = xs[0] + (i as f64) * step;
        if (xs[i] - expected).abs() > tol {
            return false;
        }
    }
    true
}
