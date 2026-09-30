# Spike: spektrafilm-rs → WASM + WebGPU

Obiettivo: verificare che il motore Rust di [spektrafilm-rs](https://github.com/turbasvin/spektrafilm-rs)
(port di [spektrafilm](https://github.com/andreavolpato/spektrafilm)) giri nel browser, CPU e WebGPU.

Upstream: `turbasvin/spektrafilm-rs` @ `9dd59b0380194b93686aaa230a8bb9680aa270a4` (GPL-3.0).
Il motore patchato ora vive in `../engine/` (wrapper incluso); qui restano report, patch e harness.

## Esito

| Verifica | Risultato |
|---|---|
| `spektrafilm-core` → `wasm32-unknown-unknown` | OK dopo ~180 righe di patch |
| Pipeline CPU in wasm (Kodak Gold 200 → Portra Endura) | OK, output corretto, 0 NaN |
| Pipeline GPU-resident WebGPU in Chromium | OK, diff vs CPU: media 1.2/255, max 9.7/255 |
| Bundle | `.wasm` 1.8 MB (CPU+GPU) + dati ~5.9 MB (Gold 200 + Endura + LUT spettrale) |
| jpegli wasm (export) | firma decodificata e validata, vedi sotto |

### Timing CPU wasm (Node 22, 1 core, 0.72 MP)

| Config | ms/frame |
|---|---|
| default (integrazione spettrale 81 bande per pixel) | ~9400 |
| `use_enlarger_lut` + `use_scanner_lut` | ~2900 (diff vs full: max 1/255) |
| + `output_gamut_compress: aces_rgc` | ~2000 (ma diff visibile, max 39/255: scartato) |

→ CPU wasm ≈ 4 s/MP: ok come fallback/export, **non** per preview interattiva.
Hotspot: `libm pow` f64 software (~1/3), RNG grana, pchip3d, CAM16.

### Timing GPU — iPhone reale (Safari 27, iOS 18.7, WebGPU Apple), 2026-09-30

| MP | 1ª (ms) | mediana (ms) |
|---|---|---|
| 0.5 | 32 | 18 |
| 1 | 40 | 38 |
| 2 | 82 | 82 |
| 4 | 200 | 215 |
| CPU wasm 0.5 | 837 | — |

- Foto reale 1200×1600 (P3, arrivata come JPEG 3024×4032 dal picker iOS): decode 68 ms, sviluppo 131 ms end-to-end.
- Scala ~lineare (~50 ms/MP) → preview 2 MP interattiva; 12 MP stimati ~0.6–0.8 s (memoria da verificare).
- Adapter Apple: `maxComputeInvocationsPerWorkgroup = 1024` (il limite 256 serve per Android/altri).
- Gate superato: **preview interattiva fattibile**.

## Patch a upstream (`patches/0001-wasm-webgpu.patch`)

1. **BLAS**: `cblas`/`openblas-src` esclusi su wasm32, riusato il fallback già presente per Windows.
2. **getrandom**: feature `wasm_js` + `RUSTFLAGS='--cfg getrandom_backend="wasm_js"'`.
3. **`std::time::Instant`** (panic su wasm) → `web-time`.
4. **`std::fs`** → modulo `vfs` (disco su nativo, tabella in memoria popolata da JS su wasm).
5. **wgpu**: `default-features = false` a livello workspace (cli/gui lo riabilitano), feature `webgpu` + `fragile-send-sync-non-atomic-wasm`.
6. **`WgpuBackend::new_async()`**: niente `pollster::block_on` su wasm.
7. **Readback asincrono**: su wasm `run_film_chain` fa submit + `map_async` e ritorna subito; i pixel si prendono con `take_readback().await`. Nativo invariato.
8. **Workgroup 1024 → 256 su wasm** (riscrittura WGSL a compile-time): WebGPU garantisce solo 256 invocazioni/workgroup, tipico limite mobile.

Nota: il workspace nativo non è stato ricompilato qui (manca OpenBLAS nel container) — da verificare prima di proporre upstream.

## API wrapper (`engine/crates/spektrafilm-wasm`)

```ts
register_file(path: string, bytes: Uint8Array): void   // es. "data/profiles/kodak_gold_200.json"
default_params(): string                               // RuntimeParams JSON
init_gpu(): Promise<boolean>
new Engine(film: string, paper: string, overridesJson: string)
engine.process(rgb: Float32Array, w, h): Float32Array            // CPU
engine.process_gpu(rgb: Float32Array, w, h): Promise<Float32Array> // WebGPU, sRGB-encoded
```

Params consigliati: `settings.use_enlarger_lut = true`, `settings.use_scanner_lut = true`.

## Input iPhone (HEIC, Display P3)

- Il motore **non** conosce "Display P3": nomi sconosciuti ricadono **silenziosamente su ProPhoto** → colori sbagliati.
- MVP: decodifica P3 nel browser (`getImageData(..., { colorSpace: 'display-p3' })`), linearizza, matrice 3×3 P3→Rec.2020, passa `input_color_space: "ITU-R BT.2020"`, `input_cctf_decoding: false`.
- HEIC: Safari lo decodifica nativamente; Chrome no (servirebbe libheif-wasm, non prioritario).

## jpegli (export)

Firma ricavata dal wasm e verificata empiricamente:

```
_jpegli_wasm_encode_rgb(rgbPtr, w, h, distance: f32, progressive: i32, yuv444: i32, outLenPtr) -> outPtr
_jpegli_wasm_start(w, h, distance, progressive, yuv444) -> handle   // + write_rows / finish per streaming
_jpegli_wasm_free(outPtr)
```

`distance` = butteraugli distance (non qualità 0-100). Su 0.72 MP:

| distance | prog | 444 | KB | PSNR |
|---|---|---|---|---|
| 1.0 | 0 | 0 | 46 | 40.3 |
| 1.0 | 1 | 0 | 39 | 40.3 |
| 1.0 | 1 | 1 | 81 | 41.6 |
| 2.0 | 0 | 0 | 27 | 39.7 |

Proposta default: distance 1.0, progressive, 4:4:4 (preserva la grana cromatica; da valutare a occhio).

## Riprodurre

```bash
git clone https://github.com/turbasvin/spektrafilm-rs && cd spektrafilm-rs
git checkout 9dd59b0380194b93686aaa230a8bb9680aa270a4
git apply ../spike/patches/0001-wasm-webgpu.patch
cp -r ../engine/crates/spektrafilm-wasm crates/ && sed -i 's|"crates/spektrafilm-gui",|"crates/spektrafilm-gui",\n    "crates/spektrafilm-wasm",|' Cargo.toml
rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.100
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo build --target wasm32-unknown-unknown -p spektrafilm-wasm --release
wasm-bindgen --target web   --out-dir pkg-web  target/wasm32-unknown-unknown/release/spektrafilm_wasm.wasm
wasm-bindgen --target nodejs --out-dir pkg-node target/wasm32-unknown-unknown/release/spektrafilm_wasm.wasm
```

Harness: `bench/run.mjs` (CPU, Node + sharp), `bench/browser.mjs` + `web/index.html`
(Chromium headless con WebGPU/SwiftShader), `bench/jpegli-probe.cjs`.
I path nei bench sono relativi al layout della sessione di spike: da adattare.

## Prossimi passi

1. **Gate hardware**: pagina di test su iPhone (Safari, WebGPU) → misurare ms/frame a 1–2 MP.
2. Decidere come integrare upstream (fork con patch / submodule / vendoring).
3. Input P3 + HEIC, preview su canvas, 3–4 slider, export jpegli (streaming, in Worker).
4. Ottimizzazioni: niente readback in preview (render diretto da buffer GPU a canvas), readback solo in export.
