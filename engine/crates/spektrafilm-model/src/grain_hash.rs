//! Counter-based ("hash") per-pixel dye-cloud grain.
//!
//! ONE formula, mirrored by `spektrafilm-shaders/wgsl/grain_hash.wgsl`
//! (`grain_density_pixel` here == `grain_density` there). Same density maths as
//! `grain::layer_particle_model` (Poisson number of seeds, binomial developed
//! fraction, `od_particle` per developed cloud), but every pixel draws from an
//! independent stream keyed by `(seed, layer, sub-layer, global pixel)`, so
//! the result is independent of tiling/region (`origin` + local = global px)
//! and runs on the GPU. Poisson / binomial: exact inversion when the mean is
//! below 30, normal approximation above. All arithmetic is f32 and the
//! integer part is plain wrapping u32, so CPU and GPU agree to ulps.
//!
//! `amount` scales the grain AMPLITUDE: `out = d + amount * (grain - d)`
//! (amount 0 = no grain). `micro_sigma` is the log-normal sigma of a
//! per-pixel multiplicative micro-structure on that deviation (the
//! micro-structure scale, 30 nm by default, is far below a pixel, so it is
//! not blurred). The dye-cloud blur is a separate gaussian pass on the result.

use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::{from_f32, to_f64};
use rayon::prelude::*;

/// Poisson/binomial switch to the normal approximation above this mean.
pub const EXACT_MAX_MEAN: f32 = 30.0;
/// Hard cap on inversion steps (mean < 30 is exhausted well before this).
pub const MAX_INVERSION_STEPS: u32 = 120;
/// Inter-layer light scatter / DIR coupling: fraction of each layer's grain
/// deviation replaced by the mean deviation of all three layers (correlated
/// density noise shared across the dye layers).
/// Two-population emulsion (used when `n_sub_layers >= 2`): sub-layer 0 is
/// the coarse FAST crystals (few, big; developed fraction saturates quickly,
/// p_fast = 1 - (1-p)^FAST_K), sub-layer 1 the fine SLOW crystals (many,
/// small; developed fraction is whatever keeps the mean density exact).
/// `FAST_OD_SHARE` (<= 1/FAST_K) is the share of the layer's max density
/// carried by the fast population, `FAST_COUNT_FRAC` the share of crystals
/// that are fast.
pub const FAST_OD_SHARE: f32 = 0.3;
pub const FAST_K: f32 = 3.3;
pub const FAST_COUNT_FRAC: f32 = 0.002;
pub const LAYER_COUPLING: f32 = 0.45;

#[derive(Debug, Clone, Copy)]
pub struct HashGrain {
    /// Per-photo seed (low, high 32 bits).
    pub seed: u64,
    /// Region origin in the full frame, pixels.
    pub origin: [u32; 2],
    pub n_sub_layers: u32,
    /// One shared noise field for all channels (B&W).
    pub monochrome: bool,
    pub density_min: [f32; 3],
    /// Already includes `density_min` (as `apply_grain_to_density`).
    pub density_max: [f32; 3],
    /// Particles per pixel per channel, already divided by `n_sub_layers`.
    pub n_particles: [f32; 3],
    pub uniformity: [f32; 3],
    pub micro_sigma: f32,
    pub amount: f32,
}

#[inline]
pub fn pcg(x: u32) -> u32 {
    let s = x.wrapping_mul(747796405).wrapping_add(2891336453);
    let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277803737);
    (w >> 22) ^ w
}

/// Uniform in the open interval (0, 1), 24 bits.
#[inline]
pub fn unit_open(x: u32) -> f32 {
    ((x >> 8) as f32 + 0.5) * (1.0 / 16777216.0)
}

#[inline]
pub fn stream_key(seed: u64, stream: u32) -> u32 {
    let lo = seed as u32;
    let hi = (seed >> 32) as u32;
    pcg(lo ^ pcg(hi ^ 0x68e3_1da4) ^ pcg(stream.wrapping_mul(0x9e37_79b9).wrapping_add(0x7f4a_7c15)))
}

