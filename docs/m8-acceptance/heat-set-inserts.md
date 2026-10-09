# M8 acceptance scenario: heat-set inserts in a printed enclosure (T8.6b)

## The request

> Put M3 heat-set inserts in the four lid bosses of this enclosure and make the lid screw holes
> clear.

The document is a fixture built from commands,
[`apps/mcp/test/fixtures/heat-set-inserts/enclosure.ts`](../../apps/mcp/test/fixtures/heat-set-inserts/enclosure.ts):
one part, two bodies. The base (`extrude#1`) is an 80 x 60 x 40 mm box shelled 2 mm with its top
open, with four round bosses 7 mm across (`sketch#2`, `extrude#2`, "Lid bosses") standing from the
floor up to the rim at z = 40, 8 mm in from each corner. The lid (`extrude#3`) is a 2 mm plate on
the rim with four screw holes over the bosses (`hole#1`) at 3.0 mm, the screw's own size, so not
clear. 7 mm bosses are a common size for self-tapping screws; with a 4.0 mm insert hole they leave
a 1.5 mm wall, under the 1.6 mm the insert vendor asks for. `make-library.ts` in the same
directory writes it into a library directory for the live run.

## The scripted test

[`apps/mcp/test/scenarios/heat-set-inserts.test.ts`](../../apps/mcp/test/scenarios/heat-set-inserts.test.ts),
14 tests, about 5 s, in-process server on the in-process kernel. In order:

1. Opens a session; the fixture regenerates with no errors.
2. Finds the bosses by geometry: the base's cylinders of radius 3.5 are `extrude#2:side:e5` to
   `e8`, their centroids on the boss axes; the lid hole walls sit over them; `measure` gives a
   boss axis as a line (origin and direction).
3. Gap probes (listed below): no axis point, hole flag or coaxial query in `find_geometry`; fragile
   boss top names; no insert table or insert hole type; a cosmetic M3 thread on the insert hole
   fails.
4. Drills the insert holes: `#insert_hole` 4.0 mm, `#insert_depth` 6.5 mm, a sketch of four points
   on the boss tops and a blind hole scoped to the base.
5. Makes the lid holes clear: `editFeature` on `hole#1` with 3.4 mm and `standard: M3 normal`.
6. Gap probe: the wall between boss and insert hole measures 1.5 mm and nothing warns. Then
   widens the bosses to 8 mm (an `editFeature` of `sketch#2`, same entity ids) and measures 2.0 mm
   at all four.
7. Measures the hole depth (boss top to the end of the wall): 6.5 mm, at least the insert's 5.7 mm.
8. Gap probe: the blind hole ends in a drill point (a cone).
9. Renders a section through two bosses (`compare: true`); asserts the result carries a scale and no
   dimensions.
10. No regen errors; submits with a section view in the bundle; exports a 3MF from the unreviewed
    branch (`reviewed: false`).

Set `HEAT_SET_INSERTS_IMAGES=/some/dir` to keep the section PNGs.

## The live run

Claude Code headless (`claude -p` with the request, `--mcp-config` pointing `node` at
`apps/mcp/src/main.ts`, `--strict-mcp-config --allowedTools "mcp__manufakture__*"`), on a temp
library holding the fixture and a temp output directory, `timeout 1200`. Raw transcript
(stream-json) kept outside the repo at `/tmp/hsi-live/transcript.jsonl` on the machine that ran it.

- **Outcome:** done and submitted for review, 86 s, 21 turns, 20 tool calls (16 to manufakture).
  Two batches applied, no regen errors.
