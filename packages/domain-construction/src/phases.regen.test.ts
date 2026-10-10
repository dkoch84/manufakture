// Construction phases (#1213) through regen with the real kernel: a wall and its door as built,
// the door moved (demolished at its old place, new at its new one), member overrides that set a
// phase, new and demolished walls, and the takeoff of new material and of the demolition list.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  type MemberSetResult,
  type RegenResult,
  type RegenSolver,
} from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConstruction } from './domain';
import { memberListing } from './member-list';
import { setPhases } from './phases';
import { constructionTakeoff } from './takeoff';
import { hasPhases, phaseInput, takeoffModel } from './takeoff/from-regen';
import { readConstructionData } from './data';

const PART = 'part#1';
const WALL = 'extension#1';
const DOOR = 'extension#2';
const MOVED = 'extension#3';

const ins = (v: number) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});
const IN = 25.4;

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

const CONSTRUCTION = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: ins(0), height: ins(97.125) }],
  wallTypes: [
    {
      id: 'ext-2x4',
      name: 'Exterior 2x4',
      layers: [
        { id: 'sheathing', kind: 'sheathing', stock: 'us-osb-7-16' },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x4',
          header: { stock: 'us-2x8', plies: 2, jacks: 1 },
        },
      ],
    },
  ],
};

/** A 16' wall along +x. */
function wall(params: Record<string, unknown> = {}, id = WALL, y = 0): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'construction.wall',
    schemaVersion: 1,
    dependsOn: [],
    references: [],
    expressions: { x1: ins(0), y1: ins(y), x2: ins(192), y2: ins(y) },
    params: { level: 'level-1', wallType: 'ext-2x4', points: 2, ...params } as never,
    operation: 'new',
  };
}

/** A 36" x 80" door centred `at` inches along the wall. */
function door(id: string, at: number, params: Record<string, unknown> = {}): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'construction.opening',
    schemaVersion: 1,
    dependsOn: [WALL],
    references: [],
    expressions: { position: ins(at), width: ins(36), height: ins(80) },
    params: { kind: 'door', ...params } as never,
    scope: [`${WALL}:layer/sheathing`],
  };
}

function building(
  features: ExtensionFeature[],
  data: Record<string, unknown> = { ...CONSTRUCTION, asBuilt: true },
): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-1', name: 'Phases' });
  const commands: Command[] = [
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: data as never },
    ...features.map((feature): Command => ({ type: 'addFeature', partId: PART, feature })),
  ];
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const noSolver: RegenSolver = {
  solve: () => {
    throw new Error('these documents have no sketches');
  },
};

async function regen(doc: ManufaktureDocument): Promise<RegenResult> {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  const engine = new RegenEngine({ kernel: service, solver: noSolver, extensions });
  try {
    const s = service.stats();
    const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
    const result = await engine.regen(doc, { generation });
    if (result === null) throw new Error('the regen was superseded');
    for (const f of result.parts[0]!.features) {
      expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
    }
    return result;
  } finally {
    await engine.dispose();
  }
}

const setOf = (r: RegenResult, group = WALL): MemberSetResult =>
  (r.parts[0]!.members ?? []).find((s) => s.group === group)!;

const full = (m: { owner: string; id: string }) => `${m.owner}:${m.id}`;

function listing(r: RegenResult, owner: string) {
  const l = memberListing({
    owner,
    features: r.parts[0]!.features,
    sets: (r.parts[0]!.members ?? []).map((s) => ({
      group: s.group,
      members: s.members!,
      metadata: s.metadata,
    })),
  });
  if (l === undefined) throw new Error(`no listing of ${owner}`);
  return l;
}

