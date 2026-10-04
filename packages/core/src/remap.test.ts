import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from './commands';
import { hasTombstoneSubId } from './ids';
import {
  TOMBSTONE_NAME,
  commandIds,
  emptyRemapReport,
  remapDocument,
  remapIds,
  tombstoneId,
  type RenameTable,
} from './remap';
import type {
  CamOperation,
  ChamferFeature,
  ExtrudeFeature,
  ManufaktureDocument,
  Mate,
  SketchFeature,
} from './schema';
import { documentCounters, idText, maxCounters, type CounterTable } from './scopes';
import { Generator, Rng, type Category } from './sync-test-generator';
import { PART, bracket, deepFreeze, mm, unwrap } from './test-helpers';

const P1 = partScopeOf(PART);
function partScopeOf(id: string): string {
  return `part:${id}`;
}

function one(command: Command, table: RenameTable, document?: ManufaktureDocument): Command {
  return remapIds([command], table, document === undefined ? {} : { document })[0]!;
}

const sketch = (over: Partial<SketchFeature> = {}): SketchFeature => ({
  id: 'sketch#3',
  kind: 'sketch',
  name: 'Sketch 3',
  suppressed: false,
  plane: { type: 'face', face: { id: 'r7', ref: { face: 'extrude#1:side:e7#a' } } },
  entities: [
    { id: 'e7#a', kind: 'line', construction: false, start: [0, 0], end: [1, 0] },
    { id: 'e7#b', kind: 'line', construction: false, start: [1, 0], end: [2, 0] },
    { id: 'e8', kind: 'point', construction: false, position: [3, 3] },
  ],
  constraints: [
    {
      id: 'k4',
      kind: 'coincident',
      a: { entity: 'e7#a', at: 'end' },
      b: { entity: 'e7#b', at: 'start' },
    },
    { id: 'k5', kind: 'horizontal', line: 'e7#b' },
    { id: 'k6', kind: 'coincident', a: { entity: 'e8' }, b: { entity: '@origin' } },
  ],
  ...over,
});

