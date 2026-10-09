# M8 acceptance scenario: drawer slides (T8.6a)

The request, as the person would type it:

> Add a drawer to the bottom opening of this cabinet on 18" side-mount ball-bearing slides, 1/2"
> clearance each side, and check it opens fully.

"This cabinet" is the authoring guide's cabinet (`cabinetDocument()` in
`packages/session/src/test/fixtures.ts`): 24" wide, 30" tall, a fixed shelf at 14", 3/4" plywood
in rabbets and dados and a 1/4" back. Its bottom opening is 22-9/16" wide and 13-9/32" tall, but
the cabinet is a bookshelf only 11-1/4" deep (11-1/32" inside, to the back), so an 18" slide does
not fit. The scripted test shows that first, then runs on the same cabinet made 22" deep by
commands (`baseCabinetDocument()` in
[`apps/mcp/test/fixtures/drawer-slides/cabinet.ts`](../../apps/mcp/test/fixtures/drawer-slides/cabinet.ts):
`editFeature` on the six sketches that carry the depth). Both were given to the live agent, in two
runs.

## The scripted test

[`apps/mcp/test/scenarios/drawer-slides.test.ts`](../../apps/mcp/test/scenarios/drawer-slides.test.ts),
in the `mcp` vitest project, through the real MCP server in process (15 tests, about 10 s).

What it does, as an agent would:

