// The members of one feature as data (#1218, follow-up 6 of docs/m8-acceptance/remodel-frame.md):
// what an agent reads instead of diffing takeoff row sources or guessing render patterns. For a
// wall, an opening, a floor or a roof: each member it owns (full and local id, role, stock, blank
// length, where it sits along its wall and above the wall's base, and whether its `add` params
// add it, #1214), and each per-member override its params hold, with the status the last framing
// gave it.
//
// With phases (#1213, `phases.ts`), each member says whether it is existing or new, the feature
// its own phase, and the members the design takes out are listed apart, as `demolished`.
//
// Plain data in, plain data out: the caller passes the part's feature results (for the metadata
// the translators returned) and the member sets as the last regen left them (members, and the
// group metadata whose `overrides` list carries each override's status and whose `phases` the
// members' phases).

import type { FeatureResult } from '@manufakture/regen';
import {
  metadataPhase,
  readOpeningMetadata,
  readWallMetadata,
  planSegments,
  type P2,
} from './features/common';
import type { PlanSegment, WallMetadata } from './features/common';
import { readFloorMetadata } from './features/floor';
import { readRoofMetadata } from './features/roof';
import type { MemberOverride } from './framing/wall';
import { memberFullId, parseAddedMemberId, parseWallMemberId } from './member-ids';
import { memberCorners, type Phase, type StockRef } from './members';
import { setPhases } from './phases';
import type { Placement, Vec3 } from './geom';

/**
 * What became of an override in the last framing. `applied`: it found its member; `moved` (#1215):
 * it carries `at` and its member's id changed (a spacing, origin or direction change renumbered a
 * wall's layout), so it applied to the member now where its member was (`appliedTo`); `lost`: it
 * found none (the owner no longer has that member, nothing is at its position, or the owner is
 * not framed). Later statuses may be added; readers should treat an unknown status as "not
 * applied as written".
 */
export type MemberOverrideStatus = 'applied' | 'moved' | 'lost';

/** One member as listed. Lengths are mm. */
export interface ListedMember {
  /** The full id, `<owner>:<local>` (`extension#2:s4`). */
  readonly id: string;
  /** The local id (`s4`, `king-l`, `top1:2`). */
  readonly local: string;
  readonly role: string;
  readonly stock: { readonly id: string; readonly name: string };
  /** The blank length, before any cut. */
  readonly length: number;
  /** The centre of its blank, world mm. */
  readonly centre: Vec3;
  /**
   * Wall and opening members: where it sits along its wall segment, from the segment's first
   * point (as an opening's `position` is measured): its extent and its centre. Null otherwise.
   */
  readonly along: {
    readonly segment: number;
    readonly from: number;
    readonly to: number;
    readonly centre: number;
  } | null;
  /** Wall and opening members: its extent above the wall's base (as an opening's sill). */
  readonly above: { readonly from: number; readonly to: number } | null;
  /** Present on a member the owner's `add` params add (`add3`, `add3-2`): its layout does not. */
  readonly added?: true;
  /**
   * Its phase (#1213): `existing` or `new` for a member of the design (`new` when the group has
   * no phases), `demolish` for one of `MemberListing.demolished`.
   */
  readonly phase: Phase;
}

/** One override the owner's params hold, in their order. */
export interface ListedOverride {
  /** 1-based: the override's `move_<n>` expression nudges it. */
  readonly n: number;
  /** The local member id it names. */
  readonly id: string;
  /** The full member id it names. */
  readonly member: string;
  readonly status: MemberOverrideStatus;
  /** `moved` only: the full id of the member it applied to. */
  readonly appliedTo?: string;
  /** Where its member was when it was made (#1215), along the wall segment, mm; absent if unknown. */
  readonly at?: number;
  readonly delete?: true;
  /** The stock id it changes the member to. */
  readonly stock?: string;
  /** How far it moves the member along the wall (or across a floor or roof), mm. */
  readonly move?: number;
  /** The phase it gives the member (#1213). */
  readonly phase?: Phase;
}

export type MemberOwnerKind = 'wall' | 'opening' | 'floor' | 'roof';

export interface MemberListing {
  readonly owner: string;
  readonly kind: MemberOwnerKind;
  /** An opening's host wall and segment. */
  readonly wall?: string;
  readonly segment?: number;
  /** The framing group the members come from (a wall's id for its openings too). */
  readonly group: string;
  /** False when the last regen has no members for the group (it failed, or did not run). */
  readonly framed: boolean;
  /** The feature's phase (#1213): its `phase` param, or the document's default. */
  readonly phase: Phase;
  /** How many members the owner has (in the design: demolished ones are not counted). */
  readonly count: number;
  /** Sorted along the wall (segment, then centre, then height), else in framing order. */
  readonly members: readonly ListedMember[];
  /** Members of the owner the design takes out (#1213), sorted as `members`; phase `demolish`. */
  readonly demolished: readonly ListedMember[];
  readonly overrides: readonly ListedOverride[];
}

