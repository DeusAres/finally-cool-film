// Counter-based dye-cloud grain on film density CMY (in place).
//
// Mirror of `spektrafilm_model::grain_hash::grain_density_pixel` (the Rust
// reference; keep the two in lockstep, see the parity tests). Per pixel and
// layer an independent PCG stream keyed by (seed, layer + 10*sub-layer,
// global px = origin + local) draws a Poisson number of seeds and a binomial
// developed count (exact inversion below mean 30, normal approximation
// above), then a log-normal micro-structure on the deviation. The dye-cloud
// blur is a separate gaussian pass on the grain only: with `dev_only` set the
// density is left as is and the deviation goes to `grain_dev`, blurred and
// added back (grain_blur_v_add.wgsl), so the image itself is not softened.

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
    dev_only: f32,                // 1: write grainy - clean to grain_dev, keep density_cmy
    split: f32,                   // 1 (with dev_only): the fast crystals' deviation to grain_dev_fast, the rest to grain_dev
    fast_count_frac: f32,         // share of the crystals that are fast (two-population emulsions)
    scan_noise: f32,              // the scanner's noise (scan_noise_rgb in grain_hash.rs): sigma at density 1,
    scan_noise_slope: f32,        // its growth 10^(slope (d - 1)),
    scan_noise_chroma: f32,       // its colour share (1: channels independent, 0: one draw)
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> density_cmy: array<f32>;
@group(0) @binding(2) var<storage, read_write> grain_dev: array<f32>;
@group(0) @binding(3) var<storage, read_write> grain_dev_fast: array<f32>;

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
            let c2 = c + f;
            if c2 == c { break; }
            c = c2;
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
            let c2 = c + f;
            if c2 == c { break; }
            c = c2;
        }
        if flip { return n - k; }
        return k;
    }
    let z = std_normal(st);
    return clamp(floor(np + sqrt(np * q) * z + 0.5), 0.0, n);
}

const FAST_OD_SHARE: f32 = 0.3;
const FAST_K: f32 = 3.3;
const LAYER_COUPLING: f32 = 0.97;
// coupling rises to LAYER_COUPLING_HI between mean developed fraction COUPLING_P0 and COUPLING_P1
// (lights: less coloured grain where the shoulder squeezes luma only); see grain_hash.rs
const LAYER_COUPLING_HI: f32 = 0.97;
const COUPLING_P0: f32 = 0.5;
const COUPLING_P1: f32 = 0.6;
// ... and also with the spread (max - min) of the three developed fractions between COUPLING_S0 and COUPLING_S1 (saturated colours)
const COUPLING_S0: f32 = 0.12;
const COUPLING_S1: f32 = 0.22;

fn grain_density(d: vec3<f32>, gx: u32, gy: u32) -> vec3<f32> {
    var out = d;
    var devs = vec3<f32>(0.0);
    var d_ins = vec3<f32>(0.0);
    var p_sum = 0.0;
    var p_lo = 1.0;
    var p_hi = 0.0;
    for (var ch = 0u; ch < 3u; ch++) {
        var layer = ch;
        if params.monochrome != 0u { layer = 0u; }
        let dmin = params.density_min[ch];
        let dmax = params.density_max[ch];
        let npp = params.n_particles[ch];
        let od_particle = dmax / npp;
        let d_in = d[ch] + dmin;
        let p = clamp(d_in / dmax, 1e-6, 1.0 - 1e-6);
        p_sum += p;
        p_lo = min(p_lo, p);
        p_hi = max(p_hi, p);
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
                var ps = p_fast; var qs = q_fast; var w = FAST_OD_SHARE; var cf = params.fast_count_frac;
                if sl == 1u { ps = p_slow; qs = q_slow; w = w_slow; cf = 1.0 - params.fast_count_frac; }
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
        d_ins[ch] = d_in;
        if params.micro_sigma > 0.0 {
            var st = pixel_state(stream_key(1000u + layer), gx, gy);
            let z = std_normal(&st);
            dev *= exp(params.micro_sigma * z - 0.5 * params.micro_sigma * params.micro_sigma);
        }
        devs[ch] = dev;
    }
    let mean = (devs.x + devs.y + devs.z) * (1.0 / 3.0);
    let tt = clamp((p_sum * (1.0 / 3.0) - COUPLING_P0) / (COUPLING_P1 - COUPLING_P0), 0.0, 1.0);
    let uu = clamp((p_hi - p_lo - COUPLING_S0) / (COUPLING_S1 - COUPLING_S0), 0.0, 1.0);
    let cpl = LAYER_COUPLING + (LAYER_COUPLING_HI - LAYER_COUPLING) * max(tt * tt * (3.0 - 2.0 * tt), uu * uu * (3.0 - 2.0 * uu));
    var noise = vec3<f32>(0.0);
    if params.scan_noise > 0.0 { noise = scan_noise_rgb(d_ins, gx, gy); }
    for (var ch = 0u; ch < 3u; ch++) {
        out[ch] = d[ch] + params.amount * (devs[ch] + cpl * (mean - devs[ch]) + noise[ch]);
    }
    return out;
}

// scan_noise_rgb (grain_hash.rs): the scanner's noise at the three densities d_in, after the layer coupling.
fn scan_noise_rgb(d_in: vec3<f32>, gx: u32, gy: u32) -> vec3<f32> {
    var st = pixel_state(stream_key(2003u), gx, gy);
    let z_all = std_normal(&st) * sqrt(max(1.0 - params.scan_noise_chroma * params.scan_noise_chroma, 0.0));
    var out = vec3<f32>(0.0);
    for (var ch = 0u; ch < 3u; ch++) {
        var s2 = pixel_state(stream_key(2000u + ch), gx, gy);
        let z = params.scan_noise_chroma * std_normal(&s2) + z_all;
        out[ch] = params.scan_noise * pow(10.0, params.scan_noise_slope * (d_in[ch] - 1.0)) * z;
    }
    return out;
}

