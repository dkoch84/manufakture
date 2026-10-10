// What changed in the mechanical domain, in lines a reviewer reads (ADR 0016 decision 11, ADR
// 0017 decision 2): two summarisers the review bundle (`@manufakture/review`) calls, one for the
// settings in `domains.mech` and one for core's typed `mech` section. Each takes the two sides
// (undefined when absent) and returns plain text lines, and never throws; the review package
// bounds the lines' number and length. Items are matched by id and named by name where they have
// one. The section's lines end with the domain's notice (decision 17). Nothing here calls a
// design safe, certified, compliant, passing or OK.

import {
  MECH_LISTS,
  type DomainData,
  type Electrical,
  type MechData,
  type MechList,
  type StoredExpression,
} from '@manufakture/core';
import { DISCLAIMER_SHORT } from './disclaimer';
import { MECH_NAMESPACE, readMechSettings, type MechSettings } from './settings';

/** The settings hook's shape: the namespace, and the lines describing a change of its data. */
export interface DomainDataSummariser {
  readonly namespace: string;
  summarise(before: DomainData | undefined, after: DomainData | undefined): string[];
}

/** The section hook's shape: the section's key, and the lines describing a change of it. */
export interface SectionSummariser {
  readonly section: string;
  summarise(before: unknown, after: unknown): string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isExpression = (v: unknown): v is StoredExpression =>
  typeof v === 'object' && v !== null && typeof (v as StoredExpression).source === 'string';

function valueText(v: unknown): string {
  if (v === undefined) return 'not set';
  if (isExpression(v)) return v.source.trim();
  if (typeof v === 'object' && v !== null) {
    const text = JSON.stringify(v);
    return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
  }
  return String(v);
}

/** The keys of two objects whose values differ, sorted. */
function changedKeys(a: object, b: object): string[] {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => !same(x[k], y[k]))
    .sort();
}

// Settings ---------------------------------------------------------------------------------------

const FACTOR_NAMES = { strength: 'Strength factor (on yield)', fatigue: 'Fatigue factor' } as const;

function settingsOf(entry: DomainData | undefined): MechSettings | string | undefined {
  if (entry === undefined) return undefined;
  const r = readMechSettings(entry.data, entry.schemaVersion);
  return r.ok ? r.value : r.message;
}

/** Lines for a change of `domains.mech`: the two factors first, then other settings by name. */
export const mechDataSummariser: DomainDataSummariser = {
  namespace: MECH_NAMESPACE,
  summarise(before, after) {
    const a = settingsOf(before);
    const b = settingsOf(after);
    const lines: string[] = [];
    if (a === undefined && b !== undefined) lines.push('Started the mechanical domain');
    if (b === undefined) return a === undefined ? [] : ['Removed the mechanical settings'];
    if (typeof b === 'string') return [...lines, `The mechanical settings do not read: ${b}`];
    const was = typeof a === 'object' ? a : undefined;
    const text = (v: number | undefined) => (v === undefined ? 'not set' : String(v));
    for (const key of ['strength', 'fatigue'] as const) {
      const x = was?.factors[key];
      const y = b.factors[key];
      // On start both factors are listed, set or not: no factor is ever filled in for the user.
      if (was === undefined) lines.push(`${FACTOR_NAMES[key]}: ${text(y)}`);
      else if (x !== y) lines.push(`${FACTOR_NAMES[key]}: ${text(x)} to ${text(y)}`);
    }
    if (!same(was?.factors.checks ?? {}, b.factors.checks ?? {})) {
      for (const k of changedKeys(was?.factors.checks ?? {}, b.factors.checks ?? {})) {
        lines.push(
          `Factor for ${k}: ${valueText(was?.factors.checks?.[k])} to ${valueText(b.factors.checks?.[k])}`,
        );
      }
    }
    if (was !== undefined) {
      const rest = (s: MechSettings) => ({ ...s, factors: undefined });
      for (const k of changedKeys(rest(was), rest(b))) {
        const x = (was as unknown as Record<string, unknown>)[k];
        const y = (b as unknown as Record<string, unknown>)[k];
        lines.push(`${k}: ${valueText(x)} to ${valueText(y)}`);
      }
    }
    return lines;
  },
};

