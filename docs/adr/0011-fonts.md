# 0011: Fonts: one bundled OFL font (Inter Bold), user fonts stored in the document

- Status: accepted, amended 2026-10-01
- Date: 2026-10-01

## Context

M3 adds embossed and debossed text ([M3 plan](../plans/m3.md), decisions 6 to 8, tasks T3.2b to T3.2d). Text needs a font, and two kinds are involved:

- **A bundled font**, shipped with the app and the default in the Text tool, so text works with no setup and a document that uses it opens the same everywhere.
- **User fonts**, a TTF or OTF file a user adds to a document for their own text.

[ADR 0006](0006-licensing.md) decision 2 lists the licenses a shipped dependency may have: permissive GPLv3-compatible licenses, MPL-2.0, GPLv3, and LGPL as a separate module. Almost every good open font is under the SIL Open Font License 1.1, which that list does not name, so shipping one needs a decision. This ADR amends ADR 0006 decision 2 in part, and ADR 0006 records the change in an amendment section, as the [ADR README](README.md) asks. User fonts are not dependencies at all: we never ship them, but the document stores them, so their handling needs rules too.

What the license says, from its own text and FAQ, as the M3 plan cites them:

- The OFL is a license for the font only. Its condition 5 keeps the font, modified or not, entirely under the OFL; it can never be relicensed under the GPL. Its condition 1 forbids selling the font by itself but allows bundling it with software, and OFL FAQ 1.3 says bundling with software under other licenses is intended ([OFL FAQ](https://openfontlicense.org/ofl-faq/)). The FSF lists the OFL as "a free copyleft license for fonts" ([FSF license list](https://www.gnu.org/licenses/license-list.html)).
- Condition 2 requires the copyright notice and the license to travel with every copy of the font, as a text file or in the font's metadata.
- Condition 3 forbids a modified version from using a Reserved Font Name (RFN), if the font declares one. OFL FAQ 2.6 counts subsetting as modification, so a font with an RFN cannot be subsetted and still called by its name.
- OFL FAQ 1.13: embedding a font in a document "does not change the license of the document itself". Geometry made from glyph outlines in a user's part is the user's work.

What a font has to do for FDM printing:

- **Thick strokes.** Embossed text is raised strokes; a stroke thinner than the minimum wall (two line widths, 0.84 mm at a 0.4 mm nozzle, an estimate, M3 plan T3.1c) prints as a single weak line or not at all. Light and regular weights fail first; a bold or semibold weight keeps strokes printable at a smaller size.
- **Open shapes at small sizes.** Small text is where printers struggle. A large x-height keeps lowercase letters big at a given size, and open apertures (in `a`, `c`, `e`, `s`) keep counters from closing up into blobs.
- **A static instance with overlaps removed.** Regen turns glyph contours into sketch regions with the nonzero fill rule (T3.2b). Variable fonts and their instances often keep overlapping contours inside a glyph (where a stem meets a bowl), which `outline.ts` would have to merge or refuse. A static font whose build removed overlaps gives clean regions with no extra work, and a static file has no axes to choose.

## Decision

1. **OFL 1.1 is allowed for font files that ship with the app**, as an addition to ADR 0006 decision 2, on these terms:
   - the font is a separate data file, served as its own asset and loaded at run time as bytes (fetched as an `ArrayBuffer` and parsed by `opentype.js`); it is never compiled, inlined or base64-encoded into our JavaScript, so it stays an aggregate next to the GPL code rather than part of it;
   - the file is shipped unmodified, byte for byte as the upstream release has it, **or** the font has no Reserved Font Name, in which case a later change (subsetting to cut download size) is allowed and keeps the name;
   - the font's copyright line and the full OFL text ship in the app's notices (ADR 0006 decision 5), with the font's name and version, and the license file sits next to the font file in the repository;
   - the license is read from the font's own files (the license file in its release, whatever that release names it, and the font's `name` table), not from a catalogue or CDN listing, as ADR 0006 decision 6 requires for packages.

   This applies to every font file committed to the repository, test fixtures included (T3.2b's test font): the repository is public, so committing a font distributes it.

2. **The bundled font is Inter Bold**, the static TrueType file `Inter-Bold.ttf` from the upstream release of [Inter](https://github.com/rsms/inter) (`rsms/inter` on GitHub, Releases page; the release zip carries the static instances under `extras/ttf/`). The version is Inter 4.1 (latest release as of 2026-10-01). Its license file is `LICENSE.txt` in the release zip: SIL OFL 1.1, copyright "The Inter Project Authors", no Reserved Font Name (no RFN, confirmed from `LICENSE.txt` on 2026-10-01). `extras/ttf/Inter-Bold.ttf` in that zip (420,428 bytes) is static (no `fvar` or `gvar` table, `glyf` outlines), has OS/2 `fsType` 0 and `name` id 5 "Version 4.001", and its `name` entries 0, 13 and 14 agree with `LICENSE.txt`; all checked from the release on 2026-10-01. SPDX identifier: `OFL-1.1-no-RFN`. T3.2b ships 4.1, or a later release if one exists by then and passes item 3 again, and records the file's SHA-256. Reasons:
   - **Weight.** Bold is the heaviest weight below Extra Bold and Black, whose counters close up at small sizes. It is the better trade for embossing, where strokes must clear the minimum wall; SemiBold is the alternative if T3.2b's measurements (item 3) show Bold's counters closing at the sizes people use.
   - **Small sizes.** Inter was drawn for small text on screens: a tall x-height, open apertures and generous spacing. The static `Inter-*` files are the text optical size; the `InterDisplay-*` files beside them are tighter and finer for large sizes and are not the ones to ship.
   - **Clean outlines.** The release ships static instances as plain TrueType (verified for `Inter-Bold.ttf` 4.1), so there are no axes to pick. Overlap removal is expected of static instances but not verified yet; item 3 confirms it.
   - **License shape.** No RFN means a later subsetting optimisation (Latin only, say) stays allowed without renaming. One upstream with one license file, distributed as static files directly by its author, keeps the provenance simple.
   - **One font, one weight.** One bundled file keeps the download small; it is fetched only when a document first needs text, not at app start.

3. **What T3.2b must verify from the files before shipping**, recorded in `packages/text/fonts/README.md` (or the package README) with the date. The first two checks and `fsType` were done for Inter 4.1 on 2026-10-01 (decision 2); T3.2b repeats them only if it ships a different release.
   - The release's license file (`LICENSE.txt` for Inter) is the SIL OFL 1.1, gives the copyright line, and has **no** "with Reserved Font Name" clause; the font's `name` table entries 0 (copyright), 13 (license description) and 14 (license URL) agree with it.
   - The file is static: it has no `fvar` or `gvar` table and TrueType (`glyf`) outlines, not CFF2.
   - Overlaps are removed: no glyph in the shipped character set has contours that intersect each other, checked by a test over the glyphs (at least Basic Latin, Latin-1 Supplement, the degree sign, plus-minus and multiplication sign, and the diameter sign U+2300 if present; the test reports which are missing).
   - Its OS/2 `fsType` (0, installable embedding, for Inter 4.1), version string and SHA-256, recorded.
   - Stroke widths: the vertical stem of `H` and `l` and the narrowest counter (`e`, `a`) in font units, and from them the smallest cap height at which the stem clears the minimum wall at a 0.4 mm nozzle; that number goes into `docs/user/text.md` as the recommended minimum text size.

   If a check fails (an RFN, overlaps, variable tables), T3.2b does not ship Inter Bold; it takes the fallback in item 4 and records the swap as an amendment to this ADR.

4. **Fallback: Noto Sans Bold**, the static `NotoSans-Bold.ttf` from the Noto project's upstream release, OFL 1.1, "The Noto Project Authors". The upstream repository (believed to be `notofonts/latin-greek-cyrillic` on GitHub) and the absence of a Reserved Font Name are not verified here; the checks in item 3 settle both before it could ship. It meets the same criteria with a smaller x-height and a much larger glyph set, so a bigger file. The same checks apply.

5. **Source rules for the bundled font.** The file comes from the upstream release, never from a font CDN or a repackaging: a CDN may serve a variable or otherwise modified file (Google Fonts is believed to serve Inter as a variable font; not verified here), and npm repackagings (Fontsource and similar) ship subsetted WOFF files, which are modified copies. The file lives under `packages/text/fonts/` with `OFL.txt`, a verbatim copy of the release's `LICENSE.txt`. Its bundled id is stable for the family and weight (`inter-bold`); an update to a newer upstream version is a deliberate change that changes the recorded SHA-256, which documents detect (a warning and a cache miss, M3 plan T3.2c), never a silent change of geometry.

6. **It is the default in the Text tool.** A new text entity uses the bundled font unless the user picks another; the document records it as `{ kind: 'bundled', id, sha256 }` with no bytes (T3.2c).

7. **User fonts are stored in the document like imported files.** A font a user adds is kept as its bytes (base64 `data`), its `fileName`, its `size` and the lower-case hex SHA-256 of the bytes, as `ImportSourceSchema` does for STEP and STL (`packages/core/src/schema.ts`), and persistence moves the bytes to content-addressed blobs the same way. Further rules:
   - **Formats:** TTF and OTF only; collections (`.ttc`), WOFF2 and bitmap-only fonts are refused with a clear message. The size cap is `MAX_IMPORT_BYTES` (20 MiB). Parsing happens in a worker, never on the main thread, and a malformed file fails cleanly (M3 plan T3.2b, risks): font parsing is attack surface.
   - **What is shown:** the family and style, the version, the copyright (`name` 0), the license description and URL (`name` 13 and 14) when present, and the embedding permissions from OS/2 `fsType`: installable (0), restricted (bit 1), preview and print (bit 2), editable (bit 3), and the no-subsetting (bit 8) and bitmap-only (bit 9) flags. A restrictive value (restricted, or preview and print) gets a warning that storing the font in a document that is shared may not be allowed by its license. We do not interpret licenses further and do not block the file: the font is the user's, and so is the decision.
   - **Never redistributed by us.** User fonts are never shipped with the app, never added to the bundled set and never sent anywhere by the app on its own. They travel only inside the user's own document (a saved `.mfk`, and in M7 the user's synced or shared documents, at the user's request). Mesh and CAD exports (3MF, STL, STEP) contain geometry only, never font bytes.
   - **Variable user fonts** are used at their default instance; overlapping contours are merged or refused by `outline.ts` (T3.2b), never passed to the kernel as overlapping regions.

8. **New runtime dependency: `opentype.js`** (2.0.0, MIT, from npm metadata read on 2026-09-26) parses fonts in `packages/text`. Its license and its own runtime dependencies are re-read from the installed package when T3.2b adds it (ADR 0006 decision 6), and each gets an inventory row.

9. **Coordination with M5.** M5's T5.0c or T5.5a amends the same ADR 0006 decision 2 for LGPL-3.0 (OpenCAMLib). Whichever of the two amendments lands second extends the first rather than contradicting it; the two are independent (fonts as data, a library as a separate module).

## Alternatives considered

- **Roboto (Bold).** Believed to be OFL 1.1 in its current releases with no RFN, after years under Apache-2.0 (license history not verified here); if so, the license depends on which copy of the file one has, which is the kind of question decision 1 wants to avoid. Its letters are narrower, with tighter apertures, which close up sooner at small printed sizes.
- **Noto Sans (Bold).** Kept as the fallback (decision 4): good shapes and, as far as known (RFN status not verified here), a clean license, but a smaller x-height than Inter at the same size and a far larger file for glyphs a part label does not need.
- **Atkinson Hyperlegible.** Drawn for legibility, with clearly different `I`, `l` and `1`, which matters on labels. Its OFL text is believed to declare a Reserved Font Name (not verified here), so it could only ship unmodified and never subsetted under its name; a candidate for a second bundled font later if that is acceptable.
- **A variable font (Inter's variable file, or another).** One file for every weight, but its glyphs keep overlapping contours, and picking an instance at run time means work in `opentype.js` that a static file avoids.
- **Several bundled weights or families.** More choice, more download. One bold font covers printed labels; users who want another add it as a user font.
- **No bundled font, user fonts only.** No license question for us, but text would not work out of the box and documents would not open the same everywhere.
- **Single-stroke (engraving) fonts such as Hershey.** Lines, not filled regions; useful for CNC engraving (M5), not for embossed FDM text.
- **Loading the font from a font CDN at run time.** Breaks offline, local-first use (product decisions), and the served file may be a modified or variable version.

## Consequences

- ADR 0006 gains an amendment (dated 2026-10-01) that adds OFL 1.1 for font files to its allowlist and adds `opentype.js` and Inter Bold to its inventory. The follow-up CI license check of ADR 0006 decision 5 must also check the files under `packages/text/fonts/`, which are not npm packages.
- T3.2b ships `Inter-Bold.ttf` and `OFL.txt` (a verbatim copy of the release's `LICENSE.txt`) under `packages/text/fonts/` after the checks in decision 3, and keeps any test font under OFL with its license next to it. Until this ADR is accepted, it builds with a test font only.
- T3.2c's `fonts` list records the bundled font by id and SHA-256 and user fonts with their bytes, size and SHA-256; a bundled font update is detected, not silent.
- T3.2d's Text tool defaults to the bundled font, and its **Add font** panel shows the user font's name, license strings and `fsType` permissions with the warning in decision 7.
- `docs/user/text.md` states the recommended minimum text size measured from the bundled font, and that user fonts' licenses are the user's to honour.
- Inter's `I` and `l` are both plain vertical bars, as in most sans-serifs, so they can be mistaken for each other on a label. Inter has a disambiguation stylistic set; using it depends on `opentype.js` applying that substitution, which a later task can check.
- Inter has no RFN (confirmed from `LICENSE.txt` on 2026-10-01), so subsetting the bundled font to cut its size stays open as a later optimisation, provided the result keeps its OFL license and notice.

## Amendment: the overlap check, and overlaps merged in outline.ts (T3.2b)

Decision 3's checks were run on Inter Bold 4.1 by T3.2b on 2026-10-01 (`packages/text/src/bundled.test.ts`, results in `packages/text/README.md`). The license, static-file, `name` table and `fsType` checks pass as decision 2 recorded, and the SHA-256 is `288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f`. Two findings change how the decision is carried out:

- **The overlap check fails, for composite glyphs.** Five glyphs of Latin-1 Supplement, `Ç`, `ç` (a cedilla component), `Ð` (a bar) and `Ø`, `ø` (a slash), keep their components' contours overlapping or touching, as TrueType composite glyphs do; every other glyph of Basic Latin and Latin-1 Supplement has disjoint contours. The context above expected a static font with overlaps removed to have none; that holds for simple glyphs only. Decision 3 says a failed check means the fallback, but the fallback has the same kind of overlaps: Noto Sans Bold 2.015 (the `NotoSans-v2.015` release of `notofonts/latin-greek-cyrillic`, OFL 1.1 with no Reserved Font Name in its `OFL.txt`) overlaps in `Å`, `Ç` and `ç`. Swapping fonts would not remove the problem, and decision 7 already requires `outline.ts` to merge or refuse overlaps for user fonts. So `outline.ts` merges them (M3 plan, T3.2b: "merged in `outline.ts` or refused"): segments are cut where contours meet, the pieces with fill on one side kept and re-chained, Beziers cut exactly; `Ø` becomes one region with two holes. Only curves that partly coincide are refused. **Inter Bold stays the bundled font**, shipped unmodified.
- **The diameter sign U+2300 is not in Inter** (nor in Noto Sans). Labels write `Ø` (U+00D8), which both fonts have; `layoutText` reports characters a font lacks.

The stroke measurements give a recommended minimum text size of 4.2 mm cap height (the 300-unit stem of `l` against a 0.84 mm wall at a 0.4 mm nozzle); horizontal strokes are thinner, the crossbar of `e` (188 units) clearing 0.84 mm only from 6.7 mm. T3.2d puts the number into `docs/user/text.md`.

## Amendment: limits on untrusted fonts, and a watchdog (T3.2b security review)

Decision 7 asks that a malformed user font "fails cleanly". A security review of T3.2b on 2026-10-01 found well-formed but hostile files that did not fail at all; they hung or crashed the parser: a 163 KB GPOS table whose features and lookups repeat (3.9 s to read; more with a bigger table), nested composite glyphs that opentype.js expands to K^depth points (300 references three levels deep ran V8 out of memory), and overlapping contours whose merging in `outline.ts` grows faster than quadratically (640 overlapping bars: 26 s). Each now has a limit, and every limit fails with a `FontError`, a warning or an issue rather than a hang: the GPOS reader reads each feature once, keeps a lookup's subtables once per offset and stops at 1,024 lookup indexes or 4,096 subtables (the font is used without kerning, with a warning); a TrueType glyph is checked from the raw bytes before opentype.js builds it and refused (`FontError` `malformed`) past 8 levels of nesting, 100,000 points or 10 million parse steps; `outlineRegions` refuses a path over 100,000 commands, 250 million work steps or a million flattened vertices with a `too-complex` error. The numbers and the reasons are in `packages/text/README.md` and `packages/sketch/README.md`.

Not every cost can be bounded from outside the parser: a CFF font's subroutine calls can fan out without limit inside opentype.js. So, in addition to decision 7's worker, **callers must run `loadFont`, `layoutText` and `outlineRegions` for a user font in a worker with a time limit, and terminate the worker when it passes.** A timeout, or the worker dying out of memory, reaches the user as "this font could not be read", the same as a `FontError`, and the font is not used. T3.2c builds this watchdog into the regen worker's font handling.
