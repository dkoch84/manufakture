// Tools in the document (M5 plan, T5.3a): the Tools dialog's editor for one `cam.tools` entry, free
// of React. Its sizes and feed presets are expressions (so `1/4"` is a diameter in a millimetre
// document), checked for kind and range here, since core checks neither: a zero or negative
// diameter, a corner radius past the tool's radius or a stepover outside (0, 1] never reaches
// `editCamTool`. A new tool made here (not copied from a library) has no `source`.

import {
  CAM_TOOL_COUNTER,
  CAM_TOOL_KINDS,
  MAX_CAM_FLUTES,
  MAX_CAM_TOOL_NUMBER,
  previewIds,
  type CamFeedPreset,
  type CamTool,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { findFeedCategory, unverifiedToolFields, type LibraryTool } from '@manufakture/cam/library';
import type { Variables } from '../sketcher/values';
import { checkField, storedOf, type Rule } from './values';
import type { FieldKind } from '../components/expression';

export type ToolKindId = (typeof CAM_TOOL_KINDS)[number];

export const TOOL_KIND_LABELS: Readonly<Record<ToolKindId, string>> = {
  flat: 'Flat end mill',
  ball: 'Ball end mill',
  bull: 'Bull nose end mill',
  vbit: 'V-bit',
  drill: 'Drill',
  engraver: 'Engraver',
};

export type PresetKey = 'spindle' | 'feed' | 'plunge' | 'stepdown' | 'stepover';
export const PRESET_KEYS: readonly PresetKey[] = [
  'spindle',
  'feed',
  'plunge',
  'stepdown',
  'stepover',
];

export const PRESET_SPECS: Readonly<
  Record<PresetKey, { kind: FieldKind; rule: Rule; label: string }>
> = {
  spindle: { kind: 'spindleSpeed', rule: 'positive', label: 'Spindle speed' },
  feed: { kind: 'feed', rule: 'positive', label: 'Feed' },
  plunge: { kind: 'feed', rule: 'positive', label: 'Plunge' },
  stepdown: { kind: 'length', rule: 'positive', label: 'Stepdown' },
  stepover: { kind: 'number', rule: 'fraction', label: 'Stepover (fraction)' },
};

export interface PresetForm {
  material: string;
  values: Record<PresetKey, string>;
}

export interface ToolForm {
  name: string;
  kind: ToolKindId;
  /** The tool number a post writes; empty for none. */
  number: string;
  diameter: string;
  fluteLength: string;
  flutes: string;
  cornerRadius: string;
  angle: string;
  tipDiameter: string;
  presets: PresetForm[];
}

export function toolFormOf(tool: CamTool): ToolForm {
  return {
    name: tool.name,
    kind: tool.kind,
    number: tool.number === undefined ? '' : String(tool.number),
    diameter: tool.diameter.source,
    fluteLength: tool.fluteLength.source,
    flutes: String(tool.flutes),
    cornerRadius: tool.cornerRadius?.source ?? '',
    angle: tool.angle?.source ?? '',
    tipDiameter: tool.tipDiameter?.source ?? '',
    presets: tool.presets.map((p) => ({
      material: p.material,
      values: {
        spindle: p.spindle.source,
        feed: p.feed.source,
        plunge: p.plunge.source,
        stepdown: p.stepdown.source,
        stepover: p.stepover.source,
      },
    })),
  };
}

/** Which size fields a kind has: `cornerRadius` a bull nose's, `angle` a V-bit's or a drill's. */
export function toolFields(kind: ToolKindId): ('cornerRadius' | 'angle' | 'tipDiameter')[] {
  if (kind === 'bull') return ['cornerRadius'];
  if (kind === 'vbit') return ['angle', 'tipDiameter'];
  if (kind === 'drill') return ['angle'];
  return [];
}

export type ToolBuild =
  { ok: true; command: Command; label: string } | { ok: false; errors: Record<string, string> };

/** Check the form and build `editCamTool` for `tool` (or `addCamTool` for a new one). */
export function buildTool(
  form: ToolForm,
  ctx: {
    doc: ManufaktureDocument;
    existing?: CamTool;
    units: DisplayUnits;
    variables: Variables;
  },
): ToolBuild {
  const { doc, existing, units, variables } = ctx;
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Give the tool a name.';

  let number: number | undefined;
  if (form.number.trim() !== '') {
    const n = Number(form.number.trim());
    if (!Number.isInteger(n) || n < 0 || n > MAX_CAM_TOOL_NUMBER) {
      errors.number = `A tool number is a whole number from 0 to ${MAX_CAM_TOOL_NUMBER}.`;
    } else number = n;
  }
  const flutes = Number(form.flutes.trim());
  if (!Number.isInteger(flutes) || flutes < 1 || flutes > MAX_CAM_FLUTES) {
    errors.flutes = `Flutes is a whole number from 1 to ${MAX_CAM_FLUTES}.`;
  }

  const value = (
    key: 'diameter' | 'fluteLength' | 'cornerRadius' | 'angle' | 'tipDiameter',
    kind: FieldKind,
    rule: Rule,
    optional: boolean,
  ): { stored?: StoredExpression; value?: number } => {
    const r = checkField(form[key], kind, rule, units, variables, optional);
    if (!r.ok) {
      errors[key] = r.message;
      return {};
    }
    if (r.empty) return {};
    return { stored: storedOf(form[key], units, existing?.[key]), value: r.value };
  };
  const diameter = value('diameter', 'length', 'positive', false);
  const fluteLength = value('fluteLength', 'length', 'positive', false);
  const fields = toolFields(form.kind);
  const corner = fields.includes('cornerRadius')
    ? value('cornerRadius', 'length', 'positive', false)
    : {};
  const angle = fields.includes('angle')
    ? value('angle', 'angle', 'any', form.kind === 'drill')
    : {};
  const tip = fields.includes('tipDiameter')
    ? value('tipDiameter', 'length', 'nonNegative', true)
    : {};
  if (angle.value !== undefined && !(angle.value > 0 && angle.value < Math.PI)) {
    errors.angle = 'The angle must be greater than 0 and less than 180 degrees.';
  }
  if (diameter.value !== undefined) {
    if (corner.value !== undefined && corner.value > diameter.value / 2) {
      errors.cornerRadius = 'The corner radius must be at most half the diameter.';
    }
    if (tip.value !== undefined && tip.value >= diameter.value) {
      errors.tipDiameter = 'The tip must be smaller than the diameter.';
    }
  }

  const presets: CamFeedPreset[] = [];
  const seen = new Set<string>();
  form.presets.forEach((p, i) => {
    if (seen.has(p.material)) errors[`presets.${i}.material`] = `Two presets for ${p.material}.`;
    seen.add(p.material);
    const out: Partial<Record<PresetKey, StoredExpression>> = {};
    for (const key of PRESET_KEYS) {
      const s = PRESET_SPECS[key];
      const r = checkField(p.values[key], s.kind, s.rule, units, variables);
      if (!r.ok) errors[`presets.${i}.${key}`] = r.message;
      else {
        const before = existing?.presets.find((x) => x.material === p.material)?.[key];
        out[key] = storedOf(p.values[key], units, before);
      }
    }
    if (PRESET_KEYS.every((k) => out[k])) {
      presets.push({ material: p.material, ...(out as Record<PresetKey, StoredExpression>) });
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const id = existing?.id ?? previewIds(doc.cam.nextIds, CAM_TOOL_COUNTER)[0]!;
  const tool: CamTool = {
    id,
    name,
    kind: form.kind,
    ...(number !== undefined ? { number } : {}),
    diameter: diameter.stored!,
    fluteLength: fluteLength.stored!,
    flutes,
    ...(corner.stored ? { cornerRadius: corner.stored } : {}),
    ...(angle.stored ? { angle: angle.stored } : {}),
    ...(tip.stored ? { tipDiameter: tip.stored } : {}),
    presets,
    ...(existing?.source ? { source: existing.source } : {}),
  };
  return existing
    ? { ok: true, command: { type: 'editCamTool', tool }, label: `Edit tool ${name}` }
    : { ok: true, command: { type: 'addCamTool', tool }, label: `Add tool ${name}` };
}

/** A blank tool's form: a 6 mm, two-flute flat end mill with no presets. */
export function newToolForm(): ToolForm {
  return {
    name: 'Flat end mill',
    kind: 'flat',
    number: '',
    diameter: '6 mm',
    fluteLength: '20 mm',
    flutes: '2',
    cornerRadius: '',
    angle: '',
    tipDiameter: '',
    presets: [],
  };
}

/** Readable names of the unverified fields of a library tool. */
export function unverifiedText(tool: LibraryTool): string | null {
  const fields = unverifiedToolFields(tool);
  if (fields.length === 0) return null;
  const parts = fields.map((f) => {
    if (f === 'geometry') return 'sizes';
    const [, category, what] = f.split('.');
    const name = findFeedCategory(category ?? '')?.name ?? category;
    return `${name} ${what === 'feeds' ? 'speeds and feeds' : what}`;
  });
  return `Not checked against the source: ${parts.join(', ')}.`;
}

/**
 * A tool's title in a list: its number before its name ("#5 Facing mill"), unless the name already
 * starts with that number, as the built-in Carbide 3D tools' names do ("#201 1/4" flat end mill").
 */
export function numberedName(number: number | undefined, name: string): string {
  if (number === undefined) return name;
  const tag = `#${number}`;
  return name === tag || name.startsWith(`${tag} `) ? name : `${tag} ${name}`;
}
