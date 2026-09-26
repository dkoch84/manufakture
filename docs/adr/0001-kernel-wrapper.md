# 0001: Kernel wrapper: a thin wrapper of our own over OCCT

- Status: accepted
- Date: 2026-09-26

## Context

manufakture models with OpenCASCADE (OCCT) compiled to WebAssembly, running in a Web Worker. [T0.2](../spikes/T0.2-occt.md) chose the kernel binary: `libcascade` 3.0.2 (OCCT 8.0.1), single-threaded, pinned, loaded as a separate replaceable `.wasm` ([product decisions](../decisions/0000-product-decisions.md): GPL-3.0-or-later, OCCT stays LGPL-relinkable). T0.2 also found that libcascade's `delete()` frees nothing for 2102 of its 5298 bound classes, so memory has to be managed defensively, and that copying a mesh out through per-node embind calls is slow.

Product decisions live in [`docs/decisions/0000-product-decisions.md`](../decisions/0000-product-decisions.md); technical decisions such as this one are ADRs in `docs/adr/`.

This decision is how our code talks to OCCT: adopt an existing TypeScript CAD library as the wrapper, or write a thin one of our own. The candidates were [brepjs](https://github.com/andymai/brepjs) (Apache-2.0) and [replicad](https://replicad.xyz) (MIT). [T0.3](../spikes/T0.3-wrapper.md) implemented the same scenario (filleted box; sketch wire extruded and drilled; meshing) with brepjs 20.0.0 on its default kernel occt-wasm 5.3.5, with replicad 1.1.0 on its own build and on libcascade, and with a minimal wrapper of our own on libcascade, and measured each.

The forces, from T0.3's measurements:

- **History is required.** The next spike (T0.5, topological naming) needs OCCT's `Modified`, `Generated` and `IsDeleted`. Raw calls give them: T0.3's wrapper traced 26 of 26 fillet result faces back to input faces, edges and vertices, and 9 of 9 cut result faces back to input faces. That is history to result faces only; edge-level history was not exercised. replicad exposes none (only through raw escape hatches, which its trimmed build partly breaks). brepjs and occt-wasm report faces only, by hash, and lose the faces a fillet generates from edges and vertices (6 of 26 traced); brepjs returns empty history unless inputs carry metadata.
- **Build lock-in.** brepjs cannot run on libcascade; it needs occt-wasm (or an older, stale opencascade.js build). replicad's modelling runs on libcascade, but its meshing needs four C++ classes that exist only in replicad's own build.
- **Memory.** Both libcascade and replicad's build have empty destructors (2102 of 5298 and 171 of 454 classes). Per scenario run, replicad leaks 249.6 to 361.0 KiB whether or not the GC runs; our wrapper, applying T0.2's release-before-delete rules, 110.1 to 143.4 KiB. occt-wasm, whose C++ facade keeps shapes in a C++ arena and gives JS integer ids, leaks nothing measurable.
- **Speed.** Wrapper overhead is small for replicad (about 1 % per call more than our own thin wrapper on the same libcascade wasm; neither was compared with bare libcascade calls) and larger for brepjs (77 % per call, 20 % on the scenario, over occt-wasm alone). Meshing through C++ extractors is 2.6 to 2.8 times faster than per-node embind calls on a fine mesh. Init in Node: libcascade 482 ms, replicad's build 84 ms, occt-wasm 32 ms.
- **Product shape.** manufakture is GUI and feature-tree first. The kernel is called by a regen engine that replays features, keeps OCCT state rebuildable, recycles the wasm instance at a heap threshold, and needs history for naming. brepjs (626 exports) and replicad (172 exports) are built for code-first modelling, with global kernel singletons and GC-driven memory.
- **Maintenance.** brepjs: 496 versions and 20 majors since February 2026, 118 releases in the last 90 days, essentially one author. replicad: 5 years, 2 majors, one main maintainer, the largest user base.

## Decision

Write a thin wrapper of our own in `packages/kernel`, and depend on neither brepjs nor replicad.

1. **No OCCT object crosses the package boundary.** Shapes live in an arena inside the kernel and are addressed by branded integer ids (the design occt-wasm uses). Callers cannot leak or double-free an OCCT object, and the whole implementation can move between JS over raw bindings and C++ helpers without an API change.
2. **Operations are coarse and history-aware.** Every topology-changing operation can return OCCT's history (modified, generated, deleted, kept), naming sub-shapes by index. What T0.3 proved is history from input sub-shapes to result faces: for fillet, input faces, edges and vertices to the result faces they became or generated; for cut, input faces only. Edge-level history is not exercised yet: `HistoryEntry` names no result edges, `Modified` is never recorded for input edges, and input edges and vertices that generated no face are left out. T0.5 (the topological naming spike, the next task) must establish what naming needs from edge history and extend `HistoryEntry` to match; persistent names are built on top of it there.
3. **The first backend is libcascade 3.0.2 through its raw bindings**, with T0.2's scope and release-before-delete rules and instance recycling. The spike's `spikes/kernel-wrapper/src/own/kernel.ts` is the starting point.
4. **The second backend is T0.2's custom build**: operations, history collection and mesh extraction as C++ helpers, shapes kept in C++. It is measured against T0.3's occt-wasm numbers: no measurable leak, fine-mesh copy about 28 ms, init well under 482 ms. The fallback is forking occt-wasm's MIT-or-Apache-2.0 facade and adding edge and vertex history. Switch to it if either holds: the custom libcascade build does not meet those targets by the end of M1, or the leak per regen measured on real M1 models exceeds 1 MiB (at T0.2's example threshold of 1 GiB, fewer than about 1,000 regens between recycles).
5. **Borrowed, not adopted**: occt-wasm's arena, `checkpoint` / `releaseSince` and error codes; brepjs's branded ids and structured errors; the packed-buffer mesh contract (positions, normals, indices, per-face groups) of replicad's and occt-wasm's C++ extractors.

