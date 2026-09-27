# 0008: Assembly mate solver: our own joint-coordinate solver in TypeScript

- Status: accepted
- Date: 2026-09-26

## Context

M2 brings assemblies (task T2.3 in [the M2 plan](../plans/m2.md)): instances of parts placed by mates between mate connectors, with four mate kinds to start with: fastened, revolute, slider and planar. Something has to turn instances and mates into instance poses, report degrees of freedom, and explain redundant and conflicting mates in terms the user can act on, the way [ADR 0003](0003-sketch-solver.md) does for sketches. The candidates were named in [T0.4](../spikes/T0.4-planegcs.md) (Ansatz, SolveSpace's `libslvs`) and in the epic plan (planegcs, which is 2D only).

The forces:

- **License.** [ADR 0006](0006-licensing.md): permissive, MPL-2.0 or GPLv3-or-later code may be bundled; LGPL only as a separately loaded, replaceable `.wasm`; no AGPL, no GPL-2.0-only.
- **What the mates are.** Each mate in the [Onshape sense](https://cad.onshape.com/help/Content/Assembly/mates.htm) fixes the relative transform between two mate connectors (a coordinate frame on each part) except for named free coordinates: fastened none, revolute a rotation about the connector's z axis, slider a translation along it, planar x and y translation and a rotation about z ([Revolute](https://cad.onshape.com/help/Content/Assembly/revolute_mate.htm), [Slider](https://cad.onshape.com/help/Content/Assembly/slider_mate.htm), [Fastened](https://cad.onshape.com/help/Content/mate-fastened.htm)). Cylindrical, ball and pin-slot follow the same pattern and are likely next.
- **What the assemblies are.** The first domains are 3D printing and furniture and boards ([product decisions](../decisions/0000-product-decisions.md)). Their assemblies are mostly trees: boards fastened to boards, a lid on a revolute, a drawer on a slider. Closed loops (a four-bar linkage, a part fastened to two others that are themselves mated) happen but are the minority.
- **Interaction.** Dragging an instance moves everything mated to it and must keep up with the pointer. The sketch solver's lesson (T0.4) is that a dense solve over every coordinate grows fast with size.
- **Diagnostics.** Like sketches, mates need DOF, the redundant and the conflicting mates by their stable ids ([ADR 0004](0004-document-format.md) decision 4), and one to blame.
- **Worker model.** [ADR 0007](0007-worker-protocol.md): heavy work in workers, errors as data, generations for cancellation.

## Evaluation

"Measured" below means run on 2026-09-26 on a desktop PC (AMD Ryzen 5 7600X, Linux, Node 26.10.0) against the npm package, in a scratch directory outside this repository; the probe scripts are not kept. "Read" means taken from the cited page or the package files. Everything else is marked as research: not built, not run.

### Ansatz (`ansatz-wasm` 0.3.0, MIT)

[Ansatz](https://github.com/LAU-MARS/Ansatz) is a Rust constraint solver with a WebAssembly build and a JSON contract.

- **License**: MIT, read from the package's `package.json` and `LICENSE`. GPLv3-compatible; could be bundled.
- **Maturity**, read from the GitHub API and npm on 2026-09-26: repository created 2026-09-09, 7 commits by one author, the last on 2026-09-11, 1 star, no forks, no issues; npm versions 0.1.0 to 0.3.0 published 2026-09-10 and 11. Nothing has happened since.
- **Coverage**, read from its README: 3D `rigid3` bodies with `mate` (planar contact), `coaxial`, anchored `distance`, `angle` and `fixed`, and joints `revolute`, `cylindrical`, `prismatic`, `spherical`, with drives and gear coupling. General 2D constraints return `unsupported_constraint` (measured: a 2D `coincident` does). The published TypeScript types (`types/ansatz.d.ts`) do not list the joint kinds; a `revolute` with `a_axis` and `b_axis` solved anyway (measured).
- **Diagnostics**: an outcome (`converged`, `underconstrained`, `overconstrained`, `inconsistent`, `max_iterations`), `dof_total`, `dof_remaining`, redundancy groups, per-constraint residuals, suggestions and per-joint values. Measured: two identical revolutes between the same pair gave `overconstrained` with the second in a redundancy group; a four-bar linkage gave `dof_remaining: 1`, which is right; two fixed bodies with a distance between them gave `inconsistent` with the distance's residual but **no** group naming the conflicting constraints. Every `human_message` is in Chinese, so the UI could not show them as they are.
- **Size and loading**, measured: `ansatz_wasm_bg.wasm` is 782,758 bytes (203,203 gzip -9, 157,203 brotli -q 11). The npm build targets Node (`wasm-pack --target nodejs`: the glue reads the `.wasm` with `require('fs')`), so a browser build would be ours to make, with a Rust toolchain in CI.
- **Speed**, measured: it solves over six pose parameters per body with dense Levenberg-Marquardt and SVD. A serial chain of revolute joints took 6.67 ms per solve at 10 bodies, 757 ms at 50 and 10.2 s at 100 (mean of 20, 5 and 5 solves). A four-bar solved in 0.35 ms. At 50 bodies it is already far outside a drag budget, and cost grows roughly with the cube of the body count.
- **Rerunning the timings.** They came from throwaway probe scripts, not from anything in this repository; since the scripts are gone, what follows is the method rather than their exact code. In an empty directory, `npm install ansatz-wasm@0.3.0`; write a Node script that builds the JSON model from the package README for a chain of N `rigid3` bodies, the first `fixed` and each next one joined to the previous by a `revolute` with `a_axis` and `b_axis` along z and a unit offset between the joint origins; call the package's solve entry point on it, time each call with `performance.now()` after one warm-up call, and average over 20 runs at N = 10 and 5 runs at N = 50 and 100. The four-bar is four bodies with the ground `fixed` and four revolutes. Expect different absolute numbers on other hardware; the growth with N is the point.

### SolveSpace `libslvs` (GPL-3.0-or-later)

[SolveSpace](https://github.com/solvespace/solvespace) is a parametric CAD program whose solver is also a library, and upstream publishes a JavaScript build as [`slvs`](https://www.npmjs.com/package/slvs).

- **License**: "GPL v3 or later" (read from its README); the npm package says "GNU GPL V3". Compatible with GPL-3.0-or-later; could be bundled.
- **Maturity**: developed since 2008, about 4,170 stars, commits in September 2026 (read from the GitHub API). The solver is proven in the application.
- **Coverage**, read from `slvs.d.ts` of `slvs` 3.2.0-dev.155: 3D points, 3D normals (quaternions), workplanes, lines, circles, arcs, cubics, and 37 constraint types (coincidence, distances, point in plane, parallel, perpendicular, same orientation and so on). **There is no rigid-body entity**: nothing places a set of entities by one pose, which is what an instance is. Modelling instances would mean a point and a normal per body plus a connector's world position expressed through constraints, which the API was not designed for. Whether that works well was not tried (research).
- **Diagnostics**: `dof`, a result code (okay, inconsistent, did not converge, too many unknowns, redundant but okay) and a list of failed constraints (read).
- **Size**, measured: `slvs` 3.1.0-dev.14 ships a 235,936-byte `.wasm` (72,152 brotli); the current dev build 3.2.0-dev.155 is a single 6,743,325-byte `slvs.js` with the `.wasm` inlined as base64 (1,122,109 brotli). The npm dist-tags do not point where the names suggest: `stable` is 3.2.0 (6.16 MB unpacked, the inlined kind), while `latest`, which a plain `npm install slvs` gets, is 3.1.0-dev.14 (read from the registry).
- The community [SolverWasm](https://github.com/Box-of-Dragons/SolverWasm) fork exposes a 2D-workplane API only (read).

### OndselSolver (LGPL-2.1)

[OndselSolver](https://github.com/FreeCAD/OndselSolver) is the multibody solver behind FreeCAD 1.0's Assembly workbench.

- **License**: the `LICENSE` file is the LGPL 2.1 text; the source headers say only "See LICENSE file", so whether it is "only" or "or later" is not stated (read). Either way ADR 0006 allows it only as a separately loaded, replaceable `.wasm`.
- **Maturity**: moved to the FreeCAD organisation in 2025; a small number of maintainers, commits in June to September 2026 (read). It ships in a major open-source CAD program.
- **Coverage**, read from its source tree: fixed, revolute, cylindrical, translational (slider), planar, spherical, parallel axes, perpendicular, angle, point-in-line, point-in-plane, rack and pinion, gear, screw, universal, constant velocity, and more (27 `ASMT*Joint` classes), with drag limits and kinematic simulation.
- **Size and loading**: the `OndselSolver/` directory is 658 files and 5.6 MB of C++. **No WebAssembly build was found** (the one project found using it outside FreeCAD, [3d-modeller-app](https://github.com/cedricziel/3d-modeller-app/pull/23), links it natively). A build would be ours, like the planegcs build [ADR 0003](0003-sketch-solver.md) decision 8 plans. Its size and speed in wasm are unknown (research).
- **Signal**: FreeCAD has a draft pull request to put assembly solvers behind an interface and add a [Project Chrono](https://projectchrono.org/) backend ([FreeCAD#28156](https://github.com/FreeCAD/FreeCAD/pull/28156)); its description mentions a model breaking on drag. Chrono is a full multibody dynamics engine, reportedly BSD-3-Clause (not verified), far larger than what M2 needs.

### planegcs, physics engines

- **planegcs** is FreeCAD's 2D sketch solver ([ADR 0003](0003-sketch-solver.md)); it has no 3D rigid bodies. Not applicable.
- **Physics engines** with joints (for example Rapier) solve joints approximately, by impulses over time steps, not exactly by position. An assembly must satisfy its mates exactly. Rejected without evaluation; licenses not checked.

### Our own solver

The four M2 mates are joints with explicit coordinates, which allows a formulation that none of the above uses:

- **Unknowns are joint coordinates, not poses.** A revolute has one unknown, a slider one, a planar three, a fastened none. A body's pose follows from the path of mates that connects it to a fixed instance, by composing transforms. Ansatz's six pose parameters per body are replaced by at most a few per mate.
- **A tree needs no iteration.** When the mate graph is a tree rooted at the fixed instances (the common case above), every pose is exact forward kinematics: linear in the number of instances, no Jacobian, nothing to converge. Dragging an instance on a revolute mate is choosing that mate's angle.
- **Loops are small nonlinear systems.** Each mate outside a spanning tree closes a loop and adds six equations (the relative transform around the loop is the identity). These are solved by damped Gauss-Newton (Levenberg-Marquardt) over the joint coordinates on the loop, seeded from the last solution. Unconnected loops are solved separately.
- **Diagnostics from rank.** DOF is the number of joint coordinates minus the rank of the loop equations' Jacobian at the solution. Equations that do not raise the rank and are satisfied are redundant; a loop left with a residual is a conflict, reported as every mate on that loop, blaming the most recently added (ADR 0003's rule for sketches). Rank comes from an SVD of a small dense matrix. A graph check finds the plain cases first: two fastened mates between the same pair, a fastened mate closing a loop of fastened mates.
- **Cost** is an estimate, not measured: a tree of 200 instances is 200 transform compositions, well under a millisecond; a loop of a few mates is a system of a few to a few tens of unknowns. The benchmark in T2.3a replaces this estimate.
- **Price**: we write and maintain it (transforms, a small SVD, Levenberg-Marquardt, the graph), perhaps 1,500 lines of TypeScript with tests, and each new mate kind is ours to add. Couplings (gears, rack and pinion, screws) and limits inside loops are harder in this formulation and are not in M2.

## Decision

1. **Own solver, in a new pure TypeScript package `packages/assembly`**, with no WebAssembly and no runtime dependency. It solves in joint coordinates as above: forward kinematics on a spanning tree from the fixed instances, Levenberg-Marquardt on loop closures, DOF and redundancy from the rank of the loop Jacobian (a small SVD of our own), conflicts reported per loop.
2. **Solver-neutral interface.** The package exposes `solve(input)` and `drag(input, instanceId, target)`: plain-data input (instances with their last poses and whether they are fixed, connectors as local frames, mates with kind, offsets and limits) and a report in the shape Ansatz uses and ADR 0003 adopted as its reference: an outcome, per-instance poses, DOF, redundant and conflicting groups by mate id, per-mate residuals and free coordinates, and one message per entry, in English and written by us. No solver type leaves the package, so the solver behind it can be replaced.
3. **Stored state is poses.** As a sketch stores its last solved coordinates ([ADR 0004](0004-document-format.md) decision 1), an assembly stores each instance's last solved pose; the mates define the result, the poses seed it and choose among solutions (a four-bar's two branches). Joint coordinates are derived from the poses at the start of a solve and never stored.
4. **Where it runs.** The solve is part of the regen worker's reply for an assembly (ADR 0007 decision 3): regen resolves mate connectors on the part bodies, solves, and returns instance transforms and diagnostics. Drags go to the same worker and are coalesced, latest target wins, as for sketches. The package itself is thread-agnostic, so tests run it in Node directly.
5. **Mate kinds in M2**: fastened, revolute, slider and planar; cylindrical and ball when they are cheap to add (the formulation covers them). Revolute and slider limits clamp drags; limits are not enforced inside loops in M2, and a loop solution outside a limit is a warning.
6. **Revisit** when any of these is needed: couplings (gear, rack and pinion, screw, belt), limits enforced inside loops, kinematic simulation or dynamics, or when T2.3a's benchmark misses the drag budget on assemblies of the size we target. The first candidate then is **OndselSolver** in our own `.wasm` build, loaded separately as LGPL requires; the second is Ansatz, if it matures and stays maintained. The interface in decision 2 is what makes either a swap rather than a rewrite.

## Alternatives considered

- **Ansatz now.** The right license, the diagnostics we want, and a working revolute, four-bar and redundancy report. Rejected for now: one author, days old and idle since 2026-09-11; no browser build published; no messages in English; no conflict group in the measured inconsistent case; and a dense pose formulation measured at 757 ms per solve for a 50-body chain. Kept as the diagnostic reference (decision 2) and a watch item (decision 6).
- **`libslvs`.** Mature, GPLv3-or-later, and small in its older build, but it has no rigid-body entity; mates between instances would have to be faked with points, normals and extra constraints, and its diagnostics are a flat list of failed constraints. Rejected.
- **OndselSolver now.** The most complete and the most proven for assemblies, but no wasm build exists, its size and speed in the browser are unknown, and it is a C++ build to own for four mate kinds that are straightforward in joint coordinates. Deferred to decision 6.
- **Project Chrono.** A dynamics engine; far more than M2 needs. Rejected.
- **planegcs.** 2D only. Not applicable.
- **A dense pose-based solver of our own** (six unknowns per instance, like Ansatz). Simpler to state but carries the same cubic growth and turns every tree into an iterative solve. Rejected in favour of joint coordinates.

## Consequences

- No new dependency, license or `.wasm` for assemblies; the notices in ADR 0006 do not change.
- Tree assemblies are exact and cheap; loops are iterative and can fail to converge, which is reported like any conflict. The T2.3a benchmark (trees of 10 to 500 instances, loops, drags) sets the numbers this ADR only estimates.
- We own the numerical code: transforms, a small SVD and Levenberg-Marquardt need careful tests against hand-computed poses, including near-singular cases (a revolute axis through a slider's line).
- Adding couplings or dynamics later likely means switching to OndselSolver in wasm, not growing this solver; decision 2 keeps that possible.
- Instance poses in the document are seeds and change on every solve that moves something, like sketch coordinates; they add churn to the command log that version history (T2.5) has to live with.
