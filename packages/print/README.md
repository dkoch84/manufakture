# @manufakture/print

Printability checks for FDM printing (M3 plan, T3.1b): the printer table, the transform a print
item's orientation stands for, overhang classes per triangle and per face, and whether a placed
body fits a printer; and the fit defaults (T3.2g). Pure TypeScript with no runtime dependency. It
reads the kernel's `MeshData`, `Placement` and `BoundingBox` shapes as types only, so it runs in a
worker or in Node unchanged.

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

## Tests

`pnpm --filter @manufakture/print test`. The meshes are built by hand in `src/test-helpers.ts`
with the kernel's layout (vertices per face, normals in a `Float32Array`), and the answers are
computed by hand.