// The section ------------------------------------------------------------------------------------

const WHAT: { readonly [K in MechList]: string } = {
  requirements: 'requirement',
  loadCases: 'load case',
  drivetrains: 'drivetrain',
  purchased: 'purchased part',
  catalog: 'catalog entry',
  schematics: 'schematic',
  symbols: 'symbol',
  studies: 'stress study',
  checks: 'check override',
  specNotes: 'specification note',
  hazards: 'hazard',
  testBands: 'test band',
};

interface Item {
  readonly id: string;
  readonly name?: string;
}

/** An item as a reviewer reads it: its name and id, or what identifies it. */
function label(list: MechList | 'electrical', item: Item): string {
  const x = item as unknown as Record<string, unknown>;
  if (typeof item.name === 'string') return `"${item.name}" (${item.id})`;
  if (list === 'catalog') return `${String(x.maker)} ${String(x.partNumber)} (${item.id})`;
  if (list === 'checks') return `${String(x.check)} (${item.id})`;
  if (list === 'specNotes') return `${String(x.spec)} ${String(x.field)} (${item.id})`;
  if (list === 'testBands') return `${String(x.test)} (${item.id})`;
  return item.id;
}

function listLines(
  list: MechList | 'electrical',
  what: string,
  a: readonly Item[],
  b: readonly Item[],
): string[] {
  const lines: string[] = [];
  const was = new Map(a.map((x) => [x.id, x]));
  const now = new Map(b.map((x) => [x.id, x]));
  for (const item of b) {
    const old = was.get(item.id);
    if (old === undefined) lines.push(`Added ${what} ${label(list, item)}`);
    else if (!same(old, item)) {
      lines.push(`Changed ${what} ${label(list, item)}: ${changedKeys(old, item).join(', ')}`);
    }
  }
  for (const item of a) if (!now.has(item.id)) lines.push(`Removed ${what} ${label(list, item)}`);
  return lines;
}

function electricalLines(a: Electrical | undefined, b: Electrical | undefined): string[] {
  const empty: Electrical = { components: [], connections: [], harness: [] };
  const x = a ?? empty;
  const y = b ?? empty;
  const lines: string[] = [];
  if (x.assembly !== y.assembly) {
    lines.push(
      `Electrical system assembly: ${x.assembly ?? 'not set'} to ${y.assembly ?? 'not set'}`,
    );
  }
  lines.push(...listLines('electrical', 'component', x.components, y.components));
  const conn = (c: Electrical['connections'][number]) => ({
    ...c,
    name: `${c.from.component}.${c.from.terminal} to ${c.to.component}.${c.to.terminal}`,
  });
  lines.push(
    ...listLines('electrical', 'connection', x.connections.map(conn), y.connections.map(conn)),
  );
  lines.push(...listLines('electrical', 'harness segment', x.harness, y.harness));
  return lines;
}

const asMech = (v: unknown): MechData | undefined =>
  typeof v === 'object' && v !== null ? (v as MechData) : undefined;

/**
 * Lines for a change of the `mech` section, list by list in section order, then the electrical
 * system, and the notice last when anything changed.
 */
export const mechSectionSummariser: SectionSummariser = {
  section: 'mech',
  summarise(before, after) {
    const a = asMech(before);
    const b = asMech(after);
    const lines: string[] = [];
    for (const list of MECH_LISTS) {
      const x = (a?.[list] ?? []) as readonly Item[];
      const y = (b?.[list] ?? []) as readonly Item[];
      if (!same(x, y)) lines.push(...listLines(list, WHAT[list], x, y));
    }
    if (!same(a?.electrical, b?.electrical))
      lines.push(...electricalLines(a?.electrical, b?.electrical));
    if (lines.length > 0) lines.push(DISCLAIMER_SHORT);
    return lines;
  },
};
