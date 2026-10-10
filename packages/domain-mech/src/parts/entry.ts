// A catalog entry from typed text fields (ADR 0017 decision 7): what the app's datasheet form and
// each row of a CSV import both give, keyed by the same names (`csv.ts` lists them). Every value
// goes through `@manufakture/units` (`input.ts`); the result is checked against core's schema and
// the family's fields, so an entry this returns is one `setCatalogEntry` accepts.

import {
  CATALOG_FAMILIES,
  CatalogEntrySchema,
  type CatalogEntry,
  type DisplayUnits,
  type Rated,
} from '@manufakture/core';
import { DIMENSION_NAMES, entryProblems, familySchema, type CatalogFamily } from './families';
import { readDimension, readMass, readRating } from './input';

/** The fields that are not a rating or a dimension. */
export const ENTRY_FIELDS = [
  'family',
  'maker',
  'partNumber',
  'description',
  'mass',
  'verified',
  'notes',
  'shape',
  'axis',
  'sourceTitle',
  'sourceUrl',
  'sourceRevision',
  'sourceRead',
] as const;
export type EntryField = (typeof ENTRY_FIELDS)[number];

/** The parts of a rating column: `<name>`, `<name>.convention`, `.basis`, `.estimated`. */
export type RatingPart = 'value' | 'convention' | 'basis' | 'estimated';

const RATING_NAMES = new Set(
  CATALOG_FAMILIES.flatMap((f) => familySchema(f).fields.map((x) => x.name)),
);

const YES = /^(?:yes|y|true|1)$/i;
const NO = /^(?:no|n|false|0)$/i;
/** http or https, nothing else: no `javascript:`, `data:` or `file:` link ever reaches a page. */
const WEB_URL = /^https?:\/\/[^\s]+$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** Why a field name is not one an entry reads, or undefined when it is. */
export function columnProblem(name: string): string | undefined {
  if ((ENTRY_FIELDS as readonly string[]).includes(name)) return undefined;
  if (name.startsWith('dim.')) {
    const d = name.slice(4);
    return (DIMENSION_NAMES as readonly string[]).includes(d)
      ? undefined
      : `no dimension "${d.slice(0, 64)}" (one of ${DIMENSION_NAMES.join(', ')})`;
  }
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\.(convention|basis|estimated))?$/.exec(name);
  if (m && RATING_NAMES.has(m[1]!)) return undefined;
  return `"${name.slice(0, 64)}" is not a column this import reads`;
}

export interface EntryProblem {
  column: string;
  message: string;
}

export type ReadEntryFields =
  { ok: true; entry: CatalogEntry } | { ok: false; problems: EntryProblem[] };

function codePoints(s: string): number {
  return [...s].length;
}

/**
 * A user entry (`id`, version 1) from text fields by name. Unknown names are refused; empty
 * fields are not given. Every problem is listed with the field it is in.
 */
