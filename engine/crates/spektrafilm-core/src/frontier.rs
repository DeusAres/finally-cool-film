//! Frontier SP-3000 scanner model: developed negative -> positive.
//!
//! Inferred model, see `eval/FRONTIER.md` / `eval/frontier_model.json`; every
//! constant is a named field of [`FrontierModelParams`] (calibration targets).
//!
//! Per pixel, from the film dye densities `cmy` (relative to the unexposed film):
//!
//! 1. **Sensor RGB.** `T(l) = 10^-(cmy . channel_density(l) + base_density(l))`,
//!    `T_c = sum_l T(l) w_c(l)` with `w_c` the normalised Gaussian sensitivity of
//!    channel c (peak/FWHM params; LED light x CCD response are folded into it, so
//!    the scanner light is flat). `D_c = -log10(max(T_c, tmin_floor))`.
//! 2. **D-min.** `Dn_c = D_c - Dmin_c`, `Dmin_c` = the reading at `cmy = 0`
//!    (film base; the stock's fog is already the zero of `cmy`, see
//!    `normalize_density_curves`).
//! 3. **Film-type setup.** `D'_c = slope_c Dn_c + offset_c`, fitted once on the
//!    stock's grey ramp (18 % grey at -fit..+fit EV): channel G is the reference
//!    (identity), R and B get the least-squares slope against G through the
//!    mid-grey point, so grey is neutral at mid-scale and in slope; the curvature
//!    left over along the scale is the film's.
//! 4. **Keys.** `D'_c += (density + auto.d) * d_per_ev - (cmy_c + auto.c_c)`.
//!    `d_per_ev` is the grey-ramp G density change per EV at mid-scale, so the
//!    density key is an exposure compensation. A positive C/M/Y key adds that
//!    colour, i.e. lowers the density of its complementary channel (R/G/B).
//! 5. **Gradation.** `x = 0.5 + (D'_c - d_ref) / range_density`, clamped to
//!    0..1, then a sigmoid `1/(1+exp(-a (x-m)))` rescaled to 0..1 (`a` scaled by
//!    `1 + contrast`, `m` solved so x = 0.5 gives `mid_grey_out`), a C1 soft
//!    shoulder above `shoulder_start` (strength scaled by `1 + highlight`),
//!    black/white points, and `black_lift` (same for R, G, B). The output is
//!    sRGB-encoded.
//! 6. **Colour.** Saturation about Rec.709 luma in encoded RGB.
//!
//! The result is baked per pixel into a 17^3 (`settings.lut_resolution`) PCHIP
//! LUT over the film density, like the legacy scanner LUT.

use rayon::prelude::*;
use spektrafilm_math::pchip3d::{PreparedPchip3d, pchip_interp, prepare_pchip_3d};
use spektrafilm_math::spectral::N_WAVELENGTHS;

use crate::params::{FrontierAutoParams, FrontierModelParams, FrontierParams};
use crate::profile::Profile;

const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];
const FIRST_WL_NM: f64 = 380.0;
const STEP_WL_NM: f64 = 5.0;

/// Grey-ramp exposures of the film-type fit: (ev, scene grey) pairs, the middle
/// one is 18 % grey at ev 0.
pub fn ramp_evs(m: &FrontierModelParams) -> Vec<f64> {
    let n = (m.setup_fit_steps.max(3) | 1) as usize;
    (0..n)
        .map(|i| -m.setup_fit_ev + 2.0 * m.setup_fit_ev * i as f64 / (n - 1) as f64)
        .collect()
}

/// Everything that depends on the film and the model constants but not on the
/// operator keys: sensor, D-min, film-type setup.
#[derive(Clone, Debug)]
pub struct FrontierBase {
    cd: Vec<[f64; 3]>,
    base: Vec<f64>,
    weights: Vec<[f64; 3]>,
    pub model: FrontierModelParams,
    pub dmin: [f64; 3],
    pub slope: [f64; 3],
    pub offset: [f64; 3],
    /// Mid-grey density (setup space), the gradation's mid-scale anchor.
    pub d_ref: f64,
    /// Setup-space density change per EV at mid-scale (>0).
    pub d_per_ev: f64,
}

