#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: this script builds llama.cpp for macOS Apple Silicon" >&2
  exit 1
fi

version="b10237"
commit="2b63e0610bbc2be990ae1360d5256efcdc3f9efb"
depends_root="$(cd "$(dirname "$0")/.." && pwd)"
destination="$depends_root/llama/mac/bin"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/zoneclip-llama.XXXXXX")"
trap 'rm -rf "$temp_root"' EXIT

echo "==> Fetching llama.cpp $version"
git clone --quiet --depth 1 --branch "$version" https://github.com/ggml-org/llama.cpp.git "$temp_root/source"
actual_commit="$(git -C "$temp_root/source" rev-parse HEAD)"
if [[ "$actual_commit" != "$commit" ]]; then
  echo "error: llama.cpp commit mismatch: expected $commit, received $actual_commit" >&2
  exit 1
fi

cmake -S "$temp_root/source" -B "$temp_root/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DLLAMA_CURL=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON
cmake --build "$temp_root/build" --config Release --target llama-server --parallel

server="$temp_root/build/bin/llama-server"
if [[ ! -x "$server" ]]; then
  echo "error: llama-server was not produced at $server" >&2
  exit 1
fi
rm -rf "$destination"
mkdir -p "$destination"
cp "$server" "$destination/llama-server"
chmod 755 "$destination/llama-server"

printf '%s\n' "$version" > "$destination/VERSION"
echo "==> llama.cpp runtime ready: $destination"
