# @manufakture/assembly

The assembly mate solver of [ADR 0008](../../docs/adr/0008-assembly-mate-solver.md): it turns
instances and mates into instance poses, reports degrees of freedom, and names redundant and
conflicting mates. Pure TypeScript with no runtime dependency, thread-agnostic (the regen worker
runs it; tests run it in Node directly).

## API

```ts
import { solve, drag } from '@manufakture/assembly';

const report = solve(input); // SolveReport
const moved = drag(input, 'inst#2', target); // DragReport
```

Both take plain data and return plain data, so they cross a worker boundary; no solver type
leaves the package (ADR 0008 decision 2).

```ts
interface AssemblyInput {
  instances: { id: string; pose: Pose; fixed?: boolean }[]; // any order
  mates: MateInput[]; // creation order: the last is the newest
}

interface MateInput {
  id: string;
  kind: 'fastened' | 'revolute' | 'slider' | 'planar' | 'cylindrical' | 'ball';
  a: { instance: string; frame: Pose }; // connector frames, in instance coordinates
  b: { instance: string; frame: Pose };
  offset?: Pose; // after connector a, in a's frame, before the free coordinates
  limits?: { min?: number; max?: number }; // revolute (radians) and slider (mm) only
  suppressed?: boolean;
}

type DragTarget = Pose | { point: Vec3; position: Vec3 }; // whole pose, or a local point to a world position
```

A `Pose` is `{ translation: [x, y, z], rotation: [x, y, z, w] }` (a unit quaternion, three.js
order), mapping instance coordinates to world coordinates. Lengths are millimetres, angles
radians.

The poses in the input are the last solved poses: they seed the solve and choose among
solutions, such as a four-bar's two branches (ADR 0008 decision 3). Joint coordinates are derived
from them at the start of every call and never stored.

### The report

