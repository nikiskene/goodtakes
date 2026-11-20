#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
  echo "Build the Apple Silicon package on an Apple Silicon Mac." >&2
  exit 1
fi
workspace="$PWD/.tooling"
runtime="$PWD/src-tauri/resources/runtime"
bin="$PWD/src-tauri/binaries"
mkdir -p "$runtime/fonts" "$runtime/notices" "$bin" "$workspace/src"
bash scripts/setup-runtime.sh
ffmpeg_version=7.1.5
source="$workspace/src/ffmpeg-$ffmpeg_version"
if [[ ! -x "$source/ffmpeg" || ! -x "$source/ffprobe" ]]; then
  mkdir -p "$source"
  curl -fL --retry 2 "https://ffmpeg.org/releases/ffmpeg-$ffmpeg_version.tar.xz" -o "$source/source.tar.xz"
  printf "%s  %s\n" de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f "$source/source.tar.xz" | shasum -a 256 -c -
  tar -xJf "$source/source.tar.xz" -C "$source" --strip-components=1
  (
    cd "$source"
    export PKG_CONFIG_PATH="$(brew --prefix libass)/lib/pkgconfig:$(brew --prefix zimg)/lib/pkgconfig"
    ./configure --disable-autodetect --disable-doc --disable-ffplay --disable-network \
      --enable-videotoolbox --enable-libass --enable-libzimg \
      --extra-ldflags="-Wl,-headerpad_max_install_names"
    make -j "${GOODTAKE_BUILD_JOBS:-4}"
  )
fi
cp "$source/ffmpeg" "$source/ffprobe" "$workspace/bin/whisper-cli" "$workspace/bin/llama-cli" "$runtime"
cp "$source/COPYING.LGPLv2.1" "$runtime/notices/FFmpeg-LGPL-2.1.txt"
cp "$workspace/src/whisper.cpp-v1.7.6/LICENSE" "$runtime/notices/whisper.cpp-MIT.txt"
cp "$workspace/src/llama.cpp-b6500/LICENSE" "$runtime/notices/llama.cpp-MIT.txt"
cp LICENSES.md "$runtime/notices/"
cp assets/DejaVuSans-Bold.ttf "$runtime/fonts/"
mkdir -p "$runtime/notices/fonts"
cp assets/DejaVu-LICENSE.txt "$runtime/notices/fonts/"
python3 scripts/bundle_macos.py "$runtime"
"$runtime/ffmpeg" -hide_banner -encoders | grep -F h264_videotoolbox
"$runtime/ffmpeg" -hide_banner -filters | grep -F ' zscale '
"$workspace/venv/bin/pyinstaller" --clean --noconfirm --onefile --name goodtake-worker \
  --distpath "$workspace/packed" --workpath "$workspace/pyinstaller" --specpath "$workspace" engine/app.py
cp "$workspace/packed/goodtake-worker" "$bin/goodtake-worker-aarch64-apple-darwin"
npm run desktop -- build --config src-tauri/tauri.release.conf.json --target aarch64-apple-darwin
