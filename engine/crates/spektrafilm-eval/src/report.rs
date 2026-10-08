//! `report.json` (SCHEMA.md) and the scoring against `gold200_spec.json`.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::chart::CC24;
use crate::color::{self, V3};

#[derive(Serialize)]
pub struct GreyOut {
    pub ev: f64,
    #[serde(rename = "L")]
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

#[derive(Serialize)]
pub struct Cc24Out {
    pub id: usize,
    #[serde(rename = "L")]
    pub l: f64,
    pub a: f64,
    pub b: f64,
    #[serde(rename = "C")]
    pub c: f64,
    pub h: f64,
    /// Against the spec target when scored, else against the reference.
    pub de00: f64,
    /// `null` when no spec was given.
    pub pass: Option<bool>,
}

#[derive(Serialize)]
pub struct Report {
    pub grey: Vec<GreyOut>,
    pub cc24: Vec<Cc24Out>,
    pub global: BTreeMap<String, f64>,
    /// 0..100, `null` when no spec was given.
    pub score: Option<f64>,
    pub fails: Vec<String>,
}

#[derive(Deserialize)]
pub struct Spec {
    pub grey: Vec<GreySpec>,
    pub cc24: Vec<Cc24Spec>,
    pub global: Vec<GlobalSpec>,
    pub weights: Weights,
}

#[derive(Deserialize)]
pub struct GreySpec {
    pub ev: f64,
    #[serde(rename = "L")]
    pub l: [f64; 2],
    pub a: [f64; 2],
    pub b: [f64; 2],
}

#[derive(Deserialize)]
pub struct Cc24Spec {
    pub id: usize,
    pub target_lab: V3,
    pub tol_de00: f64,
    pub chroma_ratio: Option<[f64; 2]>,
    pub hue_shift_deg: Option<[f64; 2]>,
}

#[derive(Deserialize)]
pub struct GlobalSpec {
    pub id: String,
    pub target: [f64; 2],
}

#[derive(Deserialize)]
pub struct Weights {
    pub grey: f64,
    pub cc24: f64,
    pub global: f64,
}

fn ref_lab(id: usize) -> V3 {
    CC24[id - 1].1
}

/// Least-squares slope of L* against ev over the grey patches with ev in `[lo, hi]`.
fn slope(grey: &[(f64, V3)], lo: f64, hi: f64) -> f64 {
    let pts: Vec<_> = grey.iter().filter(|(ev, _)| *ev >= lo - 1e-6 && *ev <= hi + 1e-6).collect();
    let n = pts.len() as f64;
    let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1[0]).sum::<f64>() / n);
    let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1[0] - my)).sum();
    let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
    sxy / sxx
}

fn mean(v: impl Iterator<Item = f64>) -> f64 {
    let (s, n) = v.fold((0.0, 0.0), |(s, n), x| (s + x, n + 1.0));
    s / n
}

fn chroma_ratio(cc: &[V3], id: usize) -> f64 {
    color::chroma(cc[id - 1]) / color::chroma(ref_lab(id))
}

/// Circular mean hue (degrees) of patches `ids`.
fn mean_hue(cc: &[V3], ids: &[usize]) -> f64 {
    let (s, c) = ids.iter().fold((0.0, 0.0), |(s, c), &i| {
        let h = color::hue(cc[i - 1]).to_radians();
        (s + h.sin(), c + h.cos())
    });
    s.atan2(c).to_degrees().rem_euclid(360.0)
}