1. On the guide's cabinet: measures a side (11-1/4" deep) and the back's front face (11-1/32" in):
   too shallow for the slide. Closes that session.
2. On the 22" cabinet: finds the opening's faces with `find_geometry` (the bottom's top, the
   shelf's underside, the sides' inner faces, the back) and measures the opening between faces
   of two bodies with `targets` (since #1206; before, through `clearance` box gaps): 22-9/16" by
   13-9/32", 21-25/32" deep. The sides' inner faces are named after the dado walls beside them
   (since #1207); raising the shelf 2" keeps both names, and the former positional names still
   find the same faces.
3. Adds the drawer box in one batch: two variables (`#slide_clearance`, and `#drawer_width`,
   measured from the opening's side faces less the clearances since #1202; before, typed in as
   `22-9/16" - 2 * #slide_clearance`), five boards (1/2" plywood sides, front and back, a 1/4"
   bottom; 21-9/16" x 12" x 18"; the front, back and bottom dimensioned from `#drawer_width`, the
   right side sketched on the front's right end) and four dowel joints, with symbols for the new
   sketches and boards in the boards' `sketch` and the joints' `a` and `b` too. When this scenario
   was first written those `params` fields did not take symbols, so it sent the batch as a dry run
   for the ids and then again with them put in; since #1223 the symbols resolve there and the
   batch goes once. No regen errors.
4. Places the slides from the hardware catalog (since #1200; before, four plain extrudes, a
   1/4" x 1-3/4" x 18" steel bar per member, which no bill of materials counted): reads the
   catalog resource (`manufakture://tables/hardware`), picks the side-mount family whose
   clearance is the 1/2" asked for and its 18" size (450 mm closed, 450 mm of cabinet needed,
   `verified: false`), shows a 24" pair as a dry run refused on both slides (600 mm of cabinet
   needed, 558.8 mm there), then adds the pair in one batch: a `wood.slide` per side between the
   cabinet side and the drawer side. Each makes its cabinet member and drawer member as bodies;
   each slide touches but does not overlap the cabinet side and the drawer side, 45.7 mm high,
   centred on the drawer side.
5. Reads the quantities and exports a bill of materials (`bom-csv`): the pair is a hardware line
   (2 slides, by length) beside the 16 dowels, and nothing is excluded (since #1200).
6. Builds an assembly in one batch: the cabinet's boards and cabinet members as a fixed instance,
   the drawer's boards and drawer members as a second instance of the same part (instances show a
   subset of bodies), and a `slider` mate from the cabinet bottom's front face to the drawer front,
   limited to 0 to 18". One degree of freedom, mate `ok`, no errors.
7. Checks the drawer opens fully: `measure` `interference` at the solved pose and with `poses` at 0,
   9" and 18" pulled out: no pairs. At 18" the drawer's back is at the cabinet's front.
   Then reads the solved pose and the slide's value from `get_tree` (instance `transform` and
   `moved`, mate `coordinates`), and pulls the drawer 600 mm out with `setPoses`: past the
   457.2 mm limit, so the solver holds it at 457.2 mm, `get_tree` reads 457.2 mm and `moved`, and
   the apply report and `get_errors` carry a `limit` warning on the mate (since #1203; this was a
   gap probe before). `get_object` still shows the stored 600 mm, as the document holds it.
   Then sweeps the slider (since #1201; this was a gap probe before): `interference` with
   `travel: { mateId }` checks 21 values over the 0 to 18" limits, the drawer the one instance
   `moving`, no pairs. A sweep from -4" to 0
   and a pose pushed 4" in both collide and both warn `outside-limits` (the sweep with the values,
   the pose with the value and the limit); a pose an inch sideways warns `off-mate`; a 1 mm step
   over 18" is refused (at most 101 values). With the cabinet made 17" deep the 18" slides no
   longer fit (a dry run: each slide an error naming 450 mm needed and 431.8 mm there, since
   #1200), so they go to 16" in the same batch; the default sweep's `first` is then 0 with the
   cabinet and drawer as the pair (0 and 0.9" collide), and closing from 18" an inch at a time
   first collides at 1". Undone afterwards.
   Then renders the assembly (since #1204; this was a gap probe before): a view with
   `assembly: { assemblyId }` draws it at the solved poses, with `mates` the slider held at 18"
   (the drawer out of the front, highlighted as `<drawer instance>/*`), each image answering the
   slider's distance as drawn; at 600 mm, or with the drawer placed 600 mm out by hand, it is drawn
   there with an `outside-limits` warning, and a pose an inch sideways warns `off-mate`.
8. Exports the cut list through the assembly and submits for review with a note and a view of the
   assembly with the drawer 18" open: the bundle's head image shows it, with the slider's
   distance beside it (the base has no assembly, so its side says so).

The gap probes (tests named `gap probe`) asserted the behaviour of the day, so a fix flips the
test. None is left: two more flipped with #1200 and are now tests of the new behaviour. Found:
the schema index had no hardware, component or catalog kind, a `wood.slide` extension
regenerated with `unsupported`, and the slides (plain steel extrudes) were `excluded` from the
cut list as `not-wood` and in neither the hardware lines nor the `bom-csv` file, while the 16
dowels were. Now the slides come from the catalog and are a hardware line in both.

Two probes flipped with #1202 and are now tests of the new behaviour: a variable takes a measured
value (`distance(...)` between the opening's sides; a lost face is a regen error naming the
variable and the face; a feature field measuring directly is refused), and widening the cabinet
by 1" widens `#drawer_width` to 22-9/16", the drawer with it, and the right slide follows to the
side (before: 1" off it, the variable still 21-9/16").

## The live runs

Claude Code headless (`claude -p` with the request above, `--strict-mcp-config`, only the
manufakture tools allowed), model Opus 5.5, against `apps/mcp/src/main.ts` over stdio with a
temporary library holding the fixture and a temporary output directory. Raw transcripts are
outside the repository (`/tmp/ds/live-a/transcript.jsonl`, `/tmp/ds/live-b/transcript.jsonl`).

**Run A, the guide's cabinet** (35 s, 14 turns, 13 tool calls). It read the authoring guide
resource, opened a session, read the shelf's sketch and board, the quantities and three body
measurements, then closed the session without a batch and answered: an 18" slide does not fit,
the cabinet is 11-1/4" deep and 11-1/32" inside; the opening is 22-9/16" x 13-9/32", so the box
would be 21-9/16" wide; use 10" slides (12" do not fit) or make the cabinet about 19" deep, and
tell it which. All of that is right, and stopping to ask was the right call for a request that
cannot be built as written. The empty agent branch stays in the library.

**Run B, the 22" cabinet** (4 min 43 s, 29 turns, 28 tool calls, no refused call). What it did:

1. Read the guide, opened a session, read the part and the extension schema, listed the
   resources looking for a drawer or slide schema, and probed a drawer `extension` in a dry run
   (`unsupported`: no such domain). It then said it would build the drawer from boards and joints.
2. Measured the bottom and shelf boards and found the side's inner face, then sent one 24-command
   batch as a dry run and again for real: an inset 3/4" front with 1/16" reveals, a 21-9/16" x 18" x
   11" box in 15/32" plywood (front and back in rabbets, a 7/32" bottom in dados), and two slides
   as plain 1/2" x 1-3/4" x 18" extrudes. It wrote literal ids it counted itself (`sketch#7`,
   `extension#15`, `extrude#1`) instead of symbols, against the guide's advice; the dry run
   confirmed them. No variables: every size is a number in a sketch.
3. Checked "opens fully" without an assembly: `measure` `clearance` of the six drawer boards,
   each with the same placement, against the carcass and both slide blocks at 0, 4-1/2", 9",
   13-1/2" and 18" of travel (no pairs), plus a control it built itself (the box back pushed into
   the cabinet back: the first try, +100 mm, missed; +92 mm overlapped), to prove the check
   detects a collision.
4. Rendered (a section first cut away the wrong half; it re-cut and looked again), read the
   quantities and errors, and submitted with a note that lists the slides as plain blocks with no
   material, left out of the cut list and the hardware.

Its closing message to the person flagged exactly the plan's gaps in its own words: "Remember to
order the slides separately"; "Each slide is one fixed block, so the check doesn't cover its
sliding inner parts"; "Check the real slide's height and screw-hole spacing before you drill".

What it got right: the opening's sizes, the 1/2" clearance, the 18" travel, a sound box, a
self-made control for the interference check, an honest note. Where it stumbled: no symbols, no
variables, the slides without a material (so they are excluded as `no-material` rather than
`not-wood`), one wrong section, one missed control. It never used an assembly or a mate, so the
mate-based gaps below come from the scripted test only.

Environment notes: `--allowedTools "mcp__manufakture__*"` pre-approves the manufakture tools but
did not stop the agent from running `Bash` once (`echo noop`, harmless) under this machine's
permission settings; a stricter run would also pass `--disallowedTools`. Reading the guide
resource (`ReadMcpResourceTool`) worked without being listed.

## Gaps

| Gap                                                                                                                                      | Hypothesis from plan or found | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Suggested follow-up                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No purchased-part catalog: a slide is not a component with a length series, clearance and hole pattern, counted in the bill of materials | Plan                          | Confirmed, closed (#1200) | Closed by #1200. Found: no hardware, component or catalog kind in the schema index; a `wood.slide` extension regenerated `unsupported`; slides modelled as extrudes were `excluded` (`not-wood` in the test, `no-material` live), in neither the hardware lines nor `bom-csv`. Now the hardware catalog (`SLIDE_FAMILIES` in packages/domain-wood, the resource `manufakture://tables/hardware`) holds a side-mount ball-bearing series, 10" to 28" in 2" steps, 1/2" a side, and an undermount family (side thickness, bottom recess and clearance, back notch), with lengths, travel, the cabinet depth each needs and screw holes, `verified: false`. A `wood.slide` between a cabinet board and a drawer side checks the fit (a wrong gap, a short drawer side or a shallow cabinet is an error with the numbers), makes the two members as bodies and is a hardware line in `get_quantities` and `bom-csv`. The test places the 18" pair: 2 slides beside 16 dowels, none excluded; 17" deep, they are errors                     | None; hinges, pulls and other purchased parts can join the catalog the same way. The app has no slide dialog yet: an agent places slides, or a batch of commands. |
| Interference is checked at one pose, not over a slider mate's travel                                                                     | Plan                          | Confirmed, closed (#1201) | Closed by #1201. Found: `measure` `interference` took `poses` only; a `travel` was refused by the input schema; a pose outside the slider's limits was checked without a word. Scripted: three poses by hand. Live run B: five positions plus a self-made control, all through `clearance` placements. Now `travel: { mateId, from?, to?, step? }` sweeps a slider's distance (mm) or a revolute's angle (degrees) over its limits by default, 20 steps, at most 101 values, the other mates kept, checking only pairs with an instance that moves (the rest once, as `staticPairs`) and stopping past one kernel call's time budget (a `truncated` warning), and answers `first` (the first colliding value and its pairs), `colliding`, `values` and `checked`; it is refused while the assembly's solve conflicts; values past the limits and hand-made poses past them or off a mate are `warnings`. The test sweeps the 18" travel clean, and a 17" deep cabinet collides first at 0 (at 1" closing from 18"), cabinet and drawer | None; `solveAtCoordinate` and `posedMate` in packages/assembly and `sweepPoses` / `posedMates` in regen are there for a viewer's motion study                     |
| Variables cannot take a measured value, so numbers are hardcoded and a later edit breaks them                                            | Plan                          | Confirmed, closed (#1202) | Closed by #1202. Found: a `setVariable` that measures the model was refused (`expression`); widening the cabinet 1" left the right slide 1" off the side and `#drawer_width` unchanged; live run B used no variables. Now `distance("face", "face")` (and `angle(...)`) is an expression function, allowed in variables (feature fields read the variable): regen measures the named faces (two bodies of one part; `part#2/` names a part) on the part built without the variable's readers, the planes' distance of parallel planar faces, else the minimum, and the readers follow. A lost face, or a variable measuring faces it shapes, is a regen error naming the variable and the face (`get_errors`, `where: variable`), and its readers fail: never a stale value. The test measures `#drawer_width` from the sides, dimensions the drawer from it and stands the right side and slides on it: 1" wider, it reads 22-9/16" and the slide touches the side                                                                    | None; a feature field cannot measure directly (it reads a variable); id remaps rewrite the quoted face names                                                      |
| The cut list does not separate hardware lines                                                                                            | Plan                          | Not confirmed             | `get_quantities` gives `hardware` rows (`kind: hardware`) apart from boards, with a `hardware` total; `bom-csv` lists 16 dowels. The lines come only from joints, which is the catalog gap above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | None of its own; covered by the catalog follow-up                                                                                                                 |
| The solved pose of an instance and a slider's value cannot be read; a pose past the limits is clamped silently                           | Found                         | Confirmed                 | Closed by #1203. Found: `setPoses` 600 mm out was clamped to 457.2 mm with no warning, `get_object` showed the stored 600 mm, and `get_tree` mates carried only id, name, kind, status, suppressed. Now `get_tree` gives each instance's solved `transform` and `moved` and each mate's named `coordinates` (457.2 mm here), and the clamp is a `limit` warning on the mate in the apply report and `get_errors`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | None; the solved poses (`solvedPoses` in regen) and the limit check (`limitViolation` in packages/assembly) are there for the travel sweep and assembly renders   |
| Render draws the part studio only, never an assembly at a pose                                                                           | Found                         | Confirmed, closed (#1204) | Closed by #1204. Found: `render` refused `assemblyId`; neither the agent nor the review bundle could show the drawer open. Now a view's `assembly: { assemblyId, mates?, poses? }` draws the assembly's instances at the solved poses, with sliders and revolutes held at values (mm, degrees; one solve, the other mates kept) or instances placed by hand; names also match qualified with an instance (`inst#2/*`); each image answers the mates' coordinates as drawn and `outside-limits`, `off-mate` and `not-reached` warnings. `submit_for_review` views take the same, and the bundle shows each side's pose. The test renders the drawer closed and 18" open (from the top the scale grows by 40/22), at 600 mm (drawn, warned) and placed by hand, and submits an open-drawer view                                                                                                                                                                                                                                          | None; scripted features still fail in MCP renders and exports (the workshop regenerates without a script engine)                                                  |
| Mate connector frames are not readable, so connector offsets are found by trial                                                          | Found                         | Confirmed, closed (#1205) | Closed by #1205. Found: the slider needed a 174.228 mm offset along the cabinet connector's frame y; which axis that is (world up, for a -Y face) was found by trying. Now `get_object` on a mate answers `frames` beside the mate: each connector's origin and axes x, y, z in world coordinates (mm) at the solved poses, after flip, rotate and offset, and `motion` (a slider's distance runs along a's z). The test adds the mate without an offset, reads a's frame, projects the drawer front's centroid on its x and y (0 and 174.228 mm) and sets the offset with `editMate`: the drawer is not `moved`                                                                                                                                                                                                                                                                                                                                                                                                                       | None; `connectorFrames` in regen and `frameAxes` / `coordinateAxes` in packages/assembly are there for a viewer's connector triad                                 |
| No distance between faces of two bodies                                                                                                  | Found                         | Partly, closed (#1206)    | Closed by #1206. Found: `measure` `targets` measured within one body; the opening's width and height came from `clearance` box gaps, which only work for boxes aligned with the axes. Now a target's `bodyId` puts it on another body of the same part: the distance and angle between faces of two bodies, each item with its `bodyId`, and for two parallel planar faces `distance.planes`, the distance between their planes (`value`, the minimum, also counts a sideways offset). The test measures the opening's width between the sides' inner faces and its height from the bottom's top to the shelf's underside, 22-9/16" by 13-9/32", parallel and square across                                                                                                                                                                                                                                                                                                                                                            | None; `measuredDistance` in packages/kernel (the planes' distance, else the minimum) is what a `distance(...)` expression reads at regen (#1202)                  |
| The opening's side faces have fragile names                                                                                              | Found                         | Partly, closed (#1207)    | Closed by #1207. Found: the sides' inner faces were `extension#1:cap:end#1` and `extension#2:cap:start#1`, `fragile: true`, because the shelf's dados split them and the pieces were numbered by position. Now a wood joint's tools name the pieces of a board face they split after the joint face beside each (`keySplits` in packages/kernel): `extension#1:cap:end{extension#11:groove:xmin}` and `extension#2:cap:start{extension#12:groove:xmin}`, the pieces below the shelf, not fragile. The test raises the shelf 2" and finds both faces by the same names, and measures through the old names, which stay aliases and resolve exactly to the same faces                                                                                                                                                                                                                                                                                                                                                                    | None; other splits (extrude cuts, construction openings) still number their pieces, and could opt in the same way                                                 |

The request did not fit the guide's cabinet at all (an 18" slide in an 11-1/4" deep bookshelf).
That is a fixture choice, not a product gap; run A caught it and asked.
