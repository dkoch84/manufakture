// A construction view's params (the `params` of a domain view source, format v15), version 1:
//
// - `{ kind: 'plan', level, cut?, openings? }`: a floor plan of a level, cut `cut` above the
//   level's datum (an expression, default 4').
// - `{ kind: 'elevation', wall, segment?, from?, openings?, marks? }`: a framing elevation of one
//   segment (1-based, default 1) of a wall, seen from `outside` (default) or `inside`.
// - `{ kind: 'roof-plan', roof }`: a roof framing plan.
//
// `openings` picks what a dimension string stops at for doors and windows: their `rough` opening
// edges (default) or their `centre` lines, or `none` for no strings; `marks` (default true) adds
// stud layout marks to an elevation's string. Strings are derived from wall, opening and member
// data at every request and never stored (ADR 0015); the params only say which a view shows.

import { fail, isObject, ok, onlyKeys, own, readEnum, readId, type Read } from '@manufakture/stock';

export const VIEW_PARAMS_VERSION = 1;

export type OpeningStops = 'rough' | 'centre' | 'none';

export type ConstructionViewParams =
  | {
      readonly kind: 'plan';
      readonly level: string;
      /** A stored expression, evaluated by regen with the document's variables; absent: 4'. */
      readonly cut?: unknown;
      readonly openings: OpeningStops;
    }
  | {
      readonly kind: 'elevation';
      readonly wall: string;
      readonly segment: number;
      readonly from: 'outside' | 'inside';
      readonly openings: OpeningStops;
      readonly marks: boolean;
    }
  | { readonly kind: 'roof-plan'; readonly roof: string };

/** The most segments a wall's path has (`MAX_WALL_POINTS`), bounding `segment`. */
const MAX_SEGMENT = 64;

const STOPS = ['rough', 'centre', 'none'] as const;

/** A construction view's params at `schemaVersion`, checked (version 1 is the only one). */
export function readViewParams(
  params: unknown,
  schemaVersion: number,
): Read<ConstructionViewParams> {
  if (schemaVersion !== VIEW_PARAMS_VERSION) {
    return fail(`construction views are version ${VIEW_PARAMS_VERSION}, not ${schemaVersion}`);
  }
  if (!isObject(params)) return fail('expected the view params object');
  const kind = readEnum(own(params, 'kind'), ['plan', 'elevation', 'roof-plan'] as const, ['kind']);
  if (!kind.ok) return kind;
  const stops = (): Read<OpeningStops> => {
    const v = own(params, 'openings');
    return v === undefined ? ok('rough') : readEnum(v, STOPS, ['openings']);
  };
  if (kind.value === 'plan') {
    const keys = onlyKeys(params, ['kind', 'level', 'cut', 'openings'], []);
    if (!keys.ok) return keys;
    const level = readId(own(params, 'level'), ['level'], 'a level id', 64);
    if (!level.ok) return level;
    const openings = stops();
    if (!openings.ok) return openings;
    const cut = own(params, 'cut');
    return ok({
      kind: 'plan',
      level: level.value,
      ...(cut === undefined ? {} : { cut }),
      openings: openings.value,
    });
  }
  if (kind.value === 'elevation') {
    const keys = onlyKeys(params, ['kind', 'wall', 'segment', 'from', 'openings', 'marks'], []);
    if (!keys.ok) return keys;
    const wall = readId(own(params, 'wall'), ['wall'], 'a wall feature id', 200);
    if (!wall.ok) return wall;
    const rawSegment = own(params, 'segment');
    const segment = rawSegment === undefined ? 1 : rawSegment;
    if (!(
      Number.isInteger(segment) &&
      (segment as number) >= 1 &&
      (segment as number) <= MAX_SEGMENT
    )) {
      return fail(`expected a segment from 1 to ${MAX_SEGMENT}`, ['segment']);
    }
    const rawFrom = own(params, 'from');
    const from =
      rawFrom === undefined
        ? ok('outside' as const)
        : readEnum(rawFrom, ['outside', 'inside'] as const, ['from']);
    if (!from.ok) return from;
    const openings = stops();
    if (!openings.ok) return openings;
    const marks = own(params, 'marks');
    if (marks !== undefined && typeof marks !== 'boolean')
      return fail('expected true or false', ['marks']);
    return ok({
      kind: 'elevation',
      wall: wall.value,
      segment: segment as number,
      from: from.value,
      openings: openings.value,
      marks: marks ?? true,
    });
  }
  const keys = onlyKeys(params, ['kind', 'roof'], []);
  if (!keys.ok) return keys;
  const roof = readId(own(params, 'roof'), ['roof'], 'a roof feature id', 200);
  if (!roof.ok) return roof;
  return ok({ kind: 'roof-plan', roof: roof.value });
}
