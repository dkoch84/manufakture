// Acceptance scenario T8.6a, drawer slides (M8 plan; write-up in
// docs/m8-acceptance/drawer-slides.md). The request:
//
//   "Add a drawer to the bottom opening of this cabinet on 18" side-mount ball-bearing slides,
//   1/2" clearance each side, and check it opens fully."
//
// A fixed tool-call sequence through the real MCP server (in process), doing the scenario as far
// as the product allows: measure the opening, a drawer box of boards with dowel joints, the slides
// from the hardware catalog (#1200; before, plain steel bodies), an assembly with a slider mate
// limited to the slide's travel, and interference checks at poses along that travel and swept
// over it. The plan's gap hypotheses, and the gaps found on the way, were asserted in tests named
// "gap probe"; every one has since flipped into a test of the fix, which says what was found
// before, and the write-up's gap table says the same.
//
// The guide's cabinet (packages/session's fixture) is a bookshelf 11-1/4" deep, too shallow for
// an 18" slide; the first test shows that. The rest runs on the same cabinet made 22" deep by
// commands (../fixtures/drawer-slides/cabinet.ts).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { BackendBundleStore } from '@manufakture/session';
import { cabinetDocument } from '@manufakture/session/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARDWARE_URI } from '../../src/resources';
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

/**
 * A rectangle sketch (mm) from (x0, y0) to (x1, y1), its lines `e$<name>_0` (bottom) to `_3`
 * (left, `_1` the right side), on a plane or on a planar face (by name). With `size`, constrained
 * fully: corners joined, sides square, the bottom-left corner fixed where it is drawn, and the
 * width and height dimensions those expressions (inches), so the right side follows the width.
 */