export function readEntryFields(
  fields: Readonly<Record<string, string>>,
  id: string,
  units: DisplayUnits,
  extra: {
    version?: number;
    derivedFrom?: CatalogEntry['derivedFrom'];
    geometry?: CatalogEntry['geometry'];
  } = {},
): ReadEntryFields {
  const problems: EntryProblem[] = [];
  const at = (column: string, message: string) => problems.push({ column, message });
  const fixed: Partial<Record<EntryField, string>> = {};
  const dims: Record<string, string> = {};
  const ratings: Record<string, Partial<Record<RatingPart, string>>> = {};
  for (const [name, raw] of Object.entries(fields)) {
    const why = columnProblem(name);
    if (why !== undefined) {
      at(name.slice(0, 64), why);
      continue;
    }
    const v = raw.trim();
    if ((ENTRY_FIELDS as readonly string[]).includes(name)) fixed[name as EntryField] = v;
    else if (name.startsWith('dim.')) dims[name.slice(4)] = v;
    else {
      const [rating, part] = name.split('.') as [string, RatingPart | undefined];
      (ratings[rating] ??= {})[part ?? 'value'] = v;
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const familyText = fixed.family ?? '';
  if (!(CATALOG_FAMILIES as readonly string[]).includes(familyText)) {
    at(
      'family',
      `"${familyText.slice(0, 64)}" is not a family (one of ${CATALOG_FAMILIES.join(', ')})`,
    );
    return { ok: false, problems };
  }
  const family = familyText as CatalogFamily;
  const schema = familySchema(family);
  if ((fixed.maker ?? '') === '') at('maker', 'a maker is needed');
  if ((fixed.partNumber ?? '') === '') at('partNumber', 'a part number is needed');
  for (const name of ['maker', 'partNumber'] as const) {
    if (codePoints(fixed[name] ?? '') > 200) at(name, 'at most 200 characters');
  }
  if (codePoints(fixed.description ?? '') > 1000) at('description', 'at most 1000 characters');

  const rated: Record<string, Rated> = {};
  for (const [name, parts] of Object.entries(ratings)) {
    const field = schema.fields.find((f) => f.name === name);
    const given = Object.values(parts).some((v) => v !== undefined && v !== '');
    if (field === undefined) {
      if (given) at(name, `a ${family} has no rating "${name}"`);
      continue;
    }
    const r = readRating(field, parts.value ?? '', units);
    if (!r.ok) {
      at(name, `${field.label}: ${r.message}`);
      continue;
    }
    const convention = parts.convention ?? '';
    const basis = parts.basis ?? '';
    const estimated = parts.estimated ?? '';
    if (r.value === undefined) {
      if (given) at(name, `${field.label}: a convention, basis or estimate without a value`);
      continue;
    }
    let value = r.value;
    if ('value' in value) {
      if (convention !== '') {
        const match = field.conventions?.find((c) => c.toLowerCase() === convention.toLowerCase());
        if (match === undefined) {
          at(
            `${name}.convention`,
            field.conventions === undefined
              ? `${field.label} has no conventions`
              : `one of ${field.conventions.join(', ')}`,
          );
          continue;
        }
        value = { ...value, convention: match };
      }
      if (basis !== '') {
        if (codePoints(basis) > 1000) {
          at(`${name}.basis`, 'at most 1000 characters');
          continue;
        }
        value = { ...value, basis };
      }
      if (estimated !== '') {
        if (YES.test(estimated)) value = { ...value, estimated: true };
        else if (!NO.test(estimated)) {
          at(`${name}.estimated`, 'yes or no');
          continue;
        }
      }
    } else if (convention + basis + estimated !== '') {
      at(name, `${field.label}: a convention, basis or estimate goes with a number`);
      continue;
    }
    rated[name] = value;
  }

  const dimensions: Record<string, Rated> = {};
  for (const [name, text] of Object.entries(dims)) {
    if (text === '') continue;
    if (!schema.dimensions.some((d) => d.name === name)) {
      at(`dim.${name}`, `a ${family} has no dimension "${name}"`);
      continue;
    }
    const r = readDimension(text, units);
    if (!r.ok) at(`dim.${name}`, r.message);
    else if (r.value !== undefined) dimensions[name] = r.value;
  }

  const mass = readMass(fixed.mass ?? '', units);
  if (!mass.ok) at('mass', mass.message);

  const verifiedText = fixed.verified ?? '';
  if (verifiedText !== '' && !YES.test(verifiedText) && !NO.test(verifiedText)) {
    at('verified', 'yes or no');
  }
  const shape = fixed.shape ?? '';
  if (shape !== '' && !['cylinder', 'ring', 'box'].includes(shape)) {
    at('shape', 'cylinder, ring or box');
  }
  const axis = fixed.axis ?? '';
  if (axis !== '' && !['x', 'y', 'z'].includes(axis)) at('axis', 'x, y or z');
  if (axis !== '' && shape === '') at('axis', 'an axis goes with a shape');
  if (shape !== '' && extra.geometry !== undefined) at('shape', 'the entry has a STEP file');

  const title = fixed.sourceTitle ?? '';
  const url = fixed.sourceUrl ?? '';
  const revision = fixed.sourceRevision ?? '';
  const read = fixed.sourceRead ?? '';
  if (url !== '' && (!WEB_URL.test(url) || codePoints(url) > 2000)) {
    at('sourceUrl', 'an http or https address');
  }
  if (read !== '' && !DATE.test(read)) at('sourceRead', 'a date like 2026-10-10');
  if (title === '' && url + revision + read !== '') at('sourceTitle', 'a source needs a title');
  if (title !== '' && read === '') at('sourceRead', 'a source needs the date it was read');
  if (problems.length > 0) return { ok: false, problems };

  const entry: CatalogEntry = {
    id,
    version: extra.version ?? 1,
    family,
    fieldsVersion: schema.fieldsVersion,
    maker: fixed.maker!,
    partNumber: fixed.partNumber!,
    description: fixed.description ?? '',
    ratings: rated,
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    ...(mass.ok && mass.value !== undefined ? { mass: mass.value } : {}),
    ...(extra.geometry !== undefined
      ? { geometry: extra.geometry }
      : shape !== ''
        ? {
            geometry: {
              kind: 'placeholder' as const,
              shape: {
                kind: shape as 'cylinder' | 'ring' | 'box',
                ...(axis !== '' ? { axis: axis as 'x' | 'y' | 'z' } : {}),
              },
            },
          }
        : {}),
    sources:
      title === ''
        ? []
        : [
            {
              title,
              ...(url !== '' ? { url } : {}),
              ...(revision !== '' ? { revision } : {}),
              read,
            },
          ],
    verified: YES.test(verifiedText),
    ...(extra.derivedFrom !== undefined ? { derivedFrom: extra.derivedFrom } : {}),
    ...((fixed.notes ?? '') !== '' ? { notes: fixed.notes! } : {}),
  };
  const parsed = CatalogEntrySchema.safeParse(entry);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 5)) {
      at(issue.path.map(String).join('.') || 'entry', issue.message);
    }
    return { ok: false, problems };
  }
  for (const p of entryProblems(entry)) at(p.field, p.message);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, entry };
}

