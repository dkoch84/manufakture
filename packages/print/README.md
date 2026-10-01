# @manufakture/print

Printability checks for FDM printing (M3 plan, T3.1b): the printer table, the transform a print
item's orientation stands for, overhang classes per triangle and per face, and whether a placed
body fits a printer; the fit defaults (T3.2g); and wall thickness, gaps, small holes and teardrops
with the print-analysis worker that runs the ray casting (T3.1c). Pure TypeScript; its one runtime
dependency is Comlink, for the worker. It reads the kernel's `MeshData`, `Topology`, `Placement`
and `BoundingBox` shapes as types only, so it runs in a worker or in Node unchanged.

Lengths are millimetres and angles radians, as everywhere else (`@manufakture/units`). Nothing in
this package is stored in a document: core stores the printer id, the nozzle, the orientation and
the thresholds as expressions, and the caller evaluates them before calling in here.

## Printers

```ts
import { PRINTERS, findPrinter, defaultLineWidth, minFeatureSize } from '@manufakture/print';

const x1c = findPrinter('bambu-x1c'); // Printer | undefined
defaultLineWidth(0.4); // 0.42
minFeatureSize(0.4); // 0.1: 25% of the nozzle
```

`PRINTERS` follows the `materials.ts` pattern in core: rows of plain data with **permanent ids**
(documents store them), each citing where its numbers come from. A row may be corrected, but an id
is never removed or reused. `findPrinter` returns `undefined` for an id it does not know, so a
document naming a printer from a newer table still loads and the print panel reports it.

| Id              | Area (mm) | Height | Excluded or per-nozzle areas                                    |
| --------------- | --------- | ------ | --------------------------------------------------------------- |
| `bambu-a1-mini` | 180 x 180 | 180    | none                                                            |
| `bambu-a1`      | 256 x 256 | 256    | none                                                            |
| `bambu-p1p`     | 256 x 256 | 250    | corner 0 to 18 by 0 to 28 at the bed origin                     |
| `bambu-p1s`     | 256 x 256 | 250    | same corner                                                     |
| `bambu-p2s`     | 256 x 256 | 256    | none                                                            |
| `bambu-x1`      | 256 x 256 | 250    | same corner                                                     |
| `bambu-x1c`     | 256 x 256 | 250    | same corner                                                     |
| `bambu-x1e`     | 256 x 256 | 250    | same corner                                                     |
| `bambu-h2s`     | 340 x 320 | 340    | none                                                            |
| `bambu-h2d`     | 350 x 320 | 325    | left nozzle x 0 to 325 (320 high), right x 25 to 350 (325)      |
| `bambu-h2d-pro` | 350 x 320 | 325    | as the H2D                                                      |
| `bambu-x2d`     | 256 x 256 | 261    | left nozzle the whole bed (261 high), right x 20.5 to 256 (256) |

Every row offers 0.2, 0.4, 0.6 and 0.8 mm nozzles and ships with 0.4.

**Where the numbers come from.** The geometry is copied as numbers from OrcaSlicer 2.4.2's
printer profiles (`resources/profiles/BBL/machine/<model> 0.4 nozzle.json`, resolved through
`inherits` to `fdm_bbl_3dp_00x_common.json` and `fdm_machine_common.json`; see the
[research note, section 4](../../docs/research/slicer-handoff.md#4-bambu-lab-build-volumes)). The
profile files themselves (AGPL) are not copied. The profiles are the slicer's view, which is what a
part has to fit: the X1 and P1 heights of 250 mm are inherited from `fdm_machine_common.json`,
although Bambu Lab states 256. The 0.2, 0.6 and 0.8 nozzle profiles inherit their geometry from the
0.4 one unchanged. Nozzle sizes were read from Bambu Lab's spec pages on 2026-10-01 (each row's
`nozzleSource` names the page); no X1E spec page could be read, so that row cites OrcaSlicer's
nozzle profiles. Line widths (nozzle + 0.02 mm: 0.22, 0.42, 0.62, 0.82) come from OrcaSlicer's BBL
process profiles and `min_feature_size` (25%) from its `PrintConfig.cpp`. When a profile changes,
update the row and its `source` together, as a deliberate change.

Coordinates are the slicer's bed coordinates: origin at the corner the profile calls `0x0`, x to
the right, y to the back, z up from the bed. Areas are convex polygons listed counter-clockwise.

Not modelled: OrcaSlicer's `wrapping_exclude_area` (P2S, H2D) and `head_wrap_detect_zone` (A1,
A1 mini), which only apply when the printer's clog or wrap detection is turned on; excluded areas
that differ by build plate (the profiles give one default, which is what is used); custom printers.

