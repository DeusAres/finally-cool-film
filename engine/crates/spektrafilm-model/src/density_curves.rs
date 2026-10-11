/// H-D (Hurter-Driffield) characteristic curve interpolation.
///
/// Maps log exposure → density for each CMY channel using the
/// per-profile density curve tables.
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::interp;

/// f64 variant — preserves precision through the interpolation.
pub fn interpolate_exposure_to_density_f64(
    log_raw: &ImageBuf,
    density_curves: &[[f64; 3]],
    log_exposure: &[f64],
    gamma_factor: f64,
) -> ImageBuf {
    if (gamma_factor - 1.0).abs() < 1e-12 {
        interp::fast_interp_image_f64(log_raw, log_exposure, density_curves)
    } else {
        let x_axes: Vec<[f64; 3]> = log_exposure
            .iter()
            .map(|&le| [le / gamma_factor, le / gamma_factor, le / gamma_factor])
            .collect();
        interp::fast_interp_image_perchannel_f64(log_raw, &x_axes, density_curves)
    }
}

/// Interpolate density for a full image. Port of Python `interpolate_exposure_to_density`.
pub fn interpolate_exposure_to_density(
    log_raw: &ImageBuf,
    density_curves: &[[f32; 3]],
    log_exposure: &[f32],
    gamma_factor: f32,
) -> ImageBuf {
    if (gamma_factor - 1.0).abs() < 1e-6 {
        interp::fast_interp_image(log_raw, log_exposure, density_curves)
    } else {
        // Build per-channel x-axes: log_exposure / gamma_factor
        let x_axes: Vec<[f32; 3]> = log_exposure
            .iter()
            .map(|&le| [le / gamma_factor, le / gamma_factor, le / gamma_factor])
            .collect();
        interp::fast_interp_image_perchannel(log_raw, &x_axes, density_curves)
    }
}

/// f64 variant — normalize density curves by subtracting the per-channel minimum.
pub fn normalize_density_curves_f64(curves: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut min = [f64::INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] < min[c] {
                min[c] = row[c];
            }
        }
    }
    curves
        .iter()
        .map(|row| [row[0] - min[0], row[1] - min[1], row[2] - min[2]])
        .collect()
}

/// Normalize density curves by subtracting the per-channel minimum.
pub fn normalize_density_curves(curves: &[[f32; 3]]) -> Vec<[f32; 3]> {
    let mut min = [f32::INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] < min[c] {
                min[c] = row[c];
            }
        }
    }
    curves
        .iter()
        .map(|row| [row[0] - min[0], row[1] - min[1], row[2] - min[2]])
        .collect()
}

/// Get max density per channel from curves.
pub fn max_density(curves: &[[f32; 3]]) -> [f32; 3] {
    let mut max = [f32::NEG_INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] > max[c] {
                max[c] = row[c];
            }
        }
    }
    max
}

/// Get max density per channel from f64 curves — Python parity for grain
/// which reads the profile's f64 `density_curves` directly.
pub fn max_density_f64(curves: &[[f64; 3]]) -> [f64; 3] {
    let mut max = [f64::NEG_INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] > max[c] {
                max[c] = row[c];
            }
        }
    }
    max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_density_curves() {
        let curves = vec![[1.0, 2.0, 3.0], [2.0, 3.0, 4.0]];
        let norm = normalize_density_curves(&curves);
        assert_eq!(norm[0], [0.0, 0.0, 0.0]);
        assert_eq!(norm[1], [1.0, 1.0, 1.0]);
    }

    #[test]
    fn test_max_density() {
        let curves = vec![[0.1, 0.2, 0.3], [2.0, 1.5, 1.0], [1.5, 1.8, 0.8]];
        let max = max_density(&curves);
        assert_eq!(max, [2.0, 1.8, 1.0]);
    }
}
