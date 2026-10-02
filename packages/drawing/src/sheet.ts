// Sheet sizes and the drawing frame. Sizes are the published trimmed sizes: ISO 216 A series in
// millimetres, and ANSI/ASME Y14.1 (A to E) and architectural (Arch A to E1) in inches, converted
// exactly (25.4 mm per inch). Stored portrait (width <= height); `orientation` turns them.

import { MM_PER_INCH } from '@manufakture/units';

export type SheetSeries = 'iso' | 'ansi' | 'arch';

export type SheetSizeName =
  | 'A0'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'ANSI A'
  | 'ANSI B'
  | 'ANSI C'
  | 'ANSI D'
  | 'ANSI E'
  | 'Arch A'
  | 'Arch B'
  | 'Arch C'
  | 'Arch D'
  | 'Arch E'
  | 'Arch E1';

export interface SheetSize {
  readonly series: SheetSeries;
  /** Portrait width in millimetres (the short side). */
  readonly width: number;
  /** Portrait height in millimetres (the long side). */
  readonly height: number;
}

const inches = (series: SheetSeries, w: number, h: number): SheetSize => ({
  series,
  width: w * MM_PER_INCH,
  height: h * MM_PER_INCH,
});

export const SHEET_SIZES: Readonly<Record<SheetSizeName, SheetSize>> = {
  A0: { series: 'iso', width: 841, height: 1189 },
  A1: { series: 'iso', width: 594, height: 841 },
  A2: { series: 'iso', width: 420, height: 594 },
  A3: { series: 'iso', width: 297, height: 420 },
  A4: { series: 'iso', width: 210, height: 297 },
  'ANSI A': inches('ansi', 8.5, 11),
  'ANSI B': inches('ansi', 11, 17),
  'ANSI C': inches('ansi', 17, 22),
  'ANSI D': inches('ansi', 22, 34),
  'ANSI E': inches('ansi', 34, 44),
  'Arch A': inches('arch', 9, 12),
  'Arch B': inches('arch', 12, 18),
  'Arch C': inches('arch', 18, 24),
  'Arch D': inches('arch', 24, 36),
  'Arch E': inches('arch', 36, 48),
  'Arch E1': inches('arch', 30, 42),
};

export const SHEET_SIZE_NAMES = Object.keys(SHEET_SIZES) as SheetSizeName[];

/** Other names for sizes: US Letter is ANSI A, Tabloid (Ledger turned) is ANSI B. */
export type SheetSizeAlias = 'Letter' | 'letter' | 'Tabloid' | 'tabloid';

export const SHEET_SIZE_ALIASES: Readonly<Record<SheetSizeAlias, SheetSizeName>> = {
  Letter: 'ANSI A',
  letter: 'ANSI A',
  Tabloid: 'ANSI B',
  tabloid: 'ANSI B',
};

export type Orientation = 'landscape' | 'portrait';

export interface Margins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface SheetInput {
  /**
   * A named size or an alias (`Letter`, `Tabloid`), or a custom one in millimetres (taken as
   * given, then turned by `orientation`). A custom width or height that is not a positive
   * finite number throws a `RangeError`.
   */
  readonly size:
    SheetSizeName | SheetSizeAlias | { readonly width: number; readonly height: number };
  /** Default `'landscape'`. */
  readonly orientation?: Orientation;
  /** From the paper edge to the frame, millimetres. Default: see `defaultMargins`. */
  readonly margins?: Partial<Margins>;
}

export interface SheetGeometry {
  readonly width: number;
  readonly height: number;
  /** The frame (border) rectangle, paper millimetres, origin at the paper's bottom left. */
  readonly frame: {
    readonly min: readonly [number, number];
    readonly max: readonly [number, number];
  };
}

export function isSheetSizeName(name: string): name is SheetSizeName {
  return Object.hasOwn(SHEET_SIZES, name);
}

/** The size a name or alias stands for (`'letter'` is `'ANSI A'`); undefined for neither. */
export function resolveSheetSizeName(name: string): SheetSizeName | undefined {
  if (isSheetSizeName(name)) return name;
  return Object.hasOwn(SHEET_SIZE_ALIASES, name)
    ? SHEET_SIZE_ALIASES[name as SheetSizeAlias]
    : undefined;
}

/** A sheet input's size in millimetres, portrait or as given, with its series for named sizes. */
function baseSize(size: SheetInput['size']): {
  width: number;
  height: number;
  series?: SheetSeries;
} {
  if (typeof size !== 'string') {
    if (!(size.width > 0 && size.height > 0 && Number.isFinite(size.width + size.height)))
      throw new RangeError(
        `a custom sheet size needs a positive width and height, not ${size.width} x ${size.height}`,
      );
    return size;
  }
  return SHEET_SIZES[resolveSheetSizeName(size)!];
}

/**
 * Default frame margins. ISO: 20 mm on the left (the filing margin) and 10 mm elsewhere, which
 * is how ISO 5457 is usually summarised (the standard was not read; unverified). ANSI and Arch:
 * 1/2" all round, our choice. Custom sizes: 10 mm all round, our choice.
 */
export function defaultMargins(size: SheetInput['size']): Margins {
  const series = baseSize(size).series;
  if (series) {
    if (series === 'iso') return { left: 20, right: 10, top: 10, bottom: 10 };
    const m = MM_PER_INCH / 2;
    return { left: m, right: m, top: m, bottom: m };
  }
  return { left: 10, right: 10, top: 10, bottom: 10 };
}

/** Paper size (after orientation) and the frame rectangle, in millimetres. */
export function sheetGeometry(sheet: SheetInput): SheetGeometry {
  const base = baseSize(sheet.size);
  const short = Math.min(base.width, base.height);
  const long = Math.max(base.width, base.height);
  const landscape = (sheet.orientation ?? 'landscape') === 'landscape';
  const width = landscape ? long : short;
  const height = landscape ? short : long;
  const m = { ...defaultMargins(sheet.size), ...sheet.margins };
  return {
    width,
    height,
    frame: { min: [m.left, m.bottom], max: [width - m.right, height - m.top] },
  };
}
