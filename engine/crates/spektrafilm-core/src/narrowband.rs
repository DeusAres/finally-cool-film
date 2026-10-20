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

use crate::frontier::{FrontierLut, band_transmittance, band_weights, film_spectra};
use crate::params::NarrowbandParams;
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
