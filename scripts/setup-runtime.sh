#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
workspace="$PWD/.tooling"
mkdir -p "$workspace/src" "$workspace/bin"
python3 -m venv "$workspace/venv"
"$workspace/venv/bin/pip" install numpy==2.2.6 pyinstaller==6.14.2 certifi==2025.11.12

build_cli() {
  local repo="$1" version="$2" binary="$3" checksum="$4"
  shift 4
  if [[ -x "$workspace/bin/$binary" ]]; then return; fi
  local source="$workspace/src/$repo-$version"
  mkdir -p "$source"
  curl -fL --retry 2 "https://codeload.github.com/ggml-org/$repo/tar.gz/refs/tags/$version" -o "$source/source.tar.gz"
  printf "%s  %s\n" "$checksum" "$source/source.tar.gz" | shasum -a 256 -c -
  tar -xzf "$source/source.tar.gz" -C "$source" --strip-components=1
  cmake -S "$source" -B "$source/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_CCACHE=OFF "$@"
  cmake --build "$source/build" --target "$binary" --parallel "${GOODTAKE_BUILD_JOBS:-4}"
  cp "$source/build/bin/$binary" "$workspace/bin/$binary"
}
build_cli whisper.cpp v1.7.6 whisper-cli 166140e9a6d8a36f787a2bd77f8f44dd64874f12dd8359ff7c1f4f9acb86202e -DWHISPER_BUILD_TESTS=OFF
build_cli llama.cpp b6500 llama-cli f2a188b194f25178460eecda7a7619b34d0b53421588faa2e6f0287a96674f28 -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF
