//! Halation light-threshold soft knee, shared by the CPU path
//! (`apply_halation_um`) and the GPU path (uniform values fed to
//! `halation_threshold.wgsl`). The WGSL shader implements the same formula
//! with the same `lo` / `hi` bounds computed here.
//!
//! `src = E * smoothstep(lo, hi, E)` with `lo = 0.18 * 2^ev` (scene-linear)
//! and `hi = lo * 2^HALATION_KNEE_EV`, i.e. a soft knee one EV wide.

pub const MID_GREY: f32 = 0.18;
pub const HALATION_KNEE_EV: f32 = 1.0;

/// `(lo, hi)` exposure bounds for a threshold given in EV above mid grey.
pub fn halation_threshold_bounds(threshold_ev: f32) -> (f32, f32) {
    let lo = MID_GREY * threshold_ev.exp2();
    (lo, lo * HALATION_KNEE_EV.exp2())
}

/// Light that feeds the halation blur: `e * smoothstep(lo, hi, e)`.
pub fn halation_source(e: f32, lo: f32, hi: f32) -> f32 {
    let t = ((e - lo) / (hi - lo)).clamp(0.0, 1.0);
    e.max(0.0) * t * t * (3.0 - 2.0 * t)
}
