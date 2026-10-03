// The IFC writer (T6.6a): a building (`IfcBuildingInput`) as an IFC4 file through web-ifc's model
// writer. web-ifc (MPL-2.0, ADR 0006) is loaded on the first export only, with a dynamic import,
// so it is its own chunk and `.wasm` and never part of a bundle that does not export IFC; it runs
// single-threaded (ADR 0002 rules out cross-origin isolation).
//
// What is written (the M6 plan's T6.6a scope):
// - `IfcProject` with its units (the document's length unit) and a Body context, `IfcSite`,
//   `IfcBuilding`, one `IfcBuildingStorey` per level, joined by `IfcRelAggregates`.
// - `IfcWall` per wall. Its framing members, and its sheathing (`IfcPlate` SHEET) and siding and
//   drywall (`IfcCovering` CLADDING) as boxes with the openings left out, are its parts
//   (`IfcRelAggregates`), so a wall has no body of its own unless it has no parts; then its
//   framing band is its body.
// - `IfcOpeningElement` per opening voiding its wall (`IfcRelVoidsElement`), filled
//   (`IfcRelFillsElement`) by an `IfcDoor` or `IfcWindow` (a panel in the framing band).
// - Members as extruded rectangles (their blanks; cuts are not written) with their placement:
//   `IfcMember` STUD, PLATE, RAFTER (or USERDEFINED with the role), `IfcBeam` JOIST, LINTEL.
// - `IfcSlab` FLOOR per floor (its subfloor), the floor's members its parts; `IfcRoof` per roof
//   aggregating its members and its sheathing sheets (`IfcPlate`).
// - Walls, doors, windows, slabs and roofs are contained in their storey
//   (`IfcRelContainedInSpatialStructure`); parts are not (their whole is).
// - The disclaimer in the header's FILE_DESCRIPTION.
//
// GlobalIds are derived from the document id and element ids (`guid.ts`). Strings go through
// `ifcString` (see `strings.ts` for why), and the saved file is checked to be 7-bit ASCII with
// exactly the entity lines written, so no document text can add or hide an entity.

import type * as WebIfc from 'web-ifc';
import { ifcGlobalId } from './guid';
import {
  IFC_UNIT_MM,
  IfcExportError,
  MAX_IFC_WORK,
  checkIfcBuilding,
  type IfcBuildingInput,
  type IfcMemberInput,
  type IfcOpeningInput,
  type IfcPlaneInput,
  type IfcVec2,
  type IfcVec3,
  type IfcWallInput,
} from './model';
import { MAX_IFC_LABEL, ifcHeaderStrings, ifcString } from './strings';

type WebIfcModule = typeof WebIfc;
type Handle<T> = WebIfc.Handle<T>;
type IFC4 = typeof WebIfc.IFC4;

/** The IFC schema written. IFC4 (ADD2 TC1) is what common viewers and BIM tools open. */
export const IFC_SCHEMA = 'IFC4';
/** The model view declared in the header. */
export const IFC_VIEW_DEFINITION = 'ViewDefinition [ReferenceView_V1.2]';

export interface IfcWriteOptions {
  /**
   * web-ifc's `locateFile` handler: where `web-ifc.wasm` is (a bundler's asset URL in the
   * browser). Node finds its own file. Only the first load uses it.
   */
  readonly locateFile?: (path: string, prefix: string) => string;
  /** Loads the web-ifc module instead of `import('web-ifc')` (tests, or a worker's own loader). */
  readonly load?: () => Promise<WebIfcModule>;
  /** A lower work budget than `MAX_IFC_WORK` (tests); never a higher one. */
  readonly maxWork?: number;
}

interface Loaded {
  mod: WebIfcModule;
  api: WebIfc.IfcAPI;
}

let loading: Promise<Loaded> | null = null;

/**
 * web-ifc, loaded and initialised once per module instance (one per worker), single-threaded.
 * A failed load is forgotten, so the next export tries again.
 */
