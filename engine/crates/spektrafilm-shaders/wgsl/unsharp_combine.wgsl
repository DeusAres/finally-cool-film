// Unsharp mask combine pass:
//   out[i] = a[i] + amount * (a[i] - b[i])
//          = (1 + amount) * a[i] - amount * b[i]
//
// `a` is the original image (read), `b` is the blurred version (read),
// `out` is the destination (write — different buffer from a, b).
// Hyper Sharpness (t1 > 0): the detail is gated per pixel, as spektrafilm-model `unsharp_gate` (same maths).

struct Params {
    n_pixels: u32,
    amount: f32,
    t0: f32,
    t1: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> a_buf: array<f32>;
@group(0) @binding(2) var<storage, read> b_buf: array<f32>;
@group(0) @binding(3) var<storage, read_write> out_buf: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    if params.t1 > 0.0 {
        let o = vec3<f32>(a_buf[base], a_buf[base + 1u], a_buf[base + 2u]);
        let b = vec3<f32>(b_buf[base], b_buf[base + 1u], b_buf[base + 2u]);
        let yd = ((o.x - b.x) + (o.y - b.y) + (o.z - b.z)) / 3.0;
        let yb = max((b.x + b.y + b.z) / 3.0, 0.01);   // UNSHARP_Y_FLOOR
        let k = clamp(sqrt(0.18 / yb), 1.0, 4.0);   // x2 per 2 stops below mid grey (shadow grain), up to x4
        let t = clamp((abs(yd) / yb - k * params.t0) / max(k * (params.t1 - params.t0), 1e-6), 0.0, 1.0);
        let r = o + (params.amount * t * t * (3.0 - 2.0 * t)) * (o - b);
        out_buf[base] = r.x;
        out_buf[base + 1u] = r.y;
        out_buf[base + 2u] = r.z;
        return;
    }
    let k1 = 1.0 + params.amount;
    let k2 = params.amount;
    out_buf[base] = k1 * a_buf[base] - k2 * b_buf[base];
    out_buf[base + 1u] = k1 * a_buf[base + 1u] - k2 * b_buf[base + 1u];
    out_buf[base + 2u] = k1 * a_buf[base + 2u] - k2 * b_buf[base + 2u];
}