impl FrontierBase {
    /// `ramp_cmy[i]` is the developed film density of the grey ramp at
    /// `ramp_evs(model)[i]`.
    pub fn new(film: &Profile, model: &FrontierModelParams, ramp_cmy: &[[f64; 3]]) -> Self {
        let cd: Vec<[f64; 3]> = film
            .data
            .channel_density
            .iter()
            .take(N_WAVELENGTHS)
            .map(|r| {
                [
                    r.first().copied().unwrap_or(0.0),
                    r.get(1).copied().unwrap_or(0.0),
                    r.get(2).copied().unwrap_or(0.0),
                ]
            })
            .collect();
        let n = cd.len();
        let base: Vec<f64> = (0..n)
            .map(|i| film.data.base_density.get(i).copied().unwrap_or(0.0))
            .collect();
        // Profile data is NaN where the dye data does not reach (UV/NIR edges):
        // those wavelengths carry no sensor weight (the sensors are narrow).
        let valid: Vec<bool> = (0..n)
            .map(|i| base[i].is_finite() && cd[i].iter().all(|v| v.is_finite()))
            .collect();
        let mut weights = vec![[0.0f64; 3]; n];
        for c in 0..3 {
            let sigma = |fwhm: f64| fwhm / (2.0 * (2.0 * std::f64::consts::LN_2).sqrt());
            let s = sigma(model.sensor_fwhm_nm[c]).max(1e-6);
            let mut sum = 0.0;
            for (i, w) in weights.iter_mut().enumerate() {
                let wl = FIRST_WL_NM + STEP_WL_NM * i as f64;
                let z = (wl - model.sensor_peak_nm[c]) / s;
                w[c] = if valid[i] { (-0.5 * z * z).exp() } else { 0.0 };
                sum += w[c];
            }
            for w in weights.iter_mut() {
                w[c] /= sum;
            }
        }
        let mut b = Self {
            cd,
            base,
            weights,
            model: model.clone(),
            dmin: [0.0; 3],
            slope: [1.0; 3],
            offset: [0.0; 3],
            d_ref: 0.0,
            d_per_ev: 1.0,
        };
        b.dmin = b.raw_density([0.0; 3]);
        b.fit_setup(ramp_cmy);
        b
    }

    /// Sensor densities `D_c` (before D-min removal).
    pub fn raw_density(&self, cmy: [f64; 3]) -> [f64; 3] {
        let mut t = [0.0f64; 3];
        for i in 0..self.cd.len() {
            let c = &self.cd[i];
            let d = cmy[0] * c[0] + cmy[1] * c[1] + cmy[2] * c[2] + self.base[i];
            let w = &self.weights[i];
            if w[0] + w[1] + w[2] == 0.0 {
                continue; // no data at this wavelength
            }
            let tr = 10f64.powf(-d);
            t[0] += tr * w[0];
            t[1] += tr * w[1];
            t[2] += tr * w[2];
        }
        [
            -t[0].max(self.model.tmin_floor).log10(),
            -t[1].max(self.model.tmin_floor).log10(),
            -t[2].max(self.model.tmin_floor).log10(),
        ]
    }

    /// `Dn_c = D_c - Dmin_c`.
    pub fn normalised_density(&self, cmy: [f64; 3]) -> [f64; 3] {
        let d = self.raw_density(cmy);
        [d[0] - self.dmin[0], d[1] - self.dmin[1], d[2] - self.dmin[2]]
    }

    /// Film-type-setup density `D'_c`, before the keys.
    pub fn setup_density(&self, cmy: [f64; 3]) -> [f64; 3] {
        let dn = self.normalised_density(cmy);
        [
            self.slope[0] * dn[0] + self.offset[0],
            self.slope[1] * dn[1] + self.offset[1],
            self.slope[2] * dn[2] + self.offset[2],
        ]
    }

