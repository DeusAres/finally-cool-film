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
  ORF Olympus (`web/lib/orf.js`, v3.13): compressione Olympus a 12 bit (algoritmo di dcraw), nero / bilanciamento / ritaglio
  dal MakerNote, matrice colore Adobe del modello (tabella LibRaw); poi lo stesso sviluppo del DNG. Provato su XZ-1; l'ORF a 14 bit
  (OM-1 e successive) non è supportato.
- **Gold 200 spettrale → scanner Frontier SP-3000** (motore, `scanner.frontier`): sensore LED RGB (proxy Status M), D-min
  per canale, bilanciamento per tipo di film, AutoSetup con guardia sulle alte luci, gradazione, saturazione. Il motore
  restituisce il positivo (`io.scan_film` + `scanner.model="frontier"`). Modello inferito: nessun dato misurato sullo
  SP-3000, vedi `eval/FRONTIER.md`.
- Luci automatiche (v3, `web/lib/dodge.js`, `eval/V3.md`): dodging digitale stile Frontier Hyper Tone, dosato sulla foto e sul
  contrasto; slider Contrasto luci = contrasto locale dentro le luci; Ombre = schiarisce le zone scure grandi senza toccare il cielo. `index.html?v2` = app precedente.
- Slider: esposizione (guadagno di scena 2^EV prima della pellicola), contrasto (`frontier.contrast`), alte luci
  (`frontier.highlight`), bianchi (`frontier.whites`), filtri colore dello scanner magenta↔verde e giallo↔blu (`frontier.cmy`, mezzo tasto Frontier per passo da v3.34), nero (`frontier.black_lift`,
  neutro), texture, chiarezza, grana, halation, aberrazione, vignettatura, falloff, polvere (quantità). Auto = esposizione
  automatica del motore + `frontier_auto_setup`. Doppio tap sul cerchio dello slider (o sull'etichetta) = 0 / off, non il
  default di apertura. Esposizione −3…+3 EV (v3.33; l'Auto resta nel suo −2…+2.5 di prima).
- **Vividezza** (Colore, v3.33): solo manuale, 0 = off (stadio saltato, output identico). Croma in OkLab sulla scena prima della
  pellicola: forte sui colori spenti, quasi nulla sui saturi, zero sui grigi, pelle −85 %; mai oltre il tetto di croma per tinta
  misurato sulle scansioni Gold (`scripts/eval/kg200_chroma_ceiling.py`, diviso per il guadagno di croma della pellicola).
- **Temperatura luce** (Colore, v3.35): colore della luce sulla scena, prima della pellicola (la Gold è da luce diurna).
  3500–7500 K (destra = luce più calda), guadagni = bianco di Planck a quella temperatura / a 5500 K, a luminanza costante.
  Diverso da Giallo ↔ Blu (filtro dello scanner, dopo): qui la pellicola reagisce alla luce. A 5500 K guadagni esattamente 1.
- **Drag & drop** (v3.35): trascina una foto in qualsiasi punto della pagina, come Scegli foto.
- **ORF (v3.37)**: livello di saturazione del sensore misurato dall'istogramma (XZ-1: 3971, non 4095): le alte luci bruciate
  tornano neutre invece che magenta; file troncato → errore chiaro; aggiunti E-M10 (I–IIIS), OM-5, TG-5/6/7, Stylus 1, SH-2.
- **Interno / luce scarsa** (interruttore nella scheda **Luce**): sottoesposizione fissa di 2 EV prima della pellicola (`INTERNO_EV` in `web/lib/interno.js`), senza dati EXIF. Disattivato a ogni caricamento di foto.
- **Lens** (portato da grain pro e migliorato, `web/lib/lens.js` + shader WebGPU `lens-gpu.js`): aberrazione cromatica laterale
  (calibrata in µm sul 35 mm, max 60 µm), vignettatura in luce lineare e falloff condiviso, applicati alla luce *prima* della pellicola.
- Zoom/pan: pizzica, trascina, doppio tap (adatta ↔ 100%). Tieni premuto **A/B** = originale.
- Layout: su telefono (e tablet in verticale) le impostazioni stanno sotto la foto, in un pannello ridimensionabile con la
  maniglia. Su PC / tablet in orizzontale (finestra orizzontale ≥ 900 × 500 px) foto a sinistra e impostazioni in una
  colonna a destra (schede in alto); su PC: rotella = zoom, trascina = sposta, doppio clic = adatta ↔ 100%.
- **Trasforma** (v3.14): rotazione di 90° a sinistra / destra, per JPEG, HEIC, DNG e ORF, in anteprima e in export. Applicata alla
  sorgente (canvas per le immagini, mappatura degli indici dopo l'orientamento EXIF per i raw): dodge, AutoSetup, grana ed export
  vedono un fotogramma già dritto; slider ed esposizione restano.
- **Raddrizza** (Trasforma): righello a scorrimento stile iPhone (tacca ogni 1°, numero ogni 5°, ±45° al decimo di grado; trascina,
  rotella, frecce; scatta su 0 vicino allo zero; doppio tocco = 0; griglia dei terzi sulla foto mentre trascini). La foto ruota
  attorno al centro e viene ingrandita quanto basta perché non resti nessun angolo vuoto (stesso formato e stessa dimensione in
  uscita). È una trasformazione del campionamento nel passo d'ingresso (lib/tilt.js, GPU e CPU): vignettatura / caduta / aberrazione,
  grana, polvere e bordo restano sul fotogramma d'uscita; anteprima ed export usano le coordinate del fotogramma intero. L'angolo
  resta con la rotazione di 90°, torna a 0 con una nuova foto o con Azzera impostazioni. Esposizione Auto / AutoSetup / mappa del
  dodge sono misurate sul fotogramma intero (raddrizzare non cambia i toni). A 0° nessuna trasformazione (identico a prima).
- **Esporta**: piena risoluzione (max 12.5 MP) a tile 1024 px, una striscia alla volta passata in streaming a jpegli
  (worker, distance 1.0, 4:4:4, baseline sopra 6 MP perché il progressive tiene tutti i coefficienti DCT in heap),
  EXIF dell'originale preservati, download diretto.
- **Look Gold 200 (v3.16)**: rivisto in 6 giri con un revisore "Kodak Gold 200" su 3 foto molto diverse (luce piena con pelle e cielo,
  interno a luce calda, rocce scure ad alto contrasto): cieli azzurri (saturazione selettiva dei blu chiari nello scanner,
  `saturation_blue`, solo sopra luminanza ~0.22, così pelle, verdi e i blu scuri della carta non si muovono), dodge del cielo meno
  forte, mezzitoni e luci un po' più caldi, ombre profonde senza dominante blu, vignettatura 0.12 e falloff 0.25 di default, grana
  con meno rumore di colore (accoppiamento tra layer 0.45 → 0.72, colore/luminanza ~2.1 → ~1.1 nei mezzitoni). Override in
  `web/app.js` renderParams (`model`); per l'harness: `sf-eval chart --params eval/calib/look_v3.22.json`.
- **Look Gold 200 (v3.17)**: altri 8 giri con il revisore su 10 foto (incluse foto mai viste per verificare che il look
  generalizzi) e un consolidamento per ablazione (tolte le leve senza effetto misurabile). Nello scanner (LUT, costo zero):
  `saturation_blue` esteso ai cieli profondi, `green_hue_shift` solo sui verdi spenti, `saturation_warm` (ambra/pesca, pelle esclusa),
  `cool_neutral_warm` (grigi freddi scuri → neutro-caldi), `highlight_neutral` (bianchi meno gialli, non i caldi saturi).
  **Recupero luci locale** (dodge.js): quando Esposizione / Contrasto spingono le zone chiare verso il bianco, parte della spinta
  viene ripresa dalla loro base locale, come le Luci di Lightroom: texture dell'intonaco al sole 0.29 → 0.67 a Esposizione +0.6 /
  Contrasto +15. Vignettatura / falloff di partenza 0.12 / 0.18 (in v3.16 l'HTML partiva ancora da 0.65 / 0.4). Grana più
  monocromatica dove i tre strati divergono (cieli). Limiti noti in `BUGS.md`.
- **Tramonti / giallo-arancio (v3.19)**: pellicola + scanner rendevano i giallo-arancio ~5° più gialli della scena e del target
  Gold (nuvole al tramonto gialle invece che arancio). La banda calda dello scanner ora si sceglie per tinta (giallo-arancio,
  pelle e rossi esclusi, non i quasi-neutri): `warm_hue_shift` 6° verso il rosso + `saturation_warm` 0.2. Nuvola al tramonto
  tinta 71°/80° → 65°/74° (camera 63°/67°); interni caldi anche loro più vicini alla camera. Harness:
  `sf-eval chart --params eval/calib/look_v3.22.json` (carta 95.5 → 96.4).
- **Alte luci / Bianchi in negativo (v3.20)**: abbassarli ora scurisce le zone chiare *prima della pellicola* (locale, dalla stessa base
  del recupero luci), come bruciare in camera oscura: il negativo ha il dettaglio, quindi muri e cieli restano con texture e colore
  invece di diventare grigi piatti (muro al sole, Alte luci −0.6: texture 0.30 → 0.44, croma 10 → 17). In positivo restano sulla
  curva dello scanner, più delicata. A 0 l'immagine è identica al pixel.
- **Ombre ciano / verde oliva con Interno (v3.21)**: in v3.16 il piede della pellicola era stato neutralizzato (ombre senza dominante,
  per le rocce), e così gli interni avevano perso le ombre fredde tipiche di un Gold sottoesposto. Con Interno acceso il piede torna
  quello della pellicola (R 1.5, B 0.85, zona neutralizzata 2 EV, mezzitoni caldi conservati): gatto, ombre profonde a*/b* +6.6/+6.3 →
  −0.6/0.0. Con Interno spento l'immagine è identica al pixel a prima.
- **Blu e Interno (v3.22)**: confronto con scansioni Gold reali di cielo e mare. I cieli chiari avevano circa il doppio della
  croma e quelli profondi erano più viola: `saturation_blue` 1.0 → 0.15, nuova `blue_hue_shift` 17° verso il ciano solo sui blu
  medi / profondi (cielo alto, mare verde-acqua), l'orizzonte chiaro resta com'è. Carta 96.4 → 96.7 (fail 18 → 13). Con Interno il
  piede della pellicola è più marcato (R 1.9) e `cool_neutral_warm` è spento (scaldava proprio quelle ombre): ombre profonde e
  mezzitoni scuri teal-verde, niente velo magenta, stanza calda.
- **v3.23**: Alte luci / Bianchi in negativo senza artefatti: la v3.20 usava rampe troppo ripide (pendenza > 1), che su texture
  forti nelle luci (pieghe, pelo) invertivano i toni (posterizzazione, bordi disegnati). Ora la spinta cresce con una rampa morbida
  a pendenza ≤ 0.95 in totale: comprime, non inverte mai. Interno: bilanciamento verso verde / giallo (M −0.02, Y +0.04), i chiari
  restano crema e la contaminazione va al verde invece del velo magenta (gatto, chiari a*/b* +2.7/+1.8 → −0.2/+5.5).
- **v3.24**: contrasto alto senza contorni / posterizzazione nelle luci. Il recupero luci (v3.17), con Esposizione + Contrasto
  forti, agiva come una curva per pixel di pendenza fino a 0.75 sulle zone chiare con texture (pieghe, pelo): ora la sua rampa è più
  morbida (pendenza ≤ ~0.4). Gatto a Esposizione +0.5 / Contrasto +83: bordi creati 0.41 → 0.05; il muro al sole tiene un po' meno
  recupero ai contrasti estremi. Interno: lo spostamento verde / giallo è diviso per il fattore del Contrasto (a +83 l'immagine
  diventava verde). Default identici al pixel.
- **v3.25**: tasto **Azzera impostazioni** (scheda File): tutti gli slider a 0 / off, anche quelli con default diverso (grana,
  halation, texture…); Qualità JPEG, interruttori e rotazione restano. **Ombre** va da −100 a +100: in negativo scurisce le zone
  d'ombra prima della pellicola, che scendono nel piede del Gold (il suo limite naturale) invece di tagliarsi al nero. **Nero** si
  chiama **Nostalgia** (è il nero sollevato, l'effetto sbiadito).
- **Chiarezza (v3.26)**: rifatta. Prima era un glow "sognante" (sfocatura larga che colava la luce sui bordi), anche al default 10.
  Ora è contrasto locale dei mezzitoni come in Lightroom, da −100 a +100, prima della pellicola, a ~0.5 mm del fotogramma, con
  base attenta ai bordi (niente aloni sul profilo roccia / cielo). In negativo ammorbidisce i toni locali senza velo né sfocatura.
  Default 0; il glow è tolto anche dal look di base (differenza al default: ΔE medio 0.2–0.45).
- **Export IG (v3.27)**: come "Ridimensiona + Nitidezza per schermo" di Lightroom. Tela 1080×1440 (3:4, il formato della griglia
  dal 2025) in sRGB (il P3 su Instagram spegne i rossi saturi); la foto intera ci sta dentro, il resto è colore carta, così IG non
  taglia: vale anche per le orizzontali. La pellicola viene renderizzata al doppio, poi ridotta con Lanczos-3 in luce lineare
  (`web/lib/igout.js`) e resa nitida per schermo (maschera di contrasto sulla luminanza, σ 0.7 px, soglia morbida che non spinge
  la grana, passi limitati a 14 livelli: niente aloni). Gatto: dettaglio +32 %, grana invariata (0.33 → 0.36).
- **Interno (v3.29)**: ombre profonde e mezzitoni scuri teal-verdi (piede della pellicola), chiari crema / gialli senza magenta.
  Il pelo bianco del gatto (IDG_20261008_160856_907) diventava rosa per due cause, tolte: la scala del bilanciamento col Contrasto
  della v3.24 (ora è il contrario: col Contrasto il tasto magenta va più verso il verde) e la rotazione dei caldi della v3.19 (nata
  per un tramonto particolare, tolta per tutte le foto). Pelo (L* 60–80) a*/b* a Contrasto 0 / +50 / +83: +3.2/+25 · +6.2/+36 ·
  +4.0/+39 (prima +12/+35, riferimento preferito +1.6/+33); ombre profonde a* −7…−10.
- **Nitidezza (v3.30)**: un solo slider (−100…+100) al posto di Quantità / Raggio / Dettaglio / Maschera. Agisce sulla luce della
  scena *prima della pellicola*, quindi la grana (che nasce dopo, nel negativo) non viene mai resa più nitida; raggio fisso sul
  fotogramma (25 µm: uguale in anteprima ed export); soglia automatica sul rumore del sensore (più alta nelle ombre e sui pixel più
  fini dell'export); risultato tenuto dentro min / max dei vicini (niente aloni). In negativo ammorbidisce (obiettivo morbido).
  A +100: acutanza dei bordi +12 % muro, +30 % roccia, +12 % gatto; rumore nelle zone piatte +2 %; nessun bordo creato in più.
  Solo GPU (come Texture e Chiarezza). Default 0: immagine identica al pixel.
- **Grana (v3.31)**: tarata su 20 scansioni Gold 200 vere (`samples/kg200`, misure con `scripts/eval/grainstats.py` sulle zone
  piatte). La nostra era 3–4× più debole e, in proporzione, 3–4× più colorata (puntinato digitale, "strato appiccicato").
  Ora la grana è quasi tutta di luminanza (accoppiamento tra strati 0.72 → 0.97: colore/luma ~1.0 → ~0.45, Gold ~0.5) e il
  default è Grana 2.5× (~60–70 % della Gold misurata; 4× ≈ Gold). Interno: grana ×1.41 invece di ×2. Con la grana a 0
  l'immagine è identica al pixel a prima.
- **Grana più fine (v3.32)**: lo spettro della grana delle 10 scansioni Gold a frame intero ha ~12 % di potenza sotto i 40 µm
  di lunghezza d'onda e grumi (r50) di ~13.5 µm; la nostra 3 % / 18.6 µm (troppo morbida, non "a celle" mancanti). Nuvola di
  colorante 0.65 → 0.45 px di riferimento: 12 % / 14.8 µm. Il motore ora sceglie il kernel discreto che dà la stessa varianza
  della sfocatura integrata sul pixel (sotto ~1 px il kernel campionato sfocava troppo poco): l'anteprima non è più più granulosa
  dell'export visto alla stessa misura (prima +33 % con blur 0.45, +7 % con 0.65). Default 2.5× ≈ 80 % della Gold. Grana 0 invariata.
- **Qualità JPEG** (scheda File, v3.15): 10–100%, scala di jpegli; default 90% = l'export di prima (distance 1.0, identico al byte),
  100% = distance 0.1 (file ~3–4× più grandi). Doppio tap sull'etichetta = 90%. Vale anche per IG.
- **Bordo bianco** (scheda File, attivo di default): nell'export normale mantiene le proporzioni della foto (v3.36): 1 % del lato
  lungo sui lati lunghi, proporzionalmente più spesso sugli altri due (3:4 2736 × 3648 → 36 / 48 px → 2808 × 3744, 3:4 esatto).
- **IG** (qualsiasi orientamento, v3.27): tela fissa 1080 × 1440 (3:4), foto intera dentro senza ritaglio; col bordo almeno
  14 px per lato, il resto della tela va sopra / sotto (o ai lati). L'intera pipeline gira a quella dimensione, così la grana nasce alla risoluzione finale: resa a
  12 MP e poi ridotta si media via; a 1080 sopravvive alla ricompressione di Instagram (test interni, compressione simulata).
- **Pipeline GPU**: la foto va sulla GPU una volta, come texture 8-bit; lens + ingresso (inversa JPEG o matrice DNG) + matrice colore
  girano come primo pass della catena del motore (shader in `lens-gpu.js`, `Engine.process_frame`) e l'uscita torna già RGBA 8-bit
  tramite la LUT di uscita (scanner). Nessun frame float attraversa JS↔wasm: ~4 ms di CPU per frame invece di ~100.
- **Texture** (−1..+1): microcontrasto in luminanza log a ~60 µm (adiacenza della pellicola), edge-aware (niente aloni),
  solo sui mezzitoni, tap prefiltrati (niente aliasing all'export). Negativa = micro-toni più piatti.
- **Chiarezza** (0..1): bagliore dreamy in luce lineare (stile Orton, ~220 µm): la luce delle forme chiare si spande
  sui vicini più scuri, più un velo leggero; i dettagli restano. Sempre attivi: morbidezza ottica di lente + scanner
  (0.6 px) e compressione del crunch da ISP (15–60 µm).
- **Nitidezza della pellicola** (v3.11–3.12): lo scatter della luce nell'emulsione (core 2.2 / coda 9.3 µm) è a metà scala (`SCATTER_SCALE` in `web/app.js`):
  a scala piena toglieva ~35 % del dettaglio fine, visibile nelle luci dove la spalla non lascia contrasto (muri al sole). Il blur
  dye-cloud della grana agisce solo sulla grana, non sull'immagine (prima la Grana accesa ammorbidiva tutta la foto). Muro al sole,
  Grana 1.5 + Texture +100: dettaglio 0.035 → 0.060 (originale 0.068); toni invariati sui 10 DNG di prova; carta colori identica.
- **Pulizia del colore** (sempre attiva, stadio d'ingresso): il rumore di colore del sensore del telefono, invisibile
  nella foto, la saturazione della pellicola lo amplificava ~5× in puntini colorati digitali. Come in laboratorio,
  si media solo la crominanza (RGB / luminanza) su due anelli, rispettando i bordi di luminanza: dettaglio e grana
  restano. Misurato: σC 2.4 → 0.8, colore/luminanza del rumore 0.64 → 0.17 (Gold di riferimento 0.18).
- **Polvere e graffi** (`web/lib/dust.js`): procedurali, niente texture. Granelli irregolari (alcuni sfocati), fibre a curvatura
  casuale, rari graffi lungo lo scorrimento della pellicola, in µm sul fotogramma 36 mm, quindi identici in anteprima ed export.
  Stanno sul negativo e, dopo l'inversione, appaiono bianchi. Layer separato: slider e **Rimescola** non ri-renderizzano nulla.
  Tarati su scansioni reali: quasi solo granelli minuscoli (1–3 px a 12 MP, max ~0.2 mm), fibre rare, sottili, corte e
  arricciate, graffi rari e interrotti (tratti e pause, leggermente ondulati). I segni più vistosi compaiono solo alzando
  la quantità: al 27 % pochi granelli piccoli e quasi mai una fibra; a 1 un fotogramma maneggiato senza cura.
  Default 0 (off, v3.33); Rimescola a polvere spenta la accende al 27 %.
- **Nero** (0..1, default 0, mostrato come 0): neri sollevati dallo scanner, neutri nello spazio scanner.
- Tocca la riga di stato per il **log**; se la scheda muore durante un export, al riavvio il log si apre da solo.

### Validazione

- Harness `eval/` (`sf-eval chart` e `sf-eval image`, vedi `eval/README.md`): renderizza la carta colori o una foto DNG
  con le impostazioni dell'app e misura il risultato. Non include grana, polvere, lens, Texture e Chiarezza.
- Spec di accettazione `eval/gold200_spec.json` (`eval/SPEC.md`): **confidenza bassa sui valori assoluti**. Nessuna carta Gold 200
  misurata disponibile; i target sono priori da curve qualitative, recensioni e tolleranze larghe. Non leggerli come misure.
- Score carta attuale: **97.2** (`eval/calib/CALIB.md`, ultima calibrazione con guardia AutoSetup e black point 0.022).

## Versione

Il numero mostrato nell'app (`v2.0 · dd/mm hh:mm`, es. `v2.0 · 09/10 14:30`) viene dal file `VERSION` (`index.html?v2` riapre l'app precedente, con Alte luci / Bianchi / Nero): si alza la seconda cifra a ogni rilascio; all’avvio e al ritorno in primo piano l’app legge `version.txt` (senza cache) e si ricarica da sola se c’è un deploy nuovo (con una foto aperta: “tocca per aggiornare”)
(v1.1, v1.2…) e la prima per i cambi grossi. L'id del commit resta solo nei parametri anti-cache dei file.

## Build locale

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100
./scripts/build-web.sh          # → web/pkg
python3 -m http.server -d web   # WebGPU richiede https o localhost
```

## Deploy

`.github/workflows/pages.yml` builda e pubblica `web/` su GitHub Pages a ogni push su `main` o sul branch `claude/spektrafilm-mobile-web-har40e`, e manualmente (workflow_dispatch).
Una tantum: Settings → Pages → Source: **GitHub Actions**.

## Licenza

GPL-3.0 (derivato di spektrafilm / spektrafilm-rs). Profili e LUT: CC BY-SA 4.0.
