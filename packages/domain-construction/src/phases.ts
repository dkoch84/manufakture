// Construction phases (#1213, follow-up 1 of docs/m8-acceptance/remodel-frame.md): which members
// a remodel keeps, adds and takes out.
//
// - **Features**: a wall, opening, floor or roof has a `phase` param, `existing`, `new` or
//   `demolish`. Absent, it is `existing` in a document marked as built
//   (`domains.construction.asBuilt`) and `new` otherwise, so a design that never mentions phases
//   frames, counts and draws as it did before them. The translators record the phase in their
//   metadata (`existing` and `demolish` only; `new` is the absence), a demolished opening cuts
//   nothing and a demolished wall, floor or roof makes no body.
// - **Members**: a group's members are worked out against the frame as built. The member stage
//   frames the group twice: as built (its features that were there: existing and demolished
//   openings) and as designed (what stands after the work: existing and new openings). A member of
//   the design that the as-built frame has too, the same stock and blank length at the same place
//   whoever owns it, is `existing`; any other is `new`; an as-built member the design does not
//   keep is demolished. So moving an existing opening, which is demolishing it and adding a new one
//   at its new place, makes its old framing and the studs where it goes `demolish`, and its new
//   framing and the studs that fill its old place `new`; the studs nobody touched stay
//   `existing`. A new wall, floor or roof is all new; a demolished one all demolished.
// - **Overrides**: a per-member override's `phase` changes its member's afterwards: `demolish`
//   takes it out (listed as demolished), `new` makes it new work (an extra block, a stud put in
//   that was missing: not in the as-built frame, so nothing is demolished for it), `existing`
//   keeps it as built. It applies to the member the override found (`applied`, or `moved` to its
//   `appliedTo`, #1215), and does nothing when the override is lost.
// - **Data**: the members of the design are the set's members, as before: what is built, drawn,
//   rendered, exported and counted. The group's metadata adds `phases`: the full ids of the new
//   members (the others are existing) and the demolished members as data, which regen keeps and
//   sends with the set like the rest of its metadata. `setPhases` reads them back; a set without
//   `phases` (no feature of its group has a phase, no override sets one) is all new.
//
// Contradictions are framed as the wall says and warned on the opening (`phase-contradiction`): a
// new opening in a demolished wall is not framed (the wall comes out), and a demolished opening in
// a new wall takes nothing out (the wall was not there).
//
// Not modelled: patching sheets around a changed opening (sheet faces take their feature's
// phase), the corner and tee studs a neighbour of a demolished or new wall frames against it (a
// group's neighbours frame as they are), a floor's doubled joists under a demolished wall (it
// doubles under every wall in its `dependsOn`), a roof bearing on a demolished wall, and
// replacing a member in place (an override's `new` means the as-built frame lacks it).

import type {
  JsonValue,
  MemberFeature,
  MemberGroupContext,
  MemberOutput,
  MemberWarning,
} from '@manufakture/regen';
import { isObject, own } from '@manufakture/stock';
import {
  OPENING_TYPE,
  WALL_TYPE,
  metadataPhase,
  readOpeningMetadata,
  readWallMetadata,
} from './features/common';
import { readFloorMetadata } from './features/floor';
import { readRoofMetadata } from './features/roof';
import type { MemberOverride } from './framing/wall';
import { memberFullId } from './member-ids';
import { shapeKey, type Member, type Phase } from './members';

export { PHASES, type Phase } from './members';

/** What a phased group's metadata adds (`phases`). */
export interface GroupPhases {
  /** Full ids of the set's members that are new; the others are existing. */
  readonly new: readonly string[];
  /** The as-built members the design takes out. */
  readonly demolished: readonly Member[];
}

/** A set's phases as its readers use them. */
export interface SetPhases {
  /** Whether the group has phases at all (false: every member is new, the default). */
  readonly phased: boolean;
  /** The phase of a member of the set, by full id. */
  phaseOf(fullId: string): 'existing' | 'new';
  /** The members the design takes out, as data. */
  readonly demolished: readonly Member[];
}

const NONE: SetPhases = Object.freeze({
  phased: false,
  phaseOf: () => 'new' as const,
  demolished: [],
});

