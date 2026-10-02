// The assembly workspace's logic: instance bodies sharing their part's meshes, connector
// inference from a pick, the mate form and its commands, inserting, and the mates list.

import type { Command, Mate } from '@manufakture/core';
import { createDocument } from '@manufakture/core';
import type { MateResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { geometryRef } from '../state/selection';
import type { BodyInput } from '../viewport/bodies';
import {
  addAssemblyCommand,
  assemblyBodies,
  assemblySummary,
  buildMate,
  choiceFromConnector,
  choiceFromPick,
  choiceLabel,
  circumcentre,
  connectorPoint,
  inferencesFor,
  insertCommand,
  blockedDeleteTitle,
  instanceBlockers,
  instanceOf,
  mateFormOf,
  mateRows,
  movedPoses,
  newMateForm,
  uniqueName,
  withPoses,
  type ConnectorChoice,
  type ConnectorContext,
} from './assembly';

import {
  A,
  LIFTED,
  apply,
  box,
  instanceResult,
  lid,
  model,
  result,
  twoInstances,
} from './assembly.test-fixture';

describe('instances in the viewport', () => {
  it('shows each instance body under its instance view id, sharing the part mesh, placed', () => {
    const doc = twoInstances();
    const shown = assemblyBodies(doc, A, model());
    expect(shown.map((b) => b.id)).toEqual([
      'assembly#1/inst#1/extrude#1',
      'assembly#1/inst#2/extrude#1',
    ]);
    // No copies: the part's mesh, names and topology objects themselves.
    expect(shown[0]!.mesh).toBe(box.mesh);
    expect(shown[1]!.mesh).toBe(lid.mesh);
    expect(shown[1]!.names).toBe(lid.names);
    expect(shown[1]!.topology).toBe(lid.topology);
    expect(shown[1]!.transform).toEqual(LIFTED);
    expect(instanceOf(shown[1]!.id, A)).toBe('inst#2');
    expect(instanceOf(shown[1]!.id, 'assembly#2')).toBeNull();
    expect(instanceOf('part#1/extrude#1', A)).toBeNull();
  });

  it('takes a drag or preview pose over the solved one, and leaves out suppressed instances', () => {
    let doc = twoInstances();
    const dragged = { translation: [1, 2, 3] as const, rotation: [0, 0, 0, 1] as const };
    const shown = assemblyBodies(doc, A, model(), new Map([['inst#2', dragged]]));
    expect(shown[1]!.transform).toEqual(dragged);
    doc = apply(doc, {
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#1',
      suppressed: true,
    });
    expect(assemblyBodies(doc, A, model()).map((b) => b.id)).toEqual([
      'assembly#1/inst#2/extrude#1',
    ]);
    // Not regenerated yet: nothing to show, rather than something wrong.
    expect(assemblyBodies(doc, A, model([]))).toEqual([]);
  });
});

describe('connectors from picks', () => {
  it('infers the point from what was picked', () => {
    expect(inferencesFor('face', 'plane')).toEqual(['centroid']);
    expect(inferencesFor('face', 'cylinder')).toEqual(['centre', 'centroid']);
    expect(inferencesFor('edge', 'circle')).toEqual(['centre', 'midpoint']);
    expect(inferencesFor('edge', 'line')).toEqual(['midpoint']);
    expect(inferencesFor('vertex', null)).toEqual(['vertex']);
  });

  it('finds the point on the mesh topology: centroid, midpoint, vertex, circle centre', () => {
    // Face 6 is the top (+Z), edge 1 runs along X at y = z = 0, vertex 8 the far corner.
    expect(connectorPoint(lid, 'face', 6, 'centroid')).toEqual([20, 15, 5]);
    expect(connectorPoint(lid, 'edge', 1, 'midpoint')).toEqual([20, 0, 0]);
    expect(connectorPoint(lid, 'vertex', 8, 'vertex')).toEqual([40, 30, 5]);
    expect(circumcentre([1, 0, 0], [0, 1, 0], [-1, 0, 0])).toEqual([0, 0, 0]);
    expect(circumcentre([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
    // A closed circle of radius 5 about (10, 0, 3), as a polyline that repeats its start.
    const points: number[] = [];
    for (let k = 0; k <= 12; k++) {
      const a = (2 * Math.PI * k) / 12;
      points.push(10 + 5 * Math.cos(a), 5 * Math.sin(a), 3);
    }
    const ring = {
      id: 'ring',
      names: [],
      mesh: { edgeRanges: new Uint32Array([0, 13]), edgePositions: new Float32Array(points) },
      topology: {
        faces: [],
        vertices: [],
        edges: [
          {
            index: 1,
            faces: [],
            seam: false,
            curve: 'circle',
            midpoint: [15, 0, 3],
            length: 1,
            vertices: [1],
          },
        ],
      },
    } as unknown as BodyInput;
    const centre = connectorPoint(ring, 'edge', 1, 'centre')!;
    centre.forEach((v, i) => expect(v).toBeCloseTo([10, 0, 3][i]!, 5));
    expect(connectorPoint(ring, 'edge', 1, 'midpoint')).toEqual([15, 0, 3]);
  });

  const shown = assemblyBodies(twoInstances(), A, model());
  const context = (over: Partial<ConnectorContext> = {}): ConnectorContext => ({
    assemblyId: A,
    bodies: shown,
    edge: vi.fn(async () => ({ ok: true as const, value: { faces: ['x', 'y'] } })),
    vertex: vi.fn(async () => ({ ok: true as const, value: { faces: ['x', 'y', 'z'] } })),
    ...over,
  });

  it('stores a face by its name in the part, wherever the instance is', async () => {
    const id = 'assembly#1/inst#2/extrude#1';
    const r = await choiceFromPick(geometryRef('face', id, 'extrude#1/top'), context());
    expect(r).toEqual({
      ok: true,
      choice: {
        instanceId: 'inst#2',
        viewId: id,
        kind: 'face',
        index: 6,
        ref: { face: 'extrude#1/top' },
        inference: 'centroid',
        inferences: ['centroid'],
      },
    });
  });

  it('asks the kernel for edges and vertices, by index on the picked body', async () => {
    const id = 'assembly#1/inst#1/extrude#1';
    const ctx = context();
    const edge = await choiceFromPick(geometryRef('edge', id, 'extrude#1/front|bottom'), ctx);
    expect(ctx.edge).toHaveBeenCalledWith(id, 1);
    expect(edge).toMatchObject({
      ok: true,
      choice: { kind: 'edge', index: 1, ref: { faces: ['x', 'y'] }, inference: 'midpoint' },
    });
    const vertex = await choiceFromPick(
      geometryRef('vertex', id, 'placeholder:vertex:8', { placeholder: true }),
      ctx,
    );
    expect(ctx.vertex).toHaveBeenCalledWith(id, 8);
    expect(vertex).toMatchObject({ ok: true, choice: { kind: 'vertex', inference: 'vertex' } });
  });

  it('refuses picks off the instances and names that are placeholders', async () => {
    expect(await choiceFromPick(geometryRef('face', 'part#1/extrude#1', 'x'), context())).toEqual({
      ok: false,
      message: 'Pick a face, edge or vertex of an instance.',
    });
    const id = 'assembly#1/inst#1/extrude#1';
    expect(
      await choiceFromPick(
        geometryRef('edge', id, 'placeholder:edge:3', { placeholder: true }),
        context(),
      ),
    ).toMatchObject({ ok: false, message: 'That edge has no stable name to refer to.' });
    const failing = context({ edge: async () => ({ ok: false, message: 'dropped' }) });
    expect(
      await choiceFromPick(geometryRef('edge', id, 'extrude#1/front|bottom'), failing),
    ).toEqual({ ok: false, message: 'dropped' });
  });
});

describe('the mate form', () => {
  const doc = twoInstances();
  const assembly = doc.assemblies[0]!;
  const face = (instanceId: string, name: string): ConnectorChoice => ({
    instanceId,
    viewId: `${A}/${instanceId}/extrude#1`,
    kind: 'face',
    index: 6,
    ref: { face: name },
    inference: 'centroid',
    inferences: ['centroid'],
  });
  const ctx = { assembly, units: doc.units, variables: {} };

  it('needs two connectors on two instances', () => {
    expect(buildMate(newMateForm(), ctx)).toEqual({
      ok: false,
      errors: { a: 'Pick the first connector.', b: 'Pick the second connector.' },
    });
    const same = { ...newMateForm(), a: face('inst#1', 'a'), b: face('inst#1', 'b') };
    expect(buildMate(same, ctx)).toMatchObject({
      ok: false,
      errors: { b: 'The two connectors must be on different instances.' },
    });
  });

  it('makes a mate with fresh ids, the flip and turns on the second connector, the offset on the first', () => {
    const form = {
      ...newMateForm('slider'),
      a: face('inst#1', 'extrude#1/top'),
      b: face('inst#2', 'extrude#1/bottom'),
      flip: true,
      rotate: 1 as const,
      offset: { x: '0', y: '0', z: '4', angle: '0' },
      limits: { min: '0', max: '25' },
    };
    const r = buildMate(form, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
    expect(r.mate).toEqual({
      id: 'mate#1',
      name: 'Slider 1',
      kind: 'slider',
      a: {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'centroid',
        origin: { id: 'r1', ref: { face: 'extrude#1/top' } },
        offset: {
          translation: [mm('0'), mm('0'), mm('4')],
          rotation: [mm('0'), mm('0'), mm('0')],
        },
      },
      b: {
        id: 'mc#2',
        instance: 'inst#2',
        inference: 'centroid',
        origin: { id: 'r2', ref: { face: 'extrude#1/bottom' } },
        flip: true,
        rotate: 1,
      },
      suppressed: false,
      limits: { min: mm('0'), max: mm('25') },
    });
    expect(r.label).toBe('Add Slider 1');
    // The command is valid as it is, and the form of the stored mate reads back the same.
    const added = apply(doc, r.command);
    const stored = added.assemblies[0]!.mates[0]!;
    const back = mateFormOf(stored, A, assemblyBodies(added, A, model()));
    expect(back).toMatchObject({
      kind: 'slider',
      flip: true,
      rotate: 1,
      offset: { z: '4' },
      limits: { min: '0', max: '25' },
    });
    expect(back.a).toMatchObject({
      instanceId: 'inst#1',
      index: 6,
      ref: { face: 'extrude#1/top' },
    });
    // Editing keeps every id; a fastened mate has no limits.
    const edit = buildMate(
      { ...back, kind: 'fastened' },
      { ...ctx, assembly: added.assemblies[0]!, existing: stored },
    );
    if (!edit.ok) throw new Error(JSON.stringify(edit.errors));
    expect(edit.command).toMatchObject({
      type: 'editMate',
      mate: { id: 'mate#1', kind: 'fastened' },
    });
    expect(edit.mate.a.id).toBe('mc#1');
    expect(edit.mate.b.origin.id).toBe('r2');
    expect(edit.mate.limits).toBeUndefined();
    expect(apply(added, edit.command).assemblies[0]!.mates[0]!.kind).toBe('fastened');
  });

  it('keeps what the dialog cannot show when it edits a mate', () => {
    const mm = (source: string) => ({
      source,
      lengthUnit: 'mm' as const,
      angleUnit: 'deg' as const,
    });
    const stored: Mate = {
      id: 'mate#1',
      name: 'Odd',
      kind: 'fastened',
      a: {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'centroid',
        origin: { id: 'r1', ref: { face: 'extrude#1/top' } },
        flip: true,
        rotate: 2,
        offset: {
          translation: [mm('1'), mm('0'), mm('0')],
          rotation: [mm('15deg'), mm('0'), mm('0')],
        },
      },
      b: {
        id: 'mc#2',
        instance: 'inst#2',
        inference: 'centroid',
        origin: { id: 'r2', ref: { face: 'extrude#1/bottom' } },
        offset: {
          translation: [mm('0'), mm('2'), mm('0')],
          rotation: [mm('0'), mm('0'), mm('0')],
        },
      },
      suppressed: false,
    };
    const added = apply(doc, { type: 'addMate', assemblyId: A, mate: stored });
    const form = mateFormOf(stored, A, assemblyBodies(added, A, model()));
    // Change only what the dialog shows: the x offset goes, the second connector turns.
    const r = buildMate(
      { ...form, offset: { ...form.offset, x: '0' }, rotate: 1 },
      { ...ctx, assembly: added.assemblies[0]!, existing: stored },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.mate.a).toMatchObject({ flip: true, rotate: 2 });
    expect(r.mate.a.offset!.rotation[0].source).toBe('15deg');
    expect(r.mate.a.offset!.translation[0].source).toBe('0');
    expect(r.mate.b).toMatchObject({ rotate: 1, offset: stored.b.offset });
  });

  it('checks offsets and limits as expressions', () => {
    const form = {
      ...newMateForm('revolute'),
      a: face('inst#1', 'a'),
      b: face('inst#2', 'b'),
      offset: { x: '#nope', y: '0', z: '0', angle: '10mm' },
      limits: { min: '90deg', max: '10deg' },
    };
    const r = buildMate(form, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['limits.max', 'offset.angle', 'offset.x']);
    expect(r.errors['limits.max']).toBe('The maximum must not be below the minimum.');
  });

  it('shows a stored connector again, found on the shown body by its name', () => {
    const shown = assemblyBodies(doc, A, model());
    const edge = choiceFromConnector(
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'midpoint',
        origin: { id: 'r1', ref: { faces: ['extrude#1/bottom', 'extrude#1/front'] } },
      },
      A,
      shown,
    );
    expect(edge).toMatchObject({ kind: 'edge', index: 1, viewId: `${A}/inst#1/extrude#1` });
    expect(choiceLabel(edge, assembly)).toBe(
      'Box 1: midpoint of extrude#1/bottom | extrude#1/front',
    );
  });

  it('commits the solved poses with the mate as one step', () => {
    const mate = { type: 'addMate' } as unknown as Command;
    expect(withPoses(mate, A, {})).toBe(mate);
    const moved = movedPoses(
      result({
        instances: [instanceResult('inst#2', 'part#2', { transform: LIFTED, moved: true })],
      }),
    );
    expect(moved).toEqual({ 'inst#2': LIFTED });
    expect(withPoses(mate, A, moved)).toEqual({
      type: 'batch',
      commands: [mate, { type: 'setPoses', assemblyId: A, poses: { 'inst#2': LIFTED } }],
    });
  });
});

describe('inserting', () => {
  it('fixes the first instance and numbers names', () => {
    let doc = createDocument({ id: 'd', name: 'D' });
    doc = apply(doc, addAssemblyCommand(doc).command);
    expect(doc.assemblies[0]!.name).toBe('Assembly 1');
    const first = insertCommand(doc.assemblies[0]!, { part: 'part#1' }, 'Part 1');
    expect(first).toMatchObject({ label: 'Insert Part 1 1', instanceId: 'inst#1' });
    doc = apply(doc, first.command);
    const second = insertCommand(doc.assemblies[0]!, { part: 'part#1' }, 'Part 1');
    doc = apply(doc, second.command);
    expect(doc.assemblies[0]!.instances.map((x) => [x.id, x.name, x.fixed])).toEqual([
      ['inst#1', 'Part 1 1', true],
      ['inst#2', 'Part 1 2', false],
    ]);
    expect(uniqueName('Lid', ['Lid 1', 'Lid 3'])).toBe('Lid 2');
  });
});

describe('the mates list', () => {
  const doc = twoInstances();
  const mate = (id: string, extra: Partial<Mate> = {}): Mate => ({
    id,
    name: `Fastened ${id.slice(5)}`,
    kind: 'fastened',
    a: {
      id: `mc#${id.slice(5)}1`,
      instance: 'inst#1',
      inference: 'centroid',
      origin: { id: `r${id.slice(5)}1`, ref: { face: 'a' } },
    },
    b: {
      id: `mc#${id.slice(5)}2`,
      instance: 'inst#2',
      inference: 'centroid',
      origin: { id: `r${id.slice(5)}2`, ref: { face: 'b' } },
    },
    suppressed: false,
    ...extra,
  });
  const mateResult = (
    id: string,
    status: MateResult['status'],
    extra: Partial<MateResult> = {},
  ): MateResult => ({
    mateId: id,
    status,
    coordinates: [],
    residual: null,
    connectors: [
      { connectorId: 'x', instanceId: 'inst#1', frame: null, reference: null },
      { connectorId: 'y', instanceId: 'inst#2', frame: null, reference: null },
    ],
    errors: [],
    warnings: [],
    ...extra,
  });
  const assembly = {
    ...doc.assemblies[0]!,
    mates: [mate('mate#1'), mate('mate#2'), mate('mate#3', { suppressed: true })],
  };

  it('says what the last solve made of each mate, and which one to blame', () => {
    const r = result({
      outcome: 'conflicting',
      dof: null,
      message: 'mate#1 and mate#2 contradict each other: change mate#2',
      conflicting: [
        { mates: ['mate#1', 'mate#2'], blame: 'mate#2', message: 'They contradict each other.' },
      ],
      mates: [
        mateResult('mate#1', 'conflicting'),
        mateResult('mate#2', 'conflicting'),
        mateResult('mate#3', 'suppressed'),
      ],
    });
    expect(mateRows(assembly, r).map((m) => [m.id, m.status, m.blamed, m.message])).toEqual([
      ['mate#1', 'conflicting', false, 'They contradict each other.'],
      ['mate#2', 'conflicting', true, 'They contradict each other.'],
      ['mate#3', 'suppressed', false, null],
    ]);
    expect(assemblySummary(r)).toBe('mate#1 and mate#2 contradict each other: change mate#2');
    const lost = result({
      mates: [
        mateResult('mate#1', 'error', {
          errors: [
            {
              code: 'reference-lost',
              referenceId: 'r1',
              missing: ['a'],
              message: 'a is lost: re-pick it',
            },
          ],
        }),
      ],
    });
    expect(mateRows(assembly, lost)[0]).toMatchObject({
      status: 'error',
      message: 'a is lost: re-pick it',
    });
    // A mate the last regen has not seen yet.
    expect(mateRows(assembly, lost)[1]!.status).toBe('pending');
  });

  it('counts degrees of freedom', () => {
    expect(assemblySummary(undefined)).toBe('Solving...');
    expect(assemblySummary(result({ dof: 0 }))).toBe('Fully constrained');
    expect(assemblySummary(result({ dof: 1 }))).toBe('1 degree of freedom');
    expect(assemblySummary(result({ dof: 7 }))).toBe('7 degrees of freedom');
  });

  it('lists the mates that keep an instance from being deleted', () => {
    const mates = ['Fastened 1', 'Fastened 2', 'Fastened 3'];
    expect([...instanceBlockers(assembly)]).toEqual([
      ['inst#1', { mates, steps: [] }],
      ['inst#2', { mates, steps: [] }],
    ]);
    expect(blockedDeleteTitle(instanceBlockers(assembly).get('inst#1'))).toBe(
      'Mated by Fastened 1, Fastened 2, Fastened 3: delete those mates first',
    );
    expect(blockedDeleteTitle(undefined)).toBeUndefined();
  });

  it('lists the exploded steps that keep an instance from being deleted, as mates do', () => {
    const exploded = {
      ...assembly,
      mates: [],
      explodedViews: [
        {
          id: 'explode#1',
          name: 'Exploded view 1',
          steps: [
            {
              id: 'step#1',
              instances: ['inst#2'],
              direction: { vector: [0, 0, 1] as [number, number, number] },
              distance: { source: '10', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
            },
            {
              id: 'step#2',
              instances: ['inst#2'],
              direction: { instance: 'inst#1', face: { face: 'f' } },
              distance: { source: '5', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
            },
          ],
        },
      ],
    };
    const blockers = instanceBlockers(exploded);
    expect(blockers.get('inst#1')).toEqual({ mates: [], steps: ['step 2 of Exploded view 1'] });
    expect(blockers.get('inst#2')!.steps).toEqual([
      'step 1 of Exploded view 1',
      'step 2 of Exploded view 1',
    ]);
    expect(blockedDeleteTitle(blockers.get('inst#1'))).toBe(
      'Moved or aimed by exploded step 2 of Exploded view 1: edit or delete those steps first',
    );
    expect(
      blockedDeleteTitle({ mates: ['Fastened 1'], steps: ['step 1 of Exploded view 1'] }),
    ).toBe(
      'Mated by Fastened 1; moved or aimed by exploded step 1 of Exploded view 1: delete those mates and edit or delete those steps first',
    );
  });
});
