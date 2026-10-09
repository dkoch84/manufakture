// Per-member actions on a picked framing member (ADR 0015 decision 6): delete it, change its
// stock, or put it back as framed. An override is a param of the member's owner (a wall or an
// opening), keyed by the member's local id: `{ id, delete?, stock?, at? }`, with its nudge in the
// expression `move_<n>` (n: its 1-based place in the list). Removing an override renumbers the
// nudges after it, so each stays with its own override. Each action is one `editFeature`.
// An override of a wall's layout stud or block records where the member is (`at`, #1215), so a
// later spacing, origin or direction change finds it by position and says so (`moved`, `lost`)
// instead of re-targeting the stud that inherits its id. So the override a member has is found
// through the last regen's listing (an override that `moved` applies to another member than its
// id names), and by id only when the listing does not say.

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
  memberListing,
  overridePosition,
  readOpeningParams,
  readWallParams,
  splitMemberFullId,
  type ListedOverride,
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

/** The owner's overrides as the last regen framed them (`memberListing`'s `overrides`). */
export type ListedOverrides = readonly Pick<
  ListedOverride,
  'n' | 'id' | 'member' | 'status' | 'appliedTo'
>[];

export interface MemberOwner {
  feature: ExtensionFeature;
  /** The member's id within its owner (`s12`, `king-l`). */
  localId: string;
  /**
   * The override that applies to it, and its index: the one the last regen applied to it (also
   * one made for another id that `moved` to it), else the one naming its id.
   */
  override: StoredOverride | undefined;
  index: number;
  /** The override's status in the last regen, when it says (`applied`, `moved`). */
  status?: string;
  /**
   * The index of an override that names this member's id but, the last regen says, applies to
   * another member or none (`moved`, `lost`): it holds the id, so no override of this member can
   * be added until it is removed. Absent otherwise.
   */
  heldBy?: number;
  /** That override's status. */
  heldStatus?: string;
}

function overridesOf(f: ExtensionFeature): StoredOverride[] {
  const raw = (f.params as Record<string, unknown>).overrides;
  return Array.isArray(raw) ? (raw as StoredOverride[]) : [];
}

/**
 * The wall or opening of the active part that owns a member, by the member's full id, and the
 * override it has. `listed` is what the last regen said of the owner's overrides; an entry counts
 * only while the document still holds the same override at its place (a later edit is not yet
 * framed), and without one the override is found by id.
 */
export function memberOwner(
  doc: ManufaktureDocument,
  partId: string,
  fullId: string,
  listed?: ListedOverrides,
): MemberOwner | null {
  const split = splitMemberFullId(fullId);
  if (!split) return null;
  const part = doc.parts.find((p) => p.id === partId);
  const feature = part?.features.find((f) => f.id === split.owner);
  if (!feature || !(isWall(feature) || isOpening(feature))) return null;
  const overrides = overridesOf(feature);
  const current = (l: ListedOverrides[number]) => overrides[l.n - 1]?.id === l.id;
  const base = { feature, localId: split.id };
  const applying = listed?.find(
    (l) =>
      current(l) &&
      ((l.status === 'applied' && l.member === fullId) ||
        (l.status === 'moved' && l.appliedTo === fullId)),
  );
  if (applying) {
    return {
      ...base,
      override: overrides[applying.n - 1],
      index: applying.n - 1,
      ...status(applying),
    };
  }
  const index = overrides.findIndex((o) => o.id === split.id);
  const own = index >= 0 ? listed?.find((l) => l.n === index + 1 && current(l)) : undefined;
  if (own && own.status !== 'applied') {
    return { ...base, override: undefined, index: -1, heldBy: index, heldStatus: own.status };
  }
  return {
    ...base,
    override: index >= 0 ? overrides[index] : undefined,
    index,
    ...(own ? status(own) : {}),
  };
}

const status = (l: ListedOverrides[number]) => ({ status: l.status });

/** What the last regen says that a member action needs. */
export interface MemberContext {
  /** Where an override of the member should record it is (`overridePosition`). */
  at?: number;
  /** The owner's overrides as framed (`memberListing`). */
  listed?: ListedOverrides;
}

/**
 * The member's context from the last regen: the part's feature results and member sets. Empty
 * when they do not have the owner.
 */
export function memberContext(
  model: ModelStore,
  members: MemberStore,
  partId: string,
  owner: string,
  localId: string,
): MemberContext {
  const features = model.getState().parts.find((p) => p.partId === partId)?.features ?? [];
  const sets = members.getState().parts.get(partId) ?? [];
  const sources = { owner, features, sets };
  const listing = memberListing(sources);
  const at = overridePosition(sources, localId);
  return {
    ...(at === undefined ? {} : { at }),
    ...(listing?.framed ? { listed: listing.overrides } : {}),
  };
}

export type MemberAction =
  { kind: 'delete' } | { kind: 'stock'; stock: string } | { kind: 'restore' };

export type ActionOutcome =
  { ok: true; command: Command; label: string } | { ok: false; message: string };

/**
 * The edit of the owner's overrides that performs `action` on the member (`memberContext` gives
 * `context` from the last regen). The override edited or removed is the one that applies to the
 * member (`memberOwner`), which after a layout change may be one made for another id. `at` is
 * where the member sits along its wall segment as the layout made it (undefined when positions
 * do not apply): stored on a new override, and on an older one that has none. An override keeps
 * the position it was first made with. Restore also removes an override that holds the member's
 * id but applies elsewhere or nowhere (`heldBy`), the only way to free the id.
 */
export function memberActionCommand(
  doc: ManufaktureDocument,
  partId: string,
  fullId: string,
  action: MemberAction,
  context: MemberContext = {},
): ActionOutcome {
  const owner = memberOwner(doc, partId, fullId, context.listed);
  if (!owner) return { ok: false, message: 'This member belongs to no wall or opening here.' };
  const { feature, localId, index, heldBy } = owner;
  const at = context.at;
  const overrides = overridesOf(feature).map((o) => ({ ...o }));
  let expressions: Record<string, StoredExpression> = { ...feature.expressions };
  let label: string;
  if (action.kind === 'restore') {
    const removed = index >= 0 ? index : (heldBy ?? -1);
    if (removed < 0) return { ok: false, message: 'This member has no change to undo.' };
    overrides.splice(removed, 1);
    expressions = renumberMoves(expressions, removed + 1);
    label = `Restore ${fullId}`;
  } else if (heldBy !== undefined) {
    return {
      ok: false,
      message: `An earlier change made for ${localId} no longer applies to it (${owner.heldStatus ?? 'lost'}: the layout changed) and holds its id. Restore removes it; then change this member.`,
    };
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
