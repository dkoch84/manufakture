// The M6 shed, framed by this package's generators (`test-shed.ts`), written by
// `@manufakture/io`'s IFC writer and read back with web-ifc: one element per wall, opening, floor
// and roof and one per member, members typed by role and placed where their blanks are, openings
// voiding their walls, parts aggregated, GlobalIds stable across exports.

import { IFC_GUID_PATTERN, memberClass, writeIfc } from '@manufakture/io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Member } from '../members';
import { fullId, ifcReader, type IfcReader } from './test-ifc-read';
import { SHED_DISCLAIMER, shed } from './test-shed';

let r: IfcReader;

beforeAll(async () => {
  r = await ifcReader();
});

afterAll(() => r.close());

describe('the shed as IFC', () => {
  let bytes: Uint8Array;
  let model: number;
  let members: Member[];

  beforeAll(async () => {
    const s = shed();
    members = s.members;
    bytes = await writeIfc(s.building);
    model = r.read(bytes);
  });

  it('carries the disclaimer in the header', () => {
    const text = new TextDecoder().decode(bytes);
    expect(text.slice(0, text.indexOf('ENDSEC;'))).toContain(SHED_DISCLAIMER);
  });

  it('has one element per wall, opening, floor and roof, and one per member', () => {
    const asMember = members.filter((m) => memberClass(m.role).entity === 'member');
    const asBeam = members.filter((m) => memberClass(m.role).entity === 'beam');
    expect(members.length).toBeGreaterThan(100);
    expect(r.counts(model)).toEqual({
      project: 1,
      site: 1,
      building: 1,
      storey: 1,
      wall: 4,
      opening: 3,
      door: 1,
      window: 2,
      member: asMember.length,
      beam: asBeam.length,
      plate: 4 + 2, // wall sheathing, roof slopes
      covering: 2, // drywall
      slab: 1,
      roof: 1,
    });
  });

  it('tags every member with its full id and types it by role', () => {
    const elements = [...r.lines(model, r.mod.IFCMEMBER), ...r.lines(model, r.mod.IFCBEAM)];
    expect(elements.map((e) => e.Tag.value).sort()).toEqual(members.map(fullId).sort());
    const byTag = new Map(elements.map((e) => [e.Tag.value as string, e]));
    for (const m of members) {
      const cls = memberClass(m.role);
      expect(byTag.get(fullId(m)).PredefinedType.value).toBe(cls.type);
    }
    const types = (t: number) => r.lines(model, t).map((e) => e.PredefinedType.value);
    expect(types(r.mod.IFCMEMBER)).toContain('STUD');
    expect(types(r.mod.IFCMEMBER)).toContain('PLATE');
    expect(types(r.mod.IFCMEMBER)).toContain('RAFTER');
    expect(types(r.mod.IFCBEAM)).toContain('JOIST');
    expect(types(r.mod.IFCBEAM)).toContain('LINTEL');
  });

  it('places every member where its blank is', () => {
    expect(r.worstPlacement(model, members)).toBeLessThan(0.01);
  });

  it('voids the walls with the openings and fills them with the door and windows', () => {
    const walls = new Map(r.ids(model, r.mod.IFCWALL).map((id) => [id, r.api.GetLine(model, id)]));
    const voided = r
      .lines(model, r.mod.IFCRELVOIDSELEMENT)
      .map((v) => walls.get(v.RelatingBuildingElement.value).Tag.value)
      .sort();
    expect(voided).toEqual(['extension#2', 'extension#3', 'extension#3']);
    expect(r.lines(model, r.mod.IFCRELFILLSELEMENT)).toHaveLength(3);
    const door = r.lines(model, r.mod.IFCDOOR)[0];
    expect(door.OverallWidth.value).toBeCloseTo(38 / 12, 9);
  });

  it('makes members, sheathing and drywall parts of their wall, floor and roof', () => {
    const tagOf = (id: number) => r.api.GetLine(model, id).Tag?.value as string | undefined;
    const partsOf = new Map<string, number>();
    for (const a of r.lines(model, r.mod.IFCRELAGGREGATES)) {
      const whole = tagOf(a.RelatingObject.value);
      if (whole !== undefined) partsOf.set(whole, a.RelatedObjects.length);
    }
    const owned = (owners: string[]) => members.filter((m) => owners.includes(m.owner)).length;
    expect(partsOf.get('extension#2')).toBe(owned(['extension#2', 'extension#6']) + 1);
    expect(partsOf.get('extension#3')).toBe(
      owned(['extension#3', 'extension#7', 'extension#8']) + 1,
    );
    expect(partsOf.get('extension#4')).toBe(owned(['extension#4']) + 2);
    expect(partsOf.get('extension#1')).toBe(owned(['extension#1']));
    expect(partsOf.get('extension#20')).toBe(owned(['extension#20']) + 2);
  });

  it('keeps every GlobalId across two exports and changes them for another document', async () => {
    const a = r.globalIds(model);
    const b = r.globalIds(r.read(await writeIfc(shed().building)));
    expect(a.size).toBeGreaterThan(150);
    expect(b).toEqual(a);
    for (const g of a.values()) expect(g).toMatch(IFC_GUID_PATTERN);
    const other = new Set(
      r.globalIds(r.read(await writeIfc(shed('Shed', 'doc-2').building))).values(),
    );
    expect([...a.values()].filter((g) => other.has(g))).toEqual([]);
  });
});