    fn fit_setup(&mut self, ramp_cmy: &[[f64; 3]]) {
        let evs = ramp_evs(&self.model);
        if ramp_cmy.len() != evs.len() {
            return; // identity setup
        }
        let dn: Vec<[f64; 3]> = ramp_cmy.iter().map(|&c| self.normalised_density(c)).collect();
        let mid = dn.len() / 2;
        let m = dn[mid];
        let (mut sgg, mut sge) = (0.0, 0.0);
        let mut sxx = [0.0f64; 3];
        let mut sxg = [0.0f64; 3];
        for (d, ev) in dn.iter().zip(&evs) {
            let dg = d[1] - m[1];
            sgg += dg * dg;
            sge += dg * ev;
            for c in 0..3 {
                let dx = d[c] - m[c];
                sxx[c] += dx * dx;
                sxg[c] += dx * dg;
            }
        }
        self.d_ref = m[1];
        self.d_per_ev = if sge.abs() > 1e-12 && sgg > 0.0 {
            // regression of G density on EV through the mid point
            let see: f64 = evs.iter().map(|e| e * e).sum();
            (sge / see).abs().max(1e-3)
        } else {
            1.0
        };
        for c in 0..3 {
            self.slope[c] = if c == 1 || sxx[c] < 1e-12 { 1.0 } else { sxg[c] / sxx[c] };
            self.offset[c] = self.d_ref - self.slope[c] * m[c];
        }
    }

    /// Encoded positive at the `steps^3` nodes of the density box (r-major,
    /// 3 per node). Same maths as `encode`, with the spectral sum factored per
    /// axis (`10^-(r a + g b + c d) = 10^-r a * 10^-g b * 10^-c d`), so a
    /// node costs a few multiply-adds instead of 80 `powf`.
    pub fn node_table(&self, stage: &Stage, data_min: [f64; 3], data_max: [f64; 3], steps: usize) -> Vec<f64> {
        let lam: Vec<usize> = (0..self.cd.len())
            .filter(|&i| self.weights[i].iter().sum::<f64>() > 0.0)
            .collect();
        let nl = lam.len();
        let mut axis = vec![vec![0.0f64; steps * nl]; 3];
        for a in 0..3 {
            for n in 0..steps {
                let v = data_min[a] + (data_max[a] - data_min[a]) * n as f64 / (steps - 1) as f64;
                for (l, &i) in lam.iter().enumerate() {
                    let base = if a == 0 { 10f64.powf(-self.base[i]) } else { 1.0 };
                    axis[a][n * nl + l] = 10f64.powf(-v * self.cd[i][a]) * base;
                }
            }
        }
        let mut out = vec![0.0f64; steps * steps * steps * 3];
        out.par_chunks_exact_mut(3).enumerate().for_each(|(idx, dst)| {
            let (i, j, k) = (idx / (steps * steps), (idx / steps) % steps, idx % steps);
            let (e0, e1, e2) = (&axis[0][i * nl..], &axis[1][j * nl..], &axis[2][k * nl..]);
            let mut t = [0.0f64; 3];
            for (l, &wl) in lam.iter().enumerate() {
                let tr = e0[l] * e1[l] * e2[l];
                let w = &self.weights[wl];
                t[0] += tr * w[0];
                t[1] += tr * w[1];
                t[2] += tr * w[2];
            }
            let mut d = [0.0f64; 3];
            for c in 0..3 {
                let raw = -t[c].max(self.model.tmin_floor).log10();
                d[c] = self.slope[c] * (raw - self.dmin[c]) + self.offset[c];
            }
            dst.copy_from_slice(&stage.encode(d));
        });
        out
    }

