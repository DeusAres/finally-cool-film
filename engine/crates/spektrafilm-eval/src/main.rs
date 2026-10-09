//! `sf-eval`: measurement harness for the film pipeline (contract: eval/SCHEMA.md).
//!
//!   sf-eval chart --params <overrides.json> --out <dir> [--spec <spec.json>] [--data <web/data>]
//!                 [--exposure-ev <x>] [--relative <0|1>] [--output-space srgb|bt2020]
//!     --exposure-ev: scene exposure error in EV; the lab's AutoSetup (core `frontier`) then runs on the
//!                    ColorChecker frame as the app does on its thumbnail, and the chart is re-rendered with it.
//!     --relative 1:  grade shape only (slopes, grey a*/b*, chroma ratios, hue shifts), not absolute L*.
//!   sf-eval image --params <overrides.json> --in <linear.npy> --out <png> [--data <web/data>]
mod chart;
mod color;
mod render;
mod report;

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};

use image::RgbImage;
use serde::de::DeserializeOwned;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::npy;

use render::Renderer;
use report::{Cc24Out, GreyOut, Report, Spec};

const USAGE: &str = "usage:\n  sf-eval chart --params <overrides.json> --out <dir> [--spec <spec.json>] [--data <dir>] [--exposure-ev <x>] [--relative 1]\n  sf-eval image --params <overrides.json> --in <linear.npy> --out <png> [--data <dir>]";

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_reader(BufReader::new(file)).map_err(|e| format!("{}: {e}", path.display()))
}

struct Args(HashMap<String, String>);

impl Args {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut map = HashMap::new();
        let mut args = args;
        while let Some(flag) = args.next() {
            let name = flag.strip_prefix("--").ok_or_else(|| format!("unexpected argument {flag}\n{USAGE}"))?;
            let value = args.next().ok_or_else(|| format!("--{name} needs a value"))?;
            map.insert(name.to_string(), value);
        }
        Ok(Self(map))
    }
    fn opt(&self, name: &str) -> Option<PathBuf> {
        self.0.get(name).map(PathBuf::from)
    }
    fn req(&self, name: &str) -> Result<PathBuf, String> {
        self.opt(name).ok_or_else(|| format!("missing --{name}\n{USAGE}"))
    }
    /// The pipeline built from `--params` (and `--data`).
    fn renderer(&self) -> Result<render::EngineRenderer, String> {
        let mut overrides: serde_json::Value = read_json(&self.req("params")?)?;
        if self.0.get("output-space").is_some_and(|v| v == "bt2020") {
            overrides["io"]["output_color_space"] = "ITU-R BT.2020".into();
        }
        render::build(overrides, &self.opt("data").unwrap_or_else(render::default_data_dir))
    }
}

fn chart_cmd(args: &Args) -> Result<(), String> {
    let mut renderer = args.renderer()?;
    let out = args.req("out")?;
    let relative = args.0.get("relative").is_some_and(|v| v != "0");
    let exposure: Option<f64> = args.0.get("exposure-ev").map(|v| v.parse().map_err(|_| format!("bad --exposure-ev {v}"))).transpose()?;
    let gain = exposure.map_or(1.0, f64::exp2);
    if exposure.is_some() {
        let auto = renderer.apply_autosetup(chart::cc24_frame(gain)).ok_or("AutoSetup needs a negative film")?;
        eprintln!("autosetup [density_ev, c, m, y] = {auto:?}");
    }
    let space = if args.0.get("output-space").is_some_and(|v| v == "bt2020") { color::Rgb::rec2020() } else { color::Rgb::srgb() };
    let spec: Option<Spec> = args.opt("spec").map(|p| read_json(&p)).transpose()?;

    let evs = chart::grey_evs();
    let grey: Vec<_> = evs.iter().map(|&ev| chart::measure(&renderer, chart::grey_scene(ev).map(|v| v * gain), &space)).collect();
    let cc24: Vec<_> = chart::CC24.iter().map(|(_, lab)| chart::measure(&renderer, chart::lab_scene(*lab).map(|v| v * gain), &space)).collect();

    let grey_lab: Vec<_> = evs.iter().zip(&grey).map(|(&ev, m)| (ev, m.lab)).collect();
    let cc_lab: Vec<_> = cc24.iter().map(|m| m.lab).collect();
    let global = report::globals(&grey_lab, &cc_lab);

    let mut rows: Vec<Cc24Out> = cc24
        .iter()
        .zip(chart::CC24)
        .enumerate()
        .map(|(i, (m, (_, reference)))| Cc24Out {
            id: i + 1,
            l: m.lab[0],
            a: m.lab[1],
            b: m.lab[2],
            c: color::chroma(m.lab),
            h: color::hue(m.lab),
            de00: color::de00(m.lab, reference),
            pass: None,
        })
        .collect();
    let (score, fails) = match &spec {
        Some(spec) => {
            let (s, f) = report::score(spec, &grey_lab, &mut rows, &global, relative);
            (Some(s), f)
        }
        None => (None, Vec::new()),
    };
    let report = Report {
        grey: grey_lab.iter().map(|&(ev, l)| GreyOut { ev, l: l[0], a: l[1], b: l[2] }).collect(),
        cc24: rows,
        global,
        score,
        fails,
    };

    fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(out.join("report.json"), json).map_err(|e| e.to_string())?;
    chart::save_png(&out.join("chart.png"), &grey, &cc24)?;
    match report.score {
        Some(s) => println!("score {s:.1}, {} fails -> {}", report.fails.len(), out.display()),
        None => println!("no spec: measured only -> {}", out.display()),
    }
    Ok(())
}

