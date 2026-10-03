# @manufakture/drawing

Drawing sheets as 2D geometry: sheet sizes and frames, scales, views placed and aligned on the
sheet, hidden lines, centre marks, section hatching, dimensions, notes and a title block, all laid
out as one **display list** in paper millimetres. Pure TypeScript; its only dependency is
`packages/units` (value formatting). It does not import `packages/core` or `packages/kernel`
(M4 plan, decision 7): it defines its own inputs, which the regen drawing stage (T4.4e) fills from
core's drawing schema and the kernel's `project` op (T4.4b), and the SVG, DXF and PDF writers
(T4.4f) consume its output.

```ts
import { layoutSheet } from '@manufakture/drawing';

const list = layoutSheet({
  sheet: { size: 'A3', orientation: 'landscape' },
  scale: { paper: 2, model: 1 },
  views: [
    { id: 'view#1', edges: front.edges, position: [110, 130] },
    { id: 'view#2', edges: top.edges, align: { parent: 'view#1', direction: 'vertical' } },
  ],
  dimensions: [
    {
      id: 'dim#1',
      view: 'view#1',
      kind: 'horizontal',
      points: [
        [0, 0],
        [50, 0],
      ],
      offset: -10,
    },
    { id: 'dim#2', view: 'view#2', kind: 'diameter', circle: { center: [25, 0], radius: 4 } },
  ],
  notes: [{ id: 'note#1', text: 'BREAK ALL SHARP EDGES', at: [40, 70] }],
  titleBlock: { title: 'M1 bracket', drawingNumber: 'MK-0001' },
  format: { length: { unit: 'mm' } },
});
list.items; // lines, arcs, ellipse arcs, polylines, text and hatches, each on a layer
list.layers; // line type, weight and dash pattern per layer
list.warnings; // unknown or duplicate views, degenerate dimensions, views outside the frame
```

## Coordinates

- **View coordinates** are model millimetres in the view's frame: x right and y up on paper, as
  T4.4a's `views.ts` and the kernel's `project` op produce them. Every view input (edges, bounds,
  sections, dimension anchors) is in these.
- **Paper coordinates** are millimetres from the paper's bottom left corner, y up. Every display
  item is in these. Writers that need y down (SVG) flip once.
- A placed view maps one to the other with `paper = offset + scale * view`. Arcs and ellipse arcs
  run counter-clockwise from `start` to `end` in both.

## Inputs

