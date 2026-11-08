// Grain blur, horizontal pass, one kernel per colour channel (R, G, B = the three dye layers: GrainParams `layer_blur_fast`).
// Each thread convolves `2*radius+1` samples of a row (indices clamped at the borders). The kernels are built on the CPU
// (wgpu_backend.rs `grain_blur_job`): three back to back, each zero-padded to the widest radius. Pairs with
// `grain_blur_v_add.wgsl`.

struct Params {
    width: u32,
    height: u32,
    radius: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;   // [H*W*3]
@group(0) @binding(2) var<storage, read> kernel_buf: array<f32>;  // [3][2*radius+1]: kernel of R, G, B (zero-padded to the widest radius)
@group(0) @binding(3) var<storage, read_write> output: array<f32>; // [H*W*3]

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if x >= params.width || y >= params.height {
        return;
    }

    var sum = vec3<f32>(0.0, 0.0, 0.0);
    let kernel_size = 2u * params.radius + 1u;
    let w_g = kernel_size;
    let w_b = 2u * kernel_size;
    let w_i32 = i32(params.width);
    for (var k = 0u; k < kernel_size; k++) {
        let dx = i32(k) - i32(params.radius);
        let sx_signed = i32(x) + dx;
        let sx = u32(clamp(sx_signed, 0i, w_i32 - 1i));
        let idx = (y * params.width + sx) * 3u;
        let w = vec3<f32>(kernel_buf[k], kernel_buf[w_g + k], kernel_buf[w_b + k]);
        sum.x += w.x * input[idx];
        sum.y += w.y * input[idx + 1u];
        sum.z += w.z * input[idx + 2u];
    }

    let out_idx = (y * params.width + x) * 3u;
    output[out_idx] = sum.x;
    output[out_idx + 1u] = sum.y;
    output[out_idx + 2u] = sum.z;
}
