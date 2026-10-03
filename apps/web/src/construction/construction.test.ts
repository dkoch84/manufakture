import { DEFAULT_UNITS, type ExtensionFeature } from '@manufakture/core';
import {
  CONSTRUCTION_NAMESPACE,
  FLOOR_TYPE,
  OPENING_TYPE,
  ROOF_TYPE,
  WALL_TYPE,
  readWallParams,
  type WallMetadata,
} from '@manufakture/domain-construction';
import { describe, expect, it } from 'vitest';
import {
  FT,
  FT_IN,
  HEADER,
  IN,
  PART,
  constructionDocument,
  run,
  settingsOf,
} from './construction.test-fixture';
import {
  CONSTRUCTION_DOMAIN,
  FLOOR_FEATURE,
  OPENING_FEATURE,
  ROOF_FEATURE,
  WALL_FEATURE,
  constructionLabel,
} from './kinds';
import { MAX_LENGTH_TEXT, checkLength, coordinateSource } from './lengths';
import { memberActionCommand, memberOwner } from './memberActions';
import {
  buildOpening,
  headerPreview,
  headerSourceText,
  headerUsed,
  newOpeningForm,
} from './openings';
import {
  addLevel,
  editLevel,
  editWallType,
  startCommand,
  wallTypeId,
  withLayer,
  withoutLayer,
} from './settings';
import {
  buildWall,
  buildWallFraming,
  directionOf,
  MAX_LAYER_JOIN_WALLS,
  finishPath,
  framingFormOf,
  meetingWalls,
  pathPoints,
  roleCounts,
  snapPoint,
  step,
  turn,
  type P2,
} from './walls';

/** A wall's regen metadata, as far as the layer joins read it. */
function wallMeta(points: readonly P2[], closed = false): WallMetadata {
  return {
    kind: 'wall',
    level: 'level-1',
    points,
    closed,
    free: { start: false, end: false },
  } as unknown as WallMetadata;
}

/** The 12' x 16' outline as typed: 16' right, 12' up, 16' left, then closed. */
const OUTLINE: P2[] = pathPoints(
  [0, 0],
  [
    { kind: 'typed', dir: 0, length: 16 * FT, text: `16'` },
    { kind: 'typed', dir: 90, length: 12 * FT, text: `12'` },
    { kind: 'typed', dir: 180, length: 16 * FT, text: `16'` },
  ],
);

function withWall(points: readonly P2[] = OUTLINE, closed = true) {
  const doc = constructionDocument();
  const r = buildWall(doc, PART, settingsOf(doc).settings, {
    level: 'level-1',
    wallType: 'exterior-2x4',
    points,
    closed,
  });
  if (!r.ok) throw new Error(r.message);
  return { doc: run(doc, r.command), wall: r.feature };
}

describe('the construction kinds', () => {
  it('name the domain types and namespace as the domain does', () => {
    expect(WALL_FEATURE).toBe(WALL_TYPE);
    expect(OPENING_FEATURE).toBe(OPENING_TYPE);
    expect(FLOOR_FEATURE).toBe(FLOOR_TYPE);
    expect(ROOF_FEATURE).toBe(ROOF_TYPE);
    expect(CONSTRUCTION_DOMAIN).toBe(CONSTRUCTION_NAMESPACE);
  });

  it('label floors and roofs in the tree', () => {
    const f = (extension: string) =>
      ({ kind: 'extension', extension, params: {} }) as unknown as ExtensionFeature;
    expect(constructionLabel(f(FLOOR_TYPE))).toBe('Floor');
    expect(constructionLabel(f(ROOF_TYPE))).toBe('Roof');
  });
});

