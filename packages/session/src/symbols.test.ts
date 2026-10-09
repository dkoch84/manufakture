import { applyCommand } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { nodeExtensions } from './node-host';
import { hasSymbols, resolveSymbols, type IdFieldsOf } from './symbols';
import { PART, bracketDocument } from './test/fixtures';

const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });

const sketch = (id: string, partId = PART, entity = 'e$c') => ({
  type: 'addFeature',
  partId,
  feature: {
    id,
    kind: 'sketch',
    name: 'S',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 40], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [{ id: entity, kind: 'circle', construction: false, center: [3, 0], radius: 2 }],
    constraints: [],
  },
});

const extrude = (id: string, sketchId: string) => ({
  type: 'addFeature',
  partId: PART,
  feature: {
    id,
    kind: 'extrude',
    name: 'Boss',
    suppressed: false,
    profile: { sketch: sketchId },
    operation: 'add',
    extent: { type: 'blind', distance: mm(5) },
    reverse: false,
  },
});

function resolve(commands: unknown[]) {
  return resolveSymbols(bracketDocument(), { type: 'batch', commands });
}

describe('symbolic ids', () => {
  it('allocates real ids in order of appearance, through names too', () => {
    const r = resolve([
      sketch('sketch#$s'),
      extrude('extrude#$boss', 'sketch#$s'),
      {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'fillet#$round',
          kind: 'fillet',
          name: 'Round',
          suppressed: false,
          edges: [
            { id: 'r$edge', ref: { faces: ['extrude#$boss:end', 'extrude#$boss:side:e$c'] } },
          ],
          radius: mm(0.5),
        },
      },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.value.table).toEqual({
      $s: 'sketch#3',
      $c: 'e9',
      $boss: 'extrude#2',
      $round: 'fillet#2',
      $edge: 'r2',
    });
    const fillet = (r.value.command as { commands: { feature: { edges: unknown } }[] }).commands[2]!
      .feature;
    expect(fillet.edges).toEqual([
      { id: 'r2', ref: { faces: ['extrude#2:end', 'extrude#2:side:e9'] } },
    ]);
    expect(applyCommand(bracketDocument(), r.value.command).ok).toBe(true);
  });

  it("resolves a symbol inside a measured variable's quoted face names (#1202)", () => {
    const r = resolve([
      {
        type: 'setVariable',
        name: 'boss_top',
        expression: {
          source: 'distance("extrude#$boss:end", "extrude#$boss:side:e$c") + 1 mm',
          lengthUnit: 'mm',
          angleUnit: 'deg',
        },
      },
      sketch('sketch#$s'),
      extrude('extrude#$boss', 'sketch#$s'),
      {
        type: 'setVariable',
        name: 'qualified',
        expression: {
          source: 'angle("part#1/extrude#$boss:end", "extrude#1:cap:end")',
          lengthUnit: 'mm',
          angleUnit: 'deg',
        },
      },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.value.table).toMatchObject({ $boss: 'extrude#2', $c: 'e9' });
    const sources = (
      r.value.command as { commands: { expression?: { source: string } }[] }
    ).commands.flatMap((c) => (c.expression ? [c.expression.source] : []));
    expect(sources).toEqual([
      'distance("extrude#2:end", "extrude#2:side:e9") + 1 mm',
      'angle("part#1/extrude#2:end", "extrude#1:cap:end")',
    ]);
    expect(applyCommand(bracketDocument(), r.value.command).ok).toBe(true);
  });

  it('starts past a literal fresh id of the same counter', () => {
    const r = resolve([sketch('sketch#3', PART, 'e9'), sketch('sketch#$next', PART, 'e$d')]);
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.value.table).toEqual({ $next: 'sketch#4', $d: 'e10' });
  });

  it("allocates in a part the batch makes, from that part's own counters", () => {
    const r = resolve([
      { type: 'addPart', partId: 'part#$p', name: 'Second' },
      sketch('sketch#$t', 'part#$p'),
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.value.table).toEqual({ $p: 'part#2', $t: 'sketch#1', $c: 'e1' });
  });

  it('refuses a symbol with two counters, or for two things', () => {
    const two = resolve([sketch('sketch#$x'), extrude('extrude#$x', 'sketch#$x')]);
    expect(two).toEqual({
      ok: false,
      problem: { kind: 'symbol', message: expect.stringMatching(/two counters/) },
    });
    const scopes = resolve([
      { type: 'addPart', partId: 'part#$p', name: 'Second' },
      sketch('sketch#$s', 'part#$p'),
      sketch('sketch#$s'),
    ]);
    expect(scopes).toEqual({
      ok: false,
      problem: { kind: 'symbol', message: expect.stringMatching(/two different things/) },
    });
  });

  it('leaves text alone, and refuses what is not a command', () => {
    const r = resolve([{ type: 'renameDocument', name: 'Costs r$x, e$y' }]);
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.value.command).toEqual({
      type: 'batch',
      commands: [{ type: 'renameDocument', name: 'Costs r$x, e$y' }],
    });
    expect(r.value.table).toEqual({});
    expect(hasSymbols({ name: 'abc$x' })).toBe(false);
    expect(hasSymbols({ id: 'extrude#$x' })).toBe(true);
    const bad = resolve([{ type: 'noSuchCommand' }]);
    expect(bad).toEqual({
      ok: false,
      problem: { kind: 'core', error: expect.objectContaining({ code: 'schema' }) },
    });
  });
});

