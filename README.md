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

## App (v2.0)

- Scegli foto → **input**: JPEG → decode EOTF → un'unica inversa generica display→scena (`web/lib/color.js`), nessuna
  misura della pipeline. DNG → luce lineare Rec.2020 con ColorMatrix + ForwardMatrix quando presente.
- **Gold 200 spettrale → scanner Frontier SP-3000** (motore, `scanner.frontier`): sensore LED RGB (proxy Status M), D-min
  per canale, bilanciamento per tipo di film, AutoSetup con guardia sulle alte luci, gradazione, saturazione. Il motore
  restituisce il positivo (`io.scan_film` + `scanner.model="frontier"`). Modello inferito: nessun dato misurato sullo
  SP-3000, vedi `eval/FRONTIER.md`.
- Slider: esposizione (guadagno di scena 2^EV prima della pellicola), contrasto (`frontier.contrast`), alte luci
  (`frontier.highlight`), filtri colore dello scanner magenta↔verde e giallo↔blu (`frontier.cmy`), nero (`frontier.black_lift`,
  neutro), texture, chiarezza, grana, halation, aberrazione, vignettatura, falloff, polvere (quantità). Auto = esposizione
  automatica del motore + `frontier_auto_setup`. Doppio tap sull'etichetta = reset.
- **Interno / luce scarsa** (interruttore in Tono e colore): sottoesposizione extra da EXIF (tempo, diaframma, ISO), 0–2 EV.
  Preselezionato dagli EXIF (luce sotto la portata di una compatta f/2.8 1/30 a 200 ISO).
- **Lens** (portato da grain pro e migliorato, `web/lib/lens.js` + shader WebGPU `lens-gpu.js`): aberrazione cromatica laterale
  (calibrata in µm sul 35 mm, max 60 µm), vignettatura in luce lineare e falloff condiviso, applicati alla luce *prima* della pellicola.
- Zoom/pan: pizzica, trascina, doppio tap (adatta ↔ 100%). Tieni premuto **A/B** = originale.
- **Esporta**: piena risoluzione (max 12.5 MP) a tile 1024 px, una striscia alla volta passata in streaming a jpegli
  (worker, distance 1.0, 4:4:4, baseline sopra 6 MP perché il progressive tiene tutti i coefficienti DCT in heap),
  EXIF dell'originale preservati, download diretto.
- **IG** (solo foto verticali): export per Instagram a 1080 px di larghezza (3:4 → 1080 × 1440 senza bordo; ≈1080 × 1431 con il bordo bianco, attivo di default), senza ritaglio. L'intera pipeline gira a quella dimensione, così la grana nasce alla risoluzione finale: resa a
  12 MP e poi ridotta si media via; a 1080 sopravvive alla ricompressione di Instagram (test interni, compressione simulata).
- **Pipeline GPU**: la foto va sulla GPU una volta, come texture 8-bit; lens + ingresso (inversa JPEG o matrice DNG) + matrice colore
  girano come primo pass della catena del motore (shader in `lens-gpu.js`, `Engine.process_frame`) e l'uscita torna già RGBA 8-bit
  tramite la LUT di uscita (scanner). Nessun frame float attraversa JS↔wasm: ~4 ms di CPU per frame invece di ~100.
- **Texture** (−1..+1): microcontrasto in luminanza log a ~60 µm (adiacenza della pellicola), edge-aware (niente aloni),
  solo sui mezzitoni, tap prefiltrati (niente aliasing all'export). Negativa = micro-toni più piatti.
- **Chiarezza** (0..1): bagliore dreamy in luce lineare (stile Orton, ~220 µm): la luce delle forme chiare si spande
  sui vicini più scuri, più un velo leggero; i dettagli restano. Sempre attivi: morbidezza ottica di lente + scanner
  (0.6 px) e compressione del crunch da ISP (15–60 µm).
- **Pulizia del colore** (sempre attiva, stadio d'ingresso): il rumore di colore del sensore del telefono, invisibile
  nella foto, la saturazione della pellicola lo amplificava ~5× in puntini colorati digitali. Come in laboratorio,
  si media solo la crominanza (RGB / luminanza) su due anelli, rispettando i bordi di luminanza: dettaglio e grana
  restano. Misurato: σC 2.4 → 0.8, colore/luminanza del rumore 0.64 → 0.17 (Gold di riferimento 0.18).
- **Polvere e graffi** (`web/lib/dust.js`): procedurali, niente texture. Granelli irregolari (alcuni sfocati), fibre a curvatura
  casuale, rari graffi lungo lo scorrimento della pellicola, in µm sul fotogramma 36 mm, quindi identici in anteprima ed export.
  Stanno sul negativo e, dopo l'inversione, appaiono bianchi. Layer separato: slider e **Rimescola** non ri-renderizzano nulla.
- **Nero** (0..1, default 0.15, mostrato come 15): neri sollevati dallo scanner, neutri nello spazio scanner.
- Tocca la riga di stato per il **log**; se la scheda muore durante un export, al riavvio il log si apre da solo.

### Validazione

- Harness `eval/` (`sf-eval chart` e `sf-eval image`, vedi `eval/README.md`): renderizza la carta colori o una foto DNG
  con le impostazioni dell'app e misura il risultato. Non include grana, polvere, lens, Texture e Chiarezza.
- Spec di accettazione `eval/gold200_spec.json` (`eval/SPEC.md`): **confidenza bassa sui valori assoluti**. Nessuna carta Gold 200
  misurata disponibile; i target sono priori da curve qualitative, recensioni e tolleranze larghe. Non leggerli come misure.
- Score carta attuale: **97.5** (`eval/calib/CALIB.md`, ultima calibrazione con guardia AutoSetup e black point 0.05).

## Versione

Il numero mostrato nell'app (`v2.0 · dd/mm hh:mm`, es. `v2.0 · 09/10 14:30`) viene dal file `VERSION`: si alza la seconda cifra a ogni rilascio
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
