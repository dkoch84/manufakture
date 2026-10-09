// Acceptance scenario T8.6a, drawer slides (M8 plan; write-up in
// docs/m8-acceptance/drawer-slides.md). The request:
//
//   "Add a drawer to the bottom opening of this cabinet on 18" side-mount ball-bearing slides,
//   1/2" clearance each side, and check it opens fully."
//
// A fixed tool-call sequence through the real MCP server (in process), doing the scenario as far
// as the product allows: measure the opening, a drawer box of boards with dowel joints, the slides
// as plain steel bodies, an assembly with a slider mate limited to the slide's travel, and
// interference checks at poses along that travel and swept over it. The plan's gap hypotheses,
// and the gaps found on the way, are asserted as they are today in tests named "gap probe": when
// a fix changes one, its test fails, and the write-up's gap table needs the same change.
//
// The guide's cabinet (packages/session's fixture) is a bookshelf 11-1/4" deep, too shallow for
// an 18" slide; the first test shows that. The rest runs on the same cabinet made 22" deep by
// commands (../fixtures/drawer-slides/cabinet.ts).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { cabinetDocument } from '@manufakture/session/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_CABINET_ID, baseCabinetDocument } from '../fixtures/drawer-slides/cabinet';
import { harness, value, type Data, type Harness } from '../harness';

const IN = 25.4;
const P = 'part#1';
const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
const close = (a: number, b: number, digits = 3) => expect(a).toBeCloseTo(b, digits);

/** An expression in inches (a bare number is inches). */
const inches = (source: string) => ({ source, lengthUnit: 'in', angleUnit: 'deg' });

type V3 = [number, number, number];

const add = (feature: Record<string, unknown>) => ({
  type: 'addFeature',
  partId: P,
  feature: { suppressed: false, ...feature },
});

/** A rectangle sketch (mm) from (x0, y0) to (x1, y1), its lines `e$<name>_0` to `_3`. */
function rectangle(
  id: string,
  name: string,
  plane: { origin: V3; normal: V3; xDir: V3 },
  [x0, y0, x1, y1]: [number, number, number, number],
) {
  const c: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const key = id.slice('sketch#$'.length);
  return add({
    id,
    kind: 'sketch',
    name,
    plane: { type: 'plane', ...plane },
    entities: c.map((start, i) => ({
      id: `e$${key}_${i}`,
      kind: 'line',
      construction: false,
      start,
      end: c[(i + 1) % 4],
    })),
    constraints: [],
  });
}