describe('remapIds: one case per naming form', () => {
  it('a sketch split keeps its split suffix, in fields and in names', () => {
    const table: RenameTable = { [P1]: { e7: 'e9', k5: 'k11', r7: 'r8', 'sketch#3': 'sketch#5' } };
    const out = one({ type: 'editFeature', partId: PART, feature: sketch() }, table);
    expect(out).toEqual({
      type: 'editFeature',
      partId: PART,
      feature: sketch({
        id: 'sketch#5',
        plane: { type: 'face', face: { id: 'r8', ref: { face: 'extrude#1:side:e9#a' } } },
        entities: [
          { id: 'e9#a', kind: 'line', construction: false, start: [0, 0], end: [1, 0] },
          { id: 'e9#b', kind: 'line', construction: false, start: [1, 0], end: [2, 0] },
          { id: 'e8', kind: 'point', construction: false, position: [3, 3] },
        ],
        constraints: [
          {
            id: 'k4',
            kind: 'coincident',
            a: { entity: 'e9#a', at: 'end' },
            b: { entity: 'e9#b', at: 'start' },
          },
          { id: 'k11', kind: 'horizontal', line: 'e9#b' },
          { id: 'k6', kind: 'coincident', a: { entity: 'e8' }, b: { entity: '@origin' } },
        ],
      }),
    });
  });

  it('a region edge keeps its positional piece', () => {
    const table: RenameTable = { [P1]: { e7: 'e9', 'extrude#1': 'extrude#4' } };
    const shell: Command = {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'shell#1',
        kind: 'shell',
        name: 'Shell',
        suppressed: false,
        faces: [{ id: 'r3', ref: { face: 'extrude#1:side:e7#1' } }],
        thickness: mm('1'),
        outward: false,
      },
    };
    const out = one(shell, table) as Extract<Command, { type: 'addFeature' }>;
    expect(out.feature.kind === 'shell' && out.feature.faces[0]!.ref.face).toBe(
      'extrude#4:side:e9#1',
    );
  });

  it('a merge rewrites each member and keeps the piece number', () => {
    const table: RenameTable = { [P1]: { 'extrude#2': 'extrude#6', e5: 'e12' } };
    const out = one(
      {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'mirror#1',
          kind: 'mirror',
          name: 'M',
          suppressed: false,
          features: ['extrude#2'],
          plane: { id: 'r4', ref: { face: '(extrude#1:cap:end+extrude#2:side:e5)#2' } },
        },
      },
      table,
    ) as Extract<Command, { type: 'addFeature' }>;
    expect(out.feature).toMatchObject({
      features: ['extrude#6'],
      plane: { id: 'r4', ref: { face: '(extrude#1:cap:end+extrude#6:side:e12)#2' } },
    });
  });

  it('a corner of three faces rewrites every member', () => {
    const table: RenameTable = {
      [P1]: { 'extrude#1': 'extrude#3', e2: 'e20', 'fillet#3': 'fillet#4' },
    };
    const corner = 'fillet#3:corner:extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2';
    const out = one(
      {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'shell#2',
          kind: 'shell',
          name: 'S',
          suppressed: false,
          faces: [{ id: 'r9', ref: { face: corner } }],
          thickness: mm('1'),
          outward: false,
        },
      },
      table,
    ) as Extract<Command, { type: 'addFeature' }>;
    expect(out.feature.kind === 'shell' && out.feature.faces[0]!.ref.face).toBe(
      'fillet#4:corner:extrude#3:cap:end&extrude#3:side:e1&extrude#3:side:e20',
    );
  });

  it('pattern and mirror instances rename the prefix and the name after it', () => {
    const table: RenameTable = {
      [P1]: {
        'pattern#7': 'pattern#9',
        'mirror#8': 'mirror#2',
        'extrude#1': 'extrude#5',
        e7: 'e8',
      },
    };
    const chamfer: ChamferFeature = {
      id: 'chamfer#1',
      kind: 'chamfer',
      name: 'C',
      suppressed: false,
      edges: [
        {
          id: 'r1',
          ref: {
            faces: ['mirror#8:image/extrude#1:cap:end', 'pattern#7:i2/extrude#1:side:e7#a'],
            ends: ['pattern#7:i2/extrude#1:cap:start'],
          },
        },
      ],
      distance: mm('1'),
    };
    const out = one({ type: 'addFeature', partId: PART, feature: chamfer }, table);
    expect(out).toEqual({
      type: 'addFeature',
      partId: PART,
      feature: {
        ...chamfer,
        edges: [
          {
            id: 'r1',
            ref: {
              faces: ['mirror#2:image/extrude#5:cap:end', 'pattern#9:i2/extrude#5:side:e8#a'],
              ends: ['pattern#9:i2/extrude#5:cap:start'],
            },
          },
        ],
      },
    });
    // A body id of a pattern instance, in a scope.
    const cut: ExtrudeFeature = {
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Cut',
      suppressed: false,
      profile: { sketch: 'sketch#2' },
      operation: 'cut',
      extent: { type: 'throughAll' },
      reverse: false,
      scope: ['pattern#7:i2', 'extrude#1'],
    };
    const scoped = one({ type: 'addFeature', partId: PART, feature: cut }, table);
    expect(scoped).toMatchObject({ feature: { scope: ['pattern#9:i2', 'extrude#5'] } });
  });

  it('a derived name renames only its own prefix, never the source name', () => {
    const table: RenameTable = {
      [P1]: { 'extrude#1': 'extrude#4', 'derived#1': 'derived#2', e1: 'e6' },
    };
    const out = one(
      {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'fillet#2',
          kind: 'fillet',
          name: 'F',
          suppressed: false,
          edges: [
            {
              id: 'r5',
              ref: { faces: ['derived#1:from/extrude#1:side:e1', 'extrude#1:side:e1'] },
            },
          ],
          radius: mm('1'),
        },
      },
      table,
    );
    expect(out).toMatchObject({
      feature: {
        edges: [{ ref: { faces: ['derived#2:from/extrude#1:side:e1', 'extrude#4:side:e6'] } }],
      },
    });
  });

  it('a script operation name renames feature ids, never operation or local ids', () => {
    // ADR 0010 decision 6: `<feature id>:<operation id>/<name>`. The operation id `from` must not
    // be read as a derived prefix, and the local id `e7` must not be read as the part's sub-id.
    const table: RenameTable = {
      [P1]: { 'scripted#2': 'scripted#6', 'extrude#1': 'extrude#4', e7: 'e9', r1: 'r3' },
    };
    const out = one(
      {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'fillet#5',
          kind: 'fillet',
          name: 'F',
          suppressed: false,
          edges: [
            {
              id: 'r1',
              ref: {
                faces: ['scripted#2:boss/cap:end', 'scripted#2:boss/side:e7'],
                ends: [
                  'scripted#2:from/round:extrude#1:side:e7&scripted#2:boss/side:s1',
                  'scripted#2:p/i2/scripted#2:boss/side:e7',
                ],
              },
            },
          ],
          radius: mm('1'),
        },
      },
      table,
    );
    expect(out).toMatchObject({
      feature: {
        edges: [
          {
            id: 'r3',
            ref: {
              faces: ['scripted#6:boss/cap:end', 'scripted#6:boss/side:e7'],
              ends: [
                'scripted#6:from/round:extrude#4:side:e9&scripted#6:boss/side:s1',
                'scripted#6:p/i2/scripted#6:boss/side:e7',
              ],
            },
          },
        ],
      },
    });
    // A body a script made, in a scope.
    const cut: ExtrudeFeature = {
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Cut',
      suppressed: false,
      profile: { sketch: 'sketch#2' },
      operation: 'cut',
      extent: { type: 'throughAll' },
      reverse: false,
      scope: ['scripted#2:boss', 'scripted#2:p/i2'],
    };
    const scoped = one({ type: 'addFeature', partId: PART, feature: cut }, table);
    expect(scoped).toMatchObject({ feature: { scope: ['scripted#6:boss', 'scripted#6:p/i2'] } });
  });

  it('renames a feature id only in the part the table names', () => {
    const table: RenameTable = { [partScopeOf('part#2')]: { 'extrude#1': 'extrude#6' } };
    expect(
      remapIds(
        [
          { type: 'deleteFeature', partId: 'part#2', featureId: 'extrude#1' },
          { type: 'deleteFeature', partId: PART, featureId: 'extrude#1' },
        ],
        table,
      ),
    ).toEqual([
      { type: 'deleteFeature', partId: 'part#2', featureId: 'extrude#6' },
      { type: 'deleteFeature', partId: PART, featureId: 'extrude#1' },
    ]);
  });

  it('tells CAM operation ids from feature ids of the same shape by scope', () => {
    const op: CamOperation = {
      id: 'pocket#1',
      kind: 'pocket',
      name: 'Pocket',
      suppressed: false,
      tool: 'tool#1',
      geometry: [
        { kind: 'region', sketch: 'sketch#1', entities: ['e1'] },
        { kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
        { kind: 'hole', feature: 'hole#1' },
      ],
      depth: { kind: 'blind', depth: mm('2') },
      entry: { kind: 'plunge' },
      climb: true,
    };
    const doc = deepFreeze(withSetup(bracket()));
    const table: RenameTable = {
      cam: { 'pocket#1': 'pocket#3', r1: 'r2', 'tool#1': 'tool#4' },
      // Part-scope ids of the same shapes: only fields of the setup's part may take them.
      [P1]: {
        'pocket#1': 'pocket#9',
        'sketch#1': 'sketch#8',
        e1: 'e30',
        r1: 'r40',
        'hole#1': 'hole#2',
        'extrude#1': 'extrude#7',
      },
    };
    const out = one({ type: 'addCamOperation', setupId: 'setup#1', operation: op }, table, doc);
    expect(out).toEqual({
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: {
        ...op,
        id: 'pocket#3',
        tool: 'tool#4',
        geometry: [
          { kind: 'region', sketch: 'sketch#8', entities: ['e30'] },
          { kind: 'face', face: { id: 'r2', ref: { face: 'extrude#7:cap:end' } } },
          { kind: 'hole', feature: 'hole#2' },
        ],
      },
    });
  });
});

