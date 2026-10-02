// The operation dialogs' logic: each kind's form built into its command, every range rule refused
// with a message (core checks neither kind nor range), sources checked per kind, face references
// given fresh `r<n>` ids, and an existing operation opened and applied unchanged.

import type { CamOperation, ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { apply, setupDocument, withTool } from './cam.test-fixture';
import {
  activeFields,
  addFace,
  addSource,
  buildOperation,
  formOf,
  newOperationForm,
  newOperationName,
  removeSource,
  suitableTools,
  type OperationForm,
} from './forms';
import type { DialogOperationKind } from './state';
import { camVariables } from './values';

function build(doc: ManufaktureDocument, form: OperationForm, existing?: CamOperation) {
  const setup = doc.cam.setups[0]!;
  return buildOperation(form, {
    doc,
    setup,
    ...(existing ? { existing } : {}),
    units: doc.units,
    variables: camVariables(doc),
  });
}

function opOf(doc: ManufaktureDocument, form: OperationForm): CamOperation {
  const r = build(doc, form);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  if (r.command.type !== 'addCamOperation') throw new Error(r.command.type);
  return r.command.operation;
}

const region = { kind: 'region' as const, sketch: 'sketch#1', label: 'Regions of Sketch 1' };
const hole = { kind: 'hole' as const, feature: 'hole#1', label: 'Holes of Hole 1' };

function form(
  doc: ManufaktureDocument,
  kind: DialogOperationKind,
  patch: Partial<OperationForm> = {},
) {
  return { ...newOperationForm(doc, kind, newOperationName(doc, kind)), ...patch };
}

describe('operation forms', () => {
  it('builds a profile with tabs, a ramp and leads, as typed', () => {
    const doc = setupDocument();
    const r = build(
      doc,
      form(doc, 'profile', {
        sources: [region],
        side: 'inside',
        depthMode: 'blind',
        depth: '#t',
        stepdown: '2',
        finishAllowance: '0.2',
        tabs: true,
        tabCount: '3',
        entry: 'ramp',
        leadIn: 'arc',
        leadInSize: '1.5',
        climb: false,
        feeds: { spindle: '18000 rpm', cut: '1200', plunge: '', ramp: '', lead: '' },
      }),
    );
    // #t is not a variable of this document: an unknown variable is an error on its field.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.depth).toMatch(/t/);
    const withT = apply(doc, {
      type: 'setVariable',
      name: 't',
      expression: { source: '6 mm', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    const ok = build(
      withT,
      form(withT, 'profile', {
        sources: [region],
        side: 'inside',
        depthMode: 'blind',
        depth: '#t',
        stepdown: '2',
        finishAllowance: '0.2',
        tabs: true,
        tabCount: '3',
        entry: 'ramp',
        leadIn: 'arc',
        leadInSize: '1.5',
        climb: false,
        feeds: { spindle: '18000 rpm', cut: '1200', plunge: '', ramp: '', lead: '' },
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.label).toBe('Add profile operation Profile 1');
    expect(ok.command).toEqual({
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: {
        id: 'profile#1',
        kind: 'profile',
        name: 'Profile 1',
        suppressed: false,
        tool: 'tool#1',
        geometry: [{ kind: 'region', sketch: 'sketch#1' }],
        feeds: {
          spindle: { source: '18000 rpm', lengthUnit: 'mm', angleUnit: 'deg' },
          cut: { source: '1200', lengthUnit: 'mm', angleUnit: 'deg' },
        },
        side: 'inside',
        depth: { kind: 'blind', depth: { source: '#t', lengthUnit: 'mm', angleUnit: 'deg' } },
        stepdown: { source: '2', lengthUnit: 'mm', angleUnit: 'deg' },
        finishAllowance: { source: '0.2', lengthUnit: 'mm', angleUnit: 'deg' },
        tabs: {
          count: { source: '3', lengthUnit: 'mm', angleUnit: 'deg' },
          width: { source: '6 mm', lengthUnit: 'mm', angleUnit: 'deg' },
          height: { source: '2 mm', lengthUnit: 'mm', angleUnit: 'deg' },
        },
        entry: { kind: 'ramp', angle: { source: '3 deg', lengthUnit: 'mm', angleUnit: 'deg' } },
        leadIn: { kind: 'arc', radius: { source: '1.5', lengthUnit: 'mm', angleUnit: 'deg' } },
        leadOut: { kind: 'none' },
        climb: false,
      },
    });
    // The command applies: core takes what the form built.
    expect(apply(withT, ok.command).cam.setups[0]!.operations).toHaveLength(1);
  });

  it('refuses out-of-range values with a message per field', () => {
    const doc = setupDocument();
    const r = build(
      doc,
      form(doc, 'pocket', {
        sources: [region],
        depth: '-3',
        stepover: '0',
        stepdown: '0 mm',
        finishAllowance: '-0.1',
        entry: 'helix',
        entryAngle: '95 deg',
        entryRadius: '0',
        feeds: { spindle: '0 rpm', cut: '-5', plunge: '10 mm', ramp: '', lead: '' },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({
      depth: 'The value must be greater than zero.',
      stepover: expect.stringMatching(/fraction of the tool diameter/),
      stepdown: 'The value must be greater than zero.',
      finishAllowance: 'The value must be zero or more.',
      entryAngle: expect.stringMatching(/less than 90 degrees/),
      entryRadius: 'The value must be greater than zero.',
      'feeds.spindle': 'The value must be greater than zero.',
      'feeds.cut': 'The value must be greater than zero.',
      // A length where a feed is expected: the kind is checked, not only the range.
      'feeds.plunge': expect.stringMatching(/Expected/),
    });
    expect(form(doc, 'pocket').stepover).toBe('');
    const frac = build(doc, form(doc, 'pocket', { sources: [region], stepover: '1.5' }));
    expect(!frac.ok && frac.errors.stepover).toMatch(/at most 1/);
    const tabs = build(
      doc,
      form(doc, 'profile', { sources: [region], tabs: true, tabCount: '2.5', tabWidth: '0' }),
    );
    expect(!tabs.ok && tabs.errors.tabCount).toMatch(/whole number/);
    expect(!tabs.ok && tabs.errors.tabWidth).toMatch(/greater than zero/);
  });

  it('builds a facing, a drill and a V-carve', () => {
    let doc = setupDocument();
    const facing = opOf(
      doc,
      form(doc, 'facing', { depth: '0.5 mm', stepover: '0.6', angle: '90' }),
    );
    expect(facing).toMatchObject({
      kind: 'facing',
      id: 'facing#1',
      name: 'Facing 1',
      geometry: [],
      depth: { source: '0.5 mm' },
      stepover: { source: '0.6' },
      angle: { source: '90' },
    });
    expect(facing).not.toHaveProperty('stepdown');

    const drill = opOf(doc, form(doc, 'drill', { sources: [hole], peck: '2', dwell: '0.5' }));
    expect(drill).toEqual({
      id: 'drill#1',
      kind: 'drill',
      name: 'Drill 1',
      suppressed: false,
      tool: 'tool#1',
      geometry: [{ kind: 'hole', feature: 'hole#1' }],
      peck: { source: '2', lengthUnit: 'mm', angleUnit: 'deg' },
      dwell: { source: '0.5', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    const through = opOf(doc, form(doc, 'drill', { depthMode: 'through', extra: '1' }));
    expect(through).toMatchObject({
      geometry: [],
      depth: { kind: 'through', extra: { source: '1' } },
    });

    // A V-carve takes a V-bit or an engraver only.
    const noBit = build(doc, form(doc, 'vcarve', { sources: [region], tool: 'tool#1' }));
    expect(!noBit.ok && noBit.errors.tool).toMatch(/V-bit/);
    doc = withTool(doc, 'c3d-301');
    expect(suitableTools(doc, 'vcarve').map((t) => t.id)).toEqual(['tool#2']);
    expect(newOperationForm(doc, 'vcarve', 'V').tool).toBe('tool#2');
    const vcarve = opOf(doc, form(doc, 'vcarve', { sources: [region], maxDepth: '3' }));
    expect(vcarve).toMatchObject({ kind: 'vcarve', tool: 'tool#2', maxDepth: { source: '3' } });
  });

  it('checks the sources each kind takes', () => {
    const doc = setupDocument();
    const none = build(doc, form(doc, 'profile'));
    expect(!none.ok && none.errors.sources).toMatch(/at least one/);
    const drillFace = build(
      doc,
      form(doc, 'drill', {
        sources: [{ kind: 'face', id: null, ref: { face: 'x' }, label: 'Face x' }],
      }),
    );
    expect(!drillFace.ok && drillFace.errors.sources).toMatch(/hole features/);
    const mixed = build(
      doc,
      form(doc, 'pocket', {
        sources: [region, { kind: 'face', id: null, ref: { face: 'x' }, label: 'Face x' }],
      }),
    );
    expect(!mixed.ok && mixed.errors.sources).toMatch(/not both/);
    const lost = build(doc, form(doc, 'profile', { sources: [{ ...region, lost: true }] }));
    expect(!lost.ok && lost.errors.sources).toMatch(/pick it again/);
    const noTool = build(doc, form(doc, 'facing', { tool: '' }));
    expect(!noTool.ok && noTool.errors.tool).toMatch(/Choose a tool/);
  });

  it('gives picked faces fresh reference ids, keeps stored ones, and a re-pick a new one', () => {
    const doc = setupDocument();
    let f = form(doc, 'profile');
    f = addFace(f, { face: 'extrude#1:cap:end' });
    f = addFace(f, { face: 'extrude#1:cap:end' }); // twice: added once
    f = addFace(f, { face: 'extrude#2:cap:end' });
    expect(f.sources).toHaveLength(2);
    const op = opOf(doc, f);
    expect(op.geometry).toEqual([
      { kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
      { kind: 'face', face: { id: 'r2', ref: { face: 'extrude#2:cap:end' } } },
    ]);
    const saved = apply(doc, { type: 'addCamOperation', setupId: 'setup#1', operation: op });
    const setup = saved.cam.setups[0]!;
    const opened = formOf(saved, setup, setup.operations[0]!, new Set([1]))!;
    expect(opened.sources.map((s) => s.lost ?? false)).toEqual([false, true]);
    const repicked = addFace(opened, { face: 'extrude#2:side:3' }, 1);
    const edit = build(saved, repicked, setup.operations[0]!);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.command.type).toBe('editCamOperation');
    const geometry = (edit.command as { operation: CamOperation }).operation.geometry;
    expect(geometry).toEqual([
      { kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
      { kind: 'face', face: { id: 'r3', ref: { face: 'extrude#2:side:3' } } },
    ]);
    expect(apply(saved, edit.command).cam.nextIds.r).toBe(4);
  });

  it('opens every kind and applies it unchanged, keeping stored units', () => {
    let doc = withTool(setupDocument(), 'c3d-301');
    const inch = { source: '0.1', lengthUnit: 'in' as const, angleUnit: 'deg' as const };
    const forms: OperationForm[] = [
      form(doc, 'facing'),
      form(doc, 'profile', { sources: [region], tabs: true, entry: 'helix', leadOut: 'line' }),
      form(doc, 'pocket', { sources: [region], stepover: '0.4', entry: 'ramp' }),
      form(doc, 'drill', { sources: [hole], depthMode: 'blind', depth: '5' }),
      form(doc, 'vcarve', { sources: [region], tool: 'tool#2' }),
    ];
    for (const f of forms) {
      const r = build(doc, f);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      doc = apply(doc, r.command);
    }
    // A stored expression in inches stays in inches when the dialog is applied unchanged.
    const ops = doc.cam.setups[0]!.operations;
    const profile = ops[1] as CamOperation & { kind: 'profile' };
    doc = apply(doc, {
      type: 'editCamOperation',
      setupId: 'setup#1',
      operation: { ...profile, stepdown: inch },
    });
    for (const op of doc.cam.setups[0]!.operations) {
      const opened = formOf(doc, doc.cam.setups[0]!, op)!;
      const r = build(doc, opened, op);
      expect(r.ok, op.id).toBe(true);
      if (r.ok) expect((r.command as { operation: CamOperation }).operation, op.id).toEqual(op);
    }
  });

  it('lists the fields each kind uses as its choices stand', () => {
    const doc = setupDocument();
    expect(activeFields(form(doc, 'facing'))).toEqual(['depth', 'stepdown', 'stepover', 'angle']);
    expect(activeFields(form(doc, 'profile'))).toEqual(['extra', 'stepdown', 'finishAllowance']);
    expect(activeFields(form(doc, 'drill'))).toEqual(['peck', 'dwell']);
    expect(activeFields(form(doc, 'vcarve'))).toEqual(['maxDepth']);
    const f = addSource(addSource(form(doc, 'profile'), region), region);
    expect(f.sources).toHaveLength(1);
    expect(removeSource(f, 0).sources).toEqual([]);
  });
});
