// Frontier scanner: film density CMY -> linear RGB through the baked 3D LUT.
//
// The LUT (built on the CPU by `FrontierLut`, the same table the CPU path
// interpolates) holds the sRGB-ENCODED positive at steps^3 nodes spread
// uniformly over [data_min, data_max]. Trilinear lookup, then sRGB decode so
// the rest of the chain (blur, unsharp, gamut, output encoding) is unchanged.
// `frontier::trilinear_reference` is the same maths in Rust (parity test).
// Hyper Tone (`hyper.on` = 1): before the lookup the density moves by `gain * map(frame position)`
// (spektrafilm-gpu `hyper_map` is the same sampling in Rust, used by the CPU scan).

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

struct Hyper {
    map_w: u32,
    map_h: u32,
    on: u32,
    pad: u32,
    origin_frame: vec4<f32>,   // xy: this render's top-left in the frame (px), zw: the frame size (px)
    gain: vec4<f32>,           // xyz: density per map EV (the same on the three layers)
    toe: vec4<f32>,            // x: the stock's toe end (G density), y: the red layer's shortfall there
}
@group(0) @binding(4) var<uniform> hyper: Hyper;
@group(0) @binding(5) var<storage, read> hyper_map_data: array<f32>;   // [map_h*map_w]

fn hyper_map(x: u32, y: u32) -> f32 {
    let mw = f32(hyper.map_w);
    let mh = f32(hyper.map_h);
    let fx = clamp((hyper.origin_frame.x + f32(x) + 0.5) / hyper.origin_frame.z * mw - 0.5, 0.0, mw - 1.0);
    let fy = clamp((hyper.origin_frame.y + f32(y) + 0.5) / hyper.origin_frame.w * mh - 0.5, 0.0, mh - 1.0);
    let x0 = u32(floor(fx));
    let y0 = u32(floor(fy));
    let x1 = min(x0 + 1u, hyper.map_w - 1u);
    let y1 = min(y0 + 1u, hyper.map_h - 1u);
    let tx = fx - f32(x0);
    let ty = fy - f32(y0);
    let top = hyper_map_data[y0 * hyper.map_w + x0] * (1.0 - tx) + hyper_map_data[y0 * hyper.map_w + x1] * tx;
    let bot = hyper_map_data[y1 * hyper.map_w + x0] * (1.0 - tx) + hyper_map_data[y1 * hyper.map_w + x1] * tx;
    return top * (1.0 - ty) + bot * ty;
}

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
    var cmy = vec3<f32>(density_cmy[base], density_cmy[base + 1u], density_cmy[base + 2u]);
    if hyper.on == 1u {
        // spektrafilm-gpu `hyper_apply`: a lift inside the toe gives the red layer less (cyan voids)
        let delta = hyper.gain.x * hyper_map(pixel_idx % params.width, pixel_idx / params.width);
        var r = delta;
        if delta > 0.0 && hyper.toe.y > 0.0 && hyper.toe.x > 0.0 {
            let tt = clamp(cmy.y / hyper.toe.x, 0.0, 1.0);
            r = r * (1.0 - hyper.toe.y * (1.0 - tt * tt * (3.0 - 2.0 * tt)));
        }
        cmy = cmy + vec3<f32>(r, delta, delta);
    }
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
