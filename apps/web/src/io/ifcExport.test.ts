import { applyCommand, createDocument, type ManufaktureDocument } from '@manufakture/core';
import { DISCLAIMER_SHORT } from '@manufakture/domain-construction';
import type { IfcBuildingInput } from '@manufakture/io';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import type { MemberSetView } from '../viewport/members';
import { IFC_TYPE, exportIfc, ifcBuilding, ifcUnit } from './ifcExport';

const length = (mm: number) => ({
  source: String(mm),
  lengthUnit: 'mm' as const,
  angleUnit: 'deg' as const,
});

function doc(levels = true): ManufaktureDocument {
  const d = createDocument({ id: 'doc-1', name: 'Shed' });
  if (!levels) return d;
  const r = applyCommand(d, {
    type: 'setDomainData',
    namespace: 'construction',
    schemaVersion: 1,
    data: {
      levels: [{ id: 'level-1', name: 'Level 1', elevation: length(0), height: length(2400) }],
      wallTypes: [],
      floorTypes: [],
      roofTypes: [],
    },
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

const wallResult = {
  featureId: 'extension#1',
  kind: 'extension',
  status: 'ok',
  metadata: {
    kind: 'wall',
    level: 'level-1',
    base: 0,
    height: 2400,
    points: [
      [0, 0],
      [3000, 0],
    ],
    closed: false,
    justification: 'left',
    thickness: 89,
    free: { start: true, end: true },
    layers: [{ id: 'framing', kind: 'framing', body: null, t: [0, 89] }],
    settings: {},
    overrides: [],
  },
} as unknown as FeatureResult;

const stud = {
  id: 's0',
  owner: 'extension#1',
  role: 'stud',
  stock: { id: 'us-2x4', name: '2x4', width: 38, depth: 89 },
  length: 2400,
  placement: { origin: [0, 0, 0], x: [0, 0, 1], y: [1, 0, 0] },
  cuts: [],
} as const;

const sets = (namespace = 'construction'): MemberSetView[] => [
  {
    group: 'extension#1',
    namespace,
    features: ['extension#1'],
    members: [stud],
    instances: [],
  },
];

describe('IFC export in the app', () => {
  it('writes feet for feet-and-inches documents and the unit itself otherwise', () => {
    const d = doc();
    expect(ifcUnit(d)).toBe('mm');
    expect(ifcUnit({ ...d, units: { ...d.units, length: { unit: 'ft-in' } } })).toBe('ft');
    expect(ifcUnit({ ...d, units: { ...d.units, length: { unit: 'in-fraction' } } })).toBe('in');
  });

  it('maps the last regen and the member sets through the construction domain', () => {
    const r = ifcBuilding({
      document: doc(),
      partId: 'part#1',
      features: [wallResult],
      sets: sets(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.documentId).toBe('doc-1');
    expect(r.value.disclaimer).toBe(DISCLAIMER_SHORT);
    expect(r.value.levels).toEqual([{ id: 'level-1', name: 'Level 1', elevation: 0 }]);
    expect(r.value.walls!.map((w) => w.id)).toEqual(['extension#1']);
    expect(r.value.members!.map((m) => m.id)).toEqual(['s0']);
    // Another domain's members are not the building's.
    const other = ifcBuilding({
      document: doc(),
      partId: 'part#1',
      features: [wallResult],
      sets: sets('wood'),
    });
    expect(other.ok && other.value.members).toEqual([]);
  });

  it('refuses a document with no level or no building element', () => {
    expect(ifcBuilding({ document: doc(false), partId: 'part#1', features: [], sets: [] })).toEqual(
      {
        ok: false,
        message: 'IFC export needs a construction document with a level.',
      },
    );
    const none = ifcBuilding({ document: doc(), partId: 'part#1', features: [], sets: [] });
    expect(none.ok).toBe(false);
  });

  it('names the file after the document and reports a failed write', async () => {
    let given: IfcBuildingInput | undefined;
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    const ok = await exportIfc(
      {
        exportIfc: async (b) => {
          given = b;
          return bytes;
        },
      },
      { document: doc(), partId: 'part#1', features: [wallResult], sets: sets() },
    );
    expect(ok).toEqual({
      ok: true,
      value: [{ name: 'Shed.ifc', bytes, type: IFC_TYPE }],
      message: 'Exported Shed.ifc.',
    });
    expect(given?.walls).toHaveLength(1);
    const failed = await exportIfc(
      {
        exportIfc: () => Promise.reject(new Error('the building is too large to export as IFC')),
      },
      { document: doc(), partId: 'part#1', features: [wallResult], sets: sets() },
    );
    expect(failed).toEqual({
      ok: false,
      message: 'IFC export failed: the building is too large to export as IFC',
    });
  });
});
