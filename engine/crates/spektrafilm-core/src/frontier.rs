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
//! 4. **Keys.** `D'_c += (density + auto.d) * d_per_ev - (cmy_c + auto.c_c + balance_c)`, `balance` being the
//!    stock's film-type balance (`model.balance_cmy`), a fixed offset AutoSetup does not touch.
//!    `d_per_ev` is the grey-ramp G density change per EV at mid-scale, so the
//!    density key is an exposure compensation. A positive C/M/Y key adds that
//!    colour, i.e. lowers the density of its complementary channel (R/G/B).
//! 5. **Gradation.** `x = 0.5 + (D'_c - d_ref) / range_density`, clamped to
//!    0..1, then a sigmoid `1/(1+exp(-a (x-m)))` rescaled to 0..1 (`a` scaled by
//!    `1 + contrast`, `m` solved so x = 0.5 gives `mid_grey_out`), a C1 soft
//!    shoulder above `shoulder_start` (strength scaled by `1 + highlight`),
//!    black/white points, and `black_lift` (same for R, G, B). The output is
//!    sRGB-encoded.
//! 6. **Colour.** Saturation about the Rec.709 luminance in linear light, re-encoded.
//!
//! The result is baked per pixel into a 17^3 (`settings.lut_resolution`) PCHIP
//! LUT over the film density, like the legacy scanner LUT.

use rayon::prelude::*;
use spektrafilm_math::pchip3d::{PreparedPchip3d, pchip_interp, prepare_pchip_3d};
use spektrafilm_math::spectral::N_WAVELENGTHS;

use crate::params::{FrontierAutoParams, FrontierModelParams, FrontierParams};
use crate::profile::Profile;

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];
const FIRST_WL_NM: f64 = 380.0;
const STEP_WL_NM: f64 = 5.0;

