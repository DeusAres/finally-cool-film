//! The synthetic chart of SCHEMA.md: scene-linear patches, rendered one uniform
//! image each, measured as CIELAB D50 patch-centre means.
use std::path::Path;

use image::{Rgb as Px, RgbImage};
use spektrafilm_math::image::ImageBuf;

use crate::color::{self, Rgb, V3};
use crate::render::Renderer;

/// Side of the uniform image each patch is rendered as. Only the central half is
/// averaged, so blur, halation and DIR see an (almost) infinite flat field and
/// never a neighbouring patch.
const PATCH_PX: u32 = 48;

/// X-Rite ColorChecker 24 (post-2014), Lab D50.
pub const CC24: [(&str, V3); 24] = [
    ("dark skin", [37.54, 14.37, 14.92]),
    ("light skin", [64.66, 19.27, 17.50]),
    ("blue sky", [49.32, -3.82, -22.54]),
    ("foliage", [43.46, -12.74, 22.72]),
    ("blue flower", [54.94, 9.61, -24.79]),
    ("bluish green", [70.48, -32.26, -0.37]),
    ("orange", [62.73, 35.83, 56.50]),
    ("purplish blue", [39.43, 10.75, -45.17]),
    ("moderate red", [50.57, 48.64, 16.67]),
    ("purple", [30.10, 22.54, -20.87]),
    ("yellow green", [71.77, -24.13, 58.19]),
    ("orange yellow", [71.51, 18.24, 67.37]),
    ("blue", [28.37, 15.42, -49.80]),
    ("green", [54.38, -39.72, 32.27]),
    ("red", [42.43, 51.05, 28.62]),
    ("yellow", [81.80, 2.67, 80.41]),
    ("magenta", [50.63, 51.28, -14.12]),
    ("cyan", [49.57, -29.71, -28.32]),
    ("white", [95.19, -1.03, 2.93]),
    ("neutral 8", [81.29, -0.57, 0.44]),
    ("neutral 6.5", [66.89, -0.75, -0.06]),
    ("neutral 5", [50.76, -0.13, 0.14]),
    ("neutral 3.5", [35.63, -0.46, -0.48]),
    ("black", [20.64, 0.07, -0.46]),
];

/// Grey ramp exposures: ev = -4..+5 in thirds of a stop.
pub fn grey_evs() -> Vec<f64> {
    (-12..=15).map(|i| f64::from(i) / 3.0).collect()
}

/// Scene-linear Rec.2020 value of a grey patch: reflectance 0.18 * 2^ev, neutral.
pub fn grey_scene(ev: f64) -> V3 {
    [0.18 * ev.exp2(); 3]
}

/// Scene-linear Rec.2020 value of a Lab D50 reflectance patch (Bradford to D65).
pub fn lab_scene(lab: V3) -> V3 {
    color::lab_d50_to_linear(lab, &Rgb::rec2020())
}

fn uniform(rgb: V3) -> ImageBuf {
    let px = rgb.map(|v| v as f32);
    ImageBuf::from_data(PATCH_PX, PATCH_PX, (0..PATCH_PX * PATCH_PX).flat_map(|_| px).collect())
}

/// Render one uniform patch; the mean of its centre, in the pipeline's encoded
/// output values.
fn render_patch(r: &dyn Renderer, scene: V3) -> V3 {
    let out = r.render(uniform(scene));
    let (lo, hi) = (PATCH_PX / 4, PATCH_PX * 3 / 4);
    let mut sum = [0.0; 3];
    for y in lo..hi {
        for x in lo..hi {
            let p = out.get(x, y);
            (0..3).for_each(|c| sum[c] += f64::from(p[c]));
        }
    }
    let n = f64::from((hi - lo) * (hi - lo));
    sum.map(|s| s / n)
}

pub struct Measured {
    /// Encoded RGB the pipeline returned, patch-centre mean.
    pub rgb: V3,
    pub lab: V3,
}

/// sRGB-encoded pipeline output to CIELAB D50 (Bradford from D65).
pub fn output_lab(rgb: V3) -> V3 {
    color::linear_to_lab_d50(rgb.map(color::srgb_decode), &Rgb::srgb())
}

pub fn measure(r: &dyn Renderer, scene: V3) -> Measured {
    let rgb = render_patch(r, scene);
    Measured { rgb, lab: output_lab(rgb) }
}

fn fill(img: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, rgb: V3) {
    let px = Px(rgb.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8));
    for yy in y..y + h {
        for xx in x..x + w {
            img.put_pixel(xx, yy, px);
        }
    }
}

/// `chart.png`: grey ramp on top, then the cc24 grid with the reference colour
/// as a small inset in each rendered patch.
pub fn save_png(path: &Path, grey: &[Measured], cc24: &[Measured]) -> Result<(), String> {
    const G: u32 = 4; // gap
    let (gw, cell) = (grey.len() as u32, 96u32);
    let (cols, rows) = (6u32, 4u32);
    let grey_h = 56;
    let w = (gw * (36 + G) + G).max(cols * (cell + G) + G);
    let h = grey_h + G * 2 + rows * (cell + G);
    let mut img = RgbImage::from_pixel(w, h, Px([24, 24, 24]));
    for (i, m) in grey.iter().enumerate() {
        fill(&mut img, G + i as u32 * (36 + G), G, 36, grey_h - G, m.rgb);
    }
    let srgb = Rgb::srgb();
    for (i, m) in cc24.iter().enumerate() {
        let (cx, cy) = (G + (i as u32 % cols) * (cell + G), grey_h + G + (i as u32 / cols) * (cell + G));
        fill(&mut img, cx, cy, cell, cell, m.rgb);
        let r = color::lab_d50_to_linear(CC24[i].1, &srgb);
        fill(&mut img, cx + cell / 3, cy + cell / 3, cell / 3, cell / 3, r.map(color::srgb_encode));
    }
    img.save(path).map_err(|e| format!("{}: {e}", path.display()))
}
