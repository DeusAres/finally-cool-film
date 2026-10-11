// Counter-based dye-cloud grain on film density CMY (in place).
//
// Mirror of `spektrafilm_model::grain_hash::grain_density_pixel` (the Rust
// reference; keep the two in lockstep, see the parity tests). Per pixel and
// layer an independent PCG stream keyed by (seed, layer + 10*sub-layer,
// global px = origin + local) draws a Poisson number of seeds and a binomial
// developed count (exact inversion below mean 30, normal approximation
// above), then a log-normal micro-structure on the deviation. The dye-cloud
// blur is a separate gaussian pass.

struct Params {
    width: u32,
    height: u32,
    n_sub_layers: u32,
    monochrome: u32,
    seed_lo: u32,
    seed_hi: u32,
    origin_x: u32,
    origin_y: u32,
    density_min: vec4<f32>,
    density_max: vec4<f32>,       // includes density_min
    n_particles: vec4<f32>,       // per sub-layer
    uniformity: vec4<f32>,
    micro_sigma: f32,
    amount: f32,
    pad0: f32,
    pad1: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> density_cmy: array<f32>;

const EXACT_MAX_MEAN: f32 = 30.0;
const MAX_STEPS: u32 = 120u;

fn pcg(x: u32) -> u32 {
    let s = x * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn unit_open(x: u32) -> f32 {
    return (f32(x >> 8u) + 0.5) * (1.0 / 16777216.0);
}

fn stream_key(stream: u32) -> u32 {
    return pcg(params.seed_lo ^ pcg(params.seed_hi ^ 0x68e31da4u) ^ pcg(stream * 0x9e3779b9u + 0x7f4a7c15u));
}

fn pixel_state(key: u32, gx: u32, gy: u32) -> u32 {
    var h = pcg(key ^ (gx * 0x9e3779b1u));
    h = pcg(h ^ (gy * 0x85ebca6bu) ^ 0x27d4eb2fu);
    return pcg(h + key);
}

fn draw(st: ptr<function, u32>) -> f32 {
    *st = pcg(*st);
    return unit_open(*st);
}

fn std_normal(st: ptr<function, u32>) -> f32 {
    let u1 = draw(st);
    let u2 = draw(st);
    return sqrt(-2.0 * log(u1)) * cos(6.2831855 * u2);
}

fn ln_1m(x: f32) -> f32 {
    if x < 0.01 {
        return -(x + x * x * 0.5 + x * x * x * (1.0 / 3.0));
    }
    return log(1.0 - x);
}

fn poisson(lambda: f32, st: ptr<function, u32>) -> f32 {
    if lambda < EXACT_MAX_MEAN {
        let u = draw(st);
        var f = exp(-lambda);
        var c = f;
        var k = 0.0;
        for (var i = 0u; i < MAX_STEPS; i++) {
            if u <= c { break; }
            k += 1.0;
            f *= lambda / k;
            c += f;
        }
        return k;
    }
    let z = std_normal(st);
    return max(floor(lambda + sqrt(lambda) * z + 0.5), 0.0);
}

fn binomial(n: f32, p: f32, q: f32, st: ptr<function, u32>) -> f32 {
    if n <= 0.0 { return 0.0; }
    let np = n * p;
    let nq = n * q;
    if min(np, nq) < EXACT_MAX_MEAN {
        let flip = nq < np;
        var pr = p;
        var qr = q;
        if flip { pr = q; qr = p; }
        let u = draw(st);
        var f = exp(n * ln_1m(pr));
        var c = f;
        let ratio = pr / qr;
        var k = 0.0;
        for (var i = 0u; i < MAX_STEPS; i++) {
            if u <= c || k >= n { break; }
            f *= (n - k) / (k + 1.0) * ratio;
            k += 1.0;
            c += f;
        }
        if flip { return n - k; }
        return k;
    }
    let z = std_normal(st);
    return clamp(floor(np + sqrt(np * q) * z + 0.5), 0.0, n);
}

const FAST_OD_SHARE: f32 = 0.3;
const FAST_K: f32 = 3.3;
const FAST_COUNT_FRAC: f32 = 0.002;
const LAYER_COUPLING: f32 = 0.45;

fn grain_density(d: vec3<f32>, gx: u32, gy: u32) -> vec3<f32> {
    var out = d;
    var devs = vec3<f32>(0.0);
    for (var ch = 0u; ch < 3u; ch++) {
        var layer = ch;
        if params.monochrome != 0u { layer = 0u; }
        let dmin = params.density_min[ch];
        let dmax = params.density_max[ch];
        let npp = params.n_particles[ch];
        let od_particle = dmax / npp;
        let d_in = d[ch] + dmin;
        let p = clamp(d_in / dmax, 1e-6, 1.0 - 1e-6);
        let q = clamp((dmax - d_in) / dmax, 1e-6, 1.0 - 1e-6);
        let sat = 1.0 - p * params.uniformity[ch] * (1.0 - 1e-6);
        let lambda = npp / sat;
        var sum = 0.0;
        if params.n_sub_layers >= 2u {
            let npp_tot = npp * f32(params.n_sub_layers);
            let qk = pow(q, FAST_K);
            let p_fast = clamp(1.0 - qk, 1e-6, 1.0 - 1e-6);
            let q_fast = clamp(qk, 1e-6, 1.0 - 1e-6);
            let w_slow = 1.0 - FAST_OD_SHARE;
            let p_slow = clamp((p - FAST_OD_SHARE * p_fast) / w_slow, 1e-6, 1.0 - 1e-6);
            let q_slow = clamp((q - FAST_OD_SHARE * qk) / w_slow, 1e-6, 1.0 - 1e-6);
            for (var sl = 0u; sl < 2u; sl++) {
                var ps = p_fast; var qs = q_fast; var w = FAST_OD_SHARE; var cf = FAST_COUNT_FRAC;
                if sl == 1u { ps = p_slow; qs = q_slow; w = w_slow; cf = 1.0 - FAST_COUNT_FRAC; }
                let npp_s = npp_tot * cf;
                let sat_s = 1.0 - ps * params.uniformity[ch] * (1.0 - 1e-6);
                var st = pixel_state(stream_key(layer + sl * 10u), gx, gy);
                let seeds = poisson(npp_s / sat_s, &st);
                let developed = binomial(seeds, ps, qs, &st);
                sum += developed * (dmax * w / npp_s) * sat_s;
            }
        } else {
            for (var sl = 0u; sl < params.n_sub_layers; sl++) {
                var st = pixel_state(stream_key(layer + sl * 10u), gx, gy);
                let seeds = poisson(lambda, &st);
                let developed = binomial(seeds, p, q, &st);
                sum += developed * od_particle * sat;
            }
            sum = sum / f32(params.n_sub_layers);
        }
        let grain = sum - dmin;
        var dev = grain - d[ch];
        if params.micro_sigma > 0.0 {
            var st = pixel_state(stream_key(1000u + layer), gx, gy);
            let z = std_normal(&st);
            dev *= exp(params.micro_sigma * z - 0.5 * params.micro_sigma * params.micro_sigma);
        }
        devs[ch] = dev;
    }
    let mean = (devs.x + devs.y + devs.z) * (1.0 / 3.0);
    for (var ch = 0u; ch < 3u; ch++) {
        out[ch] = d[ch] + params.amount * (devs[ch] + LAYER_COUPLING * (mean - devs[ch]));
    }
    return out;
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.width * params.height { return; }
    let base = idx * 3u;
    let d = vec3<f32>(density_cmy[base], density_cmy[base + 1u], density_cmy[base + 2u]);
    let o = grain_density(d, params.origin_x + idx % params.width, params.origin_y + idx / params.width);
    density_cmy[base] = o.x;
    density_cmy[base + 1u] = o.y;
    density_cmy[base + 2u] = o.z;
}