describe('typed lengths', () => {
  it("read feet and inches as framers type them: 16', 11' 6-1/2\"", () => {
    const a = checkLength(`16'`, FT_IN);
    const b = checkLength(`11' 6-1/2"`, FT_IN);
    expect(a.ok && a.value).toBeCloseTo(16 * FT, 9);
    expect(b.ok && b.value).toBeCloseTo(138.5 * IN, 9);
    expect(b.ok && b.expression).toEqual({
      source: `11' 6-1/2"`,
      lengthUnit: 'in',
      angleUnit: 'deg',
    });
  });

  it('refuses long text before parsing it, huge values, and variables in settings', () => {
    expect(checkLength('1'.repeat(MAX_LENGTH_TEXT + 1), FT_IN)).toMatchObject({ ok: false });
    expect(checkLength('1e9', FT_IN)).toMatchObject({ ok: false });
    expect(checkLength('-3', FT_IN)).toMatchObject({ ok: false });
    expect(checkLength('-3', FT_IN, {}, { sign: 'any' })).toMatchObject({ ok: true });
    expect(checkLength('#h', FT_IN, {}, { constant: true })).toEqual({
      ok: false,
      message: 'Settings take a length, not a variable.',
    });
  });

  it('writes computed coordinates exactly to a 64th of an inch', () => {
    expect(coordinateSource((10 + 1 / 64) * IN, FT_IN)).toBe('10.015625');
    expect(coordinateSource(-0, FT_IN)).toBe('0');
    expect(coordinateSource(1000, DEFAULT_UNITS)).toBe('1000');
  });
});

describe('construction settings', () => {
  it('start with one level and no wall types or header rules', () => {
    const doc = constructionDocument();
    const { stored } = settingsOf(doc);
    expect(stored.levels.map((l) => l.name)).toEqual(['Level 1']);
    expect(stored.headerRules).toEqual([]);
    // A second start changes nothing.
    expect(startCommand(doc)).toMatchObject({ ok: true, command: null });
  });

  it('stack a new level on the highest and edit it as constants', () => {
    let doc = constructionDocument();
    const added = addLevel(doc);
    expect(added.ok).toBe(true);
    doc = run(doc, added.ok ? added.command : null);
    const second = settingsOf(doc).settings.levels[1]!;
    expect(second.name).toBe('Level 2');
    expect(second.elevation).toBeCloseTo(97.125 * IN, 6);
    const renamed = editLevel(doc, second.id, { field: 'name', value: 'Loft' });
    doc = run(doc, renamed.ok ? renamed.command : null);
    expect(settingsOf(doc).stored.levels[1]!.name).toBe('Loft');
    const bad = editLevel(doc, second.id, {
      field: 'height',
      value: { source: '#h', lengthUnit: 'in', angleUnit: 'deg' },
    });
    expect(bad.ok).toBe(false);
  });

  it('make wall type ids from names, unique', () => {
    expect(wallTypeId('Exterior 2x4', new Set())).toBe('exterior-2x4');
    expect(wallTypeId('Exterior 2x4', new Set(['exterior-2x4']))).toBe('exterior-2x4-1');
    expect(wallTypeId('!!!', new Set())).toBe('wall-type-1');
  });

  it('keep walls building when a wall type loses or gains its sheet layers, in one step', () => {
    const { doc } = withWall();
    const type = settingsOf(doc).stored.wallTypes[0]!;
    const bare = withoutLayer(type, 'sheathing');
    const r = editWallType(doc, bare, 'Edit');
    expect(r.ok && r.command?.type).toBe('batch');
    const after = run(doc, r.ok ? r.command : null);
    const wall = after.parts[0]!.features[0] as ExtensionFeature;
    expect(wall.operation).toBeUndefined();
    const back = withLayer(bare, 'drywall', 'us-gyp-1-2-8ft');
    expect(typeof back === 'string' ? back : back.layers.map((l) => l.kind)).toEqual([
      'framing',
      'drywall',
    ]);
    const r2 = editWallType(after, back as typeof bare, 'Edit');
    const again = run(after, r2.ok ? r2.command : null);
    expect((again.parts[0]!.features[0] as ExtensionFeature).operation).toBe('new');
  });

  it("keep each opening's scope on its host's layer bodies as the wall type's layers change", () => {
    const { doc: walled, wall } = withWall();
    const form = { ...newOpeningForm(wall.id), width: `3'`, height: `6' 8"` };
    const built = buildOpening(form, {
      doc: walled,
      partId: PART,
      variables: {},
      segmentLength: 12 * FT,
    });
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    let doc = run(walled, built.command);
    const scopeOf = (d: typeof doc) =>
      (d.parts[0]!.features.find((f) => f.id === built.feature.id) as ExtensionFeature).scope;
    expect(scopeOf(doc)).toEqual([`${wall.id}:layer/sheathing`]);
    const type = settingsOf(doc).stored.wallTypes[0]!;
    const more = withLayer(type, 'drywall', 'us-gyp-1-2-8ft');
    if (typeof more === 'string') throw new Error(more);
    const r = editWallType(doc, more, 'Edit');
    doc = run(doc, r.ok ? r.command : null);
    expect(scopeOf(doc)).toEqual([`${wall.id}:layer/sheathing`, `${wall.id}:layer/drywall`]);
    // A framing-only wall makes no bodies: the opening has no scope and cuts nothing.
    const bare = withoutLayer(withoutLayer(more, 'sheathing'), 'drywall');
    const r2 = editWallType(doc, bare, 'Edit');
    doc = run(doc, r2.ok ? r2.command : null);
    expect(scopeOf(doc)).toBeUndefined();
    // Unchanged layers edit no opening.
    const r3 = editWallType(doc, bare, 'Edit');
    expect(r3.ok && r3.command).toBeNull();
  });
});

