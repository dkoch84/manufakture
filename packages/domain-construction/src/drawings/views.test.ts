import {
  MAX_DOMAIN_CHAIN_MARKS,
  MAX_DOMAIN_CHAIN_POINTS,
  MAX_DOMAIN_VIEW_ARCS,
  MAX_DOMAIN_VIEW_LINES,
  MAX_DOMAIN_VIEW_SYMBOLS,
  checkDomainView,
  type DomainViewContext,
  type DomainViewOutput,
  type MemberData,
} from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { readViewParams } from './params';
import {
  MAX_CHAIN_MARKS,
  MAX_CHAIN_POINTS,
  MAX_VIEW_ARCS,
  MAX_VIEW_LINES,
  MAX_VIEW_SYMBOLS,
  constructionDrawings,
  constructionView,
} from './views';

const IN = 25.4;
/** One coordinate of each point, in inches to a millionth. */
const inches = (points: readonly (readonly number[])[], i: number) =>
  points.map((p) => Math.round((p[i]! / IN) * 1e6) / 1e6);

/** A wall's metadata as the wall translator reports it: 16' along +x, 2x4 framing, OSB outside. */
const WALL = {
  kind: 'wall',
  level: 'level-1',
  base: 0,
  height: 97.125 * IN,
  points: [
    [0, 0],
    [192 * IN, 0],
  ],
  closed: false,
  justification: 'left',
  thickness: 3.5 * IN,
  free: { start: false, end: false },
  layers: [
    {
      id: 'sheathing',
      kind: 'sheathing',
      body: 'extension#1:layer/sheathing',
      t: [-0.4375 * IN, 0],
    },
    { id: 'framing', kind: 'framing', body: null, t: [0, 3.5 * IN] },
  ],
  settings: {},
  overrides: [],
};

const door = (position: number) => ({
  kind: 'opening',
  wall: 'extension#1',
  type: 'door',
  segment: 1,
  position: position * IN,
  width: 36 * IN,
  height: 80 * IN,
  sill: 0,
  header: { kind: 'auto' },
  overrides: [],
  cuts: [],
});

/** A stud of the wall at `x` inches (its near face), standing on the base. */
const stud = (id: string, x: number): MemberData => ({
  id,
  owner: 'extension#1',
  role: 'stud',
  stock: { id: 'us-2x4', name: '2x4', width: 1.5 * IN, depth: 3.5 * IN },
  length: 92.625 * IN,
  placement: { origin: [x * IN, 0, 1.5 * IN], x: [0, 0, 1], y: [1, 0, 0] },
  cuts: [],
});

function context(params: Record<string, unknown>, at = 48): DomainViewContext {
  return {
    partId: 'part#1',
    params: params as DomainViewContext['params'],
    schemaVersion: 1,
    features: [
      {
        id: 'extension#1',
        type: 'construction.wall',
        schemaVersion: 1,
        dependsOn: [],
        metadata: WALL as never,
      },
      {
        id: 'extension#2',
        type: 'construction.opening',
        schemaVersion: 1,
        dependsOn: ['extension#1'],
        metadata: door(at) as never,
      },
    ],
    sets: [
      { group: 'extension#1', members: [stud('s0', 0), stud('s1', 15.25), stud('s2', 31.25)] },
    ],
    data: {
      construction: {
        stored: {},
        settings: {
          levels: [{ id: 'level-1', name: 'Level 1', elevation: 0, height: 97.125 * IN }],
        },
      },
    },
    bodies: ['extension#1:layer/sheathing'],
    evaluate: (e, kind) => {
      const s = (e as { source?: unknown }).source;
      return kind === 'length' && typeof s === 'string' && /^\d+$/.test(s)
        ? { ok: true, value: Number(s) * IN }
        : { ok: false, message: 'not a length' };
    },
  };
}

function drawn(params: Record<string, unknown>, at?: number): DomainViewOutput {
  const out = constructionView(context(params, at));
  if ('error' in out) throw new Error(out.error);
  // Exactly what regen accepts.
  const checked = checkDomainView(out);
  if (!checked.ok) throw new Error(checked.message);
  return checked.view;
}

