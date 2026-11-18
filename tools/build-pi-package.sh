#!/usr/bin/env bash
# Host-side builder for the pi-classic runtime package.
# Produces var/artifacts/pi-package.zip (+ .sha256) which the BB10 device pulls
# from this app's /artifacts/ endpoint (see the Pi agent pane).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$PWD"
SRC="$ROOT_DIR/var/toolkit-src"
OUT="$ROOT_DIR/var/artifacts"
TOOLKIT_URL=https://github.com/wesley138cn/bb10-classic-toolkit.git

mkdir -p "$OUT"

if [ -d "$SRC/.git" ]; then
  echo "Updating toolkit checkout in $SRC ..."
  git -C "$SRC" fetch --depth 1 origin main
  git -C "$SRC" reset --hard origin/main
else
  echo "Cloning toolkit into $SRC ..."
  rm -rf "$SRC"
  git clone --depth 1 "$TOOLKIT_URL" "$SRC"
fi

echo "Installing pinned npm dependencies (host) ..."
npm ci --prefix "$SRC/pi-classic/package" --ignore-scripts --omit=optional
npm ci --prefix "$SRC/pi-classic/build-tools" --ignore-scripts

echo "Applying BB10/QNX transforms and running host tests ..."
node "$SRC/pi-classic/transform-regex.cjs"
node "$SRC/pi-classic/test-unicode.mjs"
node "$SRC/pi-classic/test-curl-fetch.mjs"
node "$SRC/pi-classic/test-guard.mjs"

echo "Bundling ..."
node "$SRC/pi-classic/bundle.cjs"

echo "Placing bb10-main.mjs into the package tree ..."
cp "$SRC/pi-classic/main-bundle.mjs" \
  "$SRC/pi-classic/package/node_modules/@earendil-works/pi-coding-agent/dist/bb10-main.mjs"

echo "Packing package contents at the ZIP root ..."
rm -f "$OUT/pi-package.zip"
(cd "$SRC/pi-classic/package" && zip -qr "$OUT/pi-package.zip" .)

(cd "$OUT" && sha256sum pi-package.zip > pi-package.zip.sha256)

echo "Done:"
ls -la "$OUT"/pi-package.zip "$OUT"/pi-package.zip.sha256
echo "Serve with LISTEN_HOST=0.0.0.0 so the device can pull from /artifacts/."
