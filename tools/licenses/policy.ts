// What may ship and what the notices must carry (ADR 0006): the license allowlist of decisions 2
// and 3 (with the OFL amendment for fonts), the two shipped artifacts and where their dependency
// closures start, and the hand-researched entries for software that is not an npm package of its
// own (C and C++ libraries compiled into the .wasm modules, the bundled font, SQLite).
//
// Changing this file is changing the license policy: say why in ADR 0006.

/** Permissive licenses compatible with GPLv3 (decision 2). */
export const PERMISSIVE: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'NCSA',
  'Unlicense',
  'Zlib',
  // SQLite's public-domain dedication ("The author disclaims copyright ... a blessing").
  'blessing',
]);

/** GPLv3, or GPL "or later" versions that include v3 (decision 2). */
export const GPL3_COMPATIBLE: ReadonlySet<string> = new Set([
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'GPL-2.0-or-later',
]);

/** MPL-2.0, unless the files carry the "Incompatible With Secondary Licenses" notice (decision 2). */
export const MPL = 'MPL-2.0';

/** LGPL 2.0 or 2.1, only for a separately loaded, replaceable module (decisions 2 and 4). */
export const LGPL: ReadonlySet<string> = new Set([
  'LGPL-2.0-only',
  'LGPL-2.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
]);

/** The SIL Open Font License, for font files only (the OFL amendment, ADR 0011). */
export const FONT: ReadonlySet<string> = new Set(['OFL-1.1', 'OFL-1.1-no-RFN', 'OFL-1.1-RFN']);

/** License exceptions that only add permissions, and the licenses they may modify. */
export const EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  'Open-CASCADE-Exception-1.0': ['LGPL-2.1-only', 'LGPL-2.1-or-later'],
  'LLVM-exception': ['Apache-2.0'],
};

/**
 * npm packages that are separately loaded, replaceable `.wasm` modules (decision 4), the only
 * place LGPL is allowed. apps/web's KNOWN_WASM (src/source/offer.ts) lists every shipped `.wasm`.
 */
export const SEPARATE_MODULES: ReadonlySet<string> = new Set([
  'libcascade',
  '@salusoft89/planegcs',
]);

/** Our own license (decision 1); every workspace package in a closure must declare it. */
export const OWN_LICENSE = 'GPL-3.0-or-later';

export type TargetName = 'web' | 'server';

/** Dependencies a package declares that its shipped files never import (ADR 0006 inventory notes). */
export interface NotShipped {
  package: string;
  /** Dependency names, or '*' for all of them. */
  dependencies: readonly string[] | '*';
  reason: string;
}

export interface Target {
  name: TargetName;
  /** Who reads the notices: the heading of the generated file. */
  title: string;
  /** Workspace packages (repository-relative) whose `dependencies` start the closure. */
  roots: readonly string[];
  notShipped: readonly NotShipped[];
  /** Repository-relative directories whose font files ship with this target (ADR 0011). */
  fontDirs: readonly string[];
}

export const TARGETS: readonly Target[] = [
  {
    name: 'web',
    title: 'the web app (apps/web)',
    roots: ['apps/web'],
    notShipped: [
      {
        package: 'manifold-3d',
        dependencies: '*',
        reason:
          'only manifold.js (the Emscripten glue) and manifold.wasm ship; its declared dependencies serve its ManifoldCAD tooling',
      },
      {
        package: 'sucrase',
        dependencies: ['commander', 'mz', 'pirates', 'tinyglobby'],
        reason: 'they serve its command line and require hook, which transform() never imports',
      },
    ],
    fontDirs: ['packages/text/fonts'],
  },
  {
    name: 'server',
    title: 'the sync server (apps/server)',
    // What `pnpm --filter @manufakture/server deploy --prod` installs beside dist/main.js; core
    // and sync are bundled into dist/ and their npm dependencies stay external (vite.config.ts).
    roots: ['apps/server'],
    notShipped: [],
    fontDirs: [],
  },
];

