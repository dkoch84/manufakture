# @manufakture/io

File formats for getting parts out to slicers and other CAD tools and bringing geometry in, published views (`.mfkview`) for sharing, 2D sheets (drawings, laser and plasma outlines) out as SVG, DXF and PDF, SVG artwork in as lines and arcs for sketches, and buildings out as IFC. STL and 3MF are written and read here, in plain TypeScript with no WebAssembly; STEP geometry goes through the kernel (OCCT's translators, see the kernel README's STEP exchange), and this package only reads STEP text. It runs the same on the main thread, in a worker and in Node.

```ts
import {
  deflectionOf,
  EXPORT_TOLERANCES,
  exportStl,
  export3mf,
  parseStl,
  validate3mf,
  checkManifold,
} from '@manufakture/io';

// Mesh a body at an export tolerance (in the kernel worker), then write files.
const mesh = kernel.mesh(body, deflectionOf(EXPORT_TOLERANCES.fine));
const [stl] = exportStl([{ name: 'Bracket', mesh }]); // { name: 'Bracket.stl', bytes }
const threemf = export3mf([{ name: 'Bracket', mesh }]); // Uint8Array, a 3MF package
```

## Export pipeline

The kernel tessellates a body per B-rep face, each face with its own copy of its vertices (the viewport needs that for picking). A file for a slicer needs one closed surface, so every export goes through `exportMesh(body)`:

1. **`weld`** merges vertices closer than `DEFAULT_WELD_TOLERANCE` (1e-4 mm: far below any export tolerance, far above float32 noise at part sizes) with a spatial hash, keeping the first vertex of each cluster, the triangle order and the winding. Triangles that welding collapses (two corners on one vertex: a cone apex, a sphere pole, a seam) are dropped.
2. **`checkManifold`** requires every edge to be shared by exactly two triangles running it in opposite directions (closed, manifold, consistently wound), no degenerate triangle (a repeated corner, or less than 1e-12 mm2 of area) and a positive enclosed volume (wound outward). A mesh that fails throws `NotWatertightError` with the report; nothing is repaired silently.
3. The writer.

`kernel-export.test.ts` runs real kernel bodies through this at every preset: the demo part (fillets, a through hole), a sphere (two poles), a cone (an apex and a seam) and a torus (two seams). All come out watertight, and the mesh volume approaches the exact volume as the tolerance tightens (under 1% at `fine`).

### Tolerances

`ExportTolerance` is `{ chordal, angular }`: the largest distance in mm between a triangle and the true surface, and the largest angle in radians between neighbouring facets. They are the kernel's `Deflection` (`linear`, `angular`) under their usual export names; `deflectionOf(t)` converts. Presets:

| Preset   | Chordal  | Angular             | For                          |
| -------- | -------- | ------------------- | ---------------------------- |
| `draft`  | 0.1 mm   | 0.5 rad (28.6 deg)  | quick looks, small files     |
| `normal` | 0.02 mm  | 0.25 rad (14.3 deg) | printing (the default)       |
| `fine`   | 0.005 mm | 0.1 rad (5.7 deg)   | small or precise round parts |

## STL

- `writeBinaryStl(mesh, { header? })`: binary STL, 80-byte ASCII header (never starting with `solid`, which would make readers take it for ASCII STL), facet normals computed from the winding, attribute bytes 0. STL has no units; by the convention every slicer follows the numbers are millimetres.
- `exportStl(bodies, { merge?, fileName? })`: welded and checked; one file of every body (default), or one file per body, named after the body.
- `fileName(name, extension)`: a safe download name from a body or document name. Path separators, reserved characters, controls and unpaired surrogates become `_`; bidirectional controls (U+202A to U+202E, U+2066 to U+2069 and the marks) are removed, so a name cannot display a false extension; the base is cut to `MAX_FILE_NAME_BYTES` (200) of UTF-8 on a character boundary, without trailing dots or spaces.
- `parseStl(bytes)`: binary or ASCII. Binary is recognised by its size (84 + 50 n bytes), not its header, since many binary files start with `solid` too. The result is welded, so it can be checked and measured; `fileTriangles` counts what the file had.

## 3MF

`write3mf(objects, options)` writes the 3MF core specification's package: `[Content_Types].xml` (content types for `.rels` and `.model`), `_rels/.rels` (the root relationship to the model part) and `3D/3dmodel.model` with `unit="millimeter"`, the core namespace, `Application` (default `manufakture`) and optional `Title` metadata, one `type="model"` object per input with its `name`, and the build. An object is a mesh (`{ name, mesh, color? }`) or made of components (`{ name, components: [{ object, transform? }] }`, each an earlier object by index: 3MF defines resources before they are used). The build is one item per object by default, or `options.items` (`{ object, transform? }`). Coordinates are written to a nanometre and transform entries to 1e-9, both without exponents; an identity transform is not written. Transforms must be rigid: one that mirrors, scales or shears is refused (a mirror would turn a mesh inside out). Names and metadata are escaped for XML: tab, newline and carriage return as character references (a parser would turn raw ones in an attribute into spaces), and what XML 1.0 cannot hold (other controls, U+FFFE, U+FFFF, unpaired surrogates) dropped. It is zipped with fflate. `export3mf(bodies)` welds and checks first, and passes each body's `color` on.

Transforms are 3MF's 3 x 4 matrices (`Matrix3x4`: `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`, for row vectors, so rows 0 to 2 are the images of the axes and row 3 the translation). `placementMatrix(placement)` turns an instance pose (a unit quaternion `[x, y, z, w]` and a translation, as regen solves it) into one; `composeMatrices`, `matrixDeterminant` and `transformMesh` (vertices moved, triangles kept) work on them.

### What is written, and why

