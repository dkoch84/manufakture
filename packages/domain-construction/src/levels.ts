// Levels (ADR 0015 decision 2): named elevations a wall, floor or roof stands on. A level is
// `{ id, name, elevation, height }`, where `height` is the default wall height on it. Both lengths
// are `StoredExpression`s that must be constants (`8'`, `2.4m`): domain data holds settings, not
// model (ADR 0013 decision 3), so one that names a variable is refused with the same message as a
// stock override's. Variables reach construction geometry through the features' own expressions
// (a wall's height), not through levels. A level is not a part studio.

import type { StoredExpression } from '@manufakture/core';
import {
  fail,
  isObject,
  ok,
  onlyKeys,
  own,
  readConstantLength,
  type Path,
  type Read,
} from '@manufakture/stock';

/** A level with its lengths as `L`: `StoredExpression` as stored, `number` (mm) as evaluated. */
export interface Level<L = number> {
  /** Permanent within the document; walls, floors and roofs name it. */
  readonly id: string;
  readonly name: string;
  /** Height of the level's datum above the document's, mm; may be negative (a basement). */
  readonly elevation: L;
  /** The default wall height on the level, mm; above zero. */
  readonly height: L;
}

export type StoredLevel = Level<StoredExpression>;

/** The most levels one document may hold. */
export const MAX_LEVELS = 100;

/** Ids of levels, types and layers: lower case, digits and hyphens, at most 64 characters. */
export const DATA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A data id (`level-1`, `ext-2x6`), checked against `DATA_ID_PATTERN`. */
export function readDataId(v: unknown, at: Path): Read<string> {
  if (typeof v !== 'string' || !DATA_ID_PATTERN.test(v)) {
    return fail('expected an id of lower-case letters, digits and hyphens (at most 64)', at);
  }
  return ok(v);
}

/** A display name: a non-empty string of at most 200 characters. */
export function readName(v: unknown, at: Path): Read<string> {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 200) {
    return fail('expected a name (1 to 200 characters)', at);
  }
  return ok(v);
}

/** One stored level, checked: ids and names, and both lengths constant. */
export function readLevel(v: unknown, at: Path): Read<StoredLevel> {
  if (!isObject(v)) return fail('expected a level { id, name, elevation, height }', at);
  const keys = onlyKeys(v, ['id', 'name', 'elevation', 'height'], at);
  if (!keys.ok) return keys;
  const id = readDataId(own(v, 'id'), [...at, 'id']);
  if (!id.ok) return id;
  const name = readName(own(v, 'name'), [...at, 'name']);
  if (!name.ok) return name;
  const elevation = readConstantLength(own(v, 'elevation'), [...at, 'elevation'], {
    signed: true,
  });
  if (!elevation.ok) return elevation;
  const height = readConstantLength(own(v, 'height'), [...at, 'height'], { positive: true });
  if (!height.ok) return height;
  return ok({
    id: id.value,
    name: name.value,
    elevation: elevation.value.expression,
    height: height.value.expression,
  });
}

/** The stored levels, checked: at most `MAX_LEVELS`, ids unique. */
export function readLevels(v: unknown, at: Path): Read<StoredLevel[]> {
  if (!Array.isArray(v)) return fail('expected a list of levels', at);
  if (v.length > MAX_LEVELS) return fail(`at most ${MAX_LEVELS} levels are allowed`, at);
  const out: StoredLevel[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const r = readLevel(v[i], [...at, i]);
    if (!r.ok) return r;
    if (ids.has(r.value.id))
      return fail(`two levels have the id "${r.value.id}"`, [...at, i, 'id']);
    ids.add(r.value.id);
    out.push(r.value);
  }
  return ok(out);
}

/** The level with this id, or undefined. */
export function findLevel<L>(levels: readonly Level<L>[], id: string): Level<L> | undefined {
  return levels.find((l) => l.id === id);
}
