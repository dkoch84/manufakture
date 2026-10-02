// "Use in document" (T5.1d): a library tool copied into a document's `cam.tools`, its numbers as
// expressions in the tool's own unit (`0.25in`, `100in/min`, `18950rpm`), so nothing is rounded,
// with `source` naming the library and the tool. The shapes below are core's `CamTool` and
// `CamFeedPreset` written out, since this package may not load core (ADR 0014 decision 1); the app
// passes the result to `addCamTool`, whose schema checks it.

import type { Tool } from '../types';
import { toMm } from './feeds';
import type { LibraryTool, LibraryUnit } from './types';

/** Core's `StoredExpression`, for the units a library writes. */
export interface ToolExpression {
  readonly source: string;
  readonly lengthUnit: LibraryUnit;
  readonly angleUnit: 'deg';
}

/** Core's `CamFeedPreset`. */
export interface CamFeedPresetData {
  readonly material: string;
  readonly spindle: ToolExpression;
  readonly feed: ToolExpression;
  readonly plunge: ToolExpression;
  readonly stepdown: ToolExpression;
  readonly stepover: ToolExpression;
}

/** Core's `CamTool`. */
export interface CamToolData {
  readonly id: string;
  readonly name: string;
  readonly kind: LibraryTool['kind'];
  readonly number?: number;
  readonly diameter: ToolExpression;
  readonly fluteLength: ToolExpression;
  readonly flutes: number;
  readonly cornerRadius?: ToolExpression;
  readonly angle?: ToolExpression;
  readonly tipDiameter?: ToolExpression;
  readonly presets: CamFeedPresetData[];
  readonly source?: { readonly library: string; readonly id: string };
}

/** A number as expression text: shortest round-trip form, never an exponent. */
function num(v: number): string {
  const s = String(v);
  return /e/i.test(s) ? v.toFixed(12).replace(/\.?0+$/, '') : s;
}

/**
 * `tool` as a document tool with id `id` (a fresh `tool#n` from the document's counter), copied
 * from library `library`. The vendor's catalogue number becomes the tool number.
 */
export function libraryToolToCamTool(tool: LibraryTool, id: string, library: string): CamToolData {
  const unit = tool.unit;
  const expr = (source: string): ToolExpression => ({ source, lengthUnit: unit, angleUnit: 'deg' });
  const length = (v: number) => expr(`${num(v)}${unit}`);
  return {
    id,
    name: tool.name,
    kind: tool.kind,
    ...(tool.vendor ? { number: tool.vendor.number } : {}),
    diameter: length(tool.diameter),
    fluteLength: length(tool.fluteLength),
    flutes: tool.flutes,
    ...(tool.cornerRadius === undefined ? {} : { cornerRadius: length(tool.cornerRadius) }),
    ...(tool.angleDeg === undefined ? {} : { angle: expr(`${num(tool.angleDeg)}deg`) }),
    ...(tool.tipDiameter === undefined ? {} : { tipDiameter: length(tool.tipDiameter) }),
    presets: tool.presets.map((p) => {
      const pe = (source: string): ToolExpression => ({
        source,
        lengthUnit: p.unit,
        angleUnit: 'deg',
      });
      return {
        material: p.category,
        spindle: pe(`${num(p.rpm)}rpm`),
        feed: pe(`${num(p.feed)}${p.unit}/min`),
        plunge: pe(`${num(p.plunge)}${p.unit}/min`),
        stepdown: pe(`${num(p.stepdown)}${p.unit}`),
        stepover: pe(num(p.stepover)),
      };
    }),
    source: { library, id: tool.id },
  };
}

/** `tool` as an evaluated tool in internal units (mm, radians), with document id `id`. */
export function libraryToolToTool(tool: LibraryTool, id: string): Tool {
  const mm = (v: number) => toMm(v, tool.unit);
  return {
    id,
    name: tool.name,
    kind: tool.kind,
    ...(tool.vendor ? { number: tool.vendor.number } : {}),
    diameter: mm(tool.diameter),
    fluteLength: mm(tool.fluteLength),
    flutes: tool.flutes,
    ...(tool.cornerRadius === undefined ? {} : { cornerRadius: mm(tool.cornerRadius) }),
    ...(tool.angleDeg === undefined ? {} : { angle: (tool.angleDeg * Math.PI) / 180 }),
    ...(tool.tipDiameter === undefined ? {} : { tipDiameter: mm(tool.tipDiameter) }),
  };
}