/** The phases a set's metadata records (`frameWithPhases`); all new when it records none. */
export function setPhases(metadata: unknown): SetPhases {
  if (!isObject(metadata)) return NONE;
  const p = own(metadata, 'phases');
  if (!isObject(p)) return NONE;
  const added = own(p, 'new');
  const demolished = own(p, 'demolished');
  const ids = new Set(Array.isArray(added) ? added.filter((x) => typeof x === 'string') : []);
  return {
    phased: true,
    phaseOf: (id) => (ids.has(id) ? 'new' : 'existing'),
    demolished: Array.isArray(demolished) ? (demolished as Member[]) : [],
  };
}

const fixed = (v: number, digits: number) => {
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

/**
 * A member's place and shape: equal keys are the same piece of lumber where it stands (stock,
 * blank length and cuts as `shapeKey` has them; its placement to 0.01 mm and 1e-5 per axis).
 *
 * Matching by rounded keys, not a tolerance: the two frames a group is matched across come from
 * the same generator on the same inputs but its openings, so a piece both keep is computed by
 * the same arithmetic and agrees far below the rounding. Two values a rounding boundary splits
 * would need to differ by float noise exactly at a 0.01 mm step; the cost of that is a member
 * reported new and demolished at once (never one lost), which the takeoff shows.
 */
export function pieceKey(m: Pick<Member, 'stock' | 'length' | 'cuts' | 'placement'>): string {
  const p = m.placement;
  const v = (x: readonly number[], d: number) => x.map((c) => fixed(c, d)).join(',');
  return `${shapeKey(m)}@${v(p.origin, 2)}|${v(p.x, 5)}|${v(p.y, 5)}`;
}

/** The overrides a feature's metadata holds, whatever its type. */
function overridesOf(f: MemberFeature): readonly MemberOverride[] {
  return (
    readWallMetadata(f.metadata)?.overrides ??
    readOpeningMetadata(f.metadata)?.overrides ??
    readFloorMetadata(f.metadata)?.input.overrides ??
    readRoofMetadata(f.metadata)?.input.overrides ??
    []
  );
}

/** The features whose members the group owns: a wall with its openings, else the feature itself. */
function ownedFeatures(ctx: MemberGroupContext): MemberFeature[] {
  const head = ctx.features.find((f) => f.id === ctx.group.id);
  if (head === undefined) return [];
  if (head.type !== WALL_TYPE) return [head];
  return [
    head,
    ...ctx.features.filter(
      (f) =>
        f.type === OPENING_TYPE &&
        readOpeningMetadata(f.metadata)?.wall === head.id &&
        f.dependsOn.includes(head.id),
    ),
  ];
}

interface Report {
  readonly owner: string;
  readonly id: string;
  readonly status: string;
  readonly appliedTo?: string;
}

/** The override reports a group's metadata holds (`{ overrides: [...] }`). */
function reportsOf(metadata: JsonValue | undefined): Report[] {
  if (!isObject(metadata)) return [];
  const list = own(metadata, 'overrides');
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) =>
    isObject(r) &&
    typeof own(r, 'owner') === 'string' &&
    typeof own(r, 'id') === 'string' &&
    typeof own(r, 'status') === 'string'
      ? [r as unknown as Report]
      : [],
  );
}

type Frame = (ctx: MemberGroupContext) => MemberOutput | { error: string };

/**
 * `frame` with phases: unchanged when no feature the group owns has a phase other than `new` and
 * no override sets one; otherwise the design's members, with `phases` in the metadata (see the
 * top of this file). Pure and deterministic, as the member stage must be.
 */