fn srgb_decode(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn srgb_encode(v: f64) -> f64 {
    if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

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
    /// Per-channel monotone map `Dn_c -> Dn_G` through the grey ramp points
    /// (film-type LUT); empty = the linear `slope`/`offset` fit.
    lut_x: [Vec<f64>; 3],
    lut_y: Vec<f64>,
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
            lut_x: [Vec::new(), Vec::new(), Vec::new()],
            lut_y: Vec::new(),
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
        self.map_setup(self.normalised_density(cmy))
    }

    /// Film-type setup map of normalised densities `Dn` (linear fit or LUT).
    fn map_setup(&self, dn: [f64; 3]) -> [f64; 3] {
        if self.lut_y.is_empty() {
            return [
                self.slope[0] * dn[0] + self.offset[0],
                self.slope[1] * dn[1] + self.offset[1],
                self.slope[2] * dn[2] + self.offset[2],
            ];
        }
        [self.lut(0, dn[0]), dn[1], self.lut(2, dn[2])]
    }

    /// Piecewise-linear `Dn_c -> Dn_G` through the ramp points (ends extrapolated with the end slopes).
    fn lut(&self, c: usize, d: f64) -> f64 {
        let (x, y) = (&self.lut_x[c], &self.lut_y);
        let n = x.len();
        let i = x.partition_point(|&v| v < d).clamp(1, n - 1);
        if d < x[0] {
            return y[0] + self.model.setup_toe_slope[if c == 0 { 0 } else { 1 }] * (d - x[0]); // below the neutralised range: native slope, offset held
        }
        if d > x[n - 1] {
            return y[n - 1] + self.model.setup_toe_slope[if c == 0 { 0 } else { 1 }] * (d - x[n - 1]);
        }
        let t = (d - x[i - 1]) / (x[i] - x[i - 1]);
        y[i - 1] + t * (y[i] - y[i - 1])
    }

    fn fit_setup(&mut self, ramp_cmy: &[[f64; 3]]) {
        let evs = ramp_evs(&self.model);
        if ramp_cmy.len() != evs.len() {
            return; // identity setup
        }
        let dn: Vec<[f64; 3]> = ramp_cmy.iter().map(|&c| self.normalised_density(c)).collect();
        let mid = dn.len() / 2;
        let m = dn[mid];
        let mut sgg = 0.0;
        let mut sxx = [0.0f64; 3];
        let mut sxg = [0.0f64; 3];
        for d in &dn {
            let dg = d[1] - m[1];
            sgg += dg * dg;
            for c in 0..3 {
                let dx = d[c] - m[c];
                sxx[c] += dx * dx;
                sxg[c] += dx * dg;
            }
        }
        self.d_ref = m[1];
        // Mid-scale slope: regression of G density on EV through the mid point, over +-2 EV only
        // (a wide ramp would average in the toe and shoulder).
        let (mut sge2, mut see2) = (0.0, 0.0);
        for (d, ev) in dn.iter().zip(&evs) {
            if ev.abs() <= 2.0 + 1e-9 {
                sge2 += (d[1] - m[1]) * ev;
                see2 += ev * ev;
            }
        }
        self.d_per_ev = if sge2.abs() > 1e-12 && sgg > 0.0 { (sge2 / see2).abs().max(1e-3) } else { 1.0 };
        if self.model.setup_lut {
            // Film-type LUT: R and B densities are mapped onto G's along the whole ramp, so a grey
            // scene is neutral at every level the ramp covers, not only at mid-scale.
            // Keep the ramp points where every channel is still rising (toe/shoulder plateaus drop out).
            let mut kept: Vec<[f64; 3]> = Vec::new();
            for (d, ev) in dn.iter().zip(&evs) {
                if ev.abs() > self.model.setup_neutral_ev + 1e-9 {
                    continue;
                }
                if kept.last().is_none_or(|k| (0..3).all(|c| d[c] > k[c] + 1e-4)) {
                    kept.push(*d);
                }
            }
            if kept.len() >= 3 {
                self.lut_x = [kept.iter().map(|d| d[0]).collect(), Vec::new(), kept.iter().map(|d| d[2]).collect()];
                self.lut_y = kept.iter().map(|d| d[1]).collect();
                return;
            }
        }
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
            let mut dn = [0.0f64; 3];
            for c in 0..3 {
                dn[c] = -t[c].max(self.model.tmin_floor).log10() - self.dmin[c];
            }
            dst.copy_from_slice(&stage.encode(self.map_setup(dn)));
        });
        out
    }

    /// Operator keys resolved to a per-pixel stage.
    pub fn stage(&self, keys: &FrontierParams) -> Stage {
        let m = &self.model;
        let mut shift = [0.0f64; 3];
        let dens_ev = keys.density as f64 + keys.auto[0] as f64;
        for c in 0..3 {
            shift[c] = dens_ev * self.d_per_ev - (keys.cmy[c] as f64 + keys.auto[1 + c] as f64 + m.balance_cmy[c]);
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
            out: IDENTITY,
        }
    }

    /// Setup-space G density that lands on the paper shoulder knee (zero keys): the
    /// brightest density a large-area highlight may have before it compresses.
    pub fn knee_density(&self) -> f64 {
        let g = Gradation::solve(self.model.gradation_a, self.model.shoulder_sharpness, &self.model);
        self.d_ref + self.model.range_density * (g.knee_x() - 0.5)
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

    /// x at which the sigmoid reaches the shoulder knee (`shoulder_start`).
    fn knee_x(&self) -> f64 {
        let s = |x: f64| 1.0 / (1.0 + (-self.a * (x - self.m)).exp());
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..50 {
            let mid = 0.5 * (lo + hi);
            if (s(mid) - self.s0) / (self.s1 - self.s0) < self.ys { lo = mid } else { hi = mid }
        }
        0.5 * (lo + hi)
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
    /// Linear sRGB (the model's working primaries) -> linear output primaries.
    out: [[f64; 3]; 3],
}

impl Stage {
    /// Final conversion to the output primaries (identity for sRGB output).
    pub fn with_output(mut self, m: [[f64; 3]; 3]) -> Self {
        self.out = m;
        self
    }

    /// Setup densities `D'` -> encoded positive RGB (0..1).
    pub fn encode(&self, d: [f64; 3]) -> [f64; 3] {
        let mut y = [0.0f64; 3];
        for c in 0..3 {
            let x = 0.5 + (d[c] + self.shift[c] - self.d_ref) / self.range;
            y[c] = self.lift + (1.0 - self.lift) * self.curve.curve(x);
        }
        // Saturation about the luminance, in linear light (Y-preserving). Scaling
        // about a gamma-encoded luma compressed bright saturated yellows.
        let lin = y.map(srgb_decode);
        let l = LUMA[0] * lin[0] + LUMA[1] * lin[1] + LUMA[2] * lin[2];
        let lin = lin.map(|v| (l + self.sat * (v - l)).clamp(0.0, 1.0));
        // Working space = sRGB primaries, whatever the output: only this last matrix
        // (and the sRGB transfer) knows the output space.
        let o = |r: &[f64; 3]| (r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2]).clamp(0.0, 1.0);
        [srgb_encode(o(&self.out[0])), srgb_encode(o(&self.out[1])), srgb_encode(o(&self.out[2]))]
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
        out_matrix: [[f64; 3]; 3],
    ) -> Self {
        let stage = base.stage(keys).with_output(out_matrix);
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
    let k_col0 = p.k_col * p.strength;
    // Density: bring the trimmed mean to mid-scale, but never past the highlight guard. A lab
    // operator prints for the subject's highlights: the bright, large-area part of the frame
    // (the `highlight_pct` percentile of G, which skips specular points and whiskers) must sit
    // at or below the paper shoulder knee. A backlit white subject on a dark room has a low
    // mean but a dense subject; the mean alone would brighten it into the shoulder. The guard
    // only limits brightening (it can also pull a frame down), and never loosens the mean term.
    let mut d_den = k_den * (target - mean[1]);
    if p.highlight_pct > 0.0 {
        let hi = percentile(&g, p.highlight_pct);
        let cap = base.knee_density() + p.highlight_margin - hi;
        d_den = d_den.min(p.strength * cap);
    }
    let d_den = d_den.clamp(-p.clamp_density, p.clamp_density);
    let k_col = thin_k_col(p, d_den / base.d_per_ev, k_col0);
    let mut out = [(d_den / base.d_per_ev) as f32, 0.0, 0.0, 0.0];
    for c in 0..3 {
        let dd = (k_col * (mean[1] - mean[c])).clamp(-p.clamp_colour, p.clamp_colour);
        out[1 + c] = (-dd) as f32; // a density gain is the opposite colour key
    }
    out
}

/// Colour-correction strength for a frame whose density key lifts `ev` EV: `k_col0` up to `thin_ev_lo`,
/// smoothly `thin_k_col * strength` from `thin_ev_hi` (a thin negative's cast is read, not left alone).
fn thin_k_col(p: &FrontierAutoParams, ev: f64, k_col0: f64) -> f64 {
    let t = ((ev - p.thin_ev_lo) / (p.thin_ev_hi - p.thin_ev_lo).max(1e-6)).clamp(0.0, 1.0);
    let t = t * t * (3.0 - 2.0 * t);
    k_col0 + t * (p.thin_k_col * p.strength - k_col0)
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
        // Neutral-stock structural tests: the calibrated Gold 200 balance / density offset are not under test.
        let m = &mut p.scanner.frontier.model;
        m.balance_cmy = [0.0; 3];
        m.auto.target_offset = 0.0;
        m.sensor_peak_nm = [650.0, 545.0, 445.0];
        m.sensor_fwhm_nm = [45.0, 50.0, 50.0];
        (m.setup_lut, m.setup_fit_ev, m.setup_fit_steps) = (false, 2.0, 9);
        (m.range_density, m.gradation_a, m.mid_grey_out) = (2.0, 4.2, 0.46);
        (m.shoulder_start, m.shoulder_sharpness, m.black_point, m.white_point) = (0.82, 1.6, 0.02, 0.98);
        (m.auto.k_den, m.auto.k_col, m.auto.strength) = (0.8, 0.6, 0.7);
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
        let (mut seed, mut max_err, mut n_over) = (12345u64, 0f64, 0u32);
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
            let err = (0..3).map(|c| (got[c] as f64 - want[c]).abs()).fold(0.0, f64::max);
            max_err = max_err.max(err);
            n_over += (err > 1.0 / 255.0) as u32;
        }
        eprintln!("gpu trilinear vs direct: max err {max_err:.5} ({:.2}/255)", max_err * 255.0);
        // Linear-light saturation clips a channel to 0 at the gamut edge, and the sRGB toe is steep
        // there: trilinear error > 1/255 stays confined to those few LUT cells (random cube points,
        // most of them outside any real film's densities).
        assert!(n_over < 20000 / 40 && max_err < 0.04, "max err {max_err}, {n_over} over 1/255");
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

    #[test]
    fn saturation_keeps_luminance_and_balance_survives_autosetup() {
        let Some(p) = pipeline() else { return };
        let lum = |c: [f64; 3]| {
            let d = |v: f64| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
            0.2126 * d(c[0]) + 0.7152 * d(c[1]) + 0.0722 * d(c[2])
        };
        // A coloured (not clipped) density: luminance independent of saturation.
        let fr = p.frontier().unwrap();
        let cmy = [0.9, 0.6, 0.5];
        let encode = |sat: f32| {
            let k = crate::params::FrontierParams { saturation: sat, ..p.params.scanner.frontier.clone() };
            fr.base.encode(cmy, &fr.base.stage(&k))
        };
        let (a, b) = (encode(1.0), encode(1.2));
        assert!((lum(a) - lum(b)).abs() < 2e-3, "luminance moved: {a:?} {b:?}");
        assert!((b[0] - b[2]).abs() > (a[0] - a[2]).abs(), "not more saturated: {a:?} {b:?}");

        // Film-type balance: warms the grey, and AutoSetup neither erases nor doubles it.
        let n = 32usize;
        let grey = ImageBuf::from_data(n as u32, n as u32, vec![from_f64(0.18); n * n * 3]);
        let mut params = p.params.clone();
        params.scanner.frontier.model.balance_cmy = [0.0, 0.0, 0.03];
        let q = p.clone().with_params(params);
        let (a0, a1) = (p.frontier_auto_setup(grey.clone()).unwrap(), q.frontier_auto_setup(grey.clone()).unwrap());
        assert!(a0.iter().zip(&a1).all(|(x, y)| (x - y).abs() < 1e-6), "auto depends on balance: {a0:?} {a1:?}");
        let px = q.process(grey_row(&[0.0]), &CpuBackend).data;
        assert!(px[0] > px[2] + 0.01, "balance did not warm the grey: {px:?}");
    }

    #[test]
    fn film_type_lut_keeps_the_whole_ramp_neutral() {
        let Some(p) = pipeline() else { return };
        let mut params = p.params.clone();
        params.scanner.frontier.model.setup_lut = true;
        params.scanner.frontier.model.setup_fit_ev = 4.5;
        params.scanner.frontier.model.setup_fit_steps = 19;
        let params_neutral_ev = params.scanner.frontier.model.setup_neutral_ev;
        let q = p.clone().with_params(params);
        let evs: Vec<f64> = (-8..=8).map(|i| i as f64 / 2.0).collect();
        let out = q.process(grey_row(&evs), &CpuBackend);
        for (px, ev) in out.data.chunks(3).zip(&evs) {
            if ev.abs() <= params_neutral_ev {
                assert!((px[0] - px[1]).abs() < 0.012 && (px[2] - px[1]).abs() < 0.012, "ev {ev} not neutral: {px:?}");
            }
        }
        // beyond the neutralised range the toe keeps its native imbalance: cyan, not neutral
        let toe = out.data[0..3].to_vec();
        assert!(toe[0] < toe[1] - 0.005, "expected a cyan (red-poor) toe at -4 EV: {toe:?}");
        // the linear fit leaves the toe crossover (R and B above G at -4 EV)
        let lin = p.process(grey_row(&[-4.0]), &CpuBackend).data;
        assert!(lin[0] - lin[1] > 0.005, "expected the linear fit to leave a red/magenta toe: {lin:?}");
    }

    fn de2000(l1: [f64; 3], l2: [f64; 3]) -> f64 {
        let rad = std::f64::consts::PI / 180.0;
        let c = |l: [f64; 3]| (l[1] * l[1] + l[2] * l[2]).sqrt();
        let cb = (c(l1) + c(l2)) / 2.0;
        let g = 0.5 * (1.0 - (cb.powi(7) / (cb.powi(7) + 25f64.powi(7))).sqrt());
        let ap = |l: [f64; 3]| (1.0 + g) * l[1];
        let (a1, a2) = (ap(l1), ap(l2));
        let (c1, c2) = ((a1 * a1 + l1[2] * l1[2]).sqrt(), (a2 * a2 + l2[2] * l2[2]).sqrt());
        let hp = |b: f64, a: f64| if a == 0.0 && b == 0.0 { 0.0 } else { b.atan2(a).to_degrees().rem_euclid(360.0) };
        let (h1, h2) = (hp(l1[2], a1), hp(l2[2], a2));
        let dl = l2[0] - l1[0];
        let dc = c2 - c1;
        let mut dh = h2 - h1;
        if dh > 180.0 { dh -= 360.0 } else if dh < -180.0 { dh += 360.0 }
        if c1 * c2 == 0.0 { dh = 0.0 }
        let dhh = 2.0 * (c1 * c2).sqrt() * (dh * rad / 2.0).sin();
        let lb = (l1[0] + l2[0]) / 2.0;
        let cbp = (c1 + c2) / 2.0;
        let hb = if c1 * c2 == 0.0 { h1 + h2 } else if (h1 - h2).abs() <= 180.0 { (h1 + h2) / 2.0 }
            else if h1 + h2 < 360.0 { (h1 + h2 + 360.0) / 2.0 } else { (h1 + h2 - 360.0) / 2.0 };
        let t = 1.0 - 0.17 * ((hb - 30.0) * rad).cos() + 0.24 * (2.0 * hb * rad).cos()
            + 0.32 * ((3.0 * hb + 6.0) * rad).cos() - 0.20 * ((4.0 * hb - 63.0) * rad).cos();
        let sl = 1.0 + 0.015 * (lb - 50.0).powi(2) / (20.0 + (lb - 50.0).powi(2)).sqrt();
        let sc = 1.0 + 0.045 * cbp;
        let sh = 1.0 + 0.015 * cbp * t;
        let dth = 30.0 * (-((hb - 275.0) / 25.0).powi(2)).exp();
        let rc = 2.0 * (cbp.powi(7) / (cbp.powi(7) + 25f64.powi(7))).sqrt();
        let rt = -(2.0 * dth * rad).sin() * rc;
        ((dl / sl).powi(2) + (dc / sc).powi(2) + (dhh / sh).powi(2) + rt * (dc / sc) * (dhh / sh)).sqrt()
    }

    /// Encoded RGB in `space` -> CIELAB D50.
    fn lab_d50(space: &str, rgb: [f64; 3]) -> [f64; 3] {
        use spektrafilm_math::colorspace as cs;
        let lin = rgb.map(super::srgb_decode);
        let to_xyz = if space == "sRGB" { cs::SRGB_TO_XYZ_F64 } else { cs::REC2020_TO_XYZ_F64 };
        let d50 = [0.96422, 1.0, 0.82521];
        let adapt = cs::chromatic_adaptation_matrix_f64(spektrafilm_math::spectral::colorspace_white_xyz_f64(space), d50);
        let mv = |m: &[[f64; 3]; 3], v: [f64; 3]| [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
        let xyz = mv(&adapt, mv(&to_xyz, lin));
        let f = |t: f64| if t > 216.0 / 24389.0 { t.cbrt() } else { (24389.0 / 27.0 * t + 16.0) / 116.0 };
        let (fx, fy, fz) = (f(xyz[0] / d50[0]), f(xyz[1] / d50[1]), f(xyz[2] / d50[2]));
        [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
    }

    #[test]
    fn rendering_is_independent_of_the_output_space() {
        let Some(p) = pipeline() else { return };
        let mut params = p.params.clone();
        params.io.output_color_space = "ITU-R BT.2020".into();
        let q = p.clone().with_params(params);
        let patches: [(&str, [f64; 3]); 4] = [
            ("grey", [0.18, 0.18, 0.18]),
            ("skin", [0.40, 0.25, 0.18]),
            ("red", [0.35, 0.04, 0.03]),
            ("sky", [0.15, 0.28, 0.5]),
        ];
        let img = ImageBuf::from_data(
            4,
            1,
            patches.iter().flat_map(|(_, c)| c.map(from_f64)).collect(),
        );
        let a = p.process(img.clone(), &CpuBackend);
        let b = q.process(img, &CpuBackend);
        for (i, (name, _)) in patches.iter().enumerate() {
            let px = |o: &ImageBuf| [0, 1, 2].map(|c| o.data[i * 3 + c] as f64);
            let (la, lb) = (lab_d50("sRGB", px(&a)), lab_d50("Rec2020", px(&b)));
            let de = de2000(la, lb);
            eprintln!("{name}: sRGB Lab {la:.1?} BT2020 Lab {lb:.1?} dE00 {de:.2}");
            assert!(de < 1.0, "{name}: output space leaks into the rendering, dE00 {de:.2}");
        }
    }

    #[test]
    fn thin_colour_strength_is_exact_for_normal_frames() {
        let p = crate::params::FrontierAutoParams::default();
        let k0 = p.k_col * p.strength;
        for ev in [-1.0, 0.0, 0.3, p.thin_ev_lo] {
            assert_eq!(super::thin_k_col(&p, ev, k0), k0, "ev {ev}");
        }
        let k = |ev| super::thin_k_col(&p, ev, k0);
        assert!(k(1.2) < k0 && k(1.2) > k(p.thin_ev_hi));
        assert!((k(2.5) - p.thin_k_col * p.strength).abs() < 1e-12);
    }

    /// A 2.5 EV thin, warm-lit grey frame: the density key reaches past the old 0.30 logD clamp and the
    /// colour key corrects more of the cast than on a normally exposed frame with the same cast.
    #[test]
    fn thin_warm_frame_gets_full_lift_and_stronger_colour() {
        let Some(p) = pipeline() else { return };
        let n = 16usize;
        let warm = |v: f64| {
            let px = [v * 1.26, v * 0.94, v * 0.54];
            ImageBuf::from_data(n as u32, n as u32, (0..n * n).flat_map(|_| px.map(from_f64)).collect())
        };
        let thin = p.frontier_auto_setup(warm(0.18 * 2f64.powf(-2.5))).unwrap();
        let normal = p.frontier_auto_setup(warm(0.18)).unwrap();
        assert!(thin[0] > 1.3, "2.5 EV thin frame should lift > 1.3 EV (k_den 0.8, strength 0.7 here): {thin:?}");
        assert!(normal[0].abs() < 0.3, "{normal:?}");
        assert!(thin[3].abs() < normal[3].abs(), "thin frame colour key {thin:?} vs normal {normal:?}");
    }
}
