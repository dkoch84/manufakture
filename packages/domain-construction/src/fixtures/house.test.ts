// The T6.5d house (`house.ts`) through regen with the real kernel and Manifold in Node: what it
// builds, that moving a window re-frames one wall, and a CI guard on its regen times.
//
// The guard allows five times T6.5a's budgets (docs/spikes/T6.5a-framing.md, "4. Budgets for
// T6.5d"): CI machines are noisy and run this file next to the rest of the suite, so it catches an
// order-of-magnitude regression only. The budgets themselves are held by the bench
// (`bench/house.bench.ts`, `make bench-house`), on medians in fresh processes.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  type RegenResult,
  type RegenSolver,
} from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConstruction } from '../domain';
import { openingScope } from '../features/opening';
import {
  HOUSE_CONSTRUCTION,
  HOUSE_IDS,
  MOVED_POSITION_IN,
  houseCommands,
  houseFeatures,
  movedWindow,
} from './house';

const PART = 'part#1';

/** T6.5a's house budgets (ms) and the CI margin over them. */
const BUDGET = { framingCold: 150, framingWarm: 10, regenCold: 3_000, regenWarm: 150 };
const CI_MARGIN = 5;

/** The house's members by role, as the generators frame it today. */
const ROLES = {
  blocking: 76,
  'bottom-plate': 29,
  'ceiling-joist': 9,
  'common-rafter': 20,
  corner: 26,
  cripple: 54,
  header: 30,
  'hip-rafter': 4,
  jack: 20,
  'jack-rafter': 112,
  joist: 78,
  king: 20,
  ridge: 1,
  rim: 12,
  'rough-sill': 8,
  stud: 232,
  'top-plate': 63,
};

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

const noSolver: RegenSolver = {
  solve: () => {
    throw new Error('the house has no sketches');
  },
};

function engineFor(): RegenEngine {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  return new RegenEngine({ kernel: service, solver: noSolver, extensions });
}

function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

const house = (): ManufaktureDocument =>
  apply(createDocument({ id: 'house', name: 'House' }), houseCommands(PART));

const windowAt = (doc: ManufaktureDocument, position: number) =>
  apply(doc, { type: 'editFeature', partId: PART, feature: movedWindow(position) });

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

const sets = (r: RegenResult) => r.parts[0]!.members ?? [];
const framingMs = (r: RegenResult) => sets(r).reduce((t, s) => t + s.ms, 0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

async function done(engine: RegenEngine) {
  await engine.dispose();
  await service.idle();
  expect(service.leaks()).toEqual([]);
}

describe('the house fixture', () => {
  it('scopes each opening to its host wall as the app does (openingScope)', () => {
    const features = houseFeatures();
    for (const id of HOUSE_IDS.openings) {
      const opening = features.find((f) => f.id === id)!;
      const host = features.find((f) => f.id === opening.dependsOn[0])!;
      const type = HOUSE_CONSTRUCTION.wallTypes.find((t) => t.id === host.params.wallType);
      expect(opening.scope, id).toEqual(openingScope(host, type));
      expect(opening.scope, id).toHaveLength(2);
    }
  });
});

describe('the house fixture through regen with the real kernel', () => {
  it('builds every feature: 794 members in 14 groups and 28 layer bodies', async () => {
    const engine = engineFor();
    const result = await regen(engine, house());
    const features = result.parts[0]!.features;
    expect(features.map((f) => f.featureId)).toEqual(houseFeatures().map((f) => f.id));
    for (const f of features) {
      expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
      // Only the roof warns: the rule of thumb on its birdsmouths (2x8 rafters at 6/12 on a 2x6
      // wall's 5-1/2" seat).
      if (f.featureId !== HOUSE_IDS.roof) expect(f.warnings, f.featureId).toEqual([]);
    }
    const roles: Record<string, number> = {};
    for (const s of sets(result))
      for (const m of s.members ?? []) roles[m.role] = (roles[m.role] ?? 0) + 1;
    expect(roles).toEqual(ROLES);
    // Part 1's estimate for a 2,000 sq ft house: 800 to 1,000 members (the spike's had 834).
    expect(sets(result).reduce((t, s) => t + s.count, 0)).toBe(794);
    // A group per wall (with its openings), per floor and for the roof.
    expect(sets(result).map((s) => s.group)).toEqual([
      ...HOUSE_IDS.exterior,
      ...HOUSE_IDS.interior,
      ...HOUSE_IDS.floors,
      HOUSE_IDS.roof,
    ]);
    // Two layers per wall, a subfloor per floor, four roof planes.
    expect(result.parts[0]!.bodies).toHaveLength(11 * 2 + 2 + 4);
    // Mesh sharing: far fewer shapes than members, and every Manifold object deleted.
    expect(engine.memberStats.meshes).toBeLessThan(100);
    expect(engine.memberStats.manifoldDeleted).toBe(engine.memberStats.manifoldCreated);
    await done(engine);
  }, 120_000);

  it('moving a window rebuilds that opening and re-frames only its wall', async () => {
    const engine = engineFor();
    const base = house();
    await regen(engine, base);
    const moved = await regen(engine, windowAt(base, MOVED_POSITION_IN + 12));
    const rebuilt = moved.parts[0]!.features.filter((f) => !f.cached).map((f) => f.featureId);
    // The moved window and the one opening after it in the same wall, which cuts the bodies the
    // moved one changed. Each opening is scoped to its host's layer bodies, so the openings of the
    // other walls, and every wall, floor and the roof, stay cached.
    expect(rebuilt).toEqual([HOUSE_IDS.moved, HOUSE_IDS.openings[2]]);
    const reframed = sets(moved).filter((s) => !s.cached);
    expect(reframed.map((s) => s.group)).toEqual([HOUSE_IDS.exterior[0]]);
    expect(reframed[0]!.changed).toBe(true);
    await done(engine);
  }, 120_000);

  it(`regenerates within ${CI_MARGIN} times the T6.5a budgets (a CI guard)`, async () => {
    const engine = engineFor();
    const base = house();
    const cold = await regen(engine, base);
    const regenWarm: number[] = [];
    const framingWarm: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = MOVED_POSITION_IN + (i % 2 === 0 ? 12 : 0) + (i + 1) / 64;
      const r = await regen(engine, windowAt(base, at));
      regenWarm.push(r.ms);
      framingWarm.push(framingMs(r));
    }
    const measured = {
      regenCold: cold.ms,
      framingCold: framingMs(cold),
      regenWarm: median(regenWarm),
      framingWarm: median(framingWarm),
    };
    for (const [key, ms] of Object.entries(measured)) {
      const limit = BUDGET[key as keyof typeof BUDGET] * CI_MARGIN;
      expect(ms, `${key}: ${ms.toFixed(1)} ms against ${limit} ms`).toBeLessThan(limit);
    }
    await done(engine);
  }, 120_000);
});
