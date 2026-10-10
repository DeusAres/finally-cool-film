/// Runtime parameters for the film simulation pipeline.
///
/// Mirrors Python `params_schema.py`. Every field has a sensible default
/// matching the Python implementation.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffusionFilterParams {
    #[serde(default)]
    pub active: bool,
    #[serde(default = "default_bpm")]
    pub filter_family: String,
    #[serde(default = "default_half")]
    pub strength: f32,
    #[serde(default = "default_one")]
    pub spatial_scale: f32,
    #[serde(default)]
    pub halo_warmth: f32,
    #[serde(default = "default_one")]
    pub core_intensity: f32,
    #[serde(default = "default_one")]
    pub core_size: f32,
    #[serde(default = "default_one")]
    pub halo_intensity: f32,
    #[serde(default = "default_one")]
    pub halo_size: f32,
    #[serde(default = "default_one")]
    pub bloom_intensity: f32,
    #[serde(default = "default_one")]
    pub bloom_size: f32,
}

impl DiffusionFilterParams {
    /// Borrowed view as the model crate's `DiffusionFilter` (f64), for the
    /// CPU diffusion-filter apply. `family` borrows `self.filter_family`.
    pub fn to_model(&self) -> spektrafilm_model::diffusion::DiffusionFilter<'_> {
        spektrafilm_model::diffusion::DiffusionFilter {
            family: &self.filter_family,
            strength: self.strength as f64,
            spatial_scale: self.spatial_scale as f64,
            halo_warmth: self.halo_warmth as f64,
            core_intensity: self.core_intensity as f64,
            core_size: self.core_size as f64,
            halo_intensity: self.halo_intensity as f64,
            halo_size: self.halo_size as f64,
            bloom_intensity: self.bloom_intensity as f64,
            bloom_size: self.bloom_size as f64,
        }
    }
}