export function loadWebIfc(options: IfcWriteOptions = {}): Promise<Loaded> {
  loading ??= (async () => {
    const mod = await (options.load ? options.load() : import('web-ifc'));
    const api = new mod.IfcAPI();
    await api.Init(options.locateFile, true);
    api.SetLogLevel(mod.LogLevel.LOG_LEVEL_OFF);
    return { mod, api };
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

// Plain vector helpers (mm) ---------------------------------------------------------------------

const add = (a: IfcVec3, b: IfcVec3): IfcVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: IfcVec3, s: number): IfcVec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: IfcVec3, b: IfcVec3): IfcVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: IfcVec3): IfcVec3 => scale(a, 1 / Math.hypot(...a));
const UP: IfcVec3 = [0, 0, 1];

interface Segment {
  a: IfcVec3;
  d: IfcVec3;
  n: IfcVec3;
  length: number;
}

function segments(w: IfcWallInput): Segment[] {
  const count = w.closed ? w.points.length : w.points.length - 1;
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const a = w.points[i]!;
    const b = w.points[(i + 1) % w.points.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: IfcVec3 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length, 0];
    out.push({ a: [a[0], a[1], 0], d, n: [-d[1], d[0], 0], length });
  }
  return out;
}

/** A rectangle on a wall face: along the segment `x0..x1`, up from the base `z0..z1`. */
interface FaceRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const EPS = 1e-6;

/**
 * The face `[0, length] x [0, height]` less the openings, as rectangles: vertical strips between
 * opening edges, each less the openings that cross it, equal neighbours merged. At most
 * `(2k + 1) (k + 1)` rectangles for `k` openings.
 */
export function faceRects(length: number, height: number, holes: readonly FaceRect[]): FaceRect[] {
  const clipped = holes
    .map((h) => ({
      x0: Math.max(0, h.x0),
      x1: Math.min(length, h.x1),
      z0: Math.max(0, h.z0),
      z1: Math.min(height, h.z1),
    }))
    .filter((h) => h.x1 - h.x0 > EPS && h.z1 - h.z0 > EPS);
  const xs = [...new Set([0, length, ...clipped.flatMap((h) => [h.x0, h.x1])])].sort(
    (p, q) => p - q,
  );
  const out: FaceRect[] = [];
  let open: FaceRect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i]!;
    const xb = xs[i + 1]!;
    if (xb - xa <= EPS) continue;
    const mid = (xa + xb) / 2;
    const cover = clipped
      .filter((h) => h.x0 < mid && mid < h.x1)
      .map((h) => [h.z0, h.z1] as const)
      .sort((p, q) => p[0] - q[0]);
    const spans: [number, number][] = [];
    let z = 0;
    for (const [z0, z1] of cover) {
      if (z0 - z > EPS) spans.push([z, z0]);
      z = Math.max(z, z1);
    }
    if (height - z > EPS) spans.push([z, height]);
    const same =
      open.length === spans.length &&
      open.every(
        (r, k) => Math.abs(r.z0 - spans[k]![0]) <= EPS && Math.abs(r.z1 - spans[k]![1]) <= EPS,
      );
    if (same) {
      for (const r of open) r.x1 = xb;
    } else {
      out.push(...open);
      open = spans.map(([z0, z1]) => ({ x0: xa, x1: xb, z0, z1 }));
    }
  }
  out.push(...open);
  return out;
}

// Member classification -------------------------------------------------------------------------

type MemberClass =
  | { entity: 'member'; type: keyof IFC4['IfcMemberTypeEnum'] & string }
  | { entity: 'beam'; type: keyof IFC4['IfcBeamTypeEnum'] & string };

const MEMBER_CLASSES: Readonly<Record<string, MemberClass>> = {
  stud: { entity: 'member', type: 'STUD' },
  king: { entity: 'member', type: 'STUD' },
  jack: { entity: 'member', type: 'STUD' },
  cripple: { entity: 'member', type: 'STUD' },
  corner: { entity: 'member', type: 'STUD' },
  'gable-stud': { entity: 'member', type: 'STUD' },
  'bottom-plate': { entity: 'member', type: 'PLATE' },
  'top-plate': { entity: 'member', type: 'PLATE' },
  'rough-sill': { entity: 'member', type: 'PLATE' },
  'common-rafter': { entity: 'member', type: 'RAFTER' },
  'jack-rafter': { entity: 'member', type: 'RAFTER' },
  'hip-rafter': { entity: 'member', type: 'RAFTER' },
  'fly-rafter': { entity: 'member', type: 'RAFTER' },
  joist: { entity: 'beam', type: 'JOIST' },
  rim: { entity: 'beam', type: 'JOIST' },
  'ceiling-joist': { entity: 'beam', type: 'JOIST' },
  header: { entity: 'beam', type: 'LINTEL' },
  'header-spacer': { entity: 'beam', type: 'LINTEL' },
};

