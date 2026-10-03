# The 12' x 16' shed by hand

The takeoff of the M6 acceptance shed (M6 plan, T6.7), worked out by hand from the generators'
documented defaults (`packages/domain-construction/README.md`, ADR 0015) before it was compared
with the app. `apps/web/e2e/m6-shed.spec.ts` builds the shed through the UI and checks the app
against these tables (they are in `apps/web/e2e/m6-fixtures.ts`). Inches throughout; dressed
sizes 2x4 1-1/2" x 3-1/2", 2x6 1-1/2" x 5-1/2", 2x8 1-1/2" x 7-1/4", 4x6 3-1/2" x 5-1/2".

## The shed as the spec builds it

- A feet-and-inches document to 1/16". Level 1 at 0, its walls 97-1/8" high (the US default:
  one bottom and two top plates on a 92-5/8" precut stud).
- Wall type: 2x4 studs, 7/16" OSB sheathing outside, no drywall; its default header two 2x8
  plies on one jack stud. Header rule entered by the user: openings up to 4': two 2x6 plies, one
  jack stud each end. Every opening here is narrower than 4', so every header is the rule's.
- Walls: one closed path drawn with the Wall tool, 16', 12', 16', 12', counter-clockwise from the
  origin, the path on the framing's outside face (left justification, the framing inside it).
  Studs at 16" from each segment's framed start, two-stud corners, no blocking (the defaults).
- Openings: a 36" x 80" door centred on segment 2 (the first 12' end, position 72"); two 24" x
  36" windows with a 44" sill, centred 48" and 144" along segment 1 (a 16' side).
- Floor: on the walls' outline, 2x6 joists at 16" spanning the 12' side, rims of the joist stock,
  three 4x6 skids, `3/4" OSB` subfloor (sold as 3/4", 23/32" thick; the app shows the name `3/4" OSB`).
- Roof: gable, 6/12, 2x6 rafters at 16", 2x8 ridge, 12" eave and rake overhangs, plumb tails,
  2x4 rafter ties 24" above the plates on every other pair, gable studs on, 7/16" OSB sheathing.

## Walls

**Pinwheel.** In a closed path each segment runs through at its end and butts at its start
(README, "Member stage"), so every segment's framing starts 3-1/2" in from its path start and
reaches the corner at its end: the 16' segments frame 192 - 3.5 = 188-1/2", the 12' ones
144 - 3.5 = 140-1/2". An opening's position moves with it: the door is at 72 - 3.5 = 68-1/2"
along its framing, the windows at 44-1/2" and 140-1/2".

**Studs** are 97.125 - 3 x 1.5 = 92.625", exactly the 92-5/8" precut. Studs, kings and corner
studs of that length are bought as precuts.

**Layout** (`layoutSlots`): slot 0 flush with the start, slot k centred on 16k while
`k <= (L - 2.25) / 16`, and the last stud flush with the end. 188-1/2": slots at 0, 16 .. 176
(11), end: 13. 140-1/2": 0, 16 .. 128 (8), end: 10.

**Corners**: the segment that runs through gets one `corner` stud 3-1/2" to 5" in from its end
(two-stud corners); one per segment, 4. None lands on a layout stud (176" and 128" are clear of
183-1/2" and 135-1/2").

**Openings** (rough opening RO; jacks and kings outside it, 1-1/2" each; the header spans the RO
plus the jacks; layout studs inside the kings' outer faces are removed; cripples stand on the
centred slots within the header's span, and for a window below the rough sill within the RO):

| Opening  | RO             | Kings' faces   | Header span | Slots removed | Cripples above | Cripples below |
| -------- | -------------- | -------------- | ----------- | ------------- | -------------- | -------------- |
| Door     | 50.5 to 86.5   | 47.5 to 89.5   | 49 to 88    | 48, 64, 80    | 64, 80         | none           |
| Window 1 | 32.5 to 56.5   | 29.5 to 59.5   | 31 to 58    | 32, 48        | 32, 48         | 48             |
| Window 2 | 128.5 to 152.5 | 125.5 to 155.5 | 127 to 154  | 128, 144      | 128, 144       | 144            |

(The slot at 48" is outside the door's header span, 47.25 < 49; the slots at 32" and 128" start
before their windows' RO, so no cripple below them.)

Heights: the head is at 80" for all three (door 0 + 80, window 44 + 36). Jacks run from the bottom
plate to the head: 80 - 1.5 = 78-1/2". The header is 5-1/2" deep, its top at 85-1/2"; the studs'
top is 1.5 + 92.625 = 94-1/8", so cripples above are 94.125 - 85.5 = 8-5/8". The rough sill lies
flat under the RO, 24" long, from 42-1/2" to 44"; cripples below run from 1-1/2" to 42-1/2": 41".
Header plies: door 36 + 3 = 39", windows 24 + 3 = 27", two each.

So per opening: door 2 kings + 2 jacks + 2 plies + 2 cripples = 8; each window 2 + 2 + 2 + 1 rough
sill + 3 cripples = 10.

**Studs left**: segment 1, 13 - 4 = 9; segment 2, 10 - 3 = 7; segments 3 and 4, 13 and 10: 39.

**Plates**: bottom 188-1/2" on segments 1 and 3, 140-1/2" on segment 4, and on segment 2 cut out
across the door: 0 to 50-1/2" and 86-1/2" to 140-1/2" (50-1/2" and 54"). Top course 1 the
segment's length. The cap (course 2) runs 3-1/2" past the butting start and stops 3-1/2" short of
the through end (the next segment's cap laps over it), so it is as long as the segment again.
No plate is longer than 16', so no splice. Plates: 6 x 188-1/2", 5 x 140-1/2", 54", 50-1/2":
13 pieces, 1938" (161' 6").

| Role           | Members | Of which                         |
| -------------- | ------- | -------------------------------- |
| stud           | 39      | 9 + 7 + 13 + 10                  |
| corner         | 4       | one per segment                  |
| king           | 6       | 2 per opening                    |
| jack           | 6       | 2 per opening                    |
| header         | 6       | 2 plies per opening              |
| rough-sill     | 2       | windows                          |
| cripple        | 8       | door 2, windows 3 each           |
| bottom-plate   | 5       |                                  |
| top-plate      | 8       |                                  |
| **wall group** | **84**  | of which door 8, windows 10 each |

This agrees with T6.1d's loop (62 members before openings, 46 studs; 76 with one door and one
window): one more window adds 10 members and removes 2 studs, 76 + 8 = 84.

## Floor

The floor's outline is the outside of the walls' framing, 192" x 144". Joists span the shorter
side (`joists: 'short'`), 144 less two 1-1/2" rims: 141". Layout along the 192" side as a wall's:
slots 0, 16 .. 176 (11), end: 13 joists. Two rims of 192" along the long edges (16' is a length
sold, no splice). Three 4x6 skids under the joists, the outline's 192" each (no overhang). 18
members.

Subfloor, laid across the joists in 96" x 48" sheets: 192 / 96 = 2 by 144 / 48 = 3, six whole
sheets, 192 sq ft.

## Roof

The footprint is the walls' framing outside, 192" along the ridge by a 144" span; the plates' top
at 97-1/8"; the birdsmouth seat the wall's 3-1/2". At 6/12: tan 0.5, cos 0.894427, sin 0.447214,
the common factor sqrt(12^2 + 6^2) / 12 = 1.118034.

- Run 72 - 0.75 = 71-1/4", line length 79.660".
- Height above plate (the rafter's top at the wall line) 5.5 / cos - 3.5 x tan =
  6.149187 - 1.75 = 4.399".
- Common rafter blank: (run + overhang + depth x sin) / cos = (71.25 + 12 + 2.459675) / 0.894427
  = 95.826" (7' 11-53/64"), plumb tail, birdsmouth, plumb cut at the ridge.
- Commons: gable layout on 192" at 16" (slot 0 flush, 16 .. 176, last flush): 13 a side, 26.
- Fly rafters: the 12" rakes put one beyond each end of each eave: 4, the same blank (no
  birdsmouth). 30 rafters of 95.826".
- Ridge: rake to rake, 192 + 2 x 12 = 216", longer than the longest ridge stock (16'), so spliced
  at the farthest rafter centre within 16' of its start: at 176", 188" and 28".
- Rafter ties: the pairs over the gable walls (slots 0 and 12) are not eligible; every other one
  of slots 1 .. 11 from the first: 1, 3, 5, 7, 9, 11, so 6 ties. 24" above the plates their
  underside meets the roof's top plane (4.399" above the plates at the wall line, rising 0.5 per
  inch) at (24 - 4.399) / 0.5 = 39.202" in from each wall line: 144 - 2 x 39.202 = 65.597"
  (5' 5-19/32").
- Gable studs stand on each gable wall's top plates on that wall's own layout, cut to the end
  rafters' underside, which rises 0.5 per inch from the seat's inside edge, 3-1/2" in from the
  wall line: a stud whose face nearer the middle is d from the nearer wall line is
  (d - 3.5) x 0.5 long; one shorter than its 1-1/2" width at its other face is left out. The e2 end (segment 2) lays out from its framed start at 3-1/2": centres at
  19-1/2", 35-1/2" .. 131-1/2"; the e4 end (segment 4, running the other way) from 140-1/2":
  centres 12-1/2", 28-1/2" .. 124-1/2". The stud at 3-1/2" (and at 140-1/2") is too short. None
  reaches the ridge (its underside 71-1/4" to 72-3/4"). Each end has 8 studs, together 2 each of
  4-7/8", 8-3/8", 12-7/8", 16-3/8", 20-7/8", 24-3/8", 28-7/8" and 32-3/8": 16 studs, 298".

| Role          | Members |
| ------------- | ------- |
| common-rafter | 26      |
| fly-rafter    | 4       |
| ridge         | 2       |
| rafter-tie    | 6       |
| gable-stud    | 16      |
| **roof**      | **54**  |

Roof sheathing, one face per plane: along the eave 192 + 2 x 12 = 216", up the slope
(12 + 72) x 1.118034 = 93.915"; 20,285.61 sq in a plane. (T6.1c's 18,031.65 sq in is the same
plane without the rakes, 192 x 93.915.)

## Hand table 1: every member, by stock and blank length

| Stock | Length   | Members | Roles                             |
| ----- | -------- | ------- | --------------------------------- |
| 2x4   | 188-1/2" | 6       | bottom and top plates             |
| 2x4   | 140-1/2" | 5       | bottom and top plates             |
| 2x4   | 92-5/8"  | 49      | studs 39, kings 6, corner studs 4 |
| 2x4   | 78-1/2"  | 6       | jack studs                        |
| 2x4   | 65.597"  | 6       | rafter ties                       |
| 2x4   | 54"      | 1       | bottom plate                      |
| 2x4   | 50-1/2"  | 1       | bottom plate                      |
| 2x4   | 41"      | 2       | cripples below the sills          |
| 2x4   | 32-3/8"  | 2       | gable studs                       |
| 2x4   | 28-7/8"  | 2       | gable studs                       |
| 2x4   | 24-3/8"  | 2       | gable studs                       |
| 2x4   | 24"      | 2       | rough sills                       |
| 2x4   | 20-7/8"  | 2       | gable studs                       |
| 2x4   | 16-3/8"  | 2       | gable studs                       |
| 2x4   | 12-7/8"  | 2       | gable studs                       |
| 2x4   | 8-5/8"   | 6       | cripples above the headers        |
| 2x4   | 8-3/8"   | 2       | gable studs                       |
| 2x4   | 4-7/8"   | 2       | gable studs                       |
| 2x6   | 192"     | 2       | rim joists                        |
| 2x6   | 141"     | 13      | joists                            |
| 2x6   | 95.826"  | 30      | common rafters 26, fly rafters 4  |
| 2x6   | 39"      | 2       | header plies (door)               |
| 2x6   | 27"      | 4       | header plies (windows)            |
| 2x8   | 188"     | 1       | ridge board                       |
| 2x8   | 28"      | 1       | ridge board                       |
| 4x6   | 192"     | 3       | skids                             |

156 members: walls 84, floor 18, roof 54.

## Sheets by face

Wall sheathing lies on the framing's outside face, which is the path itself: a face per segment,
192" or 144" long by 97-1/8", vertical 48" x 96" sheets from the segment's start (`wallFace`,
`layoutFace`). The roof carries each gable wall's sheathing up as a triangle 144" wide and
72 x 0.5 = 36" high; the wall is one path of four segments, so each triangle is a face of its own.

| Face                | Whole | Partial pieces                        | Cut-outs (offcuts)                                           |
| ------------------- | ----- | ------------------------------------- | ------------------------------------------------------------ |
| Segment 1 (windows) | 4     | 4 strips 48 x 1-1/8                   | 4 of 12 x 36 (windows straddle the 48" and 144" sheet edges) |
| Segment 2 (door)    | 3     | 3 strips 48 x 1-1/8                   | 36 x 80 (inside one sheet)                                   |
| Segment 3           | 4     | 4 strips 48 x 1-1/8                   |                                                              |
| Segment 4           | 3     | 3 strips 48 x 1-1/8                   |                                                              |
| Gable e2            | 0     | 48 x 24, 48 x 36, 48 x 24             |                                                              |
| Gable e4            | 0     | 48 x 24, 48 x 36, 48 x 24             |                                                              |
| Roof plane e1       | 2     | 24 x 48, 96 x 45.915 (2), 24 x 45.915 |                                                              |
| Roof plane e3       | 2     | 24 x 48, 96 x 45.915 (2), 24 x 45.915 |                                                              |
| Subfloor (3/4" OSB) | 6     |                                       |                                                              |

Wall sheathing as laid: 34 pieces, (192 + 144) x 2 x 97.125 less the openings (2 x 24 x 36 +
36 x 80) plus two triangles (2 x 2592) = 65,844 sq in, 457.25 sq ft. Roof: 12 pieces,
2 x 20,285.61 sq in, 281.74 sq ft.

**7/16" OSB**, 18 whole sheets. The partial pieces: segment 2's three strips go on its own door
cut-out (48" along its 80"). Nothing else fits the 12" x 36" window cut-outs. The pieces left come
to 30,797 sq in (four 96 x 45.915, two 24 x 48 and two 24 x 45.915 from the roof, four 48 x 24 and
two 48 x 36 from the gables, eleven strips); even if the door cut-out's remainder (at most 2,880 -
162 = 2,718 sq in) held some of them, 28,079 sq in is more than 6 sheets' 27,648: at least 7 new
sheets. Seven hold it all, with the 1/8" kerf, once the door cut-out also takes one 24 x 48 piece:
its three strips stand side by side along one 80" edge, 3 x 1-1/8" + 3 x 1/8" = 3-3/4" of its 36",
which leaves 32-1/4" x 80", and a 24 x 48 piece stands in that with 8-1/8" and 31-7/8" to spare.

| Sheet          | Pieces                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| Door cut-out   | 3 strips 48 x 1-1/8 (segment 2's own), one 24 x 48 beside them in the 32-1/4" x 80" |
| New sheets 1-4 | one 96 x 45.915 each, and a 48 x 1-1/8 strip in the 1.96" left above it             |
| New sheet 5    | 36 x 48, 24 x 48, 24 x 48 across (84-1/4"), up to 9 strips in the last 11-5/8"      |
| New sheet 6    | the same                                                                            |
| New sheet 7    | 24 x 48, 24 x 45.915, 24 x 45.915 across (72-1/4")                                  |

(Every piece is placed once: the six 24 x 48 pieces, the gables' four end pieces and the roof
planes' two, go 1 in the door cut-out, 2 each on new sheets 5 and 6 and 1 on new sheet 7; the two 36
x 48 are the gables' middle pieces, on sheets 5 and 6; the two 24 x 45.915 on sheet 7; the eleven
strips take 4 places on sheets 1 to 4 and 7 of the 18 on sheets 5 and 6. Sheet 7 has 23-5/8" left
after its kerf, too little for the sixth 24 x 48, which is why it goes in the door cut-out.) **25
sheets**: 18 whole and 7 new.

**3/4" OSB**: 6 whole sheets, nothing partial.

## Lengths bought

Precut studs: 49 (studs, kings and corner studs of 92-5/8").

The rest of each stock goes on sticks of 8' to 16' in 2' steps, a 1/8" kerf between pieces, no
trims, at the cheapest total (every length has a price per foot, so the least feet).

**2x4**, 51 pieces, 3282.33". The six 188-1/2" plates each take a 16' stick alone (3-3/8" is
left, shorter than any piece): 96 ft. The other 45 pieces are 2151.33". A Gilmore-Gomory column
generation bound (the LP relaxation over every cutting pattern, weights rounded down to 1/8" so
the bound stays valid) gives 181 ft for them; sticks come in whole even feet, so at least 182 ft.
182 ft is reached, for example:

| Stick | Pieces                                              |
| ----- | --------------------------------------------------- |
| 16'   | 78-1/2, 78-1/2, 28-7/8, 4-7/8                       |
| 14'   | 140-1/2, 24                                         |
| 14'   | 140-1/2, 16-3/8, 8-5/8                              |
| 14'   | 140-1/2, 8-5/8, 8-5/8, 8-5/8                        |
| 14'   | 78-1/2, 78-1/2, 8-3/8                               |
| 14'   | 78-1/2, 65.597, 20-7/8                              |
| 14'   | 78-1/2, 65.597, 16-3/8, 4-7/8                       |
| 14'   | 65.597, 41, 32-3/8, 24-3/8                          |
| 14'   | 50-1/2, 41, 24, 12-7/8, 12-7/8, 8-5/8, 8-5/8, 8-3/8 |
| 12'   | 140-1/2                                             |
| 12'   | 140-1/2                                             |
| 10'   | 65.597, 54                                          |
| 10'   | 65.597, 32-3/8, 20-7/8                              |
| 10'   | 65.597, 28-7/8, 24-3/8                              |

So **278 ft of 2x4** at the least (7 x 16', 8 x 14', 2 x 12', 3 x 10' in this layout; other layouts
of 278 ft exist). (An integer program over the same pieces found this layout; the bound proves no
layout is shorter.)

**2x6**: 30 rafters of 95.826" go two to a 16' stick (191.777" with the kerf): 15. Joists of 141"
one to a 12'. Rims of 192" a 16' each. The headers, 2 x 39 + 4 x 27 = 186" (186-5/8" with the
kerfs), one 16'. 18 x 16' and 13 x 12' = 444 ft; the column generation bound for the 2x6 is
444 ft, so this is the least, and with the fewest sticks (rafters and joists never share a stick,
nor joists with each other).

**2x8**: the ridge's 188" on a 16', its 28" on the shortest length sold, an 8'. **4x6**: 3 x 16'.

## Cost at the fixed prices

Prices: precut stud $4.50 each, 2x4 $0.75, 2x6 $1.10, 2x8 $1.50, 4x6 $2.50 a foot, 7/16" OSB $16,
3/4" OSB $38 a sheet.

| Row                  | Quantity | Cost          |
| -------------------- | -------- | ------------- |
| Precut studs 92-5/8" | 49       | $220.50       |
| 2x4                  | 278 ft   | $208.50       |
| 2x6 16'              | 18       | $316.80       |
| 2x6 12'              | 13       | $171.60       |
| 2x8 16'              | 1        | $24.00        |
| 2x8 8'               | 1        | $12.00        |
| 4x6 16'              | 3        | $120.00       |
| 7/16" OSB            | 25       | $400.00       |
| 3/4" OSB             | 6        | $228.00       |
| **Total**            |          | **$1,701.40** |

## Hand table 2: the stud rows at 24"

Changing the framing default spacing to 24" moves the walls' layout and the gable studs (which use
the gable walls' spacing); joists and rafters keep their own 16".

- Layout: 188-1/2" gives 0, 24 .. 168 (7), end: 9; 140-1/2" gives 0, 24 .. 120 (5), end: 7.
- The windows' kings (29-1/2" to 59-1/2", 125-1/2" to 155-1/2") remove 48" and 144": segment 1
  has 7. The door's (47-1/2" to 89-1/2") remove 48" and 72": segment 2 has 5. Segments 3 and 4:
  9 and 7. 28 studs; with 6 kings and 4 corner studs, **38 precut studs**.
- Cripples: one above each opening (48", 144", 72"), one below each window (48", 144"): 3 of
  8-5/8" and 2 of 41". The door has 7 members, each window 9, the wall group 70.
- Gable studs at 24": e2 centres 27-1/2", 51-1/2", 75-1/2", 99-1/2", 123-1/2"; e4 centres
  20-1/2", 44-1/2", 68-1/2", 92-1/2", 116-1/2" (3-1/2" and 140-1/2" too short). None is under the
  ridge (the one at 75-1/2" starts at 74-3/4", past its 72-3/4"). Lengths, 2 of each:
  8-7/8", 12-3/8", 20-7/8", 24-3/8", 32-7/8": **10 gable studs**, and the roof 48 members.

| Stock | Length  | Members | Roles                             |
| ----- | ------- | ------- | --------------------------------- |
| 2x4   | 92-5/8" | 38      | studs 28, kings 6, corner studs 4 |
| 2x4   | 41"     | 2       | cripples                          |
| 2x4   | 32-7/8" | 2       | gable studs                       |
| 2x4   | 24-3/8" | 2       | gable studs                       |
| 2x4   | 20-7/8" | 2       | gable studs                       |
| 2x4   | 12-3/8" | 2       | gable studs                       |
| 2x4   | 8-7/8"  | 2       | gable studs                       |
| 2x4   | 8-5/8"  | 3       | cripples                          |

Every other row of hand table 1 stays as it is.

## Where the app and the hand calculation differ

Checked with `apps/web/e2e/m6-shed.spec.ts` on 2026-10-03.

- **Agree**: every member of hand tables 1 and 2 (role, stock, blank length, count), the member
  counts per group, the plates' 1938", the faces as laid (34 + 12 + 6 pieces and their areas),
  the precut studs, the 2x6, 2x8 and 4x6 rows and their cost, the subfloor's 6 sheets, the 18
  whole sheets of 7/16" OSB, and the 51 2x4 members cut from sticks.
- **Fixed in the app**: the takeoff counted only one of the two gable triangles when both gable
  ends stand on one closed wall (its gable fills were keyed by wall and layer, so the second
  overwrote the first): 7 faces where there are 8, 24 sheets of 7/16" OSB. Hand right; fixed in
  `apps/web/src/construction/takeoff/input.ts`, with a unit test.
- **Known gap, packing (a follow-up, not part of M6 acceptance)**: the takeoff's packers are
  heuristics, documented in `packages/nesting/README.md` as good, not optimal, so their bought
  quantities are not wrong against that contract. For lengths and sheets bought, the hand
  calculation's job is a proven lower bound, and the app comes close to it:

  | Bought           | Hand least        | App                       | Difference |
  | ---------------- | ----------------- | ------------------------- | ---------- |
  | 2x4 sticks       | 278 ft            | 280 ft (17 x 16', 1 x 8') | 2 ft       |
  | 7/16" OSB sheets | 25 (18 whole + 7) | 26 (18 whole + 8)         | 1 sheet    |
  | Cost             | $1,701.40         | $1,718.90                 | $17.50     |

  The 2D packer turns a 24" x 45.915" roof end piece sideways on the seventh new sheet and needs
  an eighth for the last one. Every other stock (2x6, 2x8, 4x6, 3/4" OSB) and the precut studs
  come out at the hand calculation's least.

- **What the spec asserts for the bought rows**: precut studs exactly; for each packed stock,
  that what is bought holds every member or face of the hand tables (the members cut from each
  lumber stock, the faces each sheet stock covers, and at least their length or area), and that
  the quantity is at least the hand calculation's least and at most one 16' stick or one sheet
  more; the cost is exactly the sum of the app's bought rows at the fixed prices, from $1,701.40
  up to the bound those allowances give. A better packer would turn the app's rows into the hand
  least without touching the spec.
