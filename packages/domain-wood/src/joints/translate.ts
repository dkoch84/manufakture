// The joint feature, `wood.joint` (M4 plan decision 5, T4.2b): two boards cut against each other
// by one kernel `tools` input. The joint makes no body (no `operation`); it changes the two boards
// it joins, which it names in `params.a` and `params.b`, depends on (`dependsOn`, so regen gives it
// their frames) and, when it has a `scope`, lists there.
//
// Every joint is found from the boards' frames (T4.1c), not from their faces, so a joint follows
// its boards when they move or change size. Boards must be square to each other. The tools are
// placed in A's frame, so their face names (`extension#7:groove:zmax`) do not depend on where the
// boards are, and survive edits like any other names.

import type { ToolsInput } from '@manufakture/kernel';
import type {
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
  JsonValue,
} from '@manufakture/regen';
import { BOARD_TYPE, readBoardMetadata } from '../board';
import type { Json } from '../migrations';
import { isObject, own } from '../read';
import { boxJoint } from './box-joint';
import { Refusal, Values, type Built, type JointHardware, type JointWarning } from './common';
import { dowelJoint, pocketJoint } from './fasteners';
import { boardOf, pairOf, type Board } from './geometry';
import { grooveJoint } from './groove';
import {
  JOINT_EXPRESSIONS,
  JOINT_KINDS,
  JOINT_SCHEMA_VERSION,
  KIND_EXPRESSIONS,
  readJointParams,
  type JointKind,
  type JointParams,
} from './params';
import { tenonJoint } from './tenon';

/** What a joint reports in its feature result (`FeatureResult.metadata`). */
export interface JointMetadata {
  kind: JointKind;
  a: string;
  b: string;
  /** Dowels and screws, for the bill of materials. */
  hardware: JointHardware[];
  /** Rule-of-thumb warnings (not engineering) and parts breaking out of a board. */
  warnings: JointWarning[];
  /** The joint's sizes as built (mm, radians, counts), by name. */
  details: Record<string, number>;
}

/** A joint's metadata from a feature result, or undefined when it is not one. */
export function readJointMetadata(v: unknown): JointMetadata | undefined {
  if (!isObject(v)) return undefined;
  const hardware = own(v, 'hardware');
  const warnings = own(v, 'warnings');
  const details = own(v, 'details');
  if (
    !JOINT_KINDS.includes(own(v, 'kind') as JointKind) ||
    typeof own(v, 'a') !== 'string' ||
    typeof own(v, 'b') !== 'string' ||
    !Array.isArray(hardware) ||
    !hardware.every(
      (h) =>
        isObject(h) &&
        (own(h, 'item') === 'dowel' || own(h, 'item') === 'pocket-screw') &&
        typeof own(h, 'length') === 'number' &&
        typeof own(h, 'quantity') === 'number',
    ) ||
    !Array.isArray(warnings) ||
    !warnings.every((w) => isObject(w) && typeof own(w, 'message') === 'string') ||
    !isObject(details) ||
    !Object.values(details).every((x) => typeof x === 'number')
  ) {
    return undefined;
  }
  return structuredClone(v) as unknown as JointMetadata;
}

type Failure = Extract<ExtensionOutput, { error: string }>;

/** The frame of the board a joint names, or why it cannot be read. */
function boardFor(ctx: ExtensionContext<JointParams>, key: 'a' | 'b'): Board {
  const id = ctx.params[key];
  if (!ctx.bodies.includes(id)) {
    throw new Refusal(`${id} is not a body at this point (deleted, merged, or after the joint)`, [
      'params',
      key,
    ]);
  }
  const up = ctx.upstream.get(id);
  if (up === undefined) {
    throw new Refusal(
      `${id} is not a board this joint depends on: joints join boards (wood.board features), listed in dependsOn`,
      ['dependsOn'],
    );
  }
  if (up.type !== BOARD_TYPE) {
    throw new Refusal(`${id} is a ${up.type}, not a board`, ['params', key]);
  }
  const meta = readBoardMetadata(up.metadata);
  if (meta === undefined) throw new Refusal(`${id} reports no board frame`, ['params', key]);
  return boardOf(id, meta.frame);
}

function build(ctx: ExtensionContext<JointParams>): { built: Built; a: Board; b: Board } {
  const f = ctx.feature;
  const p = ctx.params;
  if (f.operation !== undefined) {
    throw new Refusal(
      'a joint changes the boards it joins and makes no body: it has no operation',
      ['operation'],
    );
  }
  for (const name of Object.keys(f.expressions).sort()) {
    if (!KIND_EXPRESSIONS[p.kind].includes(name)) {
      throw new Refusal(`a ${p.kind} joint has no "${name}" value`, ['expressions', name]);
    }
  }
  const a = boardFor(ctx, 'a');
  const b = boardFor(ctx, 'b');
  if (f.scope !== undefined) {
    for (const id of [a.id, b.id]) {
      if (!f.scope.includes(id)) {
        throw new Refusal(`the joint changes ${id}: list it in the joint's scope`, ['scope']);
      }
    }
  }
  const pair = pairOf(a, b);
  if (!pair.ok) throw new Refusal(pair.message, ['params', 'b']);
  const v = new Values(ctx.values);
  let built: Built;
  switch (p.kind) {
    case 'dado':
    case 'rabbet':
      built = grooveJoint(pair.pair, p, v);
      break;
    case 'mortise-tenon':
      built = tenonJoint(pair.pair, p, v);
      break;
    case 'dowel':
      built = dowelJoint(pair.pair, p, v);
      break;
    case 'pocket-screw':
      built = pocketJoint(pair.pair, p, v);
      break;
    case 'box-joint':
      built = boxJoint(pair.pair, p, v);
      break;
  }
  return { built, a, b };
}

/** The `tools` input and metadata of a joint, or why it cannot be built. */
export function translateJoint(ctx: ExtensionContext<JointParams>): ExtensionOutput {
  let out: ReturnType<typeof build>;
  try {
    out = build(ctx);
  } catch (error) {
    if (error instanceof Refusal)
      return { error: error.message, field: error.field } satisfies Failure;
    throw error;
  }
  const input: ToolsInput = { kind: 'tools', id: ctx.feature.id, items: out.built.items };
  const metadata: JointMetadata = {
    kind: ctx.params.kind,
    a: out.a.id,
    b: out.b.id,
    hardware: out.built.hardware,
    warnings: out.built.warnings,
    details: out.built.details,
  };
  return { inputs: [input], metadata: metadata as unknown as JsonValue };
}

/** The `wood.joint` extension type, as regen's registry takes it. */
export const jointType: ExtensionType<JointParams> = {
  schemaVersion: JOINT_SCHEMA_VERSION,
  expressions: JOINT_EXPRESSIONS,
  // The two boards it joins.
  idFields: [
    { path: ['a'], kind: 'feature' },
    { path: ['b'], kind: 'feature' },
  ],
  params(params, schemaVersion) {
    return readJointParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateJoint(ctx);
  },
};
