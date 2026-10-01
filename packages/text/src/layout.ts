// Text layout: a string, a loaded font and a size to glyph outlines as paths
// in sketch coordinates (millimetres, y up), ready for `outlineRegions` in
// `@manufakture/sketch`.
//
// The model is deliberately simple and fully predictable: one glyph per code
// point through the font's cmap, kerning from the font's GPOS (or legacy kern)
// table, no ligatures, no other substitutions and no shaping, left to right.
// That suits part labels, and it keeps a glyph's index in the text stable,
// which T3.2c's edge ids are built from.
//
// - **Size is the cap height:** the height of a capital "H" in millimetres,
//   what a ruler measures on a printed label (the font's OS/2 cap height).
// - **Lines** are split at line breaks (`\n`, `\r\n`, `\r`) and run downwards;
//   baselines are `lineSpacing` times the font's line height apart.
// - **Horizontal alignment** places each line's advance width (glyph advances
//   plus kerning plus letter spacing, not ink) at the anchor: `left` starts at
//   x = 0, `center` is centred on it, `right` ends at it.
// - **Vertical alignment:** `baseline` puts the first line's baseline at y = 0;
//   `top` puts the first line's cap height there; `middle` centres the span from
//   the first line's cap height to the last line's baseline on it.
// - **Letter spacing** (millimetres) is added between neighbouring glyphs of a
//   line, after kerning.

import type { PathCommand, Vec2 } from '@manufakture/sketch/geometry';
import type { Glyph, PathCommand as FontCommand } from 'opentype.js';
import { FontError, type LoadedFont } from './font';

export interface TextLayoutOptions {
  /** Cap height in millimetres. */
  size: number;
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'baseline' | 'middle' | 'top';
  /** Extra space between neighbouring glyphs, in millimetres. Default 0. */
  letterSpacing?: number;
  /** Baseline distance as a multiple of the font's line height. Default 1. */
  lineSpacing?: number;
  /** Kerning from the font. Default on. */
  kerning?: boolean;
}

export interface LaidOutGlyph {
  /** The glyph's code point position in the text (line breaks counted), from 0. */
  index: number;
  /** The line, from 0. */
  line: number;
  /** The character (one code point). */
  char: string;
  /** The font's glyph index, 0 when the font has no glyph for the character. */
  glyph: number;
  /** Where the glyph's origin sits on its baseline, in millimetres. */
  origin: Vec2;
  /** Advance width in millimetres, kerning and letter spacing not included. */
  advance: number;
  /** The outline in sketch coordinates; empty for a space or a missing glyph. */
  path: PathCommand[];
}

export interface TextLine {
  text: string;
  /** Advance width: glyph advances plus kerning plus letter spacing, in millimetres. */
  width: number;
  /** Left end of the line's advance box. */
  x: number;
  /** The line's baseline. */
  baseline: number;
}

export interface TextLayout {
  /** One per code point except line breaks, in text order. */
  glyphs: LaidOutGlyph[];
  lines: TextLine[];
  /** Characters the font has no glyph for (each once, in text order); they take no space. */
  missing: string[];
  /** Millimetres per font unit. */
  scale: number;
}

const LINE_BREAK = /(\r\n|\r|\n)/;

function toPath(
  commands: readonly FontCommand[],
  scale: number,
  x: number,
  y: number,
): PathCommand[] {
  const at = (px: number, py: number): Vec2 => [x + px * scale, y + py * scale];
  const out: PathCommand[] = [];
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        out.push({ kind: 'moveTo', to: at(c.x, c.y) });
        break;
      case 'L':
        out.push({ kind: 'lineTo', to: at(c.x, c.y) });
        break;
      case 'Q':
        out.push({ kind: 'quadTo', control: at(c.x1, c.y1), to: at(c.x, c.y) });
        break;
      case 'C':
        out.push({
          kind: 'cubicTo',
          control1: at(c.x1, c.y1),
          control2: at(c.x2, c.y2),
          to: at(c.x, c.y),
        });
        break;
      case 'Z':
        out.push({ kind: 'close' });
        break;
    }
  }
  return out;
}

/** Lays out `text` in `font`; see the module comment for the rules. */
export function layoutText(font: LoadedFont, text: string, options: TextLayoutOptions): TextLayout {
  const { size } = options;
  if (!(Number.isFinite(size) && size > 0)) {
    throw new RangeError(`Text size must be a positive number of millimetres, not ${size}.`);
  }
  const letterSpacing = options.letterSpacing ?? 0;
  const lineSpacing = options.lineSpacing ?? 1;
  if (!Number.isFinite(letterSpacing))
    throw new RangeError('Letter spacing must be a finite number.');
  if (!(Number.isFinite(lineSpacing) && lineSpacing >= 0)) {
    throw new RangeError('Line spacing must be zero or a positive number.');
  }
  const kerning = options.kerning ?? true;
  const scale = size / font.capHeight;
  const lineAdvance = font.lineHeight * scale * lineSpacing;
  const cap = font.capHeight * scale;

  // Lines at even positions, the line breaks between them at odd ones.
  const parts = text.split(LINE_BREAK);
  const texts = parts.filter((_, i) => i % 2 === 0);
  const lastBaseline = -(texts.length - 1) * lineAdvance;
  const verticalAlign = options.verticalAlign ?? 'baseline';
  const shiftY =
    verticalAlign === 'top' ? -cap : verticalAlign === 'middle' ? -(cap + lastBaseline) / 2 : 0;

  const glyphs: LaidOutGlyph[] = [];
  const lines: TextLine[] = [];
  const missing = new Set<string>();
  let index = 0;
  texts.forEach((lineText, line) => {
    const baseline = shiftY - line * lineAdvance;
    // Pen positions in font units first, then the line is aligned.
    const placed: { char: string; glyph: Glyph | null; pen: number; index: number }[] = [];
    let pen = 0;
    let previous: number | null = null;
    for (const char of lineText) {
      const g = font.glyph(char);
      if (!g) missing.add(char);
      if (g && previous !== null) {
        if (kerning) pen += font.kerning(previous, g.index) * scale;
        pen += letterSpacing;
      }
      placed.push({ char, glyph: g, pen, index: index++ });
      if (g) {
        pen += (g.advanceWidth ?? 0) * scale;
        previous = g.index;
      }
    }
    index += parts[2 * line + 1]?.length ?? 0; // the line break
    const width = pen;
    const align = options.align ?? 'left';
    const x = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
    lines.push({ text: lineText, width, x, baseline });
    for (const p of placed) {
      const origin: Vec2 = [x + p.pen, baseline];
      let path: PathCommand[] = [];
      if (p.glyph) {
        try {
          path = toPath(p.glyph.path.commands, scale, origin[0], origin[1]);
        } catch (error) {
          throw new FontError('malformed', `The font's glyph for "${p.char}" could not be read.`, {
            cause: error,
          });
        }
      }
      glyphs.push({
        index: p.index,
        line,
        char: p.char,
        glyph: p.glyph?.index ?? 0,
        origin,
        advance: (p.glyph?.advanceWidth ?? 0) * scale,
        path,
      });
    }
  });
  return { glyphs, lines, missing: [...missing], scale };
}