/** A member as regen and the generators give it (role a string, as regen's `MemberData`). */
export interface ListableMember {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly stock: StockRef;
  readonly length: number;
  readonly placement: Placement;
}

/** A member set: its group, its members and the metadata the member stage returned for it. */
export interface ListableSet {
  readonly group: string;
  readonly members: readonly ListableMember[];
  readonly metadata?: unknown;
}

export interface MemberListingSources {
  readonly owner: string;
  /** The part's feature results, with their metadata. */
  readonly features: readonly Pick<FeatureResult, 'featureId' | 'metadata'>[];
  /** The part's construction member sets, as the last regen left them. */
  readonly sets: readonly ListableSet[];
}

interface Owner {
  readonly kind: MemberOwnerKind;
  readonly group: string;
  readonly overrides: readonly MemberOverride[];
  readonly wall?: WallMetadata;
  readonly host?: string;
  readonly segment?: number;
}

function ownerOf(owner: string, features: MemberListingSources['features']): Owner | undefined {
  const metadata = features.find((f) => f.featureId === owner)?.metadata;
  const wall = readWallMetadata(metadata);
  if (wall) return { kind: 'wall', group: owner, overrides: wall.overrides ?? [], wall };
  const opening = readOpeningMetadata(metadata);
  if (opening) {
    const host = readWallMetadata(features.find((f) => f.featureId === opening.wall)?.metadata);
    return {
      kind: 'opening',
      group: opening.wall,
      overrides: opening.overrides ?? [],
      ...(host === undefined ? {} : { wall: host }),
      host: opening.wall,
      segment: opening.segment,
    };
  }
  const floor = readFloorMetadata(metadata);
  if (floor) return { kind: 'floor', group: owner, overrides: floor.input.overrides ?? [] };
  const roof = readRoofMetadata(metadata);
  if (roof) return { kind: 'roof', group: owner, overrides: roof.input.overrides ?? [] };
  return undefined;
}

interface Status {
  readonly status: MemberOverrideStatus;
  readonly appliedTo?: string;
}

/** The statuses a group's metadata reports (`{ overrides: [{ owner, id, status, appliedTo? }] }`). */
function statusesOf(metadata: unknown, owner: string): Map<string, Status> {
  const out = new Map<string, Status>();
  const list = (metadata as { overrides?: unknown } | null | undefined)?.overrides;
  if (!Array.isArray(list)) return out;
  for (const r of list as unknown[]) {
    const o = r as { owner?: unknown; id?: unknown; status?: unknown; appliedTo?: unknown } | null;
    if (o === null || typeof o !== 'object') continue;
    if (o.owner !== owner || typeof o.id !== 'string' || typeof o.status !== 'string') continue;
    out.set(o.id, {
      status: o.status as MemberOverrideStatus,
      ...(typeof o.appliedTo === 'string' ? { appliedTo: o.appliedTo } : {}),
    });
  }
  return out;
}

const round = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

const along = (p: P2, s: PlanSegment) => (p[0] - s.a[0]) * s.d[0] + (p[1] - s.a[1]) * s.d[1];

/** The segment a member lies along: its id's for a wall member, the opening's, else the nearest. */
function segmentOf(
  m: ListableMember,
  owner: Owner,
  segments: readonly PlanSegment[],
  centre: Vec3,
): number {
  if (owner.kind === 'opening' && owner.segment !== undefined) return owner.segment;
  const parsed = owner.kind === 'wall' ? parseWallMemberId(m.id) : undefined;
  if (parsed !== undefined && parsed.segment <= segments.length) return parsed.segment;
  const add = parseAddedMemberId(m.id);
  if (owner.kind === 'wall' && add !== undefined) {
    const segment = owner.wall?.add?.find((a) => a.id === `add${add.entry}`)?.segment ?? 1;
    if (segment <= segments.length) return segment;
  }
  let best = 1;
  let distance = Infinity;
  segments.forEach((s, i) => {
    const t = Math.min(Math.max(along([centre[0], centre[1]], s), 0), s.length);
    const d = Math.hypot(s.a[0] + s.d[0] * t - centre[0], s.a[1] + s.d[1] * t - centre[1]);
    if (d < distance) {
      distance = d;
      best = i + 1;
    }
  });
  return best;
}

