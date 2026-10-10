// The construction domain as regen registers it (ADR 0013 decisions 1 and 5, ADR 0015 decision 1):
// namespace `construction`, the reader of the document data it owns (`domains.construction`), and
// `reads: ['stock']` for the shared stock overrides, the wall and opening types (T6.1b) and the
// member stage that frames each wall with its openings (ADR 0015 decision 5), the floor and roof
// types (T6.1c), each framed as a group of its own, and its drawing views (T6.4a: floor plans,
// framing elevations, roof framing plans). The app's regen worker entry calls
// `registerConstruction(registry)` at start-up; regen imports no domain package.

import type {
  ExtensionDomain,
  ExtensionRegistry,
  ExtensionType,
  MemberStage,
} from '@manufakture/regen';
import { STOCK_NAMESPACE, registerStock, type Json } from '@manufakture/stock';
import { CONSTRUCTION_DATA_VERSION, CONSTRUCTION_NAMESPACE, readConstructionData } from './data';
import { constructionDrawings } from './drawings/views';
import { FLOOR_TYPE, floorGroups, floorType, frameFloorGroup } from './features/floor';
import { OPENING_TYPE, openingType } from './features/opening';
import { ROOF_TYPE, frameRoofGroup, roofGroups, roofType } from './features/roof';
import { constructionMemberStage, frameConstructionGroup } from './features/stage';
import { WALL_TYPE, wallType } from './features/wall';
import { frameWithPhases } from './phases';

/**
 * Bump with any change that can alter what a translator or the member stage returns, so results
 * built by older domain code are never served from regen's cache (ADR 0004 decision 8).
 */
export const CONSTRUCTION_IMPLEMENTATION = 2;

/**
 * The domain's member stage: each wall with its openings (`stage.ts`), then each floor and each
 * roof on its own. Group ids are feature ids, so they never collide. Each group is framed with
 * its phases (`phases.ts`, #1213): as built and as designed when any of its features has a phase.
 */
export const constructionMembers: MemberStage = {
  groups(ctx) {
    return [...constructionMemberStage.groups(ctx), ...floorGroups(ctx), ...roofGroups(ctx)];
  },
  frame(ctx) {
    const type = ctx.features.find((f) => f.id === ctx.group.id)?.type;
    if (type === FLOOR_TYPE) return frameWithPhases(ctx, frameFloorGroup);
    if (type === ROOF_TYPE) return frameWithPhases(ctx, frameRoofGroup);
    return frameWithPhases(ctx, frameConstructionGroup);
  },
};

/** The domain definition: what `registerConstruction` registers. */
export const constructionDomain: ExtensionDomain = {
  namespace: CONSTRUCTION_NAMESPACE,
  implementation: CONSTRUCTION_IMPLEMENTATION,
  reads: [STOCK_NAMESPACE],
  data: {
    [CONSTRUCTION_NAMESPACE]: {
      schemaVersion: CONSTRUCTION_DATA_VERSION,
      read: (data, schemaVersion) => readConstructionData(data as Json, schemaVersion),
    },
  },
  types: {
    [WALL_TYPE]: wallType as ExtensionType,
    [OPENING_TYPE]: openingType as ExtensionType,
    [FLOOR_TYPE]: floorType as ExtensionType,
    [ROOF_TYPE]: roofType as ExtensionType,
  },
  members: constructionMembers,
  drawings: constructionDrawings,
};

/**
 * Register the construction domain on a regen registry, and the shared stock reader unless it is
 * already there. Returns a function that unregisters the construction domain; the stock reader
 * stays, since other domains may read `stock` too.
 */
export function registerConstruction(
  registry: Pick<ExtensionRegistry, 'registerDomain' | 'reader'>,
): () => void {
  registerStock(registry);
  return registry.registerDomain(constructionDomain);
}