// grain_dev_split (grain_hash.rs): the deviation split by population, [fast, slow], amount and coupling applied.
// Two-population emulsions (n_sub_layers >= 2) only.
fn grain_devs(d: vec3<f32>, gx: u32, gy: u32) -> array<vec3<f32>, 2> {
    var devs = array<vec3<f32>, 2>(vec3<f32>(0.0), vec3<f32>(0.0));
    var d_ins = vec3<f32>(0.0);
    var p_sum = 0.0;
    var p_lo = 1.0;
    var p_hi = 0.0;
    for (var ch = 0u; ch < 3u; ch++) {
        var layer = ch;
        if params.monochrome != 0u { layer = 0u; }
        let dmin = params.density_min[ch];
        let dmax = params.density_max[ch];
        let d_in = d[ch] + dmin;
        let p = clamp(d_in / dmax, 1e-6, 1.0 - 1e-6);
        p_sum += p;
        p_lo = min(p_lo, p);
        p_hi = max(p_hi, p);
        let q = clamp((dmax - d_in) / dmax, 1e-6, 1.0 - 1e-6);
        let npp_tot = params.n_particles[ch] * f32(params.n_sub_layers);
        let qk = pow(q, FAST_K);
        let p_fast = clamp(1.0 - qk, 1e-6, 1.0 - 1e-6);
        let q_fast = clamp(qk, 1e-6, 1.0 - 1e-6);
        let w_slow = 1.0 - FAST_OD_SHARE;
        let p_slow = clamp((p - FAST_OD_SHARE * p_fast) / w_slow, 1e-6, 1.0 - 1e-6);
        let q_slow = clamp((q - FAST_OD_SHARE * qk) / w_slow, 1e-6, 1.0 - 1e-6);
        var contrib = vec2<f32>(0.0);
        for (var sl = 0u; sl < 2u; sl++) {
            var ps = p_fast; var qs = q_fast; var w = FAST_OD_SHARE; var cf = params.fast_count_frac;
            if sl == 1u { ps = p_slow; qs = q_slow; w = w_slow; cf = 1.0 - params.fast_count_frac; }
            let npp_s = npp_tot * cf;
            let sat_s = 1.0 - ps * params.uniformity[ch] * (1.0 - 1e-6);
            var st = pixel_state(stream_key(layer + sl * 10u), gx, gy);
            let seeds = poisson(npp_s / sat_s, &st);
            let developed = binomial(seeds, ps, qs, &st);
            contrib[sl] = developed * (dmax * w / npp_s) * sat_s;
        }
        let dev = contrib.x + contrib.y - dmin - d[ch];
        d_ins[ch] = d_in;
        let fast = contrib.x - p_fast * dmax * FAST_OD_SHARE;
        var m = 1.0;
        if params.micro_sigma > 0.0 {
            var st = pixel_state(stream_key(1000u + layer), gx, gy);
            let z = std_normal(&st);
            m = exp(params.micro_sigma * z - 0.5 * params.micro_sigma * params.micro_sigma);
        }
        devs[0][ch] = fast * m;
        devs[1][ch] = (dev - fast) * m;
    }
    let tt = clamp((p_sum * (1.0 / 3.0) - COUPLING_P0) / (COUPLING_P1 - COUPLING_P0), 0.0, 1.0);
    let uu = clamp((p_hi - p_lo - COUPLING_S0) / (COUPLING_S1 - COUPLING_S0), 0.0, 1.0);
    let cpl = LAYER_COUPLING + (LAYER_COUPLING_HI - LAYER_COUPLING) * max(tt * tt * (3.0 - 2.0 * tt), uu * uu * (3.0 - 2.0 * uu));
    var noise = vec3<f32>(0.0);
    if params.scan_noise > 0.0 { noise = scan_noise_rgb(d_ins, gx, gy); }
    var out = array<vec3<f32>, 2>(vec3<f32>(0.0), vec3<f32>(0.0));
    for (var k = 0u; k < 2u; k++) {
        let v = devs[k];
        let mean = (v.x + v.y + v.z) * (1.0 / 3.0);
        out[k] = params.amount * (v + cpl * (vec3<f32>(mean) - v));
    }
    out[1] += params.amount * noise;
    return out;
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.width * params.height { return; }
    let base = idx * 3u;
    let d = vec3<f32>(density_cmy[base], density_cmy[base + 1u], density_cmy[base + 2u]);
    if params.split > 0.5 {
        let dv = grain_devs(d, params.origin_x + idx % params.width, params.origin_y + idx / params.width);
        grain_dev_fast[base] = dv[0].x;
        grain_dev_fast[base + 1u] = dv[0].y;
        grain_dev_fast[base + 2u] = dv[0].z;
        grain_dev[base] = dv[1].x;
        grain_dev[base + 1u] = dv[1].y;
        grain_dev[base + 2u] = dv[1].z;
        return;
    }
    let o = grain_density(d, params.origin_x + idx % params.width, params.origin_y + idx / params.width);
    if params.dev_only > 0.5 {
        grain_dev[base] = o.x - d.x;
        grain_dev[base + 1u] = o.y - d.y;
        grain_dev[base + 2u] = o.z - d.z;
        return;
    }
    density_cmy[base] = o.x;
    density_cmy[base + 1u] = o.y;
    density_cmy[base + 2u] = o.z;
}