/** How a member role is written: its entity and predefined type (USERDEFINED: the role). */
export function memberClass(role: string): MemberClass {
  return Object.hasOwn(MEMBER_CLASSES, role)
    ? MEMBER_CLASSES[role]!
    : role === 'ridge' || role === 'skid'
      ? { entity: 'beam', type: 'USERDEFINED' }
      : { entity: 'member', type: 'USERDEFINED' };
}

// The writer ------------------------------------------------------------------------------------

/**
 * The building as an IFC4 file (IFC-SPF text as bytes). Throws an `IfcExportError` when the
 * building is malformed or over the bounds of `model.ts`.
 */
export async function writeIfc(
  building: IfcBuildingInput,
  options: IfcWriteOptions = {},
): Promise<Uint8Array> {
  checkIfcBuilding(building);
  const { mod, api } = await loadWebIfc(options);
  const name = ifcString(building.name.trim() === '' ? 'manufakture' : building.name);
  const model = api.CreateModel(
    {
      schema: IFC_SCHEMA,
      name: `${name}.ifc`,
      description: [IFC_VIEW_DEFINITION, ...ifcHeaderStrings(building.disclaimer)],
      authors: [''],
      organizations: [''],
      // web-ifc writes an empty authorization as `$`, which ISO 10303-21 does not allow.
      authorization: 'none',
    },
    {},
  );
  if (model < 0) throw new IfcExportError('web-ifc could not create a model');
  try {
    const limit = Math.min(options.maxWork ?? MAX_IFC_WORK, MAX_IFC_WORK);
    const count = await build(mod, api, model, building, name, limit);
    const bytes = api.SaveModel(model);
    checkOutput(bytes, count);
    return bytes;
  } finally {
    api.CloseModel(model);
  }
}

/** The saved file is 7-bit ASCII and has exactly `count` entity lines. */
function checkOutput(bytes: Uint8Array, count: number): void {
  for (const b of bytes) {
    if (b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d)) {
      throw new IfcExportError('web-ifc wrote a character outside 7-bit ASCII');
    }
  }
  const text = new TextDecoder('ascii').decode(bytes);
  const data = text.slice(text.indexOf('\nDATA;'), text.lastIndexOf('\nENDSEC;'));
  const lines = data.match(/^#\d+=/gm)?.length ?? 0;
  if (lines !== count) {
    throw new IfcExportError(`web-ifc wrote ${lines} entities where ${count} were made`);
  }
}

