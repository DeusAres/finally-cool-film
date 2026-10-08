# v2.0 engine ↔ app contract (binding for all agents)

Principle: colour and tone come from physics (film model + Frontier scanner). No hand-tuned "look" stages.

## Engine (Rust) owns: film → Frontier scan → positive
- `io.scan_film=true` + `scanner.model="frontier"` ⇒ the engine returns the **positive**, encoded with the
  sRGB transfer function, primaries = `io.output_color_space` (sRGB or ITU-R BT.2020), same as today's encoding.
- New params block `scanner.frontier` (all neutral defaults = lab default):
  `density` (EV, brightness key, +=brighter), `cmy` [c,m,y] (density units, Frontier keys),
  `contrast` (0 = standard gradation), `saturation` (1 = standard), `highlight` (shoulder, 0 = standard),
  `black_lift` (0..1, Nero: raises black, neutral in scanner space), `auto` [d,c,m,y] (AutoSetup result, set by app).
- Sensor/inversion/setup/gradation/colour per `eval/frontier_model.json`; baked into the scanner LUT.
  Changing `scanner.frontier.*` via `Engine.update()` must rebuild only what is needed (target < 30 ms).
- `Engine.frontier_auto_setup(rgba_f32_linear_thumb, w, h) -> Float32Array[4]` (d,c,m,y): renders the thumb
  (≤256 px, input space of the engine) to negative on CPU and runs AutoSetup. App passes it back as `scanner.frontier.auto`.
- Halation strength from profile (`antihalation`), DIR coupler spatial diffusion re-enabled at engine defaults.

## App (JS/WGSL) owns: input conditioning, spatial effects, UI, export
- Input: JPEG → EOTF decode → ONE fixed generic display→scene inverse (`lib/color.js`), no measured pipeline inverse.
  DNG → scene-linear Rec.2020 (ColorMatrix + ForwardMatrix when present).
- Esposizione = scene gain 2^ev before film (physical). Interno = extra underexposure from EXIF estimate, clamp [0,2] EV.
- Kept: lens (CA/vignette/falloff), chroma NR, Texture, Chiarezza, clip→halation boost, grain (post-scan), dust,
  export tiling/jpegli, IG, A/B, log.
- Removed: castGains, readTransfer/measured inverse, SCAN_PTS, scanLevels, greyBalance, scan.js inversion,
  GOLD toning, PRINT look + Stampa slider, skyHue, vibrance, TOE tint, FADE_TINT.
- Slider mapping: Contrasto→frontier.contrast, Alte luci→frontier.highlight, Magenta/Giallo filtri→frontier.cmy,
  Nero→frontier.black_lift, Auto→engine auto exposure + frontier_auto_setup.
- Colour constants (matrices, luma weights per primaries, transfer functions) live once in `lib/color.js`;
  WGSL gets them by string interpolation from there.