impl Default for DiffusionFilterParams {
    fn default() -> Self {
        Self {
            active: false,
            filter_family: "black_pro_mist".into(),
            strength: 0.5,
            spatial_scale: 1.0,
            halo_warmth: 0.0,
            core_intensity: 1.0,
            core_size: 1.0,
            halo_intensity: 1.0,
            halo_size: 1.0,
            bloom_intensity: 1.0,
            bloom_size: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraParams {
    #[serde(default)]
    pub exposure_compensation_ev: f32,
    #[serde(default = "default_true")]
    pub auto_exposure: bool,
    #[serde(default = "default_center_weighted")]
    pub auto_exposure_method: String,
    #[serde(default)]
    pub lens_blur_um: f32,
    #[serde(default = "default_35")]
    pub film_format_mm: f32,
    #[serde(default = "default_filter_uv")]
    pub filter_uv: [f32; 3],
    #[serde(default = "default_filter_ir")]
    pub filter_ir: [f32; 3],
    #[serde(default)]
    pub diffusion_filter: DiffusionFilterParams,
}

impl Default for CameraParams {
    fn default() -> Self {
        Self {
            exposure_compensation_ev: 0.0,
            auto_exposure: true,
            auto_exposure_method: "center_weighted".into(),
            lens_blur_um: 0.0,
            film_format_mm: 35.0,
            filter_uv: [0.0, 410.0, 8.0],
            filter_ir: [0.0, 675.0, 15.0],
            diffusion_filter: DiffusionFilterParams::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnlargerParams {
    #[serde(default = "default_th_kg3")]
    pub illuminant: String,
    #[serde(default = "default_one")]
    pub print_exposure: f32,
    #[serde(default = "default_true")]
    pub print_exposure_compensation: bool,
    #[serde(default = "default_true")]
    pub normalize_print_exposure: bool,
    #[serde(default)]
    pub y_filter_shift: f32,
    #[serde(default)]
    pub m_filter_shift: f32,
    #[serde(default = "default_55")]
    pub y_filter_neutral: f32,
    #[serde(default = "default_65")]
    pub m_filter_neutral: f32,
    #[serde(default)]
    pub c_filter_neutral: f32,
    #[serde(default)]
    pub lens_blur: f32,
    #[serde(default)]
    pub diffusion_filter: DiffusionFilterParams,
    #[serde(default)]
    pub preflash_exposure: f32,
    #[serde(default)]
    pub preflash_y_filter_shift: f32,
    #[serde(default)]
    pub preflash_m_filter_shift: f32,
}

impl Default for EnlargerParams {
    fn default() -> Self {
        Self {
            illuminant: "TH-KG3".into(),
            print_exposure: 1.0,
            print_exposure_compensation: true,
            normalize_print_exposure: true,
            y_filter_shift: 0.0,
            m_filter_shift: 0.0,
            y_filter_neutral: 55.0,
            m_filter_neutral: 65.0,
            c_filter_neutral: 0.0,
            lens_blur: 0.0,
            diffusion_filter: DiffusionFilterParams::default(),
            preflash_exposure: 0.0,
            preflash_y_filter_shift: 0.0,
            preflash_m_filter_shift: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerParams {
    #[serde(default)]
    pub lens_blur: f32,
    #[serde(default)]
    pub white_correction: bool,
    #[serde(default)]
    pub black_correction: bool,
    #[serde(default = "default_098")]
    pub white_level: f32,
    #[serde(default = "default_001")]
    pub black_level: f32,
    #[serde(default = "default_unsharp")]
    pub unsharp_mask: [f32; 2],
    /// Scanner model. `None` keeps the legacy `scan_film` behaviour (the
    /// negative as a 17^3-LUT spectral scan). `"frontier"` (with `io.scan_film`
    /// on a negative stock) returns the positive made by the Frontier model.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub frontier: FrontierParams,
}

impl Default for ScannerParams {
    fn default() -> Self {
        Self {
            lens_blur: 0.0,
            white_correction: false,
            black_correction: false,
            white_level: 0.98,
            black_level: 0.01,
            unsharp_mask: [0.7, 0.7],
            model: None,
            frontier: FrontierParams::default(),
        }
    }
}

/// Frontier SP-3000 scanner: operator keys (neutral defaults = lab default)
/// plus the inferred model constants (`model`). See `eval/V2_CONTRACT.md` and
/// `eval/frontier_model.json`; `crate::frontier` documents the maths.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FrontierParams {
    /// Brightness key in EV, + = brighter positive.
    pub density: f32,
    /// C, M, Y keys in density units (logD); + = more of that colour.
    pub cmy: [f32; 3],
    /// Gradation steepness about mid-grey, 0 = standard (`a *= 1 + contrast`).
    pub contrast: f32,
    /// Colour saturation, 1 = standard.
    pub saturation: f32,
    /// Highlight shoulder, 0 = standard (`shoulder *= 1 + highlight`).
    pub highlight: f32,
    /// 0..1, raises black equally in R, G, B (scanner space, hue-neutral).
    pub black_lift: f32,
    /// AutoSetup result `[density_ev, c, m, y]` (set by the app from
    /// `Engine.frontier_auto_setup`), same units as `density` and `cmy`.
    pub auto: [f32; 4],
    /// Inferred model constants (all `G`/`I` in `eval/frontier_model.json`).
    pub model: FrontierModelParams,
}

impl Default for FrontierParams {
    fn default() -> Self {
        Self {
            density: 0.0,
            cmy: [0.0; 3],
            contrast: 0.0,
            saturation: 1.0,
            highlight: 0.0,
            black_lift: 0.0,
            auto: [0.0; 4],
            model: FrontierModelParams::default(),
        }
    }
}

/// Inferred Frontier model constants. Defaults are the values of
/// `eval/frontier_model.json`; every one is meant to be calibrated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FrontierModelParams {
    /// Sensor channel peak wavelengths (nm), R G B (Status-M-like Gaussians).
    pub sensor_peak_nm: [f64; 3],
    /// Sensor channel FWHM (nm).
    pub sensor_fwhm_nm: [f64; 3],
    /// Transmittance floor (ADC clip): `T = max(T, tmin_floor)`.
    pub tmin_floor: f64,
    /// Film-type fit: grey ramp half-range in EV about mid-grey (18 %).
    pub setup_fit_ev: f64,
    /// Film-type setup as a per-channel LUT through the ramp (neutral at every ramp level)
    /// instead of a linear fit (neutral at mid-scale only).
    pub setup_lut: bool,
    /// dD'/dDn of R and B beyond the neutralised range.
    pub setup_toe_slope: [f64; 2],
    /// Film-type LUT neutralises only ramp points within +-this many EV of mid-grey (the density
    /// range of a normal exposure); beyond it the end slopes extrapolate and the toe/shoulder keep
    /// their native layer imbalance.
    pub setup_neutral_ev: f64,
    /// Film-type fit: number of ramp steps (odd, includes mid-grey).
    pub setup_fit_steps: u32,
    /// Density range (logD) mapped to the full gradation input 0..1.
    pub range_density: f64,
    /// Sigmoid steepness `a`.
    pub gradation_a: f64,
    /// Encoded output at mid-scale (x = 0.5); the sigmoid midpoint is solved
    /// so that this holds whatever `contrast` is (0.46 = 18 % grey, sRGB).
    pub mid_grey_out: f64,
    /// Shoulder start (fraction of the curve output).
    pub shoulder_start: f64,
    /// Shoulder strength.
    pub shoulder_sharpness: f64,
    /// Encoded black / white points of the curve.
    pub black_point: f64,
    pub white_point: f64,
    /// Encoded black raised by `black_lift = 1`.
    pub black_lift_max: f64,
    /// Saturation about Rec.709 luminance (linear light) at `saturation = 1`.
    pub saturation: f64,
    /// Film-type balance of this stock (Fuji "film master" setup): fixed C, M, Y
    /// offset in logD, same sign as `FrontierParams::cmy` (+ = more of that
    /// colour). Applied with the keys but outside AutoSetup, which keeps
    /// neutralising the frame and so never erases it.
    pub balance_cmy: [f64; 3],
    /// AutoSetup constants.
    pub auto: FrontierAutoParams,
}

impl Default for FrontierModelParams {
    fn default() -> Self {
        Self {
            sensor_peak_nm: [640.0, 540.0, 450.0],
            sensor_fwhm_nm: [40.0, 50.0, 50.0],
            tmin_floor: 0.0005,
            setup_lut: true,
            setup_toe_slope: [1.5, 0.8],
            setup_neutral_ev: 2.0,
            setup_fit_ev: 4.5,
            setup_fit_steps: 19,
            range_density: 1.5923,
            gradation_a: 5.8184,
            mid_grey_out: 0.4683,
            shoulder_start: 0.6928,
            shoulder_sharpness: 1.7142,
            black_point: 0.022,
            white_point: 0.9908,
            black_lift_max: 0.25,
            saturation: 1.12,
            balance_cmy: [0.0, 0.0, 0.02],
            auto: FrontierAutoParams::default(),
        }
    }
}

/// AutoSetup constants (`autosetup.params` of the model file).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FrontierAutoParams {
    pub k_den: f64,
    pub k_col: f64,
    pub clamp_density: f64,
    pub clamp_colour: f64,
    pub border_mask_frac: f64,
    pub trim_lo_pct: f64,
    pub trim_hi_pct: f64,
    pub exclude_pct: f64,
    /// Density target of the frame mean (G) relative to mid-grey density.
    pub target_offset: f64,
    pub strength: f64,
    pub thumb_size: u32,
    /// Highlight guard: percentile of G (0 = off) of the large-area highlights.
    pub highlight_pct: f64,
    /// Density allowed above the shoulder knee for that percentile.
    pub highlight_margin: f64,
    /// Thin negatives (Interno): once the density key lifts more than `thin_ev_lo` EV the lab trusts its
    /// colour reading more, ramping `k_col` to `thin_k_col` at `thin_ev_hi` EV. Frames needing <= `thin_ev_lo`
    /// (every normally exposed frame) keep `k_col` exactly.
    pub thin_k_col: f64,
    pub thin_ev_lo: f64,
    pub thin_ev_hi: f64,
}

impl Default for FrontierAutoParams {
    fn default() -> Self {
        Self {
            k_den: 1.0,
            k_col: 0.2,
            clamp_density: 0.45,
            clamp_colour: 0.15,
            border_mask_frac: 0.08,
            trim_lo_pct: 10.0,
            trim_hi_pct: 90.0,
            exclude_pct: 0.5,
            target_offset: 0.0109,
            strength: 0.85,
            thumb_size: 64,
            highlight_pct: 95.0,
            highlight_margin: 0.1672,
            thin_k_col: 0.0,
            thin_ev_lo: 0.8,
            thin_ev_hi: 1.6,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrainParams {
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default = "default_true")]
    pub sublayers_active: bool,
    // f64 to preserve Python JSON precision through the Poisson/Binomial
    // RNG pipeline — the f32 truncation of these values shifts the
    // Poisson lambda by ~5e-8 and produces a different RNG stream.
    #[serde(default = "default_02_f64")]
    pub agx_particle_area_um2: f64,
    #[serde(default = "default_particle_scale_f64")]
    pub agx_particle_scale: [f64; 3],
    #[serde(default = "default_particle_scale_layers_f64")]
    pub agx_particle_scale_layers: [f64; 3],
    #[serde(default = "default_density_min_f64")]
    pub density_min: [f64; 3],
    #[serde(default = "default_uniformity_f64")]
    pub uniformity: [f64; 3],
    #[serde(default = "default_065")]
    pub blur: f32,
    #[serde(default = "default_one")]
    pub blur_dye_clouds_um: f32,
    #[serde(default = "default_micro_structure")]
    pub micro_structure: [f32; 2],
    #[serde(default = "default_1i")]
    pub n_sub_layers: u32,
    /// One shared noise field across all channels instead of independent
    /// per-channel RNG streams. Set by the pipeline for B&W films
    /// (upstream n_channels==1 has a single emulsion); not user-facing.
    #[serde(default)]
    pub monochrome: bool,
}

fn default_02_f64() -> f64 {
    0.2
}
fn default_particle_scale_f64() -> [f64; 3] {
    [1.6, 1.6, 3.2]
}
fn default_particle_scale_layers_f64() -> [f64; 3] {
    [2.0, 1.0, 0.5]
}
fn default_density_min_f64() -> [f64; 3] {
    [0.03, 0.03, 0.03]
}
fn default_uniformity_f64() -> [f64; 3] {
    [0.97, 0.99, 0.97]
}

impl Default for GrainParams {
    fn default() -> Self {
        Self {
            active: true,
            sublayers_active: true,
            agx_particle_area_um2: 0.2,
            agx_particle_scale: [1.6, 1.6, 3.2],
            agx_particle_scale_layers: [2.0, 1.0, 0.5],
            density_min: [0.03, 0.03, 0.03],
            uniformity: [0.97, 0.99, 0.97],
            blur: 0.65,
            blur_dye_clouds_um: 1.0,
            micro_structure: [0.2, 30.0],
            n_sub_layers: 1,
            monochrome: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HalationParams {
    #[serde(default = "default_true")]
    pub active: bool,
    // f64 to match Python's `np.asarray(..., dtype=np.float64)` —
    // f32 storage truncates ~7 decimals which shifts every sigma/lambda
    // by ~3e-8, accumulating through Gaussian/exponential kernels.
    #[serde(default = "default_one_f64")]
    pub scatter_amount: f64,
    #[serde(default = "default_one_f64")]
    pub scatter_spatial_scale: f64,
    #[serde(default = "default_one_f64")]
    pub halation_amount: f64,
    #[serde(default = "default_one_f64")]
    pub halation_spatial_scale: f64,
    #[serde(default = "default_scatter_core_f64")]
    pub scatter_core_um: [f64; 3],
    #[serde(default = "default_scatter_tail_f64")]
    pub scatter_tail_um: [f64; 3],
    #[serde(default = "default_scatter_tail_weight_f64")]
    pub scatter_tail_weight: [f64; 3],
    #[serde(default)]
    pub boost_ev: f32,
    #[serde(default = "default_03")]
    pub boost_range: f32,
    #[serde(default = "default_4")]
    pub protect_ev: f32,
    #[serde(default = "default_halation_strength_f64")]
    pub halation_strength: [f64; 3],
    #[serde(default = "default_halation_sigma_f64")]
    pub halation_first_sigma_um: [f64; 3],
    #[serde(default = "default_3i")]
    pub halation_n_bounces: u32,
    #[serde(default = "default_half_f64")]
    pub halation_bounce_decay: f64,
    #[serde(default = "default_true")]
    pub halation_renormalize: bool,
    /// Halation only reacts to light above this threshold (EV relative to
    /// mid grey 0.18), with a soft knee one EV wide.
    #[serde(default = "default_halation_threshold_ev")]
    pub halation_threshold_ev: f32,
}

fn default_halation_threshold_ev() -> f32 {
    2.5
}

fn default_one_f64() -> f64 {
    1.0
}
fn default_half_f64() -> f64 {
    0.5
}
fn default_scatter_core_f64() -> [f64; 3] {
    [2.2, 2.0, 1.6]
}
fn default_scatter_tail_f64() -> [f64; 3] {
    [9.3, 9.7, 9.1]
}
fn default_scatter_tail_weight_f64() -> [f64; 3] {
    [0.78, 0.65, 0.67]
}
fn default_halation_strength_f64() -> [f64; 3] {
    [0.05, 0.015, 0.0]
}
fn default_halation_sigma_f64() -> [f64; 3] {
    [65.0, 65.0, 65.0]
}

impl Default for HalationParams {
    fn default() -> Self {
        Self {
            active: true,
            scatter_amount: 1.0,
            scatter_spatial_scale: 1.0,
            halation_amount: 1.0,
            halation_spatial_scale: 1.0,
            scatter_core_um: [2.2, 2.0, 1.6],
            scatter_tail_um: [9.3, 9.7, 9.1],
            scatter_tail_weight: [0.78, 0.65, 0.67],
            boost_ev: 0.0,
            boost_range: 0.3,
            protect_ev: 4.0,
            halation_strength: [0.05, 0.015, 0.0],
            halation_first_sigma_um: [65.0, 65.0, 65.0],
            halation_n_bounces: 3,
            halation_bounce_decay: 0.5,
            halation_renormalize: true,
            halation_threshold_ev: 2.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirCouplersParams {
    #[serde(default = "default_true")]
    pub active: bool,
    // f64 throughout — Python reads these as JSON floats (f64). The
    // f32 truncation of values like 0.341 (→ 0.3409999907... in f32 vs
    // 0.341 = 0.34100000000000003 in f64) shifts every coupler weight
    // and diffusion sigma by ~3e-8 and amplifies through the per-channel
    // density correction.
    #[serde(default = "default_one_f64")]
    pub amount: f64,
    #[serde(default = "default_one_f64")]
    pub inhibition_samelayer: f64,
    #[serde(default = "default_one_f64")]
    pub inhibition_interlayer: f64,
    #[serde(default = "default_gamma_same_f64")]
    pub gamma_samelayer_rgb: [f64; 3],
    #[serde(default = "default_gamma_r_gb_f64")]
    pub gamma_interlayer_r_to_gb: [f64; 2],
    #[serde(default = "default_gamma_g_rb_f64")]
    pub gamma_interlayer_g_to_rb: [f64; 2],
    #[serde(default = "default_gamma_b_rg_f64")]
    pub gamma_interlayer_b_to_rg: [f64; 2],
    #[serde(default = "default_20_f64")]
    pub diffusion_size_um: f64,
    #[serde(default = "default_200_f64")]
    pub diffusion_tail_um: f64,
    #[serde(default = "default_006_f64")]
    pub diffusion_tail_weight: f64,
}

fn default_gamma_same_f64() -> [f64; 3] {
    [0.341, 0.324, 0.273]
}
fn default_gamma_r_gb_f64() -> [f64; 2] {
    [0.355, 0.305]
}
fn default_gamma_g_rb_f64() -> [f64; 2] {
    [0.154, 0.358]
}
fn default_gamma_b_rg_f64() -> [f64; 2] {
    [0.171, 0.225]
}
fn default_20_f64() -> f64 {
    20.0
}
fn default_200_f64() -> f64 {
    200.0
}
fn default_006_f64() -> f64 {
    0.06
}

impl Default for DirCouplersParams {
    fn default() -> Self {
        Self {
            active: true,
            amount: 0.7, // Gold 200 calibration (eval/calib/CALIB.md)
            inhibition_samelayer: 0.6,
            inhibition_interlayer: 0.6,
            gamma_samelayer_rgb: [0.341, 0.324, 0.273],
            gamma_interlayer_r_to_gb: [0.355, 0.305],
            gamma_interlayer_g_to_rb: [0.154, 0.358],
            gamma_interlayer_b_to_rg: [0.171, 0.225],
            diffusion_size_um: 20.0,
            diffusion_tail_um: 200.0,
            diffusion_tail_weight: 0.06,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlareParams {
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default = "default_003")]
    pub percent: f32,
    #[serde(default = "default_07")]
    pub roughness: f32,
    #[serde(default = "default_half")]
    pub blur: f32,
}

impl Default for GlareParams {
    fn default() -> Self {
        Self {
            active: true,
            percent: 0.03,
            roughness: 0.7,
            blur: 0.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilmRenderingParams {
    #[serde(default = "default_one")]
    pub density_curve_gamma: f32,
    /// Development time (minutes) for B&W development-time families —
    /// forward-port of upstream dev's `chemistry.development_time`. Selects
    /// the nearest entry of the profile's family; `None` picks the
    /// floor-middle entry. Ignored by colour profiles.
    #[serde(default)]
    pub development_time: Option<f64>,
    #[serde(default)]
    pub grain: GrainParams,
    #[serde(default)]
    pub halation: HalationParams,
    #[serde(default)]
    pub dir_couplers: DirCouplersParams,
    #[serde(default)]
    pub glare: GlareParams,
}

impl Default for FilmRenderingParams {
    fn default() -> Self {
        Self {
            density_curve_gamma: 1.0,
            development_time: None,
            grain: GrainParams::default(),
            halation: HalationParams::default(),
            dir_couplers: DirCouplersParams::default(),
            glare: GlareParams::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintRenderingParams {
    #[serde(default = "default_one")]
    pub density_curve_gamma: f32,
    /// Development time (minutes) for B&W print stocks (e.g. kodak_2302) —
    /// same semantics as `FilmRenderingParams::development_time`.
    #[serde(default)]
    pub development_time: Option<f64>,
    #[serde(default)]
    pub glare: GlareParams,
    #[serde(default)]
    pub density_curves_morph: PrintCurvesMorphParams,
}

impl Default for PrintRenderingParams {
    fn default() -> Self {
        Self {
            density_curve_gamma: 1.0,
            development_time: None,
            glare: GlareParams::default(),
            density_curves_morph: PrintCurvesMorphParams::default(),
        }
    }
}

/// User-facing controls for the s023 print density-curve morph (see
/// `crate::print_morph`). Kept in f64 — the morph is a parity-sensitive f64
/// computation. `active` defaults to `false`, matching upstream 0.3.4 — but
/// note that (also matching upstream) the print develop always evaluates the
/// profile's fitted `density_curves_model` when one is present; `active` only
/// enables the coupled-gamma morphing of that model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintCurvesMorphParams {
    #[serde(default)]
    pub active: bool,
    #[serde(default = "default_one_f64")]
    pub gamma_factor: f64,
    #[serde(default = "default_one_f64")]
    pub gamma_factor_fast: f64,
    #[serde(default = "default_one_f64")]
    pub gamma_factor_slow: f64,
    #[serde(default = "default_one_f64")]
    pub gamma_factor_red: f64,
    #[serde(default = "default_one_f64")]
    pub gamma_factor_green: f64,
    #[serde(default = "default_one_f64")]
    pub gamma_factor_blue: f64,
    #[serde(default)]
    pub developer_exhaustion: f64,
}

impl Default for PrintCurvesMorphParams {
    fn default() -> Self {
        Self {
            active: false,
            gamma_factor: 1.0,
            gamma_factor_fast: 1.0,
            gamma_factor_slow: 1.0,
            gamma_factor_red: 1.0,
            gamma_factor_green: 1.0,
            gamma_factor_blue: 1.0,
            developer_exhaustion: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IoParams {
    #[serde(default = "default_prophoto")]
    pub input_color_space: String,
    #[serde(default)]
    pub input_cctf_decoding: bool,
    #[serde(default = "default_srgb")]
    pub output_color_space: String,
    #[serde(default = "default_true")]
    pub output_cctf_encoding: bool,
    #[serde(default)]
    pub crop: bool,
    #[serde(default = "default_crop_center")]
    pub crop_center: [f32; 2],
    #[serde(default = "default_crop_size")]
    pub crop_size: [f32; 2],
    #[serde(default = "default_one")]
    pub upscale_factor: f32,
    #[serde(default)]
    pub scan_film: bool,
    #[serde(default)]
    pub output_gamut_compress: OutputGamutCompressParams,
    #[serde(default)]
    pub input_gamut_compress: InputGamutCompressParams,
}

impl Default for IoParams {
    fn default() -> Self {
        Self {
            input_color_space: "ProPhoto RGB".into(),
            input_cctf_decoding: false,
            output_color_space: "sRGB".into(),
            output_cctf_encoding: true,
            crop: false,
            crop_center: [0.5, 0.5],
            crop_size: [0.1, 0.1],
            upscale_factor: 1.0,
            scan_film: false,
            output_gamut_compress: OutputGamutCompressParams::default(),
            input_gamut_compress: InputGamutCompressParams::default(),
        }
    }
}

/// Input gamut compression config — mirrors upstream `InputGamutCompressSpec`.
/// Baked into the tc_lut at build time, so the per-pixel path stays
/// compression-agnostic. `"xy"` (the default, matching upstream 0.3.4) applies
/// the ACES-RGC-style radial compression toward the spectral locus;
/// `algorithm = "off"` passes input chromaticities through unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InputGamutCompressParams {
    #[serde(default = "default_xy")]
    pub algorithm: String,
    #[serde(default = "default_gamut_knee")]
    pub knee: [f32; 3],
}

impl Default for InputGamutCompressParams {
    fn default() -> Self {
        Self {
            algorithm: "xy".into(),
            knee: [0.0, 1.0, 6.0],
        }
    }
}

/// Output gamut compression config — mirrors upstream `OutputGamutCompressSpec`.
/// `"cam16ucs"` (the default, matching upstream 0.3.4) applies the CAM16-UCS
/// chroma knee + one-sided lightness roll-off; `"off"` passes RGB through
/// unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputGamutCompressParams {
    #[serde(default = "default_cam16ucs")]
    pub algorithm: String,
    #[serde(default = "default_gamut_knee")]
    pub knee: [f32; 3],
    #[serde(default = "default_gamut_lightness")]
    pub lightness_compression: Option<[f32; 3]>,
}

impl Default for OutputGamutCompressParams {
    fn default() -> Self {
        Self {
            algorithm: "cam16ucs".into(),
            knee: [0.0, 1.0, 6.0],
            lightness_compression: Some([0.7, 1.0, 2.2]),
        }
    }
}

fn default_xy() -> String {
    "xy".into()
}
fn default_cam16ucs() -> String {
    "cam16ucs".into()
}
fn default_gamut_knee() -> [f32; 3] {
    [0.0, 1.0, 6.0]
}
fn default_gamut_lightness() -> Option<[f32; 3]> {
    Some([0.7, 1.0, 2.2])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsParams {
    #[serde(default = "default_hanatos")]
    pub rgb_to_raw_method: String,
    #[serde(default = "default_true")]
    pub apply_hanatos2025_adaptation_window: bool,
    #[serde(default)]
    pub apply_hanatos2025_adaptation_surface: bool,
    #[serde(default)]
    pub spectral_gaussian_blur: f32,
    #[serde(default)]
    pub use_enlarger_lut: bool,
    #[serde(default)]
    pub use_scanner_lut: bool,
    #[serde(default = "default_17")]
    pub lut_resolution: u32,
    #[serde(default)]
    pub use_fast_stats: bool,
    #[serde(default = "default_640")]
    pub preview_max_size: u32,
    #[serde(default)]
    pub preview_mode: bool,
    #[serde(default = "default_true")]
    pub neutral_print_filters_from_database: bool,
    /// Use CAT16 (instead of CAT02) for the input RGB→tc chromatic adaptation
    /// that feeds the Hanatos spectral upsampling. Default true matches
    /// upstream 0.3.4 (`_rgb_to_tc_b` hard-codes CAT16); false restores the
    /// CAT02 0.3.2 behavior.
    #[serde(default = "default_true")]
    pub use_cat16: bool,
}

impl Default for SettingsParams {
    fn default() -> Self {
        Self {
            rgb_to_raw_method: "hanatos2025".into(),
            apply_hanatos2025_adaptation_window: true,
            apply_hanatos2025_adaptation_surface: false,
            spectral_gaussian_blur: 0.0,
            use_enlarger_lut: false,
            use_scanner_lut: false,
            lut_resolution: 17,
            use_fast_stats: false,
            preview_max_size: 640,
            preview_mode: false,
            neutral_print_filters_from_database: true,
            use_cat16: true,
        }
    }
}

/// Top-level runtime parameters. Combines all sub-parameter groups.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeParams {
    #[serde(default)]
    pub camera: CameraParams,
    #[serde(default)]
    pub enlarger: EnlargerParams,
    #[serde(default)]
    pub scanner: ScannerParams,
    #[serde(default)]
    pub film_render: FilmRenderingParams,
    #[serde(default)]
    pub print_render: PrintRenderingParams,
    #[serde(default)]
    pub io: IoParams,
    #[serde(default)]
    pub settings: SettingsParams,
}

impl Default for RuntimeParams {
    fn default() -> Self {
        Self {
            camera: CameraParams::default(),
            enlarger: EnlargerParams::default(),
            scanner: ScannerParams::default(),
            film_render: FilmRenderingParams::default(),
            print_render: PrintRenderingParams::default(),
            io: IoParams::default(),
            settings: SettingsParams::default(),
        }
    }
}

// Default value helpers
fn default_bpm() -> String {
    "black_pro_mist".into()
}
fn default_half() -> f32 {
    0.5
}
fn default_one() -> f32 {
    1.0
}
fn default_true() -> bool {
    true
}
fn default_center_weighted() -> String {
    "center_weighted".into()
}
fn default_35() -> f32 {
    35.0
}
fn default_filter_uv() -> [f32; 3] {
    [0.0, 410.0, 8.0]
}
fn default_filter_ir() -> [f32; 3] {
    [0.0, 675.0, 15.0]
}
fn default_th_kg3() -> String {
    "TH-KG3".into()
}
fn default_55() -> f32 {
    55.0
}
fn default_65() -> f32 {
    65.0
}
fn default_098() -> f32 {
    0.98
}
fn default_001() -> f32 {
    0.01
}
fn default_unsharp() -> [f32; 2] {
    [0.7, 0.7]
}
fn default_02() -> f32 {
    0.2
}
fn default_particle_scale() -> [f32; 3] {
    [0.8, 1.0, 2.0]
}
fn default_particle_scale_layers() -> [f32; 3] {
    [2.5, 1.0, 0.5]
}
fn default_density_min() -> [f32; 3] {
    [0.07, 0.08, 0.12]
}
fn default_uniformity() -> [f32; 3] {
    [0.97, 0.97, 0.99]
}
fn default_065() -> f32 {
    0.65
}
fn default_micro_structure() -> [f32; 2] {
    [0.2, 30.0]
}
fn default_1i() -> u32 {
    1
}
fn default_scatter_core() -> [f32; 3] {
    [2.2, 2.0, 1.6]
}
fn default_scatter_tail() -> [f32; 3] {
    [9.3, 9.7, 9.1]
}
fn default_scatter_tail_weight() -> [f32; 3] {
    [0.78, 0.65, 0.67]
}
fn default_03() -> f32 {
    0.3
}
fn default_4() -> f32 {
    4.0
}
fn default_halation_strength() -> [f32; 3] {
    [0.05, 0.015, 0.0]
}
fn default_halation_sigma() -> [f32; 3] {
    [65.0, 65.0, 65.0]
}
fn default_3i() -> u32 {
    3
}
fn default_gamma_same() -> [f32; 3] {
    [0.341, 0.324, 0.273]
}
fn default_gamma_r_gb() -> [f32; 2] {
    [0.355, 0.305]
}
fn default_gamma_g_rb() -> [f32; 2] {
    [0.154, 0.358]
}
fn default_gamma_b_rg() -> [f32; 2] {
    [0.171, 0.225]
}
fn default_20() -> f32 {
    20.0
}
fn default_200() -> f32 {
    200.0
}
fn default_006() -> f32 {
    0.06
}
fn default_003() -> f32 {
    0.03
}
fn default_07() -> f32 {
    0.7
}
fn default_prophoto() -> String {
    "ProPhoto RGB".into()
}
fn default_srgb() -> String {
    "sRGB".into()
}
fn default_crop_center() -> [f32; 2] {
    [0.5, 0.5]
}
fn default_crop_size() -> [f32; 2] {
    [0.1, 0.1]
}
fn default_hanatos() -> String {
    "hanatos2025".into()
}
fn default_17() -> u32 {
    17
}
fn default_640() -> u32 {
    640
}