fn load_npy(path: &Path) -> Result<ImageBuf, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (shape, data) = npy::load_npy_f32(BufReader::new(file)).map_err(|e| format!("{}: {e:?}", path.display()))?;
    let [h, w, 3] = shape[..] else {
        return Err(format!("{}: expected shape HxWx3, got {shape:?}", path.display()));
    };
    Ok(ImageBuf::from_data(w as u32, h as u32, data))
}

fn scaled(img: &ImageBuf, k: f64) -> ImageBuf {
    ImageBuf::from_data(img.width, img.height, img.data.iter().map(|&v| (f64::from(v) * k) as f32).collect())
}

fn save(img: &ImageBuf, path: &Path) -> Result<(), String> {
    let bytes: Vec<u8> = img.data.iter().map(|&v| (f64::from(v).clamp(0.0, 1.0) * 255.0).round() as u8).collect();
    let rgb = RgbImage::from_raw(img.width, img.height, bytes).ok_or("output size mismatch")?;
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg")) {
        let file = File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 90);
        enc.encode_image(&rgb).map_err(|e| e.to_string())
    } else {
        rgb.save(path).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// Plain sRGB view of scene-linear Rec.2020 (no film), the comparison baseline.
fn neutral(scene: &ImageBuf) -> ImageBuf {
    let (src, dst) = (color::Rgb::rec2020(), color::Rgb::srgb());
    let m = color::mul_m(&dst.from_xyz, &src.to_xyz);
    let mut out = scene.clone();
    for p in out.pixels_mut() {
        let v = color::mul_v(&m, [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])]);
        for c in 0..3 {
            p[c] = color::srgb_encode(v[c].clamp(0.0, 1.0)) as f32;
        }
    }
    out
}

/// Without `--meta`: the .npy goes through the engine as is. With `--meta <dng2npy .json> --thumb <.thumb.npy>`
/// the app's raw path: Auto = engine exposure metering on the thumb (+ baseline), clamped to the Esposizione
/// range, rounded to 0.1 (web/app.js autoSetup); frontier AutoSetup on the thumb at that exposure; the frame is
/// rendered with gain 2^(ev - Interno + baseline). `--neutral <png|jpg>` also writes the film-less render.
fn image_cmd(args: &Args) -> Result<(), String> {
    let mut renderer = args.renderer()?;
    let mut scene = load_npy(&args.req("in")?)?;
    if let Some(meta) = args.opt("meta") {
        let meta: serde_json::Value = read_json(&meta)?;
        let num = |k: &str| meta[k].as_f64().unwrap_or(0.0);
        let under = if meta["indoor"].as_bool().unwrap_or(false) { num("under") } else { 0.0 };
        let thumb = load_npy(&args.req("thumb")?)?;
        let thumb_b = scaled(&thumb, num("baseline").exp2());
        let metered = f64::from(renderer.auto_exposure_ev(&thumb_b));
        let ev = ((metered.clamp(-2.0, 2.5)) * 10.0).round() / 10.0;   // clamp then round: as the app's slider
        let auto = renderer.apply_autosetup(scaled(&thumb_b, (ev - under).exp2())).ok_or("AutoSetup needs a negative film")?;
        eprintln!("exposure: baseline {} EV, auto ev {ev}, Interno -{under}, autosetup [density_ev, c, m, y] = {auto:?}", num("baseline"));
        scene = scaled(&scene, (ev - under + num("baseline")).exp2());
    }
    if let Some(p) = args.opt("neutral") {
        save(&neutral(&scene), &p)?;
    }
    save(&renderer.render(scene), &args.req("out")?)
}

fn main() {
    let mut argv = std::env::args().skip(1);
    let result = match argv.next().as_deref() {
        Some(cmd @ ("chart" | "image")) => Args::parse(argv).and_then(|a| if cmd == "chart" { chart_cmd(&a) } else { image_cmd(&a) }),
        _ => Err(USAGE.to_string()),
    };
    if let Err(e) = result {
        eprintln!("sf-eval: {e}");
        std::process::exit(1);
    }
}
