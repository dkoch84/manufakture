// M8 acceptance scenario T8.6b, heat-set inserts in a printed enclosure, as a scripted MCP client:
// a fixed sequence of tool calls through the real server (in process), on the enclosure fixture
// (test/fixtures/heat-set-inserts/enclosure.ts). The request it carries out:
//
//   "Put M3 heat-set inserts in the four lid bosses of this enclosure and make the lid screw
//    holes clear."
//
// It does the scenario as far as the product allows: finds the bosses by geometry, drills the
// insert holes, makes the lid holes clear, checks the boss wall and the hole depth, widens the
// bosses when the wall is too thin, renders a section, submits for review and exports.
//
// Tests named "gap probe" assert a gap the plan predicted (or the scenario found) as it stands
// today. When a later task closes one, its probe fails on purpose: update the probe and the gap
// table in docs/m8-acceptance/heat-set-inserts.md together.
//
// Insert numbers are CNC Kitchen's M3 standard insert (hole D3 4.0 mm, length L 5.7 mm, minimum
// wall W 1.6 mm), the table packages/print holds as HEAT_SET_INSERTS. The run reads them, and M3
// normal clearance, from the tables resource (manufakture://tables/holes) and checks them against
// the numbers written out here. Set HEAT_SET_INSERTS_IMAGES to a directory to keep the rendered
// PNGs for a look.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_URI, TABLES_URI } from '../../src/resources';
import {
  BOSSES,
  BOX,
  ENCLOSURE_ID,
  LID_HOLE,
  PART,
  enclosureDocument,
} from '../fixtures/heat-set-inserts/enclosure';
import { harness, value, type Data, type Harness } from '../harness';

const INSERT = { size: 'M3', hole: 4.0, length: 5.7, minWall: 1.6 } as const;
/** The hole depth this run drills: the insert's length plus room for the plastic it displaces. */
const INSERT_DEPTH = 6.5;
/** ISO 273 normal clearance for M3, the kernel's HOLE_SIZES. */
const M3_CLEAR = 3.4;
const BASE = 'extrude#1';
const LID = 'extrude#3';

const mm = (v: number | string) => ({
  source: typeof v === 'number' ? `${v} mm` : v,
  lengthUnit: 'mm',
  angleUnit: 'deg',
});

/** Rounded to a micrometre, and -0 made 0: kernel numbers compared as the test writes them. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const v6 = (v: number[]) => v.map(r6);

let h: Harness;
let sessionId: string;
/** Real ids from the insert batch. */
let insertHole: string;
let insertPoints: string[];

const IMAGES = process.env.HEAT_SET_INSERTS_IMAGES;

function keepImages(name: string, r: CallToolResult) {
  if (IMAGES === undefined) return;
  mkdirSync(IMAGES, { recursive: true });
  r.content.forEach((c, i) => {
    if (c.type === 'image') {
      writeFileSync(path.join(IMAGES, `${name}-${i}.png`), Buffer.from(c.data, 'base64'));
    }
  });
}

/**
 * The warning get_errors and an apply report give for the insert hole at `point` in the boss
 * whose side is swept by `entity`: the 7 mm boss leaves 1.5 mm around the 4.0 mm hole.
 */
function thinWall(hole: string, point: string, entity: string) {
  return {
    where: 'feature',
    partId: PART,
    featureId: hole,
    severity: 'warning',
    code: 'thin-wall',
    message: `The wall around ${hole} at ${point} on ${BASE} is 1.5 mm, under the M3 heat-set insert's minimum of ${INSERT.minWall} mm (to extrude#2:side:${entity})`,
  };
}

/** Distance between two named items of the base body. */
async function distance(a: string, b: string, kinds: ['face' | 'edge', 'face' | 'edge']) {
  const r = value(
    await h.call('measure', {
      sessionId,
      query: {
        kind: 'targets',
        partId: PART,
        bodyId: BASE,
        targets: [
          { kind: kinds[0], name: a },
          { kind: kinds[1], name: b },
        ],
      },
    }),
  );
  return r.measurement.distance.value as number;
}

beforeAll(async () => {
  h = await harness({ document: enclosureDocument() });
}, 60_000);

afterAll(async () => {
  await h.close();
});

