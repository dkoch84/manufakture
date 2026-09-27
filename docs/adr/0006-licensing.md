# 0006: Licensing: GPL-3.0-or-later, and what we may depend on

- Status: accepted
- Date: 2026-09-26

## Context

The [product decisions](../decisions/0000-product-decisions.md) made manufakture GPL-3.0-or-later: copyleft, and version 3 because Apache-2.0 dependencies are compatible with GPLv3 but not with GPLv2. They also require OpenCASCADE, which is LGPL, to be loaded as a separate, replaceable `.wasm`, which satisfies the LGPL's relinking requirement. The repository is public.

The spikes found the licenses of the kernel and solver candidates: [T0.2](../spikes/T0.2-occt.md) for libcascade, [T0.3](../spikes/T0.3-wrapper.md) for replicad, brepjs, occt-wasm and brepkit-wasm, and [T0.4](../spikes/T0.4-planegcs.md) for planegcs, the libraries linked into it, Ansatz and SolveSpace. This ADR turns that into rules and a snapshot inventory, so later tasks can add dependencies without re-deciding.

## Decision

1. **Everything in this repository is GPL-3.0-or-later**: the `LICENSE` file is the GPLv3 text, and every `package.json` (app, packages, spikes) says `GPL-3.0-or-later`.
2. **Allowed dependency licenses**, for anything shipped to users:
   - permissive licenses compatible with GPLv3, such as MIT and Apache-2.0;
   - MPL-2.0, whose files stay under MPL-2.0, provided they are not marked "Incompatible With Secondary Licenses" (such files are not GPL-compatible);
   - GPLv3, or GPL "or later" versions that include v3;
   - LGPL (2.0 or 2.1, "only" or "or later", with or without the Open CASCADE exception), **only** as a separately loaded, replaceable module, which for us means a `.wasm` plus its glue, never bundled into our JavaScript.
3. **Not allowed**: AGPL (including AGPL kernels such as `brepkit-wasm` 3.x), GPL-2.0-only, licenses that restrict use or field of use, and code with no license. AGPL is excluded even though GPLv3 permits combining with it: the combined work would carry AGPL's network-use clause, which would reach the M7 server, and the project stays plain GPL.
4. **LGPL modules stay replaceable.** OCCT ([ADR 0002](0002-kernel-build-and-loading.md)) and planegcs ([ADR 0003](0003-sketch-solver.md)) are each emitted as their own asset and loaded at run time. When we build them ourselves, the build configuration and any C++ we add live in this repository under its license, and the result is still a separate `.wasm`.
5. **Notices ship with the app.** The built app includes the license texts of every bundled dependency and every `.wasm` module, with the versions shipped. Generating that file, and a CI check of production dependency licenses against the allowlist above, is a follow-up task.
6. **Verify before adding.** A new dependency's license is read from its installed `package.json` and its license file, not from memory or a registry summary. If they disagree, the stricter reading applies until resolved. Development-only tooling that is not shipped is out of scope.

### Inventory

"installed package.json" means the license field was read from the package installed in this repository's `node_modules` on 2026-09-26; the table was last checked against the workspace `package.json` files that day, after `packages/core`, `packages/io` and `apps/web` gained runtime dependencies. "T0.x only" means the license is taken from that spike write-up and was not re-checked here. "unverified" means neither: check it before adoption.