/**
 * An entry as text fields by name, the inverse of `readEntryFields` for the form to start from
 * (editing an entry, or copying a built-in one). Numbers are written in SI units with enough
 * digits to read back the same value.
 */
export function entryFields(
  entry: CatalogEntry | Omit<CatalogEntry, 'id'>,
): Record<string, string> {
  const schema = familySchema(entry.family);
  const out: Record<string, string> = {
    family: entry.family,
    maker: entry.maker,
    partNumber: entry.partNumber,
    description: entry.description,
    verified: entry.verified ? 'yes' : 'no',
  };
  if (entry.notes !== undefined) out.notes = entry.notes;
  if (entry.geometry?.kind === 'placeholder') {
    out.shape = entry.geometry.shape.kind;
    if (entry.geometry.shape.axis !== undefined) out.axis = entry.geometry.shape.axis;
  }
  const source = entry.sources[0];
  if (source !== undefined) {
    out.sourceTitle = source.title;
    if (source.url !== undefined) out.sourceUrl = source.url;
    if (source.revision !== undefined) out.sourceRevision = source.revision;
    out.sourceRead = source.read;
  }
  const num = (v: number) => String(v);
  if (entry.mass !== undefined) {
    out.mass =
      'unknown' in entry.mass
        ? 'unknown'
        : 'value' in entry.mass
          ? `${num(entry.mass.value)} kg`
          : '';
  }
  for (const [name, d] of Object.entries(entry.dimensions ?? {})) {
    out[`dim.${name}`] = 'unknown' in d ? 'unknown' : 'value' in d ? `${num(d.value)} mm` : '';
  }
  for (const [name, r] of Object.entries(entry.ratings)) {
    const field = schema.fields.find((f) => f.name === name);
    if ('unknown' in r) out[name] = 'unknown';
    else if ('text' in r) out[name] = r.text;
    else {
      out[name] =
        field === undefined ||
        field.kind === 'number' ||
        field.kind === 'count' ||
        field.kind === 'text'
          ? num(r.value)
          : field.kind === 'velocityConstant'
            ? `${num((r.value * 60) / (2 * Math.PI))} rpm/V`
            : `${num(r.value)} ${SI_UNIT[field.kind]}`;
      if (r.convention !== undefined) out[`${name}.convention`] = r.convention;
      if (r.basis !== undefined) out[`${name}.basis`] = r.basis;
      if (r.estimated === true) out[`${name}.estimated`] = 'yes';
    }
  }
  return out;
}

/** The SI unit of each physical kind as `@manufakture/units` reads it. */
const SI_UNIT: Readonly<Record<string, string>> = {
  mass: 'kg',
  force: 'N',
  torque: 'N*m',
  energy: 'J',
  speed: 'm/s',
  angularSpeed: 'rad/s',
  acceleration: 'm/s^2',
  power: 'W',
  voltage: 'V',
  current: 'A',
  resistance: 'ohm',
  inductance: 'H',
  charge: 'C',
  temperature: 'K',
  temperatureDelta: 'K',
  pressure: 'Pa',
  stiffness: 'N/m',
  rotationalStiffness: 'N*m/rad',
  inertia: 'kg*m^2',
  frequency: 'Hz',
  time: 's',
  torqueConstant: 'N*m/A',
  thermalResistance: 'K/W',
  heatCapacity: 'J/K',
  linearDensity: 'kg/m',
};