- **What it did:** read the authoring guide resource; `list_documents`, `open_session`;
  `get_object` of the whole part, from which it read the boss centres and the lid hole sketch (it
  never queried geometry to find the bosses); `get_schema` for `hole`. A dry run of one batch: two
  variables (`#insert_hole_dia` 4.0 mm, `#insert_hole_depth` 6.7 mm), a sketch of four points at
  z = 40, a 4.0 mm blind hole, and four cosmetic M3 threads (as the guide suggests for inserts).
  The threads failed (`M3 (internal) needs a hole 1.959 to 2.865 mm across`), so it applied the
  batch without them. Second batch: `hole#1` to 3.4 mm with `standard: M3 normal`. Checked with
  `find_geometry` (hole radii 2.0 and 1.7, centroids on the boss centres), two `render` calls with a
  section, `get_errors`, then `submit_for_review` with a section view and an isometric view, and
  `close_session`.
- **Where it stumbled:** its first dry run was refused for using one symbol on two counters
  (`sketch#$ins` and `hole#$ins`), a rule the guide states; fixed at once. Its first section render
  used `extent: 25`, which frames around the middle of the whole scene, and came back as a blank
  grey square; it re-rendered with `fit` on two hole walls, which cut off the drill point at the
  bottom of the image. It used no `measure` call: the 1.5 mm wall it reported was worked out from
  the sketch radii, not measured. It also ran two harmless shell commands (`ls`, `echo`):
  `--allowedTools` alone did not keep other tools away in this headless setup.
- **What it got right:** insert size (4.0 mm, CNC Kitchen's M3 hole) and depth (insert length 5.7 mm
  plus 1 mm) from its own knowledge, as variables; the right clearance size; batches with clear
  labels; scope on both holes; a note that says what was done, what was checked, that the thread was
  left out and why, and that the 7 mm bosses leave a thin 1.5 mm wall. It asked before widening the
  bosses instead of doing more than asked.

## Gaps

| Gap                                                          | Hypothesis from plan or found | Confirmed / Not confirmed / Partly | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                           | Suggested follow-up                                                                                |
| ------------------------------------------------------------ | ----------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Insert table not next to the thread tables                   | Plan                          | Partly                             | The table exists: `HEAT_SET_INSERTS` in `packages/print/src/fits.ts` (CNC Kitchen M2 to M5: hole, insert diameter, length, minimum wall) and in `docs/user/fits.md`. No tool, resource, schema or guide text serves it (probe "no insert table"); the live agent sized the hole from memory. The kernel's clearance table (`HOLE_SIZES`) is not served either: 3.4 mm for M3 came from the agent's knowledge.                                      | Serve the hole, insert and thread tables to agents (1)                                             |
| No hole type for inserts                                     | Plan                          | Confirmed                          | Hole heads are `simple`, `counterbore`, `countersink`; `standard.fit` is `close`, `normal`, `loose`; thread representations `modelled`, `cosmetic`. A cosmetic M3 thread on a 4.0 mm insert hole fails (`needs a hole 1.959 to 2.865 mm across`), in the probe and in the live run. The insert hole is a plain hole whose purpose lives only in its name. The guide tells agents to use a cosmetic thread for heat-set inserts, which cannot work. | Insert holes as a hole kind (2); fix the guide now (3)                                             |
| No wall thickness check around a hole                        | Plan                          | Confirmed                          | A 1.5 mm wall around the insert hole (vendor minimum 1.6 mm) gives no error or warning (probe). `measure` with two faces gives the distance, but only when asked; `packages/print`'s thickness analysis runs in the app, not in a session. The live agent noticed the thin wall only by arithmetic.                                                                                                                                                | Wall check for insert and hole features (4)                                                        |
| Section renders needed, must show the hole depth             | Plan                          | Not confirmed                      | `render` and `submit_for_review` views take `section`; the section shows the hole, its depth and drill point, with `mmPerPixel` for scale. Images carry no dimensions; the depth is measured with `measure` (6.5 mm in the test). Two framing traps seen live: `extent` centres on the whole scene, and `fit` on a hole wall leaves its drill point out.                                                                                           | Optional: section views that frame named geometry with a margin; no task needed for the hypothesis |
| `find_geometry` lacks hints for bosses (axes, coaxial holes) | Plan                          | Partly                             | Hits carry axis direction, radius and centroid (enough to find these free-standing bosses), but not the axis point or the boss-or-hole flag the kernel's topology already computes (`axisOrigin`, `hole`), and there is no coaxial query (probe). `measure` returns the axis as a line, a workaround. The live agent never needed geometry: it read the boss sketch from `get_object`.                                                             | Pass `axisOrigin` and `hole` through, add a coaxial filter (5)                                     |
| Boss tops have fragile names                                 | Found                         | Confirmed                          | One extrude of four circles gives four end caps named `extrude#2:cap:end#1` to `#4`, all `fragile: true` (probe). Any reference to a boss top (a lead-in chamfer, a depth measurement, a CAM face) can jump to another boss on an edit.                                                                                                                                                                                                            | Name extrude caps per profile region (6)                                                           |
| Blind holes always end in a drill point                      | Found                         | Confirmed                          | The insert hole ends in a cone (probe). The kernel's hole takes `tipAngle`, but core's hole feature has no field for it, so no flat-bottomed insert pocket. Minor for printing.                                                                                                                                                                                                                                                                    | Add a tip option to the hole feature (with 2)                                                      |

