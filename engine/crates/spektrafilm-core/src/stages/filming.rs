/// Filming stage: expose the digital image onto virtual film.
///
/// Full Hanatos2025 path: RGB → XYZ → xy chromaticity → tc coordinates →
/// 2D LUT lookup (spectra × sensitivity) → per-channel film raw exposure.
use rayon::prelude::*;
use spektrafilm_gpu::ComputeBackend;
use spektrafilm_math::colorspace;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::{from_f32, from_f64, to_f32};
use spektrafilm_math::spectral::{self, TcLut};
use web_time::Instant;

use crate::params::RuntimeParams;
use crate::profile::Profile;

fn stage_timings_enabled() -> bool {
    std::env::var_os("SPEKTRAFILM_STAGE_TIMINGS").is_some()
}

fn print_stage_timing(enabled: bool, stage: &str, start: Instant) {
    if enabled {
        eprintln!("stage {stage}: {} ms", start.elapsed().as_millis());
    }
}

/// Compute pixel size in micrometers from film format and image dimensions.
/// Reference pixel pitch of the calibrated grain look: 36 mm / 2000 px.
pub const GRAIN_REF_PIXEL_UM: f64 = 18.0;

pub fn pixel_size_um(film_format_mm: f32, width: u32, height: u32) -> f32 {
    film_format_mm * 1000.0 / width.max(height) as f32
}

/// Auto-exposure compensation, Python-compatible
/// (`spektrafilm/utils/autoexposure.py`).
///
/// Python downsamples the image to ≤ 256 px on the long edge using
/// `skimage.transform.rescale(order=0)` (nearest neighbour) before
/// measuring (`small_preview`), then meters luminance Y with one of
/// several patterns. We mirror that — the downsample is what makes the
/// metered mean Python-parity-compatible; measuring on the full-res
/// image gives a different pixel set and shifts the resulting EV by
/// tenths of a stop.
///
/// `method` selects the metering pattern: `average`, `median`,
/// `center_weighted`, `partial`, `matrix`, `multi_zone`,
/// `highlight_weighted`. Anything else meters a flat 1.0 (0 EV), matching
/// the Python `else` branch.
pub fn measure_autoexposure_ev(image: &ImageBuf, rgb_to_xyz: &[[f32; 3]; 3], method: &str) -> f32 {
    const MAX_SIZE: usize = 256;
    let w = image.width as usize;
    let h = image.height as usize;
    let max_dim = w.max(h);
    // skimage.rescale(scale, order=0) with scale = MAX/max_dim:
    // output shape = round(orig * scale); each output pixel takes the
    // nearest source via iy = round((oy + 0.5) / scale - 0.5)
    // (scipy.ndimage.zoom convention).
    let (sw, sh, ix, iy) = if max_dim > MAX_SIZE {
        let scale = (MAX_SIZE as f64) / (max_dim as f64);
        let sw = ((w as f64) * scale).round() as usize;
        let sh = ((h as f64) * scale).round() as usize;
        // skimage rounds each axis independently, so the effective per-axis
        // scale is src_dim/out_dim — which differs from the global `scale` on
        // the short edge (e.g. 200/171 vs 300/256). Sample at the pixel centre
        // (skimage `warp` convention): src = round((o + 0.5)·src/out − 0.5).
        let map = |out_dim: usize, src_dim: usize| -> Vec<usize> {
            let axis_scale = src_dim as f64 / out_dim as f64;
            (0..out_dim)
                .map(|o| {
                    let f = ((o as f64 + 0.5) * axis_scale - 0.5).round() as isize;
                    f.clamp(0, src_dim as isize - 1) as usize
                })
                .collect()
        };
        (sw, sh, map(sw, w), map(sh, h))
    } else {
        let ix: Vec<usize> = (0..w).collect();
        let iy: Vec<usize> = (0..h).collect();
        (w, h, ix, iy)
    };

    // Downsampled luminance grid (row-major, sw × sh).
    let (ix, iy) = (&ix, &iy);
    let lum: Vec<f64> = (0..sh)
        .into_par_iter()
        .flat_map_iter(|y| {
            let row_off = iy[y] * w * 3;
            (0..sw).map(move |x| {
                let idx = row_off + ix[x] * 3;
                (rgb_to_xyz[1][0] * to_f32(image.data[idx])
                    + rgb_to_xyz[1][1] * to_f32(image.data[idx + 1])
                    + rgb_to_xyz[1][2] * to_f32(image.data[idx + 2])) as f64
            })
        })
        .collect();

    let metered = meter_luminance(&lum, sw, sh, method);
    let exposure = (metered / 0.184) as f32;
    if exposure <= 0.0 || exposure.is_infinite() {
        return 0.0;
    }
    let ev = -exposure.log2();
    tracing::info!(
        sw = sw,
        sh = sh,
        method = method,
        metered = metered,
        exposure_div_184 = exposure,
        ev = ev,
        "autoexposure"
    );
    ev
}

/// Normalized pixel coordinate along an axis: `(i/dim - 0.5) * (dim/maxdim)`,
/// so the long edge spans [-0.5, 0.5] (Python `_normalized_coords`).
fn norm_coord(i: usize, dim: usize, max_dim: usize) -> f64 {
    (i as f64 / dim as f64 - 0.5) * (dim as f64 / max_dim as f64)
}

