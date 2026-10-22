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
//!    0..1, then a sigmoid `1/(1+exp(-a (x-m)))` rescaled to 0..1 (`m` solved so x = 0.5 gives
//!    `mid_grey_out`; the contrast key remaps x on the pixel's mean density, highlights locked,
//!    the channel gaps scaled with it, see `Tone`), a C1 soft
//!    shoulder above `shoulder_start` (plus the highlights key: a smooth output bump above mid grey),
//!    black/white points, and `black_lift` (same for R, G, B). The output is
//!    sRGB-encoded.
//!    Above mid grey the dimmer channels are pulled towards their mid-slope level so
//!    bright saturated colours keep their chroma (greys unchanged).
//! 6. **Colour.** Saturation about the Rec.709 luminance in linear light, re-encoded.
//!
//! The result is baked per pixel into a 17^3 (`settings.lut_resolution`) PCHIP
//! LUT over the film density, like the legacy scanner LUT; a 3*(steps-1)+1
//! node table (49^3 at the default) is also baked for the GPU trilinear lookup.

use rayon::prelude::*;
use spektrafilm_math::pchip3d::{PreparedPchip3d, pchip_interp, prepare_pchip_3d};
use spektrafilm_math::spectral::N_WAVELENGTHS;

use crate::params::{FrontierAutoParams, FrontierModelParams, FrontierParams};
use crate::profile::Profile;

/// Highlights key, as functions of the output level above mid grey (u: 0 = mid grey, 1 = white).
/// Down (h = -1): bump (amplitude, rise width, fall start, fall width) subtracted from the output.
/// Up (h = +1): (gain, rise width): the remaining distance to white shrinks by `gain * smoothstep`.
/// Both are linear in the key.
const HIGHLIGHT_DOWN: (f64, f64, f64, f64) = (0.22, 0.7, 0.7, 0.8);
const HIGHLIGHT_UP: (f64, f64) = (0.85, 0.6);
/// Contrast key: mid-grey slope factor `1 + SLOPE_UP c` (c > 0) / `1 + SLOPE_DOWN c` (c < 0).
const SLOPE_UP: f64 = 1.9;
const SLOPE_DOWN: f64 = 0.85;
/// Contrast key shape constants (mid/shadow bulge, toe lift); `TOE_SLOPE` below is
/// the toe slope (d out / d base-out at black) the shadows keep.
const MID_BULGE_UP: f64 = 0.45;
const MID_BULGE_DOWN: f64 = 0.8;
const SHADOW_BULGE: f64 = 0.7;
const TOE_LIFT: f64 = 1.2;
const TOE_SLOPE: f64 = 0.85;
/// Contrast is applied to the pixel's mean density (`Tone`), the channel gaps are scaled by the tone
/// slope there, but never below `1 + GAP_FLOOR (k - 1)` when the contrast is up (a harder print is
/// more saturated also where the highlight lock compresses the tones).
const GAP_FLOOR: f64 = 0.15;
/// Max |d ln gap / dx|: below 3 every output channel stays non-decreasing in its own density
/// (d x'_c / d x_c >= T'/3 + gap (2/3 - 2 L/9), with |x_c - mean| <= 2/3).
const GAP_LIPSCHITZ: f64 = 2.5;
const TONE_N: usize = 256;
/// Whites key: max shift of the normalized density (`WHITES_SHIFT`), acting from `WHITES_REACH`
/// below the shoulder knee up to the top of the range.
const WHITES_SHIFT: f64 = 0.12;
const WHITES_REACH: f64 = 0.1;

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];
/// Chroma-preserving highlights: encoded level where the blend starts / is complete, gain on
/// the mid-tone slope used for the channel gaps, and the largest pull on one channel.
const CHROMA_FROM: f64 = 0.5;
const CHROMA_TO: f64 = 0.7;
const CHROMA_SLOPE_GAIN: f64 = 2.0;
const CHROMA_MAX_STEP: f64 = 0.03;
const FIRST_WL_NM: f64 = 380.0;
const STEP_WL_NM: f64 = 5.0;

