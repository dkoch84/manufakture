#!/usr/bin/env bash
# Builds the gmsh mesher that packages/fea ships: an ES module plus a separate .wasm, made with
# Emscripten from pinned sources, without Blossom and without the contribs FEA does not use
# (ADR 0006, amendment of 2026-10-10; ADR 0017 decision 13).
#
# Everything is fetched into a work directory (default /tmp/fea-gmsh-build) without root:
#   - emsdk, its checkout pinned to EMSDK_COMMIT, the SDK to EMSDK_VERSION
#   - cmake and ninja from PyPI, pinned by version and hash (build/requirements.txt), in a
#     throwaway venv
#   - OpenCASCADE (OCCT) by release tarball, pinned by SHA-256
#   - gmsh by commit, fetched from upstream's git
# The versions are the ones @loumalouomega/gmsh-wasm 0.3.0 builds (its scripts/env.sh and its gmsh
# submodule), which the T9.0a spike measured; the build itself is ours: single-threaded (no
# OpenMP, no pthreads, so no SharedArrayBuffer), a memory the caller provides (the memory
# budget), and only the C API functions src/gmsh.ts calls (build/exported-functions.json). Two
# builds from the same work directory give byte-identical output (build-info.json's SHA-256).
#
# Output (packages/fea/wasm/): gmsh.mjs, gmsh.wasm, build-info.json and licenses/ (the texts that
# ship with the module, ADR 0006 decision 5). The build fails if gmsh's configuration names
# Blossom or the binary contains Blossom's strings.
#
# Usage: packages/fea/build/build-gmsh.sh [workdir]
# The OCCT stage took 12 to 20 minutes on 12 cores and is skipped when its install exists in the
# work directory (and was built with the same flags); the gmsh stage takes about 4 minutes.

set -euo pipefail

EMSDK_VERSION=3.1.74
EMSDK_COMMIT=35ff8a6d150541276abbc6bae512ca90bcfbe220
OCCT_VERSION=7.8.1
OCCT_SHA256=7321af48c34dc253bf8aae3f0430e8cb10976961d534d8509e72516978aa82f5
GMSH_REPO=https://gitlab.onelab.info/gmsh/gmsh.git
GMSH_COMMIT=29726e7237db13ff77ef3f2db2d7fb9499c4e65c # master, 2026-07-15 (gmsh 5.0.0)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${1:-/tmp/fea-gmsh-build}"
work="$(cd "${1:-/tmp/fea-gmsh-build}" && pwd)"
out="$(cd "$here/.." && pwd)/wasm"
jobs="${JOBS:-$(nproc)}"
mkdir -p "$out"
# gmsh's configure writes cmake_options.texi into the current directory: keep it in the work
# directory, not the caller's checkout.
cd "$work"

# Compile flags shared by OCCT and gmsh. Every object must agree on the exception model.
# JavaScript-based exceptions, as @loumalouomega/gmsh-wasm builds: with native wasm exceptions
# (-fwasm-exceptions) Emscripten 3.1.74's LLVM emits a try/delegate sequence in OCCT's
# ShapeUpgrade_ShapeDivide::Perform that Binaryen cannot parse ("popping from empty stack").
CFLAGS_COMMON="-fexceptions"

# --- emsdk ------------------------------------------------------------------------------------
if [ ! -d "$work/emsdk/.git" ]; then
  git clone -q https://github.com/emscripten-core/emsdk.git "$work/emsdk"
fi
if [ "$(git -C "$work/emsdk" rev-parse HEAD)" != "$EMSDK_COMMIT" ]; then
  git -C "$work/emsdk" fetch -q origin
  git -C "$work/emsdk" -c advice.detachedHead=false checkout -q "$EMSDK_COMMIT"