/// Meter the downsampled luminance grid with the named pattern, returning the
/// mean luminance the autoexposure should map to mid-grey (0.184).
fn meter_luminance(lum: &[f64], sw: usize, sh: usize, method: &str) -> f64 {
    let max_dim = sw.max(sh);
    match method {
        "average" => lum.iter().sum::<f64>() / lum.len() as f64,

        "median" => {
            let mut sorted = lum.to_vec();
            sorted.sort_by(|a, b| a.total_cmp(b));
            let n = sorted.len();
            if n % 2 == 1 {
                sorted[n / 2]
            } else {
                0.5 * (sorted[n / 2 - 1] + sorted[n / 2])
            }
        }

        "center_weighted" => {
            let sigma = 0.2f64;
            let inv_2sigma2 = 1.0 / (2.0 * sigma * sigma);
            let mut weighted = 0.0;
            let mut total = 0.0;
            for y in 0..sh {
                let ny = norm_coord(y, sh, max_dim);
                let ny2 = ny * ny;
                for x in 0..sw {
                    let nx = norm_coord(x, sw, max_dim);
                    let w = (-(nx * nx + ny2) * inv_2sigma2).exp();
                    weighted += lum[y * sw + x] * w;
                    total += w;
                }
            }
            weighted / total
        }

        "partial" => {
            // Hard circular region, ~15% radius (Canon Partial).
            let mut sum = 0.0;
            let mut count = 0usize;
            for y in 0..sh {
                let ny = norm_coord(y, sh, max_dim);
                for x in 0..sw {
                    let nx = norm_coord(x, sw, max_dim);
                    if (nx * nx + ny * ny).sqrt() < 0.15 {
                        sum += lum[y * sw + x];
                        count += 1;
                    }
                }
            }
            if count == 0 {
                lum.iter().sum::<f64>() / lum.len() as f64
            } else {
                sum / count as f64
            }
        }

        "matrix" => {
            // 5×5 grid; each cell weighted by a raised-cosine of its distance
            // from centre so corner zones contribute less.
            let (n_rows, n_cols) = (5usize, 5usize);
            let cell_h = sh / n_rows;
            let cell_w = sw / n_cols;
            let mut means = Vec::with_capacity(n_rows * n_cols);
            let mut weights = Vec::with_capacity(n_rows * n_cols);
            for r in 0..n_rows {
                for c in 0..n_cols {
                    if cell_h == 0 || cell_w == 0 {
                        continue;
                    }
                    let mut sum = 0.0;
                    for yy in r * cell_h..(r + 1) * cell_h {
                        for xx in c * cell_w..(c + 1) * cell_w {
                            sum += lum[yy * sw + xx];
                        }
                    }
                    means.push(sum / (cell_h * cell_w) as f64);
                    let dy = (r as f64 - (n_rows - 1) as f64 / 2.0) / ((n_rows - 1) as f64 / 2.0);
                    let dx = (c as f64 - (n_cols - 1) as f64 / 2.0) / ((n_cols - 1) as f64 / 2.0);
                    let dist = (dx * dx + dy * dy).sqrt() / 2.0f64.sqrt();
                    weights.push(0.5 * (1.0 + (std::f64::consts::PI * dist).cos()));
                }
            }
            let wsum: f64 = weights.iter().sum();
            means.iter().zip(&weights).map(|(m, w)| m * w / wsum).sum()
        }

        "multi_zone" => {
            // Three concentric rings weighted 50/30/20.
            let rings = [(0.00, 0.05, 0.50), (0.05, 0.25, 0.30), (0.25, 0.50, 0.20)];
            let mut weighted_sum = 0.0;
            let mut weight_total = 0.0;
            for &(r_min, r_max, weight) in &rings {
                let mut sum = 0.0;
                let mut count = 0usize;
                for y in 0..sh {
                    let ny = norm_coord(y, sh, max_dim);
                    for x in 0..sw {
                        let nx = norm_coord(x, sw, max_dim);
                        let radius = (nx * nx + ny * ny).sqrt();
                        if radius >= r_min && radius < r_max {
                            sum += lum[y * sw + x];
                            count += 1;
                        }
                    }
                }
                if count == 0 {
                    continue;
                }
                weighted_sum += weight * (sum / count as f64);
                weight_total += weight;
            }
            if weight_total > 0.0 {
                weighted_sum / weight_total
            } else {
                lum.iter().sum::<f64>() / lum.len() as f64
            }
        }

        "highlight_weighted" => {
            // Bias toward bright pixels (weight = Y²) to protect highlights.
            let mut weighted = 0.0;
            let mut total = 0.0;
            for &y in lum {
                let w = y * y;
                weighted += y * w;
                total += w;
            }
            if total < 1e-12 {
                lum.iter().sum::<f64>() / lum.len() as f64
            } else {
                weighted / total
            }
        }

        // Python's `else` branch sets `exposure = 1.0` (already post-`/0.184`),
        // i.e. 0 EV. Returning the mid-grey target makes that division cancel.
        _ => 0.184,
    }
}

/// Per-pixel `raw = m · rgb` for the Mallett2019 path (f64 matmul, rayon-parallel).
fn apply_mallett_matrix(image: &ImageBuf, m: &[[f64; 3]; 3]) -> ImageBuf {
    let mut out = ImageBuf::new(image.width, image.height);
    out.data
        .par_chunks_exact_mut(3)
        .zip(image.data.par_chunks_exact(3))
        .for_each(|(dst, src)| {
            let rgb = [src[0] as f64, src[1] as f64, src[2] as f64];
            let v = crate::mallett::apply(m, rgb);
            dst[0] = from_f64(v[0]);
            dst[1] = from_f64(v[1]);
            dst[2] = from_f64(v[2]);
        });
    out
}

