// SVG from a `Sheet2`: width and height in millimetres with a millimetre `viewBox`, one group
// per layer carrying its stroke style, paths with line and elliptical arc commands, text in the
// standard fonts' family names. Coordinates are flipped once (SVG's y runs down) and written
// directly, with no transform, so a reader gets the geometry back by flipping y.

import { HELVETICA_CAP_HEIGHT } from './helvetica';
import {
  baselinePoint,
  connectedRuns,
  formatNumber,
  isFullTurn,
  itemsByLayer,
  layerDash,
  pageOf,
  segmentPoint,
  signedSweep,
  type Layer2,
  type Path2,
  type Segment2,
  type Sheet2,
  type Text2,
  type Vec2,
} from './path2';

export interface SvgWriteOptions {
  /** CSS font family list for text (default Helvetica, then Arial, then any sans-serif). */
  readonly fontFamily?: string;
}

export const SVG_FONT_FAMILY = 'Helvetica, Arial, sans-serif';

const n = (v: number): string => formatNumber(v);

/** An SVG document (UTF-8 text) of the sheet. */
export function writeSvg(sheet: Sheet2, options: SvgWriteOptions = {}): string {
  const page = pageOf(sheet);
  const flip = (p: Vec2): Vec2 => [p[0] - page.origin[0], page.height - (p[1] - page.origin[1])];
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(page.width)}mm" height="${n(page.height)}mm" viewBox="0 0 ${n(page.width)} ${n(page.height)}">`,
  ];
  if (sheet.title) out.push(`<title>${escapeXml(sheet.title)}</title>`);
  const font = escapeXml(options.fontFamily ?? SVG_FONT_FAMILY);
  for (const { layer, items } of itemsByLayer(sheet)) {
    if (!items.length) continue;
    out.push(`<g ${layerAttributes(layer)}>`);
    for (const item of items) {
      if (item.kind === 'path') {
        const d = pathData(item, flip);
        if (d)
          out.push(
            `<path${ownerAttr(item.owner)} d="${d}"${item.fill ? ` fill="${color(layer)}"` : ''}/>`,
          );
      } else out.push(textElement(item, flip, layer, font));
    }
    out.push('</g>');
  }
  out.push('</svg>', '');
  return out.join('\n');
}

/** The layer's `#rrggbb`, lower case; anything else (or none) is black. */
const color = (layer: Layer2): string =>
  layer.color !== undefined && /^#[0-9a-f]{6}$/i.test(layer.color)
    ? layer.color.toLowerCase()
    : '#000000';

function layerAttributes(layer: Layer2): string {
  const pattern = layerDash(layer);
  const dash = pattern.length ? pattern : undefined;
  const attrs = [
    `id="${escapeXml(layerId(layer.name))}"`,
    `data-layer="${escapeXml(layer.name)}"`,
    'fill="none"',
    `stroke="${color(layer)}"`,
    `stroke-width="${n(layer.weight ?? 0.25)}"`,
    // Round caps lengthen dashes by the line width; dashed layers keep butt caps.
    `stroke-linecap="${dash ? 'butt' : 'round'}"`,
    'stroke-linejoin="round"',
  ];
  if (dash) attrs.push(`stroke-dasharray="${dash.map(n).join(' ')}"`);
  return attrs.join(' ');
}

/** `layer-<name>`, with anything outside XML name characters replaced by `_`. */
export function layerId(name: string): string {
  return `layer-${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

const ownerAttr = (owner?: string): string =>
  owner === undefined ? '' : ` data-owner="${escapeXml(owner)}"`;

/** Path data in page coordinates (y down). Exported for the app's canvas and tests. */
export function pathData(
  path: Pick<Path2, 'segments' | 'closed'>,
  flip: (p: Vec2) => Vec2,
): string {
  const parts: string[] = [];
  const runs = connectedRuns(path.segments);
  for (const run of runs) {
    const s = flip(segmentPoint(run[0]!, 'start'));
    parts.push(`M${n(s[0])} ${n(s[1])}`);
    for (const seg of run) parts.push(...segmentCommands(seg, flip));
  }
  if (path.closed && runs.length) {
    if (runs.length === 1) parts.push('Z');
    else {
      const s = flip(segmentPoint(runs[0]![0]!, 'start'));
      parts.push(`L${n(s[0])} ${n(s[1])}`);
    }
  }
  return parts.join(' ');
}

function segmentCommands(seg: Segment2, flip: (p: Vec2) => Vec2): string[] {
  if (seg.kind === 'line') {
    const b = flip(seg.b);
    return [`L${n(b[0])} ${n(b[1])}`];
  }
  const sweep = signedSweep(seg);
  // A full turn has no single arc command (its endpoints coincide): two halves.
  const pieces = isFullTurn(seg) ? 2 : 1;
  const [rx, ry, rot] =
    seg.kind === 'arc' ? [seg.radius, seg.radius, 0] : [seg.major, seg.minor, seg.rotation];
  // y flips, so the rotation turns the other way and a counter-clockwise sweep (sweep-flag 0
  // in y-down terms) stays counter-clockwise on the page.
  const rotation = rot === 0 ? 0 : -((rot * 180) / Math.PI);
  const out: string[] = [];
  for (let i = 1; i <= pieces; i++) {
    const piece = (sweep / pieces) * i;
    const step = sweep / pieces;
    const end = flip(segmentPoint({ ...seg, end: seg.start + piece } as Segment2, 'end'));
    const large = Math.abs(step) > Math.PI + 1e-12 ? 1 : 0;
    const sweepFlag = step > 0 ? 0 : 1;
    out.push(`A${n(rx)} ${n(ry)} ${n(rotation)} ${large} ${sweepFlag} ${n(end[0])} ${n(end[1])}`);
  }
  return out;
}

function textElement(t: Text2, flip: (p: Vec2) => Vec2, layer: Layer2, font: string): string {
  const p = flip(baselinePoint(t));
  const attrs = [
    `x="${n(p[0])}"`,
    `y="${n(p[1])}"`,
    `font-family="${font}"`,
    `font-size="${n(t.height / HELVETICA_CAP_HEIGHT)}"`,
    `fill="${color(layer)}"`,
    'stroke="none"',
  ];
  if (t.anchor !== 'start') attrs.push(`text-anchor="${t.anchor}"`);
  const deg = (t.rotation * 180) / Math.PI;
  if (Math.abs(deg % 360) > 1e-9)
    attrs.push(`transform="rotate(${n(-deg)} ${n(p[0])} ${n(p[1])})"`);
  if (/^\s|\s$|\s\s/.test(t.text)) attrs.push('xml:space="preserve"');
  return `<text${ownerAttr(t.owner)} ${attrs.join(' ')}>${escapeXml(t.text)}</text>`;
}

/** Escaped for XML text and attributes; characters XML 1.0 cannot hold are dropped. */
export function escapeXml(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
