#!/usr/bin/env bash
# Cache-busting for the deployed site: append ?v=<version> to every module
# import, the entry scripts, the export worker, jpegli and the wasm binary.
# GitHub Pages caches each file separately, so without this Safari can mix a
# fresh index.html with a stale app.js (or a stale wasm with new glue code).
# Operates in place on the given web directory (CI runs it on the build output).
set -euo pipefail
dir="${1:-web}"
v="${2:-$(git rev-parse --short HEAD)}"
js=$(find "$dir" -name '*.js' -not -path "$dir/vendor/*")
# Static ES module imports: from './x.js' / '../pkg/x.js'
sed -i -E "s#(from ')(\.{1,2}/[^'?]+\.js)'#\1\2?v=$v'#g" $js
sed -i -E "s#src=\"(app|bench)\.js\"#src=\"\1.js?v=$v\"#" "$dir"/*.html
# Visible build label (app.js BUILD): v<VERSION> (+ debug) · commit time (Rome).
# The commit id ($v) stays in the cache-busting query strings only.
when=$(TZ=Europe/Rome date -d "@$(git log -1 --format=%ct 2>/dev/null || date +%s)" '+%d/%m %H:%M')
label="v$(cat "$(dirname "$0")/../VERSION" 2>/dev/null || echo 0)"
case "$v" in dbg-*) label="$label debug" ;; esac
sed -i "s#'__BUILD__'#'$label · $when'#" "$dir/app.js"
sed -i "s#new Worker('export-worker.js')#new Worker('export-worker.js?v=$v')#" "$dir/app.js"
sed -i "s#importScripts('vendor/jpegli_wasm2.js')#importScripts('vendor/jpegli_wasm2.js?v=$v')#" "$dir/export-worker.js"
sed -i "s#new URL('spektrafilm_wasm_bg.wasm', import.meta.url)#new URL('spektrafilm_wasm_bg.wasm?v=$v', import.meta.url)#" "$dir/pkg/spektrafilm_wasm.js"
# Fail loudly if a pattern stopped matching (e.g. after a refactor).
for f in "$dir/app.js" "$dir/export-worker.js" "$dir/pkg/spektrafilm_wasm.js" "$dir/index.html"; do
  grep -q "?v=$v" "$f" || { echo "stamp-version: nothing stamped in $f" >&2; exit 1; }
done
grep -q "__BUILD__" "$dir/app.js" && { echo "stamp-version: build label not stamped" >&2; exit 1; }
echo "stamped $v ($when)"
