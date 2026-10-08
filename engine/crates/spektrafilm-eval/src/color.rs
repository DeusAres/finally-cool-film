//! Colour maths for the harness: CIELAB D50, Bradford adaptation, sRGB /
//! Rec.2020 matrices, CIEDE2000, hue and chroma. All f64, independent of the
//! engine's `Scalar`.
use std::f64::consts::PI;

pub type V3 = [f64; 3];
pub type M3 = [[f64; 3]; 3];

pub const D50: V3 = [0.96422, 1.0, 0.82521];
pub const D65: V3 = [0.95047, 1.0, 1.08883];

const SRGB_PRIMARIES: [[f64; 2]; 3] = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
const REC2020_PRIMARIES: [[f64; 2]; 3] = [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]];
const BRADFORD: M3 = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];

pub fn mul_v(m: &M3, v: V3) -> V3 {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}

pub fn mul_m(a: &M3, b: &M3) -> M3 {
    std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| a[i][k] * b[k][j]).sum()))
}

pub fn inv(m: &M3) -> M3 {
    let c = |i: usize, j: usize| {
        let (r0, r1, c0, c1) = ((i + 1) % 3, (i + 2) % 3, (j + 1) % 3, (j + 2) % 3);
        m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
    };
    let det = m[0][0] * c(0, 0) + m[0][1] * c(0, 1) + m[0][2] * c(0, 2);
    std::array::from_fn(|i| std::array::from_fn(|j| c(j, i) / det))
}

/// Bradford chromatic adaptation matrix taking XYZ under `src` white to `dst` white.
pub fn bradford(src: V3, dst: V3) -> M3 {
    let (s, d) = (mul_v(&BRADFORD, src), mul_v(&BRADFORD, dst));
    let scale: M3 = std::array::from_fn(|i| std::array::from_fn(|j| if i == j { d[i] / s[i] } else { 0.0 }));
    mul_m(&inv(&BRADFORD), &mul_m(&scale, &BRADFORD))
}

/// An RGB working space (D65 white) as a pair of matrices.
pub struct Rgb {
    pub to_xyz: M3,
    pub from_xyz: M3,
}

impl Rgb {
    fn from_primaries(p: [[f64; 2]; 3], white: V3) -> Self {
        let col = |[x, y]: [f64; 2]| [x / y, 1.0, (1.0 - x - y) / y];
        let cols = p.map(col);
        let prim: M3 = std::array::from_fn(|i| std::array::from_fn(|j| cols[j][i]));
        let s = mul_v(&inv(&prim), white);
        let to_xyz = std::array::from_fn(|i| std::array::from_fn(|j| prim[i][j] * s[j]));
        Self { to_xyz, from_xyz: inv(&to_xyz) }
    }
    pub fn srgb() -> Self {
        Self::from_primaries(SRGB_PRIMARIES, D65)
    }
    pub fn rec2020() -> Self {
        Self::from_primaries(REC2020_PRIMARIES, D65)
    }
}

