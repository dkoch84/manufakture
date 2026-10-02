// Drawings to files: a `packages/drawing` display list mapped onto the shared 2D sheet
// (`path2.ts`), then written by the SVG, DXF and PDF writers. Paper millimetres, y up, in both,
// so the mapping only renames: arcs get a signed sweep, polylines become paths of lines, and
// hatches are expanded to their lines (`hatchLines`), which every format draws the same way.

import {
  LAYER_NAMES,
  hatchLines,
  sweep,
  type DisplayItem,
  type DisplayList,
  type LayerStyle,
  type LineType,
} from '@manufakture/drawing';
import { writeDxf } from './dxf';
import { line, polylinePath, type Item2, type Layer2, type Sheet2 } from './path2';
import { writePdf, type PdfWriteOptions } from './pdf';
import { writeSvg, type SvgWriteOptions } from './svg';

/** DXF linetype names per drawing line type (the names AutoCAD's `acad.lin` uses). */
export const DRAWING_LINETYPES: Readonly<Record<LineType, string | undefined>> = {
  continuous: undefined,
  dashed: 'HIDDEN',
  chain: 'CENTER',
};

export interface DrawingSheetOptions {
  /** File title (SVG `<title>`, PDF `/Title`). */
  readonly title?: string;
  /** Hatch flattening tolerance, paper millimetres (default 0.05). */
  readonly hatchTolerance?: number;
}

/** The display list as a `Sheet2`: its paper size, its layers in order, every item. */
export function displayListToSheet(list: DisplayList, options: DrawingSheetOptions = {}): Sheet2 {
  const names = [
    ...LAYER_NAMES.filter((name) => name in list.layers),
    ...Object.keys(list.layers).filter(
      (name) => !(LAYER_NAMES as readonly string[]).includes(name),
    ),
  ];
  const layers: Layer2[] = names.map((name) =>
    layerOf(name, list.layers[name as keyof typeof list.layers]),
  );
  const items: Item2[] = [];
  for (const item of list.items) {
    const mapped = itemOf(item, options.hatchTolerance ?? 0.05);
    if (mapped) items.push(mapped);
  }
  return {
    size: { width: list.width, height: list.height },
    layers,
    items,
    ...(options.title !== undefined ? { title: options.title } : {}),
  };
}

function layerOf(name: string, style: LayerStyle): Layer2 {
  const lineType = DRAWING_LINETYPES[style.lineType];
  return {
    name,
    weight: style.weight,
    dash: style.dash,
    ...(lineType ? { lineType } : {}),
  };
}

function itemOf(item: DisplayItem, hatchTolerance: number): Item2 | undefined {
  const owner = item.owner !== undefined ? { owner: item.owner } : {};
  switch (item.kind) {
    case 'line':
      return { kind: 'path', layer: item.layer, segments: [line(item.a, item.b)], ...owner };
    case 'arc':
      return {
        kind: 'path',
        layer: item.layer,
        segments: [
          {
            kind: 'arc',
            center: item.center,
            radius: item.radius,
            start: item.start,
            end: item.start + sweep(item.start, item.end),
          },
        ],
        ...owner,
      };
    case 'ellipseArc':
      return {
        kind: 'path',
        layer: item.layer,
        segments: [
          {
            kind: 'ellipseArc',
            center: item.center,
            major: item.major,
            minor: item.minor,
            rotation: item.rotation,
            start: item.start,
            end: item.start + sweep(item.start, item.end),
          },
        ],
        ...owner,
      };
    case 'polyline':
      return polylinePath(item.layer, item.points, {
        ...(item.closed ? { closed: true } : {}),
        ...(item.fill ? { fill: true } : {}),
        ...owner,
      });
    case 'text':
      return {
        kind: 'text',
        layer: item.layer,
        at: item.at,
        text: item.text,
        height: item.height,
        rotation: item.rotation,
        anchor: item.anchor,
        baseline: item.baseline,
        ...owner,
      };
    case 'hatch': {
      const segments = hatchLines(item, hatchTolerance).map(([a, b]) => line(a, b));
      return segments.length ? { kind: 'path', layer: item.layer, segments, ...owner } : undefined;
    }
  }
}

/** A drawing sheet as SVG text. */
export function drawingToSvg(
  list: DisplayList,
  options: DrawingSheetOptions & SvgWriteOptions = {},
): string {
  return writeSvg(displayListToSheet(list, options), options);
}

/** A drawing sheet as DXF text. */
export function drawingToDxf(list: DisplayList, options: DrawingSheetOptions = {}): string {
  return writeDxf(displayListToSheet(list, options));
}

/** Drawing sheets as one PDF, a page per sheet. */
export function drawingToPdf(
  lists: DisplayList | readonly DisplayList[],
  options: DrawingSheetOptions & PdfWriteOptions = {},
): Uint8Array<ArrayBuffer> {
  const all: readonly DisplayList[] = Array.isArray(lists) ? lists : [lists as DisplayList];
  return writePdf(
    all.map((l) => displayListToSheet(l, options)),
    options,
  );
}