describe('the wall path', () => {
  it('steps and turns in 90 degree steps', () => {
    expect(step([0, 0], 90, 10)).toEqual([0, 10]);
    expect(turn(0, 'left')).toBe(90);
    expect(turn(0, 'right')).toBe(270);
    expect(directionOf([0, 0], [-5, 0])).toBe(180);
    expect(directionOf([0, 0], [5, 5])).toBeNull();
  });

  it('snaps to a wall end first, then square to the last point on the grid, then the grid', () => {
    const ctx = { endpoints: [[1000, 1000] as P2], grid: IN, tolerance: 6 * IN };
    expect(snapPoint([1050, 990], ctx)).toEqual({ point: [1000, 1000], kind: 'endpoint' });
    const sq = snapPoint([3000.4, 40], { ...ctx, from: [0, 0] });
    expect(sq.kind).toBe('square');
    expect(sq.point[1]).toBe(0);
    expect(sq.point[0] / IN).toBeCloseTo(118, 9);
    expect(snapPoint([3000.4, 2000.3], { ...ctx, from: [0, 0] }).kind).toBe('grid');
  });

  it('closes a loop that ends on its start and turns it counter-clockwise', () => {
    const cw: P2[] = [
      [0, 0],
      [0, 12 * FT],
      [16 * FT, 12 * FT],
      [16 * FT, 0],
      [0, 0],
    ];
    const r = finishPath({ points: cw, closed: false });
    expect(r).toMatchObject({ ok: true, closed: true, reversed: true });
    if (r.ok) expect(r.points[1]).toEqual([16 * FT, 0]);
  });

  it('refuses paths past the limits and zero-length segments', () => {
    expect(finishPath({ points: [[0, 0]], closed: false }).ok).toBe(false);
    expect(
      finishPath({
        points: [
          [0, 0],
          [0, 0.1],
        ],
        closed: false,
      }).ok,
    ).toBe(false);
    expect(
      finishPath({
        points: [
          [0, 0],
          [200_000, 0],
        ],
        closed: false,
      }).ok,
    ).toBe(false);
    const many = Array.from({ length: 70 }, (_, i): P2 => [i * 100, (i % 2) * 100]);
    expect(finishPath({ points: many, closed: false }).ok).toBe(false);
  });

  it('builds a closed wall the domain reads, with its layer bodies', () => {
    const { wall } = withWall();
    expect(wall.name).toBe('Wall 1');
    expect(wall.operation).toBe('new');
    expect(wall.params).toEqual({
      level: 'level-1',
      wallType: 'exterior-2x4',
      points: 4,
      closed: true,
    });
    expect(wall.expressions.x2!.source).toBe('192');
    expect(wall.expressions.y3!.source).toBe('144');
    expect(readWallParams(wall.params as never, wall.schemaVersion).ok).toBe(true);
  });

  it('sets and clears a wall framing settings, refusing a spacing under 50 mm', () => {
    const { doc, wall } = withWall();
    const form = { ...framingFormOf(wall), spacing: '24"', topPlates: '1' as const };
    const r = buildWallFraming(doc, PART, wall.id, form, {});
    expect(r.ok).toBe(true);
    const after = run(doc, r.ok ? r.command : null);
    const edited = after.parts[0]!.features[0] as ExtensionFeature;
    expect(edited.expressions.spacing!.source).toBe('24"');
    expect(edited.params.framing).toEqual({ topPlates: 1 });
    expect(framingFormOf(edited).spacing).toBe('24"');
    const bad = buildWallFraming(after, PART, wall.id, { ...form, spacing: '1"' }, {});
    expect(bad.ok).toBe(false);
    const cleared = buildWallFraming(after, PART, wall.id, framingFormOf(wall), {});
    const back = run(after, cleared.ok ? cleared.command : null);
    expect((back.parts[0]!.features[0] as ExtensionFeature).params.framing).toBeUndefined();
  });

  it("names the earlier walls each of a 12' x 16' shed's four walls meets, the last the first", () => {
    let doc = constructionDocument();
    const shed: P2[][] = [
      [
        [0, 0],
        [16 * FT, 0],
      ],
      [
        [16 * FT, 0],
        [16 * FT, 12 * FT],
      ],
      [
        [16 * FT, 12 * FT],
        [0, 12 * FT],
      ],
      [
        [0, 12 * FT],
        [0, 0],
      ],
    ];
    const built: { id: string; meta: WallMetadata }[] = [];
    const deps: string[][] = [];
    for (const points of shed) {
      const r = buildWall(doc, PART, settingsOf(doc).settings, {
        level: 'level-1',
        wallType: 'exterior-2x4',
        points,
        closed: false,
        others: built,
      });
      if (!r.ok) throw new Error(r.message);
      doc = run(doc, r.command);
      deps.push(r.feature.dependsOn);
      built.push({ id: r.feature.id, meta: wallMeta(points) });
    }
    expect(deps).toEqual([[], ['extension#1'], ['extension#2'], ['extension#1', 'extension#3']]);
    // A tee: a wall ending inside another's segment names it; one on another level does not.
    expect(
      meetingWalls(
        {
          points: [
            [8 * FT, 0],
            [8 * FT, 6 * FT],
          ],
          closed: false,
        },
        'level-1',
        [
          { id: 'a', meta: wallMeta(shed[0]!) },
          { id: 'b', meta: { ...wallMeta(shed[0]!), level: 'level-2' } },
          { id: 'c', meta: wallMeta(shed[1]!) },
        ],
      ),
    ).toEqual(['a']);
  });

  it('names at most MAX_LAYER_JOIN_WALLS walls', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `w${i}`,
      meta: wallMeta([
        [0, 0],
        [1000, (i + 1) * 10],
      ]),
    }));
    expect(
      meetingWalls(
        {
          points: [
            [0, 0],
            [-1000, 0],
          ],
          closed: false,
        },
        'level-1',
        many,
      ),
    ).toHaveLength(MAX_LAYER_JOIN_WALLS);
  });

  it('counts members by role', () => {
    expect(roleCounts(undefined)).toEqual({ total: 0, roles: [] });
  });
});

