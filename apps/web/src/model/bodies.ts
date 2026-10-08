// The bodies of a part as the app shows them: regen says which bodies exist (and their solids),
// the document holds what the user set on them (`Part.bodies`: name, colour, material) and how
// they are grouped (`Part.bodyGroups`), and the view settings say which are hidden. Everything
// here is derived, so nothing is stored twice.

import {
  BODY_GROUP_COUNTER,
  bodyCreator,
  findMaterial,
  previewIds,
  type BodyGroup,
  type BodyProps,
  type BodyPropsFields,
  type Command,
  type MaterialId,
  type Part,
} from '@manufakture/core';
import type { BodyInput } from '../viewport/bodies';
import type { ModelBody, PartModel } from './model';

/**
 * Default body colours, by body order in the part. The first is the viewport's face colour,
 * so a part with one body looks as it always did.
 */
export const BODY_PALETTE: readonly string[] = [
  '#c2cad3',
  '#8fb8de',
  '#e0b27a',
  '#9ccc9c',
  '#d69ab8',
  '#c9c07a',
  '#8fd0cc',
  '#b8a3d9',
];

/** The viewport id of a part's body: `<part id>/<body id>`. */
export function viewBodyId(partId: string, bodyId: string): string {
  return `${partId}/${bodyId}`;
}

/**
 * The viewport id of a body an assembly instance shows: `<assembly id>/<instance id>/<body id>`
 * (M2 plan, T2.3e). The body id is the source part's (it may hold `/`, as derived bodies do).
 */
export function instanceViewId(assemblyId: string, instanceId: string, bodyId: string): string {
  return `${assemblyId}/${instanceId}/${bodyId}`;
}