#[inline]
pub fn pixel_state(key: u32, gx: u32, gy: u32) -> u32 {
    let mut h = pcg(key ^ gx.wrapping_mul(0x9e37_79b1));
    h = pcg(h ^ gy.wrapping_mul(0x85eb_ca6b) ^ 0x27d4_eb2f);
    pcg(h.wrapping_add(key))
}

#[inline]
fn draw(st: &mut u32) -> f32 {
    *st = pcg(*st);
    unit_open(*st)
}

#[inline]
fn std_normal(st: &mut u32) -> f32 {
    let u1 = draw(st);
    let u2 = draw(st);
    (-2.0 * u1.ln()).sqrt() * (6.283_185_5 * u2).cos()
}

#[inline]
fn ln_1m(x: f32) -> f32 {
    if x < 0.01 {
        -(x + x * x * 0.5 + x * x * x * (1.0 / 3.0))
    } else {
        (1.0 - x).ln()
    }
}

pub fn poisson(lambda: f32, st: &mut u32) -> f32 {
    if lambda < EXACT_MAX_MEAN {
        let u = draw(st);
        let mut f = (-lambda).exp();
        let mut c = f;
        let mut k = 0.0f32;
        for _ in 0..MAX_INVERSION_STEPS {
            if u <= c {
                break;
            }
            k += 1.0;
            f *= lambda / k;
            c += f;
        }
        k
    } else {
        let z = std_normal(st);
        (lambda + lambda.sqrt() * z + 0.5).floor().max(0.0)
    }
}

/// `p` = success probability, `q` = 1 - p computed independently (precision
/// near both ends).
pub fn binomial(n: f32, p: f32, q: f32, st: &mut u32) -> f32 {
    if n <= 0.0 {
        return 0.0;
    }
    let (np, nq) = (n * p, n * q);
    if np.min(nq) < EXACT_MAX_MEAN {
        let flip = nq < np;
        let (pr, qr) = if flip { (q, p) } else { (p, q) };
        let u = draw(st);
        let mut f = (n * ln_1m(pr)).exp();
        let mut c = f;
        let ratio = pr / qr;
        let mut k = 0.0f32;
        for _ in 0..MAX_INVERSION_STEPS {
            if u <= c || k >= n {
                break;
            }
            f *= (n - k) / (k + 1.0) * ratio;
            k += 1.0;
            c += f;
        }
        if flip { n - k } else { k }
    } else {
        let z = std_normal(st);
        (np + (np * q).sqrt() * z + 0.5).floor().clamp(0.0, n)
    }
}

