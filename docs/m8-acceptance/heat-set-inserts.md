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
17 tests, about 5 s, in-process server on the in-process kernel. In order:

1. Opens a session; the fixture regenerates with no errors.
2. Finds the bosses by geometry: the base's cylinders of radius 3.5 are `extrude#2:side:e5` to
   `e8`, their centroids on the boss axes; the lid hole walls sit over them; `measure` gives a
   boss axis as a line (origin and direction). The boss's `find_geometry` hit carries the same
   axis point (`axisOrigin`) and `hole: false`; the lid hole walls `hole: true`.
3. Names the boss tops: `extrude#2:cap:end:e5` to `e8`, after their circles, not fragile (was a
   gap probe; closed by follow-up 6). Reads the tables resource (`manufakture://tables/holes`): the M3 insert hole
   4.0 mm, length 5.7, wall 1.6 (CNC Kitchen, verified), M3 normal clearance 3.4 mm, and the M3
   thread's 1.9587 to 2.8647 mm hole range, which is why the insert hole takes no thread. The hole
   schema offers the insert standard (`purpose: heat-set-insert`) and a blind `tipAngle` (was a
   gap probe; closed by follow-up 2); in a session of its own, an M3 insert hole from the table
   regenerates 4.0 mm across and 5.7 mm deep, flat bottomed. A cosmetic M3 thread on the insert
   hole fails, as the guide says.
4. Drills the insert holes: `#insert_hole` 4.0 mm, `#insert_depth` 6.5 mm, a sketch of four points
   on the boss tops and a blind M3 insert hole, flat bottomed, scoped to the base. The apply report
   has no error and a `thin-wall` warning per boss: 1.5 mm, under the insert's 1.6 mm.
5. Makes the lid holes clear: `editFeature` on `hole#1` with 3.4 mm and `standard: M3 normal`.
   Then `coaxialWith: "extrude#2:side:e5"` gives the boss, its insert hole wall and the lid hole
   wall over it, across both bodies, and none of the other three bosses.
6. The wall between boss and insert hole measures 1.5 mm, and `get_errors` holds the four
   `thin-wall` warnings (was a gap probe; closed by follow-up 4). Then widens the bosses to 8 mm
   (an `editFeature` of `sketch#2`, same entity ids): the warnings are gone, and the wall measures
   2.0 mm at all four; every boss top keeps its name, over its own boss.
7. Measures the hole depth (boss top to the end of the wall): 6.5 mm, at least the insert's 5.7 mm.
   The top's former ordinal name, `extrude#2:cap:end#1`, still finds the same face.
8. The insert holes end in a flat bottom (a plane), where a blind hole used to end in a drill
   point (was a gap probe; closed by follow-up 2).
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

