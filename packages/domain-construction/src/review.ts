// What changed in `domains.construction`, in lines a reviewer reads (ADR 0016 decision 11, M8
// plan T8.3a): the summariser the review bundle (`@manufakture/review`) calls for a
// `setDomainData` of this namespace. It takes the namespace's entry in the two documents
// (undefined when absent) and returns plain text lines; it never throws. Lists of named things
// (levels, wall, floor and roof types) are matched by id; header rules by position. Data that
// does not read is reported as such. The review package bounds the lines' number and length.

import type { DomainData, StoredExpression } from '@manufakture/core';
import type { Json } from '@manufakture/stock';
import {
  CONSTRUCTION_NAMESPACE,
  EMPTY_CONSTRUCTION_SETTINGS,
  readConstructionData,
  type StoredConstructionSettings,
} from './data';

/** The hook's shape: the namespace, and the lines describing a change of its data. */
export interface DomainDataSummariser {
  readonly namespace: string;
  summarise(before: DomainData | undefined, after: DomainData | undefined): string[];
}

const isExpression = (v: unknown): v is StoredExpression =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as StoredExpression).source === 'string' &&
  typeof (v as StoredExpression).lengthUnit === 'string';

/** A setting's value as a reviewer reads it: expressions as typed, lists and objects short. */
function valueText(v: unknown): string {
  if (v === undefined) return 'not set';
  if (isExpression(v)) {
    const s = v.source.trim();
    return /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s) ? `${s} ${v.lengthUnit}` : s;
  }
  if (Array.isArray(v)) {
    if (v.length <= 6 && v.every((x) => isExpression(x) || typeof x !== 'object')) {
      return `[${v.map(valueText).join(', ')}]`;
    }
    return `${v.length} items`;
  }
  if (typeof v === 'object' && v !== null) {
    const text = JSON.stringify(v);
    return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
  }
  return String(v);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Each key of two objects whose value differs, as "label key: before to after". */
function fieldLines(label: string, a: object, b: object): string[] {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  return keys
    .filter((k) => !same(x[k], y[k]))
    .map((k) => `${label} ${k}: ${valueText(x[k])} to ${valueText(y[k])}`);
}

interface Named {
  readonly id: string;
  readonly name?: string;
}

function listLines(what: string, a: readonly Named[], b: readonly Named[]): string[] {
  const lines: string[] = [];
  const was = new Map(a.map((item) => [item.id, item]));
  const now = new Map(b.map((item) => [item.id, item]));
  const label = (item: Named) => (item.name === undefined ? item.id : `"${item.name}"`);
  for (const item of b) {
    const old = was.get(item.id);
    if (old === undefined) lines.push(`Added ${what} ${label(item)}`);
    else if (!same(old, item)) {
      const changed = fieldLines('', old, item).map((l) => l.trim());
      lines.push(`Changed ${what} ${label(item)}: ${changed.join('; ')}`);
    }
  }
  for (const item of a) if (!now.has(item.id)) lines.push(`Removed ${what} ${label(item)}`);
  return lines;
}

function settingsLines(a: StoredConstructionSettings, b: StoredConstructionSettings): string[] {
  const lines = [
    ...listLines('level', a.levels, b.levels),
    ...listLines('wall type', a.wallTypes, b.wallTypes),
    ...listLines('floor type', a.floorTypes, b.floorTypes),
    ...listLines('roof type', a.roofTypes, b.roofTypes),
    ...fieldLines('Framing', a.framing, b.framing),
  ];
  const rules = Math.max(a.headerRules.length, b.headerRules.length);
  for (let i = 0; i < rules; i++) {
    const x = a.headerRules[i];
    const y = b.headerRules[i];
    if (same(x, y)) continue;
    const text = (r: typeof x) =>
      r === undefined
        ? 'none'
        : `up to ${valueText(r.maxWidth)}: ${r.header.plies} x ${r.header.stock} on ${r.header.jacks} jacks`;
    lines.push(`Header rule ${i + 1}: ${text(x)} to ${text(y)}`);
  }
  lines.push(...fieldLines('Takeoff', a.takeoff ?? {}, b.takeoff ?? {}));
  return lines;
}

function read(entry: DomainData | undefined): StoredConstructionSettings | string {
  if (entry === undefined) return EMPTY_CONSTRUCTION_SETTINGS;
  const r = readConstructionData(entry.data as Json, entry.schemaVersion);
  return r.ok ? r.value.stored : r.message;
}

/** `domains.construction`: levels, wall, floor and roof types, framing, header rules, takeoff. */
export const constructionDataSummariser: DomainDataSummariser = {
  namespace: CONSTRUCTION_NAMESPACE,
  summarise(before, after) {
    const a = read(before);
    const b = read(after);
    if (typeof b === 'string') return [`The construction settings do not read: ${b}`];
    if (typeof a === 'string') {
      return [`The construction settings were replaced (they did not read: ${a})`];
    }
    if (after === undefined) return ['The construction settings were removed'];
    const lines = settingsLines(a, b);
    return lines.length > 0 ? lines : ['The construction settings were rewritten without a change'];
  },
};
