import { applyCommand, configured, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { boxDocument, mm } from '../variables/box.test-fixture';
import {
  addParameter,
  addRow,
  cellExpression,
  cellFlag,
  cellSource,
  configuredVariableNames,
  deleteParameter,
  deleteRow,
  keepUnits,
  nameProblem,
  parameterCandidates,
  parameterColumns,
  renameParameter,
  renameRow,
  rowVariables,
  setActive,
  setCell,
  type Edit,
} from './configurations';

function apply(doc: ManufaktureDocument, edit: Edit | null): ManufaktureDocument {
  if (!edit) throw new Error('no edit');
  const r = applyCommand(doc, edit.command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

/** The box with a #w parameter, a suppression of the fillet, and rows Small and Large. */
function table(): ManufaktureDocument {
  let doc = boxDocument();
  doc = apply(doc, addParameter(doc, parameterCandidates(doc, 'part#1')[0]!));
  const fillet = parameterCandidates(doc, 'part#1').find((c) => c.key === 'f:part#1:fillet#1')!;
  doc = apply(doc, addParameter(doc, fillet));
  doc = apply(doc, addRow(doc, 'Small'));
  doc = apply(doc, addRow(doc, 'Large'));
  doc = apply(doc, setCell(doc, 'cfg#1', 'cp#1', mm('30 mm')));
  doc = apply(doc, setCell(doc, 'cfg#2', 'cp#1', mm('60 mm')));
  doc = apply(doc, setCell(doc, 'cfg#2', 'cp#2', true));
  return doc;
}

describe('the configuration table', () => {
  it('offers every variable and feature not configured yet', () => {
    const doc = boxDocument();
    expect(parameterCandidates(doc, 'part#1').map((c) => c.label)).toEqual([
      '#w',
      '#d',
      '#h',
      '#r',
      'Suppress Sketch 1',
      'Suppress Extrude 1',
      'Suppress Fillet 1',
    ]);
    const t = table();
    expect(parameterCandidates(t, 'part#1').map((c) => c.label)).toEqual([
      '#d',
      '#h',
      '#r',
      'Suppress Sketch 1',
      'Suppress Extrude 1',
    ]);
  });

  it('adds parameters named after what they configure, with fresh ids', () => {
    const doc = table();
    expect(doc.configurations!.parameters).toEqual([
      { id: 'cp#1', name: 'w', kind: 'variable', variable: 'w' },
      {
        id: 'cp#2',
        name: 'Fillet 1 suppressed',
        kind: 'suppression',
        partId: 'part#1',
        featureId: 'fillet#1',
      },
    ]);
    expect(parameterColumns(doc).map((c) => [c.target, c.base, c.kind])).toEqual([
      ['#w', '40 mm', 'length'],
      ['Fillet 1', false, 'any'],
    ]);
    // A name already taken gets a number.
    const again = addParameter(
      { ...doc, variables: [...doc.variables, { name: 'w2', expression: mm('1 mm') }] },
      { kind: 'variable', key: 'v:w2', label: '#w2', variable: 'w2' },
    );
    expect(again.command).toMatchObject({ parameter: { id: 'cp#3', name: 'w2' } });
    expect(configuredVariableNames(doc).get('w')?.id).toBe('cp#1');
  });

  it('adds rows with unique names and edits their cells', () => {
    let doc = table();
    expect(doc.configurations!.rows.map((r) => [r.id, r.name])).toEqual([
      ['cfg#1', 'Small'],
      ['cfg#2', 'Large'],
    ]);
    expect(addRow(doc, 'Small').command).toMatchObject({ row: { id: 'cfg#3', name: 'Small 2' } });
    expect(addRow(doc).command).toMatchObject({ row: { name: 'Configuration 3' } });
    const large = doc.configurations!.rows[1]!;
    expect(cellSource(large, 'cp#1')).toBe('60 mm');
    expect(cellFlag(large, 'cp#2')).toBe(true);
    expect(cellFlag(doc.configurations!.rows[0]!, 'cp#2')).toBeUndefined();
    // The same value is no edit; clearing a value leaves the document's own.
    expect(setCell(doc, 'cfg#2', 'cp#1', mm('60 mm'))).toBeNull();
    doc = apply(doc, setCell(doc, 'cfg#2', 'cp#1', null));
    expect(doc.configurations!.rows[1]!.values).toEqual({ 'cp#2': true });
    expect(setCell(doc, 'cfg#2', 'cp#1', null)).toBeNull();
  });

  it('applies a row: the variable and the suppression follow it', () => {
    const doc = table();
    const large = configured(doc, 'cfg#2');
    if (!large.ok) throw new Error(large.error.message);
    expect(large.value.variables.find((v) => v.name === 'w')!.expression.source).toBe('60 mm');
    expect(large.value.parts[0]!.features.find((f) => f.id === 'fillet#1')!.suppressed).toBe(true);
  });

  it('renames rows and parameters, refusing empty and duplicate names', () => {
    let doc = table();
    expect(nameProblem(doc, ' ', 'row', 'cfg#1')).toBe('Enter a name.');
    expect(nameProblem(doc, 'Large', 'row', 'cfg#1')).toBe(
      'There is already a configuration named "Large".',
    );
    expect(nameProblem(doc, 'Small', 'row', 'cfg#1')).toBeNull();
    expect(nameProblem(doc, 'w', 'parameter', 'cp#2')).toBe(
      'There is already a parameter named "w".',
    );
    expect(nameProblem(doc, 'x'.repeat(201), 'row', 'cfg#1')).toMatch(/at most 200/);
    expect(renameRow(doc, 'cfg#1', 'Small')).toBeNull();
    doc = apply(doc, renameRow(doc, 'cfg#1', ' 600 '));
    expect(doc.configurations!.rows[0]!.name).toBe('600');
    doc = apply(doc, renameParameter(doc, 'cp#1', 'Width'));
    expect(doc.configurations!.parameters[0]!.name).toBe('Width');
  });

  it('switches the active row and deletes rows and parameters', () => {
    let doc = table();
    expect(setActive(doc, null)).toBeNull();
    const show = setActive(doc, 'cfg#2')!;
    expect(show.label).toBe('Show configuration Large');
    doc = apply(doc, show);
    expect(doc.configurations!.active).toBe('cfg#2');
    expect(setActive(doc, 'cfg#9')).toBeNull();
    expect(setActive(doc, null)!.label).toBe('Show no configuration');
    doc = apply(doc, deleteParameter(doc, 'cp#2'));
    expect(doc.configurations!.rows[1]!.values).toEqual({ 'cp#1': mm('60 mm') });
    doc = apply(doc, deleteRow(doc, 'cfg#2'));
    expect(doc.configurations!.active).toBeNull();
    expect(deleteRow(doc, 'cfg#2')).toBeNull();
  });

  it('evaluates a cell against the variables as its row gives them', () => {
    let doc = table();
    // #h reads #d; a row that sets #d changes what #h is in that row.
    doc = apply(doc, addParameter(doc, parameterCandidates(doc, 'part#1')[0]!)); // #d, cp#3
    doc = apply(doc, setCell(doc, 'cfg#1', 'cp#3', mm('35 mm')));
    const small = rowVariables(doc, 'cfg#1', 'w');
    expect(small.w).toBeUndefined();
    expect(small.d!.value).toBeCloseTo(35);
    expect(small.h!.value).toBeCloseTo(25);
    expect(rowVariables(doc, 'cfg#2').d!.value).toBeCloseTo(25);
  });

  it('writes the unit into a bare number for a length or angle, as the Variables panel does', () => {
    const doc = boxDocument();
    const vars = rowVariables(doc, 'none');
    expect(cellExpression('800', 'length', doc.units, vars)).toEqual(mm('800 mm'));
    expect(cellExpression('2 * #w', 'length', doc.units, vars)).toEqual(mm('2 * #w'));
    expect(cellExpression('2 * 3', 'length', doc.units, vars)).toEqual(mm('(2 * 3) mm'));
    expect(cellExpression('30', 'angle', doc.units, vars)).toEqual(mm('30 deg'));
    expect(cellExpression('3', 'number', doc.units, vars)).toEqual(mm('3'));
  });

  it('keeps the units a value was entered under while its text is the same', () => {
    const old = { source: '40', lengthUnit: 'in' as const, angleUnit: 'deg' as const };
    expect(keepUnits(old, mm('40'))).toBe(old);
    expect(keepUnits(old, mm('41'))).toEqual(mm('41'));
    expect(keepUnits(undefined, mm('41'))).toEqual(mm('41'));
  });
});