fi
(cd "$work/emsdk" && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source "$work/emsdk/emsdk_env.sh" >/dev/null 2>&1

# --- cmake and ninja --------------------------------------------------------------------------
if [ ! -x "$work/venv/bin/pip" ]; then
  python3 -m venv "$work/venv"
fi
# Versions and hashes in build/requirements.txt (cmake 4.4.3, ninja 1.13.2): pip refuses any file
# whose SHA-256 is not listed there.
"$work/venv/bin/pip" install -q --require-hashes --only-binary :all: --no-deps \
  -r "$here/requirements.txt"
export PATH="$work/venv/bin:$PATH"

# --- sources ----------------------------------------------------------------------------------
occt_src="$work/occt-$OCCT_VERSION"
if [ ! -f "$occt_src/CMakeLists.txt" ]; then
  tarball="$work/occt-$OCCT_VERSION.tar.gz"
  curl -fsSL -o "$tarball" \
    "https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V${OCCT_VERSION//./_}.tar.gz"
  echo "$OCCT_SHA256  $tarball" | sha256sum -c - >/dev/null
  rm -rf "$occt_src"
  mkdir -p "$occt_src"
  tar -xzf "$tarball" -C "$occt_src" --strip-components=1
fi

gmsh_src="$work/gmsh"
if [ ! -d "$gmsh_src/.git" ]; then
  git init -q "$gmsh_src"
  git -C "$gmsh_src" remote add origin "$GMSH_REPO"
fi
if [ "$(git -C "$gmsh_src" rev-parse -q --verify HEAD || true)" != "$GMSH_COMMIT" ]; then
  git -C "$gmsh_src" fetch -q --depth 1 origin "$GMSH_COMMIT"
  git -C "$gmsh_src" -c advice.detachedHead=false checkout -q "$GMSH_COMMIT"
fi

# --- OCCT: static libraries, the toolkits gmsh's OCC kernel links -----------------------------
occt_build="$work/occt-build"
occt_prefix="$work/occt-install"
if [ "$(cat "$occt_prefix/.flags" 2>/dev/null || true)" != "$CFLAGS_COMMON" ]; then
  rm -rf "$occt_build" "$occt_prefix"
fi
if [ ! -f "$occt_prefix/lib/libTKDESTEP.a" ]; then
  emcmake cmake -S "$occt_src" -B "$occt_build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_INSTALL_PREFIX="$occt_prefix" \
    -DCMAKE_C_FLAGS="$CFLAGS_COMMON" \
    -DCMAKE_CXX_FLAGS="$CFLAGS_COMMON" \
    -DBUILD_LIBRARY_TYPE=Static \
    -DBUILD_MODULE_Draw=OFF \
    -DBUILD_MODULE_Visualization=OFF \
    -DBUILD_MODULE_ApplicationFramework=ON \
    -DBUILD_MODULE_DataExchange=ON \
    -DBUILD_MODULE_ModelingAlgorithms=ON \
    -DBUILD_MODULE_ModelingData=ON \
    -DBUILD_MODULE_FoundationClasses=ON \
    -DBUILD_DOC_Overview=OFF \
    -DBUILD_USE_PCH=OFF \
    -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_TCL=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF \
    -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF -DUSE_VTK=OFF -DUSE_FREEIMAGE=OFF -DUSE_OPENVR=OFF \
    -DUSE_TBB=OFF \
    -DINSTALL_TEST_CASES=OFF >"$work/occt-cmake.log" 2>&1 || {
    tail -40 "$work/occt-cmake.log"
    exit 1
  }
  cmake --build "$occt_build" -j "$jobs" >"$work/occt-build.log" 2>&1 || {
    tail -60 "$work/occt-build.log"
    exit 1
  }
  # The install also tries to install a code generator (ExpToCasExe) whose .wasm companion
  # Emscripten does not emit: harmless. The toolkits gmsh needs are checked below.
  cmake --install "$occt_build" >"$work/occt-install.log" 2>&1 || true
  for tk in TKDESTEP TKDEIGES TKXSBase TKOffset TKFeat TKFillet TKBool TKMesh TKHLR TKBO TKPrim \
    TKShHealing TKTopAlgo TKGeomAlgo TKBRep TKGeomBase TKG3d TKG2d TKMath TKernel; do
    [ -f "$occt_prefix/lib/lib$tk.a" ] || {
      echo "OCCT install is missing lib$tk.a" >&2
      exit 1
    }
  done
  echo "$CFLAGS_COMMON" >"$occt_prefix/.flags"
fi