describe('heat-set inserts in a printed enclosure (T8.6b)', () => {
  it('opens a session on the enclosure, which regenerates clean', async () => {
    const r = value(await h.call('open_session', { documentId: ENCLOSURE_ID }));
    sessionId = r.sessionId;
    expect(r.outline.parts[0].bodies.map((b: Data) => b.bodyId)).toEqual([BASE, LID]);
    expect(value(await h.call('get_errors', { sessionId })).errors).toEqual([]);
  });

  it('finds the four lid bosses by geometry, and the lid holes over them', async () => {
    // The bosses are the outward cylinders of the base; the scenario knows their radius, a person
    // asking would not: so first every cylinder of the base, then the ones whose name says boss.
    const cylinders = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bodyId: BASE, radius: BOSSES.radius },
      }),
    ).hits as Data[];
    expect(cylinders.map((c) => c.name)).toEqual(BOSSES.entities.map((e) => `extrude#2:side:${e}`));
    // A full cylinder's centroid lies on its axis: the boss centres, at mid height.
    expect(cylinders.map((c) => v6(c.centroid))).toEqual(
      BOSSES.centres.map(([x, y]) => [x, y, (BOSSES.bottom + BOSSES.top) / 2]),
    );
    // measure gives the axis as a line (origin and direction), so coaxiality can be checked.
    const lid = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bodyId: LID, bornBy: 'hole#1' },
      }),
    ).hits as Data[];
    expect(lid.map((f) => v6([f.centroid[0], f.centroid[1], f.radius]))).toEqual(
      BOSSES.centres.map(([x, y]) => [x, y, LID_HOLE.diameter / 2]),
    );
    const axis = value(
      await h.call('measure', {
        sessionId,
        query: {
          kind: 'targets',
          partId: PART,
          bodyId: BASE,
          targets: [{ kind: 'face', name: 'extrude#2:side:e5' }],
        },
      }),
    ).measurement.items[0].axis;
    expect([v6(axis.origin), v6(axis.direction)]).toEqual([
      [8, 8, BOSSES.bottom],
      [0, 0, -1],
    ]);
  });

  it('tells a boss from a hole, and gives a point on its axis', async () => {
    const hit = (
      value(
        await h.call('find_geometry', {
          sessionId,
          query: { kind: 'face', partId: PART, name: 'extrude#2:side:e5' },
        }),
      ).hits as Data[]
    )[0]!;
    // The same axis line measure gives: the hit alone tells coaxial faces from parallel ones.
    expect([hit.surface, v6(hit.axis), v6(hit.axisOrigin), hit.radius, hit.hole]).toEqual([
      'cylinder',
      [0, 0, -1],
      [8, 8, BOSSES.bottom],
      BOSSES.radius,
      false,
    ]);
    const lid = (
      value(
        await h.call('find_geometry', {
          sessionId,
          query: { kind: 'face', partId: PART, bodyId: LID, bornBy: 'hole#1' },
        }),
      ).hits as Data[]
    ).map((f) => f.hole);
    expect(lid).toEqual([true, true, true, true]);
  });

  it('names each boss top after its circle, not by an ordinal, so the names are not fragile', async () => {
    // Was a gap probe: one extrude of four circles named its tops `extrude#2:cap:end#1` to `#4`,
    // all fragile. Each top is now named after its circle, like its side.
    const tops = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bornBy: 'extrude#2', normal: [0, 0, 1] },
      }),
    ).hits as Data[];
    expect(tops.map((t) => [t.name, t.fragile])).toEqual(
      BOSSES.entities.map((e) => [`extrude#2:cap:end:${e}`, false]),
    );
  });

  it('reads the M3 insert hole and M3 clearance from the tables resource', async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri)).toContain(TABLES_URI);
    const first = (await h.client.readResource({ uri: TABLES_URI })).contents[0] as {
      text: string;
      mimeType: string;
    };
    expect(first.mimeType).toBe('application/json');
    const tables = JSON.parse(first.text) as Data;
    expect(tables.units).toEqual({ length: 'mm', angle: 'deg' });
    const insert = (tables.heatSetInserts.sizes as Data[]).find((i) => i.size === INSERT.size)!;
    expect(insert).toMatchObject({
      hole: INSERT.hole,
      length: INSERT.length,
      minWall: INSERT.minWall,
      verified: true,
      source: expect.stringMatching(/CNC Kitchen/),
    });
    const clearance = (tables.clearanceHoles.sizes as Data[]).find((s) => s.size === 'M3')!;
    expect(clearance.clearance.normal).toBe(M3_CLEAR);
    expect(clearance.verified).toEqual({ clearance: true, counterbore: false, countersink: false });
    expect(clearance.countersink.angle).toBe(90);
    expect(tables.clearanceHoles.sources.clearance.metric).toMatch(/ISO 273/);
    // The thread table says why the scenario leaves the thread off: an M3 thread wants a hole
    // far smaller than the insert's.
    const thread = (tables.threads.sizes as Data[]).find((s) => s.size === 'M3')!;
    expect([thread.tapDrill, thread.internalHole]).toEqual([2.5, { min: 1.9587, max: 2.8647 }]);
    expect(thread.internalHole.max).toBeLessThan(INSERT.hole);
    expect((tables.selfTappingHoles.sizes as Data[]).every((h) => h.verified === false)).toBe(true);
  });

  it('offers an insert hole kind and a tip angle in the hole schema', async () => {
    // Was a gap probe: heads, fits and thread representations had nothing for an insert, so the
    // hole's purpose lived only in its name. A hole standard now says what the hole is for.
    const hole = value(await h.call('get_schema', { feature: 'hole' })).schema as Data;
    const heads = (hole.properties.head.oneOf as Data[]).map((o) => o.properties.type.const);
    expect(heads).toEqual(['simple', 'counterbore', 'countersink']);
    const standard = hole.properties.standard as Data;
    expect(standard.properties.fit.enum).toEqual(['close', 'normal', 'loose']);
    expect(standard.properties.purpose.enum).toEqual(['heat-set-insert']);
    expect(standard.required).toEqual(['size']);
    expect(hole.properties.standard.description).toMatch(/heat-set insert/);
    // A blind hole takes a tip angle; 180 deg is a flat bottom.
    const blind = (hole.properties.extent.oneOf as Data[]).find(
      (o) => o.properties.type.const === 'blind',
    )!;
    expect(Object.keys(blind.properties)).toEqual(['type', 'depth', 'tipAngle']);
    expect(blind.required).toEqual(['type', 'depth']);
    expect(hole.properties.extent.description).toMatch(/180 deg is a flat bottom/);
    // Still no thread for an insert: the thread feature cuts threads, an insert brings its own.
    const thread = value(await h.call('get_schema', { feature: 'thread' })).schema as Data;
    expect(thread.properties.representation.enum).toEqual(['modelled', 'cosmetic']);
    expect(JSON.stringify(thread)).not.toMatch(/heat.?set|insert/i);
    // The guide (fixed after this scenario found it sending inserts to a cosmetic thread) says to
    // drill the insert's own hole and leave the thread off.
    const guide = (await h.client.readResource({ uri: GUIDE_URI })).contents[0] as { text: string };
    expect(guide.text).not.toMatch(/cosmetic[^.]*heat-set inserts/);
    expect(guide.text).toMatch(/do \*\*not\*\* put a\s+`thread` on its hole/);
    expect(guide.text).toMatch(/purpose: 'heat-set-insert'/);
  });

  it('makes an M3 insert hole from the table: 4.0 mm, the insert length deep, flat bottomed', async () => {
    // In a session of its own, so the scenario's model is untouched: the table's numbers as they
    // come, the insert standard and a flat bottom.
    const tables = JSON.parse(
      ((await h.client.readResource({ uri: TABLES_URI })).contents[0] as { text: string }).text,
    ) as Data;
    const row = (tables.heatSetInserts.sizes as Data[]).find((i) => i.size === INSERT.size)!;
    const own = value(await h.call('open_session', { documentId: ENCLOSURE_ID })).sessionId;
    const r = value(
      await h.call('apply', {
        sessionId: own,
        label: 'One M3 insert hole from the table',
        commands: insertBatch(`${row.hole} mm`, `${row.length} mm`, { flat: true, points: 1 }),
      }),
    );
    const hole = r.symbols.$insert;
    const p = r.symbols.$p1;
    // The boss is still 7 mm across: the apply report warns that the wall is under the insert's.
    expect(r.errors).toEqual([thinWall(hole, p, BOSSES.entities[0]!)]);
    const faces = value(
      await h.call('find_geometry', {
        sessionId: own,
        query: { kind: 'face', partId: PART, bornBy: hole },
      }),
    ).hits as Data[];
    expect(faces.map((f) => [f.name, f.surface]).sort()).toEqual(
      [
        [`${hole}:bottom:${p}`, 'plane'],
        [`${hole}:wall:${p}`, 'cylinder'],
      ].sort(),
    );
    const wall = faces.find((f) => f.surface === 'cylinder')!;
    const bottom = faces.find((f) => f.surface === 'plane')!;
    expect([r6(2 * wall.radius), r6(BOSSES.top - bottom.centroid[2])]).toEqual([
      INSERT.hole,
      INSERT.length,
    ]);
    // The model keeps what the hole is for, and the review says it.
    const feature = value(
      await h.call('get_object', {
        sessionId: own,
        query: { kind: 'feature', partId: PART, featureId: hole },
      }),
    ).object as Data;
    expect(feature.standard).toEqual({ size: 'M3', purpose: 'heat-set-insert' });
    expect(feature.extent.tipAngle.source).toBe('180 deg');
    value(await h.call('close_session', { sessionId: own }));
  });

  it('a cosmetic M3 thread on the insert hole fails (the guide says leave it off)', async () => {
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Try a cosmetic M3 thread on an insert hole',
        dryRun: true,
        commands: [...insertBatch(), threadOn('hole#$insert:wall:e$p1')],
      }),
    );
    expect(r.errors).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringMatching(/M3 \(internal\) needs a hole 1\.959 to 2\.865 mm across/),
      }),
      // Errors first, then the warnings: the holes themselves built, in walls too thin.
      ...BOSSES.entities.map(() =>
        expect.objectContaining({ severity: 'warning', code: 'thin-wall' }),
      ),
    ]);
  });

  it('drills the four insert holes from the boss tops, as variables', async () => {
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Drill M3 heat-set insert holes into the lid bosses',
        commands: [
          { type: 'setVariable', name: 'insert_hole', expression: mm(INSERT.hole) },
          { type: 'setVariable', name: 'insert_depth', expression: mm(INSERT_DEPTH) },
          ...insertBatch('#insert_hole', '#insert_depth', { flat: true }),
        ],
      }),
    );
    insertHole = r.symbols.$insert;
    insertPoints = [1, 2, 3, 4].map((i) => r.symbols[`$p${i}`]);
    // No error, and a warning per boss: its wall is 1.5 mm, under the insert's 1.6 mm.
    expect(r.errors).toEqual(
      insertPoints.map((p, i) => thinWall(insertHole, p, BOSSES.entities[i]!)),
    );
    const walls = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bornBy: insertHole, radius: INSERT.hole / 2 },
      }),
    ).hits as Data[];
    expect(walls.map((w) => [w.bodyId, r6(w.centroid[0]), r6(w.centroid[1])])).toEqual(
      BOSSES.centres.map(([x, y]) => [BASE, x, y]),
    );
  });

  it('makes the lid screw holes clear for M3', async () => {
    const current = value(
      await h.call('get_object', {
        sessionId,
        query: { kind: 'feature', partId: PART, featureId: 'hole#1' },
      }),
    ).object as Data;
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Open the lid screw holes to M3 clearance',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: {
              ...current,
              diameter: mm(M3_CLEAR),
              standard: { size: 'M3', fit: 'normal' },
            },
          },
        ],
      }),
    );
    // The report lists the head's errors and warnings: only the boss walls, still too thin. The
    // lid holes have no minimum (an M3 clearance hole, and no print setup in the document).
    expect(r.errors.map((e: Data) => [e.severity, e.code, e.featureId])).toEqual(
      BOSSES.entities.map(() => ['warning', 'thin-wall', insertHole]),
    );
    const walls = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bodyId: LID, bornBy: 'hole#1' },
      }),
    ).hits as Data[];
    expect(walls.map((w) => r6(w.radius))).toEqual([1.7, 1.7, 1.7, 1.7]);
  });

  it('finds the boss, its insert hole and the lid hole over it on one axis', async () => {
    const hits = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, coaxialWith: 'extrude#2:side:e5' },
      }),
    ).hits as Data[];
    // Across both bodies: the boss itself, the insert hole drilled into it and the clearance hole
    // in the lid above, each with its side; the other three bosses are parallel, not coaxial.
    expect(hits.map((f) => [f.bodyId, f.name, r6(f.radius), f.hole])).toEqual([
      [BASE, 'extrude#2:side:e5', BOSSES.radius, false],
      [BASE, `${insertHole}:wall:${insertPoints[0]}`, INSERT.hole / 2, true],
      [LID, `hole#1:wall:${LID_HOLE.entities[0]}`, M3_CLEAR / 2, true],
    ]);
    expect(hits.every((f) => r6(f.centroid[0]) === 8 && r6(f.centroid[1]) === 8)).toBe(true);
  });

  it('warns in get_errors that a boss wall is under the insert minimum', async () => {
    // Was a gap probe: the hole said it held an M3 insert, but nothing checked the wall around
    // it. Regen now measures it on the final body, against the insert's minimum wall.
    const wall = await distance('extrude#2:side:e5', `${insertHole}:wall:${insertPoints[0]}`, [
      'face',
      'face',
    ]);
    expect(wall).toBeCloseTo(BOSSES.radius - INSERT.hole / 2, 6);
    expect(wall).toBeLessThan(INSERT.minWall);
    expect(value(await h.call('get_errors', { sessionId })).errors).toEqual(
      insertPoints.map((p, i) => thinWall(insertHole, p, BOSSES.entities[i]!)),
    );
  });

  it('widens the bosses to 8 mm, so the wall is 2 mm', async () => {
    const sketch = value(
      await h.call('get_object', {
        sessionId,
        query: { kind: 'feature', partId: PART, featureId: 'sketch#2' },
      }),
    ).object as Data;
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Widen the lid bosses to 8 mm for the inserts',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: {
              ...sketch,
              entities: (sketch.entities as Data[]).map((e) => ({ ...e, radius: 4 })),
            },
          },
        ],
      }),
    );
    // 2 mm walls, over the insert's 1.6 mm: the warnings are gone.
    expect(r.errors).toEqual([]);
    for (const [i, e] of BOSSES.entities.entries()) {
      const wall = await distance(`extrude#2:side:${e}`, `${insertHole}:wall:${insertPoints[i]}`, [
        'face',
        'face',
      ]);
      expect(wall).toBeCloseTo(2, 6);
    }
    // Every boss top keeps its name through the edit, over its own circle.
    const tops = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bornBy: 'extrude#2', normal: [0, 0, 1] },
      }),
    ).hits as Data[];
    expect(tops.map((t) => [t.name, t.fragile, r6(t.centroid[0]), r6(t.centroid[1])])).toEqual(
      BOSSES.entities.map((e, i) => [`extrude#2:cap:end:${e}`, false, ...BOSSES.centres[i]!]),
    );
  });

  it('measures the hole depth from the boss top to the end of the wall', async () => {
    const p = insertPoints[0]!;
    const end = `${insertHole}:bottom:${p}|${insertHole}:wall:${p}`;
    const depth = await distance(`extrude#2:cap:end:${BOSSES.entities[0]}`, end, ['face', 'edge']);
    expect(depth).toBeCloseTo(INSERT_DEPTH, 6);
    expect(depth).toBeGreaterThanOrEqual(INSERT.length);
    // The ordinal name the top had before still finds the same face, for older documents.
    expect(await distance('extrude#2:cap:end#1', end, ['face', 'edge'])).toBe(depth);
  });

  it('ends the insert holes flat, as asked, where a blind hole used to end in a drill point', async () => {
    // Was a gap probe: core's hole had no tip option, so every blind hole ended in a cone.
    const tips = value(
      await h.call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: PART, bornBy: insertHole, nearest: [8, 8, 30], limit: 2 },
      }),
    ).hits as Data[];
    expect(tips.map((t) => [t.name, t.surface, v6(t.normal ?? [])])).toEqual([
      [`${insertHole}:bottom:${insertPoints[0]}`, 'plane', [0, 0, 1]],
      [`${insertHole}:wall:${insertPoints[0]}`, 'cylinder', []],
    ]);
  });

  it('renders a section through two bosses, before and after, with scale but no dimensions', async () => {
    const r = await h.raw('render', {
      sessionId,
      views: [
        {
          camera: { view: 'front', fit: ['extrude#2:*', 'hole#*'] },
          section: { origin: [0, 8, 0], normal: [0, -1, 0] },
          width: 800,
          height: 400,
        },
      ],
      compare: true,
    });
    expect(r.isError).toBeFalsy();
    keepImages('section', r);
    const images = (r.structuredContent as Data).images as Data[];
    expect(images.map((i) => i.side)).toEqual(['head', 'base']);
    expect(images[0]!.mmPerPixel).toBeGreaterThan(0);
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(2);
    // Gap probe: what an image shows is pixels and a scale; the depth is not written anywhere.
    expect(Object.keys(images[0]!).sort()).toEqual(
      ['bytes', 'content', 'height', 'mmPerPixel', 'side', 'unmatched', 'view', 'width'].sort(),
    );
  });

  it('builds without errors, submits with a section view, and exports a 3MF', async () => {
    expect(value(await h.call('get_errors', { sessionId })).errors).toEqual([]);
    const body = value(
      await h.call('measure', {
        sessionId,
        query: { kind: 'body', partId: PART, bodyId: BASE },
      }),
    ).measurement as Data;
    expect(body.boundingBox).toEqual({
      min: [0, 0, 0],
      max: [BOX.length, BOX.width, BOX.height],
    });
    const submitted = value(
      await h.call('submit_for_review', {
        sessionId,
        note: `M3 heat-set inserts: four ${INSERT.hole} mm holes, ${INSERT_DEPTH} mm deep, in the lid bosses (#insert_hole, #insert_depth; CNC Kitchen standard M3: L ${INSERT.length} mm, W ${INSERT.minWall} mm). Bosses widened to 8 mm so the wall is 2 mm. Lid holes opened to ${M3_CLEAR} mm (M3 normal clearance).`,
        views: [
          {
            name: 'Section through two bosses',
            camera: { view: 'front', fit: ['extrude#2:*'] },
            section: { origin: [0, 8, 0], normal: [0, -1, 0] },
          },
        ],
      }),
    );
    expect(submitted.review).toBe('submitted');
    const review = value(await h.call('get_review', { sessionId }));
    expect(review).toMatchObject({ review: 'submitted', bundle: { stale: false } });
    const exported = value(
      await h.call('export', { sessionId, format: '3mf', fileName: 'enclosure-inserts' }),
    );
    expect(exported).toMatchObject({ reviewed: false, files: [{ name: 'enclosure-inserts.3mf' }] });
  });
});

