# @manufakture/text

Text for sketches: fonts and layout. A string, a font and a size become glyph outlines as paths
(`PathCommand[]` from `@manufakture/sketch`) in sketch coordinates, and `outlineRegions` in
`@manufakture/sketch` turns each glyph's path into region loops. The decisions behind it are
[ADR 0011](../../docs/adr/0011-fonts.md) (fonts) and the [M3 plan](../../docs/plans/m3.md),
decisions 6 to 8 and task T3.2b.

Pure TypeScript, using [opentype.js](https://github.com/opentypejs/opentype.js) 2.0.0 (MIT) to
parse fonts. Parse fonts in a worker (the regen worker), never on the main thread, with a time limit:
user fonts are attack surface (see [Untrusted fonts](#untrusted-fonts)).

```ts
import { DEFAULT_FONT_ID, fetchBundledFont, layoutText, loadFont } from '@manufakture/text';
import { outlineRegions } from '@manufakture/sketch/geometry';

const font = loadFont(await fetchBundledFont(DEFAULT_FONT_ID));
const layout = layoutText(font, 'M3 x 12', { size: 6, align: 'center', verticalAlign: 'middle' });
for (const glyph of layout.glyphs) {
  const { regions, issues } = outlineRegions(glyph.path); // one glyph at a time
}
```

Lay out the whole string, then convert **one glyph at a time**: neighbouring glyphs may touch or
overlap after kerning, and those regions are fused by the kernel (T3.2a), not merged here.

## Loading fonts

`loadFont(bytes, { maxBytes? })` takes an `ArrayBuffer` or `Uint8Array` of a TTF or OTF file and
returns a `LoadedFont`, or throws a `FontError` with a `code` and a message a user can act on:

| Code                 | When                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `empty`              | no bytes                                                                               |
| `too-large`          | more than `MAX_FONT_BYTES` (20 MiB, core's `MAX_IMPORT_BYTES`), checked before parsing |
| `unsupported-format` | a collection (`.ttc`), WOFF or WOFF2, or not a font at all                             |
| `malformed`          | a damaged directory, table, character map or glyph; any error from the parser          |
| `no-outlines`        | no `glyf`, `CFF ` or `CFF2` table (a bitmap-only font)                                 |

Before opentype.js sees the file, `sfnt.ts` checks the signature, that every table lies inside the
file, the required tables, and the character map: opentype.js expands every range of a `cmap`
subtable into one entry per code point, so one damaged byte cost it 3 s in testing and a hostile
range could cost far more. Subtables of format 4, 12, 13 and 14 are bounds-checked and refused when
they map more than `MAX_CMAP_CODE_POINTS` (0x40000) code points. The parser then runs on a private
copy inside a try/catch, with the layout and variation tables hidden from it (`GSUB`, `GPOS`,
`GDEF`, `fvar`, `gvar` and others are renamed in the copy's directory): this package applies no
substitutions and reads kerning itself, opentype.js 2.0.0 throws on GSUB lookups it does not know
(Inter's has one), and a variable font is used at its default instance, which is what `glyf` holds.
Glyphs are loaded lazily (`lowMemory`); a damaged glyph surfaces as a `FontError` from `layoutText`.
A test damages the bundled font at random 300 times and checks that only `FontError` is ever thrown.
A font without a `post` table (glyph names) is read normally: opentype.js 2.0.0 would otherwise
fail every glyph lookup on it and map no characters.

**Glyph size checks.** opentype.js expands a composite glyph by copying its components' points,
recursively, so a few hundred bytes of nested composites cost K^depth points (300 references three
levels deep ran V8 out of memory), and it parses a simple glyph in time proportional to points
times contours. `glyf.ts` therefore walks every TrueType glyph from the raw `glyf` and `loca` bytes
before opentype.js builds its path, memoised per glyph, and `font.glyph(char)` throws a `FontError`
(`malformed`, "The font's glyph for "X" could not be read: ...") for a glyph whose components nest
more than `MAX_COMPONENT_DEPTH` (8) deep, that expands to more than `MAX_GLYPH_POINTS` (100,000)
points and contours, or that would take more than `MAX_GLYPH_SCAN` (10 million) steps to parse
(point-by-contour checks, plus the points opentype.js copies appending each component: it
`concat`s every component onto the running total, so a 65,000-point glyph followed by a million
empty components took 32 s), as well as for a component cycle or a component glyph that does not exist. Refusing
beats dropping the glyph: text silently missing a letter would go unnoticed on a printed part, while
the error names the character. Inter Bold's largest glyph has 141 points and contours. Where "H" is
refused while the cap height is being measured, the cap height falls back to 0.7 em with a warning.
CFF outlines are not covered (see below).

`font.info` has what ADR 0011 decision 7 shows for a user font: `family` and `style` (typographic
names 16 and 17, else 1 and 2), `fullName`, `version` (name 5), `copyright` (name 0), `license` and
`licenseUrl` (names 13 and 14), `fsType` and its decoding `embedding` (`level`: `installable`,
`restricted`, `preview-and-print` or `editable`, the least restrictive winning when several bits
are set; `noSubsetting`, `bitmapOnly`, and `restrictive` for the warning), `outlines` (`truetype` or
`cff`), `variable`, `unitsPerEm` and `glyphCount`. `fontSha256(bytes)` gives the lower-case hex
SHA-256 documents record.

`font.capHeight` is OS/2 `sCapHeight`, else the top of "H", else 0.7 em; `font.lineHeight` is
ascender minus descender plus line gap, from the OS/2 typo metrics when the font sets
`USE_TYPO_METRICS`, else from `hhea`. `font.warnings` collects problems that did not stop loading.

### Kerning

opentype.js 2.0.0 cannot kern current fonts: it skips GPOS Extension (type 9) lookups, which is
where fonts built with current tools keep class kerning, and stops at the first class subtable that
covers the left glyph. It returns 0 for "AV" in Inter. `kerning.ts` reads pair kerning from the raw
GPOS bytes as the OpenType spec says: the `kern` feature of `latn` (else `DFLT`, else the first
script), default language; lookups in lookup-list order, each contributing its first subtable that
applies; PairPos formats 1 and 2, inside Extension lookups or not; the first glyph's x advance. It
matched HarfBuzz (uharfbuzz, kern on minus kern off) on all 11,881 pairs of printable ASCII and some
Latin-1 letters for Inter Bold (1,720 of them non-zero), checked on 2026-10-01; `font.test.ts` keeps
a sample. Reads are bounded to the table, so a damaged GPOS throws, and the font is then used without
kerning and with a warning. A font without GPOS kerning falls back to its legacy `kern` table.

A hostile GPOS can also make the work multiply with every read in bounds: a language system listing
one feature 65,535 times, a feature listing 65,535 lookup indexes, lookup records all pointing at
one lookup with thousands of subtables (a 163 KB table took 3.9 s to read before these limits).
Each feature is read once (by index and by offset), a lookup's subtables are kept once per offset,
and the reader stops with `KerningTooComplex` past `MAX_KERN_LOOKUP_INDEXES` (1,024) lookup indexes
or `MAX_KERN_SUBTABLES` (4,096) subtable records in all; the font is then used without kerning and
with a warning, as for a damaged table. Inter Bold has 3 kern lookups.

## Layout

`layoutText(font, text, options)` lays out one or more lines, left to right. One glyph per code
point through the font's cmap, kerning from the font, and nothing else: no ligatures, no other
substitutions, no shaping (opentype.js's `stringToGlyphs` throws on Inter's GSUB anyway). That suits
part labels and keeps a glyph's index in the text stable, which edge names are built from.

| Option          | Default    | Meaning                                                                   |
| --------------- | ---------- | ------------------------------------------------------------------------- |
| `size`          | required   | **cap height** in mm: the height of "H", what a ruler measures on a print |
| `align`         | `left`     | `left`, `center`, `right`: where each line's advance box sits at x = 0    |
| `verticalAlign` | `baseline` | `baseline`, `middle`, `top`: what of the block sits at y = 0              |
| `letterSpacing` | 0          | mm added between neighbouring glyphs of a line, after kerning             |
| `lineSpacing`   | 1          | baseline distance as a multiple of the font's line height                 |
| `kerning`       | `true`     | apply the font's kerning                                                  |

- **Size is the cap height**, not the em: a 6 mm label has 6 mm capitals in every font, and the
  printability numbers below are stated against it. Inter's em is 1.37 times its cap height.
- **Lines** split at `\n`, `\r\n` and `\r` and run downwards (sketch y is up), baselines
  `lineSpacing` times the line height apart.
- **Horizontal alignment** uses each line's advance width (glyph advances plus kerning plus letter
  spacing, not the ink): `left` starts at x = 0, `center` is centred on it, `right` ends at it.
- **Vertical alignment:** `baseline` puts the first line's baseline at y = 0; `top` puts the first
  line's cap height there; `middle` centres the span from the first line's cap height to the last
  line's baseline on it.

The result has `glyphs` (one per code point except line breaks, in text order: `index` in the text
counting line breaks, `line`, `char`, the font's `glyph` index, `origin` on the baseline, `advance`,
and `path` in millimetres, empty for a space or a missing glyph), `lines` (`text`, `width`, `x`,
`baseline`), `missing` (characters the font has no glyph for, each once; they take no space) and
`scale` (mm per font unit). Placing the anchor and turning by the entity's angle is the caller's
job (T3.2c).

## Untrusted fonts

Every check above bounds a cost this package could measure, but not all of them: a CFF font's
charstrings can call subroutines that call subroutines, and opentype.js follows the fan-out with no
limit of its own. So callers must run `loadFont`, `layoutText` and `outlineRegions` (from
`@manufakture/sketch`) for a user font **in a worker with a time limit, and terminate the worker when
the limit passes**, rather than wait for it. A timeout, or the worker dying out of memory, must reach
the user as "this font could not be read", the same as a `FontError`, and the font is not used. The
watchdog is part of the regen worker's font handling (T3.2c); this package assumes it. The limits
here keep every font that is merely damaged or oversized well inside it, with a clear message.

## Bundled font

| Id           | File                   | Font                                           | License        |
| ------------ | ---------------------- | ---------------------------------------------- | -------------- |
| `inter-bold` | `fonts/Inter-Bold.ttf` | Inter Bold 4.1 (`Version 4.001;git-9221beed3`) | OFL-1.1-no-RFN |

The file is `extras/ttf/Inter-Bold.ttf` from the `Inter-4.1.zip` release asset of
[rsms/inter](https://github.com/rsms/inter/releases/tag/v4.1) (zip SHA-256
`9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`), unmodified: 420,428 bytes,
SHA-256 `288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f`. `fonts/OFL.txt` is the
release's `LICENSE.txt`, verbatim (SHA-256
`262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`). Both ship in the app's notices.

The font is a separate asset, never imported as a module, inlined or base64-encoded into
JavaScript (ADR 0011, decision 1). `bundledFontUrl(id)` is a literal
`new URL('../fonts/Inter-Bold.ttf', import.meta.url)`, which bundlers emit as its own file (the
font is far above Vite's 4 KiB inlining limit), and a file URL in Node. `fetchBundledFont(id)`
fetches it and checks the bytes against the recorded SHA-256, so a damaged or substituted asset
fails rather than changing geometry. `INTER_BOLD` carries the id, names, version, size, SHA-256,
SPDX identifier and copyright line that documents record (T3.2c).

### Checks (ADR 0011, decision 3), 2026-10-01

Run on the file in this directory by `bundled.test.ts`, which repeats them on every test run.

- **License:** `OFL.txt` is the SIL OFL 1.1, copyright "Copyright (c) 2016 The Inter Project
  Authors (https://github.com/rsms/inter)", with no "Reserved Font Name" in its header. Name 0 is
  "Copyright 2016 The Inter Project Authors", name 13 the OFL 1.1 notice, name 14
  `http://scripts.sil.org/OFL`: they agree with it.
- **Static:** TrueType `glyf` outlines; no `fvar`, `gvar`, `CFF ` or `CFF2` table.
- **`fsType`** 0 (installable). **Version** `Version 4.001;git-9221beed3`. **SHA-256** above.
- **Overlaps:** Basic Latin and Latin-1 Supplement (with the degree, plus-minus and multiplication
  signs) are all present except U+00AD (soft hyphen, invisible) and U+2300 (diameter sign; write
  "Ø"). The check found overlapping contours, which ADR 0011 expected not to: five composite
  glyphs, `Ç`, `ç` (cedilla component), `Ð` (bar) and `Ø`, `ø` (slash), keep their components'
  contours overlapping or touching, as TrueType composites do. Every other glyph has disjoint
  contours. `outlineRegions` merges the five (Ø becomes one region with two holes), and the test
  feeds each merged result back in and checks that it needs no further merging and fills the same
  area. The fallback, Noto Sans Bold 2.015 (`notofonts/latin-greek-cyrillic`, OFL 1.1), has the same
  kind of overlaps (`Å`, `Ç`, `ç`) and lacks U+2300 too, so swapping fonts would not avoid them;
  Inter Bold is kept, and merging handles both (and user fonts). See ADR 0011's amendment.
- **Strokes,** in font units (cap height 1490, x-height 1118), measured across the outline:

  | Feature                                 | Units | At 4.2 mm cap height |
  | --------------------------------------- | ----- | -------------------- |
  | Stem of "H"                             | 305   | 0.86 mm              |
  | Stem of "l"                             | 300   | 0.85 mm              |
  | Crossbar of "H"                         | 253   | 0.71 mm              |
  | Crossbar of "e" (thinnest stroke found) | 188   | 0.53 mm              |
  | Counter of "e" (narrowest counter)      | 237   | 0.67 mm              |
  | Bowl counter of "a"                     | 281   | 0.79 mm              |

  **Recommended minimum text size: 4.2 mm cap height**, where the thinner stem (300 units) clears
  the minimum wall of 0.84 mm (two line widths at a 0.4 mm nozzle, an estimate from the M3 plan,
  T3.1c). Horizontal strokes are thinner: every stroke clears 0.84 mm only from 6.7 mm cap height.
  T3.2d puts the number into `docs/user/text.md`.

## Tests

`vitest run --project packages packages/text` runs everything in Node against the bundled font:
`font.test.ts` (names, embedding permissions, kerning against HarfBuzz values, every refusal, a
damaged GPOS, the cmap cap, random damage), `kerning.test.ts` (crafted GPOS tables whose work
multiplies, each refused or deduplicated in milliseconds), `glyf.test.ts` (hand-built fonts with
exponential composites, too-deep nesting, cycles, a glyph of 5,000 contours, the cap-height
fallback, a font without `post`), `layout.test.ts` ("O" is one region with a hole, "i"
two regions, the control points of "O" against fontTools' reading of the glyf table, cap-height
scaling, missing glyphs, advance widths, kerning, letter and line spacing, alignment) and
`bundled.test.ts` (the checks above).
