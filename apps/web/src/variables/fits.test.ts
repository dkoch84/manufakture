import {
  DocumentStore,
  applyCommand,
  createDocument,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import { evaluateQuantity } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import { boxDocument, mm } from './box.test-fixture';
import {
  FIT_VARIABLE_NAMES,
  documentFitDefaults,
  fitSetup,
  fitsFirst,
  insertFitVariables,
  parsePrintedFit,
  printedFitDiameter,
} from './fits';
import { evaluateTable } from './variables';

function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

function withSetup(doc: ManufaktureDocument, printer: string, nozzle: number, id = 'print#1') {
  return apply(doc, {
    type: 'addPrintSetup',
    setup: { id, name: `Setup ${id}`, printer, nozzle, items: [] },
  });
}

const sources = (doc: ManufaktureDocument) =>
  Object.fromEntries(doc.variables.map((v) => [v.name, v.expression.source]));

const METRIC: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const INCH: DisplayUnits = { length: { unit: 'in', decimals: 3 }, angle: { unit: 'deg' } };

describe('insertFitVariables', () => {
  it('adds the three fit variables with the generic defaults when there is no print setup', () => {
    const doc = boxDocument();
    const r = insertFitVariables(doc);
    expect(r.added).toEqual(['fit_press', 'fit_slip', 'fit_sliding']);
    expect(r.kept).toEqual([]);
    expect(r.command?.type).toBe('batch');
    expect(r.message).toMatch(/generic defaults/);
    const after = apply(doc, r.command!);
    expect(sources(after)).toMatchObject({
      fit_press: '0.1 mm',
      fit_slip: '0.2 mm',
      fit_sliding: '0.4 mm',
    });
    const table = evaluateTable(after.variables);
    const slip = table.get('fit_slip');
    expect(slip?.ok && slip.value.value).toBeCloseTo(0.2, 12);
  });

  it("takes the values from the print setup's printer and nozzle", () => {
    const doc = withSetup(boxDocument(), 'bambu-x1c', 0.6);
    expect(fitSetup(doc)?.id).toBe('print#1');
    expect(documentFitDefaults(doc).family).toBe('bambu-lab');
    const r = insertFitVariables(doc);
    expect(r.message).toMatch(/Bambu Lab X1 Carbon with a 0\.6 mm nozzle/);
    expect(sources(apply(doc, r.command!))).toMatchObject({
      fit_press: '0.15 mm',
      fit_slip: '0.3 mm',
      fit_sliding: '0.6 mm',
    });
  });

  it('uses a named setup when given, else the first', () => {
    let doc = withSetup(boxDocument(), 'bambu-x1c', 0.4);
    doc = withSetup(doc, 'bambu-a1', 0.8, 'print#2');
    expect(insertFitVariables(doc).defaults.nozzle).toBe(0.4);
    expect(insertFitVariables(doc, 'print#2').defaults.nozzle).toBe(0.8);
    expect(insertFitVariables(doc, 'print#9').defaults.nozzle).toBe(0.4);
  });

  it('never overwrites an existing variable, and is idempotent', () => {
    let doc = apply(boxDocument(), {
      type: 'setVariable',
      name: 'fit_slip',
      expression: mm('0.25 mm'),
    });
    const r = insertFitVariables(doc);
    expect(r.added).toEqual(['fit_press', 'fit_sliding']);
    expect(r.kept).toEqual(['fit_slip']);
    expect(r.message).toMatch(/Kept #fit_slip/);
    doc = apply(doc, r.command!);
    expect(sources(doc).fit_slip).toBe('0.25 mm');

    const again = insertFitVariables(doc);
    expect(again.command).toBeNull();
    expect(again.added).toEqual([]);
    expect(again.message).toMatch(/already in the table/);
  });

  it('is one undo step', () => {
    const store = DocumentStore.create(boxDocument());
    if (!store.ok) throw new Error(store.error.message);
    const s = store.value;
    const before = s.document;
    const r = insertFitVariables(before);
    expect(s.execute(r.command!, r.label).ok).toBe(true);
    expect(s.undoStack.at(-1)?.label).toBe('Insert fit variables');
    expect(FIT_VARIABLE_NAMES.every((n) => s.document.variables.some((v) => v.name === n))).toBe(
      true,
    );
    expect(s.undo().ok).toBe(true);
    expect(s.document.variables).toEqual(before.variables);
    expect(s.canUndo).toBe(false);
    expect(s.redo().ok).toBe(true);
    expect(s.document.variables.map((v) => v.name)).toContain('fit_sliding');
  });

  it('writes explicit millimetres, so an inch document reads the same clearance', () => {
    const doc = createDocument({ id: 'inch', name: 'Inch', units: INCH });
    const after = apply(doc, insertFitVariables(doc).command!);
    const v = after.variables.find((x) => x.name === 'fit_press')!;
    expect(v.expression.lengthUnit).toBe('in');
    const q = evaluateQuantity(v.expression.source, v.expression);
    expect(q.ok && q.value.value).toBeCloseTo(0.1, 12);
  });
});

describe('suggestions', () => {
  it('puts the fit variables first, tight to loose, keeping the rest in order', () => {
    expect(fitsFirst(['w', 'fit_sliding', 'd', 'fit_press'])).toEqual([
      'fit_press',
      'fit_sliding',
      'w',
      'd',
    ]);
    expect(fitsFirst(['w', 'd'])).toEqual(['w', 'd']);
  });
});

describe('printed fit diameters', () => {
  it('writes the nominal size plus the fit variable, and reads it back', () => {
    const d = printedFitDiameter(3, 'slip', METRIC);
    expect(d).toBe('3 mm + #fit_slip');
    expect(parsePrintedFit(d)).toEqual({ nominal: '3 mm', fit: 'slip' });
    expect(parsePrintedFit('3.4')).toBeNull();
    expect(parsePrintedFit('#fit_slip')).toBeNull();
  });

  it('writes the nominal in inches under inch units', () => {
    expect(printedFitDiameter(6.35, 'press', INCH)).toBe('0.25 in + #fit_press');
    expect(printedFitDiameter(3, 'slip', INCH)).toBe('0.11811 in + #fit_slip');
  });
});
