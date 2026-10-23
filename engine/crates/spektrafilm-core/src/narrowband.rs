//! Narrowband scan (`scanner.model = "narrowband"`, with `io.scan_film` on a negative): the developed
//! negative read the way a densitometer or an RGB-LED scanner reads it, one narrow band per channel,
//! instead of the legacy scan's colorimetric look at the negative (CIE observer under the viewing
//! illuminant, whose broad overlapping bands mix the three dyes: the inverted colours come out flat
//! and shifted, measured against real Gold 200 scans, eval/V4.md).
//!
//! Output per channel: the film's transmittance in that band, base and orange mask included, encoded
//! as the scan LUT's output (sRGB transfer, decoded back to linear by the scan stage). No colour
//! matrix: the channels are the bands, taken as the output space's own channels (the Rec.2020
//! primaries are monochromatic at 630 / 532 / 467 nm, near the default bands). A neutral positive is
//! the caller's inversion of this scan (web/lib/invert.js).

use spektrafilm_math::precision::{from_f64, srgb_encode};

use crate::frontier::{FrontierBase, FrontierLut, band_transmittance, band_weights, film_spectra};
use crate::params::{FrontierModelParams, NarrowbandParams};
use crate::profile::Profile;

/// The narrowband scan as a scan LUT over the film density domain `data_min..data_max`.
pub fn scan_lut(film: &Profile, bands: &NarrowbandParams, data_min: [f64; 3], data_max: [f64; 3], steps: usize) -> FrontierLut {
    let (cd, base) = film_spectra(film);
    let weights = band_weights(&cd, &base, bands.peak_nm, bands.fwhm_nm);
    FrontierLut::from_fn(
        |cmy| band_transmittance(&cd, &base, &weights, cmy).map(|t| srgb_encode(from_f64(t.clamp(0.0, 1.0))) as f64),
        data_min,
        data_max,
        steps,
    )
}

/// The Frontier model's film-type setup, read through the narrowband bands: a per-level LUT on the stock's grey ramp (0.5 EV steps
/// over +-`setup_ev`), neutral over the whole ramp; beyond it each channel keeps its own slope (1: no added contrast).
pub fn setup_model(bands: &NarrowbandParams) -> FrontierModelParams {
    let ev = bands.setup_ev.max(0.5);
    FrontierModelParams {
        sensor_peak_nm: bands.peak_nm,
        sensor_fwhm_nm: bands.fwhm_nm,
        setup_lut: true,
        setup_fit_ev: ev,
        setup_fit_steps: (4.0 * ev).round() as u32 + 1,
        setup_neutral_ev: ev,
        setup_toe_slope: [1.0, 1.0],
        ..FrontierModelParams::default()
    }
}

/// The narrowband scan with the film-type setup: per channel `10^-D'` (`D'` the base-removed band density on G's axis,
/// `FrontierBase::setup_density`), encoded as `scan_lut`'s output. Equal channels = a grey the stock recorded as grey.
pub fn setup_scan_lut(base: &FrontierBase, data_min: [f64; 3], data_max: [f64; 3], steps: usize) -> FrontierLut {
    FrontierLut::from_fn(
        |cmy| base.setup_density(cmy).map(|d| srgb_encode(from_f64(10f64.powf(-d).clamp(0.0, 1.0))) as f64),
        data_min,
        data_max,
        steps,
    )
}

#[cfg(test)]
mod tests {
    use spektrafilm_gpu::cpu_backend::CpuBackend;
    use spektrafilm_math::image::ImageBuf;
    use spektrafilm_math::precision::from_f64;

    use crate::params::RuntimeParams;
    use crate::pipeline::Pipeline;

    fn pipeline(setup: bool) -> Option<Pipeline> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/data");
        let film = crate::profile::load_profile_by_name(&dir, "kodak_gold_200").ok()?;
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").ok()?;
        let mut p = RuntimeParams::default();
        p.io.scan_film = true;
        p.io.input_color_space = "sRGB".into();
        p.io.input_cctf_decoding = false;
        p.scanner.model = Some("narrowband".into());
        p.scanner.narrowband.setup = setup;
        p.scanner.unsharp_mask = [0.0, 0.0];
        p.camera.auto_exposure = false;
        p.film_render.grain.active = false;
        p.film_render.halation.active = false;
        Pipeline::new_with_spectral(film, print, p, &dir).ok()
    }

    /// Band densities of a neutral grey at each EV about mid grey.
    fn grey_densities(p: &Pipeline, evs: &[f64]) -> Vec<[f64; 3]> {
        let data = evs.iter().flat_map(|ev| [from_f64(0.18 * 2f64.powf(*ev)); 3]).collect();
        let out = p.process(ImageBuf::from_data(evs.len() as u32, 1, data), &CpuBackend);
        out.data
            .chunks(3)
            .map(|px| [0, 1, 2].map(|c| -spektrafilm_math::precision::srgb_decode(px[c]).max(1e-6).log10() as f64))
            .collect()
    }

    #[test]
    fn setup_puts_a_grey_ramp_on_one_axis() {
        let (Some(raw), Some(setup)) = (pipeline(false), pipeline(true)) else { return };
        let evs: Vec<f64> = (-8..=8).map(|i| f64::from(i) / 2.0).collect();
        // the raw band scan carries the orange mask: the three channels differ widely on a grey
        let r = grey_densities(&raw, &evs);
        assert!(r.iter().all(|d| (d[2] - d[0]).abs() > 0.3), "raw scan unexpectedly neutral: {r:?}");
        // with the setup a grey reads the same in the three channels, at every level within +-4 EV
        for (ev, d) in evs.iter().zip(grey_densities(&setup, &evs)) {
            assert!((d[0] - d[1]).abs() < 0.02 && (d[2] - d[1]).abs() < 0.02, "grey at {ev} EV not neutral: {d:?}");
        }
    }
}
