//! Grain statistics of a uniform patch (eval/GRAIN.md, Acceptance) and the `sf-eval grain` driver.
use serde::Serialize;
use serde_json::{Value, json};
use spektrafilm_math::image::ImageBuf;

use crate::color::{self, Rgb};
use crate::render::{self, Renderer};

pub const EVS: [f64; 7] = [-3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0];
/// Longest autocorrelation lag searched (px); FWHM is reported as this cap if the curve never drops below 0.5.
const MAX_LAG: usize = 64;

#[derive(Serialize, Debug, Clone)]
pub struct PatchStats {
    pub ev: f64,
    pub mean_l: f64,
    pub luma_std: f64,
    /// sqrt(var a* + var b*)
    pub chroma_std: f64,
    pub chroma_luma_ratio: f64,
    /// Pearson correlation of (pixel - patch mean) between R-G, R-B, G-B (output-encoded values).
    pub corr_rg: f64,
    pub corr_rb: f64,
    pub corr_gb: f64,
    pub luma_skew: f64,
    /// Plain (non-excess) kurtosis: 3 for a Gaussian.
    pub luma_kurtosis: f64,
    /// Autocorrelation FWHM in px for R, G, B (mean of the x and y direction).
    pub fwhm_px: [f64; 3],
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

fn var(v: &[f64]) -> f64 {
    let m = mean(v);
    v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64
}

/// Skewness and (non-excess) kurtosis; (0, 0) for a constant signal.
pub fn skew_kurtosis(v: &[f64]) -> (f64, f64) {
    let m = mean(v);
    let n = v.len() as f64;
    let (m2, m3, m4) = v.iter().fold((0.0, 0.0, 0.0), |(a, b, c), x| {
        let d = x - m;
        (a + d * d, b + d * d * d, c + d * d * d * d)
    });
    let (m2, m3, m4) = (m2 / n, m3 / n, m4 / n);
    if m2 <= 0.0 { (0.0, 0.0) } else { (m3 / m2.powf(1.5), m4 / (m2 * m2)) }
}

/// Pearson correlation of two equally long signals (deviations from their own means).
pub fn correlation(a: &[f64], b: &[f64]) -> f64 {
    let (ma, mb) = (mean(a), mean(b));
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let (dx, dy) = (x - ma, y - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 { 0.0 } else { sab / (saa * sbb).sqrt() }
}

/// Normalised autocorrelation of a w x h plane at lags 0..=max_lag along x (`horizontal`) or y.
fn autocorr(plane: &[f64], w: usize, h: usize, horizontal: bool, max_lag: usize) -> Vec<f64> {
    let m = mean(plane);
    let v0 = var(plane);
    let mut out = vec![1.0];
    for lag in 1..=max_lag {
        let (mut s, mut n) = (0.0, 0usize);
        let (lx, ly) = if horizontal { (lag, 0) } else { (0, lag) };
        if lx >= w || ly >= h {
            out.push(0.0);
            continue;
        }
        for y in 0..h - ly {
            for x in 0..w - lx {
                s += (plane[y * w + x] - m) * (plane[(y + ly) * w + x + lx] - m);
                n += 1;
            }
        }
        out.push(if v0 > 0.0 { s / n as f64 / v0 } else { 0.0 });
    }
    out
}

/// Full width at half maximum of a symmetric autocorrelation: 2 x the lag where it falls to 0.5
/// (linear interpolation). White noise gives 1 px.
pub fn fwhm_from_autocorr(ac: &[f64]) -> f64 {
    for k in 1..ac.len() {
        if ac[k] <= 0.5 {
            let t = (ac[k - 1] - 0.5) / (ac[k - 1] - ac[k]);
            return 2.0 * ((k - 1) as f64 + t);
        }
    }
    2.0 * (ac.len() - 1) as f64
}

pub fn fwhm_px(plane: &[f64], w: usize, h: usize) -> f64 {
    let max_lag = MAX_LAG.min(w.min(h) / 2);
    let fx = fwhm_from_autocorr(&autocorr(plane, w, h, true, max_lag));
    let fy = fwhm_from_autocorr(&autocorr(plane, w, h, false, max_lag));
    0.5 * (fx + fy)
}

/// Statistics of an sRGB/BT.2020-encoded patch (`space` = its primaries).
pub fn patch_stats(img: &ImageBuf, ev: f64, space: &Rgb) -> PatchStats {
    let (w, h) = (img.width as usize, img.height as usize);
    let n = w * h;
    let mut ch = [Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n)];
    let (mut l, mut a, mut b) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for p in img.pixels() {
        let rgb = [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])];
        for c in 0..3 {
            ch[c].push(rgb[c]);
        }
        let lab = color::linear_to_lab_d50(rgb.map(color::srgb_decode), space);
        l.push(lab[0]);
        a.push(lab[1]);
        b.push(lab[2]);
    }
    let luma_std = var(&l).sqrt();
    let chroma_std = (var(&a) + var(&b)).sqrt();
    let (skew, kurt) = skew_kurtosis(&l);
    PatchStats {
        ev,
        mean_l: mean(&l),
        luma_std,
        chroma_std,
        chroma_luma_ratio: if luma_std > 0.0 { chroma_std / luma_std } else { 0.0 },
        corr_rg: correlation(&ch[0], &ch[1]),
        corr_rb: correlation(&ch[0], &ch[2]),
        corr_gb: correlation(&ch[1], &ch[2]),
        luma_skew: skew,
        luma_kurtosis: kurt,
        fwhm_px: [fwhm_px(&ch[0], w, h), fwhm_px(&ch[1], w, h), fwhm_px(&ch[2], w, h)],
    }
}

