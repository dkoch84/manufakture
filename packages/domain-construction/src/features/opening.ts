// The opening feature, `construction.opening` (M6 plan T6.1b, ADR 0015 decisions 2, 3, 5 and 6): a
// door, window or plain opening in a wall, by rough opening.
//
// - **Host wall**: the one `construction.wall` in the opening's `dependsOn`. Params hold no
//   feature id (decision 2); the host is read from the wall's metadata (`upstream`).
// - **Params** (schemaVersion 1): `kind` (`door`, `window`, `opening`), `segment` (1-based segment
//   of the host's path, default 1), `from` (`start` or `end` of that segment: where `position` is
//   measured from), `sizing` (`rough`, the default: `width` and `height` are the rough opening;
//   `unit`: they are the unit's size and `allowance` is added to each), `header` (`auto`, the
//   default: the narrowest header rule covering the width, else the wall type's default;
//   `default`; or `explicit` with its stock, plies, jacks and optional spacer), `kings`, `jacks`,
//   `swing` and `hand` (doors; drawings only), `overrides` (per-member, keyed by local id:
//   `king-l`, `header`) and `add` (members its framing does not make, #1214: `{ id: "add<k>",
//   role: "stud" | "blocking", stock?, plies? }`, owned by the opening). Lengths are
//   expressions: `position` (to the opening's centre line), `width`, `height`, `sill` (the rough
//   opening's bottom above the wall's base: 0 for a door, required for a window), `allowance`,
//   `move_<n>`, and `add<k>_at` (an added member's centre line from the opening's, positive
//   towards the segment's end) and `add<k>_z` (an added block's centre above the wall's base).
// - **Cuts** (decision 3): one `tools` input with a box per layer body of the host, through the
//   whole wall at the rough opening (`<id>:<layer id>:<role>` faces). With a `scope`, every body
//   it cuts must be listed there. No operation: an opening makes no body of its own.
// - **Scope** (T6.5d): an opening is written with its host's layer bodies as its `scope`
//   (`openingScope`), so regen's graph and cache see it read only those. Without one it reads every
//   body in the part, and moving one opening rebuilds every opening after it. The scope names
//   bodies, not layers' geometry, so it holds while joins (a T6.1b follow-up) trim and notch them; it changes
//   only with the host's layers (a wall type gaining or losing a sheet layer), and the app rewrites
//   it then.
// - **Members** (decision 6): framed with the host wall by the member stage, owned by the
//   opening (`extension#7:king-l`).

import type { ToolItem, ToolsInput } from '@manufakture/kernel';
import type {
  ExpressionKind,
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
} from '@manufakture/regen';
import {
  currentVersion,
  fail,
  isObject,
  migrate,
  ok,
  onlyKeys,
  own,
  readEnum,
  readId,
  type Json,
  type Read,
  type Versioned,
} from '@manufakture/stock';
import type { HeaderData } from '../data';
import {
  ADD_EXPRESSIONS,
  MAX_OVERRIDES,
  MAX_SEGMENT_LENGTH,
  OPENING_TYPE,
  Refusal,
  WALL_TYPE,
  failure,
  isAddExpression,
  moveExpression,
  planSegments,
  readAdds,
  readOptionalCount,
  readOverrides,
  readWallMetadata,
  resolveAdds,
  resolveOverrides,
  stockData,
  toJson,
  type OpeningHeader,
  type OpeningMetadata,
  type StoredAdd,
  type StoredOverride,
} from './common';
import { headerSpec, wallLayerBodies } from './wall';

export type OpeningKind = 'door' | 'window' | 'opening';

export type StoredOpeningHeader =
  | { readonly kind: 'auto' }
  | { readonly kind: 'default' }
  | ({ readonly kind: 'explicit' } & HeaderData);

export interface OpeningParams {
  readonly kind: OpeningKind;
  readonly segment: number;
  readonly from: 'start' | 'end';
  readonly sizing: 'rough' | 'unit';
  readonly header: StoredOpeningHeader;
  readonly kings?: number;
  readonly jacks?: number;
  readonly swing?: 'in' | 'out';
  readonly hand?: 'left' | 'right';
  readonly overrides: readonly StoredOverride[];
  /** Members its framing does not make (#1214); absent when the params have none. */
  readonly add?: readonly StoredAdd[];
}

