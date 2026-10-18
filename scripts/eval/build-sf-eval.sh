#!/usr/bin/env bash
# Build the CPU measurement harness (engine/target/release/sf-eval) and print the LD_LIBRARY_PATH it needs.
# openblas-src downloads OpenBLAS from GitHub inside its build script; behind the cloud agent proxy that download fails TLS, so on
# failure the tarball is fetched with curl into the build script's OUT_DIR and the build re-run (the build script then finds it).
set -euo pipefail
cd "$(dirname "$0")/../../engine"
OPENBLAS_VER=0.3.32
build() { cargo build -q --release -p spektrafilm-eval 2>&1; }
if ! out=$(build); then
  dir=$(ls -d target/release/build/openblas-src-*/out 2>/dev/null | head -1 || true)
  [ -n "$dir" ] || { echo "$out" >&2; exit 1; }
  echo "sf-eval: fetching OpenBLAS $OPENBLAS_VER into $dir" >&2
  curl -sSL "https://github.com/OpenMathLib/OpenBLAS/releases/download/v$OPENBLAS_VER/OpenBLAS-$OPENBLAS_VER.tar.gz" | tar xz -C "$dir"
  build >&2
fi
lib=$(dirname "$(find target/release/build -name 'libopenblas.so.0' | head -1)")
echo "$PWD/$lib"