/** The assembly, instance and body an instance view id names; null for any other id. */
export function parseInstanceViewId(
  id: string,
): { assemblyId: string; instanceId: string; bodyId: string } | null {
  const m = /^(assembly#[0-9]+)\/(inst#[0-9]+)\/(.+)$/.exec(id);
  return m ? { assemblyId: m[1]!, instanceId: m[2]!, bodyId: m[3]! } : null;
}

/** A body of the active part, with everything the tree, the viewport and export show of it. */
export interface PartBody {
  /** Regen's body id (`extrude#1`). */
  bodyId: string;
  /** Its viewport id (`part#1/extrude#1`). */
  viewId: string;
  creator: string;
  solids: number;
  /** Its own name, or the default one (see `bodyName`). */
  name: string;
  /** The user set the name. */
  named: boolean;
  /** `#rrggbb`: its own colour, or the palette's by body order. */
  color: string;
  /** Its own material, if it has one. */
  ownMaterial: MaterialId | null;
  /** What it is made of: its own material, else the part's; null when neither is set. */
  material: MaterialId | null;
  hidden: boolean;
  /** Its entry in `Part.bodies`, if the user set anything on it. */
  props: BodyProps | undefined;
  /** For the viewport, with its colour. */
  view: BodyInput;
}

/**
 * The name a body goes by when the user has not named it: the part's name for the only body of
 * a part (what a one-body part was called before bodies existed, so its exports keep their
 * names), `Body <n>` by body order otherwise.
 */
export function bodyName(part: Pick<Part, 'name'>, index: number, count: number): string {
  return count === 1 ? part.name : `Body ${index + 1}`;
}

export function bodyColor(props: BodyProps | undefined, index: number): string {
  return props?.color ?? BODY_PALETTE[index % BODY_PALETTE.length]!;
}

/** The bodies of `part` that regen made (`model`), in creator order, with their settings. */
export function partBodies(
  part: Part | undefined,
  model: Pick<PartModel, 'bodies'> | undefined,
  hidden: ReadonlySet<string> = new Set(),
): PartBody[] {
  if (!part || !model) return [];
  const count = model.bodies.length;
  return model.bodies.map((b: ModelBody, i) => {
    const props = part.bodies.find((p) => p.id === b.bodyId);
    const color = bodyColor(props, i);
    const ownMaterial = props?.material ?? null;
    const named = props?.name !== undefined;
    return {
      bodyId: b.bodyId,
      viewId: b.view.id,
      creator: b.creator,
      solids: b.solids,
      name: props?.name ?? bodyName(part, i, count),
      named,
      color,
      ownMaterial,
      material: ownMaterial ?? part.material ?? null,
      hidden: hidden.has(b.view.id),
      props,
      // The first body's colour is left to the viewport's default, which it equals.
      view: i === 0 && props?.color === undefined ? b.view : coloured(b.view, color),
    };
  });
}

// One coloured copy per regen view and colour, so an unchanged body stays the same object and the
// viewport is not rebuilt for a document change that changes nothing it shows.
const colouredViews = new WeakMap<BodyInput, Map<string, BodyInput>>();

function coloured(view: BodyInput, color: string): BodyInput {
  let byColor = colouredViews.get(view);
  if (!byColor) colouredViews.set(view, (byColor = new Map()));
  let out = byColor.get(color);
  if (!out) byColor.set(color, (out = { ...view, color }));
  return out;
}

/** `next`, or `previous` when it holds the same items in the same order. */
export function sameOr<T>(previous: readonly T[] | null, next: readonly T[]): readonly T[] {
  return previous !== null &&
    previous.length === next.length &&
    previous.every((x, i) => x === next[i])
    ? previous
    : next;
}

/** The material a body is made of, as core describes it; null when none is set. */
export function bodyMaterial(body: Pick<PartBody, 'material'>) {
  return body.material === null ? null : (findMaterial(body.material) ?? null);
}

/**
 * The command that changes some of a body's settings (`patch`: a field set to null goes back to
 * its default), or null when nothing changes. One `setBodyProps`, so one undo step.
 */
export function bodyPropsCommand(
  partId: string,
  body: Pick<PartBody, 'bodyId' | 'props'>,
  patch: { [K in keyof BodyPropsFields]?: BodyPropsFields[K] | null },
): Command | null {
  const { id: _id, ...old } = body.props ?? { id: body.bodyId };
  void _id;
  const next: Record<string, unknown> = { ...old };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  if (JSON.stringify(sorted(next)) === JSON.stringify(sorted(old))) return null;
  return {
    type: 'setBodyProps',
    partId,
    bodyId: body.bodyId,
    props: next as BodyPropsFields,
  };
}

function sorted(o: Record<string, unknown>): [string, unknown][] {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}

// Body groups -----------------------------------------------------------------------------------
// A group (`Part.bodyGroups`) is document data: creating, renaming, changing members and deleting
// are undoable commands. Whether a group is hidden is not stored anywhere: a group is hidden when
// its bodies are, so hiding, showing and isolating a group write the per-body hidden state in the
// view settings (M2 plan, decision 5). A member whose body regen did not make (deleted, merged
// away, past the rollback bar) is not shown; it comes back with its body.

/** A group of the active part as the Bodies list shows it. */
export interface PartBodyGroup {
  group: BodyGroup;
  /** Its members that exist in the regen result, in the group's order. */
  members: PartBody[];
  /** Every member shown is hidden (false for a group with none shown). */
  hidden: boolean;
  /** Some members shown are hidden, some not. */
  partlyHidden: boolean;
}

/** The part's groups with their bodies, and the bodies in no group (in body order). */
export function groupBodies(
  part: Pick<Part, 'bodyGroups'> | undefined,
  bodies: readonly PartBody[],
): { groups: PartBodyGroup[]; ungrouped: PartBody[] } {
  const byId = new Map(bodies.map((b) => [b.bodyId, b]));
  const grouped = new Set<string>();
  const groups = (part?.bodyGroups ?? []).map((group): PartBodyGroup => {
    const members: PartBody[] = [];
    for (const id of group.bodies) {
      const b = byId.get(id);
      if (b && !grouped.has(id)) {
        members.push(b);
        grouped.add(id);
      }
    }
    const hiddenCount = members.filter((b) => b.hidden).length;
    return {
      group,
      members,
      hidden: members.length > 0 && hiddenCount === members.length,
      partlyHidden: hiddenCount > 0 && hiddenCount < members.length,
    };
  });
  return { groups, ungrouped: bodies.filter((b) => !grouped.has(b.bodyId)) };
}

/** The group a body is in, if any. */
export function groupOf(part: Pick<Part, 'bodyGroups'>, bodyId: string): BodyGroup | undefined {
  return part.bodyGroups?.find((g) => g.bodies.includes(bodyId));
}

/** `Group <n>`, the first such name no group of the part has. */
export function defaultGroupName(part: Pick<Part, 'bodyGroups'>): string {
  const names = new Set((part.bodyGroups ?? []).map((g) => g.name));
  let n = (part.bodyGroups?.length ?? 0) + 1;
  while (names.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

function batchOf(commands: Command[]): Command | null {
  if (commands.length === 0) return null;
  return commands.length === 1 ? commands[0]! : { type: 'batch', commands };
}

/**
 * Takes `bodyIds` out of every group of the part except `except`: the commands that do it. A body
 * is in one group at most, so joining a group leaves the old one in the same undo step.
 */
function leaveOtherGroups(part: Part, bodyIds: readonly string[], except?: string): Command[] {
  const moving = new Set(bodyIds);
  const out: Command[] = [];
  for (const g of part.bodyGroups ?? []) {
    if (g.id === except || !g.bodies.some((b) => moving.has(b))) continue;
    out.push({
      type: 'setBodyGroup',
      partId: part.id,
      group: { ...g, bodies: g.bodies.filter((b) => !moving.has(b)) },
    });
  }
  return out;
}

/**
 * A new group of `bodyIds` (from other groups too), named `name`, last in the list: one undo
 * step. Its id is the part's next `group#n`.
 */
export function newGroupCommand(
  part: Part,
  bodyIds: readonly string[],
  name: string = defaultGroupName(part),
): { command: Command; groupId: string; name: string } {
  const [groupId] = previewIds(part.nextIds, BODY_GROUP_COUNTER);
  const bodies = [...new Set(bodyIds)];
  const command = batchOf([
    ...leaveOtherGroups(part, bodies),
    { type: 'setBodyGroup', partId: part.id, group: { id: groupId!, name, bodies } },
  ])!;
  return { command, groupId: groupId!, name };
}

/** Renames a group; null when the name does not change. Names are trimmed. */
export function renameGroupCommand(part: Part, groupId: string, name: string): Command | null {
  const g = part.bodyGroups?.find((x) => x.id === groupId);
  const text = name.trim();
  if (!g || text === g.name) return null;
  return { type: 'setBodyGroup', partId: part.id, group: { ...g, name: text } };
}

/** Adds bodies to a group (moving them out of any other); null when none is new to it. */
export function addToGroupCommand(
  part: Part,
  groupId: string,
  bodyIds: readonly string[],
): Command | null {
  const g = part.bodyGroups?.find((x) => x.id === groupId);
  if (!g) return null;
  const have = new Set(g.bodies);
  const added = [...new Set(bodyIds)].filter((b) => !have.has(b));
  if (added.length === 0) return null;
  return batchOf([
    ...leaveOtherGroups(part, added, groupId),
    { type: 'setBodyGroup', partId: part.id, group: { ...g, bodies: [...g.bodies, ...added] } },
  ]);
}

/** Removes bodies from a group (they stay in the part); null when none is in it. */
export function removeFromGroupCommand(
  part: Part,
  groupId: string,
  bodyIds: readonly string[],
): Command | null {
  const g = part.bodyGroups?.find((x) => x.id === groupId);
  const removing = new Set(bodyIds);
  if (!g || !g.bodies.some((b) => removing.has(b))) return null;
  return {
    type: 'setBodyGroup',
    partId: part.id,
    group: { ...g, bodies: g.bodies.filter((b) => !removing.has(b)) },
  };
}

/** Deletes a group; its bodies stay. */
export function deleteGroupCommand(partId: string, groupId: string): Command {
  return { type: 'deleteBodyGroup', partId, groupId };
}

/**
 * The commands that drop, from every group, the bodies the features `gone` make: for a feature
 * delete, in its batch, so the file keeps no member that can never come back and undo restores
 * both. (Members of bodies that only merged or rolled back stay: they return.)
 */
export function pruneGroupsCommands(part: Part, gone: ReadonlySet<string>): Command[] {
  const out: Command[] = [];
  for (const g of part.bodyGroups ?? []) {
    const bodies = g.bodies.filter((b) => {
      const creator = bodyCreator(b);
      return creator === undefined || !gone.has(creator);
    });
    if (bodies.length !== g.bodies.length) {
      out.push({ type: 'setBodyGroup', partId: part.id, group: { ...g, bodies } });
    }
  }
  return out;
}

/**
 * The view ids to hide among `all` so only `keep` are shown: isolating a group, or a body.
 * `setHiddenBodies(documentId, all, isolateHidden(all, keep))`.
 */
export function isolateHidden(all: readonly string[], keep: readonly string[]): string[] {
  const kept = new Set(keep);
  return all.filter((id) => !kept.has(id));
}