### API surface of `packages/kernel`

Synchronous, inside the kernel worker; the worker's message API (T0.2) is a coarse layer on top of it. A first cut, to be grown feature by feature:

```ts
type ShapeId = number & { readonly __brand: 'ShapeId' };
type SubShapeKind = 'face' | 'edge' | 'vertex';
/** 1-based index in TopExp.MapShapes order of one given shape. */
interface SubShapeRef {
  kind: SubShapeKind;
  index: number;
}

interface HistoryEntry {
  operand: number; // which input: 0 = shape, 1 = tool, ...
  input: SubShapeRef;
  modified: number[]; // result face indices
  generated: number[]; // result face indices
  deleted: boolean;
  kept: number; // result face index when passed through unchanged, else 0
}
interface OperationResult {
  shape: ShapeId;
  history: HistoryEntry[];
}
interface OperationOptions {
  history?: boolean;
}

interface Kernel {
  // Lifetime and health
  release(id: ShapeId): void;
  checkpoint(): number;
  releaseSince(mark: number): void;
  readonly shapeCount: number;
  heapBytes(): number; // drives the recycle policy

  // Construction
  box(dx: number, dy: number, dz: number, at?: Vec3): ShapeId;
  cylinder(radius: number, height: number, at: Vec3, axis: Vec3): ShapeId;
  profile(plane: Plane, loops: ProfileLoop[]): ShapeId; // from a solved sketch
  extrude(profile: ShapeId, distance: number | Vec3, options?: OperationOptions): OperationResult;
  revolve(profile: ShapeId, axis: Axis, angle: number, options?: OperationOptions): OperationResult;

  // Modelling with history
  boolean(
    op: 'fuse' | 'cut' | 'common',
    shape: ShapeId,
    tools: ShapeId[],
    options?: OperationOptions,
  ): OperationResult;
  fillet(
    shape: ShapeId,
    edges: number[],
    radius: number,
    options?: OperationOptions,
  ): OperationResult;
  chamfer(
    shape: ShapeId,
    edges: number[],
    distance: number,
    options?: OperationOptions,
  ): OperationResult;

  // Topology and geometry queries (selection, naming signatures, measurements)
  count(shape: ShapeId, kind: SubShapeKind): number;
  describe(shape: ShapeId, ref: SubShapeRef): SubShapeInfo; // type, bbox, centroid, normal or axis
  adjacentFaces(shape: ShapeId, edge: number): number[];
  volume(shape: ShapeId): number;
  boundingBox(shape: ShapeId): Box3;

  // Output
  mesh(shape: ShapeId, deflection: { linear: number; angular: number }): MeshData; // transferable
  exportStep(shapes: ShapeId[]): Uint8Array;
  exportStl(shape: ShapeId, deflection: { linear: number; angular: number }): Uint8Array;
}

/** Thrown for every failure, with the decoded OCCT exception when there is one. */
class KernelError extends Error {
  operation: string;
  occtType?: string;
}
```