function withSetup(doc: ManufaktureDocument): ManufaktureDocument {
  const zero = mm('0');
  return unwrap(
    applyCommand(doc, {
      type: 'batch',
      commands: [
        {
          type: 'addCamTool',
          tool: {
            id: 'tool#1',
            name: 'Flat 6',
            kind: 'flat',
            diameter: mm('6'),
            fluteLength: mm('19'),
            flutes: 2,
            presets: [],
          },
        },
        {
          type: 'addCamSetup',
          setup: {
            id: 'setup#1',
            name: 'Top',
            part: PART,
            machine: 'shapeoko-5-pro-4x4',
            post: 'grbl',
            stock: {
              kind: 'fromBody',
              margins: { xMin: zero, xMax: zero, yMin: zero, yMax: zero, top: zero, bottom: zero },
            },
            wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
            heights: { clearance: mm('10'), retract: mm('5') },
            operations: [],
          },
        },
      ],
    }),
  ).document;
}

describe('remapIds: names of another part, through the document and the queue', () => {
  const twoParts = (): ManufaktureDocument =>
    unwrap(
      applyCommand(bracket(), {
        type: 'batch',
        commands: [
          { type: 'duplicatePart', sourcePartId: PART, partId: 'part#2', name: 'Copy' },
          { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Pair' },
          {
            type: 'addInstance',
            assemblyId: 'assembly#1',
            instance: {
              id: 'inst#1',
              name: 'A',
              source: { part: 'part#2' },
              fixed: true,
              suppressed: false,
              pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
            },
          },
        ],
      }),
    ).document;

  const mate = (instance2: string): Mate => ({
    id: 'mate#1',
    name: 'Fasten',
    kind: 'fastened',
    a: {
      id: 'mc#1',
      instance: 'inst#1',
      inference: 'centroid',
      origin: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
    },
    b: {
      id: 'mc#2',
      instance: instance2,
      inference: 'centroid',
      origin: { id: 'r2', ref: { face: 'extrude#1:cap:start' } },
    },
    suppressed: false,
  });

  it("renames a mate connector's names through its instance's part", () => {
    const doc = twoParts();
    const table: RenameTable = {
      [partScopeOf('part#2')]: { 'extrude#1': 'extrude#9' },
      'assembly:assembly#1': { 'mc#1': 'mc#5', r1: 'r6' },
    };
    const out = one(
      { type: 'addMate', assemblyId: 'assembly#1', mate: mate('inst#1') },
      table,
      doc,
    );
    expect(out).toMatchObject({
      mate: {
        a: { id: 'mc#5', origin: { id: 'r6', ref: { face: 'extrude#9:cap:end' } } },
        b: { id: 'mc#2', origin: { id: 'r2', ref: { face: 'extrude#9:cap:start' } } },
      },
    });
  });

  it('resolves an instance added earlier in the same list, and counts what it cannot', () => {
    const doc = twoParts();
    const table: RenameTable = { [P1]: { 'extrude#1': 'extrude#3' } };
    const report = emptyRemapReport();
    const [, added] = remapIds(
      [
        {
          type: 'addInstance',
          assemblyId: 'assembly#1',
          instance: {
            id: 'inst#2',
            name: 'B',
            source: { part: PART },
            fixed: false,
            suppressed: false,
            pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
            bodies: ['extrude#1'],
          },
        },
        { type: 'addMate', assemblyId: 'assembly#1', mate: mate('inst#2') },
        { type: 'addMate', assemblyId: 'assembly#1', mate: mate('inst#99') },
      ],
      table,
      { document: doc, report },
    );
    expect(added).toMatchObject({
      mate: {
        a: { origin: { ref: { face: 'extrude#1:cap:end' } } }, // inst#1 shows part#2
        b: { origin: { ref: { face: 'extrude#3:cap:start' } } }, // inst#2 shows part#1
      },
    });
    expect(report.unresolved).toBe(1);
  });

  it("renames an edited instance's bodies through the part it shows", () => {
    const doc = twoParts();
    const table: RenameTable = { [partScopeOf('part#2')]: { 'extrude#1': 'extrude#4' } };
    expect(
      one(
        {
          type: 'editInstance',
          assemblyId: 'assembly#1',
          instanceId: 'inst#1',
          bodies: ['extrude#1'],
        },
        table,
        doc,
      ),
    ).toMatchObject({ bodies: ['extrude#4'] });
    // A new source in the same command decides the part.
    expect(
      one(
        {
          type: 'editInstance',
          assemblyId: 'assembly#1',
          instanceId: 'inst#1',
          source: { part: PART },
          bodies: ['extrude#1'],
        },
        table,
        doc,
      ),
    ).toMatchObject({ bodies: ['extrude#1'] });
  });

  it("renames a dimension's references through its view's part", () => {
    const doc = unwrap(
      applyCommand(twoParts(), {
        type: 'addDrawing',
        drawing: {
          id: 'drawing#1',
          name: 'D',
          sheets: [
            {
              id: 'sheet#1',
              name: 'S',
              size: 'A4',
              orientation: 'landscape',
              views: [
                {
                  id: 'view#1',
                  source: { part: 'part#2' },
                  direction: 'front',
                  scale: { paper: mm('1'), model: mm('1') },
                  position: [10, 10],
                  options: { hidden: false, smooth: false },
                },
              ],
              dimensions: [],
              notes: [],
            },
          ],
          nextIds: { sheet: 2, view: 2 },
        },
      }),
    ).document;
    const table: RenameTable = {
      [partScopeOf('part#2')]: { 'extrude#1': 'extrude#5', e1: 'e9' },
      'drawing:drawing#1': { 'dim#1': 'dim#2' },
    };
    const out = one(
      {
        type: 'addDimension',
        drawingId: 'drawing#1',
        sheetId: 'sheet#1',
        dimension: {
          id: 'dim#1',
          view: 'view#1',
          kind: 'angle',
          refs: [
            { edge: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] }, body: 'extrude#1' },
            { face: { face: 'extrude#1:side:e2' }, body: 'extrude#1' },
          ],
          at: [1, 1],
        },
      },
      table,
      doc,
    );
    expect(out).toMatchObject({
      dimension: {
        id: 'dim#2',
        refs: [
          { edge: { faces: ['extrude#5:cap:end', 'extrude#5:side:e9'] }, body: 'extrude#5' },
          { face: { face: 'extrude#5:side:e2' }, body: 'extrude#5' },
        ],
      },
    });
  });
});