/// Expose: convert RGB to film raw exposure.
///
/// Dispatches on the configured upsampler: the Mallett2019 per-pixel matrix
/// (when `mallett_core` is set), the full Hanatos2025 spectral path (when a
/// TC LUT is provided), or a simplified RGB → log10 fallback.
#[allow(clippy::too_many_arguments)]
pub fn expose(
    image: &ImageBuf,
    _film: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
    tc_lut: Option<&TcLut>,
    mallett_core: Option<&[[f64; 3]; 3]>,
    front_illuminant: &[f32],
    bw_filming_correction: f64,
) -> ImageBuf {
    let pix_um = pixel_size_um(params.camera.film_format_mm, image.width, image.height);
    let rgb_to_xyz = input_colorspace_to_xyz(&params.io.input_color_space);

    // Auto-exposure
    let mut rgb = image.clone();
    if params.camera.auto_exposure {
        let ae_ev = measure_autoexposure_ev(&rgb, &rgb_to_xyz, &params.camera.auto_exposure_method);
        let scale = from_f32(2.0f32.powf(ae_ev));
        rgb.data.par_iter_mut().for_each(|v| *v *= scale);
    }

    // Exposure compensation
    let exp_comp = from_f32(2.0f32.powf(params.camera.exposure_compensation_ev));
    rgb.data.par_iter_mut().for_each(|v| *v *= exp_comp);

    // RGB → film raw exposure
    let mut raw = if let Some(core) = mallett_core {
        // Mallett2019: per-pixel `raw = (core · M_cs) · rgb`, a single 3×3
        // matrix folding the input-colour-space → linear-sRGB conversion.
        let m = crate::mallett::film_matrix(core, &params.io.input_color_space);
        apply_mallett_matrix(&rgb, &m)
    } else if let Some(lut) = tc_lut {
        // Full Hanatos2025 spectral upsampling with CAT16/CAT02 adaptation (settings.use_cat16).
        backend.hanatos2025_rgb_to_raw(
            &rgb,
            lut,
            &params.io.input_color_space,
            front_illuminant,
            params.settings.use_cat16,
        )
    } else {
        // Simplified fallback: treat RGB values as proportional to raw exposure
        rgb
    };

    // Order mirrors Python filming: boost → diffusion → lens_blur → halation.

    // Highlight boost: reconstruct pre-clip highlight irradiance before the
    // optical-scatter effects. No-op when boost_ev == 0.
    let hal_boost = &params.film_render.halation;
    if hal_boost.boost_ev != 0.0 {
        raw = spektrafilm_model::diffusion::boost_highlights(
            &raw,
            hal_boost.boost_ev as f64,
            hal_boost.boost_range as f64,
            hal_boost.protect_ev as f64,
        );
    }

    // Diffusion filter (camera): lens diffusion-filter PSF on linear raw.
    // GPU uses a downsampled sum-of-Gaussians (fast preview); CPU keeps the
    // exact FFT convolution (export parity).
    let df = &params.camera.diffusion_filter;
    if df.active {
        let dm = df.to_model();
        raw = if backend.is_gpu() {
            spektrafilm_model::diffusion::apply_diffusion_filter_blur(
                &raw,
                &dm,
                pix_um as f64,
                backend,
            )
        } else {
            spektrafilm_model::diffusion::apply_diffusion_filter_um(&raw, &dm, pix_um as f64)
        };
    }

    // Lens blur
    if params.camera.lens_blur_um > 0.0 {
        raw = spektrafilm_model::diffusion::apply_gaussian_blur_um(
            &raw,
            params.camera.lens_blur_um,
            pix_um,
            backend,
        );
    }

    // Halation (on linear raw)
    let halation = &params.film_render.halation;
    if halation.active {
        raw = spektrafilm_model::diffusion::apply_halation_um(
            &raw,
            pix_um,
            halation.scatter_amount,
            halation.scatter_spatial_scale,
            halation.scatter_core_um,
            halation.scatter_tail_um,
            halation.scatter_tail_weight,
            halation.halation_amount,
            halation.halation_spatial_scale,
            halation.halation_strength,
            halation.halation_first_sigma_um,
            halation.halation_n_bounces,
            halation.halation_bounce_decay,
            halation.halation_renormalize,
            halation.halation_threshold_ev,
            backend,
        );
    }

    // B&W / slide scanner exposure correction (Python applies this last,
    // before the log10). No-op at factor 1.0.
    if bw_filming_correction != 1.0 {
        let f = from_f64(bw_filming_correction);
        raw.data.par_iter_mut().for_each(|v| *v *= f);
    }

    // Convert to log10 exposure. Mirror Python's
    // `np.log10(np.fmax(raw, 0.0) + 1e-10)` exactly — adding 1e-10
    // after the floor-at-zero shifts every value by a constant in
    // log-space and is *not* the same as `log10(max(raw, 1e-10))`.
    let zero = from_f64(0.0);
    let eps = from_f64(1e-10);
    raw.data.par_iter_mut().for_each(|v| {
        *v = ((*v).max(zero) + eps).log10();
    });

    raw
}