`MeshData` is T0.2's layout (positions, normals, indices, per-face `[firstIndex, indexCount]` ranges), which is also what the C++ extractors return. Edge polylines for the viewport and `SubShapeInfo` details are settled when the viewport and T0.5 need them.

## Alternatives considered

- **Adopt brepjs (on occt-wasm).** Best type discipline, no memory leak, fast C++ meshing and start-up. Rejected: it cannot use libcascade, so it would replace T0.2's kernel with occt-wasm as a side effect; its history is face-only and keyed by hash, loses fillet faces, and is empty by default; it adds 20 % on the scenario and 77 % per call over its own kernel; its API has had 20 major versions in under 8 months; and its code-first surface (626 exports) is not what a feature-tree regen engine calls.
- **Adopt replicad.** Mature, MIT, tiny wrapper overhead, runs its modelling on libcascade. Rejected: no history API, so every history-carrying operation would bypass it anyway; memory is GC-driven with a single global kernel, and its own build leaks per operation (open issue #282); meshing requires its own build or four extra C++ classes in ours; its fluent, code-first API is not our call pattern.
- **Use occt-wasm directly as both binary and wrapper.** The strongest memory, size (4.76 MB brotli) and start-up numbers in T0.3. Not chosen now: its history misses edge- and vertex-generated faces, it is six months old with six major versions and one maintainer, and every change to its C++ facade would have to go upstream or into a fork. Kept as the fallback for step 4 of the decision.

## Consequences

- We own the wrapper code, so every feature needs its kernel operation written by us. In the spike, `cut` is 15 lines and `fillet` 27 over the raw bindings, sharing a 38-line history collector.
- History to result faces is available from the first feature, and the regen engine never sees OCCT objects. Whether that is enough for naming is open: edge-level history (result edges, `Modified` for edges) is neither implemented nor measured, and T0.5 decides what `HistoryEntry` has to add.
- Until the custom build lands, the kernel still leaks about 110 to 143 KiB per scenario-sized regen and copies meshes at per-node embind speed, so the recycle policy from T0.2 stays mandatory. At 143.4 KiB per regen that is about 7 regens per MiB of growth, or roughly 7,000 regens between recycles at T0.2's example threshold of 1 GiB, starting from the 41.6 MiB in use after 10 runs (computed from T0.3's `results/memory.json`). Each recycle costs a new libcascade instance (481.74 ms init in Node, T0.3) plus a replay of the feature tree (17.39 ms for the T0.3 scenario; real models take longer). The scenario is small, and real M1 models will leak more per regen; the switch condition in step 4 of the decision covers that.
- The API is designed so that the C++ backend is an internal change. Tests written against `packages/kernel` stay valid across the swap, and they double as its acceptance tests.
- The T0.3 spike adds about 82 MiB of dependencies to every CI install (replicad's and occt-wasm's builds among them). They can be dropped from `spikes/kernel-wrapper` now that the decision is made, keeping the results and the doc.
- Later ADRs are numbered from 0002 in `docs/adr/`.
