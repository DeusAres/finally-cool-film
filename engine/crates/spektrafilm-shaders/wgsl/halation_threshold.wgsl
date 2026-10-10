// Halation light threshold: dst = E * smoothstep(lo, hi, E)  (per element).
//
// Must match `spektrafilm_math::halation_knee::halation_source` exactly;
// `lo` / `hi` are computed on the host by `halation_threshold_bounds`.

struct Params {
    n_pixels: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    bounds: vec4<f32>, // .x = lo, .y = hi
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

fn knee(e: f32) -> f32 {
    let t = clamp((e - params.bounds.x) / (params.bounds.y - params.bounds.x), 0.0, 1.0);
    return max(e, 0.0) * t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    dst[base]      = knee(src[base]);
    dst[base + 1u] = knee(src[base + 1u]);
    dst[base + 2u] = knee(src[base + 2u]);
}