/**
 * The insert holes: a sketch of points on the boss tops (z = 40) and a blind hole into the base,
 * made as M3 heat-set insert holes (`standard.purpose`); `flat` ends them flat (tip angle 180 deg),
 * `points` drills only the first few bosses.
 */
function insertBatch(
  diameter: string = `${INSERT.hole} mm`,
  depth: string = `${INSERT_DEPTH} mm`,
  options: { flat?: boolean; points?: number } = {},
) {
  const centres = BOSSES.centres.slice(0, options.points ?? BOSSES.centres.length);
  return [
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'sketch#$insert_centres',
        kind: 'sketch',
        name: 'Insert centres',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, BOSSES.top], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: centres.map((position, i) => ({
          id: `e$p${i + 1}`,
          kind: 'point',
          construction: false,
          position,
        })),
        constraints: [],
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'hole#$insert',
        kind: 'hole',
        name: 'M3 heat-set insert holes',
        suppressed: false,
        sketch: 'sketch#$insert_centres',
        points: centres.map((_, i) => `e$p${i + 1}`),
        diameter: mm(diameter),
        extent: {
          type: 'blind',
          depth: mm(depth),
          ...(options.flat ? { tipAngle: mm('180 deg') } : {}),
        },
        head: { type: 'simple' },
        standard: { size: INSERT.size, purpose: 'heat-set-insert' },
        scope: [BASE],
      },
    },
  ];
}

function threadOn(face: string) {
  return {
    type: 'addFeature',
    partId: PART,
    feature: {
      id: 'thread#$m3',
      kind: 'thread',
      name: 'M3 insert thread',
      suppressed: false,
      face: { id: 'r$wall', ref: { face } },
      length: 'full',
      standard: { system: 'iso-metric', size: INSERT.size },
      hand: 'right',
      clearance: mm(0),
      representation: 'cosmetic',
    },
  };
}