# --- gmsh: the library, every optional component off unless FEA needs it ----------------------
# DEFAULT=OFF turns every default-on option off; the ones FEA needs are switched on by name:
#   MESH, TETGENBR (3D boundary recovery for Delaunay and HXT), HXT (the default 3D algorithm),
#   OCC (STEP import with exact curved faces), EIGEN (MPL-2.0, header-only linear algebra), and
#   TINYOBJLOADER (MIT), which FEA does not use but gmsh 5.0.0 does not compile without
#   (src/geo/GModelIO_OBJ.cpp includes it unconditionally), and QUADMESHINGTOOLS (gmsh's own
#   licence), which FEA does not use either but which gmsh 5.0.0's mesh generation calls at the
#   end of every run (Generator.cpp, "FIXME TEST": without it the stub reports an error and
#   answers true, and gmsh then removes mesh entities with small edges); QUADMESHINGTOOLS needs
#   POST and SOLVER (gmsh's post-processing views and finite element solvers, gmsh's licence,
#   using Eigen for linear algebra) to compile.
# Blossom is named explicitly OFF so a change of gmsh's defaults cannot bring it back.
gmsh_build="$work/gmsh-build"
rm -rf "$gmsh_build"
emcmake cmake -S "$gmsh_src" -B "$gmsh_build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$CFLAGS_COMMON" \
  -DCMAKE_CXX_FLAGS="$CFLAGS_COMMON" \
  -DDEFAULT=OFF \
  -DENABLE_BUILD_LIB=ON -DENABLE_BUILD_SHARED=OFF -DENABLE_BUILD_DYNAMIC=OFF \
  -DENABLE_BLOSSOM=OFF \
  -DENABLE_MESH=ON -DENABLE_TETGENBR=ON -DENABLE_HXT=ON -DENABLE_EIGEN=ON \
  -DENABLE_QUADMESHINGTOOLS=ON -DENABLE_POST=ON -DENABLE_SOLVER=ON \
  -DENABLE_OPENMP=OFF -DENABLE_MPI=OFF -DENABLE_BLAS_LAPACK=OFF -DENABLE_GMP=OFF \
  -DENABLE_TINYOBJLOADER=ON -DENABLE_ZIPPER=OFF -DENABLE_TESTS=OFF \
  -DENABLE_OCC=ON -DENABLE_OCC_STATIC=ON -DENABLE_OCC_CAF=OFF \
  -DOCC_INC="$occt_prefix/include/opencascade" \
  -DCMAKE_FIND_ROOT_PATH="$occt_prefix" \
  -DCMAKE_LIBRARY_PATH="$occt_prefix/lib" \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH >"$work/gmsh-cmake.log" 2>&1 || {
  tail -40 "$work/gmsh-cmake.log"
  exit 1
}
config_h="$gmsh_build/src/common/GmshConfig.h"
config="$(sed -n 's/^#define GMSH_CONFIG_OPTIONS "\(.*\)"$/\1/p' "$config_h")"
echo "gmsh configuration:$config"
if grep -qi 'blossom' <<<"$config" || grep -q '^#define HAVE_BLOSSOM' "$config_h"; then
  echo "gmsh's configuration names Blossom: refusing to build" >&2
  exit 1
fi
for want in OpenCASCADE Hxt TetGen/BR Mesh QuadMeshingTools; do
  grep -q " $want\b" <<<" $config" || {
    echo "gmsh's configuration lacks $want" >&2
    exit 1
  }
done
CASROOT="$occt_prefix" cmake --build "$gmsh_build" --target lib -j "$jobs" >"$work/gmsh-build.log" 2>&1 || {
  tail -60 "$work/gmsh-build.log"
  exit 1
}
libgmsh="$(find "$gmsh_build" -name 'libgmsh.a' | head -1)"

