// The Issues list: bed fit, overhangs, thickness and gaps from the worker's reply, holes, and
// what a click selects and frames.

import { describe, expect, it } from 'vitest';
import { createDocument, type ManufaktureDocument } from '@manufakture/core';
import type { FaceInfo } from '@manufakture/kernel';
import type { PrintAnalysisBodyResult, ThicknessIssue } from '@manufakture/print';
import { editSetupCommand } from './commands';
import { overhangsOf, printIssues } from './issues';
import { printViewBodies, resolveSetup } from './resolve';
import { issueSelection } from './usePrintWorkspace';
import { apply, boxPart, partsDocument, setupOf, withSetup } from './print.test-fixture';

const UNITS = createDocument({ id: 'u', name: 'u' }).units;

function resolved(doc: ManufaktureDocument, setupId: string, model: ReturnType<typeof boxPart>[]) {
  return resolveSetup(doc, setupOf(doc, setupId), model);
}

describe('printIssues', () => {
  it('lists nothing for a box on the bed', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const r = resolved(doc, setupId, [boxPart('part#1', [{ bodyId: 'extrude#1' }])]);
    expect(printIssues(r, overhangsOf(r), null, UNITS)).toEqual([]);
  });

  it('lists the underside of a body above the bed as an overhang, with the faces to frame', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    // Two bodies printed as one item: the second floats 10 mm above the first.
    const model = [
      boxPart('part#1', [{ bodyId: 'extrude#1' }, { bodyId: 'extrude#3', min: [0, 0, 20] }]),
    ];
    const r = resolved(doc, setupId, model);
    const issues = printIssues(r, overhangsOf(r), null, UNITS);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'overhang',
      itemId: 'item#1',
      worst: '90.00°',
      targets: [{ viewId: 'print:item#1:0:part#1/extrude#3', faces: [5] }],
    });
    expect(issues[0]!.detail).toBe(
      '100.0 mm² steeper than 60.00° from vertical, including flat ceilings that need a bridge or support.',
    );
  });

  it('lists a part too big for the bed, by the axis it exceeds', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const doc = apply(built.doc, editSetupCommand(built.setupId, { printer: 'bambu-a1-mini' }));
    const r = resolved(doc, built.setupId, [
      boxPart('part#1', [{ bodyId: 'extrude#1', size: [200, 20, 10] }]),
    ]);
    const issues = printIssues(r, overhangsOf(r), null, UNITS);
    expect(issues.map((i) => [i.kind, i.worst, i.detail])).toEqual([
      ['bedFit', 'x 20.00 mm', 'too big by x 20.00 mm.'],
    ]);
  });

  it('groups thickness and gap issues per item and kind, with the worst value', () => {
    const { doc, setupId } = withSetup(partsDocument(2), [{ part: 'part#1' }, { part: 'part#2' }]);
    const r = resolved(doc, setupId, [
      boxPart('part#1', [{ bodyId: 'extrude#1' }]),
      boxPart('part#2', [{ bodyId: 'extrude#1' }]),
    ]);
    const empty = () => ({
      thickness: new Float32Array(),
      gap: new Float32Array(),
      flags: new Uint8Array(),
      faces: [],
      samples: 0,
    });
    const bodies: PrintAnalysisBodyResult[] = [
      { id: 'print:item#1:0:part#1/extrude#1', ...empty() },
      { id: 'print:item#2:0:part#2/extrude#1', ...empty() },
      { id: 'print:item#9:0:part#9/gone', ...empty() },
    ];
    const issues: ThicknessIssue[] = [
      { kind: 'thinWall', body: 1, face: 1, value: 0.6, area: 10 },
      { kind: 'thinWall', body: 1, face: 2, value: 0.5, area: 5 },
      { kind: 'belowMinFeature', body: 1, face: 2, value: 0.05, area: 1 },
      { kind: 'narrowGap', body: 0, face: 3, value: 0.1, area: 2 },
      { kind: 'thinWall', body: 2, face: 1, value: 0.2, area: 1 },
    ];
    const meshes = [...r.items.map((i) => i.bodies[0]!.input.mesh), {}];
    const list = printIssues(r, overhangsOf(r), { bodies, issues, meshes }, UNITS);
    expect(list.map((i) => [i.kind, i.itemId, i.worst])).toEqual([
      ['belowMinFeature', 'item#2', '0.05 mm'],
      ['thinWall', 'item#2', '0.50 mm'],
      ['narrowGap', 'item#1', '0.10 mm'],
    ]);
    const thin = list.find((i) => i.kind === 'thinWall')!;
    expect(thin.targets).toEqual([{ viewId: 'print:item#2:0:part#2/extrude#1', faces: [1, 2] }]);
    expect(thin.detail).toBe('15.0 mm² thinner than two lines (0.84 mm).');
  });

  it('lists small holes and horizontal holes that need a teardrop, one entry per hole', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const part = boxPart('part#1', [{ bodyId: 'extrude#1' }]);
    const view = part.bodies[0]!.view;
    const cylinder = (index: number, radius: number, axis: [number, number, number]): FaceInfo => ({
      index,
      surface: 'cylinder',
      centroid: [0, 0, 0],
      area: 1,
      normal: null,
      axis,
      axisOrigin: index === 1 ? [5, 5, 0] : [0, 5, 5],
      radius,
      hole: true,
    });
    const faces = view.topology!.faces.map((f) =>
      f.index === 1 ? cylinder(1, 0.2, [0, 0, 1]) : f.index === 2 ? cylinder(2, 2, [1, 0, 0]) : f,
    );
    // Faces only: without edges every cylinder counts as going all the way round.
    const withHoles = {
      ...part,
      bodies: [
        { ...part.bodies[0]!, view: { ...view, topology: { faces, edges: [], vertices: [] } } },
      ],
    };
    const r = resolved(doc, setupId, [withHoles]);
    const list = printIssues(r, overhangsOf(r), null, UNITS);
    expect(list.map((i) => [i.kind, i.worst])).toEqual([
      ['smallHole', '0.40 mm'],
      ['teardrop', '4.00 mm'],
    ]);
    expect(list[0]!.targets).toEqual([{ viewId: 'print:item#1:0:part#1/extrude#1', faces: [1] }]);
  });

  it('checks nothing on a printer it does not know', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const doc = apply(built.doc, editSetupCommand(built.setupId, { printer: 'acme-9000' }));
    const r = resolved(doc, built.setupId, [
      boxPart('part#1', [
        { bodyId: 'extrude#1', min: [0, 0, 0] },
        { bodyId: 'b', min: [0, 0, 30] },
      ]),
    ]);
    expect(printIssues(r, overhangsOf(r), null, UNITS)).toEqual([]);
  });
});

describe('issueSelection', () => {
  it('selects the named faces and frames them where they are drawn', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const model = [
      boxPart('part#1', [{ bodyId: 'extrude#1' }, { bodyId: 'extrude#3', min: [0, 0, 20] }]),
    ];
    const r = resolved(doc, setupId, model);
    const [overhang] = printIssues(r, overhangsOf(r), null, UNITS);
    const { refs, box } = issueSelection(overhang!, printViewBodies(r));
    expect(refs.map((x) => [x.bodyId, x.name])).toEqual([
      ['print:item#1:0:part#1/extrude#3', 'part#1/extrude#3/bottom'],
    ]);
    // The bottom face of the upper box, placed: x and y centred on the bed, 20 mm up.
    const t = r.items[0]!.copies[0]!.placement.translation;
    expect(box).toEqual({ min: [t[0], t[1], 20], max: [t[0] + 10, t[1] + 10, 20] });
  });
});