/** The params migrations of `construction.opening` (none yet: version 1 is current). */
export const OPENING_PARAMS: Versioned = { what: '"construction.opening" params', migrations: [] };
export const OPENING_SCHEMA_VERSION = currentVersion(OPENING_PARAMS);

const LENGTHS = ['position', 'width', 'height', 'sill', 'allowance'] as const;

export const OPENING_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = Object.freeze(
  Object.fromEntries([
    ...LENGTHS.map((k) => [k, 'length']),
    ...Array.from({ length: MAX_OVERRIDES }, (_, i) => [moveExpression(i + 1), 'length']),
    ...ADD_EXPRESSIONS,
  ]) as Record<string, ExpressionKind>,
);

const KINDS: readonly OpeningKind[] = ['door', 'window', 'opening'];

function readHeaderParam(v: unknown): Read<StoredOpeningHeader> {
  if (v === undefined) return ok({ kind: 'auto' });
  const at = ['header'];
  if (!isObject(v)) return fail("expected a header { kind: 'auto' | 'default' | 'explicit' }", at);
  const kind = readEnum(own(v, 'kind'), ['auto', 'default', 'explicit'] as const, [...at, 'kind']);
  if (!kind.ok) return kind;
  if (kind.value !== 'explicit') {
    const keys = onlyKeys(v, ['kind'], at);
    return keys.ok ? ok({ kind: kind.value }) : keys;
  }
  const keys = onlyKeys(v, ['kind', 'stock', 'plies', 'jacks', 'spacer'], at);
  if (!keys.ok) return keys;
  const stock = readId(own(v, 'stock'), [...at, 'stock'], 'a stock id');
  if (!stock.ok) return stock;
  const plies = readOptionalCount(v, 'plies', at, 1, 4);
  if (!plies.ok) return plies;
  const jacks = readOptionalCount(v, 'jacks', at, 1, 4);
  if (!jacks.ok) return jacks;
  if (plies.value === undefined)
    return fail('expected a whole number from 1 to 4', [...at, 'plies']);
  if (jacks.value === undefined)
    return fail('expected a whole number from 1 to 4', [...at, 'jacks']);
  const spacer = own(v, 'spacer');
  if (spacer !== undefined) {
    const r = readId(spacer, [...at, 'spacer'], 'a stock id');
    if (!r.ok) return r;
  }
  return ok({
    kind: 'explicit',
    stock: stock.value,
    plies: plies.value,
    jacks: jacks.value,
    ...(spacer === undefined ? {} : { spacer: spacer as string }),
  });
}

function readCurrent(params: Json): Read<OpeningParams> {
  if (!isObject(params)) return fail('expected the opening params object');
  const keys = onlyKeys(
    params,
    [
      'kind',
      'segment',
      'from',
      'sizing',
      'header',
      'kings',
      'jacks',
      'swing',
      'hand',
      'overrides',
      'add',
    ],
    [],
  );
  if (!keys.ok) return keys;
  const kind = readEnum(own(params, 'kind'), KINDS, ['kind']);
  if (!kind.ok) return kind;
  const segment = readOptionalCount(params, 'segment', [], 1, 1000);
  if (!segment.ok) return segment;
  const enumOr = <T extends string>(key: string, values: readonly T[], dflt?: T) => {
    const v = own(params, key);
    return v === undefined ? ok(dflt) : readEnum(v, values, [key]);
  };
  const from = enumOr('from', ['start', 'end'] as const, 'start');
  if (!from.ok) return from;
  const sizing = enumOr('sizing', ['rough', 'unit'] as const, 'rough');
  if (!sizing.ok) return sizing;
  const swing = enumOr('swing', ['in', 'out'] as const);
  if (!swing.ok) return swing;
  const hand = enumOr('hand', ['left', 'right'] as const);
  if (!hand.ok) return hand;
  if (kind.value !== 'door' && (swing.value !== undefined || hand.value !== undefined)) {
    return fail('only a door has a swing and a hand', [
      swing.value !== undefined ? 'swing' : 'hand',
    ]);
  }
  const header = readHeaderParam(own(params, 'header'));
  if (!header.ok) return header;
  const kings = readOptionalCount(params, 'kings', [], 1, 4);
  if (!kings.ok) return kings;
  const jacks = readOptionalCount(params, 'jacks', [], 1, 4);
  if (!jacks.ok) return jacks;
  const overrides = readOverrides(own(params, 'overrides'), ['overrides']);
  if (!overrides.ok) return overrides;
  const add = readAdds(own(params, 'add'), ['add'], false);
  if (!add.ok) return add;
  return ok({
    kind: kind.value,
    segment: segment.value ?? 1,
    from: from.value!,
    sizing: sizing.value!,
    header: header.value,
    overrides: overrides.value,
    ...(add.value.length === 0 ? {} : { add: add.value }),
    ...(kings.value === undefined ? {} : { kings: kings.value }),
    ...(jacks.value === undefined ? {} : { jacks: jacks.value }),
    ...(swing.value === undefined ? {} : { swing: swing.value }),
    ...(hand.value === undefined ? {} : { hand: hand.value }),
  });
}