/// Params for a patch of `size` px at `ppm` px/mm: the engine derives the pixel pitch from
/// film_format_mm / max(w, h), so film_format_mm = size / ppm gives exactly 1000/ppm um per px
/// (the same pitch as a full 36 mm-wide frame rendered at that ppm). Everything else passes through.
pub fn patch_overrides(mut overrides: Value, size: u32, ppm: f64) -> Value {
    let cam = &mut overrides["camera"];
    if !cam.is_object() {
        *cam = json!({});
    }
    cam["film_format_mm"] = json!(f64::from(size) / ppm);
    overrides
}

pub fn flat_patch(size: u32, ev: f64) -> ImageBuf {
    let s = crate::chart::grey_scene(ev);
    let data = (0..size * size).flat_map(|_| s.map(|v| v as f32)).collect();
    ImageBuf::from_data(size, size, data)
}

pub fn run(overrides: Value, data_dir: &std::path::Path, size: u32, ppm: f64) -> Result<Vec<PatchStats>, String> {
    let renderer = render::build(patch_overrides(overrides, size, ppm), data_dir)?;
    let space = Rgb::srgb();
    Ok(EVS.iter().map(|&ev| patch_stats(&renderer.render(flat_patch(size, ev)), ev, &space)).collect())
}

pub fn table(stats: &[PatchStats]) -> String {
    let mut s = String::from("  ev  meanL  lumaStd chrStd  c/l   rRG    rRB    rGB    skew   kurt   fwhmR fwhmG fwhmB\n");
    for p in stats {
        s += &format!(
            "{:+4.0} {:6.2} {:7.3} {:6.3} {:5.2} {:+6.2} {:+6.2} {:+6.2} {:+6.2} {:6.2} {:5.2} {:5.2} {:5.2}\n",
            p.ev, p.mean_l, p.luma_std, p.chroma_std, p.chroma_luma_ratio, p.corr_rg, p.corr_rb, p.corr_gb,
            p.luma_skew, p.luma_kurtosis, p.fwhm_px[0], p.fwhm_px[1], p.fwhm_px[2]
        );
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic uniform noise in [0,1) (splitmix64).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    fn noise_plane(n: usize, seed: u64) -> Vec<f64> {
        let mut r = Rng(seed);
        (0..n).map(|_| r.next()).collect()
    }

    #[test]
    fn uniform_white_noise_moments() {
        let v = noise_plane(256 * 256, 1);
        let (skew, kurt) = skew_kurtosis(&v);
        assert!(skew.abs() < 0.03, "skew {skew}"); // uniform: 0
        assert!((kurt - 1.8).abs() < 0.03, "kurtosis {kurt}"); // uniform: 9/5
        assert!((var(&v) - 1.0 / 12.0).abs() < 0.002);
    }

    #[test]
    fn white_noise_autocorr_and_correlation() {
        let (w, h) = (256, 256);
        let a = noise_plane(w * h, 2);
        let b = noise_plane(w * h, 3);
        assert!(correlation(&a, &b).abs() < 0.02);
        assert!((correlation(&a, &a) - 1.0).abs() < 1e-12);
        let f = fwhm_px(&a, w, h);
        assert!((f - 1.0).abs() < 0.05, "white-noise FWHM {f}"); // ac(1)=0 -> half point at 0.5 px
    }

    #[test]
    fn blurred_noise_is_wider_and_mixed_channels_correlate() {
        let (w, h) = (128, 128);
        let a = noise_plane(w * h, 4);
        // 4-px horizontal box blur widens the autocorrelation
        let blurred: Vec<f64> = (0..w * h).map(|i| (0..4).map(|k| a[(i / w) * w + (i % w + k) % w]).sum::<f64>() / 4.0).collect();
        assert!(fwhm_px(&blurred, w, h) > fwhm_px(&a, w, h) + 0.5);
        let b = noise_plane(w * h, 5);
        let mix: Vec<f64> = a.iter().zip(&b).map(|(x, y)| x + y).collect();
        assert!((correlation(&a, &mix) - 0.5f64.sqrt()).abs() < 0.03);
    }

    #[test]
    fn patch_stats_of_gaussianish_grey_noise() {
        // grey noise through the sRGB encode: R=G=B -> chroma std ~ 0, correlation 1
        let size = 128u32;
        let mut r = Rng(9);
        let data: Vec<f32> = (0..size * size).flat_map(|_| { let v = (0.45 + 0.1 * r.next()) as f32; [v, v, v] }).collect();
        let img = ImageBuf::from_data(size, size, data);
        let s = patch_stats(&img, 0.0, &Rgb::srgb());
        assert!(s.luma_std > 1.0);
        assert!(s.chroma_std < 0.05 * s.luma_std);
        assert!((s.corr_rg - 1.0).abs() < 1e-9);
        assert!((s.fwhm_px[1] - 1.0).abs() < 0.1);
    }

    #[test]
    fn overrides_set_pixel_pitch() {
        let o = patch_overrides(json!({"film_render": {"grain": {"rng": "hash"}}}), 256, 100.0);
        assert_eq!(o["film_render"]["grain"]["rng"], "hash");
        assert!((o["camera"]["film_format_mm"].as_f64().unwrap() - 2.56).abs() < 1e-9);
    }
}