| Component                       | Version    | License                                       | Use                   | Verified from          |
| ------------------------------- | ---------- | --------------------------------------------- | --------------------- | ---------------------- |
| manufakture (this repository)   | 0.0.0      | GPL-3.0-or-later                              | our code              | root package.json      |
| libcascade (OCCT 8.0.1)         | 3.0.2      | LGPL-2.1-only WITH Open-CASCADE-Exception-1.0 | kernel (ADR 0002)     | installed package.json |
| @salusoft89/planegcs            | 1.2.0      | LGPL-2.0-or-later                             | solver (ADR 0003)     | installed package.json |
| Eigen, Boost (in planegcs wasm) | bundled    | MPL-2.0, BSL-1.0                              | inside planegcs       | T0.4 only              |
| three                           | 0.186.1    | MIT                                           | viewport              | installed package.json |
| comlink                         | 4.4.2      | Apache-2.0                                    | worker RPC (ADR 0007) | installed package.json |
| react, react-dom                | 19.3.0     | MIT                                           | UI                    | installed package.json |
| scheduler                       | 0.28.0     | MIT                                           | inside react-dom      | installed package.json |
| zustand                         | 5.0.15     | MIT                                           | UI state              | installed package.json |
| zod                             | 4.6.5      | MIT                                           | document schema       | installed package.json |
| fflate                          | 0.8.3      | MIT                                           | 3MF, .mfk zip         | installed package.json |
| manifold                        | none yet   | Apache-2.0                                    | later                 | unverified             |
| web-ifc                         | none yet   | MPL-2.0                                       | later                 | unverified             |
| replicad                        | 1.1.0      | MIT                                           | rejected (ADR 0001)   | installed package.json |
| replicad-opencascadejs          | 1.1.0      | LGPL-2.1-only                                 | rejected (ADR 0001)   | installed package.json |
| brepjs                          | 20.0.0     | Apache-2.0                                    | rejected (ADR 0001)   | installed package.json |
| occt-wasm                       | 5.3.5      | MIT OR Apache-2.0                             | fallback (ADR 0001)   | installed package.json |
| brepkit-wasm                    | from 3.0.0 | AGPL-3.0-only                                 | excluded (AGPL)       | T0.3 only              |
| ansatz-wasm                     | 0.3.0      | MIT                                           | watch list            | T0.4 only              |
| SolveSpace libslvs              | n/a        | GPLv3                                         | watch list            | T0.4 only              |

Notes on the inventory:

- **planegcs** declares `LGPL-2.0-or-later` in npm metadata, while its repository's `LICENSE` file is LGPL 2.1, its wrapper sources say "2.1 or later" and FreeCAD's solver sources say "Library GPL version 2 or later" (T0.4). Every variant is "or later", so it can be used under terms compatible with GPL-3.0-or-later, and it is kept a separate `.wasm` regardless.
- **occt-wasm**'s package license covers its tooling and TypeScript layer; the OCCT `.wasm` inside it is LGPL-2.1-only (T0.3).
- **zod** is a runtime dependency of `packages/core`, which validates documents and commands with it ([ADR 0004](0004-document-format.md)).
- **fflate** is a runtime dependency of `packages/io` (3MF writing and reading) and `apps/web` (the `.mfk` document archive).
- **comlink** is a runtime dependency of `packages/kernel` and `packages/regen`; **three**, **react**, **react-dom** and **zustand** are runtime dependencies of `apps/web`. **scheduler** is the one runtime dependency these pull in; the others have none.
- **manifold** and **web-ifc** are not installed, so their licenses are as stated in the task plan and unverified. Their exact package names and versions are decided when they are adopted.
- **replicad** is MIT (T0.3). The product decisions first listed it as Apache-2.0 and have been corrected; ADR 0001 rejected replicad anyway, so nothing changes.
- Development-only packages (the test runners including `@playwright/test`, lint, types, the build tooling) are not shipped and are not listed (decision 6).

## Alternatives considered

- **MIT or Apache-2.0 for the project**, the initial plan. Superseded by the product decisions, which chose copyleft.
- **GPL-2.0.** Apache-2.0 dependencies are not compatible with GPLv2; the product decisions chose v3 for that reason.
- **Allowing AGPL kernels.** Would widen the kernel choice (brepkit), at the cost of AGPL's network-use clause on the combined work. Rejected.
- **Bundling OCCT into the application JavaScript.** Smaller request count, but it would defeat the LGPL's replaceability. Rejected by the product decisions.

## Consequences

- Every new runtime dependency needs a license check and a row in the shipped notices; the table above is a snapshot and is not kept current by hand.
- Kernel and solver stay separate assets for good, including our own builds; ADR 0002 and ADR 0003 already require that.
- The app is JavaScript delivered to the browser, so serving it to users distributes it: whoever hosts a build must also offer its corresponding source, including the build recipes of the `.wasm` modules.
