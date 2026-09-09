#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script prepares the macOS Apple Silicon Whisper runtime" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "error: ZoneClip supports the macOS Whisper runtime on Apple Silicon only" >&2
  exit 1
fi

version="v1.9.1"
commit="f049fff95a089aa9969deb009cdd4892b3e74916"
depends_root="$(cd "$(dirname "$0")/.." && pwd)"
destination="$depends_root/whisper/mac/bin"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/zoneclip-whisper.XXXXXX")"
trap 'rm -rf "$temp_root"' EXIT

echo "==> Fetching whisper.cpp $version"
git clone --quiet --depth 1 --branch "$version" https://github.com/ggml-org/whisper.cpp.git "$temp_root/source"
actual_commit="$(git -C "$temp_root/source" rev-parse HEAD)"
if [[ "$actual_commit" != "$commit" ]]; then
  echo "error: whisper.cpp commit mismatch: expected $commit, received $actual_commit" >&2
  exit 1
fi

cmake -S "$temp_root/source" -B "$temp_root/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=ON
cmake --build "$temp_root/build" --config Release --target whisper-server --parallel

server="$temp_root/build/bin/whisper-server"
if [[ ! -x "$server" ]]; then
  echo "error: whisper-server was not produced at $server" >&2
  exit 1
fi
mkdir -p "$destination"
cp "$server" "$destination/whisper-server"
chmod 755 "$destination/whisper-server"
printf '%s\n' "$version" > "$destination/VERSION"
echo "==> Whisper runtime ready: $destination"