export function frameWithPhases(
  ctx: MemberGroupContext,
  frame: Frame,
): MemberOutput | { error: string } {
  const owned = ownedFeatures(ctx);
  const phaseOf = new Map(owned.map((f) => [f.id, metadataPhase(f.metadata)]));
  const overridePhases = new Map<string, Phase>();
  for (const f of owned) {
    for (const o of overridesOf(f)) {
      if (o.phase !== undefined) overridePhases.set(`${f.id}\u0000${o.id}`, o.phase);
    }
  }
  const head = phaseOf.get(ctx.group.id) ?? 'new';
  if (overridePhases.size === 0 && [...phaseOf.values()].every((p) => p === 'new')) {
    return frame(ctx);
  }
  // The group's openings that each side frames: the design leaves the demolished ones out, the
  // frame as built the new ones. Features the group does not own (neighbours) stay in both.
  const without = (drop: Phase): MemberGroupContext => ({
    ...ctx,
    features: ctx.features.filter(
      (f) => f.id === ctx.group.id || !phaseOf.has(f.id) || phaseOf.get(f.id) !== drop,
    ),
  });
  const changes = owned.some((f) => f.id !== ctx.group.id && phaseOf.get(f.id) !== 'existing');
  const designCtx = head === 'demolish' ? null : without('demolish');
  const builtCtx =
    head === 'new' ? null : changes || designCtx === null ? without('new') : designCtx;

  const design = designCtx === null ? null : frame(designCtx);
  if (design !== null && 'error' in design) return design;
  let built: MemberOutput | null = null;
  if (builtCtx !== null) {
    if (builtCtx === designCtx) built = design;
    else {
      const r = frame(builtCtx);
      if ('error' in r) return { error: `The frame as built cannot be framed: ${r.error}` };
      built = r;
    }
  }

  // Match the design's members to the as-built frame's by piece.
  const standing = [...((design?.members ?? []) as Member[])];
  const phases = new Map<string, 'existing' | 'new'>();
  const demolished: Member[] = [];
  // As-built members by piece key, and how many of each key the design has matched so far.
  const pool = new Map<string, Member[]>();
  const used = new Map<string, number>();
  if (built !== null && built !== design) {
    for (const m of built.members as Member[]) {
      const key = pieceKey(m);
      const list = pool.get(key);
      if (list) list.push(m);
      else pool.set(key, [m]);
    }
  }
  for (const m of standing) {
    const full = memberFullId(m);
    if (built === null) phases.set(full, 'new');
    else if (built === design) phases.set(full, 'existing');
    else {
      const key = pieceKey(m);
      const matched = used.get(key) ?? 0;
      if (matched < (pool.get(key)?.length ?? 0)) {
        used.set(key, matched + 1);
        phases.set(full, 'existing');
      } else phases.set(full, 'new');
    }
  }
  if (built !== null && built !== design) {
    // What the design does not keep (all of it for a demolished group), in the as-built order.
    const left = new Set([...pool].flatMap(([key, list]) => list.slice(used.get(key) ?? 0)));
    for (const m of built.members as Member[]) if (left.has(m)) demolished.push(m);
  }

  // Overrides that set a member's phase, on the member each found in the design.
  const taken = new Set<string>();
  for (const r of reportsOf(design?.metadata)) {
    const phase = overridePhases.get(`${r.owner}\u0000${r.id}`);
    if (phase === undefined || (r.status !== 'applied' && r.status !== 'moved')) continue;
    const full = memberFullId({ owner: r.owner, id: r.appliedTo ?? r.id });
    if (!phases.has(full)) continue;
    if (phase === 'demolish') taken.add(full);
    else phases.set(full, phase);
  }
  const kept: Member[] = [];
  for (const m of standing) {
    if (taken.has(memberFullId(m))) demolished.push(m);
    else kept.push(m);
  }

  const source = design ?? built!;
  const base = isObject(source.metadata) ? (source.metadata as Record<string, JsonValue>) : {};
  const recorded: GroupPhases = {
    new: kept.map(memberFullId).filter((id) => phases.get(id) === 'new'),
    demolished,
  };
  // Openings whose phase the wall's contradicts: framed as the wall says, with a warning.
  const contradictions: MemberWarning[] = owned.flatMap((f) => {
    const p = phaseOf.get(f.id);
    if (f.id === ctx.group.id) return [];
    if (head === 'demolish' && p === 'new') {
      return [
        {
          feature: f.id,
          code: 'phase-contradiction',
          message: `${f.id} is new in ${ctx.group.id}, which is demolished: it is not framed (the wall comes out).`,
        },
      ];
    }
    if (head === 'new' && p === 'demolish') {
      return [
        {
          feature: f.id,
          code: 'phase-contradiction',
          message: `${f.id} is demolished in ${ctx.group.id}, which is new: nothing comes out (the wall was not there).`,
        },
      ];
    }
    return [];
  });
  return {
    members: kept,
    // A demolished group's as-built layout warnings are about lumber that comes out: none.
    warnings: [...(design === null ? [] : (design.warnings ?? [])), ...contradictions],
    metadata: { ...base, phases: recorded as unknown as JsonValue },
  };
}
