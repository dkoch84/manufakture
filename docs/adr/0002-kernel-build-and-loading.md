# 0002: Kernel binary, loading and memory lifecycle

- Status: accepted
- Date: 2026-09-26

## Context

[ADR 0001](0001-kernel-wrapper.md) decided how our code talks to OpenCASCADE: a thin wrapper of our own in `packages/kernel`. This ADR fixes what sits under that wrapper: which OCCT build we ship, how the browser loads it, how its memory is kept bounded, and how we meet its license. The evidence is the [T0.2 spike](../spikes/T0.2-occt.md), with init and leak figures cross-checked by [T0.3](../spikes/T0.3-wrapper.md). The constraints come from the [product decisions](../decisions/0000-product-decisions.md): GPL-3.0-or-later, local-first, and OCCT loaded as a separate, replaceable `.wasm`.

The forces, from T0.2:

- **It works.** `libcascade` 3.0.2 (OCCT 8.0.1) loads in a module Web Worker under the Vite dev server and a production build, single and multi-threaded, and a whole regen of the filleted bracket takes 74 ms.
- **Size and start-up.** The single-threaded `.wasm` is 42,691,285 bytes raw and 8,223,986 bytes brotli (7.8 MiB). Cold start in Chromium is about 355 ms from `new Worker()` to a usable kernel on localhost. About 80 % of that is runtime init (static constructors and embind registering 5298 classes), so a warm HTTP cache saves only 33 to 43 ms. Download time for the single build is computed at about 6.6 s at 10 Mbit/s and 0.66 s at 100 Mbit/s.
- **Multi-threading helps only meshing.** Meshing gets 4.2x (bracket) and 7.2x (fine bracket) faster; fillet and small booleans do not change, and single-threaded extraction then takes 77 % of the fine run. In exchange: about 60 ms more cold start, COOP/COEP on every page, `navigator.hardwareConcurrency` pthread workers, a first parallel call of 935 ms, and linear memory grown from 128 MiB to 318.6 MiB on that first call (measured in Node) and never returned.
- **The leak.** `delete()` frees nothing for 2102 of the 5298 bound classes, `TopoDS_Shape` and every builder among them. The bracket leaks 2,237 KiB per regen when every object is deleted, and 499 KiB with T0.2's release-before-delete rules. libcascade 3.0.0 has the same empty destructors, and upstream issue #40 reports custom builds affected too.
- **Memory never shrinks.** A `WebAssembly.Memory` cannot give memory back; dropping the instance is the only way. A new instance from the already compiled module took 343 to 366 ms in Node; terminating and restarting the worker in the browser took 315 ms (single build).
- **A custom build is the real fix but was not built.** `@libcascade/toolchain` 3.0.2 can trim the bindings and add C++ helpers. The trimmed M1 size of about 1 to 4 MB brotli is T0.2's own estimate, not a measurement: it applies the toolchain's documented sizes per bound symbol to a guessed 200 to 600 symbols for an M1 modeller, at the 19 % brotli ratio measured on the prebuilt binary. Nothing was built, since no container engine was available.

## Decision

