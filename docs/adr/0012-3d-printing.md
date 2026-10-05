# 0012: 3D printing: a document-level print section, a print package and worker, standard 3MF by download

- Status: accepted
- Date: 2026-10-01

## Context

M3 makes manufakture good at its first domain, parts for an FDM printer ([product decisions](../decisions/0000-product-decisions.md): Bambu Lab printers sliced with OrcaSlicer). The [M3 plan](../plans/m3.md) splits the milestone into printability checks (T3.1a to T3.1d), print features (text, threads and fits, T3.2a to T3.2h) and 3MF with a slicer hand-off (T3.3a to T3.3c), and lists thirteen decisions that cut across those tasks. This ADR records them before code, so that the schema tasks (T3.1a, T3.2c, T3.2f) and the packages they touch share one design.

The inputs:

- **What M1 and M2 leave** (M3 plan, "Where M1 (and M2) leave us"). `packages/kernel`'s `topology` gives every face its surface type, area, centroid, a plane's outward normal and a cylinder's radius and axis direction, exactly and with every regen; it gives no point on a cylinder's axis and no hole-or-pin side. `MeshData` carries per-vertex normals as a `Float32Array`, face ranges and face names. `packages/io` writes watertight 3MF core with one named object per body and no transforms, colours or components. Profiles are lines, arcs and circles, one region per feature. Materials are a permanent-id table in `packages/core/src/materials.ts`. The `extension` feature kind is reserved for domain features, but regen treats it as geometry-free. M2 brings bodies with a name, colour and material each, a mesh per body and a 3MF object per body ([M2 plan](../plans/m2.md), T2.1a to T2.1d).
- **[ADR 0004](0004-document-format.md)**: the document is a versioned JSON source of truth; nothing derived is stored (decision 1); every shape change bumps `version` with a migration and a fixture (decision 2); ids are permanent and never reused (decision 4); references are names (decision 5); numbers are `StoredExpression`s (decision 7); the cache is keyed by a hash of a feature's inputs (decision 8).
- **[ADR 0007](0007-worker-protocol.md)**: three contexts (main thread, kernel worker, solver worker), Comlink for every call with one interface per worker, coarse calls, cancellation by generation, errors as data, meshes transferred and never copied by the worker.
- **[ADR 0006](0006-licensing.md)**: AGPL code is excluded from the repository (decision 3). All three slicers are AGPL-3.0.
- **[ADR 0011](0011-fonts.md)**: the bundled font (Inter Bold), the rules for user fonts in the document, and the OFL amendment to ADR 0006.
- **The research note [Slicer hand-off and 3MF interop](../research/slicer-handoff.md)**, which read OrcaSlicer 2.4.2, Bambu Studio 2.8.2 and PrusaSlicer 2.9.6 at their release tags: how each slicer reads colours from a 3MF (section 3), the Bambu Lab build volumes and process defaults from OrcaSlicer's profiles (section 4), why a page with no server cannot hand a slicer a URL (section 2), and a recommendation (section 5).
- **The spikes behind it.** T3.0a (a command-line load matrix of 3MF fixtures in OrcaSlicer) runs in parallel with this ADR, and T3.0d (the same fixtures in the slicers' GUIs, by a person) needs T3.0a's checklist. When this ADR was written, the research note had no "Verified" section yet, so no spike result is cited here; decision 13 leaves what depends on them to T3.3a.
- **The M5 plan** ([M5 plan](../plans/m5.md), decisions 2, 6 and 7) puts CAM state in a document-level `cam` section, lets CAM references go stale instead of blocking modelling, and adds a CAM worker; its own ADR (T5.0c) has not been written yet. The M4 plan proposes a generic, namespaced document field `domains` for domain data that is not a feature ([M4 plan](../plans/m4.md), decision 6, ADR task T4.0a), and asks whether M3 should use it or a typed section like M5's `cam`.

The acceptance print (T3.4b) is made on a Bambu Lab X1 Carbon with a 0.4 mm nozzle and an AMS, which gives the jig's thumbscrew its second colour without a manual filament change. The printer table and the checks must therefore cover the X1 Carbon, including its excluded corner, at that nozzle.

## Decision

1. **Print setups live in a top-level `print` section of the document, not in the feature tree.** A setup names a printer and a nozzle, optional thresholds, and the items to print (bodies with an orientation and a copy count). It changes no geometry, so it is not a feature and never dirties a regen: `diffDocuments` reports `printChanged` separately from part edits, with no `firstAffectedIndex`, and regen never reads the section. Nothing derived from it is stored (ADR 0004 decision 1): no analysis results, no transformed meshes, no exports; only setups, thresholds and orientations. Ids follow ADR 0004 decision 4, from document-level counters in `print.nextIds` (`print#n` for setups, `item#n` for items, `r<n>` for references), a namespace separate from part feature ids. Thresholds and orientation angles are `StoredExpression`s, so `variableUses`, `renameVariable` and `inlineVariable` reach them like any other expression.

   The shape, as a first cut for T3.1a (field names may still change in that task; the rules above may not):

   ```ts
   interface ManufaktureDocument {
     // ...as after M2
     print: PrintData; // the migration adds { setups: [], nextIds: {} }
   }

   interface PrintData {
     setups: PrintSetup[];
     nextIds: Record<string, number>; // 'print' (setups), 'item', 'r'; only ever increase
   }

   interface PrintSetup {
     id: string; // 'print#1'
     name: string;
     printer: string; // a printer table id (decision 3); not checked by the schema
     nozzle: number; // mm, one of the printer's nozzle sizes
     thresholds?: {
       overhang?: StoredExpression; // angle from vertical (decision 6)
       minWall?: StoredExpression;
       minGap?: StoredExpression;
       minHole?: StoredExpression;
       teardrop?: StoredExpression; // horizontal holes above this diameter are flagged
     }; // absent: defaults from printer and nozzle
     items: PrintItem[];
   }

   interface PrintItem {
     id: string; // 'item#1'
     part: string; // part id
     body?: string; // body id (M2); absent: every body of the part
     orientation:
       | { kind: 'asModelled' }
       | { kind: 'layFlat'; face: FaceReference; turn?: StoredExpression } // face down on the bed, then a turn about z
       | { kind: 'rotate'; x: StoredExpression; y: StoredExpression; z: StoredExpression };
     copies?: number;
   }
   ```

2. **Print references never block modelling.** An item names a body (`{ part, body }`, M2 decision 1) and a `layFlat` orientation names a planar face (a `FaceReference` in core's `Reference` wrapper, ADR 0004 decision 5). Deleting or changing the feature that made either is always allowed. When the print workspace next resolves the setup, a missing body or face is reported on the item as `reference-lost` with the missing names, and the panel offers a re-pick, with the same vocabulary regen uses (`exact`, `descendant`, `ancestor`, `fragile`, `lost`, `ambiguous`). Core validation checks only that an item's part id exists and that body ids and references are well formed, never that the body or face still exists. Likewise a printer id the app does not know (a document from a newer build) loads unchanged; the setup reports the unknown printer and runs no checks against it.

3. **The printer table is data with permanent ids**, in `packages/print/src/printers.ts`, kept like `materials.ts`: ids (`bambu-a1-mini`, `bambu-x1c`, ...) are never renamed or reused, and the table grows without a format change. Each row holds the build area as a polygon, the height, excluded areas, per-nozzle areas and heights for two-nozzle printers, the nozzle sizes the model is sold with, and the default line width, and **cites its source**. The Bambu Lab rows come from OrcaSlicer 2.4.2's BBL machine profiles as the research note resolved them (section 4); nozzle sizes come from Bambu Lab's product pages, read in T3.1b and cited per row.
   - **Facts, not files.** The numbers are copied as facts with the profile path and release cited. The AGPL profile files are never copied, vendored, parsed at build time or fetched at run time (ADR 0006 decision 3).
   - **The slicer's view wins.** Where a profile and the manufacturer's marketing differ (the X1 and P1 heights: 250 mm inherited in the profiles against 256 mm advertised, research note section 4), the row uses the profile value, since that is what the slicer enforces.
   - **Updates are deliberate.** A row changed for a newer profile release cites the new release; the change shows in review, never silently.
   - **Thresholds default from the printer and nozzle**: the minimum feature is OrcaSlicer's `min_feature_size`, 25% of the nozzle (research note section 4); the minimum wall (two line widths), minimum gap, minimum hole and teardrop size are estimates, documented as such where they are defined (M3 plan, T3.1b and T3.1c) and editable per setup. The UI says "may print badly", never "will fail".

4. **A new package, `packages/print`**, pure TypeScript under GPL-3.0-or-later, with no dependency on the kernel, regen, the app or the DOM; it imports `MeshData` and `Topology` from `packages/kernel` as types only and runs in Node for tests. It holds the printer table, the orientation transforms, overhang classification, bed fit, wall thickness and gaps, hole and pin checks, the fit defaults (decision 10) and the print-analysis worker entry (decision 5).

5. **Analysis runs on meshes; facts come from the B-rep; the heavy part runs in a print-analysis worker.**
   - **Mesh analysis at the export tolerance.** Overhang angles, wall thickness and gaps are measured on the per-body meshes at the export tolerance (0.02 mm chordal at `normal`, io README), two orders of magnitude finer than a nozzle resolves. Tolerances that compare mesh-derived values account for the mesh's `Float32Array` precision (M3 plan, T3.1b).
   - **Exact facts from `topology`.** Planar normals for lay-flat, bed contact, and hole and pin radii, axes and sides come from the B-rep through `topology`, exactly, never from the mesh. T3.1c adds the two cylinder facts `FaceInfo` lacks (`axisOrigin` and `hole`) to `packages/kernel`; they are additive and nullable. Face names come from the mesh's `faceNames`, since `Topology` holds none.
   - **Where each part runs.** Overhang classification is cheap: in the viewport it is a shader over the mesh normals and the orientation, recomputed on the GPU every frame (T3.1d), and the issue list's overhang areas come from `packages/print` on the main thread. Bed fit and the hole checks are cheap too and run on the main thread. Thickness and gap ray casting is not, and runs in a **print-analysis worker**.
   - **The print-analysis worker is a new context**, next to ADR 0007's main thread, kernel worker and solver worker, and follows that ADR's rules: one Comlink interface defined in `packages/print`; one coarse call per setup and analysis, not per body or triangle; a `generation` on every request, newer calls superseding older ones (debounced on the main thread after a regen or an orientation change); expected failures as values; results (issue lists, per-triangle values) returned as transferred typed arrays. Its input meshes are **copied** from the main thread, which keeps them for drawing, since regen keeps none (ADR 0007 decision 6). It is started lazily, the first time a print workspace needs it, so a document with no print setup never starts it.
   - **It is not shared with M5's CAM worker.** The two have different dependencies (the CAM worker loads a polygon library and possibly OpenCAMLib's `.wasm`; the print worker is pure TypeScript plus a bounding volume hierarchy), different lifetimes, and different costs: a slow toolpath must not hold up the printability overlay, nor the reverse. The cost is one more worker, which is small for a pure-TypeScript one. M5's architecture ADR (T5.0c) may propose one shared analysis worker; it would then amend this decision.

6. **Overhang angles in one convention: degrees from vertical.** The UI, the docs and the stored `overhang` threshold state a surface's angle from vertical: a vertical wall is 0 degrees, a flat downward-facing ceiling 90 degrees, as in the familiar "45 degree rule". OrcaSlicer's `support_threshold_angle` is a slope **from horizontal**, default 30 degrees (research note section 4); the default shown to the user is converted to **60 degrees from vertical**, and the conversion is written next to the setting in the UI and in `docs/user/printing.md`. The angle is a `StoredExpression` like any other (displayed in degrees, held in radians inside, [ADR 0005](0005-units.md)). Overhang means strictly steeper than the threshold, matching OrcaSlicer's "below the threshold" rule for slopes; a surface at the threshold within a fixed tolerance (about 1e-6 rad, fixed and documented in T3.1b) is steep, not overhang. Triangles in the plane of the bed are `onBed`, never overhang. The warning band below the threshold (10 degrees) is an estimate.

7. **Text is an `outline` sketch entity with a `source`.** A sketch can hold `{ id, kind: 'outline', construction, anchor, angle, source }`, where `source` is a union: `{ kind: 'text', text, font, size, align, letterSpacing?, lineSpacing? }` in M3, and an `svg` source added by M5's T5.8 to the same kind rather than a second one. It is part of the sketch model (`packages/sketch/src/model.ts`) and core's schema, not an `extension`, because it changes geometry and needs core validation and kernel support.
   - The anchor is a point constraints can reference; the glyph geometry is never solved.
   - Regen expands every outline into closed region loops before region detection, at every regen, so changing the string, the font or a size variable changes the part. One converter from paths (lines, quadratic and cubic Beziers) to region loops lives in `packages/sketch/src/outline.ts` (T3.2b) and serves both text and SVG.
   - Glyph edge ids are positional (entity id plus glyph, contour and segment indices), so faces built on them are **fragile** like imported faces, and a reference to one resolves with a warning.
   - Regions with holes and Bezier edges are kernel and regen capabilities (T3.2a), not part of the entity.

8. **Fonts follow [ADR 0011](0011-fonts.md).** The document gains a `fonts` list: the bundled font recorded by id and SHA-256 with no bytes, user fonts stored with their bytes, file name, size and SHA-256 like imported files and moved to content-addressed blobs by persistence. A change to the bundled file is detected through its SHA-256 (a warning and a cache miss), never a silent change of geometry. The regen cache key for an outline includes the font's SHA-256 and the evaluated size. Licensing, the choice of font and what is shown for user fonts are ADR 0011's.

9. **Threads are a core `thread` feature on a cylindrical face.** The picked face (a `FaceReference`) supplies the axis, the side (internal or external) and the extent; the thread standard (ISO metric coarse or UNC, from a table in `packages/kernel/src/threads.ts`, T3.2e), the hand, the length and a clearance define the geometry, not the cylinder's exact radius. A cylinder outside what the chosen size can be cut from or added to is an `invalid` feature error naming the expected range. The thread acts on the body that owns the face (M2 decision 3, like a fillet). Two representations:
   - **`modelled`** cuts or adds real helical geometry, with birth names `<id>:thread:flank-a`, `flank-b`, `crest`, `root` and the ends; faces of the original cylinder the thread keeps or modifies keep their own names. The printability checks tell a threaded hole from a plain one by the axis of its `:thread:` faces (T3.1c).
   - **`cosmetic`** only resizes the cylinder (to the tap drill size inside, the major diameter minus the clearance outside), for tapping, self-tapping screws and heat-set inserts, and is drawn as helix lines over the face.

   It is a core kind, not an `extension`, for the same reason as decision 7. If T3.2e finds no robust way to build modelled threads in OCCT's WASM build, M3 ships cosmetic threads only and modelled threads become a follow-up; the feature shape stays the same.

10. **Fits are document variables.** Press, slip and sliding clearances are ordinary variables, `#fit_press`, `#fit_slip` and `#fit_sliding`, inserted in one undoable `batch` by an **Insert fit variables** command that never overwrites existing ones, with defaults from the active setup's printer and nozzle (`packages/print/src/fits.ts`, T3.2g). Every dimension can use them in expressions, a thread's clearance defaults to `#fit_slip` when it exists, and a printed calibration coupon replaces the placeholder defaults with measured values (T3.2h). There is no new mechanism in `packages/units` and no format change.

11. **The slicer hand-off is a download** in M3 (research note, section 5). **Open in slicer** exports the setup as a 3MF, downloads it under a clear name (`<document>-<setup>.3mf`), and shows a dismissible panel for the chosen slicer and platform: open it from the browser's download list, make the slicer the default for `.3mf`, and Chrome's "always open" choice if T3.0d confirms it for `.3mf`. Every custom scheme ends with the slicer fetching an HTTP URL, and a page with no server has no URL a slicer can fetch (research note, section 2), so there is **no custom-scheme launch** (`orcaslicer://`, `bambustudio://`) until M7 can host a short-lived, unguessable https URL, and then only after the user opts in, with the download always offered next to it. Export is refused, with the issue named, when bed fit fails; other issues are listed but do not block.

12. **3MF stays standard.** `write3mf` (T3.3a) writes:
    - 3MF core, as today, with `Application` set to `manufakture` and `Title` to the document name. It never writes an `Application` value starting with `BambuStudio-` or `OrcaSlicer-`, or an `OrcaSlicer` metadata entry: OrcaSlicer would then treat the file as its own project and require a valid `Metadata/model_settings.config` (research note section 3).
    - The Materials and Properties extension's colour groups, declared with the prefix `m` (OrcaSlicer matches `m:colorgroup` and `m:color` as literal tag names): one `m:colorgroup` per distinct body colour with a single `m:color`, in first-use order, and `pid` with `pindex="0"` on each coloured object. That is what OrcaSlicer and Bambu Studio both turn into filament slots (research note section 3). No `requiredextensions` for colours, so a consumer that ignores them still loads the geometry; PrusaSlicer does, with no colours.
    - Build items with a rigid `transform` for each item's orientation and placement on the plate, and one build item per copy.
    - Not the Production extension, which only matters for splitting a package into several model files.

13. **Components and `Metadata/model_settings.config` are left to T3.3a, on evidence.** Whether several bodies of one item go out as one component object, and whether a minimal `Metadata/model_settings.config` with per-object or per-part `extruder` helps a third-party file, depends on how OrcaSlicer and Bambu Studio map such files, which the research note left unverified (section 3, "Several bodies as one object"). T3.0a's command-line matrix had not been written up when this ADR was accepted, so this ADR does not decide either. T3.3a decides from T3.0a's results, writes neither without evidence, and records the choice and its evidence in `packages/io/README.md`; T3.0d's GUI results confirm it or become a follow-up change to T3.3a. Whatever T3.3a writes, `parse3mf` reads back and `validate3mf` checks, so our own files round-trip.

14. **One format bump per schema task, without assuming numbers.** T3.1a (the `print` section), T3.2c (the `outline` entity and `fonts`) and T3.2f (the `thread` feature) each take the next free `FORMAT_VERSION` when they land, each with a migration from the version before it and a fixture of that version (ADR 0004 decision 2). They serialise with each other and with every other milestone's schema tasks (M2, M4, M5, M7); nothing in M3 or in this ADR assumes a version number. If schedules collide, T3.2c and T3.2f may share one bump, provided no release ships in between. Adding printers, fit defaults or thread sizes never bumps the format.

## Alternatives considered

- **Print setups as features, or as `extension` features.** A setup would then sit in a part's regen chain, dirty a regen on every orientation change, and be bound to one part, while a setup prints bodies of several parts. Regen treats `extension` features as features of the part. Rejected, for the same reasons M5 gives for CAM operations (M5 plan, decision 2).
- **Print data under M4's generic `domains` field.** One namespaced slot validated by a domain package would save M3 its own format bump. But print setups hold `StoredExpression`s and `FaceReference`s that core's variable rename and inline, its validation and `diffDocuments` must reach, and an opaque field hides them from core. M4's ADR (T4.0a) is not written yet, and M3 does not depend on M4. Rejected for M3; if T4.0a later moves every domain into `domains`, a new ADR supersedes decision 1 and a migration moves the data.
- **Blocking the deletion of a feature that a print item names.** Would invert the order people work in (model, then print) and make an orientation a reason not to edit the part. Rejected, as in M5's decision 6.
- **Reading printer data from slicer profiles at run time, or vendoring them.** The profiles are AGPL files (ADR 0006 decision 3), and a run-time fetch breaks offline use. Rejected: the numbers are facts, copied with their source cited.
- **Thickness ray casting on the main thread.** Its budget for a 200,000-triangle body is under a second even in a worker (an estimate, M3 plan, T3.1c), long enough to drop many frames. Rejected.
- **Running the analysis in the kernel worker.** It needs nothing from OCCT, and would queue behind regens and kernel recycles. Rejected.
- **One worker for print analysis and CAM.** Rejected for now (decision 5); M5's ADR may revisit it.
- **Overhang angles from horizontal, as OrcaSlicer states them.** Matches the slicer, but most printing guides state the "45 degree rule" from vertical, and two conventions in one UI invite mistakes. Rejected; the conversion is documented where the setting is.
- **Text as a separate feature kind, or one entity per glyph.** A feature would duplicate the sketch's placement, constraints and region selection; an entity per glyph would make an edit to the string a rebuild of many entities. Rejected.
- **Separate entity kinds for text and SVG.** Two converters and two schema changes for the same geometry (lines and Beziers). Rejected in favour of one `outline` kind with a `source`.
- **Threads as an `extension` feature.** Regen treats extensions as geometry-free, and a thread needs core validation, kernel support and names. Rejected.
- **Threads as a hole-feature option only.** Would leave external threads (shafts, thumbscrews) out and tie threads to one feature kind. Rejected; the hole dialog can still offer a thread through this feature.
- **Fits as a new unit or a fit table in `packages/units`.** A new mechanism for what variables already do, and not editable per document. Rejected.
- **A custom-scheme "Open in slicer" in M3.** No fetchable URL exists without a server (research note section 2), so it would at best open an empty slicer. Rejected until M7, with opt-in.
- **Writing a Bambu or Orca project file**, with their `Application` value and full `model_settings.config`. Would claim to be another program, make OrcaSlicer require the project config to be complete, and depend on undocumented formats. Rejected.
- **Per-triangle colours (`p1` to `p3`).** OrcaSlicer ignores them (research note section 3), and M3 does not paint faces. Rejected for M3.

## Consequences

- T3.1a, T3.2c and T3.2f cite this ADR for their schema changes; each takes the next free format version when it lands.
- The document gains `print` (T3.1a), `fonts` (T3.2c) and two new kinds: the `outline` sketch entity (T3.2c) and the `thread` feature (T3.2f). The persistence code must carry the new top-level keys; T3.1a checks the persistence README for key filters.
- A print edit never triggers a regen, and a model edit never fails because of a print setup; the print panel shows `reference-lost` items instead.
- ADR 0007's three contexts become four with the print-analysis worker (five once M5 adds its CAM worker). ADR 0007 should gain a short amendment section that points here, as the [ADR README](README.md) asks; that edit is left to T3.1c, which builds the worker.
- `packages/kernel`'s `FaceInfo` gains `axisOrigin` and `hole` for cylinders (T3.1c); every consumer of `Topology` sees them, and they are additive and nullable.
- The printer table must be revisited when OrcaSlicer's BBL profiles change; each row says which release it was read from.
- Analysis thresholds other than the minimum feature size and bed fit are estimates; the docs and UI say so, and the fit defaults are placeholders until T3.2h measures them.
- The jig in T3.4a and its acceptance print in T3.4b use the same setup: a Bambu Lab X1 Carbon with a 0.4 mm nozzle and an AMS (the owner's decision, replacing the plan's A1 mini), so the e2e spec's bed-fit and export checks run against the printer the part is physically printed on, including the X1 Carbon's excluded corner.
- The 3MF details beyond decision 12 (components, `model_settings.config`) are T3.3a's to decide and document; T3.3c's optional OrcaSlicer check guards whatever it chooses against later slicer releases.
- Text and SVG share one outline converter and one entity kind, so M5's T5.8 adds a source instead of a schema of its own.
