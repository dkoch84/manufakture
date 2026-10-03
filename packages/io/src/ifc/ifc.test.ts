import * as WebIfc from 'web-ifc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IFC_GUID_PATTERN, compressGuid, expandGuid, ifcGlobalId } from './guid';
import {
  IfcExportError,
  MAX_IFC_ID,
  MAX_IFC_MEMBERS,
  MAX_IFC_OPENINGS_PER_SEGMENT,
  checkIfcBuilding,
  isWellFormed,
  type IfcBuildingInput,
  type IfcMemberInput,
  type IfcOpeningInput,
} from './model';
import { MAX_IFC_HEADER_STRING, MAX_IFC_LABEL, ifcHeaderStrings, ifcString } from './strings';
import { TEST_DISCLAIMER, blankCorners, testBuilding } from './test-building';
import { faceRects, memberClass, writeIfc } from './writer';

// Reading back -----------------------------------------------------------------------------------

let api: WebIfc.IfcAPI;
const open: number[] = [];

beforeAll(async () => {
  api = new WebIfc.IfcAPI();
  await api.Init(undefined, true);
  api.SetLogLevel(WebIfc.LogLevel.LOG_LEVEL_OFF);
});

afterAll(() => {
  for (const m of open) api.CloseModel(m);
});

function read(bytes: Uint8Array): number {
  const m = api.OpenModel(bytes);
  open.push(m);
  return m;
}

const ids = (m: number, type: number): number[] => {
  const v = api.GetLineIDsWithType(m, type);
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
};
const count = (m: number, type: number) => ids(m, type).length;
const lines = (m: number, type: number) => ids(m, type).map((id) => api.GetLine(m, id));

/** Every rooted entity's GlobalId, by its type and express id (the files are written in order). */
function globalIds(m: number): Map<string, string> {
  const out = new Map<string, string>();
  const all = api.GetAllLines(m);
  for (let i = 0; i < all.size(); i++) {
    const id = all.get(i);
    const line = api.GetLine(m, id);
    if (line?.GlobalId === undefined) continue;
    out.set(`${api.GetNameFromTypeCode(line.type)}#${id}`, line.GlobalId.value);
  }
  return out;
}

const TYPES = {
  wall: WebIfc.IFCWALL,
  opening: WebIfc.IFCOPENINGELEMENT,
  door: WebIfc.IFCDOOR,
  window: WebIfc.IFCWINDOW,
  member: WebIfc.IFCMEMBER,
  beam: WebIfc.IFCBEAM,
  plate: WebIfc.IFCPLATE,
  covering: WebIfc.IFCCOVERING,
  slab: WebIfc.IFCSLAB,
  roof: WebIfc.IFCROOF,
  storey: WebIfc.IFCBUILDINGSTOREY,
  building: WebIfc.IFCBUILDING,
  site: WebIfc.IFCSITE,
  project: WebIfc.IFCPROJECT,
};

function counts(m: number): Record<keyof typeof TYPES, number> {
  return Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, count(m, t)])) as Record<
    keyof typeof TYPES,
    number
  >;
}

const fullId = (x: { owner: string; id: string }) => `${x.owner}:${x.id}`;

/**
 * The largest distance, mm, between a member's mesh bounding box as web-ifc reads it back
 * (metres, Y up) and its blank's.
 */
function worstPlacement(model: number, members: readonly IfcMemberInput[]): number {
  const byTag = new Map(
    [...ids(model, WebIfc.IFCMEMBER), ...ids(model, WebIfc.IFCBEAM)].map((id) => [
      api.GetLine(model, id).Tag.value as string,
      id,
    ]),
  );
  let worst = 0;
  for (const m of members) {
    const mesh = api.GetFlatMesh(model, byTag.get(fullId(m))!);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let g = 0; g < mesh.geometries.size(); g++) {
      const pg = mesh.geometries.get(g);
      const t = pg.flatTransformation;
      const geo = api.GetGeometry(model, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      for (let i = 0; i < v.length; i += 6) {
        const [x, y, z] = [v[i]!, v[i + 1]!, v[i + 2]!];
        const w = [0, 1, 2].map((r) => t[r]! * x + t[4 + r]! * y + t[8 + r]! * z + t[12 + r]!);
        const p = [w[0]! * 1000, -w[2]! * 1000, w[1]! * 1000];
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k]!, p[k]!);
          hi[k] = Math.max(hi[k]!, p[k]!);
        }
      }
      geo.delete();
    }
    const c = blankCorners(m);
    for (let k = 0; k < 3; k++) {
      const want = [Math.min(...c.map((p) => p[k]!)), Math.max(...c.map((p) => p[k]!))];
      worst = Math.max(worst, Math.abs(lo[k]! - want[0]!), Math.abs(hi[k]! - want[1]!));
    }
  }
  return worst;
}