/// Develop: log_raw → density_cmy via density curves + DIR couplers + grain.
pub fn develop(
    log_raw: &ImageBuf,
    film: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
) -> ImageBuf {
    let stage_timings = stage_timings_enabled();
    let pix_um = pixel_size_um(params.camera.film_format_mm, log_raw.width, log_raw.height);
    // f64 chain for Python parity — curves are f64 in the profile JSON.
    let log_exposure_f64 = film.log_exposure_f64();
    let density_curves_f64 = film.density_curves_f64();
    // f32 versions kept for DIR couplers (still f32 API).
    let log_exposure = &film.log_exposure_f32();
    let density_curves = &film.density_curves_f32();
    let gamma = params.film_render.density_curve_gamma;

    // Filming.develop uses NORMALIZED curves (Python `develop` subtracts nanmin).
    let norm_curves_f64 =
        spektrafilm_model::density_curves::normalize_density_curves_f64(&density_curves_f64);
    let t = Instant::now();
    let mut density_cmy =
        backend.density_curve_interp(log_raw, &log_exposure_f64, &norm_curves_f64, gamma as f64);
    print_stage_timing(stage_timings, "filming_develop.density_interp", t);

    // DIR couplers
    let dir = &params.film_render.dir_couplers;
    if dir.active {
        let t = Instant::now();
        let matrix = spektrafilm_model::couplers::compute_dir_couplers_matrix(
            dir.gamma_samelayer_rgb,
            dir.gamma_interlayer_r_to_gb,
            dir.gamma_interlayer_g_to_rb,
            dir.gamma_interlayer_b_to_rg,
            dir.inhibition_samelayer,
            dir.inhibition_interlayer,
        );
        density_cmy = spektrafilm_model::couplers::apply_density_correction(
            &density_cmy,
            log_raw,
            pix_um,
            log_exposure,
            density_curves,
            &matrix,
            dir.amount,
            dir.diffusion_size_um,
            dir.diffusion_tail_um,
            dir.diffusion_tail_weight,
            film.is_positive(),
            gamma,
            backend,
        );
        print_stage_timing(stage_timings, "filming_develop.dir_couplers", t);
    }

    // Grain
    let grain = &params.film_render.grain;
    if grain.applies() && grain.is_hash() {
        let t = Instant::now();
        let (hg, gb) = hash_grain_setup(params, film, density_cmy.width, density_cmy.height);
        // The dye-cloud blur shapes the grain only: blurring the whole density
        // softened the image itself as soon as Grana was on (the film's image
        // sharpness is the scatter stage's, before the curves). The scanner's
        // sharpening (GrainBlur) too; the fast crystals' grain gets its own blur.
        density_cmy = if gb.fast_px > 0.0 {
            let [fast, slow] = spektrafilm_model::grain_hash::apply_grain_hash_split(&density_cmy, &hg);
            let (fast, slow) = (gb.apply(backend, &fast, 1), gb.apply(backend, &slow, 0));
            let mut out = density_cmy;
            for ((o, &f), &s) in out.data.iter_mut().zip(fast.data.iter()).zip(slow.data.iter()) {
                *o += f + s;
            }
            out
        } else if gb.soft_px > 0.1 || gb.sharpen[1] > 0.0 {
            let mut dev = spektrafilm_model::grain_hash::apply_grain_hash(&density_cmy, &hg);
            for (g, &d) in dev.data.iter_mut().zip(density_cmy.data.iter()) {
                *g -= d;
            }
            let dev = gb.apply(backend, &dev, 0);
            let mut out = density_cmy;
            for (o, &g) in out.data.iter_mut().zip(dev.data.iter()) {
                *o += g;
            }
            out
        } else {
            spektrafilm_model::grain_hash::apply_grain_hash(&density_cmy, &hg)
        };
        print_stage_timing(stage_timings, "filming_develop.grain_hash", t);
    } else if grain.active && !grain.is_hash() {
        let t = Instant::now();
        // Use f64 throughout — Python reads these from JSON as f64; the
        // f32 storage in `GrainParams` would otherwise truncate to ~7
        // decimals and shift every Poisson lambda by ~5e-8, producing a
        // visibly different grain pattern.
        let density_max = film.grain_density_max();
        density_cmy = spektrafilm_model::grain::apply_grain_to_density(
            &density_cmy,
            pix_um,
            grain.agx_particle_area_um2,
            grain.agx_particle_scale,
            grain.density_min,
            density_max,
            grain.uniformity,
            grain.blur,
            grain.n_sub_layers,
            grain.monochrome,
            backend,
        );
        print_stage_timing(stage_timings, "filming_develop.grain", t);
    }

    density_cmy
}

/// Pixel pitch (um on the film) at which GrainParams `scan_noise` is the per-pixel sigma; at other pitches it is averaged
/// over the pixel's area (sigma x REF / pitch), so the preview and the export show the same noise at the same size.
pub const SCAN_NOISE_REF_UM: f64 = 10.0;

/// Inputs of the counter-based grain for an `image_w x image_h` region, plus
/// its blurs (`GrainBlur`). The pixel pitch comes from
/// `frame_px` (the whole frame) when given, so tiles/previews/exports share it.
/// Shared by the CPU stage and the GPU-resident chain.
pub fn hash_grain_setup(
    params: &RuntimeParams,
    film: &Profile,
    image_w: u32,
    image_h: u32,
) -> (spektrafilm_model::grain_hash::HashGrain, GrainBlur) {
    let g = &params.film_render.grain;
    let (fw, fh) = if g.frame_px[0] >= 1.0 && g.frame_px[1] >= 1.0 {
        (g.frame_px[0] as u32, g.frame_px[1] as u32)
    } else {
        (image_w, image_h)
    };
    let pix_um = pixel_size_um(params.camera.film_format_mm, fw, fh) as f64;
    let n_sub = g.n_sub_layers.max(1);
    let dmax_curves = film.grain_density_max();
    let mut hg = spektrafilm_model::grain_hash::HashGrain {
        seed: g.seed,
        origin: [g.origin_px[0].max(0.0).round() as u32, g.origin_px[1].max(0.0).round() as u32],
        n_sub_layers: n_sub,
        monochrome: g.monochrome,
        density_min: [0.0; 3],
        density_max: [0.0; 3],
        n_particles: [0.0; 3],
        uniformity: [0.0; 3],
        micro_sigma: g.micro_structure[0].max(0.0),
        amount: g.amount as f32,
        fast_count_frac: g.fast_count_frac,
        fast_k: g.fast_k.max(1.0),
        // the fast share carries at most 1 / k of the density (p_slow stays a fraction at full development)
        fast_od_share: g.fast_od_share.clamp(0.0, 0.999 / g.fast_k.max(1.0)),
        grain_gain_dense: g.grain_gain_dense.max(0.0),
        grain_gain_from: g.grain_gain_from.clamp(0.0, 0.99),
        grain_gain_to: g.grain_gain_to.clamp(g.grain_gain_from.clamp(0.0, 0.99) + 0.01, 1.0),
        // per pixel: the sigma over SCAN_NOISE_REF_UM pixels, averaged over this pixel's area (1 / pitch)
        scan_noise: (g.scan_noise as f64 * SCAN_NOISE_REF_UM / pix_um) as f32,
        scan_noise_slope: g.scan_noise_slope,
        scan_noise_chroma: g.scan_noise_chroma,
    };
    for c in 0..3 {
        let area = g.agx_particle_area_um2 * g.agx_particle_scale[c];
        hg.n_particles[c] = ((pix_um * pix_um / area) / n_sub as f64) as f32;
        hg.density_min[c] = g.density_min[c] as f32;
        hg.density_max[c] = (dmax_curves[c] + g.density_min[c]) as f32;
        hg.uniformity[c] = g.uniformity[c] as f32;
    }
    // `blur` is calibrated in px of the reference preview (2000 px across a
    // 36 mm frame = 18 um/px); convert it to um on the film so the blur (and
    // hence the grain look at a given display size) does not depend on the
    // render resolution.
    let blur_um = g.blur as f64 * GRAIN_REF_PIXEL_UM;
    let blur_um = (blur_um * blur_um + (g.blur_dye_clouds_um as f64).powi(2)).sqrt();
    let blur_px = blur_um / pix_um;
    // Each pixel's counts integrate the film over the pixel's own area, so the
    // grain the pixel grid should show is (white noise * gaussian) box-averaged
    // per pixel. A sampled gaussian of the same sigma smooths that much less
    // when sigma is under ~1 px (sigma 0.45 px: grain std x1.19 too high, the
    // preview looked ~30 % grainier than the export seen at the same size), so
    // the kernel sigma is the one whose noise-variance gain matches the
    // pixel-integrated one. Converges to blur_px above ~1.5 px (export sizes).
    // (Replaces the earlier s^0.47 fit for pixels coarser than 18 um, same effect.)
    let soft_px = if g.blur > 0.0 { discrete_matched_sigma(blur_px) } else { blur_px };
    let fast_px = |m: f64| {
        if g.blur_fast > 0.0 && n_sub >= 2 {
            let um = (g.blur_fast as f64 * GRAIN_REF_PIXEL_UM).hypot(g.blur_dye_clouds_um as f64);
            discrete_matched_sigma(um * m / pix_um)
        } else {
            0.0
        }
    };
    let r_px = (g.scan_sharpen_um as f64 / pix_um) as f32;
    let sharpen = if g.scan_sharpen > 0.0 && r_px > 0.0 { [r_px, g.scan_sharpen] } else { [0.0, 0.0] };
    // one emulsion for B&W: its single noise field gets one blur
    let layer_blur = if g.monochrome { [1.0; 3] } else { g.layer_blur_fast };
    let (fast, fast_gain) = layer_blurs(fast_px, layer_blur, sharpen);
    let soft = soft_px as f32;
    let gb = GrainBlur {
        soft_px: soft,
        fast_px: fast_px(1.0) as f32,
        layer_px: [[soft; 3], fast],
        layer_gain: [[1.0; 3], fast_gain],
        sharpen,
    };
    (hg, gb)
}