async function build(
  mod: WebIfcModule,
  api: WebIfc.IfcAPI,
  model: number,
  b: IfcBuildingInput,
  projectName: string,
  limit: number,
): Promise<number> {
  const I = mod.IFC4;
  const mm = IFC_UNIT_MM[b.unit];
  let entities = 0;
  // The work budget (`MAX_IFC_WORK`): entities, boxes asked for (cache hits too) and list
  // references, so neither new nor repeated geometry can grow the file past it.
  let work = 0;
  const spend = (n: number) => {
    work += n;
    if (work > limit) {
      throw new IfcExportError(
        `the building is too large to export as IFC (over ${limit} entities and references)`,
      );
    }
  };

  const put = <T extends WebIfc.IfcLineObject>(o: T): Handle<T> => {
    spend(1);
    entities++;
    api.WriteLine(model, o);
    return new mod.Handle<T>(o.expressID);
  };
  const keys = new Set<string>();
  const gid = async (key: string) => {
    if (keys.has(key)) throw new IfcExportError(`two elements have the key "${key}"`);
    keys.add(key);
    return new I.IfcGloballyUniqueId(await ifcGlobalId(b.documentId, key));
  };
  // Text counts too, a unit per 64 characters: a label of 255 non-ASCII characters is about a
  // kilobyte of `\X2\` escapes, so labels must not be free.
  const clean = (s: string) => {
    const t = ifcString(s, MAX_IFC_LABEL);
    spend(Math.ceil(t.length / 64));
    return t;
  };
  const label = (s: string) => new I.IfcLabel(clean(s));
  const ident = (s: string) => new I.IfcIdentifier(clean(s));
  // Lengths in the file's unit, to 12 significant digits (so 38.1 mm in feet is not written with
  // the float noise of the division).
  const inUnit = (v: number) => Number((v / mm).toPrecision(12));
  const len = (v: number) => new I.IfcLengthMeasure(inUnit(v));
  const pos = (v: number) => new I.IfcPositiveLengthMeasure(inUnit(v));

  // Shared geometry, cached by value so equal points, directions and profiles are written once.
  const key = (v: readonly number[]) =>
    v.map((x) => (Math.abs(x) < 1e-12 ? 0 : x).toPrecision(12)).join(',');
  const points = new Map<string, Handle<WebIfc.IFC4.IfcCartesianPoint>>();
  const point = (p: readonly number[]) => {
    const k = key(p);
    let h = points.get(k);
    if (!h) {
      h = put(new I.IfcCartesianPoint(p.map(len)));
      points.set(k, h);
    }
    return h;
  };
  const dirs = new Map<string, Handle<WebIfc.IFC4.IfcDirection>>();
  const dir = (v: IfcVec3) => {
    const u = unit(v);
    const k = key(u);
    let h = dirs.get(k);
    if (!h) {
      h = put(new I.IfcDirection(u.map((x) => new I.IfcReal(Math.abs(x) < 1e-12 ? 0 : x))));
      dirs.set(k, h);
    }
    return h;
  };
  const axes = new Map<string, Handle<WebIfc.IFC4.IfcAxis2Placement3D>>();
  /** A placement at `at` (mm) with axis `z` and reference direction `x`; default axes when absent. */
  const axis = (at: IfcVec3, z?: IfcVec3, x?: IfcVec3) => {
    const k = `${key(at)}|${z ? key(unit(z)) : ''}|${x ? key(unit(x)) : ''}`;
    let h = axes.get(k);
    if (!h) {
      h = put(new I.IfcAxis2Placement3D(point(at), z ? dir(z) : null, x ? dir(x) : null));
      axes.set(k, h);
    }
    return h;
  };
  // web-ifc's geometry reader needs a profile's optional Position, so every rectangle has one.
  let centre2d: Handle<WebIfc.IFC4.IfcAxis2Placement2D> | undefined;
  const profiles = new Map<string, Handle<WebIfc.IFC4.IfcRectangleProfileDef>>();
  const rectangle = (dx: number, dy: number) => {
    const k = key([dx, dy]);
    let h = profiles.get(k);
    if (!h) {
      centre2d ??= put(
        new I.IfcAxis2Placement2D(put(new I.IfcCartesianPoint([len(0), len(0)])), null),
      );
      h = put(
        new I.IfcRectangleProfileDef(I.IfcProfileTypeEnum.AREA, null, centre2d, pos(dx), pos(dy)),
      );
      profiles.set(k, h);
    }
    return h;
  };
  const solids = new Map<string, Handle<WebIfc.IFC4.IfcExtrudedAreaSolid>>();
  /**
   * A box: the rectangle `dx` by `dy` whose corner is `corner`, spanned by `x` and `z cross x`,
   * extruded `depth` along `z`.
   */
  const box = (corner: IfcVec3, z: IfcVec3, x: IfcVec3, dx: number, dy: number, depth: number) => {
    spend(1);
    // Keyed by the exact inputs (plain number text is much cheaper than `key`); boxes equal only
    // up to rounding are simply written twice.
    const k = `${corner.join()}|${z.join()}|${x.join()}|${dx},${dy},${depth}`;
    let h = solids.get(k);
    if (!h) {
      const y = cross(unit(z), unit(x));
      const centre = add(add(corner, scale(unit(x), dx / 2)), scale(y, dy / 2));
      h = put(
        new I.IfcExtrudedAreaSolid(rectangle(dx, dy), axis(centre, z, x), dir(UP), pos(depth)),
      );
      solids.set(k, h);
    }
    return h;
  };
  const polygonSolid = (outline: readonly IfcVec2[], depth: number) => {
    const ring = [...outline, outline[0]!].map((p) =>
      put(new I.IfcCartesianPoint([len(p[0]), len(p[1])])),
    );
    const curve = put(new I.IfcPolyline(ring));
    const profile = put(new I.IfcArbitraryClosedProfileDef(I.IfcProfileTypeEnum.AREA, null, curve));
    return put(new I.IfcExtrudedAreaSolid(profile, axis([0, 0, 0]), dir(UP), pos(depth)));
  };

  // Contexts and units.
  const origin = axis([0, 0, 0]);
  const world = put(
    new I.IfcGeometricRepresentationContext(
      null,
      label('Model'),
      new I.IfcDimensionCount(3),
      new I.IfcReal(1e-5),
      origin,
      null,
    ),
  );
  const body = put(
    new I.IfcGeometricRepresentationSubContext(
      label('Body'),
      label('Model'),
      world,
      null,
      I.IfcGeometricProjectionEnum.MODEL_VIEW,
      null,
    ),
  );
  const shape = (items: Handle<WebIfc.IFC4.IfcRepresentationItem>[]) => {
    if (items.length === 0) return null;
    spend(items.length);
    const rep = put(new I.IfcShapeRepresentation(body, label('Body'), label('SweptSolid'), items));
    return put(new I.IfcProductDefinitionShape(null, null, [rep]));
  };

  const metre = (prefix: WebIfc.IFC4.IfcSIPrefix | null) =>
    put(new I.IfcSIUnit(I.IfcUnitEnum.LENGTHUNIT, prefix, I.IfcSIUnitName.METRE));
  let lengthUnit: Handle<WebIfc.IFC4.IfcNamedUnit>;
  if (b.unit === 'mm') lengthUnit = metre(I.IfcSIPrefix.MILLI);
  else if (b.unit === 'cm') lengthUnit = metre(I.IfcSIPrefix.CENTI);
  else if (b.unit === 'm') lengthUnit = metre(null);
  else {
    const [one, zero] = [new I.IfcInteger(1), new I.IfcInteger(0)];
    const exponents = put(new I.IfcDimensionalExponents(one, zero, zero, zero, zero, zero, zero));
    const factor = put(new I.IfcMeasureWithUnit(new I.IfcLengthMeasure(mm / 1000), metre(null)));
    lengthUnit = put(
      new I.IfcConversionBasedUnit(
        exponents,
        I.IfcUnitEnum.LENGTHUNIT,
        label(b.unit === 'ft' ? 'FOOT' : 'INCH'),
        factor,
      ),
    );
  }
  const radian = put(new I.IfcSIUnit(I.IfcUnitEnum.PLANEANGLEUNIT, null, I.IfcSIUnitName.RADIAN));
  const units = put(new I.IfcUnitAssignment([lengthUnit, radian]));

  // The spatial structure.
  const project = put(
    new I.IfcProject(
      await gid('project'),
      null,
      label(projectName),
      null,
      null,
      null,
      null,
      [world],
      units,
    ),
  );
  const sitePlacement = put(new I.IfcLocalPlacement(null, origin));
  const site = put(
    new I.IfcSite(
      await gid('site'),
      null,
      label('Site'),
      null,
      null,
      sitePlacement,
      null,
      null,
      I.IfcElementCompositionEnum.ELEMENT,
      null,
      null,
      null,
      null,
      null,
    ),
  );
  const buildingPlacement = put(new I.IfcLocalPlacement(sitePlacement, origin));
  const building = put(
    new I.IfcBuilding(
      await gid('building'),
      null,
      label(b.buildingName ?? projectName),
      null,
      null,
      buildingPlacement,
      null,
      null,
      I.IfcElementCompositionEnum.ELEMENT,
      null,
      null,
      null,
    ),
  );
  const aggregate = async (
    keyOf: string,
    whole: Handle<WebIfc.IFC4.IfcObjectDefinition>,
    parts: Handle<WebIfc.IFC4.IfcObjectDefinition>[],
  ) => {
    if (parts.length > 0) {
      spend(parts.length);
      put(new I.IfcRelAggregates(await gid(`aggregates:${keyOf}`), null, null, null, whole, parts));
    }
  };
  await aggregate('project', project, [site]);
  await aggregate('site', site, [building]);

  interface Storey {
    handle: Handle<WebIfc.IFC4.IfcBuildingStorey>;
    elevation: number;
    placement: Handle<WebIfc.IFC4.IfcLocalPlacement>;
    contains: Handle<WebIfc.IFC4.IfcProduct>[];
  }
  const storeys = new Map<string, Storey>();
  const storeyHandles: Handle<WebIfc.IFC4.IfcBuildingStorey>[] = [];
  for (const l of b.levels) {
    const placement = put(new I.IfcLocalPlacement(buildingPlacement, axis([0, 0, l.elevation])));
    const handle = put(
      new I.IfcBuildingStorey(
        await gid(`level:${l.id}`),
        null,
        label(l.name),
        null,
        null,
        placement,
        null,
        null,
        I.IfcElementCompositionEnum.ELEMENT,
        len(l.elevation),
      ),
    );
    storeyHandles.push(handle);
    storeys.set(l.id, { handle, elevation: l.elevation, placement, contains: [] });
  }
  await aggregate('building', building, storeyHandles);

  // Members, grouped by the element they are parts of (a wall, floor or roof).
  const walls = b.walls ?? [];
  const openings = b.openings ?? [];
  const hostOf = new Map<string, string>();
  for (const w of walls) hostOf.set(w.id, w.id);
  for (const o of openings) hostOf.set(o.id, o.wall);
  for (const f of b.floors ?? []) hostOf.set(f.id, f.id);
  for (const r of b.roofs ?? []) hostOf.set(r.id, r.id);
  const membersOf = new Map<string, IfcMemberInput[]>();
  for (const m of b.members ?? []) {
    const host = hostOf.get(m.owner)!;
    let list = membersOf.get(host);
    if (!list) membersOf.set(host, (list = []));
    list.push(m);
  }

  const placed = (storey: Storey, p: IfcPlaneInput) =>
    put(
      new I.IfcLocalPlacement(
        storey.placement,
        axis(add(p.origin, [0, 0, -storey.elevation]), cross(p.x, p.y), p.x),
      ),
    );

  const writeMembers = async (host: string, storey: Storey) => {
    const out: Handle<WebIfc.IFC4.IfcElement>[] = [];
    for (const m of membersOf.get(host) ?? []) {
      const full = `${m.owner}:${m.id}`;
      const cls = memberClass(m.role);
      const solid = box([0, 0, 0], [1, 0, 0], [0, 1, 0], m.stock.width, m.stock.depth, m.length);
      const args = [
        await gid(`member:${full}`),
        null,
        label(`${m.stock.name} ${m.role}`),
        null,
        cls.type === 'USERDEFINED' ? label(m.role) : null,
        placed(storey, m.placement),
        shape([solid]),
        ident(full),
      ] as const;
      out.push(
        cls.entity === 'member'
          ? put(new I.IfcMember(...args, I.IfcMemberTypeEnum[cls.type]))
          : put(new I.IfcBeam(...args, I.IfcBeamTypeEnum[cls.type])),
      );
    }
    return out;
  };

  // Walls, their layers and openings.
  const openingsOf = new Map<string, IfcOpeningInput[]>();
  for (const o of openings) {
    let list = openingsOf.get(o.wall);
    if (!list) openingsOf.set(o.wall, (list = []));
    list.push(o);
  }
  for (const w of walls) {
    const storey = storeys.get(w.level)!;
    const segs = segments(w);
    const layers = w.layers ?? [];
    const framing = layers.find((l) => l.kind === 'framing');
    const band: readonly [number, number] = framing
      ? framing.t
      : layers.length > 0
        ? [Math.min(...layers.map((l) => l.t[0])), Math.max(...layers.map((l) => l.t[1]))]
        : [0, w.thickness];
    const outer: readonly [number, number] = [
      Math.min(band[0], ...layers.map((l) => l.t[0])),
      Math.max(band[1], ...layers.map((l) => l.t[1])),
    ];
    const placement = put(
      new I.IfcLocalPlacement(storey.placement, axis([0, 0, w.base - storey.elevation])),
    );
    const own = openingsOf.get(w.id) ?? [];
    const holes = (s: number): FaceRect[] =>
      own
        .filter((o) => o.segment === s + 1)
        .map((o) => ({
          x0: o.position - o.width / 2,
          x1: o.position + o.width / 2,
          z0: o.sill,
          z1: o.sill + o.height,
        }));

    const parts: Handle<WebIfc.IFC4.IfcElement>[] = await writeMembers(w.id, storey);
    // Each segment's face less its openings, once for all the wall's layers.
    const faces = new Map<number, FaceRect[]>();
    const faceOf = (i: number, s: Segment) => {
      let rects = faces.get(i);
      if (!rects) faces.set(i, (rects = faceRects(s.length, w.height, holes(i))));
      return rects;
    };
    for (const l of layers) {
      if (l.kind === 'framing') continue;
      const items: Handle<WebIfc.IFC4.IfcRepresentationItem>[] = [];
      segs.forEach((s, i) => {
        for (const r of faceOf(i, s)) {
          const corner = add(add(add(s.a, scale(s.d, r.x0)), scale(s.n, l.t[1])), [0, 0, r.z0]);
          items.push(box(corner, scale(s.n, -1), s.d, r.x1 - r.x0, r.z1 - r.z0, l.t[1] - l.t[0]));
        }
      });
      const rep = shape(items);
      if (rep === null) continue;
      const lp = put(new I.IfcLocalPlacement(placement, origin));
      const args = [
        await gid(`layer:${w.id}/${l.id}`),
        null,
        label(`${w.name ?? w.id} ${l.kind}`),
        null,
        null,
        lp,
        rep,
        ident(`${w.id}/${l.id}`),
      ] as const;
      parts.push(
        l.kind === 'sheathing'
          ? put(new I.IfcPlate(...args, I.IfcPlateTypeEnum.SHEET))
          : put(new I.IfcCovering(...args, I.IfcCoveringTypeEnum.CLADDING)),
      );
    }

    const bodyItems =
      parts.length > 0
        ? []
        : segs.map((s) =>
            box(add(s.a, scale(s.n, band[0])), UP, s.d, s.length, band[1] - band[0], w.height),
          );
    const wall = put(
      new I.IfcWall(
        await gid(`wall:${w.id}`),
        null,
        label(w.name ?? w.id),
        null,
        null,
        placement,
        shape(bodyItems),
        ident(w.id),
        parts.length > 0 ? I.IfcWallTypeEnum.ELEMENTEDWALL : I.IfcWallTypeEnum.STANDARD,
      ),
    );
    storey.contains.push(wall);
    await aggregate(`wall:${w.id}`, wall, parts);

    // Openings: a box through every layer, and a door or window panel in the framing band.
    const margin = 10;
    for (const o of own) {
      const s = segs[o.segment - 1]!;
      const at = (t: number) =>
        add(add(add(s.a, scale(s.d, o.position - o.width / 2)), scale(s.n, t)), [0, 0, o.sill]);
      const void_ = box(
        at(outer[0] - margin),
        UP,
        s.d,
        o.width,
        outer[1] - outer[0] + 2 * margin,
        o.height,
      );
      const opening = put(
        new I.IfcOpeningElement(
          await gid(`opening:${o.id}`),
          null,
          label(o.name ?? o.id),
          null,
          null,
          put(new I.IfcLocalPlacement(placement, origin)),
          shape([void_]),
          ident(o.id),
          I.IfcOpeningElementTypeEnum.OPENING,
        ),
      );
      put(new I.IfcRelVoidsElement(await gid(`voids:${o.id}`), null, null, null, wall, opening));
      if (o.type === 'opening') continue;
      const panel = Math.min(50, band[1] - band[0]);
      const mid = (band[0] + band[1]) / 2;
      const fillRep = shape([box(at(mid - panel / 2), UP, s.d, o.width, panel, o.height)]);
      const fillArgs = [
        await gid(`fill:${o.id}`),
        null,
        label(o.name ?? o.id),
        null,
        null,
        put(new I.IfcLocalPlacement(placement, origin)),
        fillRep,
        ident(o.id),
        pos(o.height),
        pos(o.width),
      ] as const;
      const fill =
        o.type === 'door'
          ? put(
              new I.IfcDoor(
                ...fillArgs,
                I.IfcDoorTypeEnum.DOOR,
                I.IfcDoorTypeOperationEnum.NOTDEFINED,
                null,
              ),
            )
          : put(
              new I.IfcWindow(
                ...fillArgs,
                I.IfcWindowTypeEnum.WINDOW,
                I.IfcWindowTypePartitioningEnum.NOTDEFINED,
                null,
              ),
            );
      put(new I.IfcRelFillsElement(await gid(`fills:${o.id}`), null, null, null, opening, fill));
      storey.contains.push(fill);
    }
  }

  // Floors: the subfloor as the slab, the floor's members its parts.
  for (const f of b.floors ?? []) {
    const storey = storeys.get(f.level)!;
    const placement = put(
      new I.IfcLocalPlacement(
        storey.placement,
        axis([0, 0, f.top - (f.thickness ?? 0) - storey.elevation]),
      ),
    );
    const slab = put(
      new I.IfcSlab(
        await gid(`floor:${f.id}`),
        null,
        label(f.name ?? f.id),
        null,
        null,
        placement,
        shape(f.thickness === undefined ? [] : [polygonSolid(f.outline, f.thickness)]),
        ident(f.id),
        I.IfcSlabTypeEnum.FLOOR,
      ),
    );
    storey.contains.push(slab);
    await aggregate(`floor:${f.id}`, slab, await writeMembers(f.id, storey));
  }

  // Roofs: no body of their own; their members and sheathing sheets are their parts.
  const roofKinds = {
    gable: I.IfcRoofTypeEnum.GABLE_ROOF,
    hip: I.IfcRoofTypeEnum.HIP_ROOF,
    shed: I.IfcRoofTypeEnum.SHED_ROOF,
    flat: I.IfcRoofTypeEnum.FLAT_ROOF,
  };
  for (const r of b.roofs ?? []) {
    const storey = storeys.get(r.level)!;
    const roof = put(
      new I.IfcRoof(
        await gid(`roof:${r.id}`),
        null,
        label(r.name ?? r.id),
        null,
        null,
        put(new I.IfcLocalPlacement(storey.placement, origin)),
        null,
        ident(r.id),
        r.kind ? roofKinds[r.kind] : I.IfcRoofTypeEnum.NOTDEFINED,
      ),
    );
    storey.contains.push(roof);
    const parts: Handle<WebIfc.IFC4.IfcElement>[] = await writeMembers(r.id, storey);
    for (const s of r.sheets ?? []) {
      parts.push(
        put(
          new I.IfcPlate(
            await gid(`sheet:${r.id}/${s.id}`),
            null,
            label(`${r.name ?? r.id} sheathing`),
            null,
            null,
            placed(storey, s.placement),
            shape([polygonSolid(s.outline, s.thickness)]),
            ident(`${r.id}/${s.id}`),
            I.IfcPlateTypeEnum.SHEET,
          ),
        ),
      );
    }
    await aggregate(`roof:${r.id}`, roof, parts);
  }

  for (const l of b.levels) {
    const storey = storeys.get(l.id)!;
    if (storey.contains.length === 0) continue;
    spend(storey.contains.length);
    put(
      new I.IfcRelContainedInSpatialStructure(
        await gid(`contains:${l.id}`),
        null,
        null,
        null,
        storey.contains,
        storey.handle,
      ),
    );
  }
  return entities;
}