fn srgb_decode(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn srgb_encode(v: f64) -> f64 {
    if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// Grey-ramp exposures of the film-type fit: EVs (scene grey = 0.18 * 2^ev), the middle
/// one is 18 % grey at ev 0.
pub fn ramp_evs(m: &FrontierModelParams) -> Vec<f64> {
    let n = (m.setup_fit_steps.max(3) | 1) as usize;
    (0..n)
        .map(|i| -m.setup_fit_ev + 2.0 * m.setup_fit_ev * i as f64 / (n - 1) as f64)
        .collect()
}

/// The film's dye spectral densities (per wavelength: c, m, y) and its base density, on the
/// 380-780 nm / 5 nm grid; NaN where the profile's dye data does not reach (UV/NIR edges).
pub fn film_spectra(film: &Profile) -> (Vec<[f64; 3]>, Vec<f64>) {
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
    let base: Vec<f64> = (0..cd.len())
        .map(|i| film.data.base_density.get(i).copied().unwrap_or(0.0))
        .collect();
    (cd, base)
}

/// Per-wavelength weights of three Gaussian bands (peak, FWHM in nm), each normalised to sum 1:
/// how a scanner's (or a densitometer's) channel c reads the film's transmittance. Wavelengths
/// without dye data carry no weight (the bands are narrow).
pub fn band_weights(cd: &[[f64; 3]], base: &[f64], peak_nm: [f64; 3], fwhm_nm: [f64; 3]) -> Vec<[f64; 3]> {
    let n = cd.len();
    let valid: Vec<bool> = (0..n)
        .map(|i| base[i].is_finite() && cd[i].iter().all(|v| v.is_finite()))
        .collect();
    let mut weights = vec![[0.0f64; 3]; n];
    for c in 0..3 {
        let sigma = |fwhm: f64| fwhm / (2.0 * (2.0 * std::f64::consts::LN_2).sqrt());
        let s = sigma(fwhm_nm[c]).max(1e-6);
        let mut sum = 0.0;
        for (i, w) in weights.iter_mut().enumerate() {
            let wl = FIRST_WL_NM + STEP_WL_NM * i as f64;
            let z = (wl - peak_nm[c]) / s;
            w[c] = if valid[i] { (-0.5 * z * z).exp() } else { 0.0 };
            sum += w[c];
        }
        for w in weights.iter_mut() {
            w[c] /= sum;
        }
    }
    weights
}

/// Band transmittance `T_c = sum_l w_c(l) 10^-(cmy . cd(l) + base(l))` of a film density.
pub fn band_transmittance(cd: &[[f64; 3]], base: &[f64], weights: &[[f64; 3]], cmy: [f64; 3]) -> [f64; 3] {
    let mut t = [0.0f64; 3];
    for i in 0..cd.len() {
        let w = &weights[i];
        if w[0] + w[1] + w[2] == 0.0 {
            continue; // no data at this wavelength
        }
        let c = &cd[i];
        let tr = 10f64.powf(-(cmy[0] * c[0] + cmy[1] * c[1] + cmy[2] * c[2] + base[i]));
        t[0] += tr * w[0];
        t[1] += tr * w[1];
        t[2] += tr * w[2];
    }
    t
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
        let (cd, base) = film_spectra(film);
        let weights = band_weights(&cd, &base, model.sensor_peak_nm, model.sensor_fwhm_nm);
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
        let t = band_transmittance(&self.cd, &self.base, &self.weights, cmy);
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
        let c = keys.contrast as f64;
        // mid-slope factor: x(1 + SLOPE_UP c) up to ~2.8 at +1, down to 0.2 at -1
        let a = m.gradation_a * if c > 0.0 { 1.0 + SLOPE_UP * c } else { 1.0 + SLOPE_DOWN * c };
        // Highlights key (-1..+1, + = brighter, more open): a smooth bump on the
        // output fading in above mid grey, so mid grey and shadows keep the model curve. Exactly the model curve at 0.
        let h = (keys.highlight as f64).clamp(-1.0, 1.0);
        let sh = m.shoulder_sharpness;
        Stage {
            d_ref: self.d_ref,
            range: m.range_density.max(1e-6),
            shift,
            curve: Gradation::solve(m.gradation_a, sh, m).with_highlight(h),
            tone: Tone::new(a / m.gradation_a, m, keys.debug_contrast_mode),
            lift: keys.black_lift.clamp(0.0, 1.0) as f64 * m.black_lift_max,
            mid_slope: {
                let g = Gradation::solve(m.gradation_a, m.shoulder_sharpness, m);
                (g.curve(0.52) - g.curve(0.48)) / 0.04
            },
            sat: (m.saturation * keys.saturation as f64).max(0.0),
            sat_blue: m.saturation_blue,
            blue_shift: m.blue_hue_shift,
            green_shift: m.green_hue_shift,
            sat_warm: m.saturation_warm,
            warm_shift: m.warm_hue_shift,
            cool_warm: m.cool_neutral_warm,
            hl_neutral: m.highlight_neutral,
            hue_shift: m.hue_shift,
            hue_light: m.hue_lightness.map(|g| g.max(0.0)),
            hue_sat: m.hue_saturation.map(|g| g.max(0.0)),
            whites: (keys.whites as f64).clamp(-1.0, 1.0),
            whites_x0: Gradation::solve(m.gradation_a, sh, m).knee_x() - WHITES_REACH,
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
    /// Contrast-free sigmoid (a, m, s0, s1) the highlights stay locked to; `lock` is
    /// false when the contrast is 0 (the curve is then the plain sigmoid).
    lock: bool,
    k: f64,
    /// normalized sigmoid level at x = 0.5 (mid grey); the blend is 1 up to here
    ya: f64,
    /// Highlights key: alternative shoulder (knee, sharpness, its white normalization) blended in
    /// above mid grey; `hl_on` is false at 0 (the curve is then untouched).
    hl_on: bool,
    hl: f64,
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
            lock: false,
            k: 1.0,
            ya: 0.0,
            hl_on: false,
            hl: 0.0,
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

    /// Contrast acts on mids and shadows only: `a` is the contrast-steepened slope, `a0` the
    /// contrast-free one. Mid grey stays put, and from mid grey up to the shoulder knee the
    /// curve blends C1-smoothly (smoothstep) back into the unchanged contrast-free sigmoid,
    /// so the output at and above `shoulder_start` does not depend on contrast.
    fn solve_locked(a: f64, a0: f64, sh: f64, p: &FrontierModelParams) -> Self {
        let mut g = Self::solve(a0, sh, p);
        let k = (a / a0).clamp(0.15, 2.9);
        if k == 1.0 {
            return g;
        }
        g.ya = g.pre(0.5);
        g.lock = true;
        g.k = k;
        g
    }

    /// Monotone Hermite remap of the contrast-free pre-shoulder output `y`: identity at 0, at
    /// mid grey (`ya`, slope `k`) and from the shoulder knee up (slope 1), so only shadows and mids move.
    fn remap(&self, y: f64) -> f64 {
        let (ya, ys, k) = (self.ya, self.ys, self.k);
        if y >= ys || y <= 0.0 {
            return y;
        }
        // knots: black, half way to mid grey, mid grey (slope k), half way to the knee, the knee.
        // Between them the curve bulges by `(k - 1) lam (y - ya)` so the mid-slope change is paid
        // back towards both ends.
        let lam = if k > 1.0 { MID_BULGE_UP } else { MID_BULGE_DOWN };
        let xs = [0.0, 0.5 * ya, ya, ya + 0.5 * (ys - ya), ys];
        let mut vs = xs;
        for i in 1..4 {
            vs[i] = xs[i] + (k - 1.0) * lam * (xs[i] - ya) * if i < 2 && k > 1.0 { SHADOW_BULGE } else { 1.0 };
        }
        let sec = |i: usize| (vs[i + 1] - vs[i]) / (xs[i + 1] - xs[i]);
        let mut ms = [0.0; 5];
        ms[2] = k;
        ms[4] = 1.0;
        for i in [1usize, 3] {
            let (a, b) = (sec(i - 1), sec(i));
            ms[i] = if a > 0.0 && b > 0.0 { 2.0 * a * b / (a + b) } else { 0.0 };
        }
        ms[0] = (if k > 1.0 { TOE_SLOPE } else { 1.0 + (1.0 - k) * TOE_LIFT }).min(3.0 * sec(0));
        let i = if y <= xs[1] { 0 } else if y <= xs[2] { 1 } else if y <= xs[3] { 2 } else { 3 };
        let w = xs[i + 1] - xs[i];
        let t = (y - xs[i]) / w;
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * vs[i] + (t3 - 2.0 * t2 + t) * w * ms[i] + (-2.0 * t3 + 3.0 * t2) * vs[i + 1] + (t3 - t2) * w * ms[i + 1]
    }

    fn shoulder(&self, y: f64) -> f64 {
        Self::shoulder_with(y, self.ys, self.sh)
    }

    fn shoulder_with(y: f64, ys: f64, sh: f64) -> f64 {
        if y <= ys {
            return y;
        }
        let t = (y - ys) / (1.0 - ys);
        // C1 at the knee: slope 1, then compressing; sh -> 0 is the identity.
        let f = if sh < 1e-6 { t } else { (1.0 - (-sh * t).exp()) / sh };
        ys + (1.0 - ys) * f
    }

    /// Highlights key (`HIGHLIGHT_DOWN` / `HIGHLIGHT_UP`) applied to the shouldered
    /// output above mid grey; h < 0 pulls the highlights down, h > 0 opens them towards paper white
    /// without a clip. Mid grey, shadows and h = 0 are untouched.
    fn with_highlight(mut self, h: f64) -> Self {
        if h == 0.0 {
            return self;
        }
        self.hl_on = true;
        self.hl = h;
        self.ya = self.pre(0.5);
        self
    }

    /// Curve before the shoulder (sigmoid, contrast-locked), normalized 0..1.
    fn pre(&self, x: f64) -> f64 {
        let s = |x: f64| 1.0 / (1.0 + (-self.a * (x - self.m)).exp());
        let mut y = (s(x) - self.s0) / (self.s1 - self.s0);
        if self.lock {
            y = self.remap(y);
        }
        y
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
        let y = self.pre(x);
        let mut o = self.shoulder(y) / self.shoulder_one;
        if self.hl_on {
            let sm = |t: f64| {
                let t = t.clamp(0.0, 1.0);
                t * t * (3.0 - 2.0 * t)
            };
            let o0 = self.ya / self.shoulder_one;
            let u = ((o - o0) / (1.0 - o0)).clamp(0.0, 1.0);
            if self.hl < 0.0 {
                let (amp, rise, fall_at, fall_w) = HIGHLIGHT_DOWN;
                o += self.hl * amp * sm(u / rise) * (1.0 - sm((u - fall_at) / fall_w));
            } else {
                // the remaining distance to white shrinks by g: smooth approach, never past white
                let (gain, rise) = HIGHLIGHT_UP;
                o = 1.0 - (1.0 - o) * (1.0 - self.hl * gain * sm(u / rise));
            }
        }
        self.bp + (self.wp - self.bp) * o
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
    /// Extra chroma gain on cyan-blue hues (see `FrontierModelParams::saturation_blue`).
    sat_blue: f64,
    /// Hue rotation of the cyan-blue band towards cyan, degrees (see `FrontierModelParams::blue_hue_shift`).
    blue_shift: f64,
    /// Hue rotation of the greens towards yellow, degrees (see `FrontierModelParams::green_hue_shift`).
    green_shift: f64,
    /// Extra chroma gain on the yellow-orange band (see `FrontierModelParams::saturation_warm`).
    sat_warm: f64,
    /// Hue rotation of the yellow-orange band towards red, degrees (see `FrontierModelParams::warm_hue_shift`).
    warm_shift: f64,
    /// Share of the cold chroma removed from dark-to-mid low-chroma tones (see `FrontierModelParams::cool_neutral_warm`).
    cool_warm: f64,
    /// Share of the warm chroma removed from pale light tones (see `FrontierModelParams::highlight_neutral`).
    hl_neutral: f64,
    /// Hue rotation per hue, degrees (see `FrontierModelParams::hue_shift`).
    hue_shift: [f64; 6],
    /// Light gain of saturated colours per hue (see `FrontierModelParams::hue_lightness`).
    hue_light: [f64; 6],
    /// Saturation gain per hue (see `FrontierModelParams::hue_saturation`).
    hue_sat: [f64; 6],
    /// Encoded slope of the gradation at mid grey (the film's mid-tone density -> level slope).
    mid_slope: f64,
    /// Linear sRGB (the model's working primaries) -> linear output primaries.
    out: [[f64; 3]; 3],
    /// Contrast key (None at 0).
    tone: Option<Tone>,
    /// Whites key and the normalized density where it starts.
    whites: f64,
    whites_x0: f64,
}

/// Whites key: normalized density shift for a pixel of mean density `xm`, 0 below `x0`.
/// - : the whole top comes down (white too); + : a bump that is 0 at the top (no new clip).
fn whites_shift(w: f64, x0: f64, xm: f64) -> f64 {
    let t = ((xm - x0) / (1.0 - x0)).clamp(0.0, 1.0);
    let s = t * t * (3.0 - 2.0 * t);
    w * WHITES_SHIFT * if w < 0.0 { s } else { 4.0 * s * (1.0 - t) }
}

/// Contrast key as a remap of the normalized density, `T = curve0^-1 . curve_locked`: the locked
/// contrast curve expressed on the contrast-free one. It is applied to the pixel's mean density and
/// the channels keep their gaps (scaled by `gap`), so the hue of light colours survives the highlight
/// lock (per channel, a blue sky's dim R moved while its G/B were locked: the sky went pale).
#[derive(Clone, Copy, Debug)]
struct Tone {
    t: [f64; TONE_N + 1],
    /// ln of the channel gap gain at the nodes (Lipschitz-limited, see `GAP_LIPSCHITZ`)
    lg: [f64; TONE_N + 1],
}

impl Tone {
    /// `mode` (debug v3): 0 = highlight-locked curve (v2), 1 = free steeper sigmoid,
    /// 2 = rational density remap about mid grey `u -> k u / (1 + (k^1.5 - 1) |u|^1.5)^(1/1.5)` (ends fixed),
    /// 3 = 0 below mid grey (shadow toe kept) and 2 above.
    fn new(k: f64, m: &FrontierModelParams, mode: u32) -> Option<Self> {
        let sh = m.shoulder_sharpness;
        let g0 = Gradation::solve(m.gradation_a, sh, m);
        let gk = Gradation::solve_locked(m.gradation_a * k, m.gradation_a, sh, m);
        if !gk.lock {
            return None;
        }
        let gf = Gradation::solve(m.gradation_a * gk.k, sh, m);
        let mut t = [0.0; TONE_N + 1];
        for (i, v) in t.iter_mut().enumerate() {
            let x = i as f64 / TONE_N as f64;
            // mode 3 = mode 0 (toe kept) below mid grey, mode 2 (free) above: both have slope k at x = 0.5
            if mode == 2 || (mode == 3 && x > 0.5) {
                let (u, p) = (2.0 * (x - 0.5), 1.5);
                *v = 0.5 + 0.5 * gk.k * u / (1.0 + (gk.k.powf(p) - 1.0) * u.abs().powf(p)).powf(1.0 / p);
                continue;
            }
            let y = if mode == 1 { gf.curve(x) } else { gk.curve(x) };
            let (mut lo, mut hi) = (0.0f64, 1.0f64);
            for _ in 0..40 {
                let mid = 0.5 * (lo + hi);
                if g0.curve(mid) < y { lo = mid } else { hi = mid }
            }
            *v = 0.5 * (lo + hi);
        }
        // gap = the tone slope (floored when the contrast is up), its log made L-Lipschitz (forward
        // and backward passes): contrast up takes the lower envelope (the narrow mid-grey peak comes
        // down), contrast down the upper one capped at 1 (the mid-grey dip comes up, the highlights keep their colour)
        let floor = if gk.k > 1.0 { 1.0 + GAP_FLOOR * (gk.k - 1.0) } else { 0.05 };
        let mut lg = [0.0; TONE_N + 1];
        for i in 0..=TONE_N {
            let (a, b) = (i.saturating_sub(1), (i + 1).min(TONE_N));
            let d = (t[b] - t[a]) * TONE_N as f64 / (b - a) as f64;
            lg[i] = d.max(floor).min(3.0).ln();
        }
        let step = GAP_LIPSCHITZ / TONE_N as f64;
        let s = if gk.k > 1.0 { 1.0 } else { -1.0 };
        for i in 1..=TONE_N {
            lg[i] = s * (s * lg[i]).min(s * lg[i - 1] + step);
        }
        for i in (0..TONE_N).rev() {
            lg[i] = s * (s * lg[i]).min(s * lg[i + 1] + step);
        }
        if gk.k < 1.0 {
            // a softer print is never more saturated than the standard one
            lg.iter_mut().for_each(|v| *v = v.min(0.0));
        }
        Some(Self { t, lg })
    }

    /// Remapped mean density and the channel gap gain there.
    fn at(&self, x: f64) -> (f64, f64) {
        let f = x.clamp(0.0, 1.0) * TONE_N as f64;
        let i = (f as usize).min(TONE_N - 1);
        let w = f - i as f64;
        (self.t[i] + (self.t[i + 1] - self.t[i]) * w, (self.lg[i] + (self.lg[i + 1] - self.lg[i]) * w).exp())
    }
}

impl Stage {
    /// Final conversion to the output primaries (identity for sRGB output).
    pub fn with_output(mut self, m: [[f64; 3]; 3]) -> Self {
        self.out = m;
        self
    }

    /// Setup densities `D'` -> encoded positive RGB (0..1).
    pub fn encode(&self, d: [f64; 3]) -> [f64; 3] {
        let mut x = [0.0f64; 3];
        let mut y = [0.0f64; 3];
        for c in 0..3 {
            x[c] = (0.5 + (d[c] + self.shift[c] - self.d_ref) / self.range).clamp(0.0, 1.0);
        }
        if let Some(tone) = &self.tone {
            let xm = (x[0] + x[1] + x[2]) / 3.0;
            let (xt, gap) = tone.at(xm);
            x = x.map(|v| (xt + gap * (v - xm)).clamp(0.0, 1.0));
        }
        if self.whites != 0.0 {
            // one shift for the three channels (hue kept), from the pixel's mean density; its slope
            // stays far below 3, so every channel stays non-decreasing in its own density
            let d = whites_shift(self.whites, self.whites_x0, (x[0] + x[1] + x[2]) / 3.0);
            x = x.map(|v| (v + d).clamp(0.0, 1.0));
        }
        for c in 0..3 {
            y[c] = self.lift + (1.0 - self.lift) * self.curve.curve(x[c]);
        }
        // Chroma-preserving highlights. The sigmoid and its shoulder flatten the density
        // differences between the channels, so bright saturated colours come out pale.
        // From mid grey up to about the shoulder knee, the channels are pushed towards the
        // gaps the mid-tone slope would give them. Greys (equal x) are untouched.
        let (xm, ym) = ((x[0] + x[1] + x[2]) / 3.0, (y[0] + y[1] + y[2]) / 3.0);
        let t = ((ym - CHROMA_FROM) / (CHROMA_TO - CHROMA_FROM)).clamp(0.0, 1.0);
        let w = t * t * (3.0 - 2.0 * t);
        if w > 0.0 {
            // Spread about the channel mean, each channel's step soft-limited by tanh.
            let cap = CHROMA_MAX_STEP * ((1.0 - ym) / 0.2).clamp(0.05, 1.0);
            let mut e = [0.0f64; 3];
            for c in 0..3 {
                let want = CHROMA_SLOPE_GAIN * self.mid_slope * (1.0 - self.lift) * (x[c] - xm);
                // the step fades with the channel's own curve slope (flat top: no step), which
                // keeps every output channel non-decreasing in its density
                let h = 0.01;
                let sl = ((self.curve.curve((x[c] + h).min(1.0)) - self.curve.curve((x[c] - h).max(0.0))) * (1.0 - self.lift)
                    / (((x[c] + h).min(1.0) - (x[c] - h).max(0.0)).max(1e-9)) / self.mid_slope.max(1e-9))
                .clamp(0.0, 1.0);
                e[c] = sl * sl * cap * ((want - (y[c] - ym)) / cap).tanh();
            }
            // smooth max: no channel is pushed up, so the brightest one (and the clipping) stays put
            let em = 0.01 * (e.iter().map(|v| (v / 0.01).exp()).sum::<f64>()).ln();
            for c in 0..3 {
                y[c] = (y[c] + w * (e[c] - em)).clamp(0.0, 1.0);
            }
        }
        // Saturation about the luminance, in linear light (Y-preserving). Scaling
        // about a gamma-encoded luma compressed bright saturated yellows.
        let mut lin = y.map(srgb_decode);
        let l = LUMA[0] * lin[0] + LUMA[1] * lin[1] + LUMA[2] * lin[2];
        let gw = if self.green_shift != 0.0 { green_weight(&lin) } else { 0.0 };
        if gw > 0.0 {
            // greens that are dull (low chroma, low-to-mid luma: woods, shadows) take the full rotation; vivid or light foliage keeps only
            // GREEN_VIVID_KEEP of it
            let wv = 1.0 - (1.0 - smooth(0.03, 0.08, opp_chroma(&lin))) * (1.0 - smooth(0.12, 0.30, l));
            lin = rotate_hue(&lin, l, -self.green_shift * gw * (GREEN_VIVID_KEEP + (1.0 - GREEN_VIVID_KEEP) * (1.0 - wv)));
        }
        if self.blue_shift != 0.0 {
            // mid / deep blues only (deep sky, sea): pale skies near the horizon keep their hue
            let bw = blue_weight(&lin) * (1.0 - smooth(BLUE_SHIFT_L.0, BLUE_SHIFT_L.1, l));
            if bw > 0.0 {
                lin = rotate_hue(&lin, l, -self.blue_shift * bw);
            }
        }
        let ww = if self.sat_warm != 0.0 || self.warm_shift != 0.0 { warm_weight(&lin, l) } else { 0.0 };
        if ww > 0.0 && self.warm_shift != 0.0 {
            lin = rotate_hue(&lin, l, -self.warm_shift * ww);
        }
        if self.cool_warm != 0.0 {
            lin = cool_neutral(&lin, l, self.cool_warm);
        }
        if self.hl_neutral != 0.0 {
            lin = pale_light_neutral(&lin, l, self.hl_neutral);
        }
        if self.hue_shift != [0.0; 6] {
            if let Some(h) = opp_hue(&lin) {
                lin = rotate_hue(&lin, l, knots(h, &self.hue_shift));
            }
        }
        if self.hue_light != [1.0; 6] {
            if let Some(h) = opp_hue(&lin) {
                let w = smooth(HUE_LIGHT_CHROMA.0, HUE_LIGHT_CHROMA.1, opp_chroma(&lin) / l.max(1e-6));
                let k = 1.0 + w * (knots(h, &self.hue_light) - 1.0);
                lin = lin.map(|v| v * k);
            }
        }
        let sat = if self.sat_blue != 0.0 {
            // cyan-blue hues, light ones only: the gain fades out below SAT_BLUE_L (linear luma), so dark blues (the chart's
            // blue sky, deep shadows) keep their chroma while a bright sky gets the full boost
            let t = ((l - SAT_BLUE_L.0) / (SAT_BLUE_L.1 - SAT_BLUE_L.0)).clamp(0.0, 1.0);
            self.sat * (1.0 + self.sat_blue * blue_weight(&lin) * t * t * (3.0 - 2.0 * t))
        } else {
            self.sat
        } * (1.0 + self.sat_warm * ww)
            * if self.hue_sat == [1.0; 6] { 1.0 } else { opp_hue(&lin).map_or(1.0, |h| knots(h, &self.hue_sat)) };
        let lin = lin.map(|v| (l + sat * (v - l)).clamp(0.0, 1.0));
        // Working space = sRGB primaries, whatever the output: only this last matrix
        // (and the sRGB transfer) knows the output space.
        let o = |r: &[f64; 3]| (r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2]).clamp(0.0, 1.0);
        [srgb_encode(o(&self.out[0])), srgb_encode(o(&self.out[1])), srgb_encode(o(&self.out[2]))]
    }
}

/// Relative chroma ramp (opponent chroma / linear luma) of `hue_lightness`: fitted on the Gold 200 chart frames of a real Frontier
/// (eval/frontier_cp: the excess lightness of saturated colours, none on pastels below 0.1).
const HUE_LIGHT_CHROMA: (f64, f64) = (0.19, 0.66);

/// Hue angle (deg) on the opponent axes of linear light (red 30, yellow 90, green 150, cyan 210, blue 270, magenta 330); None on a grey.
fn opp_hue(lin: &[f64; 3]) -> Option<f64> {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    (o1 * o1 + o2 * o2 >= 1e-12).then(|| o2.atan2(o1).to_degrees().rem_euclid(360.0))
}

/// A per-hue value at hue `h` from its 6 knots (red 30, yellow 90, ... magenta 330 deg): each knot weighs smoothstep(1 - |d| / 60)
/// of its hue distance d, normalised.
fn knots(h: f64, g: &[f64; 6]) -> f64 {
    let (mut sw, mut sg) = (0.0, 0.0);
    for (i, gi) in g.iter().enumerate() {
        let d = ((h - (30.0 + 60.0 * i as f64) + 180.0).rem_euclid(360.0) - 180.0).abs();
        let w = smooth(0.0, 1.0, 1.0 - d / 60.0);
        sw += w;
        sg += w * gi;
    }
    if sw > 0.0 { sg / sw } else { 0.0 }
}

/// Linear-luma ramp (full below, none above) of the `blue_hue_shift` rotation.
const BLUE_SHIFT_L: (f64, f64) = (0.15, 0.35);

/// Linear-luma ramp (from, to) of the `saturation_blue` gain.
const SAT_BLUE_L: (f64, f64) = (0.06, 0.18);

/// Weight (0..1) of the cyan-blue hue band, from the hue angle on the opponent axes of linear
/// light (red 30, yellow 90, green 150, cyan 210, blue 270, magenta 330 deg): 1 from 223 to 251
/// (cyan, sky), smooth ramps 198-223 and 251-266, 0 elsewhere (skin, reds, yellows, greens,
/// magentas).
fn blue_weight(lin: &[f64; 3]) -> f64 {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    if o1 * o1 + o2 * o2 < 1e-12 {
        return 0.0;
    }
    let h = o2.atan2(o1).to_degrees().rem_euclid(360.0);
    let ss = |a: f64, b: f64, x: f64| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    ss(198.0, 223.0, h) * (1.0 - ss(251.0, 266.0, h))
}

/// Share of `green_hue_shift` kept by vivid / light greens.
const GREEN_VIVID_KEEP: f64 = 0.15;

fn smooth(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Chroma on the opponent axes of linear light.
fn opp_chroma(lin: &[f64; 3]) -> f64 {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    (o1 * o1 + o2 * o2).sqrt()
}

/// Weight (0..1) of the yellow-orange band (golden / orange clouds of a low sun, amber): opponent hue 44-52 up / 80-100 down
/// (skin ~42-45 and pure orange / red below stay), relative chroma (opponent chroma / linear luma) 0.15-0.35 up (greys, cream
/// whites and dull warm interiors stay).
fn warm_weight(lin: &[f64; 3], l: f64) -> f64 {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    let c = (o1 * o1 + o2 * o2).sqrt();
    if c < 1e-9 || l < 1e-6 {
        return 0.0;
    }
    let h = o2.atan2(o1).to_degrees().rem_euclid(360.0);
    smooth(44.0, 52.0, h) * (1.0 - smooth(80.0, 100.0, h)) * smooth(0.15, 0.35, c / l)
}

/// Weight (0..1) of the green hue band (same opponent-axis hue angle as `blue_weight`: yellow 90,
/// green 150, cyan 210): smooth ramp 95-120 up, 1 from 120 to 165, ramp 165-195 down, so that yellows
/// (90), skin / reds (< 80) and the cyan-blue band (>= 190, `blue_weight`) are untouched.
fn green_weight(lin: &[f64; 3]) -> f64 {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    if o1 * o1 + o2 * o2 < 1e-12 {
        return 0.0;
    }
    let h = o2.atan2(o1).to_degrees().rem_euclid(360.0);
    let ss = |a: f64, b: f64, x: f64| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    ss(95.0, 120.0, h) * (1.0 - ss(165.0, 195.0, h))
}

/// Low-chroma, dark-to-mid, cold-hued tones (grey-green-blue casts of shadows / mid-tones, e.g. rock) lose a share
/// `k * weight` of their component away from the neutral-warm direction (opponent hue 60 deg), luminance kept.
/// Weights: chroma (opponent axes, linear light) ramps up 0.002-0.008 (neutral greys untouched) and down 0.03-0.06 (saturated
/// blues / sea / clothes untouched), hue 135-160 up and 255-275 down (skin, reds, yellows untouched), linear luma full below 0.18, 0 above 0.30
/// (light sky untouched).
fn cool_neutral(lin: &[f64; 3], l: f64, k: f64) -> [f64; 3] {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    let c = (o1 * o1 + o2 * o2).sqrt();
    if c < 1e-9 {
        return *lin;
    }
    let ss = |a: f64, b: f64, x: f64| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let h = o2.atan2(o1).to_degrees().rem_euclid(360.0);
    let w = ss(0.002, 0.008, c) * (1.0 - ss(0.03, 0.06, c)) * ss(135.0, 160.0, h) * (1.0 - ss(255.0, 275.0, h)) * (1.0 - ss(0.18, 0.30, l));
    if w <= 0.0 {
        return *lin;
    }
    // component along the warm axis (60 deg); only the cold (negative) part is reduced
    let (wx, wy) = (60f64.to_radians().cos(), 60f64.to_radians().sin());
    let pw = (o1 * wx + o2 * wy).min(0.0);
    let (p1, p2) = (o1 - k * w * pw * wx, o2 - k * w * pw * wy);
    let m = (lin[0] + lin[1] + lin[2]) / 3.0;
    let (a, b) = (p1 * std::f64::consts::FRAC_1_SQRT_2, p2 / 6f64.sqrt());
    let mut out = [m + a + b, m - a + b, m - 2.0 * b];
    let lo = LUMA[0] * out[0] + LUMA[1] * out[1] + LUMA[2] * out[2];
    for v in out.iter_mut() {
        *v += l - lo;
    }
    out
}

/// Pale, light, warm-hued tones (whites that come out cream / yellow: sunlit rails, walls, clouds) lose the share
/// `k * weight` of their chroma, luminance kept. Weights: linear luma ramps up 0.38-0.62 (L* ~68-82: mids stay as they are),
/// chroma 1 below 0.20 and 0 above 0.32 (saturated yellows, skin, oranges untouched), opponent hue 62-74 up / 105-125 down
/// (yellow-orange band only).
fn pale_light_neutral(lin: &[f64; 3], l: f64, k: f64) -> [f64; 3] {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    let c = (o1 * o1 + o2 * o2).sqrt();
    if c < 1e-9 {
        return *lin;
    }
    let ss = |a: f64, b: f64, x: f64| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let h = o2.atan2(o1).to_degrees().rem_euclid(360.0);
    let w = ss(0.38, 0.62, l) * (1.0 - ss(0.20, 0.32, c)) * ss(62.0, 74.0, h) * (1.0 - ss(105.0, 125.0, h));
    if w <= 0.0 {
        return *lin;
    }
    let f = 1.0 - k * w;
    // yellow-green whites (hue > 72) are also pulled back towards the warm-neutral side (a* -> 0), by up to 0.8 deg per deg, 20 deg
    let (sn, cs) = (-0.8 * k * w * (h - 72.0).clamp(0.0, 25.0)).to_radians().sin_cos();
    let (r1, r2) = (cs * o1 - sn * o2, sn * o1 + cs * o2);
    let m = (lin[0] + lin[1] + lin[2]) / 3.0;
    let (a, b) = (r1 * f * std::f64::consts::FRAC_1_SQRT_2, r2 * f / 6f64.sqrt());
    let mut out = [m + a + b, m - a + b, m - 2.0 * b];
    let lo = LUMA[0] * out[0] + LUMA[1] * out[1] + LUMA[2] * out[2];
    for v in out.iter_mut() {
        *v += l - lo;
    }
    out
}

/// Rotates the chroma of linear RGB `lin` by `deg` degrees on the opponent axes (+ = rising hue angle: yellow
/// -> green -> cyan), keeping the linear luma `l` (Rec.709); the result may leave [0, 1], the caller clamps.
fn rotate_hue(lin: &[f64; 3], l: f64, deg: f64) -> [f64; 3] {
    let o1 = (lin[0] - lin[1]) * std::f64::consts::FRAC_1_SQRT_2;
    let o2 = (lin[0] + lin[1] - 2.0 * lin[2]) / 6f64.sqrt();
    let m = (lin[0] + lin[1] + lin[2]) / 3.0;
    let (s, c) = deg.to_radians().sin_cos();
    let (p1, p2) = (c * o1 - s * o2, s * o1 + c * o2);
    let (a, b) = (p1 * std::f64::consts::FRAC_1_SQRT_2, p2 / 6f64.sqrt());
    let mut out = [m + a + b, m - a + b, m - 2.0 * b];
    let lo = LUMA[0] * out[0] + LUMA[1] * out[1] + LUMA[2] * out[2];
    for v in out.iter_mut() {
        *v += l - lo;
    }
    out
}

/// The baked scanner LUT: film density (cmy) -> encoded output (the Frontier's sRGB-encoded positive, or the
/// narrowband scan's encoded band transmittance).
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

    /// A scan LUT of any density -> encoded-output function `f` (the narrowband scan), with the same
    /// node layout, interpolation and GPU table density as the Frontier's.
    pub fn from_fn(f: impl Fn([f64; 3]) -> [f64; 3] + Sync, data_min: [f64; 3], data_max: [f64; 3], steps: usize) -> Self {
        let nodes = |n: usize| -> Vec<f64> {
            let at = |a: usize, i: usize| data_min[a] + (data_max[a] - data_min[a]) * i as f64 / (n - 1) as f64;
            let mut out = vec![0.0f64; n * n * n * 3];
            out.par_chunks_exact_mut(3).enumerate().for_each(|(idx, dst)| {
                let (i, j, k) = (idx / (n * n), (idx / n) % n, idx % n);
                dst.copy_from_slice(&f([at(0, i), at(1, j), at(2, k)]));
            });
            out
        };
        let step_inv = (steps - 1) as f64;
        let gs = 3 * (steps - 1) + 1;
        Self {
            prepared: prepare_pchip_3d(nodes(steps), steps),
            table: nodes(gs).iter().map(|&v| v as f32).collect(),
            steps: gs,
            data_min,
            inv: [0, 1, 2].map(|c| step_inv / (data_max[c] - data_min[c])),
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
    // Colour: the trimmed mean, or (neutral_sigma > 0) a mean weighted towards near-neutral pixels.
    let colour = if p.neutral_sigma > 0.0 {
        let (mut acc, mut wsum) = ([0.0f64; 3], 0.0);
        for d in &kept {
            let chroma = (d[0] - d[1]).abs().max((d[2] - d[1]).abs());
            let w = 1.0 / (1.0 + (chroma / p.neutral_sigma).powi(2));
            for c in 0..3 {
                acc[c] += w * d[c];
            }
            wsum += w;
        }
        acc.map(|a| a / wsum)
    } else {
        mean
    };
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
        let dd = (k_col * (colour[1] - colour[c])).clamp(-p.clamp_colour, p.clamp_colour);
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
    fn highlight_key_is_monotone_directional_and_identity_at_zero() {
        let p = crate::params::FrontierModelParams::default();
        let mk = |h: f64| {
            super::Gradation::solve_locked(p.gradation_a, p.gradation_a, p.shoulder_sharpness, &p).with_highlight(h)
        };
        let base = mk(0.0);
        for i in 0..=100 {
            let x = i as f64 / 100.0;
            assert_eq!(base.curve(x).to_bits(), super::Gradation::solve(p.gradation_a, p.shoulder_sharpness, &p).curve(x).to_bits());
        }
        for h in [-1.0f64, -0.5, 0.5, 1.0] {
            let g = mk(h);
            let mut prev = -1.0;
            for i in 0..=2000 {
                let y = g.curve(i as f64 / 2000.0);
                assert!(y >= prev - 1e-12, "not monotone at h={h} i={i}");
                prev = y;
            }
            assert!((g.curve(0.5) - base.curve(0.5)).abs() < 1e-9, "mid grey moved at h={h}");
            assert!((g.curve(0.2) - base.curve(0.2)).abs() < 1e-9, "shadow moved at h={h}");
            for x in [0.75, 0.85, 0.95] {
                let d = g.curve(x) - base.curve(x);
                assert!(d * h > 0.0, "wrong direction at h={h} x={x} d={d}");
            }
            if h.abs() == 1.0 {
                // strong key: the biggest highlight move is >= 0.15 (down) / 0.10 (up) in encoded level
                let big = (0..=100).map(|i| (g.curve(i as f64 / 100.0) - base.curve(i as f64 / 100.0)) * h.signum()).fold(0.0f64, f64::max);
                let need = if h < 0.0 { 0.15 } else { 0.10 };
                assert!(big >= need, "highlight key too weak at h={h}: {big}");
            }
        }
    }

    #[test]
    fn contrast_locks_highlights_and_is_identity_at_zero() {
        let p = crate::params::FrontierModelParams::default();
        let base = super::Gradation::solve_locked(p.gradation_a, p.gradation_a, p.shoulder_sharpness, &p);
        let plain = super::Gradation::solve(p.gradation_a, p.shoulder_sharpness, &p);
        for i in 0..=100 {
            let x = i as f64 / 100.0;
            assert_eq!(base.curve(x).to_bits(), plain.curve(x).to_bits());
        }
        for c in [-1.0f64, -0.5, 0.5, 1.0] {
            let a = (p.gradation_a * (1.0 + c)).max(0.05);
            let g = super::Gradation::solve_locked(a, p.gradation_a, p.shoulder_sharpness, &p);
            assert!((g.curve(0.5) - base.curve(0.5)).abs() < 1e-6, "{c} {} {} ys={} ya={}", g.curve(0.5), base.curve(0.5), g.ys, g.ya);
            let knee = base.knee_x();
            let mut prev = -1.0;
            for i in 0..=1000 {
                let x = i as f64 / 1000.0;
                let y = g.curve(x);
                assert!(y >= prev - 1e-12, "not monotonic at c={c} x={x}");
                prev = y;
                if x >= knee {
                    assert!((y - base.curve(x)).abs() < 1e-9, "highlight moved at c={c} x={x}");
                }
            }
            let slope = |g: &super::Gradation| (g.curve(0.52) - g.curve(0.48)) / 0.04;
            assert!((slope(&g) - slope(&base)).abs() > 0.1 * slope(&base), "mid slope unchanged at c={c}");
        }
    }

    #[test]
    fn contrast_tone_keeps_each_channel_monotone() {
        let p = crate::params::FrontierModelParams::default();
        for c in [-1.0f64, -0.5, 0.3, 0.5, 1.0] {
            let k = if c > 0.0 { 1.0 + super::SLOPE_UP * c } else { 1.0 + super::SLOPE_DOWN * c };
            for mode in [0u32, 2, 3] {
            let tone = super::Tone::new(k, &p, mode).expect("contrast on");
            let map = |x: [f64; 3]| {
                let xm = (x[0] + x[1] + x[2]) / 3.0;
                let (xt, gap) = tone.at(xm);
                x.map(|v| xt + gap * (v - xm))
            };
            // grey axis = the locked contrast curve's tone, in the contrast-free curve's terms
            assert!((map([0.5; 3])[0] - 0.5).abs() < 1e-6, "c={c}: mid grey moved");
            for i in 0..=20 {
                for j in 0..=20 {
                    let (a, b) = (i as f64 / 20.0, j as f64 / 20.0);
                    let mut prev = f64::NEG_INFINITY;
                    for n in 0..=400 {
                        let v = map([n as f64 / 400.0, a, b])[0];
                        assert!(v >= prev - 1e-12, "c={c} mode={mode}: channel fell at x=[{}, {a}, {b}]", n as f64 / 400.0);
                        prev = v;
                    }
                }
            }
            }
        }
    }

    #[test]
    fn whites_key_moves_only_the_top_and_keeps_channels_monotone() {
        let p = crate::params::FrontierModelParams::default();
        let x0 = super::Gradation::solve(p.gradation_a, p.shoulder_sharpness, &p).knee_x() - super::WHITES_REACH;
        assert!(x0 > 0.55 && x0 < 0.9, "knee x0={x0}");
        for w in [-1.0f64, -0.5, 0.5, 1.0] {
            assert_eq!(super::whites_shift(w, x0, 0.5), 0.0, "mid grey moved");
            assert_eq!(super::whites_shift(w, x0, x0), 0.0);
            let top = super::whites_shift(w, x0, 1.0);
            if w > 0.0 { assert!(top.abs() < 1e-12, "white moved at w={w}") } else { assert!(top < 0.0) }
            assert!(super::whites_shift(w, x0, 0.5 * (x0 + 1.0)) * w > 0.0, "wrong direction at w={w}");
            // channel c: x_c + shift(mean); the mean moves by 1/3 of x_c
            let mut prev = f64::NEG_INFINITY;
            for n in 0..=1000 {
                let xc = n as f64 / 1000.0;
                let v = xc + super::whites_shift(w, x0, (xc + 2.0 * 0.9) / 3.0);
                assert!(v >= prev, "channel fell at w={w} xc={xc}");
                prev = v;
            }
        }
    }

    #[test]
    fn saturated_warm_highlight_keeps_hue_and_chroma() {
        let Some(p) = pipeline() else { return };
        let fr = p.frontier().unwrap();
        let stage = |on: bool| {
            let mut st = fr.base.stage(&p.params.scanner.frontier);
            if !on {
                st.mid_slope = 0.0;
            }
            st
        };
        // warm highlight: R at the top of the range, G and B progressively lower in density
        let d = |st: &super::Stage| st.encode([fr.base.knee_density() + 0.25, fr.base.knee_density() - 0.05, fr.base.knee_density() - 0.3]);
        let (on, off) = (d(&stage(true)), d(&stage(false)));
        let chroma = |v: [f64; 3]| v[0] - v[2];
        assert!(on[0] >= on[1] && on[1] >= on[2], "hue order kept: {on:?}");
        assert!(chroma(on) >= chroma(off) - 1e-9, "chroma kept: {on:?} vs {off:?}");
        assert!(on.iter().all(|v| (0.0..=1.0).contains(v)));
        // greys untouched
        let g = stage(true).encode([fr.base.knee_density(); 3]);
        assert!((g[0] - g[1]).abs() < 1e-9 && (g[1] - g[2]).abs() < 1e-9);
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
    fn knots_hit_the_knots_and_greys_have_no_hue() {
        let g = [0.8, 1.1, 0.9, 1.0, 0.7, 0.6];
        assert_eq!(super::opp_hue(&[0.2, 0.2, 0.2]), None);
        let h = |lin: [f64; 3]| super::opp_hue(&lin).unwrap();
        // red (opponent hue ~30), pure blue (270), between two knots: the mean
        assert!((super::knots(h([0.5, 0.05, 0.03]), &g) - 0.8).abs() < 0.05);
        assert!((super::knots(h([0.06, 0.06, 0.4]), &g) - 0.7).abs() < 1e-9);
        assert!((super::knots(60.0, &g) - 0.95).abs() < 1e-9);
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
    fn frontier_update_matches_fresh_engine_with_halation() {
        let Some(p) = pipeline() else { return };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/data");
        let mut params = p.params.clone();
        params.film_render.halation.active = true;
        params.film_render.halation.boost_ev = 1.0;
        let updated = p.clone().with_params(params.clone());
        let fresh = Pipeline::new_with_spectral(p.film.clone(), p.print.clone(), params, &dir).unwrap();
        let evs: Vec<f64> = (-8..=8).map(|i| i as f64 / 2.0).collect();
        let a = updated.process(grey_row(&evs), &CpuBackend).data;
        let b = fresh.process(grey_row(&evs), &CpuBackend).data;
        assert!(a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-6), "update() != fresh Engine");
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