function model(r: RegenResult, doc: ManufaktureDocument) {
  const data = readConstructionData(
    doc.domains!.construction!.data as never,
    doc.domains!.construction!.schemaVersion,
  );
  if (!data.ok) throw new Error(data.message);
  return takeoffModel({
    document: doc,
    partId: PART,
    features: r.parts[0]!.features,
    sets: (r.parts[0]!.members ?? []).map((s) => ({
      namespace: s.namespace,
      members: s.members!,
      metadata: s.metadata,
    })),
    settings: data.value.settings,
    stock: undefined,
  });
}

const sheathing = (r: RegenResult) =>
  r.parts[0]!.bodies.filter((b) => b.bodyId === `${WALL}:layer/sheathing`);

describe('construction phases', () => {
  it('a design without phases frames as before: no phases in the metadata, every member new', async () => {
    const r = await regen(building([wall(), door(DOOR, 72)], CONSTRUCTION));
    const set = setOf(r);
    expect(set.metadata).not.toHaveProperty('phases');
    expect(setPhases(set.metadata).phased).toBe(false);
    const l = listing(r, WALL);
    expect(l.phase).toBe('new');
    expect(new Set(l.members.map((m) => m.phase))).toEqual(new Set(['new']));
    expect(l.demolished).toEqual([]);
    const doc = building([wall(), door(DOOR, 72)], CONSTRUCTION);
    expect(hasPhases(model(r, doc).input)).toBe(false);
  });

  it('an as-built document: every member is existing, nothing new or demolished', async () => {
    const doc = building([wall(), door(DOOR, 72)]);
    const r = await regen(doc);
    const phases = setPhases(setOf(r).metadata);
    expect(phases.phased).toBe(true);
    expect(phases.demolished).toEqual([]);
    for (const m of setOf(r).members!) expect(phases.phaseOf(full(m))).toBe('existing');
    expect(listing(r, DOOR).phase).toBe('existing');
    const input = model(r, doc).input;
    expect(phaseInput(input, 'new').members).toEqual([]);
    expect(phaseInput(input, 'new').faces).toEqual([]);
    expect(phaseInput(input, 'existing').members).toHaveLength(input.members.length);
    expect(phaseInput(input, 'demolish').members).toEqual([]);
  });

  it('moving the door: its old framing and the studs at its new place come out; its new framing and the studs filling its old place are new', async () => {
    const before = await regen(building([wall(), door(DOOR, 72)]));
    const doc = building([
      wall(),
      door(DOOR, 72, { phase: 'demolish' }),
      door(MOVED, 120, { phase: 'new' }),
    ]);
    const r = await regen(doc);
    const set = setOf(r);
    const phases = setPhases(set.metadata);
    const asBuilt = new Map(setOf(before).members!.map((m) => [full(m), m]));

    // The design is the door at its new place: the old door's members are not built.
    expect(set.members!.some((m) => m.owner === DOOR)).toBe(false);
    const door2 = set.members!.filter((m) => m.owner === MOVED);
    expect(door2.length).toBeGreaterThan(5);
    // Its kings, jacks, header and cripples are new.
    for (const m of door2.filter((x) => x.role !== 'king')) {
      expect(phases.phaseOf(full(m)), full(m)).toBe('new');
    }
    // The old door's members are demolished, all of them, as data.
    const gone = phases.demolished.map(full);
    expect(gone.filter((id) => id.startsWith(`${DOOR}:`)).sort()).toEqual(
      [...asBuilt.keys()].filter((id) => id.startsWith(`${DOOR}:`)).sort(),
    );
    // Layout studs where the door goes are demolished; those filling its old place new; the rest
    // of the wall's studs existing.
    const centre = (m: { placement: { origin: readonly number[] }; stock: { width: number } }) =>
      (m.placement.origin[0]! + m.stock.width / 2) / IN;
    const studs = phases.demolished.filter((m) => m.owner === WALL && m.role === 'stud');
    expect(studs.length).toBeGreaterThan(0);
    for (const m of studs) expect(Math.abs(centre(m) - 120)).toBeLessThan(20);
    const fill = set.members!.filter(
      (m) => m.owner === WALL && m.role === 'stud' && phases.phaseOf(full(m)) === 'new',
    );
    expect(fill.length).toBeGreaterThan(0);
    for (const m of fill) expect(Math.abs(centre(m) - 72)).toBeLessThan(20);
    const kept = set.members!.filter(
      (m) => m.owner === WALL && m.role === 'stud' && phases.phaseOf(full(m)) === 'existing',
    );
    for (const m of kept) {
      expect(Math.abs(centre(m) - 72)).toBeGreaterThan(17);
      expect(Math.abs(centre(m) - 120)).toBeGreaterThan(17);
    }
    // Top plates are untouched.
    for (const m of set.members!.filter((x) => x.role === 'top-plate')) {
      expect(phases.phaseOf(full(m))).toBe('existing');
    }

    // The member listings say so, per feature.
    expect(listing(r, DOOR)).toMatchObject({ phase: 'demolish', count: 0 });
    expect(listing(r, DOOR).demolished.length).toBe(
      gone.filter((id) => id.startsWith(`${DOOR}:`)).length,
    );
    expect(listing(r, MOVED).phase).toBe('new');
    expect(listing(r, WALL).demolished.map((m) => m.phase)).toEqual(
      listing(r, WALL).demolished.map(() => 'demolish'),
    );

    // The demolished door cuts nothing: the sheathing has the new door's hole only.
    expect(sheathing(r)).toHaveLength(1);
    const meta = r.parts[0]!.features.find((f) => f.featureId === DOOR)!.metadata as {
      cuts: unknown;
    };
    expect(meta.cuts).toEqual([]);

    // New material: the new framing; the demolition list: what comes out. Each a takeoff.
    const input = model(r, doc).input;
    expect(hasPhases(input)).toBe(true);
    const fresh = phaseInput(input, 'new');
    expect(fresh.members.map(full).sort()).toEqual(
      set
        .members!.filter((m) => phases.phaseOf(full(m)) === 'new')
        .map(full)
        .sort(),
    );
    const out = phaseInput(input, 'demolish');
    expect(out.members.map(full).sort()).toEqual(gone.sort());
    const t = constructionTakeoff(out);
    expect(t.totals.find((x) => x.group === 'framing' && x.unit === 'each')!.value).toBe(
      gone.length,
    );
    // An existing wall's sheathing is existing, whatever opening moved.
    expect(fresh.faces).toEqual([]);
    expect(phaseInput(input, 'existing').faces).toHaveLength(1);
  });

  it('overrides set a member phase: a stud demolished, an added block new', async () => {
    const doc = building([
      wall({
        overrides: [
          { id: 's3', phase: 'demolish' },
          { id: 'add1', phase: 'new' },
          { id: 's40', phase: 'demolish' },
        ],
        add: [{ id: 'add1', role: 'blocking' }],
      }),
    ]);
    const withExpr = structuredClone(doc);
    const f = withExpr.parts[0]!.features[0] as ExtensionFeature;
    (f.expressions as Record<string, StoredExpression>).add1_at = ins(40);
    (f.expressions as Record<string, StoredExpression>).add1_z = ins(48);
    const r = await regen(withExpr);
    const set = setOf(r);
    const phases = setPhases(set.metadata);
    expect(set.members!.map(full)).not.toContain(`${WALL}:s3`);
    expect(phases.demolished.map(full)).toEqual([`${WALL}:s3`]);
    expect(phases.phaseOf(`${WALL}:add1`)).toBe('new');
    expect(phases.phaseOf(`${WALL}:s2`)).toBe('existing');
    const l = listing(r, WALL);
    expect(l.overrides.map((o) => [o.id, o.status, o.phase])).toEqual([
      ['s3', 'applied', 'demolish'],
      ['add1', 'applied', 'new'],
      ['s40', 'lost', 'demolish'],
    ]);
  });

  it('a new wall is all new; a demolished one makes no body and all its members come out', async () => {
    // A demolished wall makes no body, so it has no operation.
    const gone9 = { ...wall({ phase: 'demolish' }, 'extension#9', 240) };
    delete gone9.operation;
    const doc = building([wall({ phase: 'new' }), gone9]);
    const r = await regen(doc);
    const added = setPhases(setOf(r).metadata);
    for (const m of setOf(r).members!) expect(added.phaseOf(full(m))).toBe('new');
    const gone = setOf(r, 'extension#9');
    expect(gone.members).toEqual([]);
    // Every member of it, once: as many as the same wall new.
    const out = setPhases(gone.metadata).demolished;
    expect(out.length).toBe(setOf(r).members!.length);
    expect(new Set(out.map(full)).size).toBe(out.length);
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).not.toContain('extension#9:layer/sheathing');
    const input = model(r, doc).input;
    // Its sheathing is on the demolition list, not in the design's.
    expect(input.faces!.map((x) => x.owner)).toEqual([WALL]);
    expect(phaseInput(input, 'demolish').faces!.map((x) => x.owner)).toEqual(['extension#9']);
    expect(phaseInput(input, 'new').faces!.map((x) => x.owner)).toEqual([WALL]);
  });

  it('warns on an opening whose phase its wall contradicts, and frames it as the wall says', async () => {
    const gone = { ...wall({ phase: 'demolish' }) };
    delete gone.operation;
    // The wall makes no body, so the door's scope names none.
    const opening = { ...door(DOOR, 72, { phase: 'new' }) };
    delete opening.scope;
    const doc = building([gone, opening]);
    const extensions = new ExtensionRegistry();
    registerConstruction(extensions);
    const engine = new RegenEngine({ kernel: service, solver: noSolver, extensions });
    try {
      const s = service.stats();
      const r = (await engine.regen(doc, {
        generation: Math.max(s.generation, s.cancelledThrough) + 1,
      }))!;
      const f = r.parts[0]!.features.find((x) => x.featureId === DOOR)!;
      expect(f.warnings.map((w) => w.message)).toEqual([
        `${DOOR} is new in ${WALL}, which is demolished: it is not framed (the wall comes out).`,
      ]);
      const set = setOf(r);
      expect(set.members).toEqual([]);
      expect(setPhases(set.metadata).demolished.some((m) => m.owner === DOOR)).toBe(false);
    } finally {
      await engine.dispose();
    }
  });

  it('refuses a phase that is not one, on a feature and on an override', async () => {
    const extensions = new ExtensionRegistry();
    registerConstruction(extensions);
    const engine = new RegenEngine({ kernel: service, solver: noSolver, extensions });
    try {
      const doc = building([
        wall(),
        door(DOOR, 72, { overrides: [{ id: 'king-l', phase: 'old' }] }),
        wall({ phase: 'gone' }, 'extension#9', 240),
      ]);
      const s = service.stats();
      const r = (await engine.regen(doc, {
        generation: Math.max(s.generation, s.cancelledThrough) + 1,
      }))!;
      const errors = (id: string) =>
        r.parts[0]!.features.find((f) => f.featureId === id)!.errors.map((e) => e.message);
      expect(errors('extension#9')).toEqual(['expected one of "existing", "new", "demolish"']);
      expect(errors(DOOR).join(' ')).toMatch(/expected one of "existing", "new", "demolish"/);
      // A demolished wall with an operation is refused: it makes no body.
      const bad = building([wall({ phase: 'demolish' })]);
      const t = service.stats();
      const r2 = (await engine.regen(bad, {
        generation: Math.max(t.generation, t.cancelledThrough) + 1,
      }))!;
      expect(r2.parts[0]!.features[0]!.errors.map((e) => e.message)).toEqual([
        'a demolished wall makes no body: it has no operation (remove "operation")',
      ]);
    } finally {
      await engine.dispose();
    }
  });
});
