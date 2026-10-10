// Session helpers (#1219): `addConstructionSet` expanded into core commands against the head, so
// one command makes a wall's framing elevation or the whole set, and the branch log holds only the
// core commands it became.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { afterEach, describe, expect, it } from 'vitest';
import { expandHelpers, reservedSymbolProblem } from './helpers';
import type { Session } from './session';
import { shedDocument } from './test/fixtures';
import { ok, seeded, type Seeded } from './test/setup';

const PART = 'part#1';
const BACK = 'extension#2';
const FRONT = 'extension#1';

const open: Session[] = [];
let seed: Seeded;

async function start(): Promise<Session> {
  seed = await seeded(shedDocument());
  const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Test' }));
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('expandHelpers', () => {
  it('replaces a helper by addDrawing, addSheet and addView with symbolic ids', () => {
    const r = expandHelpers(
      shedDocument(),
      [
        {
          type: 'setVariable',
          name: 'x',
          expression: { source: '1', lengthUnit: 'in', angleUnit: 'deg' },
        },
        { type: 'addConstructionSet', part: PART, wall: BACK },
      ],
      500,
    );
    if (!r.ok) throw new Error(r.message);
    const commands = r.commands as Data[];
    expect(commands.map((c) => c.type)).toEqual([
      'setVariable',
      'addDrawing',
      'addSheet',
      'addView',
    ]);
    expect(commands[1]!.drawing).toEqual({
      id: 'drawing#$__set1',
      name: 'Framing: Back',
      sheets: [],
      nextIds: {},
    });
    expect(commands[2]!.sheet.id).toBe('sheet#$__set1s1');
    expect(commands[3]!.view.id).toBe('view#$__set1v1');
    expect(commands[3]!.view.source.params).toEqual({ kind: 'elevation', wall: BACK, segment: 1 });
    // The symbols it made, for the report to leave out.
    expect([...r.symbols].sort()).toEqual(['$__set1', '$__set1s1', '$__set1v1']);
  });

  it('refuses a malformed helper, a missing drawing and a wall the part does not have', () => {
    const doc = shedDocument();
    expect(
      expandHelpers(doc, [{ type: 'addConstructionSet', part: PART, segment: 0 }], 500),
    ).toEqual({
      ok: false,
      code: 'invalid-input',
      message: expect.stringMatching(/^Command 1 \(addConstructionSet\): .* at segment\.$/),
    });
    expect(
      expandHelpers(doc, [{ type: 'addConstructionSet', part: PART, drawing: 'drawing#7' }], 500),
    ).toEqual({
      ok: false,
      code: 'invalid-input',
      message:
        'Command 1 (addConstructionSet): there is no drawing drawing#7; give a symbolic id (drawing#$set) for a new one.',
    });
    expect(
      expandHelpers(doc, [{ type: 'addConstructionSet', part: PART, wall: 'extension#5' }], 500),
    ).toEqual({
      ok: false,
      code: 'invalid-input',
      message: `Command 1 (addConstructionSet): There is no wall extension#5 in part studio ${PART}.`,
    });
  });
});

describe('expandHelpers: bounds and rules', () => {
  const back = { type: 'addConstructionSet', part: PART, wall: BACK };
  const TOO_MANY = {
    ok: false,
    code: 'too-many-commands',
    message:
      'A batch holds at most 10 commands, and its helpers expand it past that. Make the set in parts (one wall per command) or over several batches.',
    limit: 10,
  };

  it('stops at the first helper past the limit, before reading the rest', () => {
    // Three helpers make 9 commands; the fourth has nothing left. Had expansion gone on, the
    // fifth (malformed) would have been refused as invalid input instead.
    const helpers = [back, back, back, back, { ...back, segment: 0 }];
    for (let i = 0; i < 495; i++) helpers.push(back);
    expect(expandHelpers(shedDocument(), helpers, 10)).toEqual(TOO_MANY);
  });

  it('takes a set that exactly fits what the batch has left', () => {
    const doc = shedDocument();
    // The back wall alone: addDrawing, addSheet, addView.
    expect(expandHelpers(doc, [back], 3).ok).toBe(true);
    expect(expandHelpers(doc, [back], 2)).toEqual({
      ...TOO_MANY,
      message: TOO_MANY.message.replace('10', '2'),
      limit: 2,
    });
    // The whole shed set: addDrawing, 7 sheets and 10 views.
    const whole = { type: 'addConstructionSet', part: PART };
    const r = expandHelpers(doc, [whole], 18);
    expect(r.ok && r.commands.length).toBe(18);
    expect(expandHelpers(doc, [whole], 17).ok).toBe(false);
  });

  it("counts the removal of an existing drawing's empty only sheet", () => {
    const added = applyCommand(shedDocument(), {
      type: 'addDrawing',
      drawing: {
        id: 'drawing#1',
        name: 'Empty',
        nextIds: { sheet: 2 },
        sheets: [
          {
            id: 'sheet#1',
            name: 'Sheet 1',
            size: 'A3',
            orientation: 'landscape',
            views: [],
            dimensions: [],
            notes: [],
          },
        ],
      },
    });
    if (!added.ok) throw new Error(added.error.message);
    const doc = added.value.document;
    const into = { ...back, drawing: 'drawing#1' };
    const r = expandHelpers(doc, [into], 3);
    expect(r.ok && (r.commands as Data[]).map((c) => c.type)).toEqual([
      'addSheet',
      'addView',
      'deleteSheet',
    ]);
    expect(expandHelpers(doc, [into], 2).ok).toBe(false);
  });

  it("reads the part's walls once per batch, however many helpers", () => {
    // 3,000 walls (copies of the back wall), each feature read counted.
    const base = shedDocument();
    const part = base.parts[0]!;
    const wall = part.features.find((f) => f.id === BACK)!;
    const features = [
      ...part.features,
      ...Array.from({ length: 3000 }, (_, i) => ({ ...wall, id: `extension#${1000 + i}` })),
    ];
    let reads = 0;
    const counted = new Proxy(features, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const doc: ManufaktureDocument = { ...base, parts: [{ ...part, features: counted }] };
    const helpers = Array.from({ length: 500 }, (_, i) => ({
      ...back,
      wall: `extension#${1000 + i}`,
      segment: 1,
    }));
    const r = expandHelpers(doc, helpers, 1500);
    expect(r.ok && r.commands.length).toBe(1500);
    // One pass over the features for the whole batch, not one per helper.
    expect(reads).toBeLessThanOrEqual(features.length);
  });

  it('reads the construction settings once per batch, with helpers on many parts', () => {
    // 50 part studios, each with a copy of the back wall; every read of the settings counted.
    const base = shedDocument();
    const entry = base.domains!.construction!;
    let reads = 0;
    const data = new Proxy(entry.data as object, {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const part = base.parts[0]!;
    const doc: ManufaktureDocument = {
      ...base,
      domains: { ...base.domains, construction: { ...entry, data: data as never } },
      parts: Array.from({ length: 50 }, (_, i) => ({ ...part, id: `part#${i + 1}` })),
    };
    const helpers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...back, part: `part#${i + 1}` }));
    const one = expandHelpers(doc, helpers(1), 500);
    expect(one.ok).toBe(true);
    const once = reads;
    expect(once).toBeGreaterThan(0);
    reads = 0;
    const r = expandHelpers(doc, helpers(50), 500);
    expect(r.ok && r.commands.length).toBe(150);
    // The same reads for 50 helpers on 50 parts as for one.
    expect(reads).toBe(once);
  });

  it('finds a reserved symbol in any string, as symbol resolution would', () => {
    expect(reservedSymbolProblem([{ type: 'x', name: '\ne$__set1' }])).toBe(
      'Symbols starting with __set are kept for session helpers: rename e$__set1.',
    );
    expect(reservedSymbolProblem([{ type: 'x', name: 'sheet#$set1 abc$__set1' }])).toBeNull();
  });

  it('refuses one set larger than what the batch has left', () => {
    const doc = shedDocument();
    // The batch's own commands count first: 9 setVariables leave the helper nothing.
    const own = Array.from({ length: 9 }, (_, i) => ({
      type: 'setVariable',
      name: `v${i}`,
      expression: { source: '1', lengthUnit: 'in', angleUnit: 'deg' },
    }));
    expect(expandHelpers(doc, [...own, back], 10)).toEqual(TOO_MANY);
    // The whole shed set: 7 sheets and 10 views.
    expect(expandHelpers(doc, [{ type: 'addConstructionSet', part: PART }], 10)).toEqual(TOO_MANY);
    expect(expandHelpers(doc, [{ type: 'addConstructionSet', part: PART }], 500).ok).toBe(true);
  });

  it('refuses a helper inside a nested batch', () => {
    expect(
      expandHelpers(
        shedDocument(),
        [{ type: 'batch', commands: [{ type: 'batch', commands: [back] }] }],
        500,
      ),
    ).toEqual({
      ok: false,
      code: 'invalid-input',
      message:
        'addConstructionSet is a session helper: put it at the top level of the batch, not inside a nested batch.',
    });
  });

  it('refuses a drawing symbol an earlier command of the batch made', () => {
    const r = expandHelpers(
      shedDocument(),
      [
        { ...back, drawing: 'drawing#$a' },
        { type: 'addConstructionSet', part: PART, wall: FRONT, drawing: 'drawing#$a' },
      ],
      500,
    );
    expect(r).toEqual({
      ok: false,
      code: 'invalid-input',
      message:
        'Command 2 (addConstructionSet): drawing#$a is made earlier in this batch, and a helper reads the document as the batch found it. Add the sheets to it in a later batch, or let this helper make the drawing.',
    });
  });

  it('names a new drawing within the name limit, never splitting a character', () => {
    const doc = shedDocument();
    const wall = doc.parts[0]!.features.find((f) => f.id === BACK)!;
    const long = `${'a'.repeat(86)}${'\u{1F600}'.repeat(10)}`;
    const renamed = {
      ...doc,
      parts: [
        {
          ...doc.parts[0]!,
          features: doc.parts[0]!.features.map((f) =>
            f.id === BACK ? { ...wall, name: long } : f,
          ),
        },
      ],
    };
    const r = expandHelpers(renamed, [back], 500);
    if (!r.ok) throw new Error(r.message);
    // "Framing: " is 9 code points: 97 kept, then "...".
    expect((r.commands[0] as Data).drawing.name).toBe(
      `Framing: ${'a'.repeat(86)}\u{1F600}\u{1F600}...`,
    );
  });
});

describe('addConstructionSet in a session', () => {
  it("makes the back wall's framing elevation in one command; the log holds core commands", async () => {
    const s = await start();
    const r = ok(
      await s.apply({
        label: 'Framing elevation of the back wall',
        commands: [
          { type: 'addConstructionSet', part: PART, wall: BACK, drawing: 'drawing#$framing' },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    // Only the agent's own symbol is reported.
    expect(r.symbols).toEqual({ $framing: 'drawing#1' });
    const drawing = ok(await s.object({ kind: 'drawing', drawingId: 'drawing#1' })) as Data;
    expect(drawing.name).toBe('Framing: Back');
    expect(drawing.sheets.map((x: Data) => [x.id, x.name, x.views.map((v: Data) => v.id)])).toEqual(
      [['sheet#1', 'Framing: Back', ['view#1']]],
    );
    expect(drawing.sheets[0].views[0].direction).toEqual({
      direction: [-0, -1, 0],
      up: [0, 0, 1],
    });
    const log = ok(await seed.library.readLog(seed.documentId, s.branch));
    const types = (c: Command): string[] =>
      c.type === 'batch' ? c.commands.flatMap(types) : [c.type];
    expect(types(log.at(-1)!.command)).toEqual(['addDrawing', 'addSheet', 'addView']);
  });

  it('makes two drawings in one batch, then adds the whole set to one of them', async () => {
    const s = await start();
    const two = ok(
      await s.apply({
        label: 'Back and front framing',
        commands: [
          { type: 'addConstructionSet', part: PART, wall: BACK },
          { type: 'addConstructionSet', part: PART, wall: FRONT, name: 'Front only' },
        ],
      }),
    );
    expect(two.symbols).toEqual({});
    expect(two.created.document).toEqual(['drawing#1', 'drawing#2']);
    const set = ok(
      await s.apply({
        label: 'The whole set',
        commands: [{ type: 'addConstructionSet', part: PART, drawing: 'drawing#2' }],
      }),
    );
    expect(set.errors).toEqual([]);
    const d = ok(await s.object({ kind: 'drawing', drawingId: 'drawing#2' })) as Data;
    // The front's sheet stays (it has a view); the set's sheets follow, with ids after it.
    expect(d.sheets.map((x: Data) => x.name)).toEqual([
      'Framing: Front',
      'Plan: Level 1',
      'Elevations',
      'Framing: Front',
      'Framing: Back',
      'Framing: Right',
      'Framing: Left',
      'Roof framing: Roof',
    ]);
    const ids = d.sheets.flatMap((x: Data) => x.views.map((v: Data) => v.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a helper whose wall is not there, as invalid input', async () => {
    const s = await start();
    expect(
      await s.apply({
        label: 'Nothing',
        commands: [{ type: 'addConstructionSet', part: PART, wall: 'extension#99' }],
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-input',
        message: `Command 1 (addConstructionSet): There is no wall extension#99 in part studio ${PART}.`,
      }),
    });
  });

  it("refuses a nested helper, and symbols with the helpers' prefix", async () => {
    const s = await start();
    expect(
      await s.apply({
        label: 'Nested',
        commands: [
          { type: 'batch', commands: [{ type: 'addConstructionSet', part: PART, wall: BACK }] },
        ],
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid-input' }) });
    expect(
      await s.apply({
        label: 'Reserved',
        commands: [
          { type: 'addConstructionSet', part: PART, wall: BACK, drawing: 'drawing#$__set1' },
        ],
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'symbol',
        message: expect.stringMatching(/^Symbols starting with __set are kept for session helpers/),
      }),
    });
  });

  it('refuses a batch whose helpers pass the command limit, as too many commands', async () => {
    const s = await start();
    const helpers = Array.from({ length: 500 }, () => ({
      type: 'addConstructionSet',
      part: PART,
    }));
    expect(await s.apply({ label: 'Too many', commands: helpers })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-many-commands', limit: 500 }),
    });
  });

  it('lists the helper in the schema index, with its schema', async () => {
    const s = await start();
    expect(s.schemaIndex().commands).toContain('addConstructionSet');
    const schema = ok(await s.schema({ command: 'addConstructionSet' })) as Data;
    expect(schema.description).toMatch(/^A session helper, not a core command/);
    expect(Object.keys(schema.properties)).toContain('wall');
  });
});