const extension = (
  id: string,
  type: string,
  params: Record<string, unknown>,
  dependsOn: string[] = [],
) => ({
  type: 'addFeature',
  partId: PART,
  feature: {
    id,
    kind: 'extension',
    name: 'X',
    suppressed: false,
    extension: type,
    schemaVersion: 1,
    operation: 'new',
    dependsOn,
    references: [],
    expressions: {},
    params,
  },
});

const paramsOf = (command: unknown, i: number) =>
  (command as { commands: { feature: { params: unknown } }[] }).commands[i]!.feature.params;

describe('symbolic ids in extension params', () => {
  const idFields: IdFieldsOf = (type) =>
    type === 'test.thing'
      ? [
          { path: ['sketch'], kind: 'feature' },
          { path: ['entities', '*'], kind: 'entity' },
          { path: ['grain', 'entity'], kind: 'entity' },
        ]
      : undefined;

  it('resolves the fields the type declares as ids, and only those', () => {
    const r = resolveSymbols(
      bracketDocument(),
      {
        type: 'batch',
        commands: [
          sketch('sketch#$s'),
          extension(
            'extension#$t',
            'test.thing',
            {
              sketch: 'sketch#$s',
              entities: ['e$c'],
              grain: { entity: 'e$c' },
              note: 'Cut from sketch#$s, e$c',
            },
            ['sketch#$s'],
          ),
        ],
      },
      { idFields },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.value.table).toEqual({ $s: 'sketch#3', $c: 'e9', $t: 'extension#1' });
    expect(paramsOf(r.value.command, 1)).toEqual({
      sketch: 'sketch#3',
      entities: ['e9'],
      grain: { entity: 'e9' },
      note: 'Cut from sketch#$s, e$c',
    });
    expect(applyCommand(bracketDocument(), r.value.command).ok).toBe(true);
  });

  it('leaves params as text for a type with no id fields, or without the option', () => {
    const commands = [
      sketch('sketch#$s'),
      extension('extension#$t', 'test.other', { sketch: 'sketch#$s' }, ['sketch#$s']),
    ];
    const unknown = resolveSymbols(bracketDocument(), { type: 'batch', commands }, { idFields });
    if (!unknown.ok) throw new Error(JSON.stringify(unknown.problem));
    expect(paramsOf(unknown.value.command, 1)).toEqual({ sketch: 'sketch#$s' });
    const none = resolveSymbols(bracketDocument(), {
      type: 'batch',
      commands: [
        sketch('sketch#$s'),
        extension('extension#$t', 'test.thing', { sketch: 'sketch#$s' }, ['sketch#$s']),
      ],
    });
    if (!none.ok) throw new Error(JSON.stringify(none.problem));
    expect(paramsOf(none.value.command, 1)).toEqual({ sketch: 'sketch#$s' });
  });

  it('refuses a symbol in an id field that the batch does not create', () => {
    const r = resolveSymbols(
      bracketDocument(),
      {
        type: 'batch',
        commands: [extension('extension#$t', 'test.thing', { sketch: 'sketch#$ghost' })],
      },
      { idFields },
    );
    expect(r).toEqual({
      ok: false,
      problem: {
        kind: 'symbol',
        message:
          'No command of the batch creates $ghost: a symbol names something the batch makes.',
      },
    });
  });

  it('refuses an entity symbol in a feature field', () => {
    const r = resolveSymbols(
      bracketDocument(),
      {
        type: 'batch',
        commands: [sketch('sketch#$s'), extension('extension#$t', 'test.thing', { sketch: 'e$c' })],
      },
      { idFields },
    );
    expect(r).toEqual({
      ok: false,
      problem: {
        kind: 'symbol',
        message: expect.stringMatching(/\$c in params\.sketch of extension#1 .* names a feature/),
      },
    });
  });

  it("follows the woodworking domain's own declarations: a board's sketch, a joint's boards", () => {
    const wood = nodeExtensions();
    const r = resolveSymbols(
      bracketDocument(),
      {
        type: 'batch',
        commands: [
          sketch('sketch#$s'),
          extension(
            'extension#$board',
            'wood.board',
            {
              form: 'panel',
              stock: 'us-ply-23-32',
              sketch: 'sketch#$s',
              entities: ['e$c'],
            },
            ['sketch#$s'],
          ),
          extension(
            'extension#$other',
            'wood.board',
            {
              form: 'panel',
              stock: 'us-ply-23-32',
              sketch: 'sketch#$s',
            },
            ['sketch#$s'],
          ),
          extension(
            'extension#$dado',
            'wood.joint',
            {
              kind: 'dado',
              a: 'extension#$board',
              b: 'extension#$other',
            },
            ['extension#$board', 'extension#$other'],
          ),
        ],
      },
      { idFields: (type) => wood.lookup(type)?.definition.idFields },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(paramsOf(r.value.command, 1)).toMatchObject({ sketch: 'sketch#3', entities: ['e9'] });
    expect(paramsOf(r.value.command, 3)).toEqual({
      kind: 'dado',
      a: 'extension#1',
      b: 'extension#2',
    });
  });
});
