// The construction member stage (ADR 0015 decision 5): after a part's features regenerate, regen
// asks it which features frame together, then frames each group with the pure generators.
//
// A group is a wall (named after it), with every built opening whose host it is, plus the walls it
// meets at corners and tees or crosses: they decide where its framing stops and where its tee
// studs go, so they are part of its cache key. Members belong to the wall and to its openings
// (decision 6), never to a neighbour. Moving an opening changes only its wall's group.

import type {
  JsonValue,
  MemberFeature,
  MemberGroup,
  MemberGroupContext,
  MemberOutput,
  MemberStage,
  MemberStageContext,
  MemberWarning,
} from '@manufakture/regen';
import {
  FramingInputError,
  frameWall,
  type FramingWarning,
  type MemberOverride,
  type OpeningReport,
  type OverrideReport,
  type WallOpening,
} from '../framing/wall';
import { parseWallMemberId } from '../member-ids';
import {
  OPENING_TYPE,
  WALL_TYPE,
  readOpeningMetadata,
  readWallMetadata,
  toJson,
  type OpeningMetadata,
} from './common';
import { framedWall, wallGraph, type GraphWall } from './graph';

/** What a wall's group reports (`MemberSetResult.metadata`): which header each opening used. */
export interface WallGroupMetadata {
  readonly openings: readonly (OpeningReport & { readonly header: { readonly source: string } })[];
  /** Each override's status; `appliedTo` on a `moved` one (#1215). */
  readonly overrides: readonly OverrideReport[];
}

function walls(features: readonly MemberFeature[]): GraphWall[] {
  return features.flatMap((f) => {
    if (f.type !== WALL_TYPE) return [];
    const meta = readWallMetadata(f.metadata);
    return meta === undefined ? [] : [{ id: f.id, meta }];
  });
}

function openingsOf(
  features: readonly MemberFeature[],
  wall: string,
): { id: string; meta: OpeningMetadata }[] {
  return features.flatMap((f) => {
    if (f.type !== OPENING_TYPE) return [];
    const meta = readOpeningMetadata(f.metadata);
    return meta !== undefined && meta.wall === wall && f.dependsOn.includes(wall)
      ? [{ id: f.id, meta }]
      : [];
  });
}

/** Wall groups: each wall with its openings, then its neighbours in the wall graph. */
export function constructionGroups(ctx: MemberStageContext): MemberGroup[] {
  const all = walls(ctx.features);
  const graph = wallGraph(all);
  return all.map((w) => ({
    id: w.id,
    features: [
      w.id,
      ...openingsOf(ctx.features, w.id).map((o) => o.id),
      ...[...graph.neighbours.get(w.id)!].sort(),
    ],
  }));
}

const RULE_OF_THUMB = 'Rule of thumb: ';

/** One wall's members: `frameWall` on its framed segments, with its openings on them. */
export function frameConstructionGroup(ctx: MemberGroupContext): MemberOutput | { error: string } {
  const all = walls(ctx.features);
  const wall = all.find((w) => w.id === ctx.group.id);
  if (wall === undefined) return { error: `${ctx.group.id} reports no wall geometry` };
  const graph = wallGraph(all);
  const crossing = graph.crossings.find(([a, b]) => a === wall.id || b === wall.id);
  if (crossing !== undefined) {
    const other = crossing[0] === wall.id ? crossing[1] : crossing[0];
    return {
      error: `${wall.id} crosses ${other} away from their ends: walls meet at their ends or where one ends on the other; split one of them there`,
    };
  }
  const framed = framedWall(graph, wall);
  // Positions in params are from the segment's first path point, as an opening's position is.
  const shift = (segment: number) => framed.shifts[segment - 1] ?? 0;
  const overrides = wall.meta.overrides.map((o): MemberOverride =>
    o.at === undefined ? o : { ...o, at: o.at - shift(parseWallMemberId(o.id)?.segment ?? 1) },
  );
  const openings = openingsOf(ctx.features, wall.id);
  const bySegment = new Map<number, WallOpening[]>();
  const defaults = new Set<string>();
  for (const { id, meta } of openings) {
    const shift = framed.shifts[meta.segment - 1];
    if (shift === undefined) continue;
    if (meta.header.kind === 'default') defaults.add(id);
    const opening: WallOpening = {
      id,
      position: meta.position - shift,
      width: meta.width,
      height: meta.height,
      sill: meta.sill,
      ...(meta.header.kind === 'explicit'
        ? { header: meta.header.header }
        : meta.header.kind === 'default'
          ? { header: wall.meta.settings.defaultHeader }
          : {}),
      ...(meta.kings === undefined ? {} : { kings: meta.kings }),
      ...(meta.jacks === undefined ? {} : { jacks: meta.jacks }),
      ...(meta.overrides.length === 0 ? {} : { overrides: meta.overrides }),
      ...(meta.add === undefined || meta.add.length === 0 ? {} : { add: meta.add }),
    };
    const list = bySegment.get(meta.segment) ?? [];
    list.push(opening);
    bySegment.set(meta.segment, list);
  }
  let result;
  try {
    result = frameWall({
      wall: wall.id,
      segments: framed.segments.map((s, i) => {
        const list = bySegment.get(i + 1);
        return list === undefined ? s : { ...s, openings: list };
      }),
      settings: wall.meta.settings,
      ...(overrides.length === 0 ? {} : { overrides }),
      ...(wall.meta.add === undefined || wall.meta.add.length === 0
        ? {}
        : {
            add: wall.meta.add.map((a) => ({ ...a, at: a.at - shift(a.segment ?? 1) })),
          }),
    });
  } catch (error) {
    if (error instanceof FramingInputError) return { error: error.message };
    throw error;
  }
  const owners = new Set([wall.id, ...openings.map((o) => o.id)]);
  const warnings: MemberWarning[] = [
    ...graph.warnings
      .filter((w) => w.wall === wall.id)
      .map((w) => ({ feature: wall.id, message: w.message, code: w.code })),
    ...result.warnings.map((w: FramingWarning) => ({
      feature: w.opening !== undefined && owners.has(w.opening) ? w.opening : wall.id,
      message: w.kind === 'rule-of-thumb' ? `${RULE_OF_THUMB}${w.message}` : w.message,
      code: w.code,
      ...(w.member === undefined ? {} : { member: w.member }),
    })),
  ];
  const metadata: WallGroupMetadata = {
    // An opening that asked for the wall type's default reports it as such, not as its own.
    openings: result.openings.map((o) =>
      defaults.has(o.id) ? { ...o, header: { ...o.header, source: 'default' } } : o,
    ),
    overrides: result.overrides,
  };
  return { members: result.members, warnings, metadata: toJson(metadata) as JsonValue };
}

/** The construction domain's member stage, as `ExtensionDomain.members` takes it. */
export const constructionMemberStage: MemberStage = {
  groups(ctx) {
    return constructionGroups(ctx);
  },
  frame(ctx) {
    return frameConstructionGroup(ctx);
  },
};