function rectangle(
  id: string,
  name: string,
  plane: { origin: V3; normal: V3; xDir: V3 } | { face: string },
  [x0, y0, x1, y1]: [number, number, number, number],
  size?: { width: string; height: string },
) {
  const c: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const key = id.slice('sketch#$'.length);
  const e = (i: number) => `e$${key}_${i}`;
  const k = (i: number) => `k$${key}_k${i}`;
  const at = (i: number, end: 'start' | 'end') => ({ entity: e(i), at: end });
  return add({
    id,
    kind: 'sketch',
    name,
    plane:
      'face' in plane
        ? { type: 'face', face: { id: `r$${key}_on`, ref: { face: plane.face } } }
        : { type: 'plane', ...plane },
    entities: c.map((start, i) => ({
      id: e(i),
      kind: 'line',
      construction: false,
      start,
      end: c[(i + 1) % 4],
    })),
    constraints:
      size === undefined
        ? []
        : [
            ...[0, 1, 2, 3].map((i) => ({
              id: k(i),
              kind: 'coincident',
              a: at(i, 'end'),
              b: at((i + 1) % 4, 'start'),
            })),
            { id: k(4), kind: 'horizontal', line: e(0) },
            { id: k(5), kind: 'horizontal', line: e(2) },
            { id: k(6), kind: 'vertical', line: e(1) },
            { id: k(7), kind: 'vertical', line: e(3) },
            { id: k(8), kind: 'fix', point: at(0, 'start') },
            {
              id: k(9),
              kind: 'horizontalDistance',
              a: at(0, 'start'),
              b: at(0, 'end'),
              value: inches(size.width),
            },
            {
              id: k(10),
              kind: 'verticalDistance',
              a: at(1, 'start'),
              b: at(1, 'end'),
              value: inches(size.height),
            },
          ],
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
/** The slide is centred on the drawer's side. */
const zMid = (z0 + z1) / 2;

/** The opening's width, measured between the sides' faces at every regen (#1202). */
const OPENING_WIDTH = `distance("${SIDES.left}", "${SIDES.right}")`;
/** Between the drawer's sides: the front, back and bottom are this wide. */
const INSIDE = { width: '#drawer_width - 2 * 15/32"', height: '12"' };

const DRAWER = [
  {
    type: 'setVariable',
    name: 'slide_clearance',
    expression: inches('1/2"'),
  },
  {
    type: 'setVariable',
    name: 'drawer_width',
    // Measured from the opening's side faces (#1202): it follows the cabinet. Found: no
    // expression could measure the model, so it was typed in as 22-9/16" less the clearances.
    expression: inches(`${OPENING_WIDTH} - 2 * #slide_clearance`),
  },
  rectangle(
    'sketch#$ls',
    'Drawer left side',
    { origin: [xL, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
    [0, z0, LENGTH, z1],
  ),
  // The front, back and bottom are as wide as the drawer less its sides, by dimension.
  rectangle(
    'sketch#$fr',
    'Drawer front',
    { origin: [0, T, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
    [xL + T, z0, xR - T, z1],
    INSIDE,
  ),
  rectangle(
    'sketch#$bk',
    'Drawer back',
    { origin: [0, LENGTH, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
    [xL + T, z0, xR - T, z1],
    INSIDE,
  ),
  rectangle(
    'sketch#$bt',
    'Drawer bottom',
    { origin: [0, 0, z0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    [xL + T, T, xR - T, LENGTH - T],
    { width: INSIDE.width, height: `${(LENGTH - 2 * T) / IN}"` },
  ),
  board('extension#$dls', 'Drawer left side', 'sketch#$ls', 'us-ply-15-32'),
  board('extension#$dfr', 'Drawer front', 'sketch#$fr', 'us-ply-15-32'),
  // The right side stands on the front's right end, so it goes where the front's width takes it.
  rectangle('sketch#$rs', 'Drawer right side', { face: 'extension#$dfr:side:e$fr_1' }, [
    0,
    z0,
    LENGTH,
    z1,
  ]),
  board('extension#$drs', 'Drawer right side', 'sketch#$rs', 'us-ply-15-32'),
  board('extension#$dbk', 'Drawer back', 'sketch#$bk', 'us-ply-15-32'),
  board('extension#$dbt', 'Drawer bottom', 'sketch#$bt', 'us-ply-7-32'),
  dowels('extension#$j1', 'Drawer front to left side', 'extension#$dls', 'extension#$dfr'),
  dowels('extension#$j2', 'Drawer front to right side', 'extension#$drs', 'extension#$dfr'),
  dowels('extension#$j3', 'Drawer back to left side', 'extension#$dls', 'extension#$dbk'),
  dowels('extension#$j4', 'Drawer back to right side', 'extension#$drs', 'extension#$dbk'),
];

/**
 * A slide from the hardware catalog (#1200): a `wood.slide` feature between a cabinet side and a
 * drawer side, the drawer pulling out towards -Y. Found: no catalog, so the slides were four plain
 * extrudes (a 1/4" x 1-3/4" x 18" bar per member), made steel by hand, and in no bill of materials.
 */
const slide = (key: string, name: string, cabinet: string, drawer: string, size = '18in') =>
  add({
    id: `extension#$${key}`,
    kind: 'extension',
    name,
    extension: 'wood.slide',
    schemaVersion: 1,
    operation: 'new',
    dependsOn: [cabinet, drawer],
    references: [],
    expressions: {},
    params: { family: 'side-mount-ball-bearing', size, cabinet, drawer, opens: '-y' },
  });

/** The pair: the left one on the cabinet's left side, the right one on its right side. */
const slides = (dls: string, drs: string, size = '18in') => [
  slide('lslide', 'Left slide', 'extension#1', dls, size),
  slide('rslide', 'Right slide', 'extension#2', drs, size),
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
    // The same sizes by measurement, between faces of two bodies (#1206): a target's bodyId puts
    // it on another body of the part. Found: `targets` measured within one body only, so these
    // came from `clearance`'s gap between the bodies' boxes, which holds for aligned boxes only.
    const across = async (a: [string, string], b: [string, string]) => {
      const r = await call('measure', {
        sessionId,
        query: {
          kind: 'targets',
          partId: P,
          bodyId: a[0],
          targets: [
            { kind: 'face', name: a[1] },
            { kind: 'face', name: b[1], bodyId: b[0] },
          ],
        },
      });
      const m = r.measurement as Data;
      expect(m.items.map((i: Data) => [i.ok, i.bodyId])).toEqual([
        [true, a[0]],
        [true, b[0]],
      ]);
      // Parallel faces facing each other: the planes' distance is the faces', square across.
      expect(m.angle).toMatchObject({ between: 'planes', value: 0 });
      close(m.angle.normals, 180);
      close(m.distance.planes, m.distance.value);
      return m.distance.planes as number;
    };
    const width = await across(['extension#1', SIDES.left], ['extension#2', SIDES.right]);
    const height = await across(['extension#3', floor.name], ['extension#5', ceiling.name]);
    close(width, 22.5625 * IN);
    close(height, (14 - 23 / 32) * IN);
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

  it('a variable takes a measured value; a lost face is an error naming it', async () => {
    // Found: the functions were min, max, abs, sqrt, trig and rounding, nothing that reads the
    // model, so this was refused (`expression`). Now (#1202) `distance(...)` between two quoted
    // face names reads the part at regen: here the opening's width, between faces of two bodies.
    const width = await h.call('apply', {
      sessionId,
      label: 'The opening width, measured',
      dryRun: true,
      commands: [{ type: 'setVariable', name: 'opening_width', expression: inches(OPENING_WIDTH) }],
    });
    expect(value(width).errors).toEqual([]);
    // A face name that is lost (no such dado wall) fails at regen, naming the variable and the face.
    const lost = await call('apply', {
      sessionId,
      label: 'A measured variable on a face that is not there',
      dryRun: true,
      commands: [
        {
          type: 'setVariable',
          name: 'opening_width',
          expression: inches(
            `distance("${SIDES.left}", "extension#2:cap:start{extension#99:groove:xmin}")`,
          ),
        },
      ],
    });
    expect(lost.errors).toEqual([
      {
        where: 'variable',
        id: 'opening_width',
        severity: 'error',
        code: 'measure',
        message:
          '#opening_width: Face "extension#2:cap:start{extension#99:groove:xmin}" is not found on part#1: it has no extension#99',
      },
    ]);
    // Measuring is for variables: a feature field reads the variable, never distance() itself.
    const field = await h.call('apply', {
      sessionId,
      label: 'An extrude measuring the model',
      dryRun: true,
      commands: [
        add({
          id: 'extrude#$x',
          kind: 'extrude',
          name: 'x',
          profile: { sketch: 'sketch#1' },
          operation: 'new',
          extent: { type: 'blind', distance: inches(OPENING_WIDTH) },
          reverse: false,
        }),
      ],
    });
    expect(field.ok).toBe(false);
    expect(field.error).toMatchObject({
      kind: 'core',
      error: {
        code: 'expression',
        message: expect.stringMatching(/may only be used in a variable/),
      },
    });
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
    expect(ids.dfr).toBe('extension#16');
    // The drawer's width is measured from the opening (#1202), and its front, back and bottom are
    // dimensioned from it; the right side stands on the front's end.
    const width = await call('get_object', {
      sessionId,
      query: { kind: 'variable', name: 'drawer_width' },
    });
    expect(width.object.expression.source).toBe(`${OPENING_WIDTH} - 2 * #slide_clearance`);
    const variables = (await tree()).variables as Data[];
    close(variables.find((v) => v.name === 'drawer_width')!.value.value, 21.5625 * IN);
    const drawer = await clearance(ids.dls!, ids.drs!);
    close(drawer.gaps[0].boxGap, 21.5625 * IN - 2 * T);
  });

  it('picks an 18" side-mount slide from the hardware catalog and places the pair', async () => {
    // The catalog is a resource: the family's clearance is the 1/2" asked for, and the 18" size
    // fits the 22" cabinet and the 18" drawer.
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri)).toContain(HARDWARE_URI);
    const first = (await h.client.readResource({ uri: HARDWARE_URI })).contents[0] as {
      text: string;
    };
    const catalog = (JSON.parse(first.text) as Data).drawerSlides as Data;
    expect(catalog.feature.extension).toBe('wood.slide');
    const family = (catalog.families as Data[]).find((f) => f.clearance.kind === 'side-mount')!;
    expect(family).toMatchObject({ id: 'side-mount-ball-bearing', verified: false });
    close(family.clearance.side.nominal, CLEARANCE * IN);
    expect((family.sizes as Data[]).map((s) => s.id)).toEqual(
      [10, 12, 14, 16, 18, 20, 22, 24, 26, 28].map((n) => `${n}in`),
    );
    const size = (family.sizes as Data[]).find((s) => Math.abs(s.nominal - LENGTH) < 1e-6)!;
    expect(size).toMatchObject({ id: '18in', cabinetLength: 450, minCabinetDepth: 450 });
    expect(size.minCabinetDepth).toBeLessThan(22 * IN);
    expect(size.drawerLength).toBeLessThanOrEqual(LENGTH);

    // A size the cabinet is too shallow for is a regen error that says so (a dry run).
    const long = await call('apply', {
      sessionId,
      label: 'A 24" slide pair',
      dryRun: true,
      commands: slides(ids.dls!, ids.drs!, '24in'),
    });
    expect(long.errors).toEqual(
      ['extension#24', 'extension#25'].map((featureId) =>
        expect.objectContaining({
          featureId,
          message: expect.stringMatching(
            /needs 600 mm of extension#[12] behind its front, and there is 558\.8 mm: the cabinet is too shallow/,
          ) as string,
        }),
      ),
    );

    // Found: no command or feature made a purchased part, and a `wood.slide` extension regenerated
    // with `unsupported`. Now the pair goes in one batch, a slide per side.
    const r = await call('apply', {
      sessionId,
      label: 'Add 18" side-mount slides',
      commands: slides(ids.dls!, ids.drs!),
    });
    expect(r.errors).toEqual([]);
    const s = r.symbols as Record<string, string>;
    expect([s.$lslide, s.$rslide]).toEqual(['extension#24', 'extension#25']);
    // Each slide makes two bodies, its cabinet member and its drawer member.
    Object.assign(ids, {
      lslide: s.$lslide,
      rslide: s.$rslide,
      lc: `${s.$lslide}:slide/cabinet`,
      ld: `${s.$lslide}:slide/drawer`,
      rc: `${s.$rslide}:slide/cabinet`,
      rd: `${s.$rslide}:slide/drawer`,
    });
    const bodies = ((await tree()).parts as Data[])[0]!.bodies as Data[];
    expect(bodies.map((b) => b.id ?? b.bodyId)).toEqual(
      expect.arrayContaining([ids.lc, ids.ld, ids.rc, ids.rd]),
    );
    // Each slide fills its 1/2" exactly: touching both sides, overlapping neither.
    for (const [side, c, d, drawer] of [
      ['extension#1', ids.lc, ids.ld, ids.dls],
      ['extension#2', ids.rc, ids.rd, ids.drs],
    ]) {
      const fit = await call('measure', {
        sessionId,
        query: {
          kind: 'clearance',
          bodies: [side, c, d, drawer].map((bodyId) => ({ partId: P, bodyId })),
        },
      });
      expect(fit.measurement.pairs).toEqual([]);
      close((await clearance(side!, c!)).gaps[0].boxGap, 0);
      close((await clearance(d!, drawer!)).gaps[0].boxGap, 0);
    }
    // The slide's height, centred on the drawer side, and its closed length from the front.
    const member = await call('measure', {
      sessionId,
      query: { kind: 'body', partId: P, bodyId: ids.lc },
    });
    const { min, max } = member.measurement.boundingBox;
    close(max[2] - min[2], 45.7);
    close((max[2] + min[2]) / 2, zMid);
    close(min[1], 0);
    close(max[1], 450);
    close(max[0] - min[0], (CLEARANCE * IN) / 2);
  });

  it('counts the slides as hardware lines in the cut list and the bill of materials', async () => {
    const q = (await call('get_quantities', { sessionId })).quantities as Data;
    expect(q.reviewed).toBe(false);
    // Found: the hardware lines came only from joints, and the slides were left out as "not
    // wood". Now the pair is a line of its own, and its members are neither pieces nor excluded.
    expect(q.hardware.map((r: Data) => [r.kind, r.item, r.quantity])).toEqual([
      ['hardware', 'Dowel', 16],
      ['hardware', 'Drawer slide, side-mount ball-bearing, full extension', 2],
    ]);
    const line = (q.hardware as Data[])[1]!;
    close(line.size.length, LENGTH);
    expect(line.sources.map((x: Data) => x.id)).toEqual([ids.lslide, ids.rslide]);
    expect(q.cutList.totals.map((t: Data) => t.group)).toEqual(['sheet', 'hardware']);
    expect(q.cutList.excluded).toEqual([]);
    expect(q.cutList.rows.map((r: Data) => r.item)).toContain(
      'Drawer left side, Drawer right side',
    );
    expect(q.cutList.rows.map((r: Data) => r.item).join(' ')).not.toMatch(/slide/i);
    // And so is the bill of materials file: the dowels and the slides, by length.
    const bom = await call('export', { sessionId, format: 'bom-csv', fileName: 'drawer-bom' });
    expect(bom.reviewed).toBe(false);
    const csv = readFileSync(path.join(h.outputDir, bom.files[0].name), 'utf8');
    expect(csv).toMatch(/Dowel/);
    expect(csv).toContain('"Drawer slide, side-mount ball-bearing, full extension","18""",2,');
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
    // The cabinet made 17" deep (the 18" drawer as it was, the slides 16"): the back now stands
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
    // The 18" slides no longer fit (#1200): as a dry run, each is an error naming the room it
    // needs, and the instances lose their members. Found: the plain bars stayed, 1/2" past the
    // cabinet's back.
    const tooShallow = await call('apply', {
      sessionId,
      label: 'Make the cabinet 17" deep',
      dryRun: true,
      commands,
    });
    expect(tooShallow.errors).toEqual([
      ...[ids.lslide, ids.rslide].map((featureId) =>
        expect.objectContaining({
          where: 'feature',
          featureId,
          message: expect.stringMatching(
            /needs 450 mm of extension#[12] behind its front, and there is 431\.8 mm: the cabinet is too shallow/,
          ) as string,
        }),
      ),
      ...[ids.cabinet, ids.drawer].map((id) =>
        expect.objectContaining({ where: 'instance', id, code: 'reference-lost' }),
      ),
    ]);
    // So the slides go down to 16" with it (400 mm closed), in the same batch.
    for (const id of [ids.lslide!, ids.rslide!]) {
      const read = await call('get_object', {
        sessionId,
        query: { kind: 'feature', partId: P, featureId: id },
      });
      const f = structuredClone(read.object) as Data;
      f.params.size = '16in';
      commands.push({ type: 'editFeature', partId: P, feature: f });
    }
    const r = await call('apply', {
      sessionId,
      label: 'Make the cabinet 17" deep, on 16" slides',
      commands,
    });
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

  it('renders the assembly with the drawer closed and 18" open, and at a pose past the travel', async () => {
    const view = (assembly: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      camera: 'right',
      width: 480,
      height: 320,
      assembly: { assemblyId: ids.assembly, ...assembly },
      ...extra,
    });
    // At the solved poses (closed), and with the slider held at 18": the drawer, highlighted by
    // its instance, sticks out of the front. From the top, in a wide and low image, the closed
    // one is framed on the 22" depth and the open one on that and the 18" the drawer came out,
    // so the image's scale grows by 40/22.
    const top = { camera: 'top', width: 480, height: 160, highlight: [`${ids.drawer}/*`] };
    const r = await h.raw('render', {
      sessionId,
      views: [view({}, top), view({ mates: { [ids.mate!]: LENGTH } }, top)],
    });
    expect(r.isError).toBeFalsy();
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(2);
    const { images, failed } = r.structuredContent as Data;
    expect(failed).toEqual([]);
    const [closed, open] = images as [Data, Data];
    for (const [image, distance] of [
      [closed, 0],
      [open, LENGTH],
    ] as const) {
      expect(image.unmatched).toEqual([]);
      expect(image.assembly).toMatchObject({
        assemblyId: ids.assembly,
        mates: [{ mateId: ids.mate, kind: 'slider' }],
        warnings: [],
        skipped: [],
      });
      expect(image.assembly.mates[0].coordinates).toEqual([
        { name: 'distance', value: expect.closeTo(distance, 6) as number, unit: 'mm' },
      ]);
    }
    close(open.mmPerPixel / closed.mmPerPixel, 40 / 22, 2);
    // Past the slide's travel: drawn there all the same, with the warning the interference check
    // gives. So is a pose placed by hand; and a pose off the slider says so.
    const past = await call('render', {
      sessionId,
      views: [
        view({ mates: { [ids.mate!]: 600 } }),
        view({ poses: { [ids.drawer!]: pulled(600) } }),
        view({ poses: { [ids.drawer!]: { translation: [IN, -IN, 0], rotation: [0, 0, 0, 1] } } }),
      ],
    });
    const [held, placed, sideways] = past.images as [Data, Data, Data];
    for (const image of [held, placed]) {
      expect(image.assembly.mates[0].coordinates[0].value).toBeCloseTo(600, 6);
      expect(image.assembly.warnings).toEqual([
        expect.objectContaining({
          code: 'outside-limits',
          mateId: ids.mate,
          bound: 'max',
          limit: expect.closeTo(LENGTH, 6) as number,
          value: expect.closeTo(600, 6) as number,
          unit: 'mm',
        }),
      ]);
    }
    expect(sideways.assembly.warnings).toEqual([
      expect.objectContaining({
        code: 'off-mate',
        mateId: ids.mate,
        position: expect.closeTo(IN, 6) as number,
      }),
    ]);
    // Refused per view: an assembly that does not exist, a mate that does not move.
    const wrong = await call('render', {
      sessionId,
      views: [
        view({}),
        { ...view({}), assembly: { assemblyId: 'assembly#99' } },
        view({ mates: { 'mate#99': 1 } }),
      ],
    });
    expect(wrong.images).toHaveLength(1);
    expect(wrong.failed).toEqual([
      expect.objectContaining({ view: 1, side: 'head', code: 'not-found' }),
      expect.objectContaining({ view: 2, side: 'head', code: 'invalid-input' }),
    ]);
    // At most 64 mate values (and poses) a view.
    const many = await h.call('render', {
      sessionId,
      views: [
        view({ mates: Object.fromEntries(Array.from({ length: 65 }, (_, k) => [`mate#${k}`, 0])) }),
      ],
    });
    expect(many.ok).toBe(false);
    expect(many.error!.message).toMatch(/At most 64 entries/);
    // The part studio is still drawn as before when no assembly is asked for.
    const drawn = await h.raw('render', {
      sessionId,
      views: [{ camera: 'front', width: 480, height: 400, highlight: [`${ids.dfr}`] }],
    });
    expect(drawn.isError).toBeFalsy();
    expect(drawn.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect((drawn.structuredContent as Data).images[0].assembly).toBeUndefined();
  });

  it('widening the cabinet widens the drawer, and the slides follow', async () => {
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
    // Found: the right slide stood an inch off the side, and `#drawer_width` still said 21-9/16"
    // (it was typed in). Now (#1202) it measures the opening, 1" wider, and the drawer's front,
    // back, bottom and right side, and the right slide on it, follow.
    const variables = (await tree()).variables as Data[];
    close(variables.find((v) => v.name === 'drawer_width')!.value.value, 22.5625 * IN);
    close((await clearance(ids.dls!, ids.drs!)).gaps[0].boxGap, 22.5625 * IN - 2 * T);
    const fit = await call('measure', {
      sessionId,
      query: {
        kind: 'clearance',
        bodies: ['extension#2', ids.rc, ids.rd, ids.drs].map((bodyId) => ({ partId: P, bodyId })),
      },
    });
    // The right slide fills the 1/2" again, touching the side and the drawer, overlapping none.
    expect(fit.measurement.pairs).toEqual([]);
    close((await clearance('extension#2', ids.rc!)).gaps[0].boxGap, 0);
    close((await clearance(ids.rd!, ids.drs!)).gaps[0].boxGap, 0);
    // The drawer still opens fully at the new width.
    for (const d of [0, LENGTH]) {
      expect((await interference({ poses: { [ids.drawer!]: pulled(d) } })).pairs).toEqual([]);
    }
    expect((await call('get_errors', { sessionId })).errors).toEqual([]);
    await call('undo', { sessionId });
    close((await clearance('extension#2', ids.rc!)).gaps[0].boxGap, 0);
    close(
      (await tree()).variables.find((v: Data) => v.name === 'drawer_width').value.value,
      21.5625 * IN,
    );
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
    // A review view's ids are at most 120 characters: the refusal says so.
    const long = await h.call('submit_for_review', {
      sessionId,
      views: [
        { name: 'Long', assembly: { assemblyId: ids.assembly, mates: { ['m'.repeat(121)]: 0 } } },
      ],
    });
    expect(long.ok).toBe(false);
    expect(long.error!.message).toMatch(/not valid review views\. .*1 to 120 characters/);
    const submitted = await call('submit_for_review', {
      sessionId,
      note:
        'Added a drawer box (21-9/16" x 12" x 18", 1/2" plywood, 1/4" bottom, dowelled) in the ' +
        'bottom opening, on a pair of 18" side-mount slides from the hardware catalog (1/2" each ' +
        'side, in the bill of materials; the catalog is not verified against a real slide), and ' +
        'an assembly with a slider mate limited to 0 to 18". Checked: no interference closed, at ' +
        '9" and at 18".',
      views: [
        { name: 'Drawer', camera: { view: 'front', fit: [`${ids.dfr}`] } },
        {
          name: 'Drawer open 18"',
          camera: 'right',
          highlight: [`${ids.drawer}/*`],
          assembly: { assemblyId: ids.assembly, mates: { [ids.mate!]: LENGTH } },
        },
      ],
    });
    expect(submitted.review).toBe('submitted');
    // The bundle's assembly view: the base has no assembly, the head shows the drawer open.
    const { branch } = await call('get_review', { sessionId });
    const stored = await new BackendBundleStore(new NodeBackend(h.libraryRoot)).latest(
      BASE_CABINET_ID,
      branch,
    );
    const renders = (stored!.bundle as Data).renders as Data[];
    expect(renders.map((v) => v.name)).toEqual([
      'isometric',
      'front',
      'top',
      'right',
      'Drawer',
      'Drawer open 18"',
    ]);
    const open = renders[5]!;
    expect(open.head).toMatchObject({ width: 800, height: 600 });
    expect(open.base).toBeNull();
    expect(open.baseError).toMatch(/no assembly/);
    expect(open.assembly).toMatchObject({
      assemblyId: ids.assembly,
      mates: { [ids.mate!]: expect.closeTo(LENGTH, 6) as number },
      poses: {},
      base: null,
      head: {
        mates: {
          items: [{ mateId: ids.mate, kind: 'slider', coordinates: [{ name: 'distance' }] }],
          omitted: 0,
        },
        warnings: { items: [], omitted: 0 },
        skipped: { items: [], omitted: 0 },
      },
    });
    close(open.assembly.head.mates.items[0].coordinates[0].value, LENGTH);
  });
});
