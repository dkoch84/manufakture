// The M8 plan's fixtures as documents built from commands and regenerated in Node on the real
// kernel (`createNodeService`) and solver, with the domains the app's regen worker registers, as
// the T8.0b spike built them (spikes/T8.0b-render/src/fixtures.ts):
//
// - the M1 bracket (docs/m1-acceptance.md): an L profile 50 x 40 mm, 6 mm thick, extruded 30 mm
//   symmetric, two M4 counterbored holes through the foot and a 4 mm fillet in the inside corner.
//   The app's e2e test builds it through the UI (apps/web/e2e/bracket.ts); these are its numbers.
// - a cabinet: the M4 bookshelf's construction (apps/web/e2e/m4-fixtures.ts) cut down to two
//   plywood sides, a bottom, a top and a shelf in rabbets and a dado, and a 1/4" back, 24" wide.
//   The bookshelf's own batch needs the face frame, configurations and the e2e helpers; this
//   keeps the same boards and joints without them.
// - the M6 shed (apps/web/e2e/shed-fixture.ts): the 12' x 16' framed shed, the same batch.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { registerConstruction } from '@manufakture/domain-construction';
import { registerWood } from '@manufakture/domain-wood';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  type MemberMesh,
  type RegenResult,
} from '@manufakture/regen';
import { createSolverService } from '@manufakture/sketch';

const PART = 'part#1';