const board = (id: string, name: string, sketch: string, stock: string) =>
  add({
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

const dowels = (id: string, name: string, a: string, b: string) =>
  add({
    id,
    kind: 'extension',
    name,
    extension: 'wood.joint',
    schemaVersion: 1,
    dependsOn: [a, b],
    scope: [a, b],
    references: [],
    expressions: {},
    params: { kind: 'dowel', a, b },
  });

// The layout, in mm, from the opening the test measures (asserted below): the drawer box is the
// opening less 1/2" each side, 12" tall standing 1/2" above the bottom, 18" deep (the slide
// length), its front flush with the cabinet's front (y = 0; the cabinet's back is at +Y).
const OPENING = { left: 23 / 32, right: 24 - 23 / 32, bottom: 23 / 32, top: 14 };
/** The sides' faces of the bottom opening: each piece below the shelf named after its dado wall. */
const SIDES = {
  left: 'extension#1:cap:end{extension#11:groove:xmin}',
  right: 'extension#2:cap:start{extension#12:groove:xmin}',
};
const CLEARANCE = 0.5;
const PLY = 15 / 32; // 1/2" plywood, actual
const xL = (OPENING.left + CLEARANCE) * IN;
const xR = (OPENING.right - CLEARANCE) * IN;
const z0 = (OPENING.bottom + CLEARANCE) * IN;
const z1 = z0 + 12 * IN;
const LENGTH = 18 * IN;
const T = PLY * IN;
/** A slide is 1/2" thick (two 1/4" members) and 1-3/4" tall, centred on the drawer's side. */
const SLIDE_HEIGHT = 1.75 * IN;
const zMid = (z0 + z1) / 2;

const DRAWER = [
  {
    type: 'setVariable',
    name: 'slide_clearance',
    expression: inches('1/2"'),
  },
  {
    type: 'setVariable',
    name: 'drawer_width',
    // The opening's width is typed in: no expression can measure it (gap probe below).
    expression: inches('22-9/16" - 2 * #slide_clearance'),
  },
  rectangle(
    'sketch#$ls',
    'Drawer left side',
    { origin: [xL, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
    [0, z0, LENGTH, z1],
  ),
  rectangle(
    'sketch#$rs',
    'Drawer right side',
    { origin: [xR - T, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
    [0, z0, LENGTH, z1],
  ),
  rectangle(
    'sketch#$fr',
    'Drawer front',
    { origin: [0, T, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
    [xL + T, z0, xR - T, z1],
  ),
  rectangle(
    'sketch#$bk',
    'Drawer back',
    { origin: [0, LENGTH, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
    [xL + T, z0, xR - T, z1],
  ),
  rectangle(
    'sketch#$bt',
    'Drawer bottom',
    { origin: [0, 0, z0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    [xL + T, T, xR - T, LENGTH - T],
  ),
  board('extension#$dls', 'Drawer left side', 'sketch#$ls', 'us-ply-15-32'),
  board('extension#$drs', 'Drawer right side', 'sketch#$rs', 'us-ply-15-32'),
  board('extension#$dfr', 'Drawer front', 'sketch#$fr', 'us-ply-15-32'),
  board('extension#$dbk', 'Drawer back', 'sketch#$bk', 'us-ply-15-32'),
  board('extension#$dbt', 'Drawer bottom', 'sketch#$bt', 'us-ply-7-32'),
  dowels('extension#$j1', 'Drawer front to left side', 'extension#$dls', 'extension#$dfr'),
  dowels('extension#$j2', 'Drawer front to right side', 'extension#$drs', 'extension#$dfr'),
  dowels('extension#$j3', 'Drawer back to left side', 'extension#$dls', 'extension#$dbk'),
  dowels('extension#$j4', 'Drawer back to right side', 'extension#$drs', 'extension#$dbk'),
];

/** One slide member: a 1/4" steel bar the slide's length, its sketch on a plane at x (mm). */
const member = (key: string, name: string, x: number) => [
  rectangle(`sketch#$${key}`, name, { origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, [
    0,
    zMid - SLIDE_HEIGHT / 2,
    LENGTH,
    zMid + SLIDE_HEIGHT / 2,
  ]),
  add({
    id: `extrude#$${key}_bar`,
    kind: 'extrude',
    name,
    profile: { sketch: `sketch#$${key}` },
    operation: 'new',
    extent: { type: 'blind', distance: inches('1/4"') },
    reverse: false,
  }),
];

const SLIDES = [
  ...member('lc', 'Left slide, cabinet member', OPENING.left * IN),
  ...member('ld', 'Left slide, drawer member', (OPENING.left + 0.25) * IN),
  ...member('rc', 'Right slide, cabinet member', xR + 0.25 * IN),
  ...member('rd', 'Right slide, drawer member', xR),
];

/** The drawer's pose with the slides pulled out `d` mm (the drawer moves towards -Y). */
const pulled = (d: number) => ({ translation: [0, -d, 0], rotation: [0, 0, 0, 1] });

describe('scenario T8.6a: drawer slides', () => {
  let h: Harness;
  let sessionId: string;
  const ids: Record<string, string> = {};

  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    value(await h.call(tool, args));
  const tree = async (): Promise<Data> => (await call('get_tree', { sessionId })).tree as Data;
  const face = async (query: Record<string, unknown>) => {
    const r = await call('find_geometry', {
      sessionId,
      query: { kind: 'face', partId: P, ...query },
    });
    return r.hits[0] as Data;
  };
  const clearance = async (a: string, b: string) => {
    const r = await call('measure', {
      sessionId,
      query: { kind: 'clearance', bodies: [a, b].map((bodyId) => ({ partId: P, bodyId })) },
    });
    return r.measurement as Data;
  };
  const interference = async (
    options: { poses?: Record<string, unknown>; travel?: Record<string, unknown> } = {},
  ) => {
    const r = await call('measure', {
      sessionId,
      query: { kind: 'interference', assemblyId: ids.assembly, ...options },
    });
    return r.measurement as Data;
  };

  beforeAll(async () => {
    h = await harness({ document: baseCabinetDocument() });
    await new DocumentLibrary(new NodeBackend(h.libraryRoot)).create(cabinetDocument());
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('finds the guide\'s cabinet too shallow for an 18" slide', async () => {
    const opened = await call('open_session', { documentId: 'doc-cabinet' });
    sessionId = opened.sessionId;
    const side = await call('measure', {
      sessionId,
      query: { kind: 'body', partId: P, bodyId: 'extension#1' },
    });
    const { min, max } = side.measurement.boundingBox;
    // 11-1/4" deep outside; less the 7/32" back inside: 11-1/32". An 18" slide cannot fit.
    close(max[1] - min[1], 11.25 * IN);
    const back = await face({ normal: [0, -1, 0], bornBy: 'extension#6' });
    expect(back.centroid[1]).toBeLessThan(LENGTH);
    await call('close_session', { sessionId });
  });

  it('opens a session on the 22" deep cabinet and measures the bottom opening', async () => {
    const opened = await call('open_session', { documentId: BASE_CABINET_ID });
    sessionId = opened.sessionId;
    expect(opened.outline.units.length.unit).toBe('in-fraction');
    // The opening's four faces: the bottom's top, the shelf's underside, the sides' inner faces.
    const floor = await face({ normal: [0, 0, 1], nearest: [304.8, 280, 0], limit: 1 });
    const ceiling = await face({ normal: [0, 0, -1], nearest: [304.8, 280, 180], limit: 1 });
    const left = await face({ normal: [1, 0, 0], nearest: [0, 280, 180], limit: 1 });
    const right = await face({ normal: [-1, 0, 0], nearest: [609.6, 280, 180], limit: 1 });
    const back = await face({ normal: [0, -1, 0], bornBy: 'extension#6', limit: 1 });
    expect([floor.name, ceiling.name, back.name]).toEqual([
      'extension#3:cap:end',
      'extension#5:cap:start',
      'extension#6:cap:end',
    ]);
    close(floor.centroid[2], OPENING.bottom * IN);
    close(ceiling.centroid[2], OPENING.top * IN);
    close(left.centroid[0], OPENING.left * IN);
    close(right.centroid[0], OPENING.right * IN);
    // The sides' inner faces are split by the shelf's dados. Found: their names were positional
    // (`extension#1:cap:end#1`, fragile). Now (#1207) each piece is named after the dado wall
    // beside it, not fragile; the positional names are aliases (next test).
    expect([left.name, left.fragile, right.name, right.fragile]).toEqual([
      SIDES.left,
      false,
      SIDES.right,
      false,
    ]);
    // The same sizes by measurement: `targets` measures within one body only, so the distances
    // across the opening come from `clearance`'s gap between the bodies' boxes.
    close((await clearance('extension#1', 'extension#2')).gaps[0].boxGap, 22.5625 * IN);
    close((await clearance('extension#3', 'extension#5')).gaps[0].boxGap, (14 - 23 / 32) * IN);
    // 21-25/32" from the front to the back's front face: an 18" slide fits.
    expect(back.centroid[1]).toBeGreaterThan(LENGTH);
  });

  it("keeps the opening's side face names when the shelf moves; the old names still resolve", async () => {
    const plane = async (bodyId: string, name: string) => {
      const r = await call('measure', {
        sessionId,
        query: { kind: 'targets', partId: P, bodyId, targets: [{ kind: 'face', name }] },
      });
      const item = r.measurement.items[0] as Data;
      return [item.index, item.centroid];
    };
    // A reference stored with the former positional name resolves to the same face.
    expect(await plane('extension#1', 'extension#1:cap:end#1')).toEqual(
      await plane('extension#1', SIDES.left),
    );
    expect(await plane('extension#2', 'extension#2:cap:start#1')).toEqual(
      await plane('extension#2', SIDES.right),
    );
    // Move the shelf (and with it both dados) up 2": the faces below it keep their names.
    const read = await call('get_object', {
      sessionId,
      query: { kind: 'feature', partId: P, featureId: 'sketch#5' },
    });
    const shelf = structuredClone(read.object) as Data;
    shelf.plane.origin[2] += 2 * IN;
    const r = await call('apply', {
      sessionId,
      label: 'Raise the shelf 2"',
      commands: [{ type: 'editFeature', partId: P, feature: shelf }],
    });
    expect(r.errors).toEqual([]);
    for (const [name, bodyId, x] of [
      [SIDES.left, 'extension#1', OPENING.left],
      [SIDES.right, 'extension#2', OPENING.right],
    ] as const) {
      const r = await call('find_geometry', {
        sessionId,
        query: { kind: 'face', partId: P, bodyId, name },
      });
      expect(r.hits).toHaveLength(1);
      expect(r.hits[0].fragile).toBe(false);
      close(r.hits[0].centroid[0], x * IN);
      // The piece below the shelf grew 2" upwards: its centroid rose 1".
      close(r.hits[0].centroid[2], ((OPENING.bottom + OPENING.top) / 2 + 1) * IN, 1);
    }
    await call('undo', { sessionId });
  });

  it('gap probe: a variable cannot take a measured value', async () => {
    // The functions are min, max, abs, sqrt, trig and rounding; there is nothing that reads the
    // model, so the opening's width cannot drive the drawer's.
    const r = await h.call('apply', {
      sessionId,
      label: 'Drawer width from the opening',
      dryRun: true,
      commands: [
        {
          type: 'setVariable',
          name: 'opening_width',
          expression: inches('distance("extension#1:cap:end#1", "extension#2:cap:start#1")'),
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ kind: 'core', error: { code: 'expression' } });
  });

  it('adds the drawer box: five boards and four dowel joints, symbols in params', async () => {
    // One batch: the symbols in the boards' `sketch` and the joints' `a` and `b` resolve too.
    const real = await call('apply', {
      sessionId,
      label: 'Add a drawer box for the bottom opening',
      commands: DRAWER,
    });
    expect(real.errors).toEqual([]);
    const symbols = real.symbols as Record<string, string>;
    for (const k of ['dls', 'drs', 'dfr', 'dbk', 'dbt']) ids[k] = symbols[`$${k}`]!;
    expect(ids.dfr).toBe('extension#17');
    // The drawer's width is the variable's value, but only because the sketches were drawn to
    // the same typed-in number: sketch coordinates are numbers, not expressions.
    const width = await call('get_object', {
      sessionId,
      query: { kind: 'variable', name: 'drawer_width' },
    });
    expect(width.object.expression.source).toBe('22-9/16" - 2 * #slide_clearance');
    const variables = (await tree()).variables as Data[];
    close(variables.find((v) => v.name === 'drawer_width')!.value.value, 21.5625 * IN);
    const drawer = await clearance(ids.dls!, ids.drs!);
    close(drawer.gaps[0].boxGap, 21.5625 * IN - 2 * T);
  });

  it('adds the slides as plain steel bodies (gap probe: no purchased-part catalog)', async () => {
    const r = await call('apply', {
      sessionId,
      label: 'Add 18" side-mount slides',
      commands: SLIDES,
    });
    expect(r.errors).toEqual([]);
    const s = r.symbols as Record<string, string>;
    for (const k of ['lc', 'ld', 'rc', 'rd']) ids[k] = s[`$${k}_bar`]!;
    expect([ids.lc, ids.ld, ids.rc, ids.rd]).toEqual([
      'extrude#1',
      'extrude#2',
      'extrude#3',
      'extrude#4',
    ]);
    const steel = await call('apply', {
      sessionId,
      label: 'Make the slides steel',
      commands: [ids.lc, ids.ld, ids.rc, ids.rd].map((bodyId) => ({
        type: 'setBodyProps',
        partId: P,
        bodyId,
        props: { material: 'steel' },
      })),
    });
    expect(steel.errors).toEqual([]);
    // Each slide fills its 1/2" exactly: touching both sides, overlapping neither.
    const fit = await call('measure', {
      sessionId,
      query: {
        kind: 'clearance',
        bodies: ['extension#1', ids.lc, ids.ld, ids.dls].map((bodyId) => ({ partId: P, bodyId })),
      },
    });
    expect(fit.measurement.pairs).toEqual([]);

    // The gap: no command or feature makes a purchased part. The schema index knows boards and
    // joints (extension features) and plain geometry; a slide as a domain feature is refused.
    const { index } = await call('get_schema', {});
    const kinds = [...index.commands, ...index.features].join(' ');
    expect(kinds).not.toMatch(/hardware|component|catalog|purchased|slide/i);
    const slide = await h.call('apply', {
      sessionId,
      label: 'An 18" slide from a catalog',
      dryRun: true,
      commands: [
        add({
          id: 'extension#$slide',
          kind: 'extension',
          name: '18" slide',
          extension: 'wood.slide',
          schemaVersion: 1,
          dependsOn: [ids.dls],
          references: [],
          expressions: { length: inches('18') },
          params: { series: 'side-mount', length: 18 },
        }),
      ],
    });
    expect(slide.ok).toBe(true);
    expect(slide.errors).toEqual([
      expect.objectContaining({ featureId: 'extension#24', code: 'unsupported' }),
    ]);
  });

  it('gap probe: the slides are not in the cut list or its hardware; dowels are', async () => {
    const q = (await call('get_quantities', { sessionId })).quantities as Data;
    expect(q.reviewed).toBe(false);
    // Hardware lines are separate from boards (the plan's fourth hypothesis does not hold) ...
    expect(q.hardware.map((r: Data) => [r.kind, r.item, r.quantity])).toEqual([
      ['hardware', 'Dowel', 16],
    ]);
    expect(q.cutList.totals.map((t: Data) => t.group)).toEqual(['sheet', 'hardware']);
    // ... but they come only from joints: the slides are left out, as "not wood".
    expect(q.cutList.excluded).toEqual(
      [ids.lc, ids.ld, ids.rc, ids.rd].map((bodyId) => ({ part: P, bodyId, reason: 'not-wood' })),
    );
    expect(q.cutList.rows.map((r: Data) => r.item)).toContain(
      'Drawer left side, Drawer right side',
    );
    // And so is the bill of materials file.
    const bom = await call('export', { sessionId, format: 'bom-csv', fileName: 'drawer-bom' });
    expect(bom.reviewed).toBe(false);
    const csv = readFileSync(path.join(h.outputDir, bom.files[0].name), 'utf8');
    expect(csv).toMatch(/Dowel/);
    expect(csv).not.toMatch(/slide/i);
  });

  it('mates the drawer to the cabinet on a slider limited to the 18" travel', async () => {
    const cabinetBodies = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];
    cabinetBodies.push('extension#5', 'extension#6', ids.lc!, ids.rc!);
    const drawerBodies = [ids.dls, ids.drs, ids.dfr, ids.dbk, ids.dbt, ids.ld, ids.rd];
    // The slider runs along its connectors' z axis: the normal of the cabinet bottom's front
    // face and of the drawer front's face, both -Y. The two faces' centroids are not on one
    // line, so the cabinet's connector needs an offset in its own frame: the mate goes in
    // without one first, get_object reads where its connectors resolved, and the offset follows.
    const r = await call('apply', {
      sessionId,
      label: 'Put the drawer on its slides in an assembly',
      commands: [
        { type: 'addAssembly', assemblyId: 'assembly#$asm', name: 'Drawer in cabinet' },
        {
          type: 'addInstance',
          assemblyId: 'assembly#$asm',
          instance: {
            id: 'inst#$cabinet',
            name: 'Cabinet',
            source: { part: P },
            bodies: cabinetBodies,
            fixed: true,
            suppressed: false,
            pose: IDENTITY,
          },
        },
        {
          type: 'addInstance',
          assemblyId: 'assembly#$asm',
          instance: {
            id: 'inst#$drawer',
            name: 'Drawer',
            source: { part: P },
            bodies: drawerBodies,
            fixed: false,
            suppressed: false,
            pose: IDENTITY,
          },
        },
        {
          type: 'addMate',
          assemblyId: 'assembly#$asm',
          mate: {
            id: 'mate#$slides',
            name: 'Drawer slides',
            kind: 'slider',
            suppressed: false,
            a: {
              id: 'mc#$on_cabinet',
              instance: 'inst#$cabinet',
              inference: 'centroid',
              origin: { id: 'r$cabinet_front', ref: { face: 'extension#3:side:e9' } },
            },
            b: {
              id: 'mc#$on_drawer',
              instance: 'inst#$drawer',
              inference: 'centroid',
              origin: { id: 'r$drawer_front', ref: { face: `${ids.dfr}:cap:end` } },
            },
            limits: { min: inches('0'), max: inches('18') },
          },
        },
      ],
    });
    expect(r.errors).toEqual([]);
    const s = r.symbols as Record<string, string>;
    Object.assign(ids, {
      assembly: s.$asm,
      cabinet: s.$cabinet,
      drawer: s.$drawer,
      mate: s.$slides,
    });
    // The frames as they resolved: the cabinet's connector at its face's centroid, its z axis
    // the face's normal (-Y), which is the axis the slider's distance runs along.
    const read = await call('get_object', {
      sessionId,
      query: { kind: 'mate', assemblyId: ids.assembly, mateId: ids.mate },
    });
    const { a, b, motion } = read.frames as Data;
    expect(motion).toEqual([{ coordinate: 'distance', axis: 'z', angular: false }]);
    expect(a).toMatchObject({ connectorId: expect.any(String), instanceId: ids.cabinet });
    expect(b).toMatchObject({ instanceId: ids.drawer });
    a.z.forEach((c: number, i: number) => close(c, [0, -1, 0][i]!, 9));
    // The offset is the drawer front's centroid (in the part, where the drawer stands at rest)
    // seen from the cabinet's connector, along the frame's x and y: no trial regens.
    const front = await face({ name: `${ids.dfr}:cap:end` });
    const d = (front.centroid as V3).map((c, i) => c - a.origin[i]);
    const along = (axis: V3) => d.reduce((sum, c, i) => sum + c * axis[i]!, 0);
    const [dx, dy] = [along(a.x), along(a.y)];
    // 174.228 mm, from the bottom panel's mid-thickness up to the drawer's mid-height; the
    // frame's y is world up for this face.
    close(Math.abs(dy), zMid - (23 / 32 / 2) * IN);
    close(dx, 0);
    const mate = structuredClone(read.object) as Data;
    mate.a.offset = {
      translation: [inches(`${dx} mm`), inches(`${dy} mm`), inches('0')],
      rotation: [inches('0 deg'), inches('0 deg'), inches('0 deg')],
    };
    const edited = await call('apply', {
      sessionId,
      label: "Offset the cabinet's slide connector to the drawer's height",
      commands: [{ type: 'editMate', assemblyId: ids.assembly, mate }],
    });
    expect(edited.errors).toEqual([]);
    // With the offset the drawer sits on the slider where it stands: the solve does not move it.
    const asm = ((await tree()).assemblies as Data[])[0]!;
    expect(asm).toMatchObject({
      id: ids.assembly,
      dof: 1,
      instances: [{ id: ids.cabinet }, { id: ids.drawer, moved: false }],
      mates: [{ id: ids.mate, kind: 'slider', status: 'ok' }],
    });
    const after = (
      await call('get_object', {
        sessionId,
        query: { kind: 'mate', assemblyId: ids.assembly, mateId: ids.mate },
      })
    ).frames as Data;
    after.a.origin.forEach((c: number, i: number) => close(c, front.centroid[i]));
    expect((await call('get_errors', { sessionId })).errors).toEqual([]);
  });

  it('checks the drawer opens fully: no interference closed, half open or at 18"', async () => {
    expect((await interference()).pairs).toEqual([]);
    for (const d of [0, 9 * IN, LENGTH]) {
      const m = await interference({ poses: { [ids.drawer!]: pulled(d) } });
      expect(m.instances).toEqual([ids.cabinet, ids.drawer]);
      expect(m.pairs).toEqual([]);
      expect(m.failures).toEqual([]);
    }
    // At 18" the drawer's back (at y = 18" in the part) has reached the cabinet's front, y = 0:
    // the box is fully out.
    const back = await face({ normal: [0, 1, 0], bornBy: ids.dbk!, limit: 1 });
    close(back.centroid[1] - LENGTH, 0);
  });

  it('sweeps the slider\'s travel: no interference over 18", and a pose past it is a warning', async () => {
    // Over the slider's limits by default, 20 steps: nothing collides anywhere on the travel.
    const sweep = await interference({ travel: { mateId: ids.mate } });
    expect(sweep).toMatchObject({
      instances: [ids.cabinet, ids.drawer],
      moving: [ids.drawer],
      staticPairs: [],
      travel: { mateId: ids.mate, kind: 'slider', unit: 'mm', from: 0, to: LENGTH },
      checked: 21,
      first: null,
      pairs: [],
      colliding: [],
      failures: [],
      warnings: [],
    });
    close(sweep.travel.step, LENGTH / 20, 9);
    expect(sweep.values).toHaveLength(21);
    close(sweep.values[10], 9 * IN, 9);
    // A range past the travel is checked and warned about: pushed in (below the travel's 0) the
    // drawer hits the cabinet's back, so the first colliding value is the first step.
    const pushed = await interference({
      travel: { mateId: ids.mate, from: -4 * IN, to: 0, step: IN },
    });
    expect(pushed.checked).toBe(5);
    expect(pushed.first.value).toBeCloseTo(-4 * IN, 9);
    expect(pushed.first.pairs).toEqual([
      { a: ids.cabinet, b: ids.drawer, volume: expect.any(Number) },
    ]);
    expect(pushed.colliding.length).toBeGreaterThan(0);
    expect(pushed.colliding).not.toContain(0);
    expect(pushed.warnings).toEqual([
      expect.objectContaining({
        code: 'outside-limits',
        mateId: ids.mate,
        bound: 'min',
        limit: 0,
        values: [-4, -3, -2, -1].map((x) => expect.closeTo(x * IN, 9) as number),
      }),
    ]);
    // A pose placed by hand is checked against the slider too: 4" in is past its minimum.
    const posed = await interference({ poses: { [ids.drawer!]: pulled(-4 * IN) } });
    expect(posed.pairs).toEqual([{ a: ids.cabinet, b: ids.drawer, volume: expect.any(Number) }]);
    expect(posed.warnings).toEqual([
      expect.objectContaining({
        code: 'outside-limits',
        mateId: ids.mate,
        bound: 'min',
        limit: 0,
        value: expect.closeTo(-4 * IN, 6) as number,
        unit: 'mm',
      }),
    ]);
    // And a pose off the slider's line (an inch sideways) does not keep the mate.
    const sideways = await interference({
      poses: { [ids.drawer!]: { translation: [IN, -IN, 0], rotation: [0, 0, 0, 1] } },
    });
    expect(sideways.warnings).toEqual([
      expect.objectContaining({
        code: 'off-mate',
        mateId: ids.mate,
        position: expect.closeTo(IN, 6) as number,
      }),
    ]);
    // A sweep is bounded: at most 101 values.
    const huge = await h.call('measure', {
      sessionId,
      query: {
        kind: 'interference',
        assemblyId: ids.assembly,
        travel: { mateId: ids.mate, step: 1 },
      },
    });
    expect(huge.ok).toBe(false);
    expect(huge.error!.message).toMatch(/at most 101 values/);
  });

  it('sweeps a shortened cabinet: the first colliding value and the pair', async () => {
    // The cabinet made 17" deep (the slides and the 18" drawer as they were): the back now stands
    // inside the drawer's travel.
    const depth = 17 * IN;
    const back = (7 / 32) * IN;
    const commands: unknown[] = [];
    for (const id of ['sketch#1', 'sketch#2', 'sketch#3', 'sketch#4', 'sketch#5', 'sketch#6']) {
      const read = await call('get_object', {
        sessionId,
        query: { kind: 'feature', partId: P, featureId: id },
      });
      const f = structuredClone(read.object) as Data;
      if (id === 'sketch#6') {
        f.plane.origin[1] = depth;
      } else {
        const axis = id === 'sketch#1' || id === 'sketch#2' ? 0 : 1;
        const from = axis === 0 ? 22 * IN : 22 * IN - back;
        const to = axis === 0 ? depth : depth - back;
        for (const e of f.entities as Data[]) {
          for (const p of [e.start, e.end]) if (p && Math.abs(p[axis] - from) < 1e-6) p[axis] = to;
        }
      }
      commands.push({ type: 'editFeature', partId: P, feature: f });
    }
    const r = await call('apply', { sessionId, label: 'Make the cabinet 17" deep', commands });
    expect(r.errors).toEqual([]);
    // Closed, the drawer runs through the back: the sweep's first value collides.
    const closed = await interference({ travel: { mateId: ids.mate } });
    expect(closed.checked).toBe(21);
    expect(closed.first).toEqual({
      value: 0,
      pairs: [{ a: ids.cabinet, b: ids.drawer, volume: expect.any(Number) }],
    });
    expect(closed.pairs).toEqual(closed.first.pairs);
    // Clear from 1-7/32" out: of the 0.9" steps, 0 and 0.9" collide.
    expect(closed.colliding).toEqual([0, expect.closeTo(0.9 * IN, 9) as number]);
    expect(closed.warnings).toEqual([]);
    // Closing it from fully open, an inch at a time, it first hits the back at 1".
    const closing = await interference({
      travel: { mateId: ids.mate, from: LENGTH, to: 0, step: IN },
    });
    expect(closing.checked).toBe(19);
    expect(closing.first.value).toBeCloseTo(IN, 9);
    expect(closing.first.pairs).toEqual([
      { a: ids.cabinet, b: ids.drawer, volume: expect.any(Number) },
    ]);
    await call('undo', { sessionId });
    expect((await interference({ travel: { mateId: ids.mate } })).first).toBeNull();
  });

  it("reads the solved pose and the slider's value, and a pose past the limit is a warning", async () => {
    // At rest the tree gives the solved pose and the slide's distance, with no warning.
    const before = ((await tree()).assemblies as Data[])[0]!;
    expect(before.instances[1]).toMatchObject({ id: ids.drawer, moved: false });
    expect(before.instances[1].transform.translation[1]).toBeCloseTo(0, 6);
    expect(before.mates[0]).toMatchObject({ id: ids.mate, warnings: 0 });
    expect(before.mates[0].coordinates).toEqual([
      { name: 'distance', value: expect.closeTo(0, 6) as number, unit: 'mm' },
    ]);
    // Opening the drawer 600 mm (past the slide's 457.2) as a pose of the instance: the solver
    // holds it at the limit, and the apply report says so.
    const r = await call('apply', {
      sessionId,
      label: 'Pull the drawer out past its travel',
      commands: [
        { type: 'setPoses', assemblyId: ids.assembly, poses: { [ids.drawer!]: pulled(600) } },
      ],
    });
    const warning = {
      where: 'mate',
      assemblyId: ids.assembly,
      id: ids.mate,
      severity: 'warning',
      code: 'limit',
      message: expect.stringMatching(/600\.00 mm, past its maximum of 457\.20 mm/) as string,
    };
    expect(r.errors).toEqual([warning]);
    expect(r.measured).toEqual([]);
    expect((await call('get_errors', { sessionId })).errors).toEqual([warning]);
    // get_object is the document: the stored 600 mm. get_tree is the solve: 457.2 mm.
    const instance = await call('get_object', {
      sessionId,
      query: { kind: 'instance', assemblyId: ids.assembly, instanceId: ids.drawer },
    });
    expect(instance.object.pose.translation).toEqual([0, -600, 0]);
    const asm = ((await tree()).assemblies as Data[])[0]!;
    expect(asm.instances[1]).toMatchObject({ id: ids.drawer, moved: true });
    expect(asm.instances[1].transform.translation[1]).toBeCloseTo(-LENGTH, 6);
    expect(asm.mates[0]).toMatchObject({ id: ids.mate, status: 'ok', warnings: 1 });
    expect(asm.mates[0].coordinates).toEqual([
      { name: 'distance', value: expect.closeTo(LENGTH, 6) as number, unit: 'mm' },
    ]);
    await call('undo', { sessionId });
    expect((await call('get_errors', { sessionId })).errors).toEqual([]);
  });

  it('gap probe: render draws the part, not the assembly at a pose', async () => {
    const asked = await h.call('render', {
      sessionId,
      views: [{ camera: 'isometric', assemblyId: ids.assembly, width: 320, height: 240 }],
    });
    expect(asked.ok).toBe(false);
    expect(asked.error!.message).toMatch(/Unrecognized key: "assemblyId"/);
    const drawn = await h.raw('render', {
      sessionId,
      views: [{ camera: 'front', width: 480, height: 400, highlight: [`${ids.dfr}`] }],
    });
    expect(drawn.isError).toBeFalsy();
    expect(drawn.content.filter((c) => c.type === 'image')).toHaveLength(1);
  });

  it('gap probe: widening the cabinet leaves the drawer and slides where they were', async () => {
    // One inch wider: the right side moves out, and the fixed panels reach it.
    const right = 24 * IN - (23 / 32 - 1 / 4) * IN;
    const commands: unknown[] = [];
    for (const id of ['sketch#2', 'sketch#3', 'sketch#4', 'sketch#5', 'sketch#6']) {
      const read = await call('get_object', {
        sessionId,
        query: { kind: 'feature', partId: P, featureId: id },
      });
      const f = structuredClone(read.object) as Data;
      if (id === 'sketch#2') {
        f.plane.origin[0] += IN;
      } else {
        for (const e of f.entities as Data[]) {
          for (const p of [e.start, e.end]) if (Math.abs(p[0] - right) < 1e-6) p[0] += IN;
        }
      }
      commands.push({ type: 'editFeature', partId: P, feature: f });
    }
    const r = await call('apply', { sessionId, label: 'Make the cabinet 25" wide', commands });
    expect(r.errors).toEqual([]);
    close((await clearance('extension#1', 'extension#2')).gaps[0].boxGap, 23.5625 * IN);
    // The right slide now stands an inch off the side, and the drawer width variable still says
    // 21-9/16": nothing followed the opening.
    close((await clearance('extension#2', ids.rc!)).gaps[0].boxGap, IN);
    const variables = (await tree()).variables as Data[];
    close(variables.find((v) => v.name === 'drawer_width')!.value.value, 21.5625 * IN);
    await call('undo', { sessionId });
    close((await clearance('extension#2', ids.rc!)).gaps[0].boxGap, 0);
  });

  it('exports the cut list and submits the branch for review', async () => {
    const cuts = await call('export', {
      sessionId,
      format: 'cut-list-csv',
      fileName: 'drawer-cut-list',
      assemblyId: ids.assembly,
    });
    expect(cuts.reviewed).toBe(false);
    expect((await call('get_errors', { sessionId })).errors).toEqual([]);
    const submitted = await call('submit_for_review', {
      sessionId,
      note:
        'Added a drawer box (21-9/16" x 12" x 18", 1/2" plywood, 1/4" bottom, dowelled) in the ' +
        'bottom opening, on two 18" slides modelled as plain steel bars (1/2" each side), and an ' +
        'assembly with a slider mate limited to 0 to 18". Checked: no interference closed, at 9" ' +
        'and at 18". Not checked: the slides are not in the bill of materials.',
      views: [{ name: 'Drawer', camera: { view: 'front', fit: [`${ids.dfr}`] } }],
    });
    expect(submitted.review).toBe('submitted');
  });
});