/// Per-layer sigmas (`sigma_px(multiplier)`, the population's px sigma) and amplitude gains of one grain population for
/// the per-layer multipliers `mult` (GrainParams `layer_blur_fast`; the slow population keeps one blur). A wider kernel
/// alone lowers a layer's grain std (white noise: variance gain ~ 1 / sigma^2), so each layer's blurred deviation is
/// scaled by sqrt(V(base) / V(layer)), V = the white-noise variance gain of the whole sampled kernel (scanner sharpening
/// included): the same std as with multiplier 1, the grain only coarser or finer. Multiplier 1 gives exactly the base
/// sigma and gain 1.0 (ratio of equal numbers).
fn layer_blurs(sigma_px: impl Fn(f64) -> f64, mult: [f32; 3], sharpen: [f32; 2]) -> ([f32; 3], [f32; 3]) {
    let base = sigma_px(1.0);
    let (mut px, mut gain) = ([0.0f32; 3], [1.0f32; 3]);
    for c in 0..3 {
        let s = sigma_px(mult[c] as f64);
        px[c] = s as f32;
        if s > 0.0 && base > 0.0 {
            gain[c] = (kernel_variance_gain(base, sharpen) / kernel_variance_gain(s, sharpen)).sqrt() as f32;
        }
    }
    (px, gain)
}

/// White-noise variance gain (2D) of `(1 + a) G(s) - a G(sqrt(s^2 + r^2))` with the backends' sampled kernels
/// (`[r, a]` = GrainBlur `sharpen`, a = 0: G(s) alone): the kernels are separable, so each product sums to a 1D sum squared.
/// Exact for the GPU's kernels (wgpu_backend `grain_blur_job`); the CPU blurs sigma >= 3 with an IIR instead, whose gain
/// differs (a layer at sigma 2.8 px, sharpened sigma 3.1: std +10 %, unverified beyond that test case), so V4_GRAIN's
/// multiplier keeps the CPU eval's kernels under 3 px at the 12 MP pitch.
fn kernel_variance_gain(s: f64, sharpen: [f32; 2]) -> f64 {
    let [r, a] = [sharpen[0] as f64, sharpen[1] as f64];
    let w = s.hypot(r);
    let (k1, k2) = (1.0 + a, a);
    let (ss, ww, sw) = (sampled_cross(s, s), sampled_cross(w, w), sampled_cross(s, w));
    k1 * k1 * ss * ss + k2 * k2 * ww * ww - 2.0 * k1 * k2 * sw * sw
}

/// The hash grain's blurs in px of the region: the dye clouds (`soft_px`; `fast_px` > 0: the fast crystals' own, their
/// deviation blurred apart) and the scanner sharpening `[radius_px, amount]` on each (amount 0 = off). `layer_px` /
/// `layer_gain` (`[soft, fast]`, per channel): the per-layer sigmas and amplitude gains (`layer_blurs`; GrainParams
/// `layer_blur_fast` moves the fast ones only); with [1, 1, 1] every channel has `soft_px` / `fast_px` and gain 1.
#[derive(Debug, Clone, Copy)]
pub struct GrainBlur {
    pub soft_px: f32,
    pub fast_px: f32,
    pub layer_px: [[f32; 3]; 2],
    pub layer_gain: [[f32; 3]; 2],
    pub sharpen: [f32; 2],
}

