// The templates and requirement wording (T9.4a): the cable trainer template filled in from the
// T9.0c research's R1 to R18, applied as one undo step, saved and loaded back, with every
// requirement and load case evaluating; the winch and the linear axis likewise; problems with a
// requirement by field.

import {
  applyCommand,
  createDocument,
  parseDocument,
  requirementKind,
  serialize,
  type ManufaktureDocument,
  type Requirement,
  type StoredExpression,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { dutyCycle, resolveDynamic } from './motion';
import { loadCaseProblems, requirementProblems, requirementText } from './requirement';
import { MECH_TEMPLATES, templateCommand } from './templates';
import { NO_VARIABLES, siValue } from './values';

const LBF = 4.4482216152605;

function withTemplate(doc: ManufaktureDocument, id: string): ManufaktureDocument {
  const t = templateCommand(doc, id);
  if (!t.ok) throw new Error(t.message);
  const r = applyCommand(doc, t.command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

function value(r: Requirement): number {
  const v = siValue(r.value as StoredExpression, requirementKind(r.quantity), NO_VARIABLES);
  if (!v.ok) throw new Error(v.message);
  return v.value;
}

describe('the cable trainer template', () => {
  const doc = withTemplate(createDocument({ id: 'd', name: 'Trainer' }), 'cable-trainer');
  const reqs = doc.mech!.requirements!;
  const cases = doc.mech!.loadCases!;
  const byName = (prefix: string) => reqs.find((r) => r.name.startsWith(prefix))!;

  it('takes its targets from the research, R1 to R18', () => {
    expect(value(byName('R1 Maximum'))).toBeCloseTo(200 * LBF, 6);
    expect(value(byName('R1 Minimum'))).toBeCloseTo(5 * LBF, 6);
    expect(value(byName('R2'))).toBeCloseTo(LBF, 9);
    expect(value(byName('R4'))).toBeCloseTo(2.85, 12);
    expect(value(byName('R6'))).toBe(1.5);
    expect(value(byName('R7'))).toBe(3);
    expect(value(byName('R8'))).toBe(30);
    expect(reqs.filter((r) => r.quantity === 'sessionsPerCharge').map(value)).toEqual([6, 14]);
    expect(value(byName('R10'))).toBeCloseTo(360_000, 6);
    expect(byName('R10').comparison).toBe('<');
    expect(value(byName('R11'))).toBeCloseTo(9000, 9);
    expect(value(byName('R12'))).toBe(6);
    expect(byName('R13').value).toHaveLength(3);
    expect(
      (byName('R13').value as readonly StoredExpression[]).map((v) =>
        siValue(v, 'length', NO_VARIABLES),
      ),
    ).toEqual([
      { ok: true, value: 0.33 },
      { ok: true, value: 0.14 },
      { ok: true, value: 0.1 },
    ]);
    expect(value(byName('R18'))).toBeCloseTo(333.15, 9);
  });

  it('names its load cases, which carry R6 to R9 and R14', () => {
    expect(cases.map((c) => [c.id, c.name])).toEqual([
      ['lc#1', 'Full force rep (R6)'],
      ['lc#2', 'Light rowing (R7)'],
      ['lc#3', 'Isometric hold at 40 °C (R8, R14)'],
      ['lc#4', 'Session at 100 lbf (R9)'],
      ['lc#5', 'Session at 60 lbf (R9)'],
    ]);
    expect(byName('R6').loadCase).toBe('lc#1');
    expect(byName('R7').loadCase).toBe('lc#2');
    expect(byName('R8').loadCase).toBe('lc#3');
    expect(reqs.filter((r) => r.quantity === 'sessionsPerCharge').map((r) => r.loadCase)).toEqual([
      'lc#4',
      'lc#5',
    ]);
    const session = resolveDynamic(cases[3]!.dynamic!, NO_VARIABLES);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(session.value).toMatchObject({ reps: 9, sets: 13, rest: 60, startCharge: 1 });
    expect(session.value.law.force).toBeCloseTo(100 * LBF, 6);
    expect(session.value.motion).toMatchObject({
      kind: 'half-cosine',
      stroke: 0.6,
      pullSpeed: 1.5,
    });
    expect(dutyCycle(session.value).sessionDuration).toBeGreaterThan(12 * 60);
    const hold = resolveDynamic(cases[2]!.dynamic!, NO_VARIABLES);
    expect(hold.ok && hold.value.ambient).toBeCloseTo(313.15, 9);
    const rowing = resolveDynamic(cases[1]!.dynamic!, NO_VARIABLES);
    expect(rowing.ok && rowing.value.law.kind).toBe('rowing');
  });

  it('fills in no safety factor', () => {
    expect(doc.domains).toBeUndefined();
    expect(doc.mech!.checks).toBeUndefined();
    expect(JSON.stringify(doc.mech)).not.toMatch(/factor of|design factor|safety/i);
  });

  it('saves and loads back unchanged, every item evaluating', () => {
    const loaded = parseDocument(JSON.parse(serialize(doc)));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const back = loaded.value.document;
    expect(back.mech).toEqual(doc.mech);
    for (const r of back.mech!.requirements!)
      expect(requirementProblems(back, r, NO_VARIABLES)).toEqual([]);
    for (const c of back.mech!.loadCases!)
      expect(loadCaseProblems(back, c, NO_VARIABLES)).toEqual([]);
  });

  it('is one undo step, and appends to what the document has', () => {
    const t = templateCommand(doc, 'cable-trainer');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.command.type).toBe('batch');
    expect(t.loadCaseIds[0]).toBe('lc#6');
    expect(t.requirementIds[0]).toBe(`req#${reqs.length + 1}`);
    const twice = withTemplate(doc, 'cable-trainer');
    expect(twice.mech!.requirements).toHaveLength(reqs.length * 2);
    expect(twice.mech!.requirements!.at(-1)!.id).toBe(`req#${reqs.length * 2}`);
    expect(
      twice.mech!.requirements!.find((r) => r.name.startsWith('R6') && r.id !== byName('R6').id)!
        .loadCase,
    ).toBe('lc#6');
  });

  it('states each requirement in a line', () => {
    const text = reqs.map((r) => requirementText(r, cases));
    expect(text).toContain('Maximum force at least 200 lbf');
    expect(text).toContain('Peak cable speed at least 1.5 m/s, in Full force rep (R6)');
    expect(text).toContain('Pack energy below 100 Wh');
    expect(text).toContain('Envelope within 330 mm x 140 mm x 100 mm');
    expect(text.join('\n')).not.toMatch(/\b(safe|pass|fail|certified|compliant)\b/i);
  });
});

describe('the other templates', () => {
  it('apply and evaluate', () => {
    for (const t of MECH_TEMPLATES) {
      const doc = withTemplate(createDocument({ id: 'd', name: t.name }), t.id);
      expect(doc.mech!.requirements!.length).toBeGreaterThan(0);
      for (const r of doc.mech!.requirements!)
        expect(requirementProblems(doc, r, NO_VARIABLES)).toEqual([]);
      for (const c of doc.mech!.loadCases!)
        expect(loadCaseProblems(doc, c, NO_VARIABLES)).toEqual([]);
    }
  });

  it('refuses an unknown template', () => {
    const r = templateCommand(createDocument({ id: 'd', name: 'D' }), 'crane');
    expect(r).toEqual({ ok: false, message: 'there is no template "crane"' });
  });
});

describe('requirement problems', () => {
  const doc = createDocument({ id: 'd', name: 'D' });
  const x = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

  it('names a value of the wrong kind, a negative tolerance and a missing load case', () => {
    const r: Requirement = {
      id: 'req#1',
      name: 'Pull',
      quantity: 'maxForce',
      comparison: '>=',
      value: x('2 m/s'),
      tolerance: x('-1 N'),
      loadCase: 'lc#9',
    };
    expect(requirementProblems(doc, r, NO_VARIABLES).map((p) => p.path.join('.'))).toEqual([
      'value',
      'tolerance',
      'loadCase',
    ]);
  });

  it('reads a tolerance on a temperature as a difference', () => {
    const r: Requirement = {
      id: 'req#1',
      name: 'Surface',
      quantity: 'surfaceTemperature',
      comparison: '<=',
      value: x('60 degC'),
      tolerance: x('2 K'),
    };
    expect(requirementProblems(doc, r, NO_VARIABLES)).toEqual([]);
  });

  it('names a load case with nothing in it', () => {
    expect(loadCaseProblems(doc, { id: 'lc#1', name: 'Empty' }, NO_VARIABLES)).toEqual([
      { path: [], message: 'a load case needs a motion or a static load' },
    ]);
  });
});