    /// Operator keys resolved to a per-pixel stage.
    pub fn stage(&self, keys: &FrontierParams) -> Stage {
        let m = &self.model;
        let mut shift = [0.0f64; 3];
        let dens_ev = keys.density as f64 + keys.auto[0] as f64;
        for c in 0..3 {
            shift[c] = dens_ev * self.d_per_ev - (keys.cmy[c] as f64 + keys.auto[1 + c] as f64);
        }
        let a = (m.gradation_a * (1.0 + keys.contrast as f64)).max(0.05);
        let sh = (m.shoulder_sharpness * (1.0 + keys.highlight as f64)).max(0.0);
        Stage {
            d_ref: self.d_ref,
            range: m.range_density.max(1e-6),
            shift,
            curve: Gradation::solve(a, sh, m),
            lift: keys.black_lift.clamp(0.0, 1.0) as f64 * m.black_lift_max,
            sat: (m.saturation * keys.saturation as f64).max(0.0),
        }
    }

    /// sRGB-encoded positive for a film density.
    pub fn encode(&self, cmy: [f64; 3], stage: &Stage) -> [f64; 3] {
        stage.encode(self.setup_density(cmy))
    }
}

/// Gradation curve: x in 0..1 -> encoded 0..1.
#[derive(Clone, Copy, Debug)]
pub struct Gradation {
    a: f64,
    m: f64,
    ys: f64,
    sh: f64,
    bp: f64,
    wp: f64,
    shoulder_one: f64,
    /// sigmoid at x = 0 and x = 1 (rescale to 0..1)
    s0: f64,
    s1: f64,
}

impl Gradation {
    fn new(a: f64, m_mid: f64, sh: f64, p: &FrontierModelParams) -> Self {
        let mut g = Self {
            a,
            m: m_mid,
            ys: p.shoulder_start.clamp(0.0, 0.999),
            sh,
            bp: p.black_point,
            wp: p.white_point,
            shoulder_one: 1.0,
            s0: 1.0 / (1.0 + (a * m_mid).exp()),
            s1: 1.0 / (1.0 + (-a * (1.0 - m_mid)).exp()),
        };
        g.shoulder_one = g.shoulder(1.0);
        g
    }

