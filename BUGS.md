# Bug da sistemare

## Aperti

- **Striscia in alto sulle foto raw orizzontali** (DNG, ORF; trovato in v3.14, presente anche prima).
  A volte la prima striscia di upload della foto sulla GPU (le prime ~260 righe di un'anteprima 2000×1500) contiene le
  righe della striscia successiva: in alto compare un pezzo della foto spostato. Intermittente (due caricamenti identici
  danno risultati diversi); le foto verticali non risultano colpite. Visto in Chromium headless (WebGPU su SwiftShader):
  non ancora verificato su iPhone. Il codice JS / Rust copia i dati correttamente (`raw.js` uploadRaw →
  `set_frame_rows_f16` → `queue.write_texture`, wgpu copia in un ArrayBuffer nuovo a ogni chiamata), quindi il sospetto
  è sul driver / sull'ordine dei `writeTexture`. Idee: un unico `writeTexture` per l'anteprima, oppure strisce con
  `bytesPerRow` allineato a 256.

- **Tramonti: l'arancio saturo vira al giallo e si sbiadisce** (presente già in v3.15).
  Nuvola dorata IDG_20261010_183007_728, zona calda (L* > 45, tinta 40-95°): riferimento camera croma 33.5 / tinta 63°;
  v3.15 32.2 / 74°, v3.16 30.7 / 72°. Non è il bilanciamento del bianco: l'iPhone stima ~7650 K (scalda) e un WB diurno
  fisso peggiora (73°). Pista: risposta pellicola/scanner sui rossi-arancio; il confronto con un target IT8 misurato su
  Portra 400 (repo arufahc/negicc) mostra la densità del canale B/giallo sui rossi-arancio ~0.07 sotto il misurato.