| Input           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sheet`         | A named size (`A0` to `A4`, `ANSI A` to `ANSI E`, `Arch A` to `Arch E`, `Arch E1`; `Letter` and `Tabloid` for ANSI A and B) or a custom `{ width, height }` in mm; `orientation` (default landscape); frame `margins`.                                                                                                                                                                                     |
| `scale`         | Default scale of views: `{ paper, model }`, with `notation: 'imperial'` to write it as `1-1/2" = 1'`.                                                                                                                                                                                                                                                                                                      |
| view `edges`    | `{ item, cls, visible, curve }`: the shape of T4.4b's `ProjectedEdge`. `cls` is `sharp`, `smooth`, `sewn` or `outline`; `curve` is a `line`, `arc`, `ellipseArc` or `polyline`.                                                                                                                                                                                                                            |
| view `position` | Paper position of the centre of the view's bounds (default the frame's centre).                                                                                                                                                                                                                                                                                                                            |
| view `align`    | `{ parent, direction, side }`: a projected view stays on its parent's row (`horizontal`) or column (`vertical`), at the parent's scale; only the other coordinate of `position` is used. Without a position it goes beside the parent on `side`, named for third angle: `after` (default; right or above: right and top views) or `before` (left or below: left and bottom views). First angle flips both. |
| view `sections` | T4.4b's section loops per item, hatched.                                                                                                                                                                                                                                                                                                                                                                   |
| view `display`  | `hidden` (default true), `smooth` (`'thin'` or `'omit'`), `sewn` (default false), `centreMarks` (default true), hatch angle and spacing.                                                                                                                                                                                                                                                                   |
| view `overlay`  | Geometry a domain draws itself, view coordinates (`{ curve, layer, item? }`): member outlines in a framing elevation, member sections and door swings in a plan. Drawn as is on its layer, after the edges; part of the bounds when the view gives none.                                                                                                                                                   |
| `dimensions`    | Already projected anchors in a view's coordinates (regen resolves the model references and projects them): two points (`horizontal`, `vertical`, `aligned`), a circle (`radius`, `diameter`), two silhouette lines (`diameter` of a cylinder seen across) or a vertex and two legs (`angle`).                                                                                                              |
| `chains`        | Chained dimension strings (M6 plan T6.4a): points in order along one line in a view, `kind` and `offset` as a linear dimension's, `overall` (default: more than one span) and layout `marks`. Derived by regen, never stored.                                                                                                                                                                              |
| `symbols`       | Roof pitch symbols: `at` in a view, `pitch` in radians, `rises` `left` or `right`, `size` and `lift` in paper mm.                                                                                                                                                                                                                                                                                          |
| `notes`         | Text on paper, lines split at `\n`, with an optional leader to a paper point or a point in a view.                                                                                                                                                                                                                                                                                                         |
| `titleBlock`    | Title, drawing number, revision, sheet, scale (default: the views' shared scale or `AS SHOWN`), company, drawn by, date, material, units, projection. `false` for none.                                                                                                                                                                                                                                    |
| `disclaimer`    | Small text in a box on top of the title block (or in the frame's bottom right corner without one): the construction domain's "not an engineering tool" text.                                                                                                                                                                                                                                               |
| `format`        | The document's display units (ADR 0005), for every value: `{ length: { unit: 'ft-in', denominator: 16 } }` and so on. A dimension may carry its own.                                                                                                                                                                                                                                                       |

## The display list

Items are `line`, `arc`, `ellipseArc`, `polyline` (optionally `closed` and `fill`ed: arrowheads),
`text` (cap height, rotation, anchor, baseline) and `hatch` (loops, angle, spacing; `hatchLines`
expands one to segments). Each has a `layer` and an `owner` (`view#1`, `dim#2`, `note#1`,
`titleBlock`, `border`) so the app can pick and highlight; view edges also keep the projected
`item` they came from.

| Layer        | Line type     | Weight (mm) | What                                                                         |
| ------------ | ------------- | ----------- | ---------------------------------------------------------------------------- |
| `visible`    | continuous    | 0.5         | visible sharp edges and silhouettes                                          |
| `hidden`     | dashed 3, 1.5 | 0.35        | hidden sharp edges and silhouettes, less the parts lying under visible lines |
| `smooth`     | continuous    | 0.25        | visible tangent edges (hidden ones are never drawn)                          |
| `sewn`       | continuous    | 0.18        | seams, only when a view asks                                                 |
| `centre`     | chain         | 0.25        | centre marks on full circles                                                 |
| `dimension`  | continuous    | 0.25        | extension lines, dimension lines, arrowheads, ticks, leaders                 |
| `section`    | chain         | 0.5         | reserved for cutting plane lines                                             |
| `hatch`      | continuous    | 0.18        | section hatching                                                             |
| `text`       | (text)        |             | dimension values, notes, labels, title block text                            |
| `border`     | continuous    | 0.7         | the frame                                                                    |
| `titleBlock` | continuous    | 0.35        | the title block's grid                                                       |

## Rules and defaults

**Hidden lines under visible lines.** Exact HLR returns hidden edges that lie exactly under
visible ones (T4.4a: 0 to 331 mm per view on its fixtures: a hole's circles seen edge on under
the outline, a through hole's bottom circle under its top one). `removeHiddenUnderVisible`
trims them before layout: hidden lines against collinear visible lines, hidden arcs against
visible arcs of the same circle, hidden ellipse arcs against the same ellipse, and hidden
polylines segment by segment against anything. Hidden edges that coincide with an earlier hidden
edge (two holes seen end on, say) are trimmed the same way, so each hidden line is drawn once.
Only edges the view draws cover others: a hidden line under a smooth edge the view omits, under
a seam it does not draw or under a hidden smooth edge stays whole. Tolerance 0.01 model mm.

**Linear dimensions.** `offset` (paper mm) is how far the dimension line clears the anchor
nearest it; positive is above (horizontal), right (vertical) or left of the first point to the
second (aligned). Extension lines start 1 mm from the feature and run 2 mm past the dimension
line. Arrowheads go inside when the line has room for both and the value, otherwise outside
pointing in; text that does not fit goes past the far end. Values are measured from the anchors
in model units (|dx|, |dy|, the distance) unless the input gives `value`.

**Radius and diameter.** The terminator touches the circle at `angle`; large circles get a line
from the centre (radius) or across (diameter), small ones an arrow outside pointing in. The
value is the model size, prefixed `R` or `Ø` (U+00D8, which the PDF writer's standard fonts
have). A radius with `textSide: 'inside'` runs its leader back through the centre, for concave
fillets. A cylinder seen across is dimensioned by its two silhouette lines; `offset` moves the
dimension line up along them (right when they are horizontal), whatever the order of their
points, and when it goes past their ends, extension lines run out to it from the nearer ends.
Lines that are not parallel still get a dimension, with a `degenerate-dimension` warning.

**Angles.** Always the angle under 180 degrees between the two legs (never its reflex
complement): an arc at `radius` between the legs, with extension lines along legs shorter than
it. When the arc is too short for both arrowheads, they go outside pointing in and the arc runs on
under them.

**Chained strings.** `layoutChain` lays out a row of consecutive linear dimensions on one line
(each span through `layoutDimension`, so it looks like the single dimensions beside it; the
extension line two spans share is drawn once), the line `offset` paper mm past the farthest point
on its side, then the overall dimension a row further out (`rowGap`, default two text heights and
two gaps plus 1 mm, past any value nudged that way) and an X on the first row at each layout mark.
Placement is the M4 rule, a fixed offset with collision nudging only: a value that would overlap
the one before it on its row moves across the line, a row at a time, at most `MAX_NUDGE` (3) rows,
so a string of short spans comes out staggered. `chainSpans` gives the values. A chain with fewer
than two distinct points, more than `MAX_CHAIN_POINTS` (1,000) points or more than
`MAX_CHAIN_MARKS` (5,000) marks is a `degenerate-dimension` warning and is not drawn.

**Pitch symbol.** `layoutPitchSymbol` draws a right triangle `lift` (default 3) mm above `at`: the
run leg level and `size` (default 8) mm long, labelled with the run (`12`), the rise leg plumb at
the high end labelled with the rise, the hypotenuse at the roof's slope (up to a rise of three
runs). The labels come from `packages/units` (`formatAngle` with `unit: 'pitch'` in a slope
field, `6/12`), through `pitchLabels`. Text 2.5 mm.

**Disclaimer.** `layoutDisclaimer` wraps the text to the title block's width (`wrapText`: words,
0.85 cap heights a character so it stays inside the box in Helvetica and in a monospaced fallback,
at most `MAX_DISCLAIMER_LINES` (24, enough for the longest text) lines of 1.8 mm text, the text cut to `MAX_DISCLAIMER_LENGTH`
(2,000) characters first, a cut ending in an ellipsis) and draws it on the `titleBlock` layer.

**Text.** `'aligned'` (default) puts text along the dimension line, above it, readable from the
bottom or the right; `'horizontal'` writes it horizontally in a break in the line. Text widths
are estimated (0.6 cap heights per character) to decide what fits; the writers use real fonts.

**Values** go through `packages/units`: `40`, `4.5` (millimetres, trailing zeros and the unit
dropped by default), `1.5"`, `23/32"`, `40-1/2"`, `3' 4-1/2"`. Override text may contain `<>` for
the value (`2x <> CBORE`).

**Where the numbers come from.** None of ISO 128, ISO 129-1, ISO 5455, ISO 5457, ISO 7200 or
ASME Y14.5 was read for this package. The defaults follow how those standards are commonly
quoted, and each is marked in the code as either "as usually quoted, unverified" or "our
choice": the 0.5 and 0.25 mm line widths, dash proportions, 3.5 mm text, 3 x 1 mm arrowheads,
1 mm extension gap and 2 mm overshoot, ISO frame margins of 20 mm left and 10 mm elsewhere, the
standard scale series and the 180 mm title block. Sheet sizes are the published trimmed sizes
(ISO 216, ANSI/ASME Y14.1, architectural), converted at 25.4 mm per inch.

**Scales.** `scaleFactor` gives paper mm per model mm; `parseScale` reads `1:5` and
`1-1/2" = 1'` (a `paper = model` scale with a metric side, such as `10 mm = 1 m`, becomes the
ratio `1:100`); `formatScale` writes them back; `chooseScale` picks the largest standard scale at
which an extent fits a space (`METRIC_SCALES`, or `IMPERIAL_SCALES` from 3" = 1' to 1/16" = 1').

## Not here (yet)

- Ordinate and baseline dimensions (conveniences, Part 1 of the M4 plan).
- Centre lines along the axis of a cylinder seen across (the view edges carry no axis; regen
  could pass one).
- Collision avoidance between dimensions, notes and views: nothing here moves them apart. Each
  is placed where its `offset` or position says; only the values inside one chained string are
  nudged clear of each other (above).

## Tests

`pnpm --filter @manufakture/drawing test` (or `vitest run packages/drawing` from the root). The
golden `src/goldens/bracket-three-view.jsonl` is the M1 bracket's three-view drawing, laid out
from hand-written fixture data in T4.4b's shape (`src/fixtures.ts`), one display item per line.
After a deliberate change, look at the diff, then update it with `vitest run packages/drawing -u` (the path before `-u`, which would otherwise take it as its value).