# --- link: an ES module plus gmsh.wasm --------------------------------------------------------
# The OCCT toolkits are listed twice for their circular references. The memory is imported: the
# caller creates it with the memory budget as its maximum (src/gmsh.ts), so gmsh cannot grow past
# the budget. No filesystem beyond MEMFS (the STEP goes in as a file).
mapfile -t occt_libs < <(ls "$occt_prefix"/lib/libTK*.a)
emcc "$libgmsh" "${occt_libs[@]}" "${occt_libs[@]}" \
  -O3 $CFLAGS_COMMON -sWASM_BIGINT=1 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGmsh \
  -sENVIRONMENT=web,worker,node \
  -sIMPORTED_MEMORY=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=4MB \
  -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=@"$here/exported-functions.json" \
  -sEXPORTED_RUNTIME_METHODS=FS,wasmMemory,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  -sINCOMING_MODULE_JS_API=print,printErr,wasmMemory,locateFile,instantiateWasm,wasmBinary,noExitRuntime,onAbort \
  -o "$work/gmsh.mjs" >"$work/link.log" 2>&1 || {
  tail -40 "$work/link.log"
  exit 1
}

# --- checks: no Blossom in the binary ---------------------------------------------------------
# gmsh's own option help still names Blossom ("Mesh recombination algorithm (0: simple, 1:
# blossom, ...)", and the message that it was not compiled in); these strings come only from
# Blossom IV's code (contrib/blossom/MATCH) and from gmsh's call into it (meshGFaceOptimize.cpp,
# compiled only with HAVE_BLOSSOM). The prebuilt npm module contains all three.
for marker in 'Blossom: %d internal %d closed' 'blossoms have odd cardinality' \
  'blossoms meet exactly one matching edge'; do
  if grep -a -q -F "$marker" "$work/gmsh.wasm"; then
    echo "gmsh.wasm contains Blossom's code ('$marker'): refusing to ship it" >&2
    exit 1
  fi
done

cp "$work/gmsh.mjs" "$work/gmsh.wasm" "$out/"

# --- licences: what ships next to the .wasm (ADR 0006 decision 5) -----------------------------
lic="$out/licenses"
rm -rf "$lic"
mkdir -p "$lic"
cp "$gmsh_src/LICENSE.txt" "$lic/gmsh-LICENSE.txt"
cp "$gmsh_src/CREDITS.txt" "$lic/gmsh-CREDITS.txt"
cp "$occt_src/LICENSE_LGPL_21.txt" "$lic/occt-LICENSE_LGPL_21.txt"
cp "$occt_src/OCCT_LGPL_EXCEPTION.txt" "$lic/occt-OCCT_LGPL_EXCEPTION.txt"
# Emscripten's runtime and the system libraries it links: musl, libc++ and libc++abi.
em="$EMSDK/upstream/emscripten"
cp "$em/LICENSE" "$lic/emscripten-LICENSE.txt"
cp "$em/system/lib/libc/musl/COPYRIGHT" "$lic/musl-COPYRIGHT.txt"
cp "$em/system/lib/libcxx/LICENSE.TXT" "$lic/llvm-libcxx-LICENSE.txt"
# The contribs compiled in, each with its own licence text (build/components.json lists them).
for f in "$gmsh_src"/contrib/hxt/LICENSE.txt "$gmsh_src"/contrib/hxt/CREDITS.txt \
  "$gmsh_src"/contrib/eigen/COPYING.* "$gmsh_src"/contrib/tinyobjloader/LICENSE; do
  cp "$f" "$lic/$(basename "$(dirname "$f")")-$(basename "$f" .txt).txt"
done

cat >"$out/build-info.json" <<EOF
{
  "emscripten": "$(emcc --version | head -1 | sed 's/"/\\"/g')",
  "emsdk": "$EMSDK_VERSION",
  "emsdkCommit": "$(git -C "$work/emsdk" rev-parse HEAD)",
  "cmake": "$(cmake --version | head -1 | sed 's/^cmake version //')",
  "ninja": "$(ninja --version)",
  "gmsh": "$GMSH_COMMIT",
  "gmshConfig": "$(sed 's/^ *//' <<<"$config")",
  "occt": "$OCCT_VERSION",
  "mjsBytes": $(stat -c %s "$out/gmsh.mjs"),
  "wasmBytes": $(stat -c %s "$out/gmsh.wasm"),
  "wasmSha256": "$(sha256sum "$out/gmsh.wasm" | cut -d' ' -f1)"
}
EOF
cat "$out/build-info.json"