/// Grain for one pixel (CMY density in, CMY density out) at global pixel
/// `(gx, gy)`. The reference formula; the WGSL `grain_density` mirrors it.
pub fn grain_density_pixel(g: &HashGrain, d: [f32; 3], gx: u32, gy: u32) -> [f32; 3] {
    let mut out = d;
    let mut devs = [0.0f32; 3];
    for ch in 0..3usize {
        let layer = if g.monochrome { 0 } else { ch as u32 };
        let dmin = g.density_min[ch];
        let dmax = g.density_max[ch];
        let npp = g.n_particles[ch];
        let od_particle = dmax / npp;
        let d_in = d[ch] + dmin;
        let p = (d_in / dmax).clamp(1e-6, 1.0 - 1e-6);
        let q = ((dmax - d_in) / dmax).clamp(1e-6, 1.0 - 1e-6);
        let sat = 1.0 - p * g.uniformity[ch] * (1.0 - 1e-6);
        let lambda = npp / sat;
        let mut sum = 0.0f32;
        if g.n_sub_layers >= 2 {
            let npp_tot = npp * g.n_sub_layers as f32;
            let qk = q.powf(FAST_K);
            let (p_fast, q_fast) = ((1.0 - qk).clamp(1e-6, 1.0 - 1e-6), qk.clamp(1e-6, 1.0 - 1e-6));
            let w_slow = 1.0 - FAST_OD_SHARE;
            let p_slow = ((p - FAST_OD_SHARE * p_fast) / w_slow).clamp(1e-6, 1.0 - 1e-6);
            let q_slow = ((q - FAST_OD_SHARE * qk) / w_slow).clamp(1e-6, 1.0 - 1e-6);
            for sl in 0..2u32 {
                let (ps, qs, w, cf) = if sl == 0 {
                    (p_fast, q_fast, FAST_OD_SHARE, FAST_COUNT_FRAC)
                } else {
                    (p_slow, q_slow, w_slow, 1.0 - FAST_COUNT_FRAC)
                };
                let npp_s = npp_tot * cf;
                let sat_s = 1.0 - ps * g.uniformity[ch] * (1.0 - 1e-6);
                let mut st = pixel_state(stream_key(g.seed, layer + sl * 10), gx, gy);
                let seeds = poisson(npp_s / sat_s, &mut st);
                let developed = binomial(seeds, ps, qs, &mut st);
                sum += developed * (dmax * w / npp_s) * sat_s;
            }
        } else {
            for sl in 0..g.n_sub_layers {
                let mut st = pixel_state(stream_key(g.seed, layer + sl * 10), gx, gy);
                let seeds = poisson(lambda, &mut st);
                let developed = binomial(seeds, p, q, &mut st);
                sum += developed * od_particle * sat;
            }
        }
        let grain = if g.n_sub_layers >= 2 { sum } else { sum / g.n_sub_layers as f32 } - dmin;
        let mut dev = grain - d[ch];
        if g.micro_sigma > 0.0 {
            let mut st = pixel_state(stream_key(g.seed, 1000 + layer), gx, gy);
            let z = std_normal(&mut st);
            dev *= (g.micro_sigma * z - 0.5 * g.micro_sigma * g.micro_sigma).exp();
        }
        devs[ch] = dev;
    }
    let mean = (devs[0] + devs[1] + devs[2]) * (1.0 / 3.0);
    for ch in 0..3usize {
        out[ch] = d[ch] + g.amount * (devs[ch] + LAYER_COUPLING * (mean - devs[ch]));
    }
    out
}

