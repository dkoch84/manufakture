# 0000: Product decisions

- Status: accepted
- Date: 2026-09-25

## Context

The initial plan assumed a permissive MIT/Apache-2.0 license and left the target machines generic. Before any code was written, the following product decisions were made. They supersede the earlier assumptions.

## Decisions

1. **Local-first, single user.** Documents live in the browser (Origin Private File System). There is no server until milestone M7. This keeps the early milestones focused on modelling rather than accounts, sync and hosting.

2. **GUI feature tree first.** Modelling is driven by an Onshape-style feature tree and sketches in the UI. Scripting or code-first modelling can come later on top of the same document model.

3. **License: GPL-3.0-or-later.** The project is copyleft. GPLv3 (not v2) is required because Apache-2.0 dependencies such as replicad, brepjs and manifold are only compatible with GPLv3. LGPL components (OpenCascade, planegcs) are fine; OpenCascade is loaded as a separate, replaceable `.wasm` module, which satisfies the LGPL's relinking requirement. The repository is public on GitHub and CI runs on GitHub Actions.

4. **First domain after M1: 3D printing.** It has the shortest path from a solid to a physical part (mesh export to a slicer) and exercises the core modelling features.

5. **Target machines.**
   - CNC: Shapeoko (Carbide Motion, GRBL family; grblHAL on the Shapeoko 5 Pro). The first CAM post-processor is GRBL.
   - 3D printer: Bambu Lab, sliced with OrcaSlicer. Exports target formats OrcaSlicer imports well (3MF, STL).

## Consequences

- All packages and the app are licensed GPL-3.0-or-later; new dependencies must be GPLv3-compatible.
- OpenCascade must stay a separately loaded WASM artifact rather than being bundled into the application JavaScript.
- Storage and persistence design assumes OPFS and a single user until M7.
- CAM work starts with a GRBL post; print export work is validated against OrcaSlicer.
