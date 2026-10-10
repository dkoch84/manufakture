// The built-in catalog and how a reference finds its entry (ADR 0017 decision 7). Built-in entries
// are versioned data: a published version is never edited, a correction is a new version, and every
// version ever shipped stays in `BUILTIN_ENTRIES`, so a document's numbers never change under it.
// An entry is never removed; a withdrawn one is marked `deprecated` with a reason.
//
// This task ships a few sample entries with typical published values from T9.0c's research, all
// `verified: false`; the per-family catalogs are T9.2b to T9.2e (`src/catalog/`), added below.
// Nothing here claims a part is current or that a design using it is safe.

import {
  BUILTIN_ENTRY_ID_PATTERN,
  mechItems,
  type CatalogEntry,
  type CatalogRef,
  type ManufaktureDocument,
} from '@manufakture/core';
import { FAMILY_CATALOG_ENTRIES } from '../catalog';
import { migrateEntry } from './families';

/** A built-in entry: a catalog entry whose id is `<family>/<slug>`, perhaps withdrawn. */
export type BuiltinEntry = Omit<CatalogEntry, 'id' | 'derivedFrom'> & {
  id: string;
  /** Why the entry was withdrawn; absent while it is offered. */
  deprecated?: string;
};

const READ = '2026-10-10';
const kn = (v: number) => v * 1000;
const rpm = (v: number) => (v * 2 * Math.PI) / 60;

/** Every built-in entry, every version (sorted by id, then version). */
export const BUILTIN_ENTRIES: readonly BuiltinEntry[] = byIdThenVersion([
  {
    id: 'bearing/skf-6001-2rsh',
    version: 1,
    family: 'bearing',
    fieldsVersion: 1,
    maker: 'SKF',
    partNumber: '6001-2RSH',
    description: 'Deep groove ball bearing, 12 x 28 x 8 mm, contact seals both sides',
    ratings: {
      type: { text: 'deep groove ball' },
      dynamicLoad: { value: kn(5.4) },
      staticLoad: { value: kn(2.36) },
      fatigueLimit: { value: kn(0.1) },
      limitingSpeed: { value: rpm(17000) },
      closure: { text: 'contact seal' },
    },
    dimensions: {
      innerDiameter: { value: 12 },
      outerDiameter: { value: 28 },
      width: { value: 8 },
    },
    mass: { unknown: true },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: 'MRO Supply, SKF 6001-2RSH (a search summary, not the maker)',
        url: 'https://www.mrosupply.com/bearings/319810_6001-2rsh_skf-bearing/',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'From a secondary source. The limiting speed seems high for a contact seal; check it against the maker before relying on it.',
  },
  {
    id: 'bearing/skf-6005-2rsh',
    version: 1,
    family: 'bearing',
    fieldsVersion: 1,
    maker: 'SKF',
    partNumber: '6005-2RSH',
    description: 'Deep groove ball bearing, 25 x 47 x 12 mm, contact seals both sides',
    ratings: {
      type: { text: 'deep groove ball' },
      dynamicLoad: { value: kn(11.9) },
      staticLoad: { value: kn(6.6) },
      fatigueLimit: { value: kn(0.275) },
      limitingSpeed: { value: rpm(9500) },
      closure: { text: 'contact seal' },
    },
    dimensions: {
      innerDiameter: { value: 25 },
      outerDiameter: { value: 47 },
      width: { value: 12 },
    },
    mass: { value: 0.0806 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: 'bearingsize.info catalogue, SKF 6005-2RSH',
        url: 'https://bearingsize.info/catalogue-online/deep-groove-ball-bearings/bearing-6005-2rsh-skf-obj32488.html',
        read: READ,
      },
    ],
    verified: false,
  },
  {
    id: 'belt/gates-5mgt-15',
    version: 1,
    family: 'belt',
    fieldsVersion: 1,
    maker: 'Gates',
    partNumber: '5MGT, 15 mm wide (long-length belting)',
    description: 'PowerGrip GT3 timing belt, 5 mm pitch, 15 mm wide',
    ratings: {
      profile: { text: '5MGT' },
      ratedWorkingTension: {
        value: 614,
        basis: '18 grooves on the smaller pulley (934 N at 45); table 6 of the design manual',
      },
      breakingStrength: { value: kn(5.85) },
      minimumPulleyGrooves: { value: 18 },
    },
    dimensions: { pitch: { value: 5 }, width: { value: 15 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'Gates, Light Power and Precision Drive Design Manual, table 6',
        url: 'https://www.gates.com/content/dam/documents-library/catalogs/light-power-and-precision-manual.pdf',
        read: READ,
      },
    ],
    verified: false,
    notes: 'Converted from pounds. Rate drives with at least 6 teeth in mesh.',
  },
  ...FAMILY_CATALOG_ENTRIES,
]);

