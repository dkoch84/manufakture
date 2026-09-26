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

`write3mf(objects, options)` writes the 3MF core specification's package: `[Content_Types].xml` (content types for `.rels` and `.model`), `_rels/.rels` (the root relationship to the model part) and `3D/3dmodel.model` with `unit="millimeter"`, the core namespace, `Application` (and optional `Title`) metadata, one `type="model"` mesh object per body with its `name`, and one build item per object. Coordinates are written to a nanometre without exponents. Names and metadata are escaped for XML: tab, newline and carriage return as character references (a parser would turn raw ones in an attribute into spaces), and what XML 1.0 cannot hold (other controls, U+FFFE, U+FFFF, unpaired surrogates) dropped. It is zipped with fflate. `export3mf(bodies)` welds and checks first.

This is the core subset: geometry, names and units, which is what a slicer needs to place and slice the parts. Opening in OrcaSlicer and Bambu Studio is a manual check (see `docs/user/import-export.md`); PrusaSlicer slicing it is automated in the optional `interop` CI job. Not written: colours, materials, components, build transforms, the production and slice extensions.

`parse3mf(bytes)` reads that same subset back (the root relationship, content types, unit, metadata, mesh objects, build items with their transforms), with a small regex reader rather than a DOM parser so it runs in Node; components are refused. `validate3mf(bytes)` is the structural check tests and CI use: package parts and content types, unit millimetre, unique object ids, triangle indices in range, every object watertight and outward (`checkManifold`), every build item naming an object.

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
- `stl.test.ts`, `threemf.test.ts`, `step.test.ts`, `encoding.test.ts`: writers and parsers, and `validate3mf` finding a wrong unit, an open mesh, a flipped triangle, a dangling build item, a missing content type.
- `kernel-export.test.ts`: real kernel meshes (the kernel is a dev dependency) exported watertight at every preset, STL and 3MF read back, a STEP round trip meshed.
- `interop.test.ts`: FreeCAD reopens our STEP (volume, faces, bounding box) and PrusaSlicer slices our 3MF and STL, each **skipped when the program is not installed**. The optional `interop` CI job installs both. Override the commands with `FREECADCMD` and `SLICER_CMD`; `INTEROP_KEEP=1` keeps the files.
