#!/usr/bin/env bash
# Build the wasm engine and its JS bindings into web/pkg.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --manifest-path engine/Cargo.toml --target wasm32-unknown-unknown -p spektrafilm-wasm --release
wasm-bindgen --target web --out-dir web/pkg \
  engine/target/wasm32-unknown-unknown/release/spektrafilm_wasm.wasm
