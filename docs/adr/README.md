# Architecture Decision Records

Technical decisions for manufakture, one per file, numbered in order. Each records its context, the decision, the alternatives considered and the consequences, and cites the spike write-ups in [`docs/spikes/`](../spikes/) it relies on.

Product decisions (license, local-first storage, target machines, what comes first) are not ADRs. They live in [`docs/decisions/`](../decisions/), starting with [0000: Product decisions](../decisions/0000-product-decisions.md), and the ADRs build on them. [0001: M7 hosting, accounts, sharing and data policy](../decisions/0001-m7-hosting-accounts-and-sharing.md) answers the questions ADRs 0009 and 0010 left to the maintainer.

## Index

- [0001: Kernel wrapper: a thin wrapper of our own over OCCT](0001-kernel-wrapper.md). Accepted.
- [0002: Kernel binary, loading and memory lifecycle](0002-kernel-build-and-loading.md). Accepted.
- [0003: Sketch solver: planegcs in a worker, behind our own wrapper](0003-sketch-solver.md). Accepted.
- [0004: Document format: a versioned JSON feature list, with names as references](0004-document-format.md). Accepted.
- [0005: Units: millimetres and radians inside, per-document display units outside](0005-units.md). Accepted, amended 2026-10-03 (roof pitch notation and percent slopes).
- [0006: Licensing: GPL-3.0-or-later, and what we may depend on](0006-licensing.md). Accepted, amended 2026-10-01 (fonts, by 0011).
- [0007: Worker protocol: Comlink, coarse calls, errors as data, named meshes](0007-worker-protocol.md). Accepted, amended 2026-09-26, 2026-10-01 (the print-analysis worker) and 2026-10-02 (the CAM worker, by 0014).
- [0008: Assembly mate solver: our own joint-coordinate solver in TypeScript](0008-assembly-mate-solver.md). Accepted.
- [0009: Sync model: a server-ordered command log, validated by core, rebased on the client](0009-sync-model.md). Accepted, amended 2026-10-04 (the T7.0b spike: created ids, counter guard, one rename table, tombstones, restores as intent; self-hosted single user).
- [0010: Scripting sandbox: QuickJS in WebAssembly, inside the regen worker, with no capabilities](0010-scripting-sandbox.md). Accepted, amended 2026-10-04 (the T7.0c spike: synchronous kernel session, memory and time limits, sucrase; scripts on open after sign-off, versioned API).
- [0011: Fonts: one bundled OFL font (Inter Bold), user fonts stored in the document](0011-fonts.md). Accepted, amended 2026-10-01 (overlap check, untrusted-font limits).
- [0012: 3D printing: a document-level print section, a print package and worker, standard 3MF by download](0012-3d-printing.md). Accepted.
- [0013: Domain packages: extension features that make bodies, namespaced domain data, a generic takeoff](0013-domain-packages.md). Accepted.
- [0014: CAM architecture: a document-level cam section, a pure cam package and worker, posts as data](0014-cam-architecture.md). Accepted.
- [0015: The construction domain: walls, openings, floors and roofs as extensions, framing members as data](0015-construction-domain.md). Accepted.

## Adding an ADR

- Take the next free number and name the file `NNNN-short-title.md`.
- Use the format of the existing records: a title line, `Status` and `Date`, then Context, Decision, Alternatives considered and Consequences.
- Cite the evidence by relative link, and state only what the sources measured or say; mark estimates as estimates.
- To reverse or replace a decision, write a new ADR that supersedes the old one and set the old one's status to "superseded by NNNN".
- A change that keeps the decision but adjusts how it is carried out may be recorded in place as an amendment: add a section at the end headed "Amendment: ..." that says what changed, why, and which task did it, and set the status to "accepted, amended YYYY-MM-DD" with the date of the latest amendment. Leave the original text as it was, so the record shows both.
- Fix an accepted ADR in place without an amendment only for factual errors.
- Add the new record to the index above.