/// CPU application on a CMY density region (no dye-cloud blur; the caller
/// runs the backend gaussian afterwards).
pub fn apply_grain_hash(density_cmy: &ImageBuf, g: &HashGrain) -> ImageBuf {
    let w = density_cmy.width as usize;
    let mut out = density_cmy.clone();
    out.par_pixels_mut().enumerate().for_each(|(i, px)| {
        let gx = g.origin[0].wrapping_add((i % w) as u32);
        let gy = g.origin[1].wrapping_add((i / w) as u32);
        let d = [to_f64(px[0]) as f32, to_f64(px[1]) as f32, to_f64(px[2]) as f32];
        let o = grain_density_pixel(g, d, gx, gy);
        for c in 0..3 {
            px[c] = from_f32(o[c]);
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Literal transcription of `grain_hash.wgsl` (uniform struct, flat pixel
    /// index, `floor(x + 0.5)`, vec4 lanes), the way the GPU evaluates it.
    mod wgsl_mirror {
        pub struct Params {
            pub width: u32,
            pub n_sub_layers: u32,
            pub monochrome: u32,
            pub seed_lo: u32,
            pub seed_hi: u32,
            pub origin_x: u32,
            pub origin_y: u32,
            pub density_min: [f32; 4],
            pub density_max: [f32; 4],
            pub n_particles: [f32; 4],
            pub uniformity: [f32; 4],
            pub micro_sigma: f32,
            pub amount: f32,
        }
        fn pcg(x: u32) -> u32 {
            let s = x.wrapping_mul(747796405u32).wrapping_add(2891336453u32);
            let w = ((s >> ((s >> 28u32) + 4u32)) ^ s).wrapping_mul(277803737u32);
            (w >> 22u32) ^ w
        }
        fn unit_open(x: u32) -> f32 {
            ((x >> 8u32) as f32 + 0.5) * (1.0 / 16777216.0)
        }
        fn stream_key(p: &Params, stream: u32) -> u32 {
            pcg(p.seed_lo ^ pcg(p.seed_hi ^ 0x68e31da4u32) ^ pcg(stream.wrapping_mul(0x9e3779b9u32).wrapping_add(0x7f4a7c15u32)))
        }
        fn pixel_state(key: u32, gx: u32, gy: u32) -> u32 {
            let mut h = pcg(key ^ gx.wrapping_mul(0x9e3779b1u32));
            h = pcg(h ^ gy.wrapping_mul(0x85ebca6bu32) ^ 0x27d4eb2fu32);
            pcg(h.wrapping_add(key))
        }
        fn draw(st: &mut u32) -> f32 {
            *st = pcg(*st);
            unit_open(*st)
        }
        fn std_normal(st: &mut u32) -> f32 {
            let u1 = draw(st);
            let u2 = draw(st);
            (-2.0 * u1.ln()).sqrt() * (6.2831855f32 * u2).cos()
        }
        fn ln_1m(x: f32) -> f32 {
            if x < 0.01 {
                return -(x + x * x * 0.5 + x * x * x * (1.0 / 3.0));
            }
            (1.0 - x).ln()
        }
        fn poisson(lambda: f32, st: &mut u32) -> f32 {
            if lambda < 30.0 {
                let u = draw(st);
                let mut f = (-lambda).exp();
                let mut c = f;
                let mut k = 0.0f32;
                let mut i = 0u32;
                while i < 120 {
                    if u <= c {
                        break;
                    }
                    k += 1.0;
                    f *= lambda / k;
                    c += f;
                    i += 1;
                }
                return k;
            }
            let z = std_normal(st);
            ((lambda + lambda.sqrt() * z + 0.5).floor()).max(0.0)
        }
        fn binomial(n: f32, p: f32, q: f32, st: &mut u32) -> f32 {
            if n <= 0.0 {
                return 0.0;
            }
            let np = n * p;
            let nq = n * q;
            if np.min(nq) < 30.0 {
                let flip = nq < np;
                let (mut pr, mut qr) = (p, q);
                if flip {
                    pr = q;
                    qr = p;
                }
                let u = draw(st);
                let mut f = (n * ln_1m(pr)).exp();
                let mut c = f;
                let ratio = pr / qr;
                let mut k = 0.0f32;
                let mut i = 0u32;
                while i < 120 {
                    if u <= c || k >= n {
                        break;
                    }
                    f *= (n - k) / (k + 1.0) * ratio;
                    k += 1.0;
                    c += f;
                    i += 1;
                }
                return if flip { n - k } else { k };
            }
            let z = std_normal(st);
            ((np + (np * q).sqrt() * z + 0.5).floor()).clamp(0.0, n)
        }
        fn od_s(dmax: f32, w: f32, npp_s: f32) -> f32 {
            dmax * w / npp_s
        }
        fn grain_density(p: &Params, d: [f32; 3], gx: u32, gy: u32) -> [f32; 3] {
            let mut out = d;
            let mut devs = [0.0f32; 3];
            for ch in 0..3usize {
                let layer = if p.monochrome != 0 { 0 } else { ch as u32 };
                let dmin = p.density_min[ch];
                let dmax = p.density_max[ch];
                let npp = p.n_particles[ch];
                let od = dmax / npp;
                let d_in = d[ch] + dmin;
                let pp = (d_in / dmax).clamp(1e-6, 1.0 - 1e-6);
                let q = ((dmax - d_in) / dmax).clamp(1e-6, 1.0 - 1e-6);
                let sat = 1.0 - pp * p.uniformity[ch] * (1.0 - 1e-6);
                let lambda = npp / sat;
                let mut sum = 0.0f32;
                if p.n_sub_layers >= 2 {
                    let npp_tot = npp * p.n_sub_layers as f32;
                    let qk = q.powf(super::FAST_K);
                    let (p_fast, q_fast) = ((1.0 - qk).clamp(1e-6, 1.0 - 1e-6), qk.clamp(1e-6, 1.0 - 1e-6));
                    let w_slow = 1.0 - super::FAST_OD_SHARE;
                    let p_slow = ((pp - super::FAST_OD_SHARE * p_fast) / w_slow).clamp(1e-6, 1.0 - 1e-6);
                    let q_slow = ((q - super::FAST_OD_SHARE * qk) / w_slow).clamp(1e-6, 1.0 - 1e-6);
                    for sl in 0..2u32 {
                        let (ps, qs, w, cf) = if sl == 0 {
                            (p_fast, q_fast, super::FAST_OD_SHARE, super::FAST_COUNT_FRAC)
                        } else {
                            (p_slow, q_slow, w_slow, 1.0 - super::FAST_COUNT_FRAC)
                        };
                        let npp_s = npp_tot * cf;
                        let sat_s = 1.0 - ps * p.uniformity[ch] * (1.0 - 1e-6);
                        let mut st = pixel_state(stream_key(p, layer + sl * 10), gx, gy);
                        let seeds = poisson(npp_s / sat_s, &mut st);
                        let developed = binomial(seeds, ps, qs, &mut st);
                        sum += developed * (od_s(dmax, w, npp_s)) * sat_s;
                    }
                } else {
                    for sl in 0..p.n_sub_layers {
                        let mut st = pixel_state(stream_key(p, layer + sl * 10), gx, gy);
                        let seeds = poisson(lambda, &mut st);
                        let dev = binomial(seeds, pp, q, &mut st);
                        sum += dev * od * sat;
                    }
                    sum /= p.n_sub_layers as f32;
                }
                let grain = sum - dmin;
                let mut dev = grain - d[ch];
                if p.micro_sigma > 0.0 {
                    let mut st = pixel_state(stream_key(p, 1000 + layer), gx, gy);
                    let z = std_normal(&mut st);
                    dev *= (p.micro_sigma * z - 0.5 * p.micro_sigma * p.micro_sigma).exp();
                }
                devs[ch] = dev;
            }
            let mean = (devs[0] + devs[1] + devs[2]) * (1.0 / 3.0);
            for ch in 0..3usize {
                out[ch] = d[ch] + p.amount * (devs[ch] + super::LAYER_COUPLING * (mean - devs[ch]));
            }
            out
        }
        /// `main()` for one invocation.
        pub fn main(p: &Params, idx: u32, d: [f32; 3]) -> [f32; 3] {
            grain_density(p, d, p.origin_x + idx % p.width, p.origin_y + idx / p.width)
        }
    }

    fn lcg(s: &mut u64) -> f32 {
        *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*s >> 40) as f32) / 16777216.0
    }

    fn setup(npp: f32, n_sub: u32) -> HashGrain {
        HashGrain {
            seed: 0xdead_beef_1234_5678,
            origin: [0, 0],
            n_sub_layers: n_sub,
            monochrome: false,
            density_min: [0.03; 3],
            density_max: [2.9, 3.1, 3.3],
            n_particles: [npp, npp * 1.1, npp * 0.6],
            uniformity: [0.97, 0.99, 0.97],
            micro_sigma: 0.2,
            amount: 1.0,
        }
    }

    #[test]
    fn wgsl_mirror_matches_reference() {
        let mut s = 7u64;
        let mut max_err = 0.0f32;
        // npp covers the exact-inversion (small), mixed and normal regimes.
        for &(npp, n_sub) in &[(3.0f32, 1u32), (20.0, 2), (300.0, 1), (1200.0, 3)] {
            let g = setup(npp, n_sub);
            let w = 97u32;
            let prm = wgsl_mirror::Params {
                width: w,
                n_sub_layers: n_sub,
                monochrome: 0,
                seed_lo: g.seed as u32,
                seed_hi: (g.seed >> 32) as u32,
                origin_x: 1234,
                origin_y: 77,
                density_min: [0.03, 0.03, 0.03, 0.0],
                density_max: [2.9, 3.1, 3.3, 0.0],
                n_particles: [npp, npp * 1.1, npp * 0.6, 0.0],
                uniformity: [0.97, 0.99, 0.97, 0.0],
                micro_sigma: 0.2,
                amount: 1.0,
            };
            let mut gg = g;
            gg.origin = [1234, 77];
            for idx in 0..4000u32 {
                let d = [lcg(&mut s) * 2.8, lcg(&mut s) * 3.0, lcg(&mut s) * 3.2];
                let a = grain_density_pixel(&gg, d, 1234 + idx % w, 77 + idx / w);
                let b = wgsl_mirror::main(&prm, idx, d);
                for c in 0..3 {
                    max_err = max_err.max((a[c] - b[c]).abs());
                }
            }
        }
        assert!(max_err < 1e-6, "mirror vs reference max err {max_err}");
    }

    #[test]
    fn wgsl_source_carries_the_same_constants() {
        let src = include_str!("../../spektrafilm-shaders/wgsl/grain_hash.wgsl");
        for k in [
            "747796405u", "2891336453u", "277803737u", "0x68e31da4u", "0x9e3779b9u", "0x7f4a7c15u",
            "0x9e3779b1u", "0x85ebca6bu", "0x27d4eb2fu", "6.2831855", "EXACT_MAX_MEAN: f32 = 30.0",
            "MAX_STEPS: u32 = 120u", "LAYER_COUPLING: f32 = 0.45", "FAST_OD_SHARE: f32 = 0.3", "FAST_K: f32 = 3.3", "FAST_COUNT_FRAC: f32 = 0.002", "1000u + layer", "layer + sl * 10u",
        ] {
            assert!(src.contains(k), "WGSL missing {k}");
        }
    }

    #[test]
    fn grain_statistics_are_sane() {
        // Mean of grainy density ~ clean density; std ~ per the Poisson-binomial model.
        let g = setup(400.0, 1);
        let d = [1.0f32, 1.2, 1.4];
        let (mut m, mut v) = ([0.0f64; 3], [0.0f64; 3]);
        let n = 20000u32;
        for i in 0..n {
            let o = grain_density_pixel(&g, d, i, 3);
            for c in 0..3 {
                m[c] += o[c] as f64;
                v[c] += (o[c] as f64).powi(2);
            }
        }
        for c in 0..3 {
            let mean = m[c] / n as f64;
            let sd = (v[c] / n as f64 - mean * mean).sqrt();
            assert!((mean - d[c] as f64).abs() < 0.02, "mean {mean} vs {}", d[c]);
            assert!(sd > 0.005 && sd < 0.3, "sd {sd}");
        }
    }

    #[test]
    fn same_film_position_is_identical_across_regions() {
        let full_w = 64u32;
        let full_h = 48u32;
        let mut s = 3u64;
        let mut img = ImageBuf::new(full_w, full_h);
        for v in img.data.iter_mut() {
            *v = from_f32(lcg(&mut s) * 2.5);
        }
        let g = setup(150.0, 2);
        let whole = apply_grain_hash(&img, &g);
        // crop a region at (21, 9) of size 30x25 and grain it with its origin.
        let (x0, y0, cw, ch) = (21u32, 9u32, 30u32, 25u32);
        let mut crop = ImageBuf::new(cw, ch);
        for y in 0..ch {
            for x in 0..cw {
                crop.set(x, y, img.get(x0 + x, y0 + y));
            }
        }
        let mut gc = g;
        gc.origin = [x0, y0];
        let tile = apply_grain_hash(&crop, &gc);
        for y in 0..ch {
            for x in 0..cw {
                let a = whole.get(x0 + x, y0 + y);
                let b = tile.get(x, y);
                for c in 0..3 {
                    assert_eq!(a[c].to_bits(), b[c].to_bits());
                }
            }
        }
    }

    #[test]
    fn amount_zero_is_bit_identical() {
        let mut s = 5u64;
        let mut img = ImageBuf::new(16, 16);
        for v in img.data.iter_mut() {
            *v = from_f32(lcg(&mut s) * 2.5);
        }
        let mut g = setup(100.0, 1);
        g.amount = 0.0;
        let out = apply_grain_hash(&img, &g);
        for (a, b) in img.data.iter().zip(out.data.iter()) {
            assert_eq!(a.to_bits(), b.to_bits());
        }
        // and different seeds / amount 1 do change it
        g.amount = 1.0;
        assert_ne!(apply_grain_hash(&img, &g).data, img.data);
    }
}