function build(name: string, commands: readonly unknown[]): ManufaktureDocument {
  let doc = createDocument({ id: `doc-${name.toLowerCase()}`, name });
  for (const c of commands) {
    const r = applyCommand(doc, c as Command);
    if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const mm = (v: number | string) => ({ source: String(v), lengthUnit: 'mm', angleUnit: 'deg' });
const IN = (v: number | string) => ({ source: String(v), lengthUnit: 'in', angleUnit: 'deg' });
const inch = (x: number) => x * 25.4;

const line = (id: string, a: [number, number], b: [number, number]) => ({
  id,
  kind: 'line',
  construction: false,
  start: a,
  end: b,
});

const feature = (f: Record<string, unknown>) => ({
  type: 'addFeature',
  partId: PART,
  feature: { suppressed: false, ...f },
});

// Bracket ---------------------------------------------------------------------------------------

export function bracketDocument(): ManufaktureDocument {
  const [L, H, W, R, t] = [50, 40, 30, 4, 6];
  const holes = [25, 40];
  // On Front (XZ): sketch x is world X, sketch y is world Z.
  const front = { type: 'plane', origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
  const footTop = { type: 'plane', origin: [0, 0, t], normal: [0, 0, 1], xDir: [1, 0, 0] };
  return build('Bracket', [
    { type: 'setVariable', name: 'thickness', expression: mm(`${t} mm`) },
    feature({
      id: 'sketch#1',
      kind: 'sketch',
      name: 'Profile',
      plane: front,
      entities: [
        line('e1', [0, 0], [L, 0]),
        line('e2', [L, 0], [L, t]),
        line('e3', [L, t], [t, t]),
        line('e4', [t, t], [t, H]),
        line('e5', [t, H], [0, H]),
        line('e6', [0, H], [0, 0]),
      ],
      constraints: [],
    }),
    feature({
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Extrude 1',
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'symmetric', distance: mm(W) },
      reverse: false,
    }),
    feature({
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Hole centres',
      plane: footTop,
      entities: holes.map((x, i) => ({
        id: `e${i + 7}`,
        kind: 'point',
        construction: false,
        position: [x, 0],
      })),
      constraints: [],
    }),
    feature({
      id: 'hole#1',
      kind: 'hole',
      name: 'M4 holes',
      sketch: 'sketch#2',
      points: holes.map((_, i) => `e${i + 7}`),
      diameter: mm(4.5),
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: mm(8), depth: mm(4.4) },
      standard: { size: 'M4', fit: 'normal' },
    }),
    feature({
      id: 'fillet#1',
      kind: 'fillet',
      name: 'Fillet 1',
      edges: [{ id: 'r1', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
      radius: mm(R),
    }),
  ]);
}

// Cabinet ---------------------------------------------------------------------------------------

type V3 = [number, number, number];

/** A rectangle sketch from (x0, y0), w by h inches, on a plane through `origin` (inches). */
function rectangle(
  id: string,
  name: string,
  origin: V3,
  normal: V3,
  xDir: V3,
  first: number,
  at: { x0: number; y0: number; w: number; h: number },
) {
  const c: [number, number][] = [
    [at.x0, at.y0],
    [at.x0 + at.w, at.y0],
    [at.x0 + at.w, at.y0 + at.h],
    [at.x0, at.y0 + at.h],
  ].map(([x, y]) => [inch(x!), inch(y!)]);
  return feature({
    id,
    kind: 'sketch',
    name,
    plane: { type: 'plane', origin: origin.map(inch), normal, xDir },
    entities: c.map((start, i) => line(`e${first + i}`, start, c[(i + 1) % 4]!)),
    constraints: [],
  });
}

const panel = (id: string, name: string, sketch: string, stock: string) =>
  feature({
    id,
    kind: 'extension',
    name,
    extension: 'wood.board',
    schemaVersion: 1,
    operation: 'new',
    dependsOn: [sketch],
    references: [],
    expressions: {},
    params: { form: 'panel', stock, sketch },
  });

const joint = (id: string, kind: 'dado' | 'rabbet', a: string, b: string) =>
  feature({
    id,
    kind: 'extension',
    name: `${kind === 'dado' ? 'Dado' : 'Rabbet'} ${id.slice('extension#'.length)}`,
    extension: 'wood.joint',
    schemaVersion: 1,
    dependsOn: [a, b],
    scope: [a, b],
    references: [],
    expressions: {},
    params: { kind, a, b },
  });

export const CABINET = {
  width: 24,
  height: 30,
  depth: 11.25,
  /** 3/4" and 1/4" plywood, actual. */
  ply: 23 / 32,
  back: 7 / 32,
  /** How far the panels reach into the sides. */
  dado: 1 / 4,
  shelf: 14,
};

export function cabinetDocument(): ManufaktureDocument {
  const { width: W, height: H, depth: D, ply: t, back: b, dado: d, shelf } = CABINET;
  const x0 = t - d;
  const across = W - 2 * t + 2 * d;
  const panelDepth = D - b;
  const horizontal = (id: string, name: string, z: number, first: number) =>
    rectangle(id, name, [0, 0, z], [0, 0, 1], [1, 0, 0], first, {
      x0,
      y0: 0,
      w: across,
      h: panelDepth,
    });
  const PLY = 'us-ply-23-32';
  return build('Cabinet', [
    {
      type: 'setDisplayUnits',
      units: { length: { unit: 'in-fraction', denominator: 32 }, angle: { unit: 'deg' } },
    },
    // Sketch x is world Y, sketch y is world Z; both sides made towards +X.
    rectangle('sketch#1', 'Left side', [0, 0, 0], [1, 0, 0], [0, 1, 0], 1, {
      x0: 0,
      y0: 0,
      w: D,
      h: H,
    }),
    rectangle('sketch#2', 'Right side', [W - t, 0, 0], [1, 0, 0], [0, 1, 0], 5, {
      x0: 0,
      y0: 0,
      w: D,
      h: H,
    }),
    horizontal('sketch#3', 'Bottom', 0, 9),
    horizontal('sketch#4', 'Top', H - t, 13),
    horizontal('sketch#5', 'Shelf', shelf, 17),
    // Facing forward at y = D: the back is made towards the front.
    rectangle('sketch#6', 'Back', [0, D, 0], [0, -1, 0], [1, 0, 0], 21, {
      x0,
      y0: 0,
      w: across,
      h: H,
    }),
    panel('extension#1', 'Left side', 'sketch#1', PLY),
    panel('extension#2', 'Right side', 'sketch#2', PLY),
    panel('extension#3', 'Bottom', 'sketch#3', PLY),
    panel('extension#4', 'Top', 'sketch#4', PLY),
    panel('extension#5', 'Shelf', 'sketch#5', PLY),
    panel('extension#6', 'Back', 'sketch#6', 'us-ply-7-32'),
    joint('extension#7', 'rabbet', 'extension#1', 'extension#3'),
    joint('extension#8', 'rabbet', 'extension#2', 'extension#3'),
    joint('extension#9', 'rabbet', 'extension#1', 'extension#4'),
    joint('extension#10', 'rabbet', 'extension#2', 'extension#4'),
    joint('extension#11', 'dado', 'extension#1', 'extension#5'),
    joint('extension#12', 'dado', 'extension#2', 'extension#5'),
    joint('extension#13', 'rabbet', 'extension#1', 'extension#6'),
    joint('extension#14', 'rabbet', 'extension#2', 'extension#6'),
  ]);
}

// Shed ------------------------------------------------------------------------------------------

const OSB = 'us-osb-7-16';

const CONSTRUCTION = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: IN(0), height: IN(97.125) }],
  wallTypes: [
    {
      id: 'ext-2x4',
      name: 'Exterior 2x4',
      layers: [
        { id: 'sheathing', kind: 'sheathing', stock: OSB },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x4',
          header: { stock: 'us-2x6', plies: 2, jacks: 1 },
        },
      ],
    },
  ],
  floorTypes: [
    { id: 'shed-floor', name: 'Shed floor', joistStock: 'us-2x6', subfloor: 'us-osb-23-32' },
  ],
  roofTypes: [
    {
      id: 'shed-roof',
      name: 'Shed roof',
      rafterStock: 'us-2x6',
      ridgeStock: 'us-2x8',
      sheathing: OSB,
      overhang: IN(12),
      rakeOverhang: IN(12),
    },
  ],
};