pub fn srgb_decode(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

pub fn srgb_encode(v: f64) -> f64 {
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

const EPS: f64 = 216.0 / 24389.0;
const KAPPA: f64 = 24389.0 / 27.0;

pub fn xyz_to_lab(xyz: V3, white: V3) -> V3 {
    let f = |t: f64| if t > EPS { t.cbrt() } else { (KAPPA * t + 16.0) / 116.0 };
    let [fx, fy, fz] = std::array::from_fn(|i| f(xyz[i] / white[i]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

pub fn lab_to_xyz(lab: V3, white: V3) -> V3 {
    let fy = (lab[0] + 16.0) / 116.0;
    let (fx, fz) = (fy + lab[1] / 500.0, fy - lab[2] / 200.0);
    let finv = |f: f64| if f * f * f > EPS { f * f * f } else { (116.0 * f - 16.0) / KAPPA };
    let y = if lab[0] > KAPPA * EPS { fy * fy * fy } else { lab[0] / KAPPA };
    [finv(fx) * white[0], y * white[1], finv(fz) * white[2]]
}

/// Lab D50 -> linear RGB in `space`, via Bradford D50 -> D65.
pub fn lab_d50_to_linear(lab: V3, space: &Rgb) -> V3 {
    mul_v(&space.from_xyz, mul_v(&bradford(D50, D65), lab_to_xyz(lab, D50)))
}

/// Linear RGB in `space` (D65) -> Lab D50, via Bradford D65 -> D50.
pub fn linear_to_lab_d50(rgb: V3, space: &Rgb) -> V3 {
    xyz_to_lab(mul_v(&bradford(D65, D50), mul_v(&space.to_xyz, rgb)), D50)
}

pub fn chroma(lab: V3) -> f64 {
    lab[1].hypot(lab[2])
}

/// Hue angle in degrees, [0, 360).
pub fn hue(lab: V3) -> f64 {
    lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0)
}

/// Signed hue difference `to - from` wrapped to (-180, 180].
pub fn hue_diff(from: f64, to: f64) -> f64 {
    let d = (to - from).rem_euclid(360.0);
    if d > 180.0 { d - 360.0 } else { d }
}

/// CIEDE2000 (Sharma, Wu, Dalal 2005), kL = kC = kH = 1.
pub fn de00(l1: V3, l2: V3) -> f64 {
    let rad = |d: f64| d * PI / 180.0;
    let (c1, c2) = (chroma(l1), chroma(l2));
    let cbar7 = (((c1 + c2) / 2.0).powi(7)).max(0.0);
    let g = 0.5 * (1.0 - (cbar7 / (cbar7 + 25f64.powi(7))).sqrt());
    let (a1, a2) = (l1[1] * (1.0 + g), l2[1] * (1.0 + g));
    let (cp1, cp2) = (a1.hypot(l1[2]), a2.hypot(l2[2]));
    let hp = |a: f64, b: f64| if a == 0.0 && b == 0.0 { 0.0 } else { hue([0.0, a, b]) };
    let (hp1, hp2) = (hp(a1, l1[2]), hp(a2, l2[2]));
    let dl = l2[0] - l1[0];
    let dc = cp2 - cp1;
    let dh = if cp1 * cp2 == 0.0 { 0.0 } else { hue_diff(hp1, hp2) };
    let dhh = 2.0 * (cp1 * cp2).sqrt() * rad(dh / 2.0).sin();
    let lbar = (l1[0] + l2[0]) / 2.0;
    let cbar = (cp1 + cp2) / 2.0;
    let hbar = if cp1 * cp2 == 0.0 {
        hp1 + hp2
    } else if (hp1 - hp2).abs() <= 180.0 {
        (hp1 + hp2) / 2.0
    } else if hp1 + hp2 < 360.0 {
        (hp1 + hp2 + 360.0) / 2.0
    } else {
        (hp1 + hp2 - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * rad(hbar - 30.0).cos() + 0.24 * rad(2.0 * hbar).cos()
        + 0.32 * rad(3.0 * hbar + 6.0).cos()
        - 0.20 * rad(4.0 * hbar - 63.0).cos();
    let sl = 1.0 + 0.015 * (lbar - 50.0).powi(2) / (20.0 + (lbar - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * cbar;
    let sh = 1.0 + 0.015 * cbar * t;
    let rc = 2.0 * (cbar.powi(7) / (cbar.powi(7) + 25f64.powi(7))).sqrt();
    let rt = -rad(60.0 * (-((hbar - 275.0) / 25.0).powi(2)).exp()).sin() * rc;
    let (x, y, z) = (dl / sl, dc / sc, dhh / sh);
    (x * x + y * y + z * z + rt * y * z).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn de00_sharma_vectors() {
        let cases: [(V3, V3, f64); 9] = [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
            ([50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485], 3.4412),
            ([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0000),
            ([50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485], 1.0000),
            ([50.0, 2.5, 0.0], [50.0, 0.0, -2.5], 4.3065),
            ([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644),
            ([63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630),
            ([2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082),
        ];
        for (a, b, want) in cases {
            assert!((de00(a, b) - want).abs() < 1e-4, "{a:?} {b:?}: {} vs {want}", de00(a, b));
            assert!((de00(b, a) - want).abs() < 1e-4, "symmetry {a:?} {b:?}");
        }
    }

    #[test]
    fn lab_round_trip() {
        for rgb in [[0.18, 0.18, 0.18], [0.8, 0.1, 0.3], [0.02, 0.5, 0.9], [0.0, 0.0, 0.0]] {
            for space in [Rgb::srgb(), Rgb::rec2020()] {
                let lab = linear_to_lab_d50(rgb, &space);
                let back = lab_d50_to_linear(lab, &space);
                for i in 0..3 {
                    assert!((back[i] - rgb[i]).abs() < 1e-9, "{rgb:?} -> {lab:?} -> {back:?}");
                }
            }
        }
    }

    #[test]
    fn white_and_grey_are_neutral() {
        let lab = linear_to_lab_d50([1.0, 1.0, 1.0], &Rgb::rec2020());
        assert!((lab[0] - 100.0).abs() < 1e-6 && lab[1].abs() < 1e-6 && lab[2].abs() < 1e-6, "{lab:?}");
        let lab = linear_to_lab_d50([0.18; 3], &Rgb::srgb());
        assert!((lab[0] - 49.5).abs() < 0.2 && chroma(lab) < 1e-6, "{lab:?}");
    }

    #[test]
    fn hue_helpers() {
        assert!((hue([50.0, 0.0, -1.0]) - 270.0).abs() < 1e-9);
        assert!((hue_diff(350.0, 10.0) - 20.0).abs() < 1e-9);
        assert!((hue_diff(10.0, 350.0) + 20.0).abs() < 1e-9);
        assert!((chroma([50.0, 3.0, 4.0]) - 5.0).abs() < 1e-12);
    }
}
