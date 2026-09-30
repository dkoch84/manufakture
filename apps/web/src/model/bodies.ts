// The bodies of a part as the app shows them: regen says which bodies exist (and their solids),
// the document holds what the user set on them (`Part.bodies`: name, colour, material), and the
// view settings say which are hidden. Everything here is derived, so nothing is stored twice.

import {
  findMaterial,
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
