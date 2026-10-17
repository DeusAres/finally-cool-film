# Bug da sistemare

## Aperti

- **Tramonti: l'arancio saturo vira al giallo e si sbiadisce** (presente già in v3.15).
  Nuvola dorata IDG_20261010_183007_728, zona calda (L* > 45, tinta 40-95°): riferimento camera croma 33.5 / tinta 63°;
  v3.15 32.2 / 74°, v3.16 30.7 / 72°. Non è il bilanciamento del bianco: l'iPhone stima ~7650 K (scalda) e un WB diurno
  fisso peggiora (73°). Pista: risposta pellicola/scanner sui rossi-arancio; il confronto con un target IT8 misurato su
  Portra 400 (repo arufahc/negicc) mostra la densità del canale B/giallo sui rossi-arancio ~0.07 sotto il misurato.

## Risolti

- **Striscia in alto sulle foto raw orizzontali** (v3.18). Più `writeTexture` in coda sulla stessa texture: a volte la
  prima striscia riceveva i dati della seconda (5 casi su 6 con l'ORF orizzontale in Chromium/SwiftShader). Ora
  `set_frame_rows` / `set_frame_rows_f16` fanno `queue.submit` dopo ogni striscia: 6/6 corretti, DNG, rotazione ed
  export ok.