| Gap                                                          | Hypothesis from plan or found | Confirmed / Not confirmed / Partly | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Suggested follow-up                                                                                |
| ------------------------------------------------------------ | ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Insert table not next to the thread tables                   | Plan                          | Partly                             | Closed by follow-up 1 (#1208). Found: the table existed (`HEAT_SET_INSERTS` in `packages/print/src/fits.ts`, CNC Kitchen M2 to M5, and `docs/user/fits.md`) but no tool, resource or schema served it, nor the kernel's `HOLE_SIZES`; the live agent sized the insert hole and the 3.4 mm M3 clearance from memory. Now the resource `manufakture://tables/holes` serves `HOLE_SIZES`, `THREAD_SIZES` (tap drill and the hole and shaft ranges a thread can cut), `HEAT_SET_INSERTS` and `SELF_TAPPING_HOLES` with sources and `verified` flags, the server's instructions point to it, and the scenario reads the M3 insert and clearance from it.                                                                                                                                       | Serve the hole, insert and thread tables to agents (1): done                                       |
| No hole type for inserts                                     | Plan                          | Confirmed                          | Closed by follow-up 2 (#1209). Found: hole heads were `simple`, `counterbore`, `countersink`, `standard.fit` only `close`, `normal`, `loose`; a cosmetic M3 thread on a 4.0 mm insert hole fails (`needs a hole 1.959 to 2.865 mm across`), in the probe and live; the purpose lived only in the hole's name. Now a hole `standard` can be `{ size: 'M3', purpose: 'heat-set-insert' }` (format 18, add-only): the schema and tables resource offer it, the scenario makes an M3 insert hole from the table (4.0 mm, 5.7 mm deep, flat), the review bundle and a drawing's diameter say the insert, and packages/print's `holeInsert` gives its row (`minWall`). The thread still fails, as the guide says.                                                                               | Insert holes as a hole kind (2): done; fix the guide now (3): done                                 |
| No wall thickness check around a hole                        | Plan                          | Confirmed                          | Closed by follow-up 4 (#1210). Found: a 1.5 mm wall around the insert hole (vendor minimum 1.6 mm) gave no error or warning (probe); `measure` with two faces gave the distance, but only when asked; `packages/print`'s thickness analysis ran in the app, not in a session; the live agent noticed the thin wall only by arithmetic. Now regen measures the wall around every hole on the final bodies (the kernel's `holeWalls`: rays cast radially out of the wall) and warns `thin-wall` under the insert's `minWall`, or for other holes the minimum wall of the print setups that print the part. The scenario's 7 mm bosses give four warnings in the apply report and `get_errors`, the 8 mm ones none.                                                                          | Wall check for insert and hole features (4): done                                                  |
| Section renders needed, must show the hole depth             | Plan                          | Not confirmed                      | `render` and `submit_for_review` views take `section`; the section shows the hole, its depth and drill point, with `mmPerPixel` for scale. Images carry no dimensions; the depth is measured with `measure` (6.5 mm in the test). Two framing traps seen live: `extent` centres on the whole scene, and `fit` on a hole wall leaves its drill point out.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Optional: section views that frame named geometry with a margin; no task needed for the hypothesis |
| `find_geometry` lacks hints for bosses (axes, coaxial holes) | Plan                          | Partly                             | Closed by follow-up 5 (#1211). Found: hits carried axis direction, radius and centroid (enough to find these free-standing bosses), but not the axis point or the boss-or-hole flag the kernel's topology already computes (`axisOrigin`, `hole`), and there was no coaxial query; `measure` returned the axis as a line, a workaround. The live agent never needed geometry: it read the boss sketch from `get_object`. Now every cylinder hit carries `axisOrigin` and `hole` (`false` for the boss, `true` for the hole walls), and `coaxialWith` (a face name) gives the faces whose axis line coincides with it, within `tolerance` mm and `angleTolerance` degrees, on any body of the part: for `extrude#2:side:e5`, the boss, its insert hole wall and the lid hole wall over it. | Pass `axisOrigin` and `hole` through, add a coaxial filter (5): done                               |
| Boss tops have fragile names                                 | Found                         | Confirmed                          | Closed by follow-up 6 (#1212). Found: one extrude of four circles gave four end caps named `extrude#2:cap:end#1` to `#4`, all `fragile: true` (probe), so any reference to a boss top (a lead-in chamfer, a depth measurement, a CAM face) could jump to another boss on an edit. Now each cap of a profile of several regions is named after its region's outer loop, `extrude#2:cap:end:e5` to `e8` (the smallest edge id of the loop that no other region's outer loop has), not fragile, and the names stay with their circles when the sizes change or a circle is removed (kernel test). The ordinal names are kept as aliases: a reference stored with `extrude#2:cap:end#1` resolves exactly to the same face, still reported as positional.                                      | Name extrude caps per profile region (6): done                                                     |
| Blind holes always end in a drill point                      | Found                         | Confirmed                          | Closed with follow-up 2 (#1209). Found: the insert hole ended in a cone (probe); the kernel's hole took `tipAngle`, but core's hole had no field for it. Now a blind extent takes `tipAngle` (more than 0, at most 180 deg; absent: 118 deg), 180 deg giving a flat bottom named `bottom`; the scenario's insert holes end flat and the depth is measured to that bottom.                                                                                                                                                                                                                                                                                                                                                                                                                 | Add a tip option to the hole feature (with 2): done                                                |

## Follow-ups

1. **Serve the hole, insert and thread tables to agents.** Done (#1208): the resource
   `manufakture://tables/holes`. A read-only resource (or a `get_tables`
   read in `get_schema`) with the kernel's `HOLE_SIZES` (clearance fits, counterbore, countersink),
   `THREAD_SIZES` (tap drill, range) and `packages/print`'s `HEAT_SET_INSERTS` and
   `SELF_TAPPING_HOLES`, each with its source and `verified` flag. Acceptance: an agent can read
   the M3 insert hole (4.0 mm, length 5.7, wall 1.6) and the M3 normal clearance (3.4 mm) through
   MCP; the probe "no insert table" in the scenario test flips; the guide's Holes recipe points to
   the resource.
2. **Insert holes as a hole kind.** Done (#1209): `standard.purpose` and `extent.tipAngle`. A
   hole `standard` that can say "heat-set insert M3" (or a `purpose: insert` with the insert size) so the size, depth and minimum wall come from the table
   and the intent survives in the model, the drawing and the review bundle; plus a tip option
   (`tipAngle` or flat) on blind holes, which the kernel already supports. Acceptance: an M3 insert
   hole made from the table regenerates at 4.0 mm and the insert length, flat bottomed when asked;
   the probes "no insert hole type" and "drill point" flip; core's format change follows the
   add-only rule.
3. **Fix the guide's advice on inserts.** (Done: the guide's Heat-set inserts recipe drills an M2
   insert hole in the bracket and measures its wall.) The Holes recipe said a cosmetic thread is
   for heat-set inserts; a cosmetic thread resizes the hole to the tap drill and refuses an insert hole. Say to
   drill the insert's hole and depth (from the table once follow-up 1 lands), name the hole after
   the insert, and leave the thread off. Acceptance: the guide's example runs in
   `authoring-guide.test.ts`; the guide assertion in the scenario probe is updated.
4. **Wall check around holes.** Done (#1210): a `thin-wall` warning at regen when the material
   around a hole, measured by the kernel's `holeWalls` op on the final bodies, is thinner than the
   insert's `minWall` for insert holes, the print setups' `minWall` otherwise (a plain hole in a
   part no print setup prints is not checked); a hole breaking out of the body reads 0. Acceptance:
   the fixture's 7 mm bosses with 4.0 mm insert holes report a 1.5 mm wall under 1.6 mm in
   `get_errors` (as a warning) and in the apply report; at 8 mm they do not; the probe flips.
5. **Cylinder hints in `find_geometry`.** Done (#1211). Pass `axisOrigin` and `hole` from the
   kernel's topology through to each cylinder hit, and add a `coaxialWith` filter (a face name).
   Acceptance: the probe flips; `coaxialWith: "extrude#2:side:e5"` returns the boss, its insert
   hole wall and the lid hole wall over it.
6. **Per-region names for extrude caps.** Done (#1212): `<id>:cap:end:<edge id>`, with the
   ordinal names as aliases. When one extrude makes several separate regions, name
   each cap after its profile loop (as sides are named after entities) instead of an ordinal.
   Acceptance: the four boss tops get stable, non-fragile names that survive reordering the
   circles' sizes; the probe "fragile boss tops" flips; existing documents keep resolving.