describe('construction view params', () => {
  it('reads each kind with its defaults', () => {
    expect(readViewParams({ kind: 'plan', level: 'level-1' }, 1)).toEqual({
      ok: true,
      value: {
        kind: 'plan',
        level: 'level-1',
        openings: 'rough',
        strings: 'single',
        hide: [],
      },
    });
    expect(readViewParams({ kind: 'elevation', wall: 'extension#1' }, 1)).toEqual({
      ok: true,
      value: {
        kind: 'elevation',
        wall: 'extension#1',
        segment: 1,
        from: 'outside',
        openings: 'rough',
        marks: true,
        hide: [],
      },
    });
    expect(readViewParams({ kind: 'roof-plan', roof: 'extension#6' }, 1).ok).toBe(true);
  });

  it('reads the strings a view hides, once each, and the architectural plan', () => {
    const r = readViewParams(
      {
        kind: 'plan',
        level: 'level-1',
        strings: 'architectural',
        hide: ['extension#1:s1:overall', 'extension#1:s1:overall', 'extension#2:s1:centres'],
      },
      1,
    );
    expect(r.ok && r.value).toMatchObject({
      strings: 'architectural',
      hide: ['extension#1:s1:overall', 'extension#2:s1:centres'],
    });
    const roof = readViewParams({ kind: 'roof-plan', roof: 'extension#6', hide: ['x:eave'] }, 1);
    expect(roof.ok && roof.value).toEqual({
      kind: 'roof-plan',
      roof: 'extension#6',
      hide: ['x:eave'],
    });
  });

  it.each([
    ['a newer version', { kind: 'plan', level: 'level-1' }, 2],
    ['an unknown kind', { kind: 'section' }, 1],
    ['an unknown field', { kind: 'plan', level: 'level-1', scale: 2 }, 1],
    ['no level', { kind: 'plan' }, 1],
    ['a segment of 0', { kind: 'elevation', wall: 'extension#1', segment: 0 }, 1],
    ['a segment past a path', { kind: 'elevation', wall: 'extension#1', segment: 65 }, 1],
    ['a side that is not one', { kind: 'elevation', wall: 'extension#1', from: 'above' }, 1],
    ['marks that are not true or false', { kind: 'elevation', wall: 'extension#1', marks: 1 }, 1],
    ['stops that are not ones', { kind: 'plan', level: 'level-1', openings: 'edges' }, 1],
    ['strings that are not a style', { kind: 'plan', level: 'level-1', strings: 'double' }, 1],
    ['hide that is not a list', { kind: 'plan', level: 'level-1', hide: 'extension#1:s1' }, 1],
    ['hide with an empty id', { kind: 'roof-plan', roof: 'extension#6', hide: [''] }, 1],
    [
      'hide with too many ids',
      { kind: 'plan', level: 'level-1', hide: Array.from({ length: 257 }, (_, i) => `w${i}`) },
      1,
    ],
    ['an array', [], 1],
  ])('refuses %s', (_label, params, version) => {
    expect(readViewParams(params, version).ok).toBe(false);
  });

  it('holds the same bounds as regen', () => {
    expect(MAX_VIEW_LINES).toBe(MAX_DOMAIN_VIEW_LINES);
    expect(MAX_VIEW_ARCS).toBe(MAX_DOMAIN_VIEW_ARCS);
    expect(MAX_CHAIN_POINTS).toBe(MAX_DOMAIN_CHAIN_POINTS);
    expect(MAX_CHAIN_MARKS).toBe(MAX_DOMAIN_CHAIN_MARKS);
    expect(MAX_VIEW_SYMBOLS).toBe(MAX_DOMAIN_VIEW_SYMBOLS);
    expect(constructionDrawings.schemaVersion).toBe(1);
  });
});

