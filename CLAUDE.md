# Working rules (finally-cool-film)

Personal, recreational project: Kodak Gold 200 + Frontier scan emulation, Rust/wasm engine on WebGPU, web app in `web/`.
The user writes Italian; answer in Italian, short, human bullet points.

## Branches and publishing
- `claude/spektrafilm-mobile-web-har40e` is the deploy branch (GitHub Pages). There is no `main`.
- Work on a side branch; publish (push to the deploy branch, bump `VERSION`) only with the user's explicit OK for that release.
- v4 is the default app since 4.0 (user's decision, without the planned blind test); v3 stays at `index.html?v3`.
  Work on `claude/v4`.

## How to change existing code
1. Read it all first (code, comments, `eval/*.md`, README entry). Many numbers have a measured reason; find it.
2. Understand why it is the way it is, and what it was fixing.
3. Say what is wrong with it (bug, duplication, dead path, number without a source) before changing it.
4. Fix while rewriting: no copy-paste of a broken pattern next to the fixed one.

## Code principles
- One source of truth: a parameter or formula lives in one place (e.g. `web/lib/interno.js` shared by app and eval);
  callers import it. No re-stated constants in two files.
- No magic numbers: every tuned constant gets a comment with what it does and where the value came from (measurement,
  datasheet, user choice). Unverified values are marked as such.
- Stage boundaries: scene → film conversion → film + grain → lab → scanner look → output. A control belongs to exactly
  one stage; do not let a slider act in two stages (v3 has documented exceptions, eval/V3.md: do not extend them).
- Match the surrounding style (comment density, naming); small functions over flags; delete dead code instead of
  commenting it out.
- Prefer measuring to guessing: `scripts/eval/check.py` (browser, ~5 min), `engine/target/release/sf-eval` (CPU, fast).

## Verification
- `python3 scripts/eval/check.py` before every publish. It shows what changed; an intended change is fine, an
  unexplained one is a bug. Never `--update` blindly; never `--cases __none__`.
- Show the user before/after images for any look change; numbers alone are not enough.
- Long jobs: check progress periodically and keep the user posted.