describe('remapIds: tables', () => {
  it('applies one table to the whole list, simultaneously', () => {
    // Entry A creates extrude#4, entry B creates extrude#5 and edits A's extrude#4. A remote
    // extrude#4 arrives: one table {#4 to #5, #5 to #6} renames both at once, without collision.
    const table: RenameTable = { [P1]: { 'extrude#4': 'extrude#5', 'extrude#5': 'extrude#6' } };
    expect(
      remapIds(
        [
          { type: 'suppressFeature', partId: PART, featureId: 'extrude#4', suppressed: true },
          { type: 'reorderFeature', partId: PART, featureId: 'extrude#5', index: 0 },
          { type: 'renameFeature', partId: PART, featureId: 'extrude#4', name: 'extrude#4' },
        ],
        table,
      ),
    ).toEqual([
      { type: 'suppressFeature', partId: PART, featureId: 'extrude#5', suppressed: true },
      { type: 'reorderFeature', partId: PART, featureId: 'extrude#6', index: 0 },
      // Free text is never read, even when it looks like an id.
      { type: 'renameFeature', partId: PART, featureId: 'extrude#5', name: 'extrude#4' },
    ]);
  });

  it('rewrites an undo stack: inverses are commands too', () => {
    const doc = bracket();
    const done = unwrap(
      applyCommand(doc, { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' }),
    );
    const table: RenameTable = { [P1]: { 'fillet#1': 'fillet#7', r2: 'r9' } };
    const [inverse] = remapIds([done.inverse], table);
    expect(inverse).toMatchObject({
      type: 'restoreFeature',
      feature: { id: 'fillet#7', edges: [{ id: 'r9' }] },
    });
  });

  it("turns a dropped command's ids into tombstones that never bind", () => {
    const table: RenameTable = { [P1]: { 'extrude#9': null, e20: null } };
    const out = remapIds(
      [
        { type: 'deleteFeature', partId: PART, featureId: 'extrude#9' },
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            id: 'shell#3',
            kind: 'shell',
            name: 'S',
            suppressed: false,
            faces: [{ id: 'r30', ref: { face: 'extrude#9:side:e20' } }],
            thickness: mm('1'),
            outward: false,
          },
        },
      ],
      table,
    );
    expect(out[0]).toMatchObject({ featureId: 'extrude#0' });
    expect(out[1]).toMatchObject({
      feature: { faces: [{ ref: { face: `extrude#${TOMBSTONE_NAME}:side:e${TOMBSTONE_NAME}` } }] },
    });
    expect(tombstoneId('e7', false)).toBe('e0');
    // Core refuses both: the plain id by schema or lookup, the name by its dependency.
    const doc = bracket();
    expect(applyCommand(doc, out[0]!).ok).toBe(false);
    expect(applyCommand(doc, out[1]!).ok).toBe(false);
  });

  it('refuses a tombstoned sub-id in a name on a live feature', () => {
    // extrude#1 exists, so the dependency check passes; the tombstoned entity must still fail.
    const [shell] = remapIds(
      [
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            id: 'shell#3',
            kind: 'shell',
            name: 'S',
            suppressed: false,
            faces: [{ id: 'r30', ref: { face: 'extrude#1:side:e20#a' } }],
            thickness: mm('1'),
            outward: false,
          },
        },
      ],
      { [P1]: { e20: null } },
    );
    expect(shell).toMatchObject({
      feature: { faces: [{ ref: { face: `extrude#1:side:e${TOMBSTONE_NAME}#a` } }] },
    });
    const r = applyCommand(bracket(), shell!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('schema');
      expect(JSON.stringify(r.error)).toContain('dropped command');
    }
    // A real sub-id with the same leading digits is fine.
    expect(hasTombstoneSubId('extrude#1:side:e9999999999999990')).toBe(false);
    expect(hasTombstoneSubId(`fillet#3:round:r${TOMBSTONE_NAME}`)).toBe(true);
  });

  it('returns the list unchanged for an empty table, and never mutates its input', () => {
    const cmds = deepFreeze(bracketish());
    expect(remapIds(cmds, {})).toEqual(cmds);
    expect(remapIds(cmds, { [P1]: {} })).toEqual(cmds);
    expect(() => remapIds(cmds, { [P1]: { e1: 'e50' } })).not.toThrow();
  });

  it('raises counters a command carries so they still cover their ids', () => {
    const two = unwrap(
      applyCommand(bracket(), {
        type: 'duplicatePart',
        sourcePartId: PART,
        partId: 'part#2',
        name: 'Copy',
      }),
    ).document;
    const { inverse } = unwrap(applyCommand(two, { type: 'deletePart', partId: 'part#2' }));
    const [restore] = remapIds([inverse], { 'part:part#2': { 'extrude#1': 'extrude#20' } });
    expect(restore).toMatchObject({
      type: 'restorePart',
      part: { id: 'part#2', nextIds: { extrude: 21 } },
    });
  });

  it("reports a rename that reverses the order of an edge's faces (known limitation)", () => {
    // e2 and e9: e2 sorts first. Renaming e9 to e10 makes e10 sort first, but positions are kept,
    // so the stored list is no longer sorted, and the kernel reads a chamfer's reference face from
    // that order (ADR 0009 amendment, item 9). Kernel naming is not changed in M7; the remap
    // reports it.
    const report = emptyRemapReport();
    const [out] = remapIds(
      [
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            id: 'chamfer#1',
            kind: 'chamfer',
            name: 'C',
            suppressed: false,
            edges: [{ id: 'r3', ref: { faces: ['extrude#1:side:e2', 'extrude#1:side:e9'] } }],
            distance: mm('1'),
            secondDistance: mm('2'),
          },
        },
      ],
      { [P1]: { e9: 'e10' } },
      { report },
    );
    expect(out).toMatchObject({
      feature: { edges: [{ ref: { faces: ['extrude#1:side:e2', 'extrude#1:side:e10'] } }] },
    });
    expect(report.orderFlips).toBe(1);
    expect(['extrude#1:side:e2', 'extrude#1:side:e10'].sort()).toEqual([
      'extrude#1:side:e10',
      'extrude#1:side:e2',
    ]);
  });
});