## Follow-ups

1. **Serve the hole, insert and thread tables to agents.** A read-only resource (or a `get_tables`
   read in `get_schema`) with the kernel's `HOLE_SIZES` (clearance fits, counterbore, countersink),
   `THREAD_SIZES` (tap drill, range) and `packages/print`'s `HEAT_SET_INSERTS` and
   `SELF_TAPPING_HOLES`, each with its source and `verified` flag. Acceptance: an agent can read
   the M3 insert hole (4.0 mm, length 5.7, wall 1.6) and the M3 normal clearance (3.4 mm) through
   MCP; the probe "no insert table" in the scenario test flips; the guide's Holes recipe points to
   the resource.
2. **Insert holes as a hole kind.** A hole `standard` that can say "heat-set insert M3" (or a
   `purpose: insert` with the insert size) so the size, depth and minimum wall come from the table
   and the intent survives in the model, the drawing and the review bundle; plus a tip option
   (`tipAngle` or flat) on blind holes, which the kernel already supports. Acceptance: an M3 insert
   hole made from the table regenerates at 4.0 mm and the insert length, flat bottomed when asked;
   the probes "no insert hole type" and "drill point" flip; core's format change follows the
   add-only rule.
3. **Fix the guide's advice on inserts.** The Holes recipe says a cosmetic thread is for heat-set
   inserts; a cosmetic thread resizes the hole to the tap drill and refuses an insert hole. Say to
   drill the insert's hole and depth (from the table once follow-up 1 lands), name the hole after
   the insert, and leave the thread off. Acceptance: the guide's example runs in
   `authoring-guide.test.ts`; the guide assertion in the scenario probe is updated.
4. **Wall check around holes.** A warning at regen (or a `measure` kind) when the material around
   a hole is thinner than a minimum: the insert's `minWall` for insert holes, the print setup's
   `minWall` otherwise. Acceptance: the fixture's 7 mm bosses with 4.0 mm insert holes report a
   1.5 mm wall under 1.6 mm in `get_errors` (as a warning) and in the apply report; at 8 mm they do
   not; the probe flips.
5. **Cylinder hints in `find_geometry`.** Pass `axisOrigin` and `hole` from the kernel's topology
   through to each cylinder hit, and add a `coaxialWith` filter (a face name). Acceptance: the
   probe flips; `coaxialWith: "extrude#2:side:e5"` returns the boss, its insert hole wall and the
   lid hole wall over it.
6. **Per-region names for extrude caps.** When one extrude makes several separate regions, name
   each cap after its profile loop (as sides are named after entities) instead of an ordinal.
   Acceptance: the four boss tops get stable, non-fragile names that survive reordering the
   circles' sizes; the probe "fragile boss tops" flips; existing documents keep resolving.