## Orientation

```ts
type Orientation =
  | { kind: 'asModelled' }
  | { kind: 'layFlat'; normal: Vec3; turn?: number } // the face's outward normal, FaceInfo.normal
  | { kind: 'rotate'; x: number; y: number; z: number }; // radians

orientationPlacement(orientation, mesh.positions); // Placement: rotation, then drop to z = 0
orientationRotation(orientation); // the rotation alone, a quaternion [x, y, z, w]
```

- `layFlat` turns the face's outward normal to -z by the shortest rotation (about the horizontal
  axis `normal x -z`; a face pointing straight up turns half a revolution about x), then turns the
  body by `turn` about z.
- `rotate` applies rotations about the bed's **fixed** x, then y, then z axes (extrinsic x-y-z,
  matrix `Rz * Ry * Rx`).
- Every kind then drops the body onto the bed: `orientationPlacement` translates along z so the
  lowest point of the given positions (one mesh, or a list of meshes printed as one item) is at
  z = 0, as a slicer does on import. x and y are left alone. `asModelled` is therefore "no
  rotation", not "no transform".

The result is the kernel's `Placement` shape (`p_bed = R p + t`); `placementMatrix` gives the
rotation as a row-major 3x3 matrix for a 3MF build-item transform.

## Overhangs

```ts
const result = classifyOverhangs(mesh, { placement, threshold, band });
result.classes; // Uint8Array: per triangle, an index into OVERHANG_CLASSES
result.angles; // Float64Array: per triangle, angle from vertical (radians)
result.faces; // per B-rep face (slot i is face i + 1): worst class, area per class, max angle
```

**Angles are measured from vertical**: a wall is 0, the underside of a 45 degree chamfer is
pi/4, a ceiling pi/2, and anything facing up is negative. That is the "45 degree rule" convention
the print panel shows (plan, decision 5). OrcaSlicer's `support_threshold_angle` measures the same
slope **from horizontal** and supports surfaces whose slope is below it, so

```
threshold_from_vertical = pi/2 - support_threshold_angle
```

and OrcaSlicer's default of 30 degrees is our default of 60 (`DEFAULT_OVERHANG_THRESHOLD`).
`supportThresholdToOverhang` and `overhangToSupportThreshold` convert.

| Class          | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `onBed`        | facing down with every vertex within 1e-3 mm of the bed plane            |
| `downwardFlat` | facing straight down (within the angle tolerance of pi/2), above the bed |
| `overhang`     | steeper than the threshold, strictly                                     |
| `steep`        | in the warning band: threshold - band < angle <= threshold               |
| `ok`           | everything else, upward-facing and vertical surfaces included            |

Defaults: threshold 60 degrees from vertical (OrcaSlicer), band 10 degrees (an estimate, not a
slicer value). The bed plane is the lowest placed vertex of the mesh unless `bedZ` is given
(pass 0 when several bodies share the bed). A face's `worst` class goes by severity:
`onBed < ok < steep < overhang < downwardFlat`.

**At the boundary.** A triangle exactly at the threshold is steep, not overhang, matching
OrcaSlicer. "Exactly" allows for floating point: an angle within `ANGLE_TOLERANCE` = **1e-6 rad**
of a class boundary counts as on the milder side. The tolerance has to cover the mesh: a triangle's
direction is the mean of its three vertex normals from `MeshData.normals`, a `Float32Array`, and
rounding a unit normal to 32 bits moves its angle by up to about 1e-7 rad (the tests find
rounding errors above 1e-9 rad for a 60 degree normal), so a face modelled at exactly 60 degrees
would flicker between classes with a tighter tolerance. 1e-6 rad is far below anything a printer
resolves. A triangle whose vertex normals cancel out falls back to its winding.

## Bed fit

