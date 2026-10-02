# Text

Raised or sunk lettering on a part: a label, a size, a version number. Text is drawn in a [sketch](sketcher.md) with the **Text** tool and turned into solid letters with [Extrude](features.md): **Add** raises it (emboss), **Remove** sinks it (deboss). The text stays editable: change the string, the font or the size later and the letters follow.

## Putting text on a face

1. Select the flat face the text goes on (the top of a part, a side), then **New sketch**, **Selected face**.
2. Click **Text** in the sketch toolbar (or press **X**) and click where the text goes. That point is its **anchor**; with the default alignment the text is centred on it.
3. The **Text** panel opens in the side panel with the string `Text` selected: type your own. Set the font, the size and the alignment there (below).
4. **Finish sketch**, then select the sketch in the tree and click **Extrude**. Under **Regions**, pick **The text only**: every letter of every text in the sketch, in one click.
5. For a deboss, set **Result** to **Remove**, the depth (0.6 mm is a good start), and tick **Opposite direction** so the cut goes into the face. For an emboss, set **Result** to **Add** and leave the direction: the letters grow out of the face.

The whole sketch and the extrusion are each one step for **Undo**. A font the text needed (the built-in one the first time, or one you added) goes into the document with the sketch, in the same step.

## The Text panel

The panel shows while one text is selected in the sketch (click its letters or its anchor).

| Field              | What it does                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Text**           | The string. Enter starts a new line. At most 1000 characters per text.                                                                              |
| **Font**           | The built-in font, or one added to the document with **Add font...** (below).                                                                       |
| **Size**           | The **cap height**: how tall a capital "H" is, which is what a ruler measures on the print. An expression, so `#label_size` or `2*#t` work.         |
| **Horizontal**     | Where each line sits on the anchor: starting at it (**Left**), centred on it (**Centre**) or ending at it (**Right**).                              |
| **Vertical**       | What of the text sits on the anchor: the first line's baseline (**Baseline**), the middle of the block (**Middle**) or the capitals' top (**Top**). |
| **Letter spacing** | Extra space between neighbouring letters (a length; empty for none). The font's own kerning always applies.                                         |
| **Line spacing**   | The distance between lines, as a multiple of the font's line height (empty for 1).                                                                  |
| **Angle**          | Turns the text about its anchor, counter-clockwise.                                                                                                 |

Typing in one field is one undo step inside the sketch. A value that does not work (a size of 0, an unknown variable) is shown in red and not used until it is fixed. The panel also says when the font has no glyph for a character (it is left out) and when a font could not be read.

## Placing text exactly

The anchor behaves like a point of the sketch:

- **Drag** the text by its letters or its anchor.
- **Dimension** it like a point: with the **Dimension** tool click the text (or its anchor) and another point or line, for example the sketch origin or an edge you projected as a line.
- **Constraints** that take points work on a selected text: **Fix** pins it, **Coincident** puts the anchor on a point or a line, **Horizontal** and **Vertical** line it up with another point.
- Clicking with the Text tool on a point snaps the anchor to it.

The letters themselves are never constrained: the solver moves only the anchor, and the text is drawn from the font around it.

## Size for printing

On an FDM printer a letter's strokes must be at least as wide as the minimum wall, two line widths: 0.84 mm at a 0.4 mm nozzle (an estimate; see [Printing](printing.md)). For the built-in font that gives a **recommended minimum size of 4.2 mm cap height**: there the font's vertical stems (300 font units) are 0.85 mm wide. Its horizontal strokes are thinner (the crossbar of "e" is 188 units), and clear 0.84 mm only from **6.7 mm**. Below 4.2 mm the Text panel warns, and the print workspace's wall-thickness check marks the thin strokes on the part. Small embossed text prints best standing at least 0.6 mm proud; debossed text needs a little more room, since its counters (the inside of an "e") close up first.

## Fonts

**Inter Bold** is built in: the default for new text. It ships with the app, with its license (the SIL Open Font License). A document records which file its text was made with (its SHA-256), so if an update of the app ever ships a different version of the font, the part shows a warning instead of silently changing shape.

### Adding a font

**Add font...** in the Text panel takes a TrueType (`.ttf`) or OpenType (`.otf`) file of up to 20 MiB. Font collections (`.ttc`) and web fonts (`.woff`, `.woff2`) are refused: export the single font as `.ttf` or `.otf` first. A variable font is used at its default instance.

Before anything is added, the dialog shows what the font says about itself: family and style, version, copyright, license text and license URL, and its **embedding permissions** (the font's own `fsType` setting: installable, editable, preview and print, or restricted, and whether it allows subsetting). When the permissions are restrictive, it warns that storing the font in a document you share may not be allowed by its license. **Add font** then stores the file in the document, so the text looks the same wherever the document opens; adding the same file twice uses the copy already there.

A font file is read as untrusted data: only in a separate worker with a time limit, never on the page itself, and what it says is shown as plain text. A font that is damaged, or takes too long or too much memory to read, is refused with "This font could not be read", and the rest of the app keeps working.

Licenses are yours to honour. manufakture never sends a font anywhere on its own: it travels only inside your documents. Exports for printing and CAD (3MF, STL, STEP) hold geometry only, never font files.

## How text is laid out

- One glyph per character, with the font's kerning; no ligatures or other substitutions, so "fi" stays two letters.
- Characters the font lacks are left out, with a warning. The diameter sign U+2300 is not in Inter: write `Ø` (U+00D8) instead.
- Letters that touch or overlap after kerning are joined into one solid. Letters made of overlapping pieces (`Ø`, `Ç`) are merged first.
- Inter's capital `I` and small `l` are both plain bars; on a label where it matters, use another font.

## References to letters

The faces and edges of letters are named by their position in the text, so editing the string can move a name to another letter. A feature that picks a letter's face or edge (a fillet, a sketch on a letter) gets a warning that the reference is fragile; when the text changes, check it and pick the face again if it moved.

## Speed

Measured with the end-to-end test on a 40 x 30 x 10 mm block (a production build, software rendering):

- The first text of a session appears about 75 ms after the click: that starts the text worker and loads the font.
- After that, the sketcher lays text out again 120 ms after you stop typing, so typing a word asks for one layout, not one per key; a short label then takes a few milliseconds.
- Changing a variable a text's size uses regenerates the block with its debossed label in about 0.3 s.

Dragging a text moves the letters at once: only a change of the string, font, size, spacing or alignment needs a new layout.

## Known limits

- A text whose letters cross the edge of the face it is cut into can leave odd geometry: a dot in a letter's counter that falls outside the face cuts a hole of its own. Keep text inside its face.
- Two letters that touch at a single point make a solid that is not cleanly joined there; the part is not flagged. Add a little letter spacing.
- A user font that cannot be read is tried again for each text that uses it (it fails at once, but its file is sent each time).
- A text whose letters are made of an extreme number of curves (only a damaged or deliberately hostile font does this) is drawn in the sketch with its later letters simplified: as their control points, or as plain boxes. The letters are only drawn that way; the geometry is unchanged.
- A one-click **Text** button that sketches on the picked face and opens the extrusion in one step is not there yet: use **New sketch** and **Extrude** as above.
