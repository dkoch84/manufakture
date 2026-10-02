// The params of `wood.joint` (M4 plan T4.2b): which kind of joint, the two boards it joins (`a`
// and `b`, body ids of boards the joint names in `dependsOn`), and the few choices that are not
// numbers. Sizes are expressions, so they may name variables; `JOINT_EXPRESSIONS` declares their
// kinds and `KIND_EXPRESSIONS` which kind reads which.

import type { ExpressionKind } from '@manufakture/regen';
import { currentVersion, migrate, type Json, type Versioned } from '../migrations';
import { fail, isObject, ok, onlyKeys, own, readEnum, readId, type Read } from '../read';

export const JOINT_TYPE = 'wood.joint';

export type JointKind =
  'dado' | 'rabbet' | 'mortise-tenon' | 'dowel' | 'pocket-screw' | 'box-joint';
export const JOINT_KINDS: readonly JointKind[] = [
  'dado',
  'rabbet',
  'mortise-tenon',
  'dowel',
  'pocket-screw',
  'box-joint',
];

/** Where a stopped dado stops short: at the low or high end of the A axis it runs along, or both. */
export type DadoStop = 'none' | 'low' | 'high' | 'both';
export const DADO_STOPS: readonly DadoStop[] = ['none', 'low', 'high', 'both'];

interface Boards {
  /** The board that receives (the dado's, rabbet's or mortise's board; the one a screw enters). */
  a: string;
  /** The board that enters it (the shelf, the tenon's board, the pocket's board). */
  b: string;
}

export type DadoParams = Boards & { kind: 'dado'; stopped: DadoStop };
export type RabbetParams = Boards & { kind: 'rabbet' };
export type TenonParams = Boards & { kind: 'mortise-tenon'; ends: 'square' | 'rounded' };
export type DowelParams = Boards & { kind: 'dowel' };
/** `face`: the face of B the pocket opens on, the low or high end of B's thickness axis. */
export type PocketParams = Boards & { kind: 'pocket-screw'; face: 'low' | 'high' };
/** `start`: the board whose finger comes first at the low end of the fingers' axis. */
export type BoxJointParams = Boards & { kind: 'box-joint'; start: 'a' | 'b' };

export type JointParams =
  DadoParams | RabbetParams | TenonParams | DowelParams | PocketParams | BoxJointParams;

/** The kind of every expression a joint may have. */
export const JOINT_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = {
  angle: 'angle',
  clearance: 'length',
  count: 'number',
  depthA: 'length',
  depthB: 'length',
  diameter: 'length',
  edge: 'length',
  finger: 'length',
  offset: 'length',
  screw: 'length',
  spacing: 'length',
  stop: 'length',
  thickness: 'length',
  width: 'length',
};

/** Which expressions each kind reads (all optional; defaults in the README). */
export const KIND_EXPRESSIONS: Readonly<Record<JointKind, readonly string[]>> = {
  dado: ['clearance', 'stop'],
  rabbet: ['clearance'],
  'mortise-tenon': ['thickness', 'width', 'offset', 'clearance'],
  dowel: ['diameter', 'depthA', 'depthB', 'count', 'spacing', 'edge', 'offset'],
  'pocket-screw': ['count', 'spacing', 'edge', 'angle', 'screw'],
  'box-joint': ['finger', 'count', 'clearance'],
};

/** The params migrations of `wood.joint` (none yet: version 1 is current). */
export const JOINT_PARAMS: Versioned = { what: '"wood.joint" params', migrations: [] };
export const JOINT_SCHEMA_VERSION = currentVersion(JOINT_PARAMS);

const BODY_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*(:[^\s]+)?$/;

function readBody(v: unknown, field: 'a' | 'b'): Read<string> {
  const id = readId(v, [field], 'a board body id like "extension#1"');
  if (!id.ok) return id;
  return BODY_ID.test(id.value) ? id : fail('expected a board body id like "extension#1"', [field]);
}

function readCurrent(params: Json): Read<JointParams> {
  if (!isObject(params)) return fail('expected the joint params object');
  const kind = readEnum(own(params, 'kind'), JOINT_KINDS, ['kind']);
  if (!kind.ok) return kind;
  const a = readBody(own(params, 'a'), 'a');
  if (!a.ok) return a;
  const b = readBody(own(params, 'b'), 'b');
  if (!b.ok) return b;
  if (a.value === b.value) return fail('a joint joins two different boards', ['b']);
  const boards = { a: a.value, b: b.value };
  const extra: Record<JointKind, readonly string[]> = {
    dado: ['stopped'],
    rabbet: [],
    'mortise-tenon': ['ends'],
    dowel: [],
    'pocket-screw': ['face'],
    'box-joint': ['start'],
  };
  const keys = onlyKeys(params, ['kind', 'a', 'b', ...extra[kind.value]], []);
  if (!keys.ok) return keys;
  /** An optional choice, with its default. */
  const choice = <T extends string>(key: string, values: readonly T[], fallback: T): Read<T> => {
    const v = own(params, key);
    return v === undefined ? ok(fallback) : readEnum(v, values, [key]);
  };
  switch (kind.value) {
    case 'dado': {
      const stopped = choice('stopped', DADO_STOPS, 'none');
      return stopped.ok ? ok({ kind: 'dado', ...boards, stopped: stopped.value }) : stopped;
    }
    case 'rabbet':
      return ok({ kind: 'rabbet', ...boards });
    case 'mortise-tenon': {
      const ends = choice('ends', ['square', 'rounded'] as const, 'square');
      return ends.ok ? ok({ kind: 'mortise-tenon', ...boards, ends: ends.value }) : ends;
    }
    case 'dowel':
      return ok({ kind: 'dowel', ...boards });
    case 'pocket-screw': {
      const face = choice('face', ['low', 'high'] as const, 'low');
      return face.ok ? ok({ kind: 'pocket-screw', ...boards, face: face.value }) : face;
    }
    case 'box-joint': {
      const start = choice('start', ['a', 'b'] as const, 'a');
      return start.ok ? ok({ kind: 'box-joint', ...boards, start: start.value }) : start;
    }
  }
}

/**
 * A joint's params stored at `schemaVersion`, migrated in memory and validated: regen's params
 * check, and what the joint dialog reads.
 */
export function readJointParams(params: Json, schemaVersion: number): Read<JointParams> {
  const migrated = migrate(JOINT_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}
