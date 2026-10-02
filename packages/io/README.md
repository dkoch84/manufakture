# @manufakture/io

File formats for getting parts out to slicers and other CAD tools and bringing geometry in, and 2D sheets (drawings, laser and plasma outlines) out as SVG, DXF and PDF. STL and 3MF are written and read here, in plain TypeScript with no WebAssembly; STEP geometry goes through the kernel (OCCT's translators, see the kernel README's STEP exchange), and this package only reads STEP text. It runs the same on the main thread, in a worker and in Node.

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

`width` and `height` in `mm` and a `viewBox` in millimetres, so one user unit is one millimetre; y is flipped once into the coordinates (no transform), so a reader gets the geometry back by flipping. One `<g>` per layer with `id="layer-<name>"`, `data-layer`, `stroke`, `stroke-width`, `stroke-dasharray` and caps (round, butt when dashed: round caps lengthen dashes). Paths use `M`, `L`, `A` (a full circle or ellipse as two half arcs) and `Z`; filled paths carry `fill`; `owner` becomes `data-owner`, for the app to pick. Text is `<text>` at its baseline point with `text-anchor`, `rotate(...)` and `font-family="Helvetica, Arial, sans-serif"` at a font size of cap height / 0.718 (Helvetica's cap height). No CSS, patterns, markers, clip paths or `dominant-baseline`, so every renderer and converter draws it the same.

### DXF (`writeDxf`)

ASCII DXF, AutoCAD 2000 (`AC1015`): the oldest version with `LWPOLYLINE` and `ELLIPSE` and the one readers support most widely. Units are millimetres in the header (`$INSUNITS` 4, `$MEASUREMENT` 1; `$LUNITS` decimal, `$EXTMIN`/`$EXTMAX` from the items, `$LIMMIN`/`$LIMMAX` the paper). The file has the full AC1015 skeleton (handles and owners, subclass markers, the nine symbol tables, model and paper space blocks, the root dictionary with the group and plot style dictionaries), which AutoCAD is said to require of a DXF 2000; that claim is unverified, since no AutoCAD was available: only ezdxf 1.4.4's audit was run, by hand and not in CI, and it finds no error or fix in our files. No `LAYOUT` objects are written (the model and paper space blocks have none), which a reader that wants layouts may add or complain about. Each layer gets its colour (the nearest of ACI 1 to 9; black is 7), the nearest standard lineweight and a linetype: `CONTINUOUS`, or one built from its dash pattern (in mm, `$LTSCALE` 1) named by `lineType`, made unique when two layers share a name with different patterns. Paths become `LINE`, `ARC` or `CIRCLE` when they are one segment, and one `LWPOLYLINE` (arcs as bulges, a full circle as two) when they are several connected lines and arcs, so a laser loop stays one closed entity; ellipse arcs are `ELLIPSE` (axes swapped when the minor is the longer, since DXF needs a ratio of at most 1). Filled paths of three or four straight sides (arrowheads) get a `SOLID` as well as their outline; larger fills are outlined only. Text is `TEXT` in style `STANDARD` (`arial.ttf`) with its height as the cap height, its rotation, and the horizontal (left, center, right) and vertical (baseline, middle, top) justification with the alignment point; Ø, ° and ± are written `%%c`, `%%d` and `%%p`, other non-ASCII characters `\U+XXXX`, and a `%` followed by another `%` (literal, or one of those codes) as `%%%`, so text such as `%%d` is not read as a control code. Layer and linetype names cannot hold `\U+XXXX`, so every non-ASCII character in them becomes `_` (with the reserved characters and controls); the whole file is then ASCII, which reads the same under the header's `$DWGCODEPAGE` `ANSI_1252` as under any other code page.

### PDF (`writePdf`)

One page per sheet, `MediaBox` the sheet in points (72 per 25.4 mm). The content stream draws in millimetres under one `cm` scale: per layer the line width, dash pattern, caps and colour; paths with `m`, `l`, `c` (arcs and ellipse arcs as cubic Beziers of at most a quarter turn, under 3e-4 of the radius off) and `h`, stroked (`S`) or filled and stroked (`B`); text with `Tm` (position and rotation) and `Tj` in Helvetica, a standard 14 font, WinAnsiEncoding, so no font is embedded (and none needs a license). Anchors are placed with Helvetica's AFM widths (`helvetica.ts`; pdf.js measures the same widths in the tests). Characters outside Windows-1252 print as `?`. Content streams are deflated with fflate (`compress: false` for readable output); there is no creation date unless given, so the bytes are reproducible.

**Why our own writer and not jsPDF with svg2pdf.js** (the M4 plan's Part 1 suggestion): a drawing needs vector paths, dashes, fills and standard-font text, which is about 250 lines of PDF here, plus the Helvetica width table. svg2pdf.js renders an SVG _DOM_, which a worker and Node do not have, so it would tie PDF export to the main thread and to a DOM shim in tests; jsPDF and svg2pdf.js together are a few hundred KB of JavaScript to lazy-load, and svg2pdf.js supports only a subset of SVG, which would have constrained the SVG writer too. Writing from the `Sheet2` directly gives the same geometry as the SVG and DXF by construction, runs anywhere this package runs, adds no runtime dependency (fflate was here already), and is checked by parsing it back with pdf.js. Multi-page output is built in, which the cut list PDF (T4.3d) needs. If richer PDF layout (flowing tables) is ever wanted, a layout library can sit beside this.

### Drawings (`drawing-export.ts`)

`displayListToSheet(list)` maps `packages/drawing`'s display list: the paper size; the layers in `LAYER_NAMES` order with their weights and dashes, dashed lines as DXF `HIDDEN` and chain lines as `CENTER` (`DRAWING_LINETYPES`; the section layer's longer chain becomes `CENTER_SECTION`); lines, arcs and ellipse arcs with their counter-clockwise sweep made explicit; polylines as paths of lines (closed and filled kept); text as is; hatches expanded to their lines with the drawing package's `hatchLines` (0.05 mm flattening), the same in every format. `owner` is kept, `item` dropped. `drawingToSvg`, `drawingToDxf` and `drawingToPdf` (several sheets, a page each) wrap it.

## STEP

The kernel writes and reads STEP (`exportStep`, `importStep` ops). Here: `isStep(bytes)`, `sniffFormat(bytes, fileName)` (STEP, STL or 3MF by content, the name only breaking ties) and `stepProductNames(bytes)`, the `PRODUCT` names in file order with ISO 10303-21 string escapes decoded. The app names an imported body after the file's first product.

## Imported files

`importSource(format, fileName, bytes)` gives what core's `import` feature stores: `{ format, fileName, size, sha256, data }`, `data` being base64 (`toBase64`, `fromBase64`) and `sha256` the lower-case hex SHA-256 (`sha256Hex`, WebCrypto). Why the file is kept inside the document is in the core README, "Imported geometry".

## Mesh properties

`meshProperties(mesh)` gives volume (divergence theorem), surface area, centre of mass and bounding box, summed in float64 relative to the first vertex. The app measures imported STL bodies with it, since they have no B-rep.

## Dependencies

- **fflate** 0.8.3, MIT (read from its installed `package.json` and `LICENSE`), for zip. The whole ESM build is 92 KB unminified; only `zipSync`, `unzipSync` and the string helpers are imported, so the app bundles the deflate and inflate paths only.
- **@manufakture/drawing** (workspace), for the display list types and `hatchLines`. It depends only on `packages/units`.
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
- `drawing-export.test.ts`: the display list mapping, and **goldens** of the M1 bracket's three-view drawing (the drawing package's own golden input) in `src/goldens/`: `bracket.svg`, `bracket.dxf` and the PDF page's content stream `bracket-pdf-page.txt`. After a deliberate change, look at the diff, then `vitest run packages/io -u`.
- `placement.test.ts`: poses to 3MF matrices (axis images, translation, normalising), composition order, moved meshes keeping their volume.
- `export.test.ts`: assembly exports, 3MF (an object per body per instance, each with its build item and placement; colour groups shared by every copy; a `oneObject` part as a components object per instance with its settings) and STL (merged in place), and assemblies that do not add up.
- `kernel-export.test.ts`: real kernel meshes (the kernel is a dev dependency) exported watertight at every preset, STL and 3MF read back, a STEP round trip meshed, an assembly of the demo part placed twice.
- `interop.test.ts`: FreeCAD reopens our STEP (volume, faces, bounding box) and PrusaSlicer slices our 3MF and STL (an assembly's too: two placed instances; and a two-colour part turned on its side, as an object per body and as one components object), and OrcaSlicer loads, writes back and slices our two-colour exports (an object per body placed twice, and one components object) and every slicer fixture through `scripts/orca-matrix.ts`, checking each object's name, filament slot and parts in the written `model_settings.config`, its position, and the G-code's slots; it also fails, as it must, on fixture 02 with its colour groups under another namespace prefix. Each is **skipped when the program is not installed** (or, for OrcaSlicer, does not start). The optional `interop` CI job installs all three. Inkscape exports the bracket drawing's SVG to PNG and LibreCAD's `dxf2pdf` converts its DXF (skipped when missing; neither is installed by the CI job yet). Override the commands with `FREECADCMD`, `SLICER_CMD`, `ORCA_CMD`, `INKSCAPE_CMD` and `LIBRECAD_CMD` (`ORCA_PROFILES` too, when the profiles are not next to the command); `INTEROP_KEEP=1` keeps the files.
