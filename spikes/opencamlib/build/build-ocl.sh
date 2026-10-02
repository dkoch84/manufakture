#!/usr/bin/env bash
# Builds OpenCAMLib as an ES module plus a separate .wasm with Emscripten (T5.0b spike).
#
# Everything is fetched into a work directory (default /tmp/ocl-build) without root:
#   - emsdk, its checkout pinned to EMSDK_COMMIT, the SDK to EMSDK_VERSION
#   - cmake and ninja from PyPI, pinned, in a throwaway venv
#   - Boost headers (header-only use: foreach, graph), pinned by version and SHA-256
#   - aewallin/opencamlib, pinned to OCL_COMMIT
# The upstream emscriptenlib.cmake is replaced by ./emscriptenlib.cmake in a scratch copy of
# the checkout; the bindings (src/emscriptenlib/emscriptenlib.cpp) are upstream's, unchanged.
#
# Output: spikes/opencamlib/build/dist/ocl.mjs and ocl.wasm (gitignored, and ignored by lint and format like every dist/), plus build-info.json.
#
# Usage: spikes/opencamlib/build/build-ocl.sh [workdir]

set -euo pipefail

EMSDK_VERSION=6.0.10
EMSDK_COMMIT=e566f7bdcc7735f44037911c24b87a58a3c93145
CMAKE_VERSION=4.4.3 # PyPI package version
NINJA_VERSION=1.13.2 # PyPI package version
OCL_REPO=https://github.com/aewallin/opencamlib.git
OCL_COMMIT=95b036fe28ce6d77c97b98e5fbc337904ae49560 # master, 2025-02-12
BOOST_VERSION=1.89.0
BOOST_SHA256=85a33fa22621b4f314f8e85e1a5e2a9363d22e4f4992925d4bb3bc631b5a0c7a

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${1:-/tmp/ocl-build}"
out="$here/dist"
mkdir -p "$work" "$out"

# emsdk
if [ ! -d "$work/emsdk" ]; then
  git clone -q https://github.com/emscripten-core/emsdk.git "$work/emsdk"
fi
git -C "$work/emsdk" fetch -q origin
git -C "$work/emsdk" -c advice.detachedHead=false checkout -q "$EMSDK_COMMIT"
(cd "$work/emsdk" && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source "$work/emsdk/emsdk_env.sh" >/dev/null 2>&1

# cmake and ninja
if [ ! -x "$work/venv/bin/pip" ]; then
  python3 -m venv "$work/venv"
fi
"$work/venv/bin/pip" install -q "cmake==$CMAKE_VERSION" "ninja==$NINJA_VERSION"
export PATH="$work/venv/bin:$PATH"

# Boost headers
boost_dir="$work/boost_${BOOST_VERSION//./_}"
if [ ! -f "$boost_dir/LICENSE_1_0.txt" ]; then
  tarball="$work/boost.tar.bz2"
  curl -sSL -o "$tarball" "https://archives.boost.io/release/${BOOST_VERSION}/source/boost_${BOOST_VERSION//./_}.tar.bz2"
  echo "$BOOST_SHA256  $tarball" | sha256sum -c -
  tar -xjf "$tarball" -C "$work" "boost_${BOOST_VERSION//./_}/boost" \
    "boost_${BOOST_VERSION//./_}/LICENSE_1_0.txt"
fi

# OpenCAMLib at the pinned commit
if [ ! -d "$work/opencamlib/.git" ]; then
  git clone -q "$OCL_REPO" "$work/opencamlib"
fi
git -C "$work/opencamlib" fetch -q origin
git -C "$work/opencamlib" -c advice.detachedHead=false checkout -q "$OCL_COMMIT"

src="$work/ocl-src"
rm -rf "$src" "$work/ocl-out"
git -C "$work/opencamlib" archive --prefix=ocl-src/ HEAD | tar -x -C "$work"
cp "$here/emscriptenlib.cmake" "$src/src/emscriptenlib/emscriptenlib.cmake"

emcmake cmake -S "$src" -B "$work/ocl-out" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_EMSCRIPTEN_LIB=ON \
  -DUSE_OPENMP=OFF \
  -DBUILD_DOC=OFF \
  -DVERSION_STRING="$OCL_COMMIT" \
  -DBoost_INCLUDE_DIR="$boost_dir" \
  -DCMAKE_VERBOSE_MAKEFILE=OFF >"$work/cmake.log" 2>&1 || {
  tail -40 "$work/cmake.log"
  exit 1
}
start=$(date +%s)
cmake --build "$work/ocl-out" >"$work/build.log" 2>&1 || {
  tail -60 "$work/build.log"
  exit 1
}
end=$(date +%s)

cp "$work/ocl-out/ocl.mjs" "$work/ocl-out/ocl.wasm" "$out/"
# The license texts that would ship next to the .wasm (ADR 0006 decision 5).
mkdir -p "$out/licenses"
cp "$src/COPYING" "$out/licenses/opencamlib-COPYING.txt"
cp "$boost_dir/LICENSE_1_0.txt" "$out/licenses/boost-LICENSE_1_0.txt"
cp "$EMSDK/upstream/emscripten/LICENSE" "$out/licenses/emscripten-LICENSE.txt"
cat >"$out/build-info.json" <<EOF
{
  "emscripten": "$(emcc --version | head -1 | sed 's/"/\\"/g')",
  "emsdk": "$EMSDK_VERSION",
  "emsdkCommit": "$(git -C "$work/emsdk" rev-parse HEAD)",
  "cmake": "$(cmake --version | head -1 | sed 's/^cmake version //')",
  "ninja": "$(ninja --version)",
  "opencamlib": "$OCL_COMMIT",
  "boost": "$BOOST_VERSION",
  "buildSeconds": $((end - start)),
  "mjsBytes": $(stat -c %s "$out/ocl.mjs"),
  "wasmBytes": $(stat -c %s "$out/ocl.wasm"),
  "wasmSha256": "$(sha256sum "$out/ocl.wasm" | cut -d' ' -f1)"
}
EOF
cat "$out/build-info.json"
