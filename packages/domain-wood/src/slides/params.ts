// The params of `wood.slide` (#1200): which slide of the catalog (`family` and `size`), the two
// boards it goes between (`cabinet`, the cabinet's side it is screwed to, and `drawer`, the
// drawer's side), and which way the drawer pulls out (`opens`, a horizontal world direction).
// Sizes that are numbers are expressions: `setback` (the slide's front behind the drawer side's
// front end) and, for a side-mount, `offset` (up from centred on the drawer side).

import type { ExpressionKind } from '@manufakture/regen';
import { currentVersion, migrate, type Json, type Versioned } from '../migrations';
import { fail, isObject, ok, onlyKeys, own, readEnum, readId, type Read } from '../read';
import { SLIDE_FAMILIES, findSlideFamily, findSlideSize } from './catalog';

export const SLIDE_TYPE = 'wood.slide';

/** The world direction the drawer pulls out towards. Z is up. */
export type SlideOpens = '+x' | '-x' | '+y' | '-y';
export const SLIDE_OPENS: readonly SlideOpens[] = ['+x', '-x', '+y', '-y'];

export interface SlideParams {
  /** A family of the catalog (`SLIDE_FAMILIES`). */
  family: string;
  /** One of its sizes (`18in`). */
  size: string;
  /** The cabinet's board the slide is screwed to: a board body id. */
  cabinet: string;
  /** The drawer's board: its side. */
  drawer: string;
  opens: SlideOpens;
}

/** The kind of every expression a slide may have. */
export const SLIDE_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = {
  setback: 'length',
  offset: 'length',
};

/** Which expressions each mounting reads (both optional, 0 by default). */
export const MOUNT_EXPRESSIONS: Readonly<Record<'side' | 'under', readonly string[]>> = {
  side: ['setback', 'offset'],
  under: ['setback'],
};

/** The params migrations of `wood.slide` (none yet: version 1 is current). */
export const SLIDE_PARAMS: Versioned = { what: '"wood.slide" params', migrations: [] };
export const SLIDE_SCHEMA_VERSION = currentVersion(SLIDE_PARAMS);

const BODY_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*(:[^\s]+)?$/;

function readBody(v: unknown, field: 'cabinet' | 'drawer'): Read<string> {
  const id = readId(v, [field], 'a board body id like "extension#1"');
  if (!id.ok) return id;
  return BODY_ID.test(id.value) ? id : fail('expected a board body id like "extension#1"', [field]);
}

function readCurrent(params: Json): Read<SlideParams> {
  if (!isObject(params)) return fail('expected the slide params object');
  const keys = onlyKeys(params, ['family', 'size', 'cabinet', 'drawer', 'opens'], []);
  if (!keys.ok) return keys;
  const familyId = readEnum(
    own(params, 'family'),
    SLIDE_FAMILIES.map((f) => f.id),
    ['family'],
  );
  if (!familyId.ok) return familyId;
  const family = findSlideFamily(familyId.value)!;
  const size = readId(own(params, 'size'), ['size'], 'a size id like "18in"');
  if (!size.ok) return size;
  if (findSlideSize(family, size.value) === undefined) {
    return fail(
      `${family.id} comes in ${family.sizes.map((s) => `"${s.id}"`).join(', ')}, not "${size.value}"`,
      ['size'],
    );
  }
  const cabinet = readBody(own(params, 'cabinet'), 'cabinet');
  if (!cabinet.ok) return cabinet;
  const drawer = readBody(own(params, 'drawer'), 'drawer');
  if (!drawer.ok) return drawer;
  if (cabinet.value === drawer.value) {
    return fail('a slide goes between two different boards', ['drawer']);
  }
  const opens = readEnum(own(params, 'opens'), SLIDE_OPENS, ['opens']);
  if (!opens.ok) return opens;
  return ok({
    family: family.id,
    size: size.value,
    cabinet: cabinet.value,
    drawer: drawer.value,
    opens: opens.value,
  });
}

/**
 * A slide's params stored at `schemaVersion`, migrated in memory and validated: regen's params
 * check.
 */
export function readSlideParams(params: Json, schemaVersion: number): Read<SlideParams> {
  const migrated = migrate(SLIDE_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}
