// `domains.wood`: the woodworking settings of a document (ADR 0013 decision 3): the saw kerf, the
// trims, the stage limit of sheet layouts and the grain rule. Plain settings, read by the cut list
// and the layouts (T4.3a, T4.3d), never by a board translator, so changing them rebuilds no body.
//
// Stored shape, version 1 (every field optional; absent fields take `DEFAULT_WOOD_SETTINGS`):
//
//   {
//     kerf?: StoredExpression,
//     sheetTrims?: { lengthStart?, lengthEnd?, widthStart?, widthEnd?: StoredExpression },
//     lumberTrims?: { start?, end?: StoredExpression },
//     maxStages?: number (an integer from 1) | 'unlimited',
//     grain?: 'respect' | 'ignore'
//   }
//
// The names follow `@manufakture/nesting`'s `SheetSettings` and `StickSettings`, which these feed.

import type { StoredExpression } from '@manufakture/core';
import { currentVersion, migrate, type Json, type Versioned } from './migrations';
import {
  fail,
  isObject,
  ok,
  onlyKeys,
  own,
  readConstantLength,
  readEnum,
  type Path,
  type Read,
} from './read';

export const WOOD_NAMESPACE = 'wood';

/**
 * Whether grained parts must run along a sheet's grain (`respect`), or may turn to save
 * material (`ignore`). Sheets without grain (MDF) let every part turn either way.
 */
export type GrainRule = 'respect' | 'ignore';

export interface SheetTrimSettings {
  lengthStart: number;
  lengthEnd: number;
  widthStart: number;
  widthEnd: number;
}

/** The settings, evaluated: lengths in millimetres. */
export interface WoodSettings {
  kerf: number;
  sheetTrims: SheetTrimSettings;
  lumberTrims: { start: number; end: number };
  maxStages: number | 'unlimited';
  grain: GrainRule;
}

/** The settings as stored: only what the document sets. */
export interface StoredWoodSettings {
  kerf?: StoredExpression;
  sheetTrims?: Partial<Record<keyof SheetTrimSettings, StoredExpression>>;
  lumberTrims?: Partial<Record<'start' | 'end', StoredExpression>>;
  maxStages?: number | 'unlimited';
  grain?: GrainRule;
}

/** `domains.wood` as read. */
export interface WoodData {
  stored: StoredWoodSettings;
  settings: WoodSettings;
}

/**
 * What a document without `domains.wood` gets. The kerf is 1/8" (3.175 mm), the kerf of a
 * common full-kerf table saw blade (a typical value, not a standard; thin-kerf blades are about
 * 3/32"). No trims, no stage limit, grain respected.
 */
export const DEFAULT_WOOD_SETTINGS: Readonly<WoodSettings> = Object.freeze({
  kerf: 3.175,
  sheetTrims: Object.freeze({ lengthStart: 0, lengthEnd: 0, widthStart: 0, widthEnd: 0 }),
  lumberTrims: Object.freeze({ start: 0, end: 0 }),
  maxStages: 'unlimited',
  grain: 'respect',
});

/** The migrations of `domains.wood` data (none yet: version 1 is current). */
export const WOOD_DATA: Versioned = { what: 'woodworking settings', migrations: [] };
export const WOOD_DATA_VERSION = currentVersion(WOOD_DATA);

/** The most stages a layout setting may ask for; more is `unlimited` in practice. */
export const MAX_STAGES = 100;

const SHEET_TRIMS = ['lengthStart', 'lengthEnd', 'widthStart', 'widthEnd'] as const;
const LUMBER_TRIMS = ['start', 'end'] as const;

function readTrims<K extends string>(
  raw: unknown,
  keys: readonly K[],
  at: Path,
): Read<{ stored: Partial<Record<K, StoredExpression>>; value: Partial<Record<K, number>> }> {
  if (!isObject(raw)) return fail(`expected trims { ${keys.join(', ')} }`, at);
  const known = onlyKeys(raw, keys, at);
  if (!known.ok) return known;
  const stored: Partial<Record<K, StoredExpression>> = {};
  const value: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const v = own(raw, k);
    if (v === undefined) continue;
    const r = readConstantLength(v, [...at, k]);
    if (!r.ok) return r;
    stored[k] = r.value.expression;
    value[k] = r.value.value;
  }
  return ok({ stored, value });
}