describe('openings', () => {
  it('centres a door on its segment and names it after its kind', () => {
    const { doc, wall } = withWall();
    const form = { ...newOpeningForm(wall.id), segment: 2, width: `3'`, height: `6' 8"` };
    const r = buildOpening(form, { doc, partId: PART, variables: {}, segmentLength: 12 * FT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.feature.name).toBe('Door 1');
    expect(r.feature.dependsOn).toEqual([wall.id]);
    // Scoped to the host's layer bodies, so it reads only those.
    expect(r.feature.scope).toEqual([`${wall.id}:layer/sheathing`]);
    expect(r.feature.expressions.position!.source).toBe('72');
    expect(r.feature.params).toEqual({
      kind: 'door',
      segment: 2,
      from: 'start',
      header: { kind: 'auto' },
    });
    expect(constructionLabel(r.feature)).toBe('Door');
  });

  it('needs a sill for a window, and every field of an explicit header', () => {
    const { doc, wall } = withWall();
    const base = { ...newOpeningForm(wall.id), kind: 'window' as const, width: "2'", height: "3'" };
    const ctx = { doc, partId: PART, variables: {}, segmentLength: 16 * FT };
    expect(buildOpening(base, ctx)).toMatchObject({
      ok: false,
      errors: { sill: expect.any(String) },
    });
    const r = buildOpening(
      { ...base, sill: '44"', header: 'explicit', headerStock: 'us-2x6' },
      ctx,
    );
    expect(r).toMatchObject({
      ok: false,
      errors: { headerPlies: expect.any(String), headerJacks: expect.any(String) },
    });
    expect(buildOpening({ ...base, sill: '44"', width: `17'` }, ctx)).toMatchObject({
      ok: false,
      errors: { width: expect.stringContaining('Wider') },
    });
  });

  it('previews the narrowest header rule wide enough, whatever the order, else the default', () => {
    const { doc } = withWall();
    const s = settingsOf(doc).settings;
    const type = s.wallTypes[0];
    const rules = {
      ...s,
      headerRules: [
        { maxWidth: 72 * IN, header: { stock: 'us-2x10', plies: 2, jacks: 2 } },
        { maxWidth: 48 * IN, header: { stock: 'us-2x6', plies: 2, jacks: 1 } },
      ],
    };
    expect(headerPreview(rules, type, 36 * IN, 'auto')).toMatchObject({ source: 'rule', rule: 1 });
    expect(headerPreview(rules, type, 60 * IN, 'auto')).toMatchObject({ source: 'rule', rule: 0 });
    const wide = headerPreview(rules, type, 96 * IN, 'auto');
    expect(wide).toMatchObject({ source: 'default', header: HEADER, uncovered: true });
    expect(headerSourceText(wide, FT_IN)).toContain('No header rule is this wide');
    // New documents have no rules: the wall type's default.
    const none = headerPreview(s, type, 36 * IN, 'auto');
    expect(none).toEqual({ source: 'default', header: HEADER, uncovered: false });
    expect(headerSourceText(none, FT_IN)).toBe(
      "The wall type's default header: 2 plies of 2x8 on 1 jack stud each end.",
    );
    expect(headerSourceText(headerPreview(rules, type, 36 * IN, 'auto'), FT_IN)).toContain(
      `up to 4'`,
    );
  });

  it("reads the header an opening used from its wall's set", () => {
    const meta = {
      openings: [
        {
          id: 'extension#2',
          header: { source: 'rule', rule: 0, stock: 'us-2x6', plies: 2, jacks: 1 },
          framed: true,
        },
      ],
    };
    expect(headerUsed(meta, 'extension#2')).toEqual({
      source: 'rule',
      rule: 0,
      stock: 'us-2x6',
      plies: 2,
      jacks: 1,
      framed: true,
    });
    expect(headerUsed(meta, 'extension#9')).toBeUndefined();
    expect(headerUsed(null, 'extension#2')).toBeUndefined();
  });
});

describe('member actions', () => {
  it('delete, change the stock of and restore a member, keeping nudges with their overrides', () => {
    const { doc, wall } = withWall();
    const full = `${wall.id}:s3`;
    expect(memberOwner(doc, PART, full)).toMatchObject({ localId: 's3', index: -1 });
    const del = memberActionCommand(doc, PART, full, { kind: 'delete' });
    let after = run(doc, del.ok ? del.command : null);
    const stock = memberActionCommand(after, PART, `${wall.id}:top1:2`, {
      kind: 'stock',
      stock: 'us-2x6',
    });
    after = run(after, stock.ok ? stock.command : null);
    // A nudge of the second override, as the domain stores it.
    const f = after.parts[0]!.features[0] as ExtensionFeature;
    after = run(after, {
      type: 'editFeature',
      partId: PART,
      feature: {
        ...f,
        expressions: {
          ...f.expressions,
          move_2: { source: '1', lengthUnit: 'in', angleUnit: 'deg' },
        },
      },
    });
    expect((after.parts[0]!.features[0] as ExtensionFeature).params.overrides).toEqual([
      { id: 's3', delete: true },
      { id: 'top1:2', stock: 'us-2x6' },
    ]);
    const restore = memberActionCommand(after, PART, full, { kind: 'restore' });
    after = run(after, restore.ok ? restore.command : null);
    const w = after.parts[0]!.features[0] as ExtensionFeature;
    expect(w.params.overrides).toEqual([{ id: 'top1:2', stock: 'us-2x6' }]);
    expect(w.expressions.move_1!.source).toBe('1');
    expect(w.expressions.move_2).toBeUndefined();
    expect(memberActionCommand(after, PART, full, { kind: 'stock', stock: 'us-osb-7-16' }).ok).toBe(
      false,
    );
    expect(memberActionCommand(after, PART, 'sketch#1:s1', { kind: 'delete' }).ok).toBe(false);
  });
});