function listed(
  m: ListableMember,
  owner: Owner,
  segments: readonly PlanSegment[],
  phase: Phase,
): ListedMember {
  const corners = memberCorners(m);
  const centre = corners
    .reduce<Vec3>((c, p) => [c[0] + p[0] / 8, c[1] + p[1] / 8, c[2] + p[2] / 8], [0, 0, 0])
    .map(round) as unknown as Vec3;
  const base = {
    id: memberFullId(m),
    local: m.id,
    role: m.role,
    stock: { id: m.stock.id, name: m.stock.name },
    length: round(m.length),
    centre,
    ...(parseAddedMemberId(m.id) === undefined ? {} : { added: true as const }),
    phase,
  };
  if (owner.wall === undefined || segments.length === 0) {
    return { ...base, along: null, above: null };
  }
  const segment = segmentOf(m, owner, segments, centre);
  const s = segments[segment - 1]!;
  const t = corners.map((p) => along([p[0], p[1]], s));
  const z = corners.map((p) => p[2] - owner.wall!.base);
  return {
    ...base,
    along: {
      segment,
      from: round(Math.min(...t)),
      to: round(Math.max(...t)),
      centre: round(along([centre[0], centre[1]], s)),
    },
    above: { from: round(Math.min(...z)), to: round(Math.max(...z)) },
  };
}

/**
 * The members `owner` owns and the overrides its params hold; undefined when it is not a built
 * construction wall, opening, floor or roof of the part.
 */
export function memberListing(src: MemberListingSources): MemberListing | undefined {
  const owner = ownerOf(src.owner, src.features);
  if (owner === undefined) return undefined;
  const set = src.sets.find((s) => s.group === owner.group);
  const segments = owner.wall ? planSegments(owner.wall.points, owner.wall.closed) : [];
  const phases = setPhases(set?.metadata);
  const members = (set?.members ?? [])
    .filter((m) => m.owner === src.owner)
    .map((m) => listed(m, owner, segments, phases.phaseOf(memberFullId(m))));
  const demolished = phases.demolished
    .filter((m) => m.owner === src.owner)
    .map((m) => listed(m, owner, segments, 'demolish'));
  if (owner.wall !== undefined) {
    for (const list of [members, demolished]) {
      list.sort(
        (a, b) =>
          a.along!.segment - b.along!.segment ||
          a.along!.centre - b.along!.centre ||
          a.above!.from - b.above!.from ||
          a.local.localeCompare(b.local),
      );
    }
  }
  const statuses = statusesOf(set?.metadata, src.owner);
  const overrides = owner.overrides.map((o, i): ListedOverride => {
    const s = set === undefined ? undefined : statuses.get(o.id);
    return {
      n: i + 1,
      id: o.id,
      member: memberFullId({ owner: src.owner, id: o.id }),
      status: s?.status ?? 'lost',
      ...(s?.appliedTo === undefined
        ? {}
        : { appliedTo: memberFullId({ owner: src.owner, id: s.appliedTo }) }),
      ...(o.at === undefined ? {} : { at: round(o.at) }),
      ...(o.delete ? { delete: true as const } : {}),
      ...(o.stock === undefined ? {} : { stock: o.stock.id }),
      ...(o.move === undefined || o.move === 0 ? {} : { move: round(o.move) }),
      ...(o.phase === undefined ? {} : { phase: o.phase }),
    };
  });
  return {
    owner: src.owner,
    kind: owner.kind,
    ...(owner.host === undefined ? {} : { wall: owner.host, segment: owner.segment! }),
    group: owner.group,
    framed: set !== undefined,
    phase: metadataPhase(src.features.find((f) => f.featureId === src.owner)?.metadata),
    count: members.length,
    members,
    demolished,
    overrides,
  };
}

/**
 * The `at` an override of the member `local` of `src.owner` should store (#1215): where the
 * member sits along its wall segment as the layout made it (its listed centre, less the nudge of
 * an override that already applies to it), mm from the segment's first point. Undefined when
 * positions do not apply (not a wall's own layout stud `s<k>` or block `block<r>:<n>`) or the
 * member is not in the last framing. What the app writes when it makes an override; an agent
 * reads the same number as the member's `along.centre` before overriding it.
 */
export function overridePosition(src: MemberListingSources, local: string): number | undefined {
  const form = parseWallMemberId(local)?.form;
  if (form !== 'slot' && form !== 'block') return undefined;
  const listing = memberListing(src);
  if (listing === undefined || listing.kind !== 'wall') return undefined;
  const m = listing.members.find((x) => x.local === local);
  if (m?.along == null) return undefined;
  const full = memberFullId({ owner: src.owner, id: local });
  const applying = listing.overrides.find(
    (o) =>
      (o.status === 'applied' && o.member === full) ||
      (o.status === 'moved' && o.appliedTo === full),
  );
  return round(m.along.centre - (applying?.move ?? 0));
}
