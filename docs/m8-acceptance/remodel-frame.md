# M8 acceptance scenario: remodelling an existing frame (T8.6c)

The request, as the person would type it:

> On the shed, move the door 2' right, add a 3' window on the back wall, and show what new
> lumber I need.

The document is packages/session's M6 shed (`shedDocument()` in
`packages/session/src/test/fixtures.ts`, the same document the authoring guide's framing examples
run on): a 12' x 16' shed with four 2x4 walls, two front windows, a door in the right wall, a floor
on skids and a gable roof. The door (`extension#7`) is centred 72" along the Right wall
(`extension#3`, from (192", 0) to (192", 144")). Seen from outside, "right" is along the wall's own
direction, so the door moves to 96". The Back wall (`extension#2`) is 16' long, so a centred 3'
window has its centre line at 96" (an opening's `position` is the distance to its centre line).

## The scripted test

[`apps/mcp/test/scenarios/remodel-frame.test.ts`](../../apps/mcp/test/scenarios/remodel-frame.test.ts),
in the `mcp` vitest project, through the real MCP server in process (about 6 s).

What it does, as an agent would:

1. Opens a session on the shed and reads the takeoff as built (156 framing members).
2. Moves the door with one `editFeature` (position 72" to 96"), and adds the window with one
   `addFeature` (`extension#$window`, which becomes `extension#10`). No regen errors.
3. Renders the back and right walls, members only, base against head.
4. Works out "new lumber" as the surface allows: the member full ids of the back wall, the right
   wall, the door and the window, read per feature with `get_object`'s `members` query, before and
   after, as sets (they match the takeoff's framing row sources).
5. Exports the takeoff (`takeoff-csv`) and a framing elevation of the back wall
   (`drawing-svg`), building the drawing, sheet and view by hand with `addDrawing`.
6. Submits, and reads the stored review bundle's quantities.

Then the gap probes, each asserting today's behaviour so that a fix flips the test (they are named
`GAP PROBE` in the test): a `phase` param refused; and a partial `setDomainData` that breaks every
wall. Three more probes are now normal tests: two branches from the same Main whose merges
replaced each other's wall and domain data whole (since follow-up 4, #1216, the two merge field by
field), an as-built wall where a stud could be nudged off the layout but none added (since
follow-up 2, #1214, the wall adds an extra stud and a block, counted and drawn), and a spacing
change that lost one override and silently re-targeted two others (since follow-up 3, #1215, each
override finds its stud by the position it recorded, and is reported `moved` or `lost`).

The id diff after step 2: added are the window's 13 members and `extension#3:s3`, `s4` (studs
back in the door's old spot); removed are `extension#2:s5`, `s6`, `s7` (under the window) and
`extension#3:s6`, `s7` (under the door's new spot). The door's own 8 members keep their ids, and
the right wall's bottom plate pieces keep theirs with new lengths (two 4'2-1/2" pieces become
6'2-1/2" and 2'2-1/2"), so none of them show as new. The bundle's totals say framing 156 to 166.

## The live run

Claude Code 2.1.281, headless (`claude -p "<the request>" --mcp-config ... --strict-mcp-config
--allowedTools "mcp__manufakture__*" --output-format stream-json --verbose`), against the server
started with `node` on apps/mcp's sources, with a temporary library holding a copy of the shed and
a temporary output directory. It finished in 70 s, 19 turns, exit 0. The raw transcript is kept
outside the repository (`/tmp/m8-remodel-frame-transcript.jsonl` on the machine that ran it).

What the agent did, in order: read the authoring guide resource, `list_documents`,
`open_session`, `get_object` of the part, `get_quantities`, one `apply` for the door (72" to 96"),
one `apply` for the window (96", 36" x 36", 44" sill, matching the front windows),
`get_quantities` again, `render` of both walls with `compare` and the changed features
highlighted, `get_errors`, `submit_for_review` with a clear note and two views, `close_session`.

What it got right: the edits are exactly the scripted ones; it said how it read "right" ("as seen
from outside, toward the back") and that the other reading is a one-number change; it checked
renders and errors before submitting; it said the numbers came from an unreviewed branch.

Where it stumbled:

- **Both `get_quantities` answers were too large for the client** (79,269 and 83,825 characters,
  over Claude Code's limit for one tool result). The client saved them to files, and the agent
  used its own shell (jq and a Python script) to diff the takeoff rows. A client limited to the MCP
  tools could not have read them at all. (The shell was available in this environment although
  `--allowedTools` named only the MCP tools.)
- **"New lumber" was a net difference of two whole-frame takeoffs.** Its table of "new framing
  pieces" lists the window's members and "Studs -1", and says "the door move only re-cuts the
  right wall's bottom plate". Its "change to what you buy" mixes real additions with reshuffles of
  the 1D lumber layout (2x6 x 12' from 13 to 11, 2x4 x 14' from 1 to 0) and one more OSB sheet
  although the window makes the sheathing area smaller. It noticed the reshuffling itself ("the
  minus lines are partly the planner reshuffling") and then advised buying only the plus lines, as
  if the original list had been bought rather than the shed built. Nothing in the takeoff lets it
  say which pieces are demolished, which can be reused and which are new.
- It made no drawing, so nothing showed what comes out of the walls.

The authoring guide's framing section uses this very request as its example (door 2' along the
right wall to 96", a 3' window centred on the back wall at 96"), so the live run shows the guide
being followed more than the agent finding its way.

## Gaps

| Gap                                                                                               | Hypothesis from plan or found | Confirmed / Not confirmed / Partly | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Suggested follow-up                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Members and features have no phase (existing, new, demolish)                                      | Plan                          | Confirmed                          | A `phase` param on the door is refused (`unknown field "phase"`), and on a member override too. Takeoff rows have only the categories framing, linear, faces, lumber, sheet; totals count the whole frame (166 members). The bundle shows base and head totals (156 to 166). The moved door's members keep their ids, so a diff says the door needs nothing. The live agent's answer was a net delta full of layout reshuffles. Drawings draw the head's members only: a framing elevation's params are `kind`, `wall`, `segment`, `from`, `openings`, `marks`, with nothing that could dash removals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Phases for construction features and members, a "new material" and a "demolition" takeoff, and dashed removals on framing elevations and plans                                        |
| An as-built frame off the layout cannot be modelled                                               | Plan                          | Partly                             | Closed by follow-up 2 (#1214). Found: a stud could be nudged (`move_<n>`), deleted or restocked, but an override naming a member the wall does not have (`extra1`) was reported lost ("the wall no longer has that member", although it never had it), so no stud could be added. Now a wall or opening lists members its layout does not make in its `add` params, `{ id, role, stock?, plies?, segment? }` (id `add<k>`, role stud or blocking), placed by `add<k>_at` (along the wall from the segment's first point; an opening's from its centre line) and `add<k>_z` (a block's centre above the base). A stud stands on the plates (`plies: 2` makes `add<k>` and `add<k>-2`); a block fits between the verticals either side, as overridden (`frameWall`, `framing/wall.ts`). They are the feature's, take overrides, are counted and drawn, and the `members` query marks them `added: true`; one that does not fit warns `added-member-left-out`. Without `add` nothing changes. The probe's left wall adds a stud 44" along and a block 48" up, in the takeoff and the render; its `extra1` override now says "never had" and points to `add`, while `s40` still says "no longer".                                                                                                                                               | Added members on a wall (an extra stud, blocking, a doubled stud) at a position along the wall, owned by the wall, counted in the takeoff (2): done                                   |
| Changing the layout renumbers studs and orphans per-member changes                                | Plan                          | Confirmed, and worse               | Closed by follow-up 3 (#1215). Found: left wall overrides delete `s4` and `s8` and nudge `s3` by 3", then the spacing goes from 16" to 24": `s8` was lost with a warning, while the delete of `s4` and the nudge of `s3` silently applied to the studs that inherited their ids (centred at 96" and 72" instead of 64" and 48"), with no warning. Now a wall's override may record `at`: where its member was when it was made, the member's `along.centre` in mm (the app writes it; an agent reads it from the `members` query). An override of a layout stud (`s<k>`) or block (`block<r>:<n>`) with `at` applies to the stud (or block of that row) centred within 1/2" of it, whatever its id: `moved` with `appliedTo` and an `override-moved` warning when the id changed, `lost` with a warning when none is there (`frameWall`, `framing/wall.ts`). Overrides without `at`, and those of plates, corners, openings and added members (ids the layout does not renumber), match by id as before. The probe's `s4` and `s8` are now lost (no stud at 64" or 128") and the nudge of `s3` moves to `s2`, the stud at 48".                                                                                                                                                                                                              | Anchor each override to its member's position along the wall: report `moved` when the slot id changes, `lost` when none is there, and warn on any override whose slot moved (3): done |
| `setDomainData` replaces a whole namespace: the command diff is unreadable without the summariser | Plan                          | Not confirmed (for the diff)       | The construction domain has a summariser (`constructionDataSummariser`), used by both the bundle's domain section and the `setDomainData` command summary. The replace-whole part is real and a trap for an agent: writing only `{ framing: ... }` drops every level and type, and every wall, the floor and the roof fail (dry run).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Covered by the next row; the authoring guide should say "read the namespace, change it, send it whole" with an example                                                                |
| Two branches touching one wall (or the domain data) conflict as a whole                           | Plan                          | Confirmed                          | Closed by follow-up 4 (#1216). Found: branch A adds a header rule and deletes back-wall stud `s3`; branch B, from the same Main, sets a framing default and the back wall's height. After A merged, B's merge preview dropped nothing and replaced "Back (Part 1)" and "the document's domains" whole: A's header rule and stud override were gone, said only by the `replaced` list. The same held for any `editFeature`, since it replaces the whole feature. Now a merge replays `editFeature`, `restoreFeature` and `setDomainData` by field (`packages/sync/src/merge.ts`, the `mergeFields` option of `SyncClient`, used by the library's `rebaseOnto` for local and server-version merges and by the session's `replayOnto`): a feature's fields, params and expressions by key, lists of objects with ids by id, domain data at any depth; merged domain data and extension params are kept only when the owning domain reads them (`MergeValidator`, passed in by the hosts), else the branch's whole value wins and the plan's `mergedWhole` says why. The probe's merge keeps A's header rule and stud override and B's height, with nothing overwritten. A field both changed goes to the merged branch and is named in the plan's `overwritten` (`Back (Part 1): expressions.height`), shown first and highlighted in History. | Field-level merge for feature params and expressions and for domain data entries (by id in lists) (4): done                                                                           |
| `get_quantities` is too large for an agent to read                                                | Found                         | Confirmed                          | 79,269 and 83,825 characters for this shed: over Claude Code's limit for one tool result; the live agent had to use its own shell to read the saved file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Options on `get_quantities`: takeoff only, by category or owner, without layouts and sources, and a `compare` against the base (the bundle already makes that delta)                  |
| No way to list members                                                                            | Found                         | Confirmed                          | Closed by follow-up 6 (#1218). Found: `get_object` had no member query and the outline gives only counts per wall. Member ids were reached through the takeoff's row sources, or by guessing render patterns and reading `unmatched`. Override status (`applied`, `lost`) showed only as lost warnings. Now `get_object` takes `{ kind: "members", partId, owner }` (`membersOf` in `packages/session/src/queries.ts`, `memberListing` in `packages/domain-construction/src/member-list.ts`) and answers `members`: for a wall, opening, floor or roof, each member's full and local id, role, stock, blank length, centre, and for walls and openings its extent and centre `along` the wall segment and `above` the wall's base; and each override in params order with `n` (its `move_<n>`), what it does and its `status` (`applied`, `lost`; a string that may grow, such as `moved`). The scenario reads the id diff per feature through it, finds the window's cripples under its sill and the back-wall studs it displaced (`s5`, `s6`, `s7`, those between its kings) by position, and the as-built and layout probes read each override's status there.                                                                                                                                                                           | `get_object` (or a new read) for members by owner: id, role, stock, length, position along the wall, and override status (6): done                                                    |
| The construction drawing set is app-only                                                          | Found                         | Confirmed                          | "Construction set" is app code (`apps/web/src/construction/drawings/set.ts`), not a command. The test builds a framing elevation by hand (`addDrawing` with a domain view source, a view direction worked out from the wall, a scale); the live agent made no drawing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A command or session helper that makes a construction set (or one view of a wall), and an example in the authoring guide                                                              |

## Follow-ups

One per confirmed gap, ready to file (not filed here):

1. **Construction phases: existing, new, demolish.** Add a phase to construction features
   (walls, openings, floors, roofs) and to per-member overrides, with "existing" the default for a
   document marked as-built. Regen keeps the demolished members as data. The takeoff gains a
   phase filter (new only, demolition list), framing elevations and plans draw demolished members
   dashed, and the review bundle's quantities report new material. Moving an opening in an
   existing wall makes its old members "demolish" and its new ones "new". Acceptance: this
   scenario's request gives a "new lumber" list of the window's members, the door's members at its
   new place and the studs filling its old place, and an elevation with the old door framing
   dashed; the phase probes in `remodel-frame.test.ts` flip.
2. **Added members on walls.** Done (#1214): see the gap row, and "Walls and openings" in
   `docs/agents/authoring.md`. A wall (and an opening) may add members that its layout does not
   make: a stud, a doubled stud, a block, at a position along the wall, with stock, owned by the
   feature and counted in the takeoff; an override of a member the feature never had says so
   rather than "no longer". Acceptance: the as-built probe's extra stud appears in the takeoff and
   the render.
3. **Overrides that survive a layout change.** Done (#1215): see the gap row, and the
   `domain-construction` README's "Overrides". Store each override with the position of its
   member along the wall when it was made; on regen, match by position within a tolerance, report
   `moved` when the slot id changed and `lost` when nothing is there, and warn on every override
   whose slot moved. Acceptance: the layout probe's `s4` delete and `s3` nudge are reported
   (applied to the stud at their old position, or lost), never silently re-targeted.
4. **Field-level merge for features and domain data.** Done (#1216): see the gap row, and
   "Merging a branch" in `docs/user/history.md`. Replay of an `editFeature` or
   `setDomainData` onto a branch that changed the same object merges by field (params and
   expressions by key, domain lists by id), and only a field both sides changed is
   last-writer-wins and reported. History shows the replaced fields. Acceptance: the merge probe's
   two branches merge with both the header rule and the stud override kept, and the wall's height
   from B.
5. **Readable quantities for agents.** `get_quantities` options: `takeoff` only, `categories`,
   `owner`, `detail: false` (no layouts or source lists), and `compare: true` for base against head
   (the bundle's quantities delta). Acceptance: this scenario's "what changed" answer fits in one
   tool result under 20,000 characters.
6. **Members as data through MCP.** Done (#1218): `get_object` with a `members` query, see the
   gap row and "Walls and openings" in `docs/agents/authoring.md`. A read of a feature's members:
   id, role, stock, length, position along the wall, and each override's status. Acceptance: an
   agent finds the studs under a new window and the status of its overrides without the takeoff.
7. **Construction set from a session.** A command (or `apply` helper the session expands) that
   makes the construction set or one framing elevation of a wall, as the app's button does, plus an
   authoring guide example. Acceptance: an agent makes the back wall's framing elevation with one
   call and exports it.
