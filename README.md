# finally cool film

Porting mobile web di [spektrafilm](https://github.com/andreavolpato/spektrafilm): simulazione spettrale
di pellicola → scansione, nel browser via WebAssembly + WebGPU. Focus: Kodak Gold 200 da foto iPhone.

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
  **Esposizione** = campana sui mezzi toni, spalla morbida (niente alte luci bruciate). **Auto** parte dall'istogramma della foto.
- Slider: esposizione, contrasto, alte luci, filtri colore dello scanner (magenta↔verde, giallo↔blu), nero, texture, chiarezza, grana, stampa (look da stampa con viraggio Gold), halation, aberrazione, vignettatura, falloff, polvere (quantità). Doppio tap sull'etichetta = reset.
- **Lens** (portato da grain pro e migliorato, `web/lib/lens.js` + shader WebGPU `lens-gpu.js`): aberrazione cromatica laterale
  (calibrata in µm sul 35 mm, max 60 µm), vignettatura in luce lineare e falloff condiviso, applicati alla luce *prima* della pellicola.
- Zoom/pan: pizzica, trascina, doppio tap (adatta ↔ 100%). Tieni premuto **A/B** = originale.
- **Esporta**: piena risoluzione (max 12.5 MP) a tile 1024 px, una striscia alla volta passata in streaming a jpegli
  (worker, distance 1.0, 4:4:4, baseline sopra 6 MP perché il progressive tiene tutti i coefficienti DCT in heap),
  EXIF dell'originale preservati, download diretto.
- **IG** (solo foto verticali): export per Instagram a 1080 px di larghezza (3:4 → 1080 × 1440 senza bordo; ≈1080 × 1431 con il bordo bianco, attivo di default), senza ritaglio. L'intera pipeline gira a quella dimensione, così la grana nasce alla risoluzione finale: resa a
  12 MP e poi ridotta si media via; a 1080 sopravvive alla ricompressione di Instagram (test interni, compressione simulata).
- **Pipeline GPU**: la foto va sulla GPU una volta, come texture 8-bit; lens + ricostruzione tono + matrice colore girano
  come primo pass della catena del motore (shader in `lens-gpu.js`, `Engine.process_frame`) e l'uscita torna già RGBA 8-bit
  tramite la LUT di stampa. Nessun frame float attraversa JS↔wasm: ~4 ms di CPU per frame invece di ~100.
- **Texture** (−1..+1): microcontrasto in luminanza log a ~60 µm (adiacenza della pellicola), edge-aware (niente aloni),
  solo sui mezzitoni, tap prefiltrati (niente aliasing all'export). Negativa = micro-toni più piatti.
- **Chiarezza** (0..1): bagliore dreamy in luce lineare (stile Orton, ~220 µm): la luce delle forme chiare si spande
  sui vicini più scuri, più un velo leggero; i dettagli restano. Sempre attivi: morbidezza ottica di lente + scanner
  (0.6 px) e compressione del crunch da ISP (15–60 µm).
- **Colore Gold 200** (misurato su 9 scansioni Gold 200): neutri giallo puro, b\* ~+10 in ombre e mezzitoni, ~+3 nelle
  luci, a\* ~0 (`GOLD` in grain.js). Prima della pellicola, per ogni foto, si toglie il 70% della dominante dei pixel
  quasi neutri (`castGains` in app.js), come l'operatore di laboratorio: es. il magenta dell'iPhone in interni.
- **Scansione diretta, niente carta**: Instagram è RGB su schermo, quindi la catena è pellicola → scanner. Il motore
  restituisce il negativo (`io.scan_film`), l'app lo inverte come uno scanner (`scan.js`): per canale toglie la base
  arancio, normalizza la gamma e applica una S morbida senza nero/bianco di carta; il fit è sulla scala dei grigi.
- **Contrasto**: pendenza attorno al grigio medio, che si spegne sotto −1 EV (le ombre tengono il dettaglio).
  **Alte luci** abbassa il bianco fino a −0.6 stop. I livelli per foto spostano nero/bianco al massimo di 3/2 L\*.
- **Nero** (0..1, default 0.15, mostrato come 15): neri sollevati dallo scanner con tinta ciano-verde che cresce con il sollevamento.
- **Polvere e graffi** (`web/lib/dust.js`): procedurali, niente texture. Granelli irregolari (alcuni sfocati), fibre a curvatura
  casuale, rari graffi lungo lo scorrimento della pellicola, in µm sul fotogramma 36 mm, quindi identici in anteprima ed export.
  Stanno sul negativo e, dopo l'inversione, appaiono bianchi. Layer separato: slider e **Rimescola** non ri-renderizzano nulla.
- Tocca la riga di stato per il **log**; se la scheda muore durante un export, al riavvio il log si apre da solo.

## Versione

Il numero mostrato nell'app (`v1.3 · dd/mm hh:mm`, es. `v1.3 · 08/10 14:30`) viene dal file `VERSION`: si alza la seconda cifra a ogni rilascio
(v1.1, v1.2…) e la prima per i cambi grossi. L'id del commit resta solo nei parametri anti-cache dei file.

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