function ext(
  id: string,
  name: string,
  extension: string,
  params: Record<string, unknown>,
  expressions: Record<string, unknown>,
  dependsOn: string[] = [],
  operation: 'new' | null = 'new',
) {
  return feature({
    id,
    kind: 'extension',
    name,
    extension,
    schemaVersion: 1,
    dependsOn,
    references: [],
    expressions,
    params,
    ...(operation ? { operation } : {}),
  });
}

const wall = (id: string, name: string, a: [number, number], b: [number, number]) =>
  ext(
    id,
    name,
    'construction.wall',
    { level: 'level-1', wallType: 'ext-2x4', points: 2 },
    { x1: IN(a[0]), y1: IN(a[1]), x2: IN(b[0]), y2: IN(b[1]) },
  );

const WALLS = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];

const opening = (
  id: string,
  name: string,
  host: string,
  kind: 'door' | 'window',
  at: Record<string, unknown>,
) =>
  ext(
    id,
    name,
    'construction.opening',
    { kind, segment: 1, from: 'start', header: { kind: 'auto' } },
    at,
    [host],
    null,
  );

/** The 12' x 16' shed: four 2x4 walls, two windows, a door, a floor on skids, a gable roof. */
export function shedDocument(): ManufaktureDocument {
  return build('Shed', [
    {
      type: 'setDisplayUnits',
      units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
    },
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    wall('extension#1', 'Front', [0, 0], [192, 0]),
    wall('extension#2', 'Back', [192, 144], [0, 144]),
    wall('extension#3', 'Right', [192, 0], [192, 144]),
    wall('extension#4', 'Left', [0, 144], [0, 0]),
    opening('extension#5', 'Window 1', 'extension#1', 'window', {
      position: IN(48),
      width: IN(24),
      height: IN(36),
      sill: IN(44),
    }),
    opening('extension#6', 'Window 2', 'extension#1', 'window', {
      position: IN(144),
      width: IN(24),
      height: IN(36),
      sill: IN(44),
    }),
    opening('extension#7', 'Door', 'extension#3', 'door', {
      position: IN(72),
      width: IN(36),
      height: IN(80),
    }),
    ext(
      'extension#8',
      'Floor',
      'construction.floor',
      {
        level: 'level-1',
        floorType: 'shed-floor',
        outline: 'walls',
        skids: { stock: 'us-4x6', count: 3 },
      },
      {},
      WALLS,
    ),
    ext(
      'extension#9',
      'Roof',
      'construction.roof',
      {
        roofType: 'shed-roof',
        kind: 'gable',
        ties: { kind: 'rafter-ties', stock: 'us-2x4', every: 2 },
      },
      { pitch: IN('6/12'), tieHeight: IN(24) },
      WALLS,
    ),
  ]);
}

// Regen -----------------------------------------------------------------------------------------

export interface Session {
  service: KernelService;
  engine: RegenEngine;
  /** Member shape meshes by key, as the app's member store keeps them. */
  memberMeshes: Map<string, MemberMesh>;
}

export async function session(): Promise<Session> {
  const service = await createNodeService();
  const extensions = new ExtensionRegistry();
  registerWood(extensions);
  registerConstruction(extensions);
  const engine = new RegenEngine({ kernel: service, solver: createSolverService(), extensions });
  return { service, engine, memberMeshes: new Map() };
}

/** Regenerate `doc`, failing on any feature that is not ok. */
export async function regen(s: Session, doc: ManufaktureDocument): Promise<RegenResult> {
  const st = s.service.stats();
  const generation = Math.max(s.engine.generation, st.generation, st.cancelledThrough) + 1;
  const result = await s.engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  for (const m of result.memberMeshes?.added ?? []) s.memberMeshes.set(m.key, m);
  for (const k of result.memberMeshes?.removed ?? []) s.memberMeshes.delete(k);
  for (const p of result.parts)
    for (const f of p.features)
      if (f.status !== 'ok')
        throw new Error(`${doc.name}: ${f.featureId} ${f.status} ${JSON.stringify(f.errors)}`);
  return result;
}