impl GrainBlur {
    /// Population `pop` (0 soft, 1 fast) of `dev`: per channel `gain (1 + a) G(s) - a G(sqrt(s^2 + r^2))` (just G(s) when
    /// the sharpening is off) with that channel's `layer_px` / `layer_gain`.
    pub fn apply(&self, backend: &dyn spektrafilm_gpu::ComputeBackend, dev: &ImageBuf, pop: usize) -> ImageBuf {
        let (px, gain) = (self.layer_px[pop], self.layer_gain[pop]);
        if px[1] == px[0] && px[2] == px[0] && gain == [1.0; 3] {
            return self.apply_one(backend, dev, px[0]);
        }
        // one blur per layer (CPU path: eval and tests), each channel taken from its own
        let blurred: Vec<ImageBuf> = (0..3).map(|c| self.apply_one(backend, dev, px[c])).collect();
        let mut out = ImageBuf::new(dev.width, dev.height);
        for c in 0..3 {
            let k = from_f32(gain[c]);
            let ch: Vec<_> = blurred[c].extract_channel(c).into_iter().map(|v| k * v).collect();
            out.write_channel(c, &ch);
        }
        out
    }

    fn apply_one(&self, backend: &dyn spektrafilm_gpu::ComputeBackend, dev: &ImageBuf, s: f32) -> ImageBuf {
        let soft = backend.gaussian_blur(dev, s);
        let [r, a] = self.sharpen;
        if a <= 0.0 {
            return soft;
        }
        let wide = backend.gaussian_blur(dev, s.hypot(r));
        let (k1, k2) = (from_f32(1.0 + a), from_f32(a));
        let mut out = soft;
        for (o, &w) in out.data.iter_mut().zip(wide.data.iter()) {
            *o = k1 * *o - k2 * w;
        }
        out
    }
}

/// Variance gain (per axis) of a pixel-box-integrated white noise blurred by a
/// continuous gaussian of `s` px: the box autocorrelation (triangle) weighted
/// by the gaussian autocorrelation (sigma s*sqrt 2).
fn pixel_integrated_gain(s: f64) -> f64 {
    libm::erf(0.5 / s) - 2.0 * s / std::f64::consts::PI.sqrt() * (1.0 - (-0.25 / (s * s)).exp())
}

/// Variance gain (per axis) of white noise through the normalised sampled
/// gaussian the backends build (radius ceil(3 sigma)).
fn sampled_gain(s: f64) -> f64 {
    sampled_cross(s, s)
}

/// The normalised sampled gaussian of the backends (radius ceil(3 sigma)), indexed from -radius.
fn sampled_kernel(s: f64) -> (i32, Vec<f64>) {
    let r = (3.0 * s).ceil().max(1.0) as i32;
    let w: Vec<f64> = (-r..=r).map(|k| (-(k * k) as f64 / (2.0 * s * s)).exp()).collect();
    let sum: f64 = w.iter().sum();
    (r, w.into_iter().map(|v| v / sum).collect())
}

/// Sum over k of the sampled kernels of `s1` and `s2` multiplied tap by tap (1D white-noise covariance of the two blurs).
fn sampled_cross(s1: f64, s2: f64) -> f64 {
    let ((r1, w1), (r2, w2)) = (sampled_kernel(s1), sampled_kernel(s2));
    (-r1.min(r2)..=r1.min(r2)).map(|k| w1[(k + r1) as usize] * w2[(k + r2) as usize]).sum()
}

/// Sampled-kernel sigma with the same noise-variance gain as the
/// pixel-integrated continuous blur of `s` px (bisection; gain falls with sigma).
fn discrete_matched_sigma(s: f64) -> f64 {
    let target = pixel_integrated_gain(s.max(1e-3));
    let (mut lo, mut hi) = (0.01_f64, s.max(0.01) + 2.0);
    for _ in 0..50 {
        let m = 0.5 * (lo + hi);
        if sampled_gain(m) > target { lo = m } else { hi = m }
    }
    0.5 * (lo + hi)
}

/// Full filming stage: expose + develop.
pub fn process(
    image: &ImageBuf,
    film: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
    tc_lut: Option<&TcLut>,
) -> ImageBuf {
    let ref_illuminant = select_illuminant(&film.info.reference_illuminant);
    let log_raw = expose(image, film, params, backend, tc_lut, None, ref_illuminant, 1.0);
    develop(&log_raw, film, params, backend)
}

pub fn input_colorspace_to_xyz(name: &str) -> [[f32; 3]; 3] {
    match name {
        "sRGB" => colorspace::SRGB_TO_XYZ,
        "ProPhoto RGB" => colorspace::PROPHOTO_TO_XYZ,
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::REC2020_TO_XYZ,
        "ACES2065-1" => colorspace::ACES_TO_XYZ,
        _ => colorspace::PROPHOTO_TO_XYZ,
    }
}