    /// Midpoint solved so that `curve(0.5) == mid_grey_out`.
    fn solve(a: f64, sh: f64, p: &FrontierModelParams) -> Self {
        let (mut lo, mut hi) = (-2.0f64, 3.0f64);
        for _ in 0..60 {
            let mid = 0.5 * (lo + hi);
            // curve(0.5) decreases as the midpoint grows
            if Self::new(a, mid, sh, p).curve(0.5) > p.mid_grey_out {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Self::new(a, 0.5 * (lo + hi), sh, p)
    }

    fn shoulder(&self, y: f64) -> f64 {
        if y <= self.ys {
            return y;
        }
        let t = (y - self.ys) / (1.0 - self.ys);
        // C1 at the knee: slope 1, then compressing; sh -> 0 is the identity.
        let f = if self.sh < 1e-6 { t } else { (1.0 - (-self.sh * t).exp()) / self.sh };
        self.ys + (1.0 - self.ys) * f
    }

    pub fn curve(&self, x: f64) -> f64 {
        let x = x.clamp(0.0, 1.0);
        let s = |x: f64| 1.0 / (1.0 + (-self.a * (x - self.m)).exp());
        let y = (s(x) - self.s0) / (self.s1 - self.s0);
        let y = self.shoulder(y) / self.shoulder_one;
        self.bp + (self.wp - self.bp) * y
    }
}

/// Operator keys + model, resolved for the per-pixel encode.
#[derive(Clone, Copy, Debug)]
pub struct Stage {
    d_ref: f64,
    range: f64,
    shift: [f64; 3],
    curve: Gradation,
    lift: f64,
    sat: f64,
}

impl Stage {
    /// Setup densities `D'` -> encoded positive RGB (0..1).
    pub fn encode(&self, d: [f64; 3]) -> [f64; 3] {
        let mut y = [0.0f64; 3];
        for c in 0..3 {
            let x = 0.5 + (d[c] + self.shift[c] - self.d_ref) / self.range;
            y[c] = self.lift + (1.0 - self.lift) * self.curve.curve(x);
        }
        let l = LUMA[0] * y[0] + LUMA[1] * y[1] + LUMA[2] * y[2];
        for v in y.iter_mut() {
            *v = (l + self.sat * (*v - l)).clamp(0.0, 1.0);
        }
        y
    }
}

/// The baked scanner LUT: film density (cmy) -> sRGB-encoded positive.
#[derive(Clone, Debug)]
pub struct FrontierLut {
    prepared: PreparedPchip3d,
    /// The same nodes as f32 (r-major, 3 per node): what the GPU samples.
    table: Vec<f32>,
    steps: usize,
    data_min: [f64; 3],
    inv: [f64; 3],
    max_coord: f64,
}

impl FrontierLut {
    pub fn build(
        base: &FrontierBase,
        keys: &FrontierParams,
        data_min: [f64; 3],
        data_max: [f64; 3],
        steps: usize,
    ) -> Self {
        let stage = base.stage(keys);
        let step_inv = (steps - 1) as f64;
        let lut = base.node_table(&stage, data_min, data_max, steps);
        let scale = step_inv;
        let prepared = prepare_pchip_3d(lut, steps);
        // GPU table: built directly at three times the cell density (the 17-node
        // surface itself is ~1.5/255 off the direct evaluation in the toe).
        let gs = 3 * (steps - 1) + 1;
        let table: Vec<f32> = base
            .node_table(&stage, data_min, data_max, gs)
            .iter()
            .map(|&v| v as f32)
            .collect();
        Self {
            prepared,
            table,
            steps: gs,
            data_min,
            inv: [
                scale / (data_max[0] - data_min[0]),
                scale / (data_max[1] - data_min[1]),
                scale / (data_max[2] - data_min[2]),
            ],
            max_coord: step_inv,
        }
    }

    /// Node table, `steps` and domain for the GPU's trilinear scan pass
    /// (`scan_lut.wgsl`, mirrored by [`trilinear_reference`]).
    pub fn gpu_table(&self) -> (&[f32], u32, [f32; 3], [f32; 3]) {
        let f = |a: [f64; 3]| [a[0] as f32, a[1] as f32, a[2] as f32];
        let k = (self.steps - 1) as f64 / self.max_coord;
        (&self.table, self.steps as u32, f(self.data_min), f([self.inv[0] * k, self.inv[1] * k, self.inv[2] * k]))
    }

    /// Encoded positive for a film density.
    #[inline]
    pub fn apply(&self, cmy: [f64; 3]) -> [f64; 3] {
        // TMPDBG
        if std::env::var("SF_DBG").is_ok() { static L: std::sync::Mutex<[f64;3]> = std::sync::Mutex::new([9.0;3]); let mut l = L.lock().unwrap(); if (l[0]-cmy[0]).abs()>1e-9 || (l[1]-cmy[1]).abs()>1e-9 { *l = cmy; eprintln!("DBG {:.4} {:.4} {:.4}", cmy[0], cmy[1], cmy[2]); } }
        let q = |c: usize| ((cmy[c] - self.data_min[c]) * self.inv[c]).clamp(0.0, self.max_coord);
        pchip_interp(&self.prepared, q(0), q(1), q(2))
    }
}

/// The GPU scan pass in Rust: `scan_lut.wgsl` line for line (f32 trilinear in
/// the node table, encoded output). Reference for the parity test.
pub fn trilinear_reference(
    table: &[f32],
    steps: u32,
    data_min: [f32; 3],
    inv: [f32; 3],
    cmy: [f32; 3],
) -> [f32; 3] {
    let top = (steps - 1) as f32;
    let mut i0 = [0usize; 3];
    let mut t = [0f32; 3];
    for c in 0..3 {
        let p = ((cmy[c] - data_min[c]) * inv[c]).clamp(0.0, top);
        i0[c] = (p.floor() as usize).min(steps as usize - 2);
        t[c] = p - i0[c] as f32;
    }
    let node = |i: usize, j: usize, k: usize| {
        let b = ((i * steps as usize + j) * steps as usize + k) * 3;
        [table[b], table[b + 1], table[b + 2]]
    };
    let mix = |a: [f32; 3], b: [f32; 3], t: f32| [0, 1, 2].map(|c| a[c] * (1.0 - t) + b[c] * t);
    let (i, j, k) = (i0[0], i0[1], i0[2]);
    let c00 = mix(node(i, j, k), node(i, j, k + 1), t[2]);
    let c01 = mix(node(i, j + 1, k), node(i, j + 1, k + 1), t[2]);
    let c10 = mix(node(i + 1, j, k), node(i + 1, j, k + 1), t[2]);
    let c11 = mix(node(i + 1, j + 1, k), node(i + 1, j + 1, k + 1), t[2]);
    mix(mix(c00, c01, t[1]), mix(c10, c11, t[1]), t[0])
}

/// AutoSetup (guessed LATD-style structure, see `eval/FRONTIER.md`).
///
/// `cmy` is the developed film density of a thumbnail (`width * height * 3`).
/// Returns `[density_ev, c, m, y]` in the units of `scanner.frontier.auto`: the
/// keys that bring the frame to the mid-scale density (G) and neutral mean
/// colour (grey world relative to G), softened by `k_den`, `k_col`, `strength`
/// and the clamps.
pub fn auto_setup(base: &FrontierBase, cmy: &[f32], width: usize, height: usize) -> [f32; 4] {
    let p: &FrontierAutoParams = &base.model.auto;
    if width == 0 || height == 0 || cmy.len() < width * height * 3 {
        return [0.0; 4];
    }
    // Box downsample to <= thumb_size.
    let ts = p.thumb_size.max(1) as usize;
    let max_dim = width.max(height);
    let (sw, sh) = if max_dim > ts {
        let s = ts as f64 / max_dim as f64;
        (
            ((width as f64 * s).round() as usize).max(1),
            ((height as f64 * s).round() as usize).max(1),
        )
    } else {
        (width, height)
    };
    let bx = ((sw as f64 * p.border_mask_frac).round() as usize).min(sw.saturating_sub(1) / 2);
    let by = ((sh as f64 * p.border_mask_frac).round() as usize).min(sh.saturating_sub(1) / 2);
    let mut px: Vec<[f64; 3]> = Vec::with_capacity(sw * sh);
    for oy in by..sh - by {
        let y0 = oy * height / sh;
        let y1 = ((oy + 1) * height / sh).max(y0 + 1);
        for ox in bx..sw - bx {
            let x0 = ox * width / sw;
            let x1 = ((ox + 1) * width / sw).max(x0 + 1);
            let mut acc = [0.0f64; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * width + x) * 3;
                    acc[0] += cmy[i] as f64;
                    acc[1] += cmy[i + 1] as f64;
                    acc[2] += cmy[i + 2] as f64;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            px.push(base.setup_density([acc[0] / n, acc[1] / n, acc[2] / n]));
        }
    }
    if px.is_empty() {
        return [0.0; 4];
    }
    // Exclude G-density outliers (both tails).
    let mut g: Vec<f64> = px.iter().map(|d| d[1]).collect();
    g.sort_by(|a, b| a.total_cmp(b));
    let lo = percentile(&g, p.exclude_pct);
    let hi = percentile(&g, 100.0 - p.exclude_pct);
    let kept: Vec<&[f64; 3]> = px.iter().filter(|d| d[1] >= lo && d[1] <= hi).collect();
    let mut mean = [0.0f64; 3];
    for c in 0..3 {
        let mut v: Vec<f64> = kept.iter().map(|d| d[c]).collect();
        v.sort_by(|a, b| a.total_cmp(b));
        let n = v.len();
        let i0 = (p.trim_lo_pct / 100.0 * (n - 1) as f64).floor() as usize;
        let i1 = ((p.trim_hi_pct / 100.0 * (n - 1) as f64).ceil() as usize).min(n - 1);
        let s = &v[i0.min(i1)..=i1];
        mean[c] = s.iter().sum::<f64>() / s.len() as f64;
    }
    let target = base.d_ref + p.target_offset;
    let k_den = p.k_den * p.strength;
    let k_col = p.k_col * p.strength;
    let d_den = (k_den * (target - mean[1])).clamp(-p.clamp_density, p.clamp_density);
    let mut out = [(d_den / base.d_per_ev) as f32, 0.0, 0.0, 0.0];
    for c in 0..3 {
        let dd = (k_col * (mean[1] - mean[c])).clamp(-p.clamp_colour, p.clamp_colour);
        out[1 + c] = (-dd) as f32; // a density gain is the opposite colour key
    }
    out
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    let i = (pct / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[i.min(sorted.len() - 1)]
}

#[cfg(test)]
mod tests {
    use crate::params::RuntimeParams;
    use crate::pipeline::Pipeline;
    use spektrafilm_gpu::cpu_backend::CpuBackend;
    use spektrafilm_math::image::ImageBuf;
    use spektrafilm_math::precision::from_f64;

    /// Gold 200, frontier scan of the negative; `None` if the web data is absent.
    fn pipeline() -> Option<Pipeline> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/data");
        let film = crate::profile::load_profile_by_name(&dir, "kodak_gold_200").ok()?;
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").ok()?;
        let mut p = RuntimeParams::default();
        p.io.scan_film = true;
        p.io.input_color_space = "sRGB".into();
        p.io.input_cctf_decoding = false;
        p.scanner.model = Some("frontier".into());
        p.scanner.unsharp_mask = [0.0, 0.0];
        p.camera.auto_exposure = false;
        p.film_render.grain.active = false;
        p.film_render.halation.active = false;
        Pipeline::new_with_spectral(film, print, p, &dir).ok()
    }

    fn grey_row(evs: &[f64]) -> ImageBuf {
        let data = evs
            .iter()
            .flat_map(|ev| [from_f64(0.18 * 2f64.powf(*ev)); 3])
            .collect();
        ImageBuf::from_data(evs.len() as u32, 1, data)
    }

    #[test]
    fn grey_ramp_is_neutral_at_mid_scale_after_setup() {
        let Some(p) = pipeline() else { return };
        let fr = p.frontier().expect("frontier active");
        assert!(fr.base.d_ref > 0.3 && fr.base.d_per_ev > 0.05);
        let out = p.process(grey_row(&[0.0]), &CpuBackend);
        let (r, g, b) = (out.data[0] as f64, out.data[1] as f64, out.data[2] as f64);
        assert!((r - g).abs() < 2e-3 && (b - g).abs() < 2e-3, "mid grey not neutral: {r} {g} {b}");
        assert!((g - 0.46).abs() < 0.01, "mid grey should land on mid_grey_out: {g}");
        // The setup slope is only anchored: the ramp ends are near, not exactly, neutral.
        let ends = p.process(grey_row(&[-2.0, 2.0]), &CpuBackend);
        for px in ends.data.chunks(3) {
            assert!((px[0] - px[2]).abs() < 0.08, "ramp ends far from neutral: {px:?}");
        }
    }

    #[test]
    fn lut_is_monotonic_per_channel_on_neutral_input() {
        let Some(p) = pipeline() else { return };
        let evs: Vec<f64> = (0..97).map(|i| -6.0 + 12.0 * i as f64 / 96.0).collect();
        let out = p.process(grey_row(&evs), &CpuBackend);
        for c in 0..3 {
            for i in 1..evs.len() {
                let (a, b) = (out.data[(i - 1) * 3 + c], out.data[i * 3 + c]);
                assert!(b >= a - 1e-6, "channel {c} not monotonic at ev {}: {a} -> {b}", evs[i]);
            }
        }
    }

    #[test]
    fn auto_setup_is_identity_on_neutral_mid_dense_frame() {
        let Some(p) = pipeline() else { return };
        let n = 32usize;
        let grey = ImageBuf::from_data(n as u32, n as u32, vec![from_f64(0.18); n * n * 3]);
        let a = p.frontier_auto_setup(grey).expect("negative film");
        assert!(a.iter().all(|v| v.abs() < 1e-3), "not identity: {a:?}");
        // A frame two stops too bright is pulled down, neutrally.
        let bright = ImageBuf::from_data(n as u32, n as u32, vec![from_f64(0.72); n * n * 3]);
        let a = p.frontier_auto_setup(bright).unwrap();
        assert!(a[0] < -0.3, "bright frame should darken: {a:?}");
        assert!(a[1].abs() < 0.02 && a[2].abs() < 1e-3 && a[3].abs() < 0.02, "cast on neutral frame: {a:?}");
    }

    #[test]
    fn gpu_trilinear_matches_direct_evaluation() {
        let Some(p) = pipeline() else { return };
        let fr = p.frontier().unwrap();
        let (table, steps, dmin, inv) = fr.lut.gpu_table();
        let stage = fr.base.stage(&p.params.scanner.frontier);
        let (mut seed, mut max_err) = (12345u64, 0f64);
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..20000 {
            let mut cmy = [0f32; 3];
            for c in 0..3 {
                let extent = (steps - 1) as f32 / inv[c];
                cmy[c] = dmin[c] + extent * rnd() as f32;
            }
            let got = super::trilinear_reference(table, steps, dmin, inv, cmy);
            let want = fr.base.encode([cmy[0] as f64, cmy[1] as f64, cmy[2] as f64], &stage);
            for c in 0..3 {
                max_err = max_err.max((got[c] as f64 - want[c]).abs());
            }
        }
        eprintln!("gpu trilinear vs direct: max err {max_err:.5} ({:.2}/255)", max_err * 255.0);
        assert!(max_err < 1.0 / 255.0, "max err {max_err}");
    }

    #[test]
    fn keys_move_the_image_the_documented_way() {
        let Some(p) = pipeline() else { return };
        let mut params = p.params.clone();
        let base = p.process(grey_row(&[0.0]), &CpuBackend).data;
        params.scanner.frontier.density = 1.0;
        let brighter = p.clone().with_params(params.clone()).process(grey_row(&[0.0]), &CpuBackend).data;
        assert!(brighter[1] > base[1] + 0.05);
        params.scanner.frontier.density = 0.0;
        params.scanner.frontier.cmy = [0.05, 0.0, 0.0];
        let cyan = p.clone().with_params(params).process(grey_row(&[0.0]), &CpuBackend).data;
        assert!(cyan[0] < base[0] - 0.02 && (cyan[1] - base[1]).abs() < 1e-3);
    }

    #[test]
    fn frontier_update_rebuilds_only_the_lut() {
        let Some(p) = pipeline() else { return };
        let base = p.frontier().unwrap().base.clone();
        let mut params = p.params.clone();
        params.scanner.frontier.contrast = 0.2;
        params.scanner.frontier.cmy = [0.01, -0.02, 0.0];
        let t = std::time::Instant::now();
        let q = p.clone().with_params(params.clone());
        eprintln!("frontier with_params (LUT rebuild, first): {:?}", t.elapsed());
        let t = std::time::Instant::now();
        for i in 0..10 {
            let mut pp = params.clone();
            pp.scanner.frontier.contrast = 0.1 + 0.01 * i as f32;
            std::hint::black_box(q.clone().with_params(pp));
        }
        eprintln!("frontier with_params (LUT rebuild, mean of 10): {:?}", t.elapsed() / 10);
        assert!(std::sync::Arc::ptr_eq(&base, &q.frontier().unwrap().base), "grey-ramp fit must be reused");
        // film-side change refits
        params.film_render.dir_couplers.amount = 0.5;
        let r = q.with_params(params);
        assert!(!std::sync::Arc::ptr_eq(&base, &r.frontier().unwrap().base));
    }

    #[test]
    fn legacy_negative_scan_without_a_model() {
        let Some(mut p) = pipeline() else { return };
        let mut params = p.params.clone();
        params.scanner.model = None;
        p = p.with_params(params);
        assert!(p.frontier().is_none());
        let out = p.process(grey_row(&[0.0]), &CpuBackend);
        assert!(out.data.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0));
    }
}
