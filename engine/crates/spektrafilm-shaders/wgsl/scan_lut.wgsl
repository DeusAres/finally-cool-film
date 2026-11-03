// Frontier scanner: film density CMY -> linear RGB through the baked 3D LUT.
//
// The LUT (built on the CPU by `FrontierLut`, the same table the CPU path
// interpolates) holds the sRGB-ENCODED positive at steps^3 nodes spread
// uniformly over [data_min, data_max]. Trilinear lookup, then sRGB decode so
// the rest of the chain (blur, unsharp, gamut, output encoding) is unchanged.
// `frontier::trilinear_reference` is the same maths in Rust (parity test).

struct Params {
    width: u32,
    height: u32,
    steps: u32,
    pad: u32,
    data_min: vec4<f32>,   // xyz
    inv: vec4<f32>,        // xyz: (steps-1)/(data_max-data_min)
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> density_cmy: array<f32>;      // [H*W*3]
@group(0) @binding(2) var<storage, read> lut: array<f32>;              // [steps^3*3], r-major
@group(0) @binding(3) var<storage, read_write> output_rgb: array<f32>; // [H*W*3]

fn node(i: u32, j: u32, k: u32) -> vec3<f32> {
    let b = ((i * params.steps + j) * params.steps + k) * 3u;
    return vec3<f32>(lut[b], lut[b + 1u], lut[b + 2u]);
}

fn srgb_decode(x: f32) -> f32 {
    if x <= 0.04045 {
        return x / 12.92;
    }
    return pow((x + 0.055) / 1.055, 2.4);
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pixel_idx = gid.x;
    if pixel_idx >= params.width * params.height {
        return;
    }
    let base = pixel_idx * 3u;
    let cmy = vec3<f32>(density_cmy[base], density_cmy[base + 1u], density_cmy[base + 2u]);
    let top = f32(params.steps - 1u);
    let p = clamp((cmy - params.data_min.xyz) * params.inv.xyz, vec3<f32>(0.0), vec3<f32>(top));
    let i0 = min(vec3<u32>(floor(p)), vec3<u32>(params.steps - 2u));
    let t = p - vec3<f32>(i0);
    let c00 = mix(node(i0.x, i0.y, i0.z), node(i0.x, i0.y, i0.z + 1u), t.z);
    let c01 = mix(node(i0.x, i0.y + 1u, i0.z), node(i0.x, i0.y + 1u, i0.z + 1u), t.z);
    let c10 = mix(node(i0.x + 1u, i0.y, i0.z), node(i0.x + 1u, i0.y, i0.z + 1u), t.z);
    let c11 = mix(node(i0.x + 1u, i0.y + 1u, i0.z), node(i0.x + 1u, i0.y + 1u, i0.z + 1u), t.z);
    let y = mix(mix(c00, c01, t.y), mix(c10, c11, t.y), t.x);
    output_rgb[base] = srgb_decode(y.x);
    output_rgb[base + 1u] = srgb_decode(y.y);
    output_rgb[base + 2u] = srgb_decode(y.z);
}