function bracketish(): Command[] {
  return [
    { type: 'setVariable', name: 'w', expression: mm('3') },
    { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
  ];
}

describe('remapDocument', () => {
  it('renames every id of a document and raises its counters past them', () => {
    const doc = deepFreeze(bracket());
    const out = remapDocument(doc, {
      [P1]: { 'extrude#1': 'extrude#11', e1: 'e21' },
      document: { [PART]: 'part#3' },
    });
    expect(out.parts[0]!.id).toBe('part#3');
    expect(out.parts[0]!.features.map((f) => f.id)).toContain('extrude#11');
    expect(out.parts[0]!.nextIds).toMatchObject({ extrude: 12, e: 22 });
    expect(out.nextIds).toMatchObject({ part: 4 });
    // References into the renamed feature follow it.
    const fillet = out.parts[0]!.features.find((f) => f.id === 'fillet#1');
    expect(fillet).toMatchObject({
      edges: [{ ref: { faces: ['extrude#11:side:e21', 'extrude#11:side:e2'] } }],
    });
  });

  it('does not raise a counter for an id it never covered', () => {
    const doc = bracket();
    const out = remapDocument(doc, { [P1]: { 'extrude#40': 'extrude#90' } });
    expect(out.parts[0]!.nextIds.extrude).toBe(doc.parts[0]!.nextIds.extrude);
  });
});

describe('commandIds', () => {
  it('lists plain-field ids with their scopes, not ids inside names', () => {
    expect(
      commandIds([
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            id: 'shell#1',
            kind: 'shell',
            name: 'S',
            suppressed: false,
            faces: [{ id: 'r3', ref: { face: 'extrude#1:side:e2' } }],
            thickness: mm('1'),
            outward: false,
          },
        },
      ]),
    ).toEqual([
      { scope: 'document', id: PART },
      { scope: P1, id: 'shell#1' },
      { scope: P1, id: 'r3' },
    ]);
  });
});

