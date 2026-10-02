// The layout settings form (M4 plan T4.3d): the saw kerf, the trims and the stage limit of sheet
// layouts and the grain rule, stored in `domains.wood` (`@manufakture/domain-wood`'s
// `wood-data.ts`) by one `setDomainData`, so one undo step. Lengths are constants (`1/8"`,
// `3mm`), like every domain setting. The sheet trim is one value for all four edges and the
// lumber trim one for both ends; an empty field takes the default. A document may store a
// different trim per edge (or end): the field then shows the first one, and saving keeps the
// stored trims as they are unless that field was changed (`trimNotes` says so in the panel).

import {
  bareUnits,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import {
  WOOD_NAMESPACE,
  constantLength,
  readWoodData,
  writeWoodData,
  type GrainRule,
  type Json,
  type StoredWoodSettings,
} from '@manufakture/domain-wood';

export interface SettingsForm {
  kerf: string;
  sheetTrim: string;
  lumberTrim: string;
  /** `unlimited` or a whole number of stages. */
  maxStages: string;
  grain: GrainRule;
}

/** The stored settings, or why they cannot be read. */
function storedSettings(
  doc: ManufaktureDocument,
): { ok: true; stored: StoredWoodSettings } | { ok: false; message: string } {
  const entry = doc.domains?.[WOOD_NAMESPACE];
  if (entry === undefined) return { ok: true, stored: {} };
  const r = readWoodData(entry.data as Json, entry.schemaVersion);
  return r.ok ? { ok: true, stored: r.value.stored } : { ok: false, message: r.message };
}

/** The form for the document's settings: what it stores, empty where it takes the default. */
export function settingsForm(doc: ManufaktureDocument): SettingsForm {
  const r = storedSettings(doc);
  const s = r.ok ? r.stored : {};
  return {
    kerf: s.kerf?.source ?? '',
    sheetTrim: s.sheetTrims?.lengthStart?.source ?? '',
    lumberTrim: s.lumberTrims?.start?.source ?? '',
    maxStages: String(s.maxStages ?? 'unlimited'),
    grain: s.grain ?? 'respect',
  };
}

const SHEET_EDGES = [
  ['lengthStart', 'length start'],
  ['lengthEnd', 'length end'],
  ['widthStart', 'width start'],
  ['widthEnd', 'width end'],
] as const;

const LUMBER_ENDS = [
  ['start', 'start'],
  ['end', 'end'],
] as const;

/** `length start 1/4", width end default`, or null when every edge stores the same trim. */
function differingTrims(
  stored: Partial<Record<string, StoredExpression>> | undefined,
  edges: readonly (readonly [string, string])[],
): string | null {
  const sources = edges.map(([key]) => stored?.[key]?.source ?? '');
  if (sources.every((v) => v === sources[0])) return null;
  return edges.map(([, name], i) => `${name} ${sources[i] || 'default'}`).join(', ');
}

/**
 * Notes for the panel when the document stores different trims per sheet edge or lumber end,
 * which the single fields cannot show.
 */
export function trimNotes(doc: ManufaktureDocument): string[] {
  const r = storedSettings(doc);
  if (!r.ok) return [];
  const notes: string[] = [];
  const sheet = differingTrims(r.stored.sheetTrims, SHEET_EDGES);
  if (sheet !== null) {
    notes.push(
      `The sheet edges have different trims (${sheet}). The field shows the length start trim; ` +
        'they are kept as they are unless you change it, which sets all four edges.',
    );
  }
  const lumber = differingTrims(r.stored.lumberTrims, LUMBER_ENDS);
  if (lumber !== null) {
    notes.push(
      `The lumber ends have different trims (${lumber}). The field shows the start trim; ` +
        'they are kept as they are unless you change it, which sets both ends.',
    );
  }
  return notes;
}

export type SettingsBuild =
  | { ok: true; command: Command | null; label: string }
  | { ok: false; errors: Partial<Record<keyof SettingsForm, string>>; message?: string };

/**
 * The command that stores the form (or removes `domains.wood` when the form sets nothing), or
 * null when nothing changes. Refused when the stored settings cannot be read, since saving
 * would rewrite them.
 */
export function settingsCommand(
  doc: ManufaktureDocument,
  form: SettingsForm,
  units: DisplayUnits,
): SettingsBuild {
  const current = storedSettings(doc);
  if (!current.ok) {
    return {
      ok: false,
      errors: {},
      message: `The woodworking settings cannot be read, so they are kept as they are: ${current.message}`,
    };
  }
  const errors: Partial<Record<keyof SettingsForm, string>> = {};
  const length = (field: keyof SettingsForm, source: string): StoredExpression | undefined => {
    const text = source.trim();
    if (text === '') return undefined;
    const e: StoredExpression = { source: text, ...bareUnits(units) };
    const r = constantLength(e, [field]);
    if (!r.ok) {
      errors[field] = r.message;
      return undefined;
    }
    return e;
  };
  const stored: StoredWoodSettings = {};
  const kerf = length('kerf', form.kerf);
  if (kerf) stored.kerf = kerf;
  // A trim field that still shows what the document stores keeps the stored trims, which may
  // differ per edge; only a changed field sets every edge.
  const loaded = settingsForm(doc);
  const old = current.stored;
  if (form.sheetTrim.trim() === loaded.sheetTrim) {
    if (old.sheetTrims !== undefined) stored.sheetTrims = old.sheetTrims;
  } else {
    const sheet = length('sheetTrim', form.sheetTrim);
    if (sheet) {
      stored.sheetTrims = {
        lengthStart: sheet,
        lengthEnd: sheet,
        widthStart: sheet,
        widthEnd: sheet,
      };
    }
  }
  if (form.lumberTrim.trim() === loaded.lumberTrim) {
    if (old.lumberTrims !== undefined) stored.lumberTrims = old.lumberTrims;
  } else {
    const lumber = length('lumberTrim', form.lumberTrim);
    if (lumber) stored.lumberTrims = { start: lumber, end: lumber };
  }
  if (form.maxStages !== 'unlimited') {
    const n = Number(form.maxStages);
    if (!Number.isSafeInteger(n) || n < 1) errors.maxStages = 'A whole number of stages from 1.';
    else stored.maxStages = n;
  }
  if (form.grain === 'ignore') stored.grain = 'ignore';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const label = 'Change cut list settings';
  const next = writeWoodData(stored);
  const before = doc.domains?.[WOOD_NAMESPACE];
  const same =
    next === undefined
      ? before === undefined
      : before !== undefined && JSON.stringify(before) === JSON.stringify(next);
  if (same) return { ok: true, command: null, label };
  const command: Command =
    next === undefined
      ? { type: 'setDomainData', namespace: WOOD_NAMESPACE }
      : {
          type: 'setDomainData',
          namespace: WOOD_NAMESPACE,
          schemaVersion: next.schemaVersion,
          data: next.data,
        };
  return { ok: true, command, label };
}