/** An opening's params stored at `schemaVersion`, migrated in memory and validated. */
export function readOpeningParams(params: Json, schemaVersion: number): Read<OpeningParams> {
  const migrated = migrate(OPENING_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

/**
 * The `scope` an opening in `wall` is written with: the wall's layer bodies (`wallLayerBodies`),
 * or undefined when the wall makes none (a framing-only wall: the opening then cuts nothing).
 */
export function openingScope(
  wall: { readonly id: string; readonly operation?: string | undefined },
  type: { readonly layers: readonly { readonly id: string; readonly kind: string }[] } | undefined,
): string[] | undefined {
  const bodies = wallLayerBodies(wall, type);
  return bodies.length === 0 ? undefined : bodies;
}

// The translator ---------------------------------------------------------------------------------

/** How far the cutting boxes reach past the wall's faces, mm. */
const PAST = 1;

function value(ctx: ExtensionContext<OpeningParams>, key: string): number | undefined {
  const v = ctx.values[key];
  if (v !== undefined && !(Math.abs(v) <= MAX_SEGMENT_LENGTH)) {
    throw new Refusal(`the ${key} must be at most ${MAX_SEGMENT_LENGTH / 1000} m`, [
      'expressions',
      key,
    ]);
  }
  return v;
}

function build(ctx: ExtensionContext<OpeningParams>): {
  input: ToolsInput;
  metadata: OpeningMetadata;
} {
  const f = ctx.feature;
  const p = ctx.params;
  if (f.operation !== undefined) {
    throw new Refusal('an opening cuts its wall and makes no body: it has no operation', [
      'operation',
    ]);
  }
  for (const name of Object.keys(f.expressions)) {
    const move = /^move_([1-9][0-9]*)$/.exec(name);
    const allowed =
      (LENGTHS as readonly string[]).includes(name) ||
      (move !== null && Number(move[1]) <= p.overrides.length) ||
      isAddExpression(name, p.add ?? []);
    if (!allowed || (name === 'allowance' && p.sizing !== 'unit')) {
      throw new Refusal(`this opening has no "${name}" value`, ['expressions', name]);
    }
  }
  const walls = [...ctx.upstream].filter(([, u]) => u.type === WALL_TYPE);
  if (walls.length !== 1) {
    throw new Refusal(
      walls.length === 0
        ? 'an opening needs its host wall in dependsOn'
        : 'an opening has one host wall: dependsOn names several walls',
      ['dependsOn'],
    );
  }
  const [wallId, upstream] = walls[0]!;
  const wall = readWallMetadata(upstream.metadata);
  if (wall === undefined) throw new Refusal(`${wallId} reports no wall geometry`, ['dependsOn']);
  const segs = planSegments(wall.points, wall.closed);
  const seg = segs[p.segment - 1];
  if (seg === undefined) {
    throw new Refusal(`${wallId} has ${segs.length} segment${segs.length === 1 ? '' : 's'}`, [
      'params',
      'segment',
    ]);
  }
  const need = (key: string): number => {
    const v = value(ctx, key);
    if (v === undefined) throw new Refusal(`the opening needs a ${key}`, ['expressions', key]);
    return v;
  };
  const allowance = p.sizing === 'unit' ? need('allowance') : 0;
  if (!(allowance >= 0)) {
    throw new Refusal('the allowance cannot be negative', ['expressions', 'allowance']);
  }
  const width = need('width') + allowance;
  const height = need('height') + allowance;
  if (!(width > 0)) throw new Refusal('the width must be above 0', ['expressions', 'width']);
  if (!(height > 0)) throw new Refusal('the height must be above 0', ['expressions', 'height']);
  let sill: number;
  if (p.kind === 'door') {
    if (f.expressions.sill !== undefined) {
      throw new Refusal('a door starts at the floor: it has no sill', ['expressions', 'sill']);
    }
    sill = 0;
  } else if (p.kind === 'window') {
    sill = need('sill');
  } else {
    sill = value(ctx, 'sill') ?? 0;
  }
  if (!(sill >= 0)) throw new Refusal('the sill cannot be below the wall', ['expressions', 'sill']);
  const along = need('position');
  const position = p.from === 'start' ? along : seg.length - along;
  if (position - width / 2 < 0 || position + width / 2 > seg.length) {
    throw new Refusal(`the opening does not fit along segment ${p.segment} of ${wallId}`, [
      'expressions',
      'position',
    ]);
  }
  if (sill + height > wall.height) {
    throw new Refusal(`the opening is taller than ${wallId}`, ['expressions', 'height']);
  }

  // One box per layer body, through the whole wall at the rough opening.
  const bodies = wall.layers.flatMap((l) =>
    l.body !== null && ctx.bodies.includes(l.body) ? [{ id: l.id, body: l.body }] : [],
  );
  if (f.scope !== undefined) {
    for (const b of bodies) {
      if (!f.scope.includes(b.body)) {
        throw new Refusal(`the opening cuts ${b.body}: list it in the opening's scope`, ['scope']);
      }
    }
  }
  const lo = Math.min(...wall.layers.map((l) => l.t[0])) - PAST;
  const hi = Math.max(...wall.layers.map((l) => l.t[1])) + PAST;
  const s0 = position - width / 2;
  const origin: [number, number, number] = [
    seg.a[0] + seg.d[0] * s0 + seg.n[0] * lo,
    seg.a[1] + seg.d[1] * s0 + seg.n[1] * lo,
    wall.base + sill,
  ];
  const items: ToolItem[] = bodies.map((b) => ({
    id: b.id,
    body: b.body,
    mode: 'subtract',
    primitive: {
      type: 'box',
      // x along the segment, y (normal x xDir) its left normal, z up.
      frame: { origin, xDir: [seg.d[0], seg.d[1], 0], normal: [0, 0, 1] },
      size: [width, hi - lo, height],
    },
  }));

  const data = stockData(ctx);
  let header: OpeningHeader;
  if (p.header.kind === 'explicit') {
    header = {
      kind: 'explicit',
      header: headerSpec(p.header, ctx, "The opening's header", ['params', 'header']),
    };
  } else {
    header = { kind: p.header.kind };
  }
  const metadata: OpeningMetadata = {
    kind: 'opening',
    wall: wallId,
    type: p.kind,
    segment: p.segment,
    position,
    width,
    height,
    sill,
    header,
    overrides: resolveOverrides(p.overrides, ctx.values, data),
    ...(p.add === undefined ? {} : { add: resolveAdds(p.add, ctx.values, data) }),
    cuts: bodies.map((b) => b.body),
    ...(p.kings === undefined ? {} : { kings: p.kings }),
    ...(p.jacks === undefined ? {} : { jacks: p.jacks }),
    ...(p.swing === undefined ? {} : { swing: p.swing }),
    ...(p.hand === undefined ? {} : { hand: p.hand }),
  };
  return { input: { kind: 'tools', id: f.id, items }, metadata };
}

/** The cuts and framing input of an opening, or why it cannot be built. */
export function translateOpening(ctx: ExtensionContext<OpeningParams>): ExtensionOutput {
  try {
    const { input, metadata } = build(ctx);
    return { inputs: input.items.length === 0 ? [] : [input], metadata: toJson(metadata) };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}

/** The `construction.opening` extension type, as regen's registry takes it. */
export const openingType: ExtensionType<OpeningParams> = {
  schemaVersion: OPENING_SCHEMA_VERSION,
  expressions: OPENING_EXPRESSIONS,
  params(params, schemaVersion) {
    return readOpeningParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateOpening(ctx);
  },
};

export { OPENING_TYPE };
