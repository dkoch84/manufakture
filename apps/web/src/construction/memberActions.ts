// Per-member actions on a picked framing member (ADR 0015 decision 6): delete it, change its
// stock, or put it back as framed. An override is a param of the member's owner (a wall or an
// opening), keyed by the member's local id: `{ id, delete?, stock?, at? }`, with its nudge in the
// expression `move_<n>` (n: its 1-based place in the list). Removing an override renumbers the
// nudges after it, so each stays with its own override. Each action is one `editFeature`.
// An override of a wall's layout stud or block records where the member is (`at`, #1215), so a
// later spacing, origin or direction change finds it by position and says so (`moved`, `lost`)
// instead of re-targeting the stud that inherits its id.

import type {
  Command,
  ExtensionFeature,
  ManufaktureDocument,
  StoredExpression,
} from '@manufakture/core';
import {
  MAX_OVERRIDES,
  OPENING_SCHEMA_VERSION,
  WALL_SCHEMA_VERSION,
  overridePosition,
  readOpeningParams,
  readWallParams,
  splitMemberFullId,
} from '@manufakture/domain-construction';
import { findStock } from '@manufakture/stock';
import type { ModelStore } from '../model/model';
import type { MemberStore } from '../viewport/memberStore';
import { omit } from './kinds';
import { isOpening, isWall } from './settings';

export interface StoredOverride {
  id: string;
  delete?: boolean;
  stock?: string;
  /** Where the member was along its wall segment when the override was made, mm (#1215). */
  at?: number;
}

export interface MemberOwner {
  feature: ExtensionFeature;
  /** The member's id within its owner (`s12`, `king-l`). */
  localId: string;
  /** The override the owner already holds for it, and its index. */
  override: StoredOverride | undefined;
  index: number;
}

function overridesOf(f: ExtensionFeature): StoredOverride[] {
  const raw = (f.params as Record<string, unknown>).overrides;
  return Array.isArray(raw) ? (raw as StoredOverride[]) : [];
}

/** The wall or opening of the active part that owns a member, by the member's full id. */
export function memberOwner(
  doc: ManufaktureDocument,
  partId: string,
  fullId: string,
): MemberOwner | null {
  const split = splitMemberFullId(fullId);
  if (!split) return null;
  const part = doc.parts.find((p) => p.id === partId);
  const feature = part?.features.find((f) => f.id === split.owner);
  if (!feature || !(isWall(feature) || isOpening(feature))) return null;
  const overrides = overridesOf(feature);
  const index = overrides.findIndex((o) => o.id === split.id);
  return {
    feature,
    localId: split.id,
    override: index >= 0 ? overrides[index] : undefined,
    index,
  };
}

/**
 * Where an override of the member should record it is (`overridePosition`), from the last regen:
 * the part's feature results and member sets. Undefined when they do not have it.
 */
export function memberPosition(
  model: ModelStore,
  members: MemberStore,
  partId: string,
  owner: string,
  localId: string,
): number | undefined {
  const features = model.getState().parts.find((p) => p.partId === partId)?.features ?? [];
  const sets = members.getState().parts.get(partId) ?? [];
  return overridePosition({ owner, features, sets }, localId);
}

export type MemberAction =
  { kind: 'delete' } | { kind: 'stock'; stock: string } | { kind: 'restore' };

export type ActionOutcome =
  { ok: true; command: Command; label: string } | { ok: false; message: string };

/**
 * The edit of the owner's overrides that performs `action` on the member. `at` is where the
 * member sits along its wall segment as the layout made it (`overridePosition`, from the last
 * regen; undefined when positions do not apply): stored on a new override, and on an older one
 * that has none. An override keeps the position it was first made with.
 */
export function memberActionCommand(
  doc: ManufaktureDocument,
  partId: string,
  fullId: string,
  action: MemberAction,
  at?: number,
): ActionOutcome {
  const owner = memberOwner(doc, partId, fullId);
  if (!owner) return { ok: false, message: 'This member belongs to no wall or opening here.' };
  const { feature, localId, index } = owner;
  const overrides = overridesOf(feature).map((o) => ({ ...o }));
  let expressions: Record<string, StoredExpression> = { ...feature.expressions };
  let label: string;
  if (action.kind === 'restore') {
    if (index < 0) return { ok: false, message: 'This member has no change to undo.' };
    overrides.splice(index, 1);
    expressions = renumberMoves(expressions, index + 1);
    label = `Restore ${fullId}`;
  } else {
    const next: StoredOverride = index >= 0 ? { ...overrides[index]! } : { id: localId };
    if (next.at === undefined && at !== undefined && isWall(feature)) next.at = at;
    if (action.kind === 'delete') {
      next.delete = true;
      delete next.stock;
      label = `Delete ${fullId}`;
    } else {
      const entry = findStock(action.stock);
      if (!entry || entry.kind !== 'lumber') {
        return { ok: false, message: 'Choose a lumber stock.' };
      }
      next.stock = action.stock;
      delete next.delete;
      label = `Change ${fullId} to ${entry.name}`;
    }
    if (index >= 0) overrides[index] = next;
    else {
      if (overrides.length >= MAX_OVERRIDES) {
        return { ok: false, message: `A feature holds at most ${MAX_OVERRIDES} member changes.` };
      }
      overrides.push(next);
    }
  }
  const rest = omit(feature.params as Record<string, unknown>, 'overrides');
  const params = (
    overrides.length > 0 ? { ...rest, overrides } : rest
  ) as ExtensionFeature['params'];
  const read = isWall(feature)
    ? readWallParams(params as never, WALL_SCHEMA_VERSION)
    : readOpeningParams(params as never, OPENING_SCHEMA_VERSION);
  if (!read.ok) return { ok: false, message: read.message };
  return {
    ok: true,
    command: { type: 'editFeature', partId, feature: { ...feature, params, expressions } },
    label,
  };
}

/** Drop `move_<removed>` and move every later nudge down by one. */
function renumberMoves(
  expressions: Record<string, StoredExpression>,
  removed: number,
): Record<string, StoredExpression> {
  const out: Record<string, StoredExpression> = {};
  for (const [k, v] of Object.entries(expressions)) {
    const m = /^move_([1-9][0-9]*)$/.exec(k);
    if (!m) {
      out[k] = v;
      continue;
    }
    const n = Number(m[1]);
    if (n === removed) continue;
    out[n > removed ? `move_${n - 1}` : k] = v;
  }
  return out;
}
