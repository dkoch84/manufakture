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
in the `mcp` vitest project, through the real MCP server in process (13 tests, about 6 s).

What it does, as an agent would:

1. On the guide's cabinet: measures a side (11-1/4" deep) and the back's front face (11-1/32" in):
   too shallow for the slide. Closes that session.
2. On the 22" cabinet: finds the opening's faces with `find_geometry` (the bottom's top, the
   shelf's underside, the sides' inner faces, the back) and measures the opening through
   `clearance` box gaps: 22-9/16" by 13-9/32", 21-25/32" deep.
3. Adds the drawer box in one batch: two variables (`#slide_clearance`, and `#drawer_width`, typed
   in as `22-9/16" - 2 * #slide_clearance`), five boards (1/2" plywood sides, front and back, a 1/4"
   bottom; 21-9/16" x 12" x 18") and four dowel joints, with symbols for the new sketches and
   boards in the boards' `sketch` and the joints' `a` and `b` too. When this scenario was first
   written those `params` fields did not take symbols, so it sent the batch as a dry run for the
   ids and then again with them put in; since #1223 the symbols resolve there and the batch goes
   once. No regen errors.
4. Adds the two slides as four plain extrudes (a cabinet member and a drawer member per side,
   1/4" x 1-3/4" x 18" each), made steel with `setBodyProps`; checks each slide touches but does not
   overlap the cabinet side and the drawer side.
5. Reads the quantities and exports a bill of materials (`bom-csv`).
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
8. Exports the cut list through the assembly and submits for review with a note.

The gap probes (tests named `gap probe`) assert today's behaviour, so a fix flips the test:

- a `setVariable` whose expression measures the model is refused (`expression`);
- the schema index has no hardware, component or catalog kind, and a `wood.slide` extension
  regenerates with `unsupported`;
- the slides are `excluded` from the cut list as `not-wood` and are in neither the hardware lines
  nor the `bom-csv` file, while the 16 dowels are;
- `interference` with a `travel` is refused by the input schema, and a pose pushed 4" into the
  cabinet (outside the slider's limits) reports a collision with no word about the mate;
- `render` refuses an `assemblyId`: it draws the part studio, never the assembly at a pose;
- widening the cabinet by 1" leaves the right slide 1" off the side and `#drawer_width` at
  21-9/16": nothing followed the opening.

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

| Gap                                                                                                                                      | Hypothesis from plan or found | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         | Suggested follow-up                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No purchased-part catalog: a slide is not a component with a length series, clearance and hole pattern, counted in the bill of materials | Plan                          | Confirmed     | No hardware, component or catalog kind in the schema index; a `wood.slide` extension regenerates `unsupported`; slides modelled as extrudes are `excluded` (`not-wood` in the test, `no-material` live) and are in neither the hardware lines nor `bom-csv`. Live run B: "order the slides separately", "check the real slide's height and screw-hole spacing"                                                   | A hardware catalog: purchased parts (drawer slides first) as a domain feature with size series and fit data, placed between two boards, counted as hardware lines |
| Interference is checked at one pose, not over a slider mate's travel                                                                     | Plan                          | Confirmed     | `measure` `interference` takes `poses` only; a `travel` is refused by the input schema; a pose outside the slider's limits is checked without a word. Scripted: three poses by hand. Live run B: five positions plus a self-made control, all through `clearance` placements                                                                                                                                     | An interference sweep over a slider or revolute mate's travel (limits by default), reporting the first colliding value and the pairs                              |
| Variables cannot take a measured value, so numbers are hardcoded and a later edit breaks them                                            | Plan                          | Confirmed     | A `setVariable` that measures the model is refused (`expression`); widening the cabinet 1" leaves the right slide 1" off the side and `#drawer_width` unchanged. Live run B used no variables at all; sketch coordinates are numbers, and the cabinet itself has no variables to follow                                                                                                                          | Measured variables: an expression (or a variable kind) that reads a distance between named faces at regen, with an error when a name is lost                      |
| The cut list does not separate hardware lines                                                                                            | Plan                          | Not confirmed | `get_quantities` gives `hardware` rows (`kind: hardware`) apart from boards, with a `hardware` total; `bom-csv` lists 16 dowels. The lines come only from joints, which is the catalog gap above                                                                                                                                                                                                                 | None of its own; covered by the catalog follow-up                                                                                                                 |
| The solved pose of an instance and a slider's value cannot be read; a pose past the limits is clamped silently                           | Found                         | Confirmed     | Closed by #1203. Found: `setPoses` 600 mm out was clamped to 457.2 mm with no warning, `get_object` showed the stored 600 mm, and `get_tree` mates carried only id, name, kind, status, suppressed. Now `get_tree` gives each instance's solved `transform` and `moved` and each mate's named `coordinates` (457.2 mm here), and the clamp is a `limit` warning on the mate in the apply report and `get_errors` | None; the solved poses (`solvedPoses` in regen) and the limit check (`limitViolation` in packages/assembly) are there for the travel sweep and assembly renders   |
| Render draws the part studio only, never an assembly at a pose                                                                           | Found                         | Confirmed     | `render` refuses `assemblyId`; neither the agent nor the review bundle can show the drawer open                                                                                                                                                                                                                                                                                                                  | `render` (and the bundle's views) of an assembly, at solved poses or at given poses or mate values                                                                |
| Mate connector frames are not readable, so connector offsets are found by trial                                                          | Found                         | Confirmed     | The slider needed a 174.228 mm offset along the cabinet connector's frame y; which axis that is (world up, for a -Y face) was found by trying, through the session's regen in the test                                                                                                                                                                                                                           | Return each connector's resolved frame (origin and axes) with `get_object` on a mate, or a frame hint per face in `find_geometry`                                 |
| No distance between faces of two bodies                                                                                                  | Found                         | Partly        | `measure` `targets` measures within one body; the opening's width and height came from `clearance` box gaps, which only work for boxes that are aligned with the axes                                                                                                                                                                                                                                            | `targets` across bodies of one part (distance and angle between faces of two bodies)                                                                              |
| The opening's side faces have fragile names                                                                                              | Found                         | Partly        | The sides' inner faces are `extension#1:cap:end#1` and `extension#2:cap:start#1`, `fragile: true`, because the shelf's dados split them                                                                                                                                                                                                                                                                          | A stable name for the pieces of a board face split by joints (for example by the region between two joints), so references to an opening survive                  |

The request did not fit the guide's cabinet at all (an 18" slide in an 11-1/4" deep bookshelf).
That is a fixture choice, not a product gap; run A caught it and asked.