// Units -------------------------------------------------------------------------------------------

describe('ifcString', () => {
  it('turns controls into spaces, drops bidirectional controls, replaces astral and lone surrogates', () => {
    expect(ifcString('a\u0000b\nc\u0085d')).toBe('a b c d');
    expect(ifcString('in‮voice')).toBe('invoice');
    expect(ifcString('\u{1D11E}x')).toBe('�x');
    expect(ifcString('a\ud800b\udc00c')).toBe('a�b�c');
    expect(ifcString("it's a \\ path ü€")).toBe("it's a \\ path ü€");
  });

  it('caps the length and reads no further than it needs', () => {
    expect(ifcString('x'.repeat(10_000))).toHaveLength(MAX_IFC_LABEL);
    expect(ifcString('x'.repeat(10_000), 5)).toBe('xxxxx');
    // Bidirectional controls do not count towards the cap, but they are not read forever either.
    expect(ifcString('‮'.repeat(1e6) + 'tail', 3)).toBe('');
  });

  it('splits header text into strings of at most 255 characters at spaces', () => {
    const parts = ifcHeaderStrings(`${'word '.repeat(120)}end`);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_IFC_HEADER_STRING);
    expect(parts.join(' ')).toBe(`${'word '.repeat(120)}end`);
    expect(ifcHeaderStrings('x'.repeat(1e6)).length).toBe(8);
  });
});

describe('GlobalIds', () => {
  it('compress 128 bits into 22 characters and back', () => {
    expect(compressGuid(new Uint8Array(16))).toBe('0000000000000000000000');
    expect(compressGuid(new Uint8Array(16).fill(255))).toBe('3$$$$$$$$$$$$$$$$$$$$$');
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
    expect(expandGuid(compressGuid(bytes))).toEqual(bytes);
  });

  it('derive from the document and the key, deterministically', async () => {
    const a = await ifcGlobalId('doc', 'wall:extension#2');
    expect(a).toMatch(IFC_GUID_PATTERN);
    expect(await ifcGlobalId('doc', 'wall:extension#2')).toBe(a);
    expect(await ifcGlobalId('doc', 'wall:extension#3')).not.toBe(a);
    expect(await ifcGlobalId('doc2', 'wall:extension#2')).not.toBe(a);
    // Length prefixes: moving characters between the two parts changes the id.
    expect(await ifcGlobalId('ab', 'c')).not.toBe(await ifcGlobalId('a', 'bc'));
    // A version 8, RFC 9562 variant UUID.
    const bytes = expandGuid(a);
    expect(bytes[6]! >> 4).toBe(8);
    expect(bytes[8]! >> 6).toBe(2);
  });
});

