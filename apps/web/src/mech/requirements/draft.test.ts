import { applyCommand, createDocument } from '@manufakture/core';
import { MECH_TEMPLATES, templateCommand } from '@manufakture/domain-mech';
import { describe, expect, it } from 'vitest';
import {
  loadCaseDraft,
  loadCaseFromDraft,
  nextRequirementId,
  parsePoints,
  requirementDraft,
  requirementFromDraft,
  withQuantity,
} from './draft';

describe('the editor drafts', () => {
  it('give back every template requirement and load case unchanged', () => {
    for (const t of MECH_TEMPLATES) {
      const doc0 = createDocument({ id: 'd', name: 'D' });
      const c = templateCommand(doc0, t.id);
      if (!c.ok) throw new Error(c.message);
      const r = applyCommand(doc0, c.command);
      if (!r.ok) throw new Error(r.error.message);
      const doc = r.value.document;
      for (const req of doc.mech!.requirements!) {
        expect(requirementFromDraft(requirementDraft(req), doc.units)).toEqual(req);
      }
      for (const lc of doc.mech!.loadCases!) {
        expect(loadCaseFromDraft(loadCaseDraft(lc), doc.units)).toEqual({ ok: true, loadCase: lc });
      }
    }
  });

  it('keeps static loads and a case with no motion', () => {
    const units = createDocument({ id: 'd', name: 'D' }).units;
    const lc = {
      id: 'lc#1',
      name: 'Side pull',
      static: [
        {
          kind: 'cable' as const,
          name: 'Pull',
          force: { source: '200 lbf', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
          angle: { source: '45', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
        },
      ],
    };
    expect(loadCaseFromDraft(loadCaseDraft(lc), units)).toEqual({ ok: true, loadCase: lc });
  });

  it('switches an envelope to three values and within', () => {
    const d = requirementDraft({
      id: 'req#1',
      name: 'Box',
      quantity: 'mass',
      comparison: '<=',
      value: { source: '6 kg', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    const e = withQuantity(d, 'envelope');
    expect([e.comparison, e.value]).toEqual(['within', ['6 kg', '', '']]);
    expect(withQuantity(e, 'mass')).toMatchObject({ comparison: '<=', value: ['6 kg'] });
  });

  it('reads points one per line', () => {
    expect(parsePoints('0, 1\n\n2\t3', 'T')).toEqual({
      ok: true,
      points: [
        [0, 1],
        [2, 3],
      ],
    });
    expect(parsePoints('0, x', 'T')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/line 1/),
    });
    expect(parsePoints('0, 1', 'T')).toMatchObject({ ok: false });
  });

  it('keeps untouched values under the units they were typed in after the display units change', () => {
    const doc0 = createDocument({ id: 'd', name: 'D' });
    const c = templateCommand(doc0, 'cable-trainer');
    if (!c.ok) throw new Error(c.message);
    const r = applyCommand(doc0, c.command);
    if (!r.ok) throw new Error(r.error.message);
    const doc = r.value.document;
    const inches = { ...doc.units, length: { ...doc.units.length, unit: 'in' as const } };
    for (const req of doc.mech!.requirements!) {
      expect(requirementFromDraft(requirementDraft(req), inches)).toEqual(req);
    }
    for (const lc of doc.mech!.loadCases!) {
      expect(loadCaseFromDraft(loadCaseDraft(lc), inches)).toEqual({ ok: true, loadCase: lc });
    }
    // A bare length typed under mm stays mm; an edited field takes the current units.
    const lc = doc.mech!.loadCases![0]!;
    const bare = {
      ...lc,
      dynamic: {
        ...lc.dynamic!,
        motion: {
          ...lc.dynamic!.motion,
          stroke: { source: '600', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
        },
      },
    } as typeof lc;
    const draft = loadCaseDraft(bare);
    const same = loadCaseFromDraft(draft, inches);
    expect(same.ok && same.loadCase.dynamic!.motion).toMatchObject({
      stroke: { source: '600', lengthUnit: 'mm' },
    });
    const edited = loadCaseFromDraft({ ...draft, stroke: '24' }, inches);
    expect(edited.ok && edited.loadCase.dynamic!.motion).toMatchObject({
      stroke: { source: '24', lengthUnit: 'in' },
    });
    // A parameter does not carry over to another mode.
    const env = doc.mech!.requirements!.find((q) => q.quantity === 'envelope')!;
    const changed = requirementFromDraft(
      { ...requirementDraft(env), value: ['330 mm', '140 mm', '90'] },
      inches,
    );
    expect((changed.value as readonly { lengthUnit: string }[]).map((v) => v.lengthUnit)).toEqual([
      'mm',
      'mm',
      'in',
    ]);
  });

  it('gives an added requirement an id no row holds', () => {
    const next = { req: 5 };
    expect(nextRequirementId(next, [{ id: 'req#1' }, { id: 'req#3' }])).toBe('req#5');
    // Add, add, remove the first, add: req#5 and req#6, then req#6 stays, so req#7.
    expect(nextRequirementId(next, [{ id: 'req#1' }, { id: 'req#6' }])).toBe('req#7');
    expect(nextRequirementId({}, [])).toBe('req#1');
  });
});