/// All derived quantities of SCHEMA.md. `grey` is (ev, Lab) ascending, `cc` the 24 Labs.
pub fn globals(grey: &[(f64, V3)], cc: &[V3]) -> BTreeMap<String, f64> {
    let ratio_of = |ids: &[usize]| mean(ids.iter().map(|&i| chroma_ratio(cc, i)));
    let mid: Vec<_> = grey.iter().filter(|(ev, _)| ev.abs() <= 1.0 + 1e-6).collect();
    let ab = |p: &&(f64, V3)| [p.1[1], p.1[2]];
    let (ma, mb) = (mean(mid.iter().map(|p| ab(p)[0])), mean(mid.iter().map(|p| ab(p)[1])));
    let at = |ev: f64| grey.iter().find(|p| (p.0 - ev).abs() < 1e-6).map_or(f64::NAN, |p| p.1[0]);
    let chromatic: Vec<usize> = (1..=18).collect();
    [
        ("mean_chroma_ratio", ratio_of(&chromatic)),
        ("red_chroma_ratio", ratio_of(&[15])),
        ("yellow_chroma_ratio", ratio_of(&[16])),
        ("green_chroma_ratio", ratio_of(&[14])),
        ("blue_chroma_ratio", ratio_of(&[13])),
        ("skin_chroma_ratio", ratio_of(&[1, 2])),
        ("skin_hue_deg", mean_hue(cc, &[1, 2])),
        ("sky_hue_deg", mean_hue(cc, &[3])),
        ("foliage_hue_deg", mean_hue(cc, &[4])),
        ("grey_slope_mid", slope(grey, -1.0, 1.0)),
        ("grey_slope_shadow", slope(grey, -4.0, -2.0)),
        ("grey_slope_high", slope(grey, 2.0, 5.0)),
        ("grey_ab_max_dev_mid", mid.iter().map(|p| (ab(p)[0] - ma).hypot(ab(p)[1] - mb)).fold(0.0, f64::max)),
        ("black_L", at(-4.0)),
        ("white_L", at(5.0)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// 1 inside `[lo, hi]`, falling linearly to 0 at twice the half-width outside.
fn range_score(v: f64, [lo, hi]: [f64; 2]) -> f64 {
    let half = ((hi - lo) / 2.0).max(1e-9);
    let outside = (lo - v).max(v - hi).max(0.0);
    if v.is_nan() { 0.0 } else { (1.0 - outside / (2.0 * half)).clamp(0.0, 1.0) }
}

/// Scores one item made of named range checks: (mean score, failure texts).
fn item(label: String, checks: &[(&str, f64, [f64; 2])]) -> (f64, Vec<String>) {
    let scores: Vec<f64> = checks.iter().map(|&(_, v, r)| range_score(v, r)).collect();
    let fails = checks
        .iter()
        .zip(&scores)
        .filter(|&(_, &s)| s < 1.0)
        .map(|(&(name, v, [lo, hi]), _)| format!("{label}: {name} {v:.2} outside [{lo:.2}, {hi:.2}]"))
        .collect();
    (mean(scores.into_iter()), fails)
}

/// Fills `pass`/`de00` on `cc24` and returns (score, fails).
pub fn score(spec: &Spec, grey: &[(f64, V3)], cc24: &mut [Cc24Out], glob: &BTreeMap<String, f64>) -> (f64, Vec<String>) {
    let (mut fails, mut cats) = (Vec::new(), Vec::new());
    let mut run = |weight: f64, items: Vec<(f64, Vec<String>)>| {
        if !items.is_empty() {
            cats.push((weight, mean(items.iter().map(|i| i.0))));
        }
        fails.extend(items.into_iter().flat_map(|i| i.1));
    };

    let grey_items = spec
        .grey
        .iter()
        .map(|g| match grey.iter().find(|(ev, _)| (ev - g.ev).abs() < 1e-3) {
            Some((_, lab)) => item(format!("grey {:+.2} EV", g.ev), &[("L", lab[0], g.l), ("a", lab[1], g.a), ("b", lab[2], g.b)]),
            None => (0.0, vec![format!("grey {:+.2} EV: not measured", g.ev)]),
        })
        .collect();
    run(spec.weights.grey, grey_items);

    let cc_items = spec
        .cc24
        .iter()
        .map(|p| {
            let row = &mut cc24[p.id - 1];
            let lab = [row.l, row.a, row.b];
            row.de00 = color::de00(lab, p.target_lab);
            let reference = ref_lab(p.id);
            let ratio = color::chroma(lab) / color::chroma(reference);
            let shift = color::hue_diff(color::hue(reference), color::hue(lab));
            let mut checks = vec![("de00", row.de00, [0.0, p.tol_de00])];
            checks.extend(p.chroma_ratio.map(|r| ("chroma_ratio", ratio, r)));
            checks.extend(p.hue_shift_deg.map(|r| ("hue_shift_deg", shift, r)));
            let it = item(format!("cc24 {} {}", p.id, CC24[p.id - 1].0), &checks);
            row.pass = Some(it.1.is_empty());
            it
        })
        .collect();
    run(spec.weights.cc24, cc_items);

    let global_items = spec
        .global
        .iter()
        .map(|g| match glob.get(&g.id) {
            Some(&v) => item(format!("global {}", g.id), &[("value", v, g.target)]),
            None => (0.0, vec![format!("global {}: unknown id", g.id)]),
        })
        .collect();
    run(spec.weights.global, global_items);

    let total: f64 = cats.iter().map(|c| c.0).sum();
    (100.0 * cats.iter().map(|c| c.0 * c.1).sum::<f64>() / total, fails)
}
