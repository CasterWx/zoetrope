#!/usr/bin/env bash
# Build the zoetrope browser frontend (the `zoetrope-web` crate in `web/wasm/`)
# into `web/public/wasm/`, so the Astro /app route can load it. The bundled-demo
# loader runs on init; the upload / live-follow entry points are exported as
# `zoetrope_load` / `zoetrope_append`. Safe to run from anywhere — it resolves
# its own paths.
set -euo pipefail

cd "$(dirname "$0")/../wasm"  # -> web/wasm/, the crate root

# Config (target / dist / public_url / filehash) lives in web/wasm/Trunk.toml;
# the wasm32 default target and getrandom cfg in web/wasm/.cargo/config.toml.
# Both are picked up because trunk runs from here.
trunk build

# Trunk also emits its own index.html next to the artifacts. The /app route is
# Astro's, so drop the stray page (it would otherwise ship at /wasm/).
rm -f ../public/wasm/index.html

echo "wasm build -> web/public/wasm/ (web.js, web_bg.wasm, env.js)"