```ts
const fit = checkBedFit(printer, { box, nozzles: [0, 1] });
fit.fits; // boolean
fit.overshoot; // { x, y, z }: mm outside the usable region along each axis, both sides summed
fit.exclusions; // excluded areas the footprint overlaps, with id and name
fit.region; // the area and height checked, which nozzle areas made it, unknown nozzle indices
boundingBox(mesh.positions, placement); // the placed box, or null for no points
```

The body is its bounding box in bed coordinates, after orientation and the caller's placement on
the bed. It fits when the footprint is inside the usable area, overlaps no excluded area (touching
an edge is fine), and the box lies between z = 0 and the usable height, all within
`DEFAULT_FIT_TOLERANCE` = 1e-3 mm (float32 meshes and B-rep boxes are a little noisy; a 180 mm cube
on a 180 mm bed fits).

On a two-nozzle printer the caller passes the nozzles a body is printed with, as indices into
`printer.nozzleAreas` in OrcaSlicer's extruder order (0 is the left nozzle). This package does not
guess them: the print workspace and the export derive them from the bodies' colours and filament
slots. One nozzle: that nozzle's area and height. Both: the overlap of the areas under the lower
height (H2D: x 25 to 325, 320 high). None: the printer's whole printable area, which is what the
slicer checks before filaments are assigned. Single-nozzle printers ignore `nozzles`. An index the
printer does not have never fits and is listed in `region.unknownNozzles`.

The x and y overshoots are measured against the bounds of the usable area, which is exact for the
rectangular areas of every built-in printer; `fits` itself tests the footprint's corners against
the polygon. When the nozzle areas do not overlap at all, the usable area is empty and nothing
fits.

## Fits

```ts
import {
  fitDefaults,
  FIT_VARIABLES,
  HEAT_SET_INSERTS,
  COUPON_CLEARANCES,
} from '@manufakture/print';

fitDefaults({ printer: 'bambu-x1c', nozzle: 0.4 });
// { family: 'bambu-lab', nozzle: 0.4, clearances: { press: 0.1, slip: 0.2, sliding: 0.4 },
//   provenance: 'placeholder', basis: 'table', source: '...' }
FIT_VARIABLES.slip; // 'fit_slip': the variable the app writes it to
```

Default **diametral** clearances (hole = pin + clearance) for press, slip and sliding fits, per
printer family and nozzle (ADR 0012 decision 10). The app writes them as the document variables
`#fit_press`, `#fit_slip` and `#fit_sliding` (**Insert fit variables**), so this package only
supplies starting values; nothing here is stored.

- `FIT_TABLE` has a row per family and nozzle. Today: `generic` and `bambu-lab` (every Bambu Lab
  printer, `printerFamily`), both at 0.4 mm: press 0.1, slip 0.2, sliding 0.4 mm. They are
  **placeholders** (`provenance: 'placeholder'`): typical community values, estimates not measured
  on any printer, until T3.2h prints the fit-test coupon and replaces them with measured values
  and their source.
- `fitDefaults({ printer, nozzle })`: the row for the printer's family and the nozzle. An unknown
  or absent printer is `generic`; an absent nozzle is the printer's default (or 0.4). A nozzle
  with no row scales the family's 0.4 mm row by `nozzle / 0.4`, rounded to 0.01 mm
  (`basis: 'scaled'`): 0.15, 0.3 and 0.6 mm at a 0.6 mm nozzle.
- `COUPON_CLEARANCES`: the fit-test coupon's steps, 0.0 to 0.5 mm by 0.05 mm (hole 1 to 11).

Real clearances depend on the printer, nozzle, filament and slicer settings (OrcaSlicer 2.4.2's
BBL `fdm_process_single_0.20.json` sets `elefant_foot_compensation` to 0.15 mm), so the user docs
([fits.md](../../docs/user/fits.md)) present these as starting points.

**Inserts and screws, M2 to M5.** `HEAT_SET_INSERTS` copies CNC Kitchen's comparison table for its
standard-length inserts (hole D3, insert diameter D1, length L, minimum wall W), as reproduced on
3DJake's product page for each size, read on 2026-10-01 (`verified: true`, `source` per row).
Other brands differ. `SELF_TAPPING_HOLES` are **unverified** (`verified: false`): no vendor table
for machine screws threading into printed plastic was found, so each is the ISO coarse-thread tap
drill (nominal minus pitch) as a starting point. `heatSetInsert(size)` and
`selfTappingHole(size)` look a size up.

