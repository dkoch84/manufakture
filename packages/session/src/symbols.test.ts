import { applyCommand } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { hasSymbols, resolveSymbols } from './symbols';
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
