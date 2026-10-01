# @manufakture/io

File formats for getting parts out to slicers and other CAD tools and bringing geometry in. STL and 3MF are written and read here, in plain TypeScript with no WebAssembly; STEP geometry goes through the kernel (OCCT's translators, see the kernel README's STEP exchange), and this package only reads STEP text. It runs the same on the main thread, in a worker and in Node.

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

PrusaSlicer slicing our 3MF is automated in the optional `interop` CI job (below); the OrcaSlicer matrix is run by hand when the writer or a slicer version changes. Not written: materials other than colours, per-triangle colours, plates, the production and slice extensions.

## STEP

The kernel writes and reads STEP (`exportStep`, `importStep` ops). Here: `isStep(bytes)`, `sniffFormat(bytes, fileName)` (STEP, STL or 3MF by content, the name only breaking ties) and `stepProductNames(bytes)`, the `PRODUCT` names in file order with ISO 10303-21 string escapes decoded. The app names an imported body after the file's first product.

## Imported files

`importSource(format, fileName, bytes)` gives what core's `import` feature stores: `{ format, fileName, size, sha256, data }`, `data` being base64 (`toBase64`, `fromBase64`) and `sha256` the lower-case hex SHA-256 (`sha256Hex`, WebCrypto). Why the file is kept inside the document is in the core README, "Imported geometry".

## Mesh properties

`meshProperties(mesh)` gives volume (divergence theorem), surface area, centre of mass and bounding box, summed in float64 relative to the first vertex. The app measures imported STL bodies with it, since they have no B-rep.

## Dependencies

- **fflate** 0.8.3, MIT (read from its installed `package.json` and `LICENSE`), for zip. The whole ESM build is 92 KB unminified; only `zipSync`, `unzipSync` and the string helpers are imported, so the app bundles the deflate and inflate paths only.
- **manifold-3d** (Apache-2.0) was considered for the watertightness check and not added: version 3.5.4 ships a 541 KB `.wasm` (2.8 MB unpacked package) to load in the app for what `checkManifold` does in about a hundred lines, exactly, on an indexed mesh. It would earn its place for repairing meshes or for mesh booleans, neither of which export needs.

## Testing

```sh
pnpm --filter @manufakture/io test
```

- `mesh.test.ts`, `manifold.test.ts`: welding, merging, properties; every manifold failure (a hole, a flipped triangle, an edge shared three ways, inside out, degenerate).
- `stl.test.ts`, `threemf.test.ts`, `step.test.ts`, `encoding.test.ts`: writers and parsers, and `validate3mf` finding a wrong unit, an open mesh, a flipped triangle, a dangling build item, a missing content type, a missing component or one defined after its use, a mirroring, scaling or malformed transform, a dangling `pid`, a `pindex` outside its group, a colour group outside the materials namespace, and `model_settings.config` naming what does not exist; colour groups (one per colour, first-use order), exact transform round trips, a components file with its settings round-tripping, components and build transforms built into placed meshes.
- `fixtures/slicers/fixtures.test.ts`: the committed slicer fixtures are what the script builds, each parses and validates, and `write3mf` writes fixtures 02, 06 and 07 byte for byte.
- `placement.test.ts`: poses to 3MF matrices (axis images, translation, normalising), composition order, moved meshes keeping their volume.
- `export.test.ts`: assembly exports, 3MF (an object per body per instance, each with its build item and placement; colour groups shared by every copy; a `oneObject` part as a components object per instance with its settings) and STL (merged in place), and assemblies that do not add up.
- `kernel-export.test.ts`: real kernel meshes (the kernel is a dev dependency) exported watertight at every preset, STL and 3MF read back, a STEP round trip meshed, an assembly of the demo part placed twice.
- `interop.test.ts`: FreeCAD reopens our STEP (volume, faces, bounding box) and PrusaSlicer slices our 3MF and STL (an assembly's too: two placed instances; and a two-colour part turned on its side, as an object per body and as one components object), each **skipped when the program is not installed**. The optional `interop` CI job installs both. Override the commands with `FREECADCMD` and `SLICER_CMD`; `INTEROP_KEEP=1` keeps the files.
