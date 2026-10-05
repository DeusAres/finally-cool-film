# finally cool film

Porting mobile web di [spektrafilm](https://github.com/andreavolpato/spektrafilm): simulazione spettrale
di pellicola → stampa → scansione, nel browser via WebAssembly + WebGPU. Focus: Kodak Gold 200 da foto iPhone.

## Struttura

| Path | Cosa |
|---|---|
| `engine/` | motore Rust da [spektrafilm-rs](https://github.com/turbasvin/spektrafilm-rs) @ `9dd59b0` (GPL-3.0) + patch wasm/WebGPU (`spike/patches/`) + wrapper `spektrafilm-wasm` |
| `web/` | app: `index.html` (MVP) e `bench.html` (test GPU / diagnostica) |
| `web/data/` | profili Gold 200 / Portra Endura, LUT spettrale, filtri neutri (CC BY-SA 4.0) |
| `spike/` | report della spike, patch, harness di benchmark |

## App (MVP)

- Scegli foto → **ricostruzione della luce di scena** (`web/lib/tone.js`): la curva dei grigi dell'intera pipeline viene misurata
  e invertita per canale, così la foto iPhone (già con la sua curva) non subisce una doppia curva/saturazione.
  **Contrasto** = quanta curva di stampa reintrodurre, **Esposizione** = campana sui mezzi toni, spalla morbida (niente
  alte luci bruciate), nero = Dmax reale della carta. **Auto** parte dall'istogramma della foto.
- Slider: esposizione (mezzi toni), contrasto (curva di stampa), filtri ingranditore (magenta↔verde, giallo↔blu), grana, halation. Doppio tap sull'etichetta = reset.
- **Lens** (portato da grain pro e migliorato, `web/lib/lens.js` + shader WebGPU `lens-gpu.js`): aberrazione cromatica laterale
  (calibrata in µm sul 35 mm, max 60 µm), vignettatura in luce lineare e falloff condiviso, applicati alla luce *prima* della pellicola.
- Zoom/pan: pizzica, trascina, doppio tap (adatta ↔ 100%). Tieni premuto **A/B** = originale.
- **Esporta**: piena risoluzione (max 12.5 MP) a tile 1024 px, una striscia alla volta passata in streaming a jpegli
  (worker, distance 1.0, 4:4:4, baseline sopra 6 MP perché il progressive tiene tutti i coefficienti DCT in heap),
  EXIF dell'originale preservati, download diretto.
- **Pipeline GPU**: la foto va sulla GPU una volta, come texture 8-bit; lens + ricostruzione tono + matrice colore girano
  come primo pass della catena del motore (shader in `lens-gpu.js`, `Engine.process_frame`) e l'uscita torna già RGBA 8-bit
  tramite la LUT di stampa. Nessun frame float attraversa JS↔wasm: ~4 ms di CPU per frame invece di ~100.
- **Texture** (−1..+1, dettaglio fine 15–60 µm): sotto zero il micro-dettaglio da ISP viene compresso verso una media
  edge-aware, e il peso di range si allarga così che anche i bordi si ammorbidiscono un po', come con una lente vintage;
  sopra zero il dettaglio viene restituito, con un limite.
- **Chiarezza** (−1..+1, adiacenza della pellicola, ~150 µm; negativa = resa morbida da stampa analogica): contrasto locale in luminanza log, con tap prefiltrati (niente aliasing
  né rumore all'export), pesi che ignorano i bordi forti (niente aloni) e maschera sui mezzitoni (ombre e alte luci invariate).
- **Polvere e graffi** (`web/lib/dust.js`): procedurali, niente texture. Granelli irregolari (alcuni sfocati), fibre a curvatura
  casuale, rari graffi lungo lo scorrimento della pellicola, in µm sul fotogramma 36 mm, quindi identici in anteprima ed export.
  Stanno sul negativo, quindi in stampa sono bianco carta. Layer separato: slider e **Rimescola** non ri-renderizzano nulla.
- Tocca la riga di stato per il **log**; se la scheda muore durante un export, al riavvio il log si apre da solo.

## Build locale

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100
./scripts/build-web.sh          # → web/pkg
python3 -m http.server -d web   # WebGPU richiede https o localhost
```

## Deploy

`.github/workflows/pages.yml` builda e pubblica `web/` su GitHub Pages a ogni push.
Una tantum: Settings → Pages → Source: **GitHub Actions**.

## Licenza

GPL-3.0 (derivato di spektrafilm / spektrafilm-rs). Profili e LUT: CC BY-SA 4.0.