describe('faceRects', () => {
  it('is the whole face without holes', () => {
    expect(faceRects(100, 50, [])).toEqual([{ x0: 0, x1: 100, z0: 0, z1: 50 }]);
  });

  it('leaves out a door at the base and a window above it, with no overlap and the right area', () => {
    const holes = [
      { x0: 10, x1: 30, z0: 0, z1: 40 },
      { x0: 60, x1: 80, z0: 20, z1: 35 },
      { x0: 70, x1: 120, z0: 30, z1: 45 }, // past the end: clipped
    ];
    const rects = faceRects(100, 50, holes);
    const area = rects.reduce((a, r) => a + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
    // 100 x 50, less 20 x 40, less the union of the two windows (20 x 15 + 30 x 15 - 10 x 5).
    expect(area).toBeCloseTo(5000 - 800 - (300 + 450 - 50), 9);
    const inside = (x: number, z: number) =>
      rects.filter((r) => r.x0 < x && x < r.x1 && r.z0 < z && z < r.z1).length;
    expect(inside(20, 10)).toBe(0);
    expect(inside(75, 32)).toBe(0);
    expect(inside(5, 5)).toBe(1);
    expect(inside(20, 45)).toBe(1);
  });
});

describe('memberClass', () => {
  it('maps framing roles to IFC member and beam types', () => {
    expect(memberClass('stud')).toEqual({ entity: 'member', type: 'STUD' });
    expect(memberClass('top-plate')).toEqual({ entity: 'member', type: 'PLATE' });
    expect(memberClass('common-rafter')).toEqual({ entity: 'member', type: 'RAFTER' });
    expect(memberClass('joist')).toEqual({ entity: 'beam', type: 'JOIST' });
    expect(memberClass('header')).toEqual({ entity: 'beam', type: 'LINTEL' });
    expect(memberClass('ridge')).toEqual({ entity: 'beam', type: 'USERDEFINED' });
    expect(memberClass('blocking')).toEqual({ entity: 'member', type: 'USERDEFINED' });
    expect(memberClass('__proto__')).toEqual({ entity: 'member', type: 'USERDEFINED' });
  });
});

// Checks -----------------------------------------------------------------------------------------

describe('checkIfcBuilding', () => {
  const base = testBuilding();
  const member = base.members![0]!;
  const bad: [string, (b: IfcBuildingInput) => IfcBuildingInput][] = [
    ['no levels', (b) => ({ ...b, levels: [] })],
    ['no disclaimer', (b) => ({ ...b, disclaimer: ' ' })],
    ['an unknown unit', (b) => ({ ...b, unit: 'yd' as never })],
    ['a long document id', (b) => ({ ...b, documentId: 'x'.repeat(MAX_IFC_ID + 1) })],
    ['an ill-formed document id', (b) => ({ ...b, documentId: 'doc\ud800' })],
    ['an ill-formed member id', (b) => ({ ...b, members: [{ ...member, id: 's\udc00' }] })],
    ['an ill-formed wall id', (b) => ({ ...b, walls: [{ ...b.walls![0]!, id: '\udbffw' }] })],
    [
      'a level name that is not text',
      (b) => ({ ...b, levels: [{ id: 'level-1', name: 7 as never, elevation: 0 }] }),
    ],
    ['a building name that is not text', (b) => ({ ...b, buildingName: {} as never })],
    [
      'a wall name that is not text',
      (b) => ({ ...b, walls: [{ ...b.walls![0]!, name: [] as never }] }),
    ],
    ['a NaN elevation', (b) => ({ ...b, levels: [{ id: 'level-1', name: 'L', elevation: NaN }] })],
    ['a wall on no level', (b) => ({ ...b, walls: [{ ...b.walls![0]!, level: 'nope' }] })],
    [
      'a zero-length segment',
      (b) => ({
        ...b,
        walls: [
          {
            ...b.walls![0]!,
            points: [
              [0, 0],
              [0, 0],
            ],
          },
        ],
      }),
    ],
    ['a huge height', (b) => ({ ...b, walls: [{ ...b.walls![0]!, height: 1e12 }] })],
    ['two walls with one id', (b) => ({ ...b, walls: [b.walls![0]!, b.walls![0]!] })],
    [
      'an opening on segment 2 of 1',
      (b) => ({ ...b, openings: [{ ...b.openings![0]!, segment: 2 }] }),
    ],
    ['an opening on no wall', (b) => ({ ...b, openings: [{ ...b.openings![0]!, wall: 'nope' }] })],
    ['a member of no owner', (b) => ({ ...b, members: [{ ...member, owner: 'nope' }] })],
    ['a member twice', (b) => ({ ...b, members: [member, member] })],
    [
      'a skewed placement',
      (b) => ({
        ...b,
        members: [{ ...member, placement: { ...member.placement, y: member.placement.x } }],
      }),
    ],
    [
      'an infinite origin',
      (b) => ({
        ...b,
        members: [{ ...member, placement: { ...member.placement, origin: [Infinity, 0, 0] } }],
      }),
    ],
    [
      'a zero stock',
      (b) => ({ ...b, members: [{ ...member, stock: { ...member.stock, width: 0 } }] }),
    ],
    [
      'too many members',
      (b) => ({ ...b, members: { length: MAX_IFC_MEMBERS + 1 } as unknown as IfcMemberInput[] }),
    ],
  ];

  it('accepts the test building', () => {
    expect(() => checkIfcBuilding(base)).not.toThrow();
  });

  it.each(bad)('refuses %s', (_, change) => {
    expect(() => checkIfcBuilding(change(base))).toThrow(IfcExportError);
  });

  it('refuses ids that are not well-formed text, which would share a GlobalId', async () => {
    // TextEncoder turns every lone surrogate into U+FFFD: the hash cannot tell them apart.
    expect(await ifcGlobalId('doc', 'a\ud800')).toBe(await ifcGlobalId('doc', 'a\udbff'));
    expect(isWellFormed('a\ud800')).toBe(false);
    expect(isWellFormed('a\udc00b')).toBe(false);
    expect(isWellFormed('\u{1F600}')).toBe(true);
    expect(isWellFormed('plain')).toBe(true);
    const twins = {
      ...base,
      members: [
        { ...member, id: 'a\ud800' },
        { ...member, id: 'a\udbff' },
      ],
    };
    expect(() => checkIfcBuilding(twins)).toThrow(/not well-formed/);
  });

  it('refuses a too-long member list before reading it', () => {
    // A list-like object, so a check that read the members first would throw a TypeError.
    const b = { ...base, members: Object.assign([], { length: MAX_IFC_MEMBERS + 1 }) };
    expect(() => checkIfcBuilding(b)).toThrow(/at most 200000/);
  });
});

// The test building --------------------------------------------------------------------------

describe('writeIfc: the test building', () => {
  let bytes: Uint8Array;
  let model: number;
  let members: readonly IfcMemberInput[];

  beforeAll(async () => {
    const b = testBuilding();
    members = b.members!;
    bytes = await writeIfc(b);
    model = read(bytes);
  });

  it('writes IFC4 ASCII text with the disclaimer in the header', () => {
    expect(bytes.every((b) => b === 0x0a || (b >= 0x20 && b <= 0x7e))).toBe(true);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'));");
    const header = text.slice(0, text.indexOf('ENDSEC;'));
    expect(header).toContain(TEST_DISCLAIMER);
    expect(header).toContain('ReferenceView');
  });

  it('has one element per wall, opening, floor and roof, and one per member', () => {
    const asMember = members.filter((m) => memberClass(m.role).entity === 'member');
    const asBeam = members.filter((m) => memberClass(m.role).entity === 'beam');
    expect([asMember.length, asBeam.length]).toEqual([21, 4]);
    expect(counts(model)).toEqual({
      project: 1,
      site: 1,
      building: 1,
      storey: 1,
      wall: 2,
      opening: 2,
      door: 1,
      window: 1,
      member: asMember.length,
      beam: asBeam.length,
      plate: 2 + 1, // wall sheathing, the roof sheet
      covering: 1, // drywall
      slab: 1,
      roof: 1,
    });
  });

  it('tags every member with its full id and types it by role', () => {
    const elements = [...lines(model, WebIfc.IFCMEMBER), ...lines(model, WebIfc.IFCBEAM)];
    expect(elements.map((e) => e.Tag.value).sort()).toEqual(members.map(fullId).sort());
    const byTag = new Map(elements.map((e) => [e.Tag.value as string, e]));
    for (const m of members) {
      const e = byTag.get(fullId(m))!;
      const cls = memberClass(m.role);
      expect(e.PredefinedType.value).toBe(cls.type);
      expect(e.ObjectType?.value ?? null).toBe(cls.type === 'USERDEFINED' ? m.role : null);
    }
  });

  it('places every member where its blank is (web-ifc reads it back in metres, Y up)', () => {
    expect(worstPlacement(model, members)).toBeLessThan(0.01);
  });

  it('voids each wall with its openings and fills them with the door and windows', () => {
    const walls = new Map(ids(model, WebIfc.IFCWALL).map((id) => [id, api.GetLine(model, id)]));
    const voids = lines(model, WebIfc.IFCRELVOIDSELEMENT);
    expect(voids.map((r) => walls.get(r.RelatingBuildingElement.value).Tag.value)).toEqual([
      'wall-a',
      'wall-a',
    ]);
    expect(lines(model, WebIfc.IFCRELFILLSELEMENT)).toHaveLength(2);
    const door = lines(model, WebIfc.IFCDOOR)[0];
    expect(door.OverallWidth.value).toBeCloseTo(900, 9);
    expect(door.OverallHeight.value).toBeCloseTo(2050, 9);
  });

  it('makes framing members, sheathing and drywall parts of their wall, floor and roof', () => {
    const tagOf = (id: number) => api.GetLine(model, id).Tag?.value as string | undefined;
    const partsOf = new Map<string, number>();
    for (const r of lines(model, WebIfc.IFCRELAGGREGATES)) {
      const whole = tagOf(r.RelatingObject.value);
      if (whole !== undefined) partsOf.set(whole, r.RelatedObjects.length);
    }
    // Wall A: 10 studs, a plate, the door's header, sheathing. Wall B: 8 studs, two layers.
    expect(Object.fromEntries(partsOf)).toEqual({ 'wall-a': 13, 'wall-b': 10, floor: 2, roof: 4 });
    const contained = lines(model, WebIfc.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    expect(contained).toHaveLength(1);
    expect(contained[0].RelatedElements).toHaveLength(2 + 1 + 1 + 1 + 1);
  });

  it('meshes every product web-ifc knows how to read', () => {
    let meshes = 0;
    api.StreamAllMeshes(model, () => meshes++);
    // Members; three wall layers; door and window; the slab; the roof sheet. Walls with parts and
    // the roof have no body of their own; openings are voids.
    expect(meshes).toBe(members.length + 3 + 2 + 1 + 1);
  });
});

describe('writeIfc: GlobalIds', () => {
  it('are the same when the same document is exported twice', async () => {
    const a = globalIds(read(await writeIfc(testBuilding())));
    const b = globalIds(read(await writeIfc(testBuilding())));
    expect(a.size).toBeGreaterThan(40);
    expect(b).toEqual(a);
    const values = [...a.values()];
    expect(new Set(values).size).toBe(values.length);
    for (const g of values) expect(g).toMatch(IFC_GUID_PATTERN);
  });

  it('differ between documents', async () => {
    const a = new Set(globalIds(read(await writeIfc(testBuilding('B', 'doc-a')))).values());
    const b = [...globalIds(read(await writeIfc(testBuilding('B', 'doc-b')))).values()];
    expect(b.filter((g) => a.has(g))).toEqual([]);
  });
});

describe('writeIfc: units', () => {
  it('writes feet as a conversion-based unit and millimetres as an SI unit', async () => {
    const ft = read(await writeIfc({ ...testBuilding(), unit: 'ft' }));
    const unit = lines(ft, WebIfc.IFCCONVERSIONBASEDUNIT)[0];
    expect(unit.Name.value).toBe('FOOT');
    const factor = api.GetLine(ft, unit.ConversionFactor.value);
    expect(factor.ValueComponent.value).toBeCloseTo(0.3048, 12);

    const mm = read(await writeIfc(testBuilding()));
    expect(count(mm, WebIfc.IFCCONVERSIONBASEDUNIT)).toBe(0);
    const si = lines(mm, WebIfc.IFCSIUNIT).find((u) => u.UnitType.value === 'LENGTHUNIT');
    expect(si.Prefix.value).toBe('MILLI');
    expect(si.Name.value).toBe('METRE');
    const door = (m: number) => lines(m, WebIfc.IFCDOOR)[0].OverallWidth.value as number;
    expect(door(mm)).toBeCloseTo(door(ft) * 304.8, 6);
  });
});

describe('writeIfc: document text cannot add entities', () => {
  const hostile =
    "x');#999=IFCWALL('0000000000000000000000',$,$,$,$,$,$,$,$);\n#1000=IFCWALL($);/*\\X0\\" +
    '\ud800\u{1F600}‮';

  it('writes hostile names as plain text', async () => {
    const plain = testBuilding();
    const named = testBuilding(hostile);
    const walls = named.walls!.map((w) => ({ ...w, name: hostile }));
    const openings = named.openings!.map((o) => ({ ...o, name: hostile }));
    const levels = [{ id: 'level-1', name: hostile, elevation: 0 }];
    const members = named.members!.map((m) => ({
      ...m,
      role: m.role,
      stock: { ...m.stock, name: hostile },
    }));
    const building = {
      ...named,
      disclaimer: `${TEST_DISCLAIMER} ${hostile}`,
      walls,
      openings,
      levels,
      members,
    };
    const a = read(await writeIfc(plain));
    const bytes = await writeIfc(building);
    const b = read(bytes);
    expect(counts(b)).toEqual(counts(a));
    expect(api.GetAllLines(b).size()).toBe(api.GetAllLines(a).size());
    const expected = ifcString(hostile);
    expect(lines(b, WebIfc.IFCPROJECT)[0].Name.value).toBe(expected);
    expect(lines(b, WebIfc.IFCBUILDINGSTOREY)[0].Name.value).toBe(expected);
    for (const w of lines(b, WebIfc.IFCWALL)) expect(w.Name.value).toBe(expected);
    const text = new TextDecoder().decode(bytes);
    // The text is there, inside a string, never at the start of a line.
    expect(text).toContain("x'');#999=IFCWALL(");
    expect(text).not.toMatch(/^#(999|1000)=/m);
    expect(bytes.every((x) => x === 0x0a || (x >= 0x20 && x <= 0x7e))).toBe(true);
  });
});

describe('writeIfc: the work budget', () => {
  /**
   * A small document that passes every count: one wall of a few segments, the most openings a
   * segment may hold (nested, so every strip of the face is cut many times) and the most layers,
   * all the same (so nearly every box is a cache hit). Without the budget its layers alone would
   * be millions of boxes.
   */
  function hostile(segments: number): IfcBuildingInput {
    const b = testBuilding();
    const L = 10_000;
    const wall = {
      ...b.walls![1]!,
      points: Array.from({ length: segments + 1 }, (_, i) => [i * L, 0] as const),
      layers: [
        { id: 'framing', kind: 'framing' as const, t: [0, 89] as const },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `d${i}`,
          kind: 'drywall' as const,
          t: [89, 102] as const,
        })),
      ],
    };
    const openings: IfcOpeningInput[] = [];
    for (let s = 1; s <= segments; s++) {
      for (let i = 0; i < MAX_IFC_OPENINGS_PER_SEGMENT; i++) {
        openings.push({
          id: `o${s}-${i}`,
          wall: wall.id,
          type: 'opening',
          segment: s,
          position: L / 2,
          width: 10 + 40 * i,
          height: 5,
          sill: 10 * i,
        });
      }
    }
    return { ...b, walls: [wall], openings, members: [], floors: [], roofs: [] };
  }

  it('refuses a small document whose geometry multiplies past it, quickly', async () => {
    const b = hostile(3);
    expect(() => checkIfcBuilding(b)).not.toThrow();
    const t0 = performance.now();
    await expect(writeIfc(b)).rejects.toThrow(/too large to export as IFC/);
    expect(performance.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  it('counts repeated geometry: every box and every reference, cached or not', async () => {
    // One segment: 600 entities or so of distinct geometry, but 15 layers referencing it.
    const b = hostile(1);
    await expect(writeIfc(b, { maxWork: 100_000 })).rejects.toThrow(/too large/);
    // The test building is far inside the default budget.
    await expect(writeIfc(testBuilding(), { maxWork: 2_000 })).resolves.toBeInstanceOf(Uint8Array);
  });
});