| Field         | Meaning                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`     | `solved`; `conflicting` (a loop cannot close); `invalid` (input issues: the bad instances or mates were left out, the rest solved)                          |
| `poses`       | per instance id; an instance that did not move gets its input pose object back, so callers store only what changed                                          |
| `dof`         | 6 per instance group not attached to a fixed instance, plus every mate's free coordinates, minus the rank of the loop closures; `null` while mates conflict |
| `redundant`   | groups `{ mates, blame, message }`: the mates of a loop whose closing mate holds nothing new; the newest is blamed                                          |
| `conflicting` | groups of the same shape: every mate on a loop that cannot close, blaming the newest                                                                        |
| `mates`       | per mate id: `status` (`ok`, `redundant`, `conflicting`, `invalid`, `suppressed`), `coordinates`, `residual` `{ position, angle }`, `message`               |
| `issues`      | input problems: `duplicate-id`, `invalid-pose`, `unknown-instance`, `self-mate`, `unknown-kind`, `invalid-limits`                                           |
| `warnings`    | `outside-limits` (a loop left a limit), `fixed-instance` (a drag of a fixed instance), `not-reached` (a drag target out of reach)                           |
| `message`     | a readable summary for anything but a clean solve                                                                                                           |
| `target`      | drags only: `{ position, angle, reached }`, how far the dragged instance ended from the target                                                              |

Every message is English and names mates by id, for example "Mate mate#4 is redundant: mates
mate#1 and mate#2 already hold everything it holds." The app maps ids to names.

## Mate kinds

A mate holds connector b's frame, relative to connector a's frame (after the offset), at the joint
transform J(q) of its free coordinates q:

| Kind          | J(q)                                          | Coordinates                 | DOF |
| ------------- | --------------------------------------------- | --------------------------- | --- |
| `fastened`    | identity                                      | none                        | 0   |
| `revolute`    | rotation about z                              | `[angle]`                   | 1   |
| `slider`      | translation along z                           | `[distance]`                | 1   |
| `cylindrical` | translation along z, then rotation about z    | `[distance, angle]`         | 2   |
| `planar`      | translation in x and y, then rotation about z | `[x, y, angle]`             | 3   |
| `ball`        | any rotation about the origin                 | rotation vector `[x, y, z]` | 3   |

Coordinates come from the poses by projection: the angle about z of the twist-swing split, the z
(or x and y) of the translation, the rotation vector for a ball. A revolute angle is taken in
(-pi, pi], or the turn that falls inside its limits.

**Limits** (revolute and slider) clamp drags and tree solves. Inside loops they are not enforced
in M2; a loop solution outside a limit is an `outside-limits` warning (ADR 0008 decision 5).

## Algorithm

1. **Graph.** Mates in creation order go into a union-find with the fixed instances joined to a
   virtual ground (Kruskal): a mate that connects two groups is a tree mate; one whose ends are
   already connected is a loop mate. So the spanning forest holds the oldest mates, and each loop
   mate is the newest mate on its cycle, which is the one a conflict or redundancy blames. The
   forest is rooted at the fixed instances; a group with no fixed instance is rooted at its first
   instance in input order (at the dragged instance during a drag) and keeps that root's pose.
2. **Forward kinematics** from the roots along the tree: child = parent * CA * J(q) * FB^-1 (or
   its inverse when the tree runs from b to a). A tree needs nothing else: it is exact and linear
   in the number of instances.
3. **Loops.** Each loop mate adds six closure equations: the position and the rotation vector
   between its two connector frames. Loops that share a coordinate-bearing tree mate form one
   system; separate systems are solved separately. Each system is solved by Levenberg-Marquardt
   over the coordinates of the mates on its loops, seeded from the input poses. The Jacobian is
   analytic: each coordinate is a world twist (an axis and a point, or a direction), and the
   rotation rows use the inverse SO(3) Jacobian, so it is exact away from the solution too. The
   step comes from an SVD of the scaled Jacobian with Marquardt damping adapted by the gain ratio.
   Angles are scaled by a length L (the size of the assembly), so every unknown and residual is in
   millimetres and one tolerance covers both.
4. **Diagnostics from rank.** The rank of each system's Jacobian at the solution comes from a
   one-sided Jacobi SVD (`svd.ts`). DOF = coordinates + 6 per floating group - sum of ranks. A loop
   mate is redundant when removing it (its rows and its own coordinates) leaves the DOF unchanged,
   so a four-bar (rank 3 of 6 rows, a planar mechanism) is not redundant while two fastened mates
   between one pair are. A loop left open by more than 1e-7 L (or 1e-7 rad) is a conflict.
5. **Drags.** The unknowns are the coordinates between the dragged instance and its root and those
   of every loop system they belong to. Each step is a constrained Gauss-Newton step: the part that
   keeps the loops closed (the pseudo-inverse of the loop Jacobian), plus the damped least-squares
   step toward the target projected onto the loops' null space. Loops are then re-closed by the
   solver above, so the target is soft and the loops are hard, as in the sketcher's drag. In a
   tree this is a minimum-norm step, which changes the coordinates nearest the target least.
   Limits clamp tree coordinates and freeze them at the limit for the rest of that call. A
   group with no fixed instance moves rigidly.

Hot loops work on poses packed seven numbers at a time in `Float64Array`s (`transform.ts`) and
reuse their scratch space; the public `Pose` objects are only built for the report.

Files: `transform.ts` (compose, invert, SE(3) log and exp, packed and object forms), `mates.ts`
(joint transforms, coordinate extraction, twists, the ball's retraction), `svd.ts`, `solver.ts`
(graph, forward kinematics, Levenberg-Marquardt, diagnostics, drags, report), `model.ts` (the
interface types).

## Tests

`pnpm vitest run packages/assembly`: hand-computed poses per mate kind, offsets and limits;
unconnected instances keep their poses; two fastened mates are redundant; a loop that cannot close
names its mates and blames the newest; a four-bar has one DOF and follows a crank drag through 90
degrees, matching the closed-form linkage; a slider-crank; near-singular cases (a revolute axis on
or just off a slider's line); randomised round trips (coordinates to poses and back, with mates
stated from either side); twists checked against finite differences; SVD reconstruction and rank.

## Benchmark

`benchmark.test.ts` times solves and drags (60 runs after 10 warm-up runs; a drag is one move of
a pointer drag, its result fed to the next move). It prints `BENCH ...` lines, which Vitest shows
only with `--silent=false --reporter=verbose`:

```sh
pnpm vitest run --silent=false --reporter=verbose packages/assembly/src/benchmark.test.ts
```

and writes `packages/assembly/build/benchmark.json` (gitignored) for CI to print. Budget misses
are reported, not failed, since CI machines vary.

Measured on 2026-09-30 on an AMD Ryzen 5 7600X, Linux, Node 26.10.0 (milliseconds per call):

| Scenario                                 | Instances | Solve median | Solve p95 | Drag median | Drag p95 | Budget            |
| ---------------------------------------- | --------- | ------------ | --------- | ----------- | -------- | ----------------- |
| tree                                     | 10        | 0.055        | 0.094     | 0.054       | 0.142    |                   |
| tree                                     | 100       | 0.174        | 0.275     | 0.231       | 0.452    |                   |
| tree                                     | 200       | 0.322        | 0.550     | 0.406       | 0.649    | solve < 2 ms: met |
| tree                                     | 500       | 0.765        | 0.917     | 0.983       | 1.559    |                   |
| four-bar                                 | 4         | 0.034        | 0.041     | 0.097       | 0.153    |                   |
| slider-crank                             | 4         | 0.020        | 0.026     | 0.035       | 0.077    |                   |
| 20 four-bar loops                        | 80        | 0.503        | 0.591     | 0.608       | 0.655    |                   |
| 50 instances, 3 loops, loop drag (crank) | 50        | 0.125        | 0.156     | 0.204       | 0.215    | drag < 8 ms: met  |
| 50 instances, 3 loops, tree drag (leaf)  | 50        | 0.125        | 0.156     | 0.373       | 0.513    | drag < 8 ms: met  |

Trees are random mixes of fastened, revolute, slider and planar mates. Both budgets are met with
a wide margin, so ADR 0008 decision 6 (switching solvers) is not triggered.