describe('construction views', () => {
  it('a plan: cut at 4 ft, the layers to project, member sections, the swing and a string', () => {
    const v = drawn({ kind: 'plan', level: 'level-1' });
    expect(v.direction).toEqual([0, 0, -1]);
    expect(v.section!.normal).toEqual([0, 0, 1]);
    expect(v.section!.origin[2]).toBeCloseTo(48 * IN, 9);
    expect(v.bodies).toEqual(['extension#1:layer/sheathing']);
    // Three studs, four sides each, and the door's leaf.
    expect(v.lines).toHaveLength(3 * 4 + 1);
    expect(v.arcs).toHaveLength(1);
    const [chain] = v.chains!;
    expect(inches(chain!.points, 0)).toEqual([0, 30, 66, 192]);
    // Outside the wall: to the right of its path (the exterior).
    expect(chain!.side.map((x) => x + 0)).toEqual([0, -1, 0]);
    expect(constructionDrawings.titleNote).toBe(DISCLAIMER_SHORT);
  });

  it('a plan cut elsewhere, its strings at the openings centres, or none', () => {
    const low = drawn({ kind: 'plan', level: 'level-1', cut: { source: '36' } });
    expect(low.section!.origin[2]).toBeCloseTo(36 * IN, 9);
    const centres = drawn({ kind: 'plan', level: 'level-1', openings: 'centre' }).chains![0]!;
    expect(inches(centres.points, 0)).toEqual([0, 48, 192]);
    expect(drawn({ kind: 'plan', level: 'level-1', openings: 'none' }).chains).toEqual([]);
  });

  it('a framing elevation: members, a string with layout marks, one up the side', () => {
    const v = drawn({ kind: 'elevation', wall: 'extension#1' });
    expect(v.direction.map((x) => x + 0)).toEqual([0, 1, 0]);
    expect(v.bodies).toEqual([]);
    expect(v.lines).toHaveLength(3 * 4);
    const [along, up] = v.chains!;
    expect(inches(along!.points, 0)).toEqual([0, 30, 66, 192]);
    expect(inches(along!.marks!, 0)).toEqual([0.75, 16, 32]);
    expect(inches(up!.points, 2)).toEqual([0, 80, 97.125]);
    // From inside, the other way.
    expect(drawn({ kind: 'elevation', wall: 'extension#1', from: 'inside' }).direction).toEqual([
      0, -1, 0,
    ]);
  });

  it('moving the door moves the string', () => {
    const v = drawn({ kind: 'elevation', wall: 'extension#1' }, 60);
    expect(inches(v.chains![0]!.points, 0)).toEqual([0, 42, 78, 192]);
  });

  it('an architectural plan: centres, rough openings and the overall, outward in that order', () => {
    const v = drawn({ kind: 'plan', level: 'level-1', strings: 'architectural' });
    expect(v.chains!.map((c) => c.id)).toEqual([
      'extension#1:s1:centres',
      'extension#1:s1:openings',
      'extension#1:s1:overall',
    ]);
    expect(v.chains!.map((c) => inches(c.points, 0))).toEqual([
      [0, 48, 192],
      [0, 30, 66, 192],
      [0, 192],
    ]);
    expect(v.chains!.map((c) => c.offset)).toEqual([10, 24, 38]);
    expect(v.chains!.every((c) => c.overall === false)).toBe(true);
    // A wall with no openings: its overall alone.
    const plain = constructionView({
      ...context({ kind: 'plan', level: 'level-1', strings: 'architectural' }),
      features: context({}).features.slice(0, 1),
    });
    expect('error' in plain ? [] : plain.chains!.map((c) => c.id)).toEqual([
      'extension#1:s1:overall',
    ]);
  });

  it('hides the strings a view lists, and nothing else', () => {
    const v = drawn({
      kind: 'plan',
      level: 'level-1',
      strings: 'architectural',
      hide: ['extension#1:s1:openings', 'no-such-string'],
    });
    expect(v.chains!.map((c) => c.id)).toEqual([
      'extension#1:s1:centres',
      'extension#1:s1:overall',
    ]);
    // The rest of the view is as drawn without `hide`.
    expect(v.lines).toHaveLength(3 * 4 + 1);
    const e = drawn({ kind: 'elevation', wall: 'extension#1', hide: ['extension#1:s1:up'] });
    expect(e.chains!.map((c) => c.id)).toEqual(['extension#1:s1:along']);
  });

  it('says what it cannot draw', () => {
    const err = (params: Record<string, unknown>) => {
      const out = constructionView(context(params));
      return 'error' in out ? out.error : null;
    };
    expect(err({ kind: 'plan', level: 'level-9' })).toMatch(/not one of the document's levels/);
    expect(err({ kind: 'plan', level: 'level-1', cut: { source: 'x' } })).toMatch(
      /does not evaluate/,
    );
    expect(err({ kind: 'elevation', wall: 'extension#2' })).toMatch(/not a wall/);
    expect(err({ kind: 'elevation', wall: 'extension#1', segment: 2 })).toMatch(/no segment 2/);
    expect(err({ kind: 'roof-plan', roof: 'extension#1' })).toMatch(/not a roof/);
    expect(err({ kind: 'plan' })).toMatch(/level/);
  });
});