/** The bracket with an assembly of two instances, CAM, a drawing and a print setup. */
function richBase(gen: Generator): ManufaktureDocument {
  let doc = bracket();
  const seq: Category[] = [
    'addAssembly',
    'addInstance',
    'addInstance',
    'camTool',
    'camSetup',
    'drawing',
    'printSetup',
    'configParameter',
  ];
  for (const category of seq) {
    const c = gen.force(category, doc);
    if (c) doc = unwrap(applyCommand(doc, c)).document;
  }
  return doc;
}

interface Stream {
  base: ManufaktureDocument;
  end: ManufaktureDocument;
  commands: Command[];
  /** High-water counters over every document of the stream. */
  high: CounterTable;
}

function stream(seed: number, length: number): Stream {
  const gen = new Generator(new Rng(seed));
  const base = richBase(gen);
  let end = base;
  let high = documentCounters(end);
  const commands: Command[] = [];
  for (let i = 0; i < length; i++) {
    const c = gen.generate(end);
    if (!c) break;
    commands.push(c);
    end = unwrap(applyCommand(end, c)).document;
    high = maxCounters(high, documentCounters(end));
  }
  return { base, end, commands, high };
}

/** Applies `commands` to `doc`, failing with the first refusal. */
function replay(doc: ManufaktureDocument, commands: readonly Command[], seed: number) {
  let out = doc;
  commands.forEach((c, i) => {
    const r = applyCommand(out, c);
    if (!r.ok) {
      throw new Error(
        `seed ${seed}, command ${i} (${c.type}) refused after the remap: ${r.error.message}`,
      );
    }
    out = r.value.document;
  });
  return out;
}