pub(crate) fn select_illuminant(name: &str) -> &'static [f32] {
    match name {
        "D50" => &spectral::ILLUMINANT_D50,
        "D55" => &spectral::ILLUMINANT_D55,
        "D65" => &spectral::ILLUMINANT_D65,
        _ => &spectral::ILLUMINANT_D55,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spektrafilm_math::precision::from_f64;

    fn halate(img: &ImageBuf, amount: f64, thr_ev: f32) -> ImageBuf {
        let backend = spektrafilm_gpu::cpu_backend::CpuBackend;
        spektrafilm_model::diffusion::apply_halation_um(
            img, 10.0, 0.0, 1.0, [2.2; 3], [9.3; 3], [0.7; 3], amount, 1.0,
            [0.05, 0.015, 0.0], [65.0; 3], 3, 0.5, false, thr_ev, &backend,
        )
    }

    fn flat(v: f64) -> ImageBuf {
        let (w, h) = (64u32, 64u32);
        ImageBuf {
            width: w,
            height: h,
            data: vec![from_f64(v); (w * h * 3) as usize],
        }
    }

    /// GrainParams `layer_blur_fast`: [1, 1, 1] is exactly the one blur (sigma and gain bit-equal), and a coarser layer
    /// keeps its grain std (white noise through the gained kernel, scanner sharpening on) while the blur gets wider.
    #[test]
    fn layer_blurs_identity_and_std_kept() {
        let sigma = |m: f64| discrete_matched_sigma(0.71 * m); // the app's fast sigma at the 12 MP export pitch
        let sharpen = [1.34, 0.85]; // 12 um at 8.95 um/px, amount 0.85 (V4_GRAIN)
        let (px, gain) = layer_blurs(sigma, [1.0; 3], sharpen);
        assert_eq!(px, [sigma(1.0) as f32; 3]);
        assert_eq!(gain, [1.0; 3]);
        let (px, gain) = layer_blurs(sigma, [0.9, 1.0, 3.5], sharpen);
        assert!(px[2] > 2.0 * px[1] && gain[2] > 1.0 && gain[1] == 1.0);
        let (w, h) = (256u32, 256u32);
        let mut st = 12345u32;
        let noise: Vec<_> = (0..w * h * 3)
            .map(|_| {
                st = spektrafilm_model::grain_hash::pcg(st);
                from_f32(spektrafilm_model::grain_hash::unit_open(st) - 0.5)
            })
            .collect();
        let dev = ImageBuf::from_data(w, h, noise);
        let gb = GrainBlur { soft_px: 0.0, fast_px: px[1], layer_px: [[0.0; 3], px], layer_gain: [[1.0; 3], gain], sharpen };
        let out = gb.apply(&spektrafilm_gpu::cpu_backend::CpuBackend, &dev, 1);
        let std = |c: usize| {
            let v: Vec<f64> = out.extract_channel(c).iter().map(|&x| x as f64).collect();
            let n = v.len() as f64;
            let m = v.iter().sum::<f64>() / n;
            (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / n).sqrt()
        };
        for c in [0, 2] {
            assert!((std(c) / std(1) - 1.0).abs() < 0.04, "layer {c} std {} vs {}", std(c), std(1));
        }
    }

    /// GrainParams `layer_blur_fast` in the GPU-resident chain (per-layer grain blur jobs) matches the CPU stage, scanner
    /// sharpening on, at the app's values ([1, 1, 3.5], web/app.js V4_GRAIN). Same budget as the other resident-chain parity
    /// tests (f32 shaders); the grain draws are the same hash on both, so a wrong per-layer sigma or gain shows as a
    /// grain-sized difference. The frame is 1.5 mm wide (64 px at ~23 um, the app's preview scale): on a 35 mm frame a pixel
    /// is ~0.5 mm, the dye clouds vanish under it and the test passed whatever the per-layer blur (4.43: same error with and
    /// without it). It also checks that the GPU error is small next to what the per-layer blur changes.
    /// Halation is off: at this scale its in-emulsion scatter (core ~2 um, tail ~9 um: under a pixel) differs between the
    /// backends on pixel-sharp edges (GPU: one Gaussian per pass at the channels' mean sigma; CPU: per channel, the tail an
    /// exponential), mean 0.044 on this pixel-to-pixel pattern; with it off the error is ~0.0002 (4.43, SwiftShader Vulkan).
    /// Skips without a GPU adapter. Runs only with the wgpu backend compiled in and the profiles at engine/data:
    /// `cargo test -p spektrafilm-core --features spektrafilm-gpu/wgpu-backend`.
    #[test]
    fn layer_blur_fast_gpu_resident_matches_cpu() {
        let Some(gpu) = spektrafilm_gpu::wgpu_backend::WgpuBackend::new() else {
            eprintln!("no GPU adapter available; skipping");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("data");
        let pipeline = |layer_blur_fast: [f32; 3]| {
            let film = crate::profile::load_profile_by_name(&dir, "kodak_gold_200").unwrap();
            let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();
            let mut params = RuntimeParams::default();
            params.camera.auto_exposure = false;
            params.camera.film_format_mm = 1.5;
            params.film_render.halation.active = false;
            params.io.output_gamut_compress.algorithm = "off".into(); // keeps the resident chain
            let g = &mut params.film_render.grain;
            (g.blur, g.blur_fast, g.fast_count_frac, g.amount) = (0.2, 0.35, 0.02, 4.0);
            (g.scan_sharpen_um, g.scan_sharpen) = (12.0, 0.85);
            g.layer_blur_fast = layer_blur_fast;
            crate::pipeline::Pipeline::new_with_spectral(film, print, params, &dir).unwrap()
        };
        let (w, h) = (64u32, 64u32);
        let data: Vec<_> = (0..w * h * 3).map(|i| from_f64(0.1 + 0.3 * ((i / 3) % 7) as f64 / 7.0)).collect();
        let img = ImageBuf::from_data(w, h, data);
        let diff = |a: &ImageBuf, b: &ImageBuf| {
            let d: Vec<f64> = a.data.iter().zip(b.data.iter()).map(|(x, y)| (*x as f64 - *y as f64).abs()).collect();
            (d.iter().sum::<f64>() / d.len() as f64, d.iter().cloned().fold(0.0, f64::max))
        };
        let app = pipeline([1.0, 1.0, 3.5]);
        let out_cpu = app.process(img.clone(), &spektrafilm_gpu::cpu_backend::CpuBackend);
        let out_gpu = app.process(img.clone(), &gpu);
        let plain = pipeline([1.0; 3]).process(img, &spektrafilm_gpu::cpu_backend::CpuBackend);
        let (mean, max) = diff(&out_gpu, &out_cpu);
        let (effect, _) = diff(&out_cpu, &plain);
        eprintln!("GPU vs CPU: mean {mean}, max {max}; layer blur effect (CPU, mean) {effect}");
        assert!(effect > 4.0 * mean, "the GPU error is not small next to the per-layer blur: {mean} vs {effect}");
        assert!(mean < 5e-3 && max < 5e-2, "GPU vs CPU: mean {mean}, max {max}");
    }

    /// GrainParams `fast_k` / `fast_od_share` / `grain_gain_dense` (4.47; the fast crystals' split by density, fixed constants
    /// until then, and the slow grain's gain in the dense part) reach the
    /// GPU-resident chain as on the CPU stage: non-default values, same budget and frame as the test above, halation off. Also
    /// checks they move the frame (a field the GPU ignored would pass the parity at the defaults).
    #[test]
    fn fast_split_gpu_resident_matches_cpu() {
        let Some(gpu) = spektrafilm_gpu::wgpu_backend::WgpuBackend::new() else {
            eprintln!("no GPU adapter available; skipping");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("data");
        let pipeline = |fast_k: f32, fast_od_share: f32, grain_gain_dense: f32| {
            let film = crate::profile::load_profile_by_name(&dir, "kodak_gold_200").unwrap();
            let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();
            let mut params = RuntimeParams::default();
            params.camera.auto_exposure = false;
            params.camera.film_format_mm = 1.5;
            params.film_render.halation.active = false;
            params.io.output_gamut_compress.algorithm = "off".into();
            let g = &mut params.film_render.grain;
            (g.blur, g.blur_fast, g.fast_count_frac, g.amount) = (0.2, 1.2, 0.0023, 4.5);
            (g.fast_k, g.fast_od_share, g.grain_gain_dense) = (fast_k, fast_od_share, grain_gain_dense);
            crate::pipeline::Pipeline::new_with_spectral(film, print, params, &dir).unwrap()
        };
        let (w, h) = (64u32, 64u32);
        let data: Vec<_> = (0..w * h * 3).map(|i| from_f64(0.05 + 0.6 * ((i / 3) % 9) as f64 / 9.0)).collect();
        let img = ImageBuf::from_data(w, h, data);
        let diff = |a: &ImageBuf, b: &ImageBuf| {
            let d: Vec<f64> = a.data.iter().zip(b.data.iter()).map(|(x, y)| (*x as f64 - *y as f64).abs()).collect();
            (d.iter().sum::<f64>() / d.len() as f64, d.iter().cloned().fold(0.0, f64::max))
        };
        let p = pipeline(1.8, 0.45, 0.6);
        let out_cpu = p.process(img.clone(), &spektrafilm_gpu::cpu_backend::CpuBackend);
        let out_gpu = p.process(img.clone(), &gpu);
        let plain = pipeline(spektrafilm_model::grain_hash::FAST_K, spektrafilm_model::grain_hash::FAST_OD_SHARE, 1.0)
            .process(img, &spektrafilm_gpu::cpu_backend::CpuBackend);
        let (mean, max) = diff(&out_gpu, &out_cpu);
        let (effect, _) = diff(&out_cpu, &plain);
        eprintln!("GPU vs CPU: mean {mean}, max {max}; fast split effect (CPU, mean) {effect}");
        assert!(effect > 4.0 * mean, "the GPU error is not small next to the fast split's effect: {mean} vs {effect}");
        assert!(mean < 5e-3 && max < 5e-2, "GPU vs CPU: mean {mean}, max {max}");
    }

    #[test]
    fn halation_threshold_mid_grey_none_and_spot_rings() {
        // Uniform mid grey: below threshold -> no halation at all.
        let grey = flat(0.18);
        let out = halate(&grey, 1.0, 2.5);
        assert_eq!(out.data, grey.data);

        // +5 EV spot on black: red halo ring appears outside the spot.
        let mut img = flat(0.0);
        let spot = 0.18 * 32.0;
        for y in 30..34 {
            for x in 30..34 {
                img.set(x, y, [from_f64(spot); 3]);
            }
        }
        let out = halate(&img, 1.0, 2.5);
        assert!(out.get(24, 32)[0] > from_f64(1e-6), "no ring");
        // amount 0 == untouched.
        assert_eq!(halate(&img, 0.0, 2.5).data, img.data);
    }

    /// Deterministic synthetic image, mirrored bit-for-bit in the Python
    /// reference: a 300×200 gradient where each channel is
    /// `((x*7 + y*13 + c*29) % 100) / 100`.
    fn synthetic_image() -> ImageBuf {
        let (w, h) = (300usize, 200usize);
        let mut data = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    let v = ((x * 7 + y * 13 + c * 29) % 100) as f64 / 100.0;
                    data.push(from_f64(v));
                }
            }
        }
        ImageBuf {
            width: w as u32,
            height: h as u32,
            data,
        }
    }

    /// Every metering pattern matches the upstream `measure_autoexposure_ev`
    /// (`spektrafilm/utils/autoexposure.py`) on the synthetic image, with the
    /// sRGB RGB→XYZ matrix and `apply_cctf_decoding=False`. The reference is
    /// metered on the ≤256 px `small_preview` downsample — the faithful
    /// pipeline order (downsample, then meter), which makes our nearest-edge
    /// mapping bit-exact with `skimage.transform.rescale(order=0)`.
    #[test]
    fn autoexposure_methods_match_python_reference() {
        let img = synthetic_image();
        let rgb_to_xyz = input_colorspace_to_xyz("sRGB");
        let cases = [
            ("average", -1.427705567203),
            ("median", -1.308011314552),
            ("center_weighted", -1.427664142652),
            ("partial", -1.425832251352),
            ("matrix", -1.427803049578),
            ("multi_zone", -1.439398829551),
            ("highlight_weighted", -1.783882472180),
        ];
        for (method, expected) in cases {
            let ev = measure_autoexposure_ev(&img, &rgb_to_xyz, method);
            assert!(
                (ev as f64 - expected).abs() < 1e-5,
                "method {method}: got {ev}, expected {expected}",
            );
        }
    }

    /// An unknown method name meters a flat 1.0 → 0 EV, matching the Python
    /// `else` branch (`exposure = 1.0`).
    #[test]
    fn autoexposure_unknown_method_is_zero_ev() {
        let img = synthetic_image();
        let rgb_to_xyz = input_colorspace_to_xyz("sRGB");
        let ev = measure_autoexposure_ev(&img, &rgb_to_xyz, "bogus");
        assert_eq!(ev, 0.0);
    }
}
