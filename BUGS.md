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