## Thresholds

```ts
printThresholds(0.4); // { minFeature: 0.1, minWall: 0.84, minGap: 0.2, minHole: 0.8, teardrop: 3 }
printThresholds(0.4, { minWall: 1.2 }); // a setup's own values win
```

The numbers a setup's `thresholds` expressions evaluate to, defaulting from the nozzle (ADR 0012
decision 3). Only `minFeature` is a slicer value: OrcaSlicer's `min_feature_size`, 25% of the
nozzle. The rest are **estimates**, editable per setup:

| Threshold    | Default                                     | At a 0.4 mm nozzle |
| ------------ | ------------------------------------------- | ------------------ |
| `minFeature` | 25% of the nozzle (OrcaSlicer)              | 0.1 mm             |
| `minWall`    | two line widths ("at least two perimeters") | 0.84 mm            |
| `minGap`     | 0.2 mm (the fit presets may inform it)      | 0.2 mm             |
| `minHole`    | two nozzle diameters                        | 0.8 mm             |
| `teardrop`   | 3 mm (below it a hole's top bridges)        | 3 mm               |

## Wall thickness and gaps

```ts
const r = analyzeThickness(
  [
    { mesh, placement },
    { mesh: other, placement: p2 },
  ],
  {
    thresholds: printThresholds(0.4),
  },
);
r.bodies[0].thickness; // Float32Array: per triangle, its thinnest sample (mm), Infinity beyond range
r.bodies[0].gap; // Float32Array: per triangle, its narrowest gap (mm)
r.bodies[0].flags; // Uint8Array: THICKNESS_FLAGS bits (belowMinFeature 1, thinWall 2, narrowGap 4)
r.bodies[0].faces; // per B-rep face (slot i is face i + 1): min thickness, min gap, area per class
r.issues; // { kind, body, face, value, area }: one per face and class with any area
```

For sample points on every triangle a ray goes inward along -normal through the **same body's**
mesh, and the distance to the first surface it leaves the material through is the wall thickness
there. A ray outward along +normal gives the gap: the distance to the first surface it enters
material through, of the same body or **any other body** of the setup (bodies are placed first, so
gaps between the items of a setup count). Each body's triangles sit in a bounding volume
hierarchy (`TriangleBvh`, below).

- **Samples**: the centroid of every triangle; a triangle longer than `spacing` (1 mm) is cut into
  k x k congruent pieces, k up to `maxSplit` (8), and each piece's centroid stands for its share
  of the area. The ray direction is the vertex normals interpolated at the sample (radial on a
  tessellated cylinder, so thin curved shells read right), or the triangle's own normal when they
  cancel out.
- **Classes** per sample, exclusive: thinner than `minFeature` (`belowMinFeature`: not printed at
  all), else thinner than `minWall` (`thinWall`); and, separately, a gap narrower than `minGap`
  (`narrowGap`). "Thinner" is strict, with `LENGTH_TOLERANCE` = 1e-4 mm: a wall within it of a
  threshold is at the threshold and not flagged. The tolerance covers the float32 positions of
  `MeshData` (about 1e-5 mm at 100 mm from the origin) and nothing a printer could resolve.
- **Range**: distances are measured up to `range` (10 mm); farther walls and open space read as
  `Infinity`. Every threshold is far below it.
- **Near edges**: rays start `RAY_OFFSET` (1e-4 mm) inside or outside the surface, added back to
  the distance, and hits on surfaces within `GRAZING_ANGLE` (3 degrees) of parallel to the ray are
  passed over, so a ray from beside a right-angled edge does not read the neighbouring face as a
  wall. A truly acute edge (a knife edge) still reads thin near its tip, which it is.
- Thickness is measured along the normal, so it is the wall's thickness where walls are roughly
  parallel; a thin fin is found from its sides, not from its end. Bodies that touch (a gap of 0)
  are not a narrow gap.

`ThicknessJob` is the same analysis in steps (`step(n)` runs n more triangles), which is how the
worker yields between chunks.

**The BVH is our own.** The plan named `three-mesh-bvh` (MIT) as the default. It works on a
three.js `BufferGeometry` with `three` as a peer dependency, which the worker would load only to
wrap arrays it already has; and the one query needed (the nearest hit along a ray, on a triangle
facing a given way, skipping the ray's own triangle) is a page of code. `TriangleBvh` is built
top-down with a binned surface area heuristic (12 bins, leaves of up to 4 triangles), stores
vertices as float64 in BVH order and traverses nearest child first. No dependency, so no lockfile
churn and no licence to check beyond Comlink's.

## Holes and pins

```ts
const report = analyzeHoles(topology, {
  placement, // the item's orientation, for "horizontal"
  thresholds: printThresholds(0.4),
  names: { faceNames: mesh.faceNames, names: reply.names }, // for the thread rule
});
report.groups; // holes and pins: { side, faces, radius, diameter, axis, origin, horizontal }
report.issues; // { kind: 'smallHole', faces, diameter, minimum } | { kind: 'teardrop', faces, diameter, teardrop }
report.threaded; // groups on a thread's axis: not checked
report.partial; // fillet rounds, rounded corners, slot ends: not checked
```

Exact facts from the B-rep (`FaceInfo.radius`, `axis`, `axisOrigin`, `hole`, T3.1c's kernel
step), never from the mesh. Cheap, so it runs on the main thread (ADR 0012 decision 5).

- **Grouping.** A slot or cross hole that cuts a bore splits its cylinder into several faces, so
  cylindrical faces with the same side (all holes or all pins), the same radius (within 1e-6 mm)
  and the same axis **as a line** are one hole or pin. Directions match when the angle between
  the lines, `atan2(|a x b|, |a . b|)` (sign ignored, accurate near zero), is at most 1e-9 rad;
  axes coincide when one face's `axisOrigin` is within 1e-6 mm of the other's line. Grouping looks
  only at the axis, the radius and the side, so **two separate bores in line with the same radius
  are one hole** (two holes either side of a gap, say): it cannot tell them apart without
  adjacency, and every check gives both the same answer anyway. A hole and a pin on one axis, or a
  counterbore and its hole, are separate groups.
- **Partial cylinders.** A fillet round, a rounded corner or a slot end is a cylinder too (a
  concave fillet even reads as a hole). When the topology has edges and vertices, a group counts
  only if its faces go more than half way round: a face with a seam edge goes all the way, and
  otherwise the boundary points (edge midpoints and vertices) must leave no gap of half a turn
  about the axis. Others go to `partial`. A faces-only topology cannot tell, and every group counts.
- **`smallHole`**: a hole whose diameter is below `minHole`. A diameter within
  `DIAMETER_TOLERANCE` = 1e-6 mm of the minimum is at it and not flagged, so a 0.8 mm hole whose
  radius comes back as 0.39999999 is fine. Pins are listed, never flagged: a thin pin is a thin
  wall, which the thickness check finds.
- **`teardrop`**: a hole whose axis lies within 1 degree of the bed plane after the orientation,
  with a diameter above `teardrop` by more than 1e-6 mm: it needs a teardrop or support. Its top
  is an overhang anyway, which the overhang check shows; the flag says what to do about it. One
  flag per hole, listing all its faces.
- **Threaded holes are not holes.** A face whose name contains `:thread:` (T3.2e's
  `<id>:thread:<part>`, also under a pattern or mirror prefix such as
  `pattern#6:i2/thread#5:thread:root`) is never a hole or pin itself, and a group whose axis
  coincides, as a line within the tolerances above, with the axis of a **cylindrical** `:thread:`
  face goes to `threaded` and is not checked. So the crest strips a modelled internal thread
  leaves of its hole (named after the hole) are neither a small hole nor a teardrop. **The axis
  rule is the one in use**: the plan's fallback (skipping groups that share an edge with a
  `:thread:` face) is not needed, since T3.2e's goldens show every modelled thread has
  cylindrical faces on its axis (the root of every turn, and the crest when trimmed), and a kernel
  golden checks that those roots and the crest strips share the hole's line. A cosmetic thread
  adds no thread faces and leaves a cylinder at the tap drill size, which is found like any hole.
  The rule goes by the axis, not by the face, so it also skips a plain hole that lies in line
  with a tapped one: in a clamp, the clearance hole in one jaw coaxial with the threaded hole in
  the other is reported under `threaded` and not checked, even though it is a hole of its own.
  Names come from the mesh's `faceNames` slots and the reply's name table, since `Topology` holds
  none; without names no face is a thread face.

## The print-analysis worker

```ts
import { createPrintAnalysisClient } from '@manufakture/print/client';

const client = createPrintAnalysisClient(); // no worker yet: it starts on the first analysis
const reply = await client.analyze(
  [{ id: 'part#1/body#1', mesh, placement }], // copied into the worker
  printThresholds(0.4),
);
// null when a newer analyze (or cancel, or terminate) superseded it
// { status: 'done', bodies: [{ id, thickness, gap, flags, faces, samples }], issues, ms }
// { status: 'failed', message } for a malformed mesh
client.cancel();
client.terminate();
```

The fourth worker context (ADR 0012 decision 5; ADR 0007, amended by T3.1c). `PrintWorkerApi`
(`src/worker-api.ts`) has one coarse call, `analyze(request)`, for every body of a setup at once,
and `cancel(generation?)`; the entry is `@manufakture/print/worker`, the main-thread side
`@manufakture/print/client` (`PrintAnalysisClient` lives apart from the spawn, in
`analysis-client.ts`, since Vite bundles the worker of any module containing a
`new Worker(new URL(...))` call).

- **Lazy.** The client starts its worker on the first `analyze`, so a document with no print
  setup never starts it. `terminate` stops it; the next `analyze` starts a new one.
- **Generations.** Every request carries one, and a newer request supersedes every older one. The
  analysis runs in chunks of 1024 triangles and yields to the event loop at least every 8 ms, so a
  newer request or `cancel` arriving meanwhile is seen and the stale one returns `cancelled`
  (the client resolves it to `null`). The yield (`createYield`) is a real macrotask, chosen in
  React's scheduler's order: `setImmediate` in Node, a message posted on a private
  `MessageChannel` in browsers, `setTimeout(r, 0)` where neither exists. Node gets `setImmediate`
  because a woken Node `MessagePort` drains up to 1000 messages at once, so a chain of channel
  yields would hold off a `cancel` for about 1000 yields (about 8 s). Browsers get the channel
  because they clamp nested timers to at least 4 ms, which would idle the worker about 4 ms per
  8 ms slice. Neither promises strict ordering: a newer request or `cancel` is seen within about
  one slice, which `worker.test.ts` checks with a cancel sent after 100 yields.
  Debouncing after regens and orientation changes is the caller's (T3.1d).
- **Errors are data**: a malformed mesh is a `failed` reply, never an exception through Comlink.
- **Transfer.** Input meshes are copied (the main thread keeps drawing them); the reply's
  `thickness`, `gap` and `flags` arrays are transferred (`replyTransferables`).
- **Budget.** The plan's target is a 200,000-triangle body in under a second in the worker (an
  estimate to measure). `worker.test.ts` measures a 202,800-triangle plate through a
  `MessageChannel`, request copy and reply transfer included, and logs the time against the
  1 s target. It took about 440 ms alone in a development container (2026-10-01) and up to
  about 1050 ms with the rest of the suite running in parallel, so the test fails only above
  4000 ms (`BUDGET_MS`, as in the kernel's thread timing test): headroom for loaded CI runners,
  while still catching a regression of several times.

## Tests

`pnpm --filter @manufakture/print test`. The meshes are built by hand in `src/test-helpers.ts`
with the kernel's layout (vertices per face, normals in a `Float32Array`), and the answers are
computed by hand. `thickness.test.ts` and `features.test.ts` cover the T3.1c acceptance list (a
1 mm wall, a 0.3 mm fin, a 0.1 mm slot between two bodies and in one body, the hole and teardrop
boundaries with their 1e-6 mm tolerance, the split 4.2 mm hole, parallel and in-line bores, the
thread rule on a hand-built topology with names, with and without a pattern prefix).
`kernel-meshes.test.ts` runs the Node kernel: the M1 bracket at 6 mm has no thickness issues, a
0.8 mm tube wall reads 0.8 on the `fine` export mesh, the bracket's holes (and its fillet as
`partial`), and a real modelled M5 thread in a horizontal hole. `worker.test.ts` runs the worker
API through Comlink on a `MessageChannel`: lazy start, a transferred reply, supersession, cancel,
a failed mesh, terminate, and the budget.