function byIdThenVersion(list: BuiltinEntry[]): BuiltinEntry[] {
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
}

for (const e of BUILTIN_ENTRIES) {
  if (!BUILTIN_ENTRY_ID_PATTERN.test(e.id) || !e.id.startsWith(`${e.family}/`)) {
    throw new Error(`built-in entry id "${e.id}" is not "<family>/<slug>"`);
  }
}

/** A built-in entry at one version, or undefined when this build has no such entry or version. */
export function findBuiltin(id: string, version: number): BuiltinEntry | undefined {
  return BUILTIN_ENTRIES.find((e) => e.id === id && e.version === version);
}

/** The newest version of a built-in entry this build has. */
export function latestBuiltin(id: string): BuiltinEntry | undefined {
  let best: BuiltinEntry | undefined;
  for (const e of BUILTIN_ENTRIES) {
    if (e.id === id && (best === undefined || e.version > best.version)) best = e;
  }
  return best;
}

/** The newest version of every built-in entry, deprecated ones included. */
export function latestBuiltins(): BuiltinEntry[] {
  const ids = [...new Set(BUILTIN_ENTRIES.map((e) => e.id))];
  return ids.map((id) => latestBuiltin(id)!);
}

/** A reference to a built-in entry's newest version. */
export function builtinRef(id: string): CatalogRef | undefined {
  const e = latestBuiltin(id);
  return e === undefined ? undefined : { source: 'builtin', id: e.id, version: e.version };
}

/** What a reference resolved to: the entry (fields migrated in memory), or why not. */
export type ResolvedEntry =
  | {
      ok: true;
      entry: CatalogEntry | BuiltinEntry;
      /** A newer built-in version this build has (decision 7: "a newer revision exists"). */
      newer?: number;
      /** Why a built-in entry was withdrawn. */
      deprecated?: string;
    }
  | {
      ok: false;
      reason: 'unknown-entry' | 'newer-fields';
      message: string;
    };

/** A reference as text, for messages: `bearing/skf-6001-2rsh v1`, `entry#3`. */
export function refText(ref: CatalogRef): string {
  return ref.source === 'builtin' ? `${ref.id} v${ref.version}` : ref.id;
}

/**
 * The entry a reference names: a built-in one at its pinned version, or one of the document's
 * `mech.catalog`. A reference this build cannot resolve (a document from a newer build, a deleted
 * user entry) is refused with the reason, never guessed at.
 */
export function resolveEntry(doc: ManufaktureDocument, ref: CatalogRef): ResolvedEntry {
  let found: CatalogEntry | BuiltinEntry | undefined;
  let newer: number | undefined;
  let deprecated: string | undefined;
  if (ref.source === 'builtin') {
    found = findBuiltin(ref.id, ref.version);
    const latest = latestBuiltin(ref.id);
    if (found !== undefined && latest !== undefined && latest.version > ref.version) {
      newer = latest.version;
    }
    deprecated = (found as BuiltinEntry | undefined)?.deprecated;
  } else {
    found = mechItems(doc.mech, 'catalog').find((e) => e.id === ref.id);
  }
  if (found === undefined) {
    return {
      ok: false,
      reason: 'unknown-entry',
      message:
        ref.source === 'builtin'
          ? `this build has no catalog entry ${refText(ref)}`
          : `the document has no catalog entry ${ref.id}`,
    };
  }
  const migrated = migrateEntry(found as CatalogEntry);
  if (!migrated.ok) return migrated;
  const entry =
    migrated.entry === found
      ? found
      : ({ ...found, ...migrated.entry, id: found.id } as typeof found);
  return {
    ok: true,
    entry,
    ...(newer !== undefined ? { newer } : {}),
    ...(deprecated !== undefined ? { deprecated } : {}),
  };
}

/** A copy of a built-in entry as a user entry with a fresh id, remembering where it came from. */
export function copyBuiltin(entry: BuiltinEntry, id: string): CatalogEntry {
  const { id: builtinId, ...rest } = entry;
  delete rest.deprecated;
  return {
    ...structuredClone(rest),
    id,
    version: 1,
    derivedFrom: { source: 'builtin', id: builtinId, version: entry.version },
  };
}
