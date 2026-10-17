# Bug da sistemare

## Aperti

(nessuno)

## Risolti

- **Striscia in alto sulle foto raw orizzontali** (v3.18). Più `writeTexture` in coda sulla stessa texture: a volte la
  prima striscia riceveva i dati della seconda (5 casi su 6 con l'ORF orizzontale in Chromium/SwiftShader). Ora
  `set_frame_rows` / `set_frame_rows_f16` fanno `queue.submit` dopo ogni striscia: 6/6 corretti, DNG, rotazione ed
  export ok.

- **Tramonti: l'arancio saturo virava al giallo** (v3.19). Non era il bilanciamento del bianco né l'esposizione: la
  colorimetria della scena coincide con la camera; è la catena pellicola + scanner a spostare i giallo-arancio di ~+5°
  (opponente). Fix nello scanner: banda calda per tinta, `warm_hue_shift` 6° + `saturation_warm` 0.2. Nuvola
  IDG_20261010_183007_728: 71°/80° → 65°/74° (camera 63°/67°). Costo: fogliame giallo-verde vivo −6% di croma (la vecchia
  banda lo spingeva; la carta Gold lo dava già troppo saturo).