/** Every command type in a list, batches opened. */
function typesOf(commands: readonly Command[], into: Set<string>): void {
  for (const c of commands) {
    into.add(c.type);
    if (c.type === 'batch') typesOf(c.commands, into);
  }
}

/** Duplicated part to the part it was copied from, through every duplicate in the stream. */
function duplicateRoots(commands: readonly Command[]): Map<string, string> {
  const roots = new Map<string, string>();
  const visit = (c: Command) => {
    if (c.type === 'batch') c.commands.forEach(visit);
    else if (c.type === 'duplicatePart') {
      roots.set(c.partId, roots.get(c.sourcePartId) ?? c.sourcePartId);
    }
  };
  commands.forEach(visit);
  return roots;
}

/**
 * Renames every id below its counter in every scope the stream's documents had, by an offset per
 * scope and counter: different scopes rename the same id differently, so a field walked through
 * the wrong scope shows. A duplicated part shares its source's offsets: its copied ids follow the
 * source's renames (ADR 0009 amendment, item 8), which the sync client does by copying the table.
 */
function scopedTable(rng: Rng, high: CounterTable, roots: Map<string, string>): RenameTable {
  const offsets = new Map<string, number>();
  const table: Record<string, Record<string, string>> = {};
  for (const [scope, cs] of Object.entries(high)) {
    const part = scope.startsWith('part:') ? scope.slice(5) : undefined;
    const key = part !== undefined && roots.has(part) ? `part:${roots.get(part)}` : scope;
    for (const [counter, next] of Object.entries(cs)) {
      const k = `${key}|${counter}`;
      if (!offsets.has(k)) offsets.set(k, 50 + rng.int(950));
      const offset = offsets.get(k)!;
      for (let n = 1; n < next; n++) {
        (table[scope] ??= {})[idText(counter, n)] = idText(counter, n + offset);
      }
    }
  }
  return table;
}

const SEEDS = 24;
const COMMANDS = 50;

describe('remap property: remapped commands give the renamed document', () => {
  // Random command streams over every scope: applying the remapped commands to the renamed start
  // document gives the renamed end document. Seeded and bounded so `make test` stays fast.
  it(`holds for ${SEEDS} seeded streams of ${COMMANDS} commands, per-scope renames`, () => {
    const types = new Set<string>();
    let renamed = 0;
    let scripted = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { base, end, commands, high } = stream(seed, COMMANDS);
      typesOf(commands, types);
      for (const p of end.parts) scripted += p.features.filter((f) => f.kind === 'scripted').length;
      const table = scopedTable(new Rng(seed * 31), high, duplicateRoots(commands));
      const report = emptyRemapReport();
      const remapped = remapIds(commands, table, { document: base, report });
      renamed += report.renamed;
      expect(replay(remapDocument(base, table), remapped, seed), `seed ${seed}`).toEqual(
        remapDocument(end, table),
      );
      expect(report.unresolved, `seed ${seed}`).toBe(0);
    }
    // The streams reach every scope.
    for (const t of [
      'addFeature',
      'editFeature',
      'restoreFeature',
      'batch',
      'replaceDocument',
      'duplicatePart',
      'addMate',
      'editInstance',
      'addExplodedView',
      'setConfigRow',
      'addPrintItem',
      'addDimension',
      'addCamOperation',
      'setScript',
    ]) {
      expect(types, t).toContain(t);
    }
    expect(renamed).toBeGreaterThan(5000);
    // Scripted features (with reference parameters) are in the streams too.
    expect(scripted).toBeGreaterThan(0);
  });

  it(`agrees with an independent textual rename on ${SEEDS} streams`, () => {
    // The oracle above shares the walker with `remapIds`, so a field both skip goes unseen. Here
    // every counter shifts by one offset in every scope, which makes the rename scope-free, and
    // the expected document comes from a plain text rewrite of the end document's JSON instead.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { base, end, commands, high } = stream(seed, COMMANDS);
      const rng = new Rng(seed * 17);
      const offsets: Record<string, number> = {};
      const table: Record<string, Record<string, string>> = {};
      for (const [scope, cs] of Object.entries(high)) {
        for (const [counter, next] of Object.entries(cs)) {
          const offset = (offsets[counter] ??= 50 + rng.int(950));
          for (let n = 1; n < next; n++) {
            (table[scope] ??= {})[idText(counter, n)] = idText(counter, n + offset);
          }
        }
      }
      const remapped = remapIds(commands, table, { document: base });
      const got = replay(textualRename(base, offsets), remapped, seed);
      expect(got, `seed ${seed}`).toEqual(textualRename(end, offsets));
    }
  });
});