What a slicer makes of a 3MF was measured, not assumed: the M3 spike built eight small files that each write a red and a blue box one way, and ran them through the command lines of OrcaSlicer 2.4.2, Bambu Studio 2.8.2 and PrusaSlicer 2.9.6 ([research note, section 6](../../docs/research/slicer-handoff.md#6-verified)). From that:

- **Colours** (`color`, `#rrggbb` in any case, written upper case): the materials extension's namespace is declared with the prefix `m`; each distinct colour, in first-use order, gets a `<m:colorgroup>` of its own holding that one `<m:color>`, and each coloured mesh object names its group with `pid` and `pindex="0"`. The groups come first in the resources, so they take ids 1 to n and the objects follow. There is no `requiredextensions`, so a reader without the extension still loads the geometry. OrcaSlicer and Bambu Studio give each group its own filament slot, in order (fixture 02); they take the slot from the file but never the colour itself, which stays the slot's. Only `pindex="0"` and no per-triangle colours, since OrcaSlicer ignores both (fixture 04). PrusaSlicer ignores colours and loads the geometry and names.
- **One mesh object per body per placement.** Build-item transforms place and orient objects in all three slicers (fixture 06). One object placed by several build items is avoided: OrcaSlicer and Bambu Studio split it into an object per item, and every copy after the first loses its name and its slot (fixture 08). So `export3mfAssembly` writes the mesh again for each placement.
- **Components only with `Metadata/model_settings.config`.** A bare components object makes OrcaSlicer and Bambu Studio name its parts after the object and print every part in one slot, and PrusaSlicer splits it anyway (fixture 03). With a minimal `model_settings.config` naming the object and its parts and giving each a slot (`extruder`), both keep one object with a named part per body, each in its slot (fixture 07). So whenever `write3mf` writes a components object, it adds `Metadata/model_settings.config` (content type `text/xml` for `.config`): every object the build makes, in id order, with `name` and `extruder` (its colour group's position plus one; none for an uncoloured object, which takes the slicer's default), and for a components object each distinct object it places as a `<part id="<object id>" subtype="normal_part">` with `name` and `extruder` (the object takes its first coloured part's slot). Nothing else: no plates, matrices or project settings. Neither slicer took such a file for one of its projects.
- **`Application` is never Bambu Studio or OrcaSlicer**: `write3mf` refuses a value naming either, since those slicers read a file that claims to be theirs as a project of their own.

`fixtures.test.ts` checks that `write3mf` writes fixtures 02, 06 and 07 byte for byte, so the slicers' results apply to our files. The spike's command-line results are provisional until the GUI checks (T3.0d) confirm them.

`parse3mf(bytes)` reads that same subset back (the root relationship, content types, unit, metadata, colour groups with their colours and the namespace their prefix is bound to, the ids of other property groups, mesh objects with `pid`, `pindex` and the colour they pick, components objects with their components and transforms, build items with their transforms, and `Metadata/model_settings.config` objects and parts with their metadata), with a small regex reader rather than a DOM parser so it runs in Node. `buildMeshes(parsed)` gives the meshes the build makes in world coordinates, each with its object's colour: every item's object, components resolved through their transforms. `validate3mf(bytes)` is the structural check tests and CI use: package parts and content types, unit millimetre, resource ids unique, triangle indices in range, every mesh object watertight and outward (`checkManifold`), every component naming an object that exists and is defined before it (which also rules out cycles), every build item naming an object, every transform rigid (12 finite numbers, no mirror, scale or shear); colour groups in the materials namespace with `#RRGGBB` or `#RRGGBBAA` colours, every `pid` naming a property group and every `pindex` inside its colour group; in `model_settings.config`, every object existing, every part of a components object being one of its components, and every `extruder` a slot from 1. It checks the files this package writes, not 3MF at large: a slicer's project file fails it, since slicers save scaled build items (not rigid) and components through the production extension, whose `p:path` points into other model parts, so the objects they name do not exist in the root model as far as this check reads it.

### Assemblies

`export3mfAssembly(assembly)` and `exportStlAssembly(assembly)` export an assembly (`ExportAssembly`: the bodies of its parts, each meshed once in its part's coordinates, with an optional colour; the parts, by body index; the instances, each a part and a placement). Every body is welded and checked once, however many instances show it. In 3MF every body of every instance is a mesh object of its own, in its colour, placed by a build item at the instance's transform; the object is named after the part when the part has one body, after the body otherwise. A part of several bodies marked `oneObject` (a sign with inlaid letters, bodies that touch) is written per instance as its bodies' mesh objects plus one components object named after the part, which the build item places, with the `model_settings.config` above. STL has no instances, so every instance's meshes are moved into place and merged into one file. Every body must belong to exactly one part and every part needs an instance. STEP assemblies are the kernel's (`exportStep` with `assembly`).

### Slicer fixtures and the OrcaSlicer matrix

Two scripts in `scripts/`, plain Node (type stripping), no build step:

- `pnpm --filter @manufakture/io fixtures:slicers` (`node scripts/slicer-fixtures.ts`) writes the eight fixtures to `src/fixtures/slicers/`. They are committed; `fixtures.test.ts` fails if they differ from what the script builds, and checks that each parses and validates.
- `pnpm --filter @manufakture/io orca:matrix [file.3mf ...]` (`node scripts/orca-matrix.ts`) loads each fixture (or the given files) with OrcaSlicer's command line, writes it back as a project, slices it for a Bambu Lab X1 Carbon with two filament slots, and prints what the slicer made of it: objects, parts, names, the slot per object and part, positions, and which slot the G-code prints each object with. `ORCA_CMD` names the program (an extracted AppImage works, and Bambu Studio's binary takes the same flags), `ORCA_PROFILES` its profile directory, `ORCA_OUT` where results go (outside the repository: the profiles it flattens there are the slicer's). It needs no display. `orca-matrix.test.ts` tests its readers without a slicer.

PrusaSlicer slicing our 3MF, and OrcaSlicer 2.4.2 loading and slicing our exports and the fixtures with the names and slots the matrix found, are automated in the optional `interop` CI job (below); run the full matrix by hand when the writer or a slicer version changes. Not written: materials other than colours, per-triangle colours, plates, the production and slice extensions.

## 2D sheets: SVG, DXF and PDF

One 2D layer under three writers, shared by drawings (M4 T4.4f) and the laser and plasma export (M5 T5.6a), so neither `packages/drawing` nor `packages/cam` depends on the other: each maps its own geometry onto a `Sheet2` and calls the same writers.

```ts
import { drawingToDxf, drawingToPdf, drawingToSvg, writeDxf, writeSvg } from '@manufakture/io';

const list = layoutSheet(input); // packages/drawing's display list
drawingToSvg(list, { title: 'M1 bracket' }); // string
drawingToDxf(list); // string
drawingToPdf([list, list2], { title: 'M1 bracket' }); // Uint8Array, a page per sheet

writeDxf({
  layers: [{ name: 'cut' }],
  items: [{ kind: 'path', layer: 'cut', closed: true, segments }],
});
```

### The shared layer (`path2.ts`)

Millimetres, y up. A `Sheet2` is an optional paper `size` (origin at its bottom left; without one, SVG and PDF page the items' bounds, as a laser file wants: paths by their extremes, text by its box estimated from Helvetica's widths, from the descender to the cap height, so it is not clipped; each side at least 1 mm; a sheet with neither a size nor items is an error rather than a 0 mm page), `layers` in drawing order and `items`, each on a declared layer:

- `Layer2`: `name`, `weight` (mm, default 0.25), `dash` (mm, dash and gap alternating; empty is continuous; every writer takes a negative entry as 0, and a pattern of zeros as continuous), `lineType` (the DXF linetype name for a dashed layer, default `DASHED`), `color` (`#rrggbb`, default black; every writer draws anything else in black).
- `Path2`: `segments` (`line`, `arc`, `ellipseArc`), `closed`, `fill`, `owner`. Arcs and ellipse arcs run from `start` to `end`: counter-clockwise when `end > start`, clockwise when `end < start`, a full turn when they differ by 2 pi; ellipse angles are eccentric anomalies. So a cutting loop keeps its direction and a clockwise hole stays clockwise. Segments that do not join (within 1e-6 mm) start a new subpath; `closed` adds a closing line when the last end is not the first start.
- `Text2`: `at`, `text`, cap `height`, `rotation`, `anchor` (`start`, `middle`, `end`) and `baseline` (`bottom` is the baseline, `middle` half the cap height, `top` the cap height), the drawing package's text model.

Every writer draws layer by layer in the sheet's order, items in order within a layer, and writes numbers with at most six decimals (four in PDF content, where it is 1e-4 mm), never with an exponent: `formatNumber` throws a `RangeError` for a value that is not finite or reaches 1e21 after rounding, and arc angles beyond 1e6 rad either way are refused. Output is deterministic.

### SVG (`writeSvg`)

`width` and `height` in `mm` and a `viewBox` in millimetres, so one user unit is one millimetre; y is flipped once into the coordinates (no transform), so a reader gets the geometry back by flipping. One `<g>` per layer with `id="layer-<name>"`, `data-layer`, `stroke`, `stroke-width`, `stroke-dasharray` and caps (round, butt when dashed: round caps lengthen dashes). Paths use `M`, `L`, `A` (a full circle or ellipse as two half arcs; `maxArcSweep` splits every arc into commands of at most that sweep) and `Z`; filled paths carry `fill`; `owner` becomes `data-owner`, for the app to pick. Text is `<text>` at its baseline point with `text-anchor`, `rotate(...)` and `font-family="Helvetica, Arial, sans-serif"` at a font size of cap height / 0.718 (Helvetica's cap height). No CSS, patterns, markers, clip paths or `dominant-baseline`, so every renderer and converter draws it the same.

### DXF (`writeDxf`)

ASCII DXF, AutoCAD 2000 (`AC1015`): the oldest version with `LWPOLYLINE` and `ELLIPSE` and the one readers support most widely. Units are millimetres in the header (`$INSUNITS` 4, `$MEASUREMENT` 1; `$LUNITS` decimal, `$EXTMIN`/`$EXTMAX` from the items, `$LIMMIN`/`$LIMMAX` the paper). The file has the full AC1015 skeleton (handles and owners, subclass markers, the nine symbol tables, model and paper space blocks, the root dictionary with the group and plot style dictionaries), which AutoCAD is said to require of a DXF 2000; that claim is unverified, since no AutoCAD was available: only ezdxf 1.4.4's audit was run, by hand and not in CI, and it finds no error or fix in our files. No `LAYOUT` objects are written (the model and paper space blocks have none), which a reader that wants layouts may add or complain about. Each layer gets its colour (the nearest of ACI 1 to 9; black is 7), the nearest standard lineweight and a linetype: `CONTINUOUS`, or one built from its dash pattern (in mm, `$LTSCALE` 1) named by `lineType`, made unique when two layers share a name with different patterns. Paths become `LINE`, `ARC` or `CIRCLE` when they are one segment, and one `LWPOLYLINE` (arcs as bulges, a full circle as two; bulges to `bulgeDigits` decimals, default 6) when they are several connected lines and arcs, so a laser loop stays one closed entity; ellipse arcs are `ELLIPSE` (axes swapped when the minor is the longer, since DXF needs a ratio of at most 1). Filled paths of three or four straight sides (arrowheads) get a `SOLID` as well as their outline; larger fills are outlined only. Text is `TEXT` in style `STANDARD` (`arial.ttf`) with its height as the cap height, its rotation, and the horizontal (left, center, right) and vertical (baseline, middle, top) justification with the alignment point; Ø, ° and ± are written `%%c`, `%%d` and `%%p`, other non-ASCII characters `\U+XXXX`, and a `%` followed by another `%` (literal, or one of those codes) as `%%%`, so text such as `%%d` is not read as a control code. Layer and linetype names cannot hold `\U+XXXX`, so every non-ASCII character in them becomes `_` (with the reserved characters and controls); the whole file is then ASCII, which reads the same under the header's `$DWGCODEPAGE` `ANSI_1252` as under any other code page.

### PDF (`writePdf`)

One page per sheet, `MediaBox` the sheet in points (72 per 25.4 mm). The content stream draws in millimetres under one `cm` scale: per layer the line width, dash pattern, caps and colour; paths with `m`, `l`, `c` (arcs and ellipse arcs as cubic Beziers of at most a quarter turn, under 3e-4 of the radius off) and `h`, stroked (`S`) or filled and stroked (`B`); text with `Tm` (position and rotation) and `Tj` in Helvetica, a standard 14 font, WinAnsiEncoding, so no font is embedded (and none needs a license). Anchors are placed with Helvetica's AFM widths (`helvetica.ts`; pdf.js measures the same widths in the tests). Characters outside Windows-1252 print as `?`. Content streams are deflated with fflate (`compress: false` for readable output); there is no creation date unless given, so the bytes are reproducible.

**Why our own writer and not jsPDF with svg2pdf.js** (the M4 plan's Part 1 suggestion): a drawing needs vector paths, dashes, fills and standard-font text, which is about 250 lines of PDF here, plus the Helvetica width table. svg2pdf.js renders an SVG _DOM_, which a worker and Node do not have, so it would tie PDF export to the main thread and to a DOM shim in tests; jsPDF and svg2pdf.js together are a few hundred KB of JavaScript to lazy-load, and svg2pdf.js supports only a subset of SVG, which would have constrained the SVG writer too. Writing from the `Sheet2` directly gives the same geometry as the SVG and DXF by construction, runs anywhere this package runs, adds no runtime dependency (fflate was here already), and is checked by parsing it back with pdf.js. Multi-page output is built in, which the cut list PDF (T4.3d) needs. If richer PDF layout (flowing tables) is ever wanted, a layout library can sit beside this.

### Drawings (`drawing-export.ts`)

`displayListToSheet(list)` maps `packages/drawing`'s display list: the paper size; the layers in `LAYER_NAMES` order with their weights and dashes, dashed lines as DXF `HIDDEN` and chain lines as `CENTER` (`DRAWING_LINETYPES`; the section layer's longer chain becomes `CENTER_SECTION`); lines, arcs and ellipse arcs with their counter-clockwise sweep made explicit; polylines as paths of lines (closed and filled kept); text as is; hatches expanded to their lines with the drawing package's `hatchLines` (0.05 mm flattening), the same in every format. `owner` is kept, `item` dropped. `drawingToSvg`, `drawingToDxf` and `drawingToPdf` (several sheets, a page each) wrap it.

### Loops for laser and plasma (`loopsToDxf`, `loopsToSvg`)

Closed outlines (M5 T5.6a) go through the same writers. A `LoopLayer2` is a `Layer2` (name, colour, weight) with its `loops`; a `Loop2` is a list of `line` (`start`, `end`) and `arc` (`start`, `end`, `center`, `ccw`, `fullCircle`) segments plus an optional `id`. That is the shape of `packages/cam`'s `Loop2`, declared again here so io does not depend on cam: cam's loops pass as they are (their `source` tags are ignored).

```ts
import { loopsToDxf, loopsToSvg } from '@manufakture/io';

const layers = [
  { name: 'outside', color: '#ff0000', loops: outline.loops },
  { name: 'engrave', color: '#0000ff', loops: lettering.loops },
];
loopsToDxf(layers); // string, AC1015 in millimetres
loopsToSvg(layers, { title: 'Sign' }); // string; `size` keeps the origin at (0, 0)
```

`loopsToSheet(layers, { size?, title?, snapTolerance? })` makes the sheet: a layer per source in the given order and a closed path per loop, its `id` the path's owner. Ends are kept exactly: each segment starts at the previous segment's end (gaps up to `snapTolerance`, default `LOOP_SNAP_TOLERANCE` = 0.0005 mm, cam's arc tolerance, are closed so; wider gaps throw a `RangeError` naming the layer and loop), and an arc whose ends lie at different distances from its centre gets the centre moved onto the ends' perpendicular bisector, so both ends lie on one circle. An empty loop, an arc with equal ends that is not marked `fullCircle`, and a point that is not finite are refused. Without a `size`, the page is the loops' bounds (DXF keeps absolute coordinates either way; SVG shifts them onto its page).

In DXF a loop is one closed `LWPOLYLINE` (lines, and arcs as bulges), or a `CIRCLE` when it is one full circle (a `CIRCLE` has no direction; every other loop keeps its own, clockwise arcs as negative bulges). Bulges are written to `LOOP_BULGE_DIGITS` (10) decimals: a bulge is the tangent of a quarter of the sweep, so six decimals would move a 6 mm corner's centre by about 1e-5 mm. In SVG a loop is one `<path>` ending in `Z`, with arc commands of at most a quarter turn (`LOOP_MAX_ARC_SWEEP`): a reader rebuilds an arc's centre from its rounded ends and radius, and near half a turn that is ill-conditioned (a 10 mm half circle whose radius rounds up and chord rounds down comes back with its centre 3 um off the chord), while at a quarter turn the centre moves by at most 1.5 times the rounding. Drawings keep their own output unchanged (six-decimal bulges, full circles as two halves).

The tests read every file back with two readers and compare it with the input to the written precision (points within half a unit of the sixth decimal, centres within 2e-6 mm, sweeps within 1e-6 rad), after joining arc pieces about one centre: DXF with dxf-parser (MIT) and with a plain group-code reader in the test; SVG with jsdom's `DOMParser` (centres rebuilt from the arc flags) and with this package's `importSvg`. Each has a control showing the coarser default (six-decimal bulges, half arcs) fails that comparison. Opening the files in Inkscape or LibreCAD in the `interop` CI job is not done yet.

## SVG import

Sign artwork and lettering converted to paths, for sketches (M5 T5.8). `parseSvg(text)` reads a
file **once** into shapes (`ParsedSvg`: each shape's path commands in its own user units, the
matrix to millimetres with y up and the page's bottom left corner at the origin, its fill rule and
its element), the page and the issues; it throws `SvgImportError` for a file that cannot be read at
all. From the shapes, without parsing again:

- `svgOutlinePaths(parsed, { tolerance?, maxCommands?, maxPaths?, maxCoordinate? })` gives paths
  of lines and Beziers for a sketch's
  `svg` outline: `moveTo`, `lineTo`, `quadTo`, `cubicTo` and `close` (the shape of the sketch
  model's `PathCommand`), each path with its element and fill rule, and the paths' extent (Beziers
  by their true extremes). Lines and Beziers are mapped exactly (an affine map keeps a Bezier a
  Bezier); elliptical arcs (and circles, ellipses and rounded corners) become cubics of at most a
  quarter turn, as many as keep them within `tolerance` mm of the true arc (the error of a cubic
  over a circular arc grows as the sixth power of its angle, scaled by the map's largest stretch;
  at most 256 cubics an arc). `tolerance` defaults to 0.001 mm. The output is bounded while it is
  built: the first command past `maxCommands` (default `MAX_SVG_COMMANDS`), the first path past
  `maxPaths`, or the first coordinate past `maxCoordinate` mm or not finite throws
  `SvgImportError` (`too-complex`, or `out-of-range` for a coordinate, with `limit` naming the
  cap), and an arc's ends are checked before it is split. So artwork whose arcs `<use>` reuses
  under a huge `scale()` stops at once instead of making millions of cubics; the app passes the
  outline caps (100,000 commands, 20,000 paths, 1,000,000 mm).
- `fitSvg(parsed, { scale?, tolerance?, curves?, maxSegments? })` gives lines, circular arcs and
  circles (`SvgImport`) for sketch entities: `contours` (each a list of `line` and `arc` segments
  joined end to start exactly, `closed`, and the `element` it came from, `path#O`), `circles`,
  `issues`, `bounds` (arcs by their true extremes), `page` and `maxDeviation`. `scale` is applied
  before fitting, so the tolerance holds at the final size. `placeSvgImport(result, anchor, at)`
  moves it so the page corner, the geometry's bottom left corner or its centre (`svgAnchorPoint`)
  lands on a point: a translation, so placing again needs no fit. `importSvg(text, options)` is
  `fitSvg(parseSvg(text), options)`; `svgImportCounts` counts lines, arcs and circles.

```ts
import { fitSvg, parseSvg, placeSvgImport, svgOutlinePaths } from '@manufakture/io';

const parsed = parseSvg(text); // throws SvgImportError
const outline = svgOutlinePaths(parsed); // { paths, bounds, commands }
const fitted = placeSvgImport(fitSvg(parsed, { scale: 1, tolerance: 0.01 }), 'center', [0, 0]);
fitted.contours[0].segments; // { kind: 'line', start, end } | { kind: 'arc', center, start, end, clockwise }
```

The app uses both (`apps/web/src/sketcher/svg-import.ts`): an outline by default, sketch geometry
for small artwork to edit.

**No DOM.** `parseXml` is a small XML reader (elements and attributes; text, comments, CDATA,
processing instructions and the DOCTYPE skipped; the five predefined entities and character
references decoded, nothing else expanded, so no entity bombs), so the import runs the same on the
main thread, in a worker and in Node. `svg-import.test.ts` checks it against jsdom's `DOMParser`
on the bracket golden. Malformed XML is an `SvgImportError` (`xml`) naming the line.

**What is read.** `<path>` (`parsePathData`: every command, absolute and relative, implicit
repeats, `S` and `T` reflections, compact numbers and arc flags such as `a1 1 0 00 1 1`; data with
an error is read up to it, as browsers draw it, and counted once per element however often it is
used), `<rect>` (rounded corners as quarter ellipses), `<circle>`, `<ellipse>`,
`<line>`, `<polyline>`, `<polygon>`, through `<g>`, `<a>`, `<switch>`, nested `<svg>` (its
viewBox) and `<use>` (`href` or `xlink:href`, `<symbol>` with its viewBox; cycles and nesting past
8 refused with a `use` issue; a path's data is parsed once however often it is used). `transform`
lists (`matrix`, `translate`, `scale`, `rotate` with a centre, `skewX`, `skewY`; `parseTransform`)
compose down the tree; one that does not parse, or overflows, is ignored with an `attribute` issue,
the root's included. `fill-rule` (attribute or style, inherited) is kept per shape. Skipped
silently: `display: none` (attribute or style), `<defs>` and the other non-drawing containers (clip
paths, masks, patterns, markers, gradients, filters, metadata, style, script, foreign objects) and
elements of other vocabularies (editor metadata). Skipped with an `unsupported-element` issue:
`<text>` (convert to paths first) and `<image>`. Other styles are not read: stroked and filled
shapes alike become outlines. Lengths take CSS units (`parseLength`); unit names are looked up in a
`Map`, so `1constructor` is not a length.

**Issues are grouped.** There is at most one issue per code (`unsupported-element` one per tag):
a single problem is one sentence; more are a count and the first three, as in "1,234 elements have
path data or points with an error, read up to it, for example: ...; and 1,231 more.". Ids,
element names, attribute values and hrefs are cut to 40 characters wherever a message (or a
shape's `element`) quotes them, so 100,000 bad elements with long ids make a few hundred
characters of issues, not megabytes.

**Units.** The root's `width` and `height` in real units with its `viewBox` (and
`preserveAspectRatio`: alignment, `meet`, `slice`, `none`) map user units to millimetres; a viewBox
alone, or no size at all, means 96 user units to the inch (CSS pixels). `page` is the page in
millimetres when the file gives one.

**Curves to arcs** (`fitSvg`). Circles under a transform that keeps them round (rotation, uniform
scale, reflection) stay `circles`. Every other curve (cubic and quadratic Beziers, elliptical
arcs, ellipses, a circle under a non-uniform scale) is evaluated exactly under its transform and
fitted greedily: from where the last piece ended, the longest piece that fits within 0.8 of the
tolerance (halving until one fits, then bisecting towards the shortest that does not), as a line
when the piece is flat within it, else as an arc through the piece's ends: first the arc through
the curve's middle, then the arc with the least deviation, found by a golden-section search over
its sagitta. A piece is checked at 15 interior points, both for its distance from the arc's circle
and for running along the arc in order. `curves: 'lines'` fits lines only. Lines shorter than 0.05
of the tolerance are merged into their neighbours, a subpath that ends within that distance of its
start is closed onto it, and closed subpaths enclosing no area are dropped. `maxDeviation` is the
largest distance the fit found at the points it checks: an estimate, not a bound over every point
(the tests measure the true two-sided distance on dense samples). Arcs make few entities (the "O"
of the fixture is 16 arcs a contour at 0.01 mm) and keep curves exact for toolpaths; the cost is
the sketch solver's (see `apps/web/src/sketcher/svg-import.ts`).

**Limits.** The file is untrusted, and every cost is bounded:

| Limit                | Value                               | What stops                                                                                                                                        |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_SVG_CHARS`      | 32 MB of text                       | the file, before parsing (`too-large`)                                                                                                            |
| `MAX_SVG_ELEMENTS`   | 200,000                             | elements in the XML (`too-complex`)                                                                                                               |
| `MAX_SVG_DEPTH`      | 256                                 | element nesting, in the XML and through `<use>` (`too-complex`, before any stack overflow)                                                        |
| `MAX_SVG_VISITS`     | 800,000 (4 x elements)              | elements the walk visits, each `<use>` instance counted: a fan-out of nested `<use>` stops here even when its leaves draw nothing (`too-complex`) |
| `MAX_SVG_COMMANDS`   | 1,000,000                           | path commands of all shapes, `<use>` instances counted (`too-complex`)                                                                            |
| `maxSegments`        | default `MAX_SVG_SEGMENTS`, 100,000 | lines, arcs and circles of a fit (`too-complex`); the app passes 3,000                                                                            |
| `maxCommands`        | default `MAX_SVG_COMMANDS`          | commands of `svgOutlinePaths`, checked as each is made (`too-complex`); also `maxPaths`, and `maxCoordinate` (`out-of-range`)                     |
| fit depth and pieces | 24 halvings, 65,536 pieces          | a pathological curve: it ends in a line, its deviation recorded                                                                                   |

Nothing that is not finite gets through: numbers that overflow (`1e999`) end a points list or a
viewBox, transforms whose matrix overflows are ignored, a shape whose coordinates overflow under
its transforms is dropped at parse time and an import whose scale makes them overflow drops them
at fit time (`not-finite` issues), and an elliptical arc whose radii overflow is drawn as the line
it nearly is. Every scan of attribute text is linear: lengths and transforms are split by hand and
matched with sticky regexes without ambiguous whitespace (100,000 spaces in an attribute read in
milliseconds), and styles are split on `;` and `:`. What the walk reads from an element (its
style and presentation properties, transform, lengths, viewBox, `preserveAspectRatio`, points
list, a `<use>`'s reference, like a path's data) is read on its first visit and remembered, so a
megabyte attribute on an element `<use>` draws a thousand times is read once, not a thousand times.
Each problem is counted once per element too, not once per visit.

## STEP

The kernel writes and reads STEP (`exportStep`, `importStep` ops). Here: `isStep(bytes)`, `sniffFormat(bytes, fileName)` (STEP, STL or 3MF by content, the name only breaking ties) and `stepProductNames(bytes)`, the `PRODUCT` names in file order with ISO 10303-21 string escapes decoded. The app names an imported body after the file's first product.

## Imported files

`importSource(format, fileName, bytes)` gives what core's `import` feature stores: `{ format, fileName, size, sha256, data }`, `data` being base64 (`toBase64`, `fromBase64`) and `sha256` the lower-case hex SHA-256 (`sha256Hex`, WebCrypto). Why the file is kept inside the document is in the core README, "Imported geometry".

## IFC (`writeIfc`)

`writeIfc(building, options?)` writes a building as an IFC4 file (IFC-SPF text, returned as bytes) through [web-ifc](https://github.com/ThatOpen/engine_web-ifc)'s model writer (T6.6a). IFC4 rather than IFC4X3 because it is what common viewers and BIM tools open; the header declares `ViewDefinition [ReferenceView_V1.2]` and carries the construction domain's "not an engineering tool" text (`building.disclaimer`, required), split into strings of at most 255 characters.

**Input** (`ifc/model.ts`, lengths in mm): `IfcBuildingInput` holds the document id (GlobalIds derive from it), names, the file's length unit (`mm`, `cm`, `m`, `in` or `ft`; an `ft-in` document passes `ft`), levels, walls, openings, floors, roofs and members. The shapes follow the construction domain's regen results so a caller passes them through: a wall is its feature id, a name and the `WallMetadata` fields (`level`, `base`, `height`, `points`, `closed`, `thickness`, `layers`), an opening its id and the `OpeningMetadata` fields (`wall`, `type`, `segment`, `position`, `width`, `height`, `sill`), a member is regen's `MemberData` as it stands. A floor is its subfloor slab (`outline`, `top`, `thickness`; no thickness, no body); a roof gives its kind and optional sheathing sheets (an outline on a placed plane, extruded by its thickness). This package imports neither regen nor any domain; the types are structural. The construction domain maps a part studio's regen results onto them (`constructionIfcBuilding` in `packages/domain-construction/src/ifc/adapter.ts`) and its tests export the M6 shed, framed by its generators and regenerated through regen, and read it back.

**What is written**:

| Input                    | IFC                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| the document             | `IfcProject` (units, a Body context), `IfcSite`, `IfcBuilding`, joined by `IfcRelAggregates`                 |
| a level                  | `IfcBuildingStorey` at its elevation                                                                         |
| a wall                   | `IfcWall`, `ELEMENTEDWALL` with its members and layers as parts; with no parts, its framing band as its body |
| a wall's sheathing layer | `IfcPlate` `SHEET`, boxes per segment with the openings left out                                             |
| siding, drywall          | `IfcCovering` `CLADDING`, the same                                                                           |
| an opening               | `IfcOpeningElement` through every layer, voiding the wall (`IfcRelVoidsElement`)                             |
| a door or window         | `IfcDoor` / `IfcWindow` filling it (`IfcRelFillsElement`): a 50 mm panel in the framing band                 |
| a member                 | `IfcMember` (`STUD`, `PLATE`, `RAFTER`) or `IfcBeam` (`JOIST`, `LINTEL`), its blank as an extruded rectangle |
| a floor                  | `IfcSlab` `FLOOR` (the subfloor), its members its parts                                                      |
| a roof                   | `IfcRoof` with no body, aggregating its members and sheets (`IfcPlate` `SHEET`)                              |

`memberClass(role)` maps the roles: studs, kings, jacks, cripples, corners and gable studs are `STUD`; plates and rough sills `PLATE`; common, jack, hip and fly rafters `RAFTER`; joists, rims and ceiling joists `JOIST`; headers and spacers `LINTEL`; ridge and skids are `IfcBeam` `USERDEFINED`, and anything else (blocking, backing, ties, fascia) `IfcMember` `USERDEFINED`, each with the role as its `ObjectType`. A member's `Tag` is its full id (`<owner>:<id>`), its name the stock and role. Cuts are not written: a member is its blank, placed by its own frame. Walls, doors, windows, slabs and roofs are contained in their storey; parts are reached through their whole. Points, directions, placements, profiles and extrusions are written once per distinct value.

**GlobalIds** are deterministic (`ifc/guid.ts`): the first 128 bits of SHA-256 over the length-prefixed document id and the element's key (`wall:<id>`, `member:<owner>:<id>`, `voids:<opening id>` and so on), marked as a version 8 UUID and compressed to IFC's 22 characters. Exporting the same document twice gives every entity the same GlobalId, so a BIM tool sees the second export as an update; the header's timestamp still changes.

**Document text.** web-ifc escapes quotes, backslashes and non-ASCII itself, but in 0.0.78 a lone surrogate aborts its WebAssembly module, a string over about 32,000 code units silently vanishes with its entity, and characters above U+FFFF come out as surrogate pairs inside `\X2\`, which ISO 10303-21 does not allow. So every string goes through `ifcString` first: controls become spaces, bidirectional controls are dropped, surrogates and astral characters become U+FFFD, labels are capped at 255 characters (reading no further than needed). After saving, the file must be 7-bit ASCII with exactly the entity lines the writer made, or the export throws `IfcExportError`.

**Bounds.** `checkIfcBuilding` runs first and refuses (with `IfcExportError`) anything over the limits in `model.ts` before any loop: 200 levels, 10,000 walls of up to 1,000 points, 16 layers a wall, 10,000 openings and 200 on one segment (the layer strips grow with their square), 1,000 floors, roofs and sheets, 10,000 outline points, 200,000 members, ids of 1 to 512 characters of well-formed UTF-16 (`isWellFormed`: ids are hashed as UTF-8, where every lone surrogate becomes U+FFFD, so ids differing only there would share GlobalIds), names that are text, coordinates within 10^9 mm and sizes within 10^7 mm, orthonormal placements, unique ids and references that exist.

Those counts bound each list but not their products (segments times openings times layers), and a cache hit costs a reference in the file as surely as a new entity costs a line. So the writer also spends a **work budget**, `MAX_IFC_WORK` (3,000,000): one unit for every entity written, every box asked for (cached or not), every reference placed in a representation, aggregation or containment list, and every 64 characters of a label. Past it the export stops with `IfcExportError` ("too large to export as IFC"), which bounds the file to some hundreds of megabytes at the very worst and the time to about ten seconds; a document of three wall segments with 200 nested openings each and 15 identical layers, which would otherwise ask for tens of millions of boxes, is refused that way. The 200,000 members the counts allow need about 2,700,000 (about 13 a member); the M6 shed needs a few thousand. `options.maxWork` lowers the budget (tests), never raises it.

**Loading.** web-ifc is imported with `import('web-ifc')` on the first export only, initialised single-threaded (ADR 0002 rules out the cross-origin isolation the threaded build needs) and kept for the module's life; a failed load is retried next time. Nothing else in this package imports it, so a bundle that never calls `writeIfc` has none of it (checked: the app's production build contains no web-ifc code). In the browser, pass `options.locateFile` to say where `web-ifc.wasm` is (a bundler asset URL); Node finds `web-ifc-node.wasm` itself. The writer has its own entry point, `@manufakture/io/ifc`, which the regen worker imports lazily in its `exportIfc` (`packages/regen`), with Vite's URL of `web-ifc.wasm`; the app's production build emits the writer (about 18 KB), web-ifc's API (3.5 MB raw) and `web-ifc.wasm` (1.6 MB) as their own chunks and asset, fetched on the first export only.

## Published views (`.mfkview`)

A published view (M7 plan, T7.3a; `mfkview.ts`) is a model to look at without the kernel: what the app shows, as meshes with names and metadata, in one file that any static host can serve. The viewer (T7.3b) reads it; share links (T7.3d) point at one. It is not a document format: the document, when included, is an ordinary `.mfk` inside.

`writeMfkview(input)` (async) writes it from data the app already holds: each body's display mesh as the kernel tessellated it (`MfkviewMesh`: the kernel's `MeshData` layout, face and edge names as strings or null), plus names, colours, materials, volumes and masses, parts and instances. `readMfkview(bytes, limits?)` reads one back, synchronously and without three.js: the manifest, the meshes, and `readSource()`, which inflates `source.mfk` only when called (the viewer needs it for Open in manufakture only; `readMfkview` checks just that the entry is there). Both throw `MfkviewError` with a message for the person who opened the file.

The format has its own entry point, `@manufakture/io/mfkview` (also re-exported from the package index): the read-only viewer imports only that, so it loads none of the other formats (the viewer's build check, `apps/web/src/viewer/bundleCheck.ts`). The viewer reads with `MFKVIEW_VIEWER_LIMITS`.

**The zip** holds only these entries; a reader ignores (and never inflates) anything else:

| Entry            | What                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `manifest.json`  | the manifest below, pretty-printed JSON                                             |
| `bodies/<n>.glb` | body n's mesh as binary glTF 2.0, in its part's coordinates, millimetres (deflated) |
| `source.mfk`     | the document as a `.mfk`, only with Include source (stored: it is a zip already)    |

**The manifest** (`format: "manufakture-view"`, `version: 1`):

| Field       | What                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generator` | what wrote it (`manufakture`)                                                                                                                                                       |
| `name`      | the part studio's or the assembly's name                                                                                                                                            |
| `kind`      | `part` (a part studio's shown bodies) or `assembly`                                                                                                                                 |
| `units`     | `{ length: "mm", display }`: every coordinate is in mm; `display` is the document's own length unit (`mm`, `in`, `ft-in`, ...), for the viewer's readouts                           |
| `bodies`    | per body: `name`, `color` (`#rrggbb` or null), `material` (`{ id, name, density }` in kg/m3, or null), `volume` (mm3) and `mass` (g) or null, and its `faces`, `edges`, `triangles` |
| `parts`     | per part: `name` and its `bodies` (indices); every body belongs to exactly one part                                                                                                 |
| `instances` | per instance: `name`, `part` (index) and `transform`, a rigid `Matrix3x4` (see 3MF above), part to world; every part has at least one. A part studio is one part at the identity    |
| `source`    | whether `source.mfk` is in the bundle                                                                                                                                               |

**Each `.glb`** is written by three.js's `GLTFExporter` (`three` 0.186), imported dynamically on the first write, so importing this package costs nothing until a view is written. Its scene has a node `faces`: one mesh with one triangle primitive (POSITION and NORMAL as floats, UNSIGNED_INT indices, triangles grouped by B-rep face as the kernel orders them, a `MeshStandardMaterial` of the body's colour), whose `extras.manufakture` holds `faceRanges` (per face, first index and index count), `faceNames`, `edgeRanges` (per edge, first point and point count) and `edgeNames`; and, when the body has edges, a node `edges`: one LINES primitive over the edge polylines' points, indexed as segment pairs, unlit. Any glTF viewer shows the file as it is. GLTFExporter turns its buffers into bytes with `FileReader`, which Node lacks: where it is missing, a minimal one (`readAsArrayBuffer` on `Blob.arrayBuffer`) is installed for the length of the export and removed again, so the writer runs in Node tests and in the browser alike.

**Reading untrusted bundles.** The viewer opens files and links from anyone, so `readMfkview` treats every byte as hostile:

- The zip is read with `readZip` (`zip.ts`; `listZip` makes the same file and directory checks and returns the names, inflating nothing), the same checks as the app's `.mfk` reader: file size and entry count first, every entry placed inside the file and overlapping no other before anything is inflated, per-entry and total uncompressed limits, stored or deflate only, no encryption, a name listed twice refused, and each deflated entry inflated as a stream that is cut off the moment it passes the size it claims (a zip bomb costs at most that size).
- The manifest is read first, then only the `.glb` entries it lists; `source.mfk` waits for `readSource()`, within its own limit.
- Names (document, body, part, instance, face, edge) are returned exactly as written, bidirectional and control characters included: whoever displays them must render them as text (T7.3b's viewer does).
- `parseMfkviewManifest` checks the manifest against the schema field by field and builds a fresh object: unknown fields are dropped, names are plain strings of at most 1,000 characters (never interpreted; the viewer renders them as text), colours `#rrggbb`, material ids `[a-z0-9_-]`, numbers finite and in range, counts capped, every index in range, every body in exactly one part, every part placed, every transform 12 finite numbers within 10^7 mm and rigid (orthonormal within 1e-6, right-handed: `isRigidMatrix`). A newer format version is refused with a message saying so.
- Each `.glb` is parsed here, not by a glTF loader, and only the subset written above is accepted: GLB header, length and chunk types checked; JSON chunk within the manifest limit; the `faces` and `edges` nodes found by name (two of either refused); one primitive each, of the right mode; every accessor of the expected type and component type, not sparse, not normalized, not interleaved, lying inside its buffer view and the view inside the binary chunk; data copied out (never aliased); every coordinate finite and within 10^7 mm, normals within unit range, every index inside its vertices; counts equal to the manifest's; face ranges inside the indices and on triangle boundaries, edge ranges inside the edge points, name tables as long as the faces and edges.

`MFKVIEW_LIMITS` (the writer's, and `readMfkview`'s default; all overridable per call): file 256 MiB, 2,100 entries, 768 MiB uncompressed in total, manifest (and each glTF JSON chunk) 8 MiB, one `.glb` 128 MiB, source 256 MiB (the app's `.mfk` limits apply again when it is opened), 2,000 bodies and parts, 10,000 instances, per body 4,000,000 triangles and vertices, 200,000 faces, 400,000 edges and 4,000,000 edge points, 20,000,000 triangles in all. `writeMfkview` runs the reader's manifest check and the mesh limits on its own input first, so it never writes a bundle the reader would refuse.

`MFKVIEW_VIEWER_LIMITS` are lower, for bundles from elsewhere (a dropped file, a link), so one cannot make the viewer allocate more than about 192 MiB of data (meshes plus the source, read separately): file 64 MiB, 520 entries, 128 MiB uncompressed for the manifest and meshes, manifest (and each glTF JSON chunk) 2 MiB, one `.glb` 64 MiB, source 64 MiB, 500 bodies and parts, 5,000 instances, per body 2,000,000 triangles and vertices, 50,000 faces, 100,000 edges and 2,000,000 edge points, 4,000,000 triangles in all; names 1,000 characters and coordinates 10^7 mm as before. The viewer passes them explicitly; a bundle the app writes within them opens there.

**Size.** The M1 bracket (15 faces, 472 triangles at the viewport's tessellation) publishes as a 5.7 KB bundle without its source (5,861 bytes when measured; `mfkview.test.ts` logs it and keeps it between 3 and 12 KB).

## Mesh properties

`meshProperties(mesh)` gives volume (divergence theorem), surface area, centre of mass and bounding box, summed in float64 relative to the first vertex. The app measures imported STL bodies with it, since they have no B-rep.

## Fabrication exports

Every fabrication format of the M8 plan's cross-cutting decision 5 has one entry point that runs in Node as in the browser (T8.1b), so a headless session writes the same files the app saves. Each takes what a regen produced (a `RegenEngine` and its `RegenResult`, or the on-demand stages the engine offers) and returns the files as `FabricationFile`s (`{ name, bytes, type }`; `FABRICATION_MIME` has the types).

| Format                                                                | Entry point                                                                   | Package                                  | From the regen                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-code (one file, or a zip of one per tool with the setup sheet)      | `exportGcode(document, setupId, geometer, { date, settings? })`               | `@manufakture/cam/export`                | The CAM stage (`geometer.geometry` over `RegenEngine.camGeometry`); the toolpaths are generated in-process                                                                                     |
| Cut lists and layouts (cut list CSV, bill of materials CSV, shop PDF) | `exportCutList(kind, { document, parts, assemblies?, assemblyId?, sizes? })`  | `@manufakture/domain-wood/files`         | `RegenResult.parts` and `assemblies`; sheets and sticks are laid out in-process                                                                                                                |
| Takeoffs (CSV, PDF)                                                   | `exportTakeoff(kind, { document, partId, features, sets })`                   | `@manufakture/domain-construction/files` | The part studio's `PartResult.features` and member sets (`members` of a completed regen)                                                                                                       |
| Construction drawing sets (one PDF of every sheet)                    | `drawingFile('pdf', lists, { drawing, sheets })`                              | `@manufakture/io`                        | Each sheet's `RegenEngine.drawingSheet(...).display`; the set itself is a drawing the document holds                                                                                           |
| Drawing PDF and DXF (and SVG)                                         | `drawingFile(format, lists, { drawing, sheets })`                             | `@manufakture/io`                        | As above: one sheet for DXF and SVG, every sheet for PDF                                                                                                                                       |
| Laser and plasma files (DXF, SVG)                                     | `exportLaser(document, scope, sources, services, { format, kerf, baseName })` | `@manufakture/cam/export`                | The CAM stage for faces and sketch regions, the kernel's `section` op for sections                                                                                                             |
| Print files (STL, one or one per body, and 3MF)                       | `exportBodyFiles(exchanger, 'stl' \| 'stl-each' \| '3mf', options)`           | `@manufakture/io`                        | `kernelExchanger({ kernel, generation, bodies })` over `RegenResult.parts[].bodies` (their `shape`s); framing members from `memberExportBodies` over the part's member sets and `memberMeshes` |
| STEP                                                                  | `exportBodyFiles(exchanger, 'step', options)`                                 | `@manufakture/io`                        | As above; framing members as B-reps when the exchanger has `memberBodies` (the engine's `memberBodies`), the construction disclaimer in the header with `stepDescription`                      |

The app's dialogs write the same files through the functions under these: the Cut list panel `cutListFile`, the Takeoff panel `takeoffFile` (both beside their entry points), the drawing workspace `drawingFile`, the G-code export dialog `buildExport`, `setupSheetHtml` and `exportFiles` and the laser dialog `laserFile` (in `@manufakture/cam/export`), and the app's export action `exportBodyFiles` with its kernel exchange. The print workspace's export of a print setup (copies packed onto a printer's plate, `apps/web/src/print/exportPrint.ts`) is still the app's: a Node caller writes a part's bodies as STL or 3MF with `exportBodyFiles`. IFC (`writeIfc`) and published views (`.mfkview`) are not fabrication files.

`apps/web/src/fabrication.test.ts` exports every format in Node from the M4 bookshelf and the M6 shed of the e2e fixtures.

### Files here

- `fabrication.ts`: `FabricationFile`, `FABRICATION_MIME`, and `documentFileName(name, what, extension)` (`Bookshelf cut list.csv`), which the cut list and takeoff files share.
- `drawing-files.ts` (moved from the app's drawing workspace): `drawingFile(format, lists, names)` gives `{ ok, bytes, fileName, type }` or the reason it cannot (a sheet that could not be laid out, a writer's RangeError), `drawingFileName` (no characters file systems refuse), `DRAWING_MIME` and `screenSvg` (the SVG writer's markup scaled to its box, for the screen).
- `body-files.ts` (moved from the app's export action): `exportBodyFiles` with a `BodyExchanger` (`bodies`, `tessellate`, `exportStep`, optional `exportStepWithMembers`), and `kernelExchanger`, one over a kernel service and the bodies of a regen result. The result carries `note`, a sentence about the members for the caller's message.
- `member-export.ts`: `memberExportBodies` (every member its shape mesh under its own matrix, named by its full id) and `matrix3x4`.
- `step-header.ts`: `withStepDescription(bytes, text)` splices a STEP header's `FILE_DESCRIPTION` and leaves every other byte as it was; `stepStrings` the escaping.

## Dependencies

- **fflate** 0.8.3, MIT (read from its installed `package.json` and `LICENSE`), for zip. The whole ESM build is 92 KB unminified; only `zipSync`, `unzipSync` and the string helpers are imported, so the app bundles the deflate and inflate paths only.
- **three** 0.186.1, MIT (read from its installed `package.json` and `LICENSE`; already the app's viewport library), for `GLTFExporter` in the `.mfkview` writer only, imported dynamically; the reader does not use it. `@types/three` is a development dependency.
- **@manufakture/drawing** (workspace), for the display list types and `hatchLines`. It depends only on `packages/units`.
- **@manufakture/kernel** (workspace) is a development dependency: the kernel-backed tests load it, and `body-files.ts` names its types (`KernelService`, `MeshData`, `Deflection`, `ShapeId`) with type-only imports, so nothing of it is loaded at run time.
- **web-ifc** 0.0.78, pinned exactly (it is 0.0.x and changes its API), MPL-2.0, for IFC export only, loaded lazily (see IFC above). Read from the installed `package.json` and `LICENSE.md`; it has no runtime dependencies. The bundled C++ libraries and their licenses are in [ADR 0006](../../docs/adr/0006-licensing.md). Cost on first use: `web-ifc.wasm` 1,595,268 bytes (about 440 KB brotli) plus the API module, 5.9 MB raw and about 210 KB brotli, most of it the schema classes.
- Development only: **dxf-parser** 1.1.2, MIT (read from its installed `package.json` and `LICENSE`; it was last published in 2022 but parses everything we write), to parse our DXF back in tests, and the parser T5.6a should use too; **pdfjs-dist** 6.3.289, Apache-2.0 (installed `package.json`), to parse our PDF back. SVG is parsed with jsdom's `DOMParser` (the root's development dependency, through vitest's `jsdom` environment).
- **manifold-3d** (Apache-2.0) was considered for the watertightness check and not added: version 3.5.4 ships a 541 KB `.wasm` (2.8 MB unpacked package) to load in the app for what `checkManifold` does in about a hundred lines, exactly, on an indexed mesh. It would earn its place for repairing meshes or for mesh booleans, neither of which export needs.

## Testing

```sh
pnpm --filter @manufakture/io test
```

- `mesh.test.ts`, `manifold.test.ts`: welding, merging, properties; every manifold failure (a hole, a flipped triangle, an edge shared three ways, inside out, degenerate).
- `stl.test.ts`, `threemf.test.ts`, `step.test.ts`, `encoding.test.ts`: writers and parsers, and `validate3mf` finding a wrong unit, an open mesh, a flipped triangle, a dangling build item, a missing content type, a missing component or one defined after its use, a mirroring, scaling or malformed transform, a dangling `pid`, a `pindex` outside its group, a colour group outside the materials namespace, and `model_settings.config` naming what does not exist; colour groups (one per colour, first-use order), exact transform round trips, a components file with its settings round-tripping, components and build transforms built into placed meshes.
- `fixtures/slicers/fixtures.test.ts`: the committed slicer fixtures are what the script builds, each parses and validates, and `write3mf` writes fixtures 02, 06 and 07 byte for byte.
- `path2.test.ts`: number formatting, signed sweeps, arc and ellipse bounds, the Bezier error bound, runs, layers, paging by bounds, baselines.
- `svg.test.ts` (jsdom): well-formed, page size and `viewBox`, layer groups and their styles, and every path read back and compared with its source (endpoints, radii, rotation, sweep direction and the arc centre recovered from the endpoint form), text position, size, anchor and rotation; the bracket drawing, the shapes sheet (`sheet-test-helpers.ts`: ellipse arcs, a wrapping arc, full circles, rotated text, a fill, a hatch) and a laser plate with no paper size.
- `dxf.test.ts`: the section and table skeleton, unique handles below `$HANDSEED`, owners, the header units, the LTYPE table (`HIDDEN` 3, -1.5) and each layer's linetype and lineweight; through dxf-parser, the stroked length per layer equal to the source's, ellipses with swapped axes, text with justification and `%%c`, the arrowhead's `SOLID`, and a laser plate as one closed bulged `LWPOLYLINE` plus a `CIRCLE`.
- `pdf.test.ts`: the xref table (every offset at its `n 0 obj`, `startxref`, stream lengths); through pdf.js, page sizes in points, the title block's text, one path per stroked item, text widths, anchors, baselines and rotation, several pages, deflated streams, determinism.
- `step-header.test.ts`: the header description written as ASCII STEP strings, over several lines, and nothing else changed (non-UTF-8 bytes in `DATA` included).
- `drawing-export.test.ts`: the display list mapping, and **goldens** of the M1 bracket's three-view drawing (the drawing package's own golden input) in `src/goldens/`: `bracket.svg`, `bracket.dxf` and the PDF page's content stream `bracket-pdf-page.txt`. After a deliberate change, look at the diff, then `vitest run packages/io -u`.
- `svg-import.test.ts` (jsdom, for `DOMParser` only): the hostile cases (a `<use>` fan-out eight levels deep, deep nesting, too many elements, too large a file, `1constructor` and `__proto__` units, `1e999` points and viewBox, `scale(1e200) scale(1e200)`, `r=1e300` under `scale(1e10)`, relative paths and arc radii that overflow, a scale that overflows the fit, an unreadable root transform, 100,000 spaces in an attribute, a megabyte style, transform, length, points list, viewBox or href on an element nested `<use>` draws 1,000 times read in bounded time, 10,000 arcs reused 20 times under `scale(1e12)` or `scale(1000)` refused by the outline caps at once with bounded memory, and 100,000 bad paths, lengths, transforms or hrefs with long ids grouped into at most two issues under 1,000 characters), outline paths (exact Beziers, elliptical arcs within 0.01, 0.001 and 0.00001 mm, fill rules from attributes and styles, the word fixture `src/fixtures/svg/word.svg` written by `scripts/svg-word-fixture.ts`), parsing once; path data (commands, repeats, reflections, compact numbers, errors), transforms, lengths, the XML reader (prolog, DOCTYPE with an internal subset, comments, CDATA, entities, prefixes, malformed input with line numbers, and agreement with `DOMParser` on the bracket golden); the lettering fixture `src/fixtures/svg/letters.svg` ("O" of cubic Beziers, "A" of lines, "B" of circular arc commands, each with its counters, and a dot) as closed contours, y up, with exact arcs where the file has circles and the two-sided distance between the O's Beziers and its arcs within the tolerance at 0.01, 0.0005 and 0.05 mm and at ten times the size; every shape element, an ellipse under a rotation within 0.002 mm, circles kept or not under transforms, page units and `preserveAspectRatio`, nested transforms, `<use>`, `<symbol>`, nested `<svg>`, hidden and non-drawing elements, the issues, closing and merging short pieces, refusals, a round trip through `writeSvg`, the bracket golden, and placement.
- `zip.test.ts`: one hand-built or hand-patched zip per check of `readZip`: not a zip, too large, too many entries, ZIP64, a directory outside the file, two directory records sharing one stream, an entry outside the file or running into the directory, an unsupported method, encryption, a stored entry whose sizes differ, an entry inflating past or short of its claimed size, a corrupt deflate stream, per-entry and total sizes, and a name listed twice (ignored when not wanted).
- `mfkview.test.ts`: an assembly (two parts, three instances, colours, a material, the source) and the M1 bracket from the real kernel written and read back with positions, normals, indices, face and edge ranges and name tables equal, the bracket's bundle size logged; the glTF's nodes and materials; several writes at once, Node without `FileReader`, a failed blob read rejecting rather than hanging, and a real `FileReader` installed meanwhile left in place; the viewer limits; the source read only on demand; writes the reader would refuse refused; and hostile bundles: not a zip, no manifest, not UTF-8 or JSON, another format, a newer version, each manifest field wrong in turn, unknown fields dropped, a missing mesh or source, a truncated or foreign glb, accessors outside their buffers, sparse, interleaved or of the wrong type, indices past the vertices, a NaN coordinate, ranges and name tables that do not match, counts that differ from the manifest, every size and count limit, an entry that inflates past the size it claims, and a name listed twice.
- `placement.test.ts`: poses to 3MF matrices (axis images, translation, normalising), composition order, moved meshes keeping their volume.
- `export.test.ts`: assembly exports, 3MF (an object per body per instance, each with its build item and placement; colour groups shared by every copy; a `oneObject` part as a components object per instance with its settings) and STL (merged in place), and assemblies that do not add up.
- `kernel-export.test.ts`: real kernel meshes (the kernel is a dev dependency) exported watertight at every preset, STL and 3MF read back, a STEP round trip meshed, an assembly of the demo part placed twice.
- `ifc/ifc.test.ts`: a small building as plain data (`ifc/test-building.ts`: a level, two walls with a door, a window, sheathing and drywall, studs, a header, a floor with joists, a gable roof with a sheet) written and read back with web-ifc: entity counts by type equal to the element and member counts, members tagged and typed by role, every member's mesh where its blank is (within 0.01 mm), voids and fills, parts and containment, units (feet and millimetres), GlobalIds equal across two exports and different between documents; `ifcString`, the GUID encoding, `faceRects`, `checkIfcBuilding` refusing each malformed or oversized input (ids that are not well-formed UTF-16 among them, with the GlobalId collision they would cause), the work budget refusing a small document whose geometry multiplies (cache hits counted), and hostile names (quotes, `);#999=IFCWALL(`, newlines, backslashes, surrogates) read back as plain text with no entity added.
- `ifc/ifc-interop.test.ts`: IfcOpenShell validates the test building's IFC against the IFC4 schema (and its WHERE rules when pytest is installed beside it) and builds every product's shape; **skipped** unless the Python named by `IFC_PYTHON` (default `python3`) has `ifcopenshell` (`pip install ifcopenshell pytest` in a virtualenv). The `interop` CI job does not run it yet.
- `interop.test.ts`: FreeCAD reopens our STEP (volume, faces, bounding box) and PrusaSlicer slices our 3MF and STL (an assembly's too: two placed instances; and a two-colour part turned on its side, as an object per body and as one components object), and OrcaSlicer loads, writes back and slices our two-colour exports (an object per body placed twice, and one components object) and every slicer fixture through `scripts/orca-matrix.ts`, checking each object's name, filament slot and parts in the written `model_settings.config`, its position, and the G-code's slots; it also fails, as it must, on fixture 02 with its colour groups under another namespace prefix. Each is **skipped when the program is not installed** (or, for OrcaSlicer, does not start). The optional `interop` CI job installs all three. Inkscape exports the bracket drawing's SVG to PNG and LibreCAD's `dxf2pdf` converts its DXF (skipped when missing; neither is installed by the CI job yet). Override the commands with `FREECADCMD`, `SLICER_CMD`, `ORCA_CMD`, `INKSCAPE_CMD` and `LIBRECAD_CMD` (`ORCA_PROFILES` too, when the profiles are not next to the command); `INTEROP_KEEP=1` keeps the files.