1. **Ship the prebuilt `libcascade` 3.0.2, single-threaded, pinned exactly** (no range). Import `libcascade/single/init` and the binary as a URL (`libcascade/single/wasm?url`). An upgrade is a deliberate change that re-runs T0.2's destructor audit and leak probe before it lands.
2. **The multi-threaded build is rejected for now.** Revisit it only when profiles show meshing, not extraction, dominating a regen, which is most likely after the C++ extraction helper in step 3. The kernel does not depend on cross-origin isolation.
3. **A custom trimmed build is the follow-up**, as step 4 of [ADR 0001](0001-kernel-wrapper.md): a trimmed symbol list plus C++ helpers for operations, history collection, the `topology()` query ([T0.5](../spikes/T0.5-topo-naming.md); history and query shapes in [ADR 0007](0007-worker-protocol.md), decision 9) and mesh extraction, with shapes kept in C++. It is built in CI with a container engine and measured against T0.2 and T0.3; ADR 0001 holds the targets and the switch condition to the occt-wasm fallback.
4. **Loading.**
   - Vite emits the `.wasm` as its own content-hashed asset and copies the Emscripten glue verbatim. It is never inlined into application JavaScript.
   - Compile with streaming: `WebAssembly.compileStreaming`, or the glue's own streaming path, which measured the same.
   - Start the kernel worker at app start-up, so that runtime init overlaps UI start-up.
   - Production hosting serves the `.wasm` hashed, as `immutable`, and precompressed with brotli. Vite does not do this by itself, so it belongs to the hosting configuration. The HTTP cache is the cache for M1. A service worker that precaches the `.wasm` for offline use fits local-first and is a follow-up; it saves the download, not runtime init.
   - The UI shows a loading state until the kernel worker reports ready, with download progress on a first visit. Modelling commands wait for ready. Meshes cached in OPFS ([ADR 0004](0004-document-format.md)) may be displayed before that.
5. **Memory.**
   - Every OCCT object is owned by a scope and released before `delete()`, per T0.2's table. Nothing OCCT crosses the kernel's API (ADR 0001).
   - The kernel reports `heapBytes()`. At a threshold, and only at an idle point, the kernel worker recycles its instance: a new instance from the cached `WebAssembly.Module` (no refetch), then a replay of the feature tree. T0.2's 1 GiB is the starting threshold; the real value is set from measurements on M1 models.
   - A fatal wasm error such as an abort is handled the same way: recycle, replay, report. Ordinary OCCT exceptions are not fatal; they become a `KernelError` for one feature ([ADR 0007](0007-worker-protocol.md)).
   - This only works because the document, not the OCCT state, is the source of truth ([ADR 0004](0004-document-format.md)).
6. **LGPL-2.1 compliance.** libcascade is `LGPL-2.1-only WITH Open-CASCADE-Exception-1.0`. OCCT stays a separately loaded `.wasm` plus glue, so a user can replace it with their own build; a custom build keeps the same shape. The build configuration and our C++ helpers are published in this repository. The license texts ship with the app. [ADR 0006](0006-licensing.md) has the full inventory and rules.

## Alternatives considered

- **Multi-threaded prebuilt.** Faster meshing only, capped by single-threaded extraction, at the cost of start-up time, never-returned memory, a pthread pool that forces recycling by terminating the whole worker, and COOP/COEP on every page. Rejected for now (step 2).
- **Custom build immediately.** Not measurable yet (no container engine on the measurement machine), and the prebuilt binary is fast enough for interactive regens. Deferred to step 3, not dropped.
- **An older libcascade 3.x.** 3.0.0 has the same 2102 empty destructors, so it fixes nothing.
- **Another OCCT build** (replicad's or occt-wasm's). Settled in ADR 0001: occt-wasm is the fallback, replicad's build is rejected.
- **`fetch().arrayBuffer()` then `WebAssembly.compile`.** It was 15 ms slower than streaming on localhost and gives up the download/compile overlap that matters over a real network.
- **Relying on `delete()` alone.** It recovers 0.5 % of the bracket's leak.

## Consequences

- A first visit downloads about 7.8 MiB of kernel before modelling can start; later visits pay mainly runtime init (320 ms warm in T0.2). The loading state is a product requirement, not polish.
- Until the custom build lands, the kernel leaks on every regen and recycling is mandatory. Each recycle costs a new instance (about 0.3 to 0.4 s) plus a replay. Kernel tests should watch heap growth, not only results.
- The first regen after init or a recycle is slower while V8's lazy compilation catches up (bracket 197 ms against 74 ms steady state).
- Hosting must set the caching and compression headers above, and keep serving the `.wasm` as a separate file.
- T0.2's empty-destructor evidence should be added to upstream issue taucad/opencascade.js#40.