/** Keys whose string values are free text or another document's data: never ids. */
const OPAQUE_KEYS = new Set([
  'name',
  'label',
  'text',
  'source',
  'fileName',
  'data',
  'sha256',
  'printer',
  'machine',
  'post',
  'variable',
  'params',
  'domains',
  'units',
  'format',
  'documentName',
  'versionName',
]);

/**
 * The oracle: every id token in every string of a document, shifted by its counter's offset,
 * whatever the scope; counters raised by the same offsets. Feature-like tokens (`kind#n`, any
 * kind with an offset) and sub-id tokens (`e7`, `k2`, `r1` not inside a word) are rewritten in
 * plain fields and inside names alike. Free text (a script's source among it) is skipped by key. The generator makes no
 * derived features, so no source name needs to be kept.
 */
function textualRename(
  doc: ManufaktureDocument,
  offsets: Record<string, number>,
): ManufaktureDocument {
  const token =
    /(?<![A-Za-z0-9])([a-z][a-zA-Z0-9]*)#([1-9][0-9]*)|(?<![A-Za-z0-9#])([ekr])([1-9][0-9]*)(?![0-9])/g;
  const rewrite = (s: string): string =>
    s.replace(
      token,
      (
        m,
        kind: string | undefined,
        n1: string | undefined,
        sub: string | undefined,
        n2: string | undefined,
      ) => {
        // `e1#1` (a region edge, a piece) is the sub-id `e1` with a suffix, not a kind `e1`.
        const split = kind !== undefined ? /^([ekr])([1-9][0-9]*)$/.exec(kind) : null;
        if (split) {
          const off = offsets[split[1]!];
          return off === undefined ? m : `${split[1]}${Number(split[2]) + off}#${n1}`;
        }
        const counter = kind ?? sub!;
        const offset = offsets[counter];
        if (offset === undefined) return m;
        const n = Number(kind !== undefined ? n1 : n2) + offset;
        return kind !== undefined ? `${kind}#${n}` : `${sub}${n}`;
      },
    );
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key !== undefined && OPAQUE_KEYS.has(key) ? v : rewrite(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v === null || typeof v !== 'object') return v;
    // Opaque objects: another document (a derived or pinned source), extension and view params,
    // domain data, display units.
    if ('documentId' in v || key === 'params' || key === 'domains' || key === 'units') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'nextIds') {
        const counters: Record<string, number> = {};
        for (const [c, n] of Object.entries(x as Record<string, number>)) {
          counters[c] = n > 1 && offsets[c] !== undefined ? n + offsets[c] : n;
        }
        out[k] = counters;
      } else if (k === 'params' && (v as { kind?: unknown }).kind === 'scripted') {
        // A scripted feature's parameters are not opaque: reference values hold face names.
        const rec: Record<string, unknown> = {};
        for (const [rk, rv] of Object.entries(x as Record<string, unknown>)) rec[rk] = walk(rv);
        out[k] = rec;
      } else if (k === 'values' || k === 'poses') {
        // Record keys that are ids: configuration row values, poses.
        const rec: Record<string, unknown> = {};
        for (const [rk, rv] of Object.entries(x as Record<string, unknown>))
          rec[rewrite(rk)] = walk(rv, rk);
        out[k] = rec;
      } else out[k] = walk(x, k);
    }
    return out;
  };
  return { ...(walk(doc) as ManufaktureDocument), id: doc.id };
}
