import { applyCommand, createDocument, PRINTED_KNOCKDOWN_START } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MECH_SETTINGS,
  MECH_NAMESPACE,
  factorFor,
  factorSetting,
  factorText,
  mechSettings,
  mechStarted,
  readMechSettings,
  setFactorsCommand,
} from './settings';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

describe('mech settings', () => {
  it('ship no safety factor', () => {
    expect(DEFAULT_MECH_SETTINGS.factors).toEqual({});
    expect(unwrap(mechSettings(undefined)).factors).toEqual({});
    expect(unwrap(readMechSettings({}, 1))).toEqual(DEFAULT_MECH_SETTINGS);
    expect(DEFAULT_MECH_SETTINGS.printedKnockdown).toBe(PRINTED_KNOCKDOWN_START.value);
  });

  it('read stored values over the defaults', () => {
    const s = unwrap(
      readMechSettings(
        {
          factors: { strength: 2, checks: { 'shaft.': 2.5, 'bolt.preload': 1.5 } },
          ambient: 308.15,
          simulation: { budget: 5 },
          report: { unitSystem: 'us', titleBlock: { Drawn: 'DK' } },
        },
        1,
      ),
    );
    expect(s.factors).toEqual({ strength: 2, checks: { 'shaft.': 2.5, 'bolt.preload': 1.5 } });
    expect(s.ambient).toBe(308.15);
    expect(s.simulation).toEqual({ ...DEFAULT_MECH_SETTINGS.simulation, budget: 5 });
    expect(s.report).toEqual({ unitSystem: 'us', titleBlock: { Drawn: 'DK' } });
    expect(factorFor(s, 'shaft.fatigue', 'fatigue')).toBe(2.5);
    expect(factorFor(s, 'bolt.preload', 'strength')).toBe(1.5);
    expect(factorFor(s, 'bearing.l10', 'strength')).toBe(2);
    expect(factorFor(s, 'bearing.l10', 'fatigue')).toBeUndefined();
    // With the setting it came from, for a record's provenance.
    expect(factorSetting(s, 'shaft.fatigue', 'fatigue')).toEqual({
      value: 2.5,
      key: 'factors.checks.shaft.',
    });
    expect(factorSetting(s, 'bolt.preload', 'strength')?.key).toBe('factors.checks.bolt.preload');
    expect(factorSetting(s, 'bearing.l10', 'strength')?.key).toBe('factors.strength');
    expect(factorSetting(s, 'bearing.l10', 'fatigue')).toBeUndefined();
  });

  it('refuse unknown keys, bad values and newer versions, naming the field', () => {
    const bad = (data: unknown, field?: (string | number)[]) => {
      const r = readMechSettings(data, 1);
      expect(r.ok).toBe(false);
      if (!r.ok && field) expect(r.field).toEqual(field);
    };
    bad({ extra: 1 }, ['extra']);
    bad({ factors: { strength: 0 } }, ['factors', 'strength']);
    bad({ factors: { fatigue: -1 } }, ['factors', 'fatigue']);
    bad({ factors: { strength: 1e9 } }, ['factors', 'strength']);
    bad({ factors: { checks: { 'Not A Check': 2 } } }, ['factors', 'checks', 'Not A Check']);
    bad({ printedKnockdown: 1.5 }, ['printedKnockdown']);
    bad({ fea: { targetDof: 600_000 } }, ['fea', 'targetDof']);
    bad({ report: { unitSystem: 'metric' } }, ['report', 'unitSystem']);
    bad([]);
    expect(readMechSettings({}, 2).ok).toBe(false);
    expect(readMechSettings({}, 0).ok).toBe(false);
  });

  it('start the domain with the factors the user gave, and none they did not', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    expect(mechStarted(doc.domains)).toBe(false);
    const start = setFactorsCommand(doc.domains, { strength: 2 });
    if (!start.ok) throw new Error(start.message);
    const r = applyCommand(doc, start.command);
    if (!r.ok) throw new Error(r.error.message);
    const started = r.value.document;
    expect(mechStarted(started.domains)).toBe(true);
    expect(started.domains?.[MECH_NAMESPACE]).toEqual({
      schemaVersion: 1,
      data: { factors: { strength: 2 } },
    });
    expect(unwrap(mechSettings(started.domains)).factors).toEqual({ strength: 2 });
    // Starting with neither factor starts the domain with none.
    const blank = setFactorsCommand(doc.domains, {});
    expect(blank.ok && blank.command).toMatchObject({ data: { factors: {} } });
    // Changing the factors keeps every other stored setting.
    const withAmbient = {
      [MECH_NAMESPACE]: {
        schemaVersion: 1,
        data: { factors: { strength: 2, checks: { 'shaft.': 3 } }, ambient: 300 },
      },
    };
    const next = setFactorsCommand(withAmbient, { fatigue: 1.5 });
    expect(next.ok && next.command).toMatchObject({
      data: { factors: { fatigue: 1.5, checks: { 'shaft.': 3 } }, ambient: 300 },
    });
    expect(setFactorsCommand(undefined, { strength: 0 }).ok).toBe(false);
    expect(setFactorsCommand(undefined, { fatigue: Number.NaN }).ok).toBe(false);
  });

  it("word a factor against the user's, or with nothing to compare", () => {
    expect(factorText(2.28, 2)).toBe('factor 2.28, above your 2');
    expect(factorText(1.7, 2)).toBe('factor 1.70, below your 2');
    expect(factorText(2, 2)).toBe('factor 2.00, at your 2');
    expect(factorText(2.28, undefined)).toBe('factor 2.28; not compared: no factor set');
    for (const t of [factorText(2.28, 2), factorText(1.7, 2), factorText(3, undefined)]) {
      expect(t).not.toMatch(/\b(safe|certified|compliant|pass(es|ing)?|fail(s|ing)?|ok)\b/i);
    }
  });
});
