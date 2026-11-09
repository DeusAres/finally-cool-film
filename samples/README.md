# samples

Test files for development (not deployed: the app is served from `web/`).

- `indigo/`: DNG files from Adobe Project Indigo, to build and test DNG support. Only the five used by
  `eval/check/cases.json` are kept (user, 2026-11-09). Other IDG_ names in code comments and docs are the frames those
  measurements were made on; the files were removed from the tree and remain in git history (`git log --all -- samples/indigo`).
- `olympus/`: raw files from Olympus / OM System cameras (`.ORF`), to build and test their support.

Upload on GitHub: open this folder → "Add file" → "Upload files".
The browser upload accepts files up to 25 MB; larger files need git (limit 100 MB per file).