/** A notice for software that is not an npm package of its own (or whose package lacks the text). */
export interface ManualEntry {
  name: string;
  version: string;
  /** SPDX expression of the terms we take it under. */
  license: string;
  kind: 'component' | 'font';
  targets: readonly TargetName[];
  /** npm packages whose shipped files contain it; the entry ships when one of them does. */
  inside: readonly string[];
  /** Upstream source. */
  source: string;
  /** Repository-relative license texts, copied verbatim from upstream. */
  texts: readonly string[];
  /** Where the facts were read, and anything a reader should know. */
  note: string;
  /** Font files (repository-relative) and their SHA-256, for `kind: 'font'`. */
  files?: readonly { path: string; sha256: string }[];
}

const T = 'tools/licenses/texts';
const EMSCRIPTEN_MODULES = [
  'libcascade',
  '@salusoft89/planegcs',
  'manifold-3d',
  'web-ifc',
  '@jitl/quickjs-wasmfile-release-sync',
];
const WEB_IFC = (lib: string, commit: string) =>
  `compiled into web-ifc's .wasm; ${lib} is pinned to commit ${commit} in web-ifc's src/cpp/CMakeLists.txt (main, read 2026-10-03; ADR 0006), license file read from the repository at that commit (2026-10-04)`;

export const MANUAL_ENTRIES: readonly ManualEntry[] = [
  {
    name: 'Emscripten runtime and system libraries',
    version: 'as built into each module',
    license: 'MIT OR NCSA',
    kind: 'component',
    targets: ['web'],
    inside: EMSCRIPTEN_MODULES,
    source: 'https://github.com/emscripten-core/emscripten',
    texts: [`${T}/emscripten-LICENSE.txt`],
    note: "Every shipped .wasm is an Emscripten build and its glue is Emscripten's JavaScript. LICENSE read from the repository (main, 2026-10-04); the Emscripten version of each build is not recorded in the installed files.",
  },
  {
    name: 'musl libc (in Emscripten)',
    version: 'as built into each module',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: EMSCRIPTEN_MODULES,
    source: 'https://github.com/emscripten-core/emscripten/tree/main/system/lib/libc/musl',
    texts: [`${T}/musl-COPYRIGHT.txt`],
    note: "Emscripten's C library. COPYRIGHT read from Emscripten's repository (main, 2026-10-04).",
  },
  {
    name: 'LLVM runtime libraries (libc++, libc++abi, compiler-rt, in Emscripten)',
    version: 'as built into each module',
    license: 'Apache-2.0 WITH LLVM-exception',
    kind: 'component',
    targets: ['web'],
    inside: EMSCRIPTEN_MODULES,
    source: 'https://github.com/emscripten-core/emscripten/tree/main/system/lib/libcxx',
    texts: [`${T}/llvm-libcxx-LICENSE.txt`],
    note: "The C++ modules link Emscripten's libc++ and libc++abi (libcascade's .wasm names libc++abi sources). LICENSE.TXT read from Emscripten's repository (main, 2026-10-04); it also carries the legacy NCSA and MIT texts of older LLVM code.",
  },
  {
    name: 'mimalloc (in libcascade)',
    version: 'as built by Emscripten',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['libcascade'],
    source: 'https://github.com/emscripten-core/emscripten/tree/main/system/lib/mimalloc',
    texts: [`${T}/mimalloc-LICENSE.txt`],
    note: "libcascade links with -sMALLOC=mimalloc (dist/opencascade_single.provenance.json). LICENSE read from Emscripten's copy (main, 2026-10-04).",
  },
  {
    name: 'FreeType (in libcascade)',
    version: 'as built by Emscripten',
    license: 'FTL OR GPL-2.0-or-later',
    kind: 'component',
    targets: ['web'],
    inside: ['libcascade'],
    source: 'https://github.com/freetype/freetype',
    texts: [`${T}/freetype-FTL.txt`],
    note: "libcascade links with -sUSE_FREETYPE=1 (dist/opencascade_single.provenance.json). Portions of this software are copyright (c) The FreeType Project (www.freetype.org). All rights reserved. FTL.TXT read at VER-2-14-3, the tag of Emscripten's port on main (2026-10-04); the version in libcascade's build is not recorded. We take it under GPL-2.0-or-later or the FTL.",
  },
  {
    name: 'RapidJSON (in libcascade)',
    version: 'as built into OCCT',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['libcascade'],
    source: 'https://github.com/Tencent/rapidjson',
    texts: [`${T}/rapidjson-license.txt`],
    note: "OCCT's glTF reader uses it (rapidjson symbols in libcascade's .wasm). license.txt read from the repository (master, 2026-10-04). The parts under the JSON License it names are test data, not compiled in; msinttypes is for MSVC only.",
  },
  {
    name: 'Eigen (in planegcs)',
    version: 'as built into planegcs',
    license: 'MPL-2.0',
    kind: 'component',
    targets: ['web'],
    inside: ['@salusoft89/planegcs'],
    source: 'https://gitlab.com/libeigen/eigen',
    texts: [`${T}/eigen-COPYING.MPL2.txt`],
    note: 'Linked into the planegcs .wasm (spike T0.4). COPYING.MPL2 read from the repository (master, 2026-10-04).',
  },
  {
    name: 'Boost headers (in planegcs)',
    version: 'as built into planegcs',
    license: 'BSL-1.0',
    kind: 'component',
    targets: ['web'],
    inside: ['@salusoft89/planegcs'],
    source: 'https://github.com/boostorg/boost',
    texts: [`${T}/boost-LICENSE_1_0.txt`],
    note: 'Linked into the planegcs .wasm (spike T0.4). LICENSE_1_0.txt read from the repository (master, 2026-10-04).',
  },
  {
    name: 'Clipper2 (in manifold-3d)',
    version: 'as built into manifold-3d',
    license: 'BSL-1.0',
    kind: 'component',
    targets: ['web'],
    inside: ['manifold-3d'],
    source: 'https://github.com/AngusJohnson/Clipper2',
    texts: [`${T}/boost-LICENSE_1_0.txt`],
    note: "Manifold's CrossSection is built on it (Clipper2Lib symbols in manifold.wasm, 2026-10-04). Copyright Angus Johnson, under the Boost Software License 1.0, whose text follows.",
  },
  {
    name: 'fast_float (in web-ifc)',
    version: 'b0ab987b3dfdde13fa1915f65ef2a5c068d9208c',
    license: 'Apache-2.0 OR MIT OR BSL-1.0',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/fastfloat/fast_float',
    texts: [`${T}/fast_float-LICENSE-MIT.txt`],
    note: `${WEB_IFC('fast_float', 'b0ab987')}; we take it under MIT.`,
  },
  {
    name: 'tinynurbs (in web-ifc)',
    version: '47115cd9b6e922b27bbc4ab01fdeac2e9ea597a4',
    license: 'BSD-3-Clause',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/QuimMoya/tinynurbs',
    texts: [`${T}/tinynurbs-LICENSE.txt`],
    note: `${WEB_IFC('tinynurbs (the QuimMoya fork)', '47115cd')}.`,
  },
  {
    name: 'GLM (in web-ifc)',
    version: '8d1fd52e5ab5590e2c81768ace50c72bae28f2ed',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/g-truc/glm',
    texts: [`${T}/glm-copying.txt`],
    note: `${WEB_IFC('glm', '8d1fd52')}; offered under the Happy Bunny License or MIT, we take MIT.`,
  },
  {
    name: 'earcut.hpp (in web-ifc)',
    version: 'c68c8835ccff2b7532d31d8fa8dfcf398f629498',
    license: 'ISC',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/mapbox/earcut.hpp',
    texts: [`${T}/earcut.hpp-LICENSE.txt`],
    note: `${WEB_IFC('earcut.hpp', 'c68c883')}.`,
  },
  {
    name: 'CDT (in web-ifc)',
    version: '2068d015b9db3c92481e869b0c1f669b96a1d70a',
    license: 'MPL-2.0',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/artem-ogre/CDT',
    texts: [`${T}/CDT-LICENSE.txt`],
    note: `${WEB_IFC('CDT', '2068d01')}; its sources carry the Exhibit A header, not Exhibit B.`,
  },
  {
    name: 'spdlog (in web-ifc)',
    version: '79524ddd08a4ec981b7fea76afd08ee05f83755d',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/gabime/spdlog',
    texts: [`${T}/spdlog-LICENSE.txt`],
    note: `${WEB_IFC('spdlog', '79524dd')}.`,
  },
  {
    name: '{fmt} (in spdlog, in web-ifc)',
    version: 'as bundled by spdlog',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/fmtlib/fmt',
    texts: [`${T}/fmt-LICENSE.txt`],
    note: "spdlog bundles {fmt} and asks users to comply with its license. LICENSE read from fmt's repository at 11.1.4 (2026-10-04); the bundled version is not recorded.",
  },
  {
    name: 'stduuid (in web-ifc)',
    version: '3afe7193facd5d674de709fccc44d5055e144d7a',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/mariusbancila/stduuid',
    texts: [`${T}/stduuid-LICENSE.txt`],
    note: `${WEB_IFC('stduuid', '3afe719')}.`,
  },
  {
    name: 'unordered_dense (in web-ifc)',
    version: '1c8636e810d7e4a485d17bb9cbd6dccb5fe4e284',
    license: 'MIT',
    kind: 'component',
    targets: ['web'],
    inside: ['web-ifc'],
    source: 'https://github.com/martinus/unordered_dense',
    texts: [`${T}/unordered_dense-LICENSE.txt`],
    note: `${WEB_IFC('unordered_dense', '1c8636e')}.`,
  },
  {
    name: 'Inter Bold',
    version: '4.1',
    license: 'OFL-1.1-no-RFN',
    kind: 'font',
    targets: ['web'],
    inside: [],
    source: 'https://github.com/rsms/inter',
    texts: ['packages/text/fonts/OFL.txt'],
    note: "extras/ttf/Inter-Bold.ttf from the Inter 4.1 release, shipped unmodified as its own file (ADR 0011, ADR 0006 amendment). Copyright The Inter Project Authors; OFL.txt is the release's LICENSE.txt, verbatim.",
    files: [
      {
        path: 'packages/text/fonts/Inter-Bold.ttf',
        sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
      },
    ],
  },
  {
    name: 'SQLite (in better-sqlite3)',
    version: '3.53.4',
    license: 'blessing',
    kind: 'component',
    targets: ['server'],
    inside: ['better-sqlite3'],
    source: 'https://sqlite.org',
    texts: [`${T}/sqlite-blessing.txt`],
    note: "Compiled into better-sqlite3's native module from deps/sqlite3/sqlite3.c, whose header is quoted.",
  },
];

/**
 * License texts for packages that ship none, keyed `name@version` so a new version is read again.
 * The license id still comes from the package's own package.json.
 */
export const PACKAGE_TEXTS: Readonly<Record<string, { texts: readonly string[]; note: string }>> = {
  'abstract-logging@2.0.1': {
    texts: [`${T}/abstract-logging-MIT.txt`],
    note: 'The package ships no license file; the text is the MIT License with its author as copyright holder.',
  },
};

/** File names that hold a license text, and those that hold a NOTICE (Apache-2.0 section 4d). */
export const LICENSE_FILE = /^(licen[cs]e|copying|copyright)([.-].*)?$/i;
export const NOTICE_FILE = /^notice([.-].*)?$/i;
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