function readCurrent(data: Json): Read<WoodData> {
  if (!isObject(data)) return fail('expected an object of woodworking settings');
  const keys = onlyKeys(data, ['kerf', 'sheetTrims', 'lumberTrims', 'maxStages', 'grain'], []);
  if (!keys.ok) return keys;
  const stored: StoredWoodSettings = {};
  const settings: WoodSettings = {
    ...DEFAULT_WOOD_SETTINGS,
    sheetTrims: { ...DEFAULT_WOOD_SETTINGS.sheetTrims },
    lumberTrims: { ...DEFAULT_WOOD_SETTINGS.lumberTrims },
  };
  const kerf = own(data, 'kerf');
  if (kerf !== undefined) {
    const r = readConstantLength(kerf, ['kerf']);
    if (!r.ok) return r;
    stored.kerf = r.value.expression;
    settings.kerf = r.value.value;
  }
  const sheetTrims = own(data, 'sheetTrims');
  if (sheetTrims !== undefined) {
    const r = readTrims(sheetTrims, SHEET_TRIMS, ['sheetTrims']);
    if (!r.ok) return r;
    stored.sheetTrims = r.value.stored;
    Object.assign(settings.sheetTrims, r.value.value);
  }
  const lumberTrims = own(data, 'lumberTrims');
  if (lumberTrims !== undefined) {
    const r = readTrims(lumberTrims, LUMBER_TRIMS, ['lumberTrims']);
    if (!r.ok) return r;
    stored.lumberTrims = r.value.stored;
    Object.assign(settings.lumberTrims, r.value.value);
  }
  const maxStages = own(data, 'maxStages');
  if (maxStages !== undefined) {
    if (
      maxStages !== 'unlimited' &&
      !(
        Number.isSafeInteger(maxStages) &&
        (maxStages as number) >= 1 &&
        (maxStages as number) <= MAX_STAGES
      )
    ) {
      return fail(`expected a whole number of stages from 1 to ${MAX_STAGES}, or "unlimited"`, [
        'maxStages',
      ]);
    }
    stored.maxStages = maxStages as number | 'unlimited';
    settings.maxStages = maxStages as number | 'unlimited';
  }
  const grain = own(data, 'grain');
  if (grain !== undefined) {
    const r = readEnum(grain, ['respect', 'ignore'] as const, ['grain']);
    if (!r.ok) return r;
    stored.grain = r.value;
    settings.grain = r.value;
  }
  return ok({ stored, settings });
}

/** Read `domains.wood` stored at `schemaVersion`: migrated in memory and validated. */
export function readWoodData(data: Json, schemaVersion: number): Read<WoodData> {
  const migrated = migrate(WOOD_DATA, data, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

/** The settings of a document: its `domains.wood` read, or the defaults when it has none. */
export function woodSettings(
  entry: { schemaVersion: number; data: Json } | undefined,
): Read<WoodSettings> {
  if (entry === undefined) {
    return ok({
      ...DEFAULT_WOOD_SETTINGS,
      sheetTrims: { ...DEFAULT_WOOD_SETTINGS.sheetTrims },
      lumberTrims: { ...DEFAULT_WOOD_SETTINGS.lumberTrims },
    });
  }
  const r = readWoodData(entry.data, entry.schemaVersion);
  return r.ok ? ok(r.value.settings) : r;
}

/**
 * The `domains.wood` entry to store for these settings, at the current version, or undefined when
 * they set nothing (the app then removes the namespace).
 */
export function writeWoodData(
  stored: StoredWoodSettings,
): { schemaVersion: number; data: Json } | undefined {
  const data: Record<string, Json> = {};
  if (stored.kerf !== undefined) data.kerf = { ...stored.kerf };
  for (const [key, trims] of [
    ['sheetTrims', stored.sheetTrims],
    ['lumberTrims', stored.lumberTrims],
  ] as const) {
    if (trims === undefined) continue;
    const out: Record<string, Json> = {};
    for (const k of Object.keys(trims).sort()) {
      const e = (trims as Record<string, StoredExpression | undefined>)[k];
      if (e !== undefined) out[k] = { ...e };
    }
    if (Object.keys(out).length > 0) data[key] = out;
  }
  if (stored.maxStages !== undefined) data.maxStages = stored.maxStages;
  if (stored.grain !== undefined) data.grain = stored.grain;
  if (Object.keys(data).length === 0) return undefined;
  return { schemaVersion: WOOD_DATA_VERSION, data };
}
