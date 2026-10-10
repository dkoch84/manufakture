// The checks framework (T9.5a): the registry, the sample check `cable.tension` end to end through
// the evaluation stage (including an `unknown` naming the missing simulation peak), the factor
// against the user's own and with none set, overrides, recomputing only when inputs change,
// measured geometry as an input, and the wording.

import { calc, type CalcRecord } from '@manufakture/calc';
import {
  applyCommand,
  createDocument,
  type CatalogEntry,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { EvaluationAnswer, EvaluationContext } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { DEFAULT_MECH_SETTINGS, mechSettings, type MechSettings } from '../settings';
import { CABLE_TENSION_SERIES, cableTension } from './cable';
import {
  builtinChecks,
  createMechEvaluation,
  mechEvaluationOf,
  type MechEvaluation,
} from './evaluation';
import { measuredMassInput } from './measured';
import { CheckRegistry, type CheckEntry } from './registry';
import { simulationFrom } from './simulation';
import type { CheckDefinition } from './types';
import { formatSI, statusLabel } from './wording';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const rope: CatalogEntry = {
  id: 'entry#1',
  version: 1,
  family: 'rope',
  fieldsVersion: 1,
  maker: 'Acme',
  partNumber: 'HMPE 3 mm',
  description: 'Braided HMPE',
  ratings: { minimumBreakingLoad: { value: 4500 } },
  sources: [],
  verified: false,
};

/** A rope, a static load case pulling 890 N, and a dynamic one (a rep, simulated). */
function trainer(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    { type: 'setCatalogEntry', entry: rope },
    {
      type: 'setPurchasedUse',
      use: {
        id: 'pp#2',
        entry: { source: 'document', id: 'entry#1' },
        alternates: [],
        name: 'Rope',
      },
    },
    {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#3',
        name: 'Hold',
        static: [{ kind: 'cable', name: 'Max pull', force: x('890 N'), angle: x('0 deg') }],
      },
    },
    {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#4',
        name: 'Rep',
        dynamic: {
          mode: { kind: 'constant' },
          force: x('400 N'),
          motion: {
            kind: 'half-cosine',
            stroke: x('1 m'),
            pullSpeed: x('1 m/s'),
            returnSpeed: x('1 m/s'),
            pause: x('0.5 s'),
          },
          reps: x('10'),
        },
      },
    },
  );
}

function withFactors(
  doc: ManufaktureDocument,
  factors: MechSettings['factors'],
): ManufaktureDocument {
  return apply(doc, {
    type: 'setDomainData',
    namespace: 'mech',
    schemaVersion: 1,
    data: { factors } as never,
  });
}

function context(doc: ManufaktureDocument): EvaluationContext {
  const settings = mechSettings(doc.domains);
  if (!settings.ok) throw new Error(settings.message);
  return {
    document: doc,
    data: doc.domains?.mech === undefined ? {} : { mech: settings.value },
    variables: new Map(),
    parts: [],
    assemblies: [],
  };
}

function evaluate(
  stage: ReturnType<typeof createMechEvaluation>,
  doc: ManufaktureDocument,
  answers: EvaluationAnswer[] = [],
) {
  const out = stage.evaluate(context(doc), answers);
  const data = out.data as unknown as MechEvaluation | undefined;
  return { data, warnings: [...(out.warnings ?? [])], entry: (id: string) => byId(data, id) };
}

function byId(data: MechEvaluation | undefined, id: string): CheckEntry {
  const e = data?.checks.find((c) => c.record.id === id);
  if (e === undefined) throw new Error(`no record ${id}`);
  return e;
}

const WORDS = /\b(safe|safety|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*|ok)\b/i;

describe('the check registry', () => {
  it('registers checks by id, in id order, and refuses bad or repeated ids', () => {
    const r = new CheckRegistry();
    const b = { ...cableTension, id: 'b.second' };
    r.register(b);
    const off = r.register(cableTension);
    expect(r.list().map((c) => c.id)).toEqual(['b.second', 'cable.tension']);
    expect(() => r.register(cableTension)).toThrow(/already registered/);
    expect(() => r.register({ ...cableTension, id: 'Cable' })).toThrow(/not a check id/);
    expect(() => r.register({ ...cableTension, id: 'x.y', version: 0 })).toThrow(/version/);
    off();
    expect(r.get('cable.tension')).toBeUndefined();
    expect(
      builtinChecks()
        .list()
        .map((c) => c.id),
    ).toContain('cable.tension');
  });
});

describe('cable.tension end to end through the evaluation stage', () => {
  it('states the factor against your own, and names the missing simulation peak', () => {
    const stage = createMechEvaluation({ implementation: 1 });
    const { data, warnings, entry } = evaluate(stage, withFactors(trainer(), { strength: 2 }));
    expect(data?.disclaimer).toBe(DISCLAIMER_SHORT);
    expect(data?.checks.map((c) => c.record.id)).toEqual([
      'cable.tension@pp#2/lc#3',
      'cable.tension@pp#2/lc#4',
    ]);

    const hold = entry('cable.tension@pp#2/lc#3');
    expect(hold.record).toMatchObject({
      check: 'cable.tension',
      status: 'ok',
      limit: 2,
      limitKind: 'at-least',
      loadCase: 'lc#3',
      subject: [
        { kind: 'purchased', use: 'pp#2' },
        { kind: 'loadCase', loadCase: 'lc#3' },
      ],
      inputRefs: {
        F: { kind: 'given' },
        F_break: {
          kind: 'catalog',
          entry: { source: 'document', id: 'entry#1' },
          field: 'minimumBreakingLoad',
        },
        n_req: { kind: 'setting', key: 'factors.strength' },
      },
    });
    expect(hold.record.result).toBeCloseTo(4500 / 890, 9);
    expect(hold.record.inputs.map((i) => i.source)).toEqual([
      'load case Hold (lc#3), cable pull "Max pull"',
      'entry#1 Rope, minimum breaking load (catalog data, unverified)',
      'your factor, setting factors.strength',
    ]);
    expect(hold.text).toBe(
      'Cable tension, Rope in Hold: load 890 N, rated load 4.50 kN; factor 5.06, above your 2',
    );

    const rep = entry('cable.tension@pp#2/lc#4');
    expect(rep.record.status).toBe('unknown');
    expect(rep.record.result).toBeNull();
    expect(rep.record.missing).toEqual(['Peak cable tension']);
    expect(rep.record.note).toBe('Missing: Peak cable tension (no simulation of lc#4 has run)');
    expect(rep.record.inputRefs.F).toEqual({
      kind: 'simulation',
      loadCase: 'lc#4',
      series: CABLE_TENSION_SERIES,
      statistic: 'peak',
    });
    expect(rep.text).toMatch(
      /^Cable tension, Rope in Rep: not computed\. Missing: Peak cable tension/,
    );

    expect(warnings).toEqual([
      {
        code: 'mech-check',
        message: rep.text,
        check: 'cable.tension',
        recordId: 'cable.tension@pp#2/lc#4',
        status: 'unknown',
      },
    ]);
  });

  it('computes the dynamic case from the simulation’s peak once it has run', () => {
    const stage = createMechEvaluation({
      implementation: 1,
      simulation: () => simulationFrom({ 'lc#4': { [`${CABLE_TENSION_SERIES}:peak`]: 2500 } }),
    });
    const { entry, warnings } = evaluate(stage, withFactors(trainer(), { strength: 2 }));
    const rep = entry('cable.tension@pp#2/lc#4');
    expect(rep.record.status).toBe('warning');
    expect(rep.record.result).toBeCloseTo(1.8, 9);
    expect(rep.text).toBe(
      'Cable tension, Rope in Rep: load 2.50 kN, rated load 4.50 kN; factor 1.80, below your 2',
    );
    expect(warnings).toEqual([
      expect.objectContaining({ recordId: rep.record.id, status: 'warning', message: rep.text }),
    ]);
  });

  it('with no factor set: the factor with nothing to compare, and no warning', () => {
    const stage = createMechEvaluation({
      implementation: 1,
      simulation: () => simulationFrom({ 'lc#4': { 'cable.tension:peak': 4000 } }),
    });
    const { entry, warnings } = evaluate(stage, trainer());
    const rep = entry('cable.tension@pp#2/lc#4');
    expect(rep.record.status).toBe('ok');
    expect(rep.record.limit).toBeUndefined();
    expect(rep.record.inputRefs.n_req).toBeUndefined();
    expect(rep.text).toBe(
      'Cable tension, Rope in Rep: load 4.00 kN, rated load 4.50 kN; factor 1.13; not compared: no factor set',
    );
    expect(warnings).toEqual([]);
  });

  it('reports nothing for a document that does not use the domain', () => {
    const stage = createMechEvaluation({ implementation: 1 });
    const doc = createDocument({ id: 'd', name: 'D' });
    expect(stage.measure!(context(doc))).toEqual([]);
    expect(stage.evaluate(context(doc), [])).toEqual({});
  });

  it('never calls anything safe, passing, failing, certified, compliant or OK', () => {
    const stage = createMechEvaluation({
      implementation: 1,
      simulation: () => simulationFrom({ 'lc#4': { 'cable.tension:peak': 2500 } }),
    });
    for (const doc of [trainer(), withFactors(trainer(), { strength: 2 })]) {
      const { data, warnings } = evaluate(stage, doc);
      for (const { record, text } of data!.checks) {
        for (const s of [
          text,
          record.title,
          record.method,
          record.note ?? '',
          ...record.assumptions,
        ]) {
          expect(s).not.toMatch(WORDS);
        }
      }
      for (const w of warnings) expect(w.message).not.toMatch(WORDS);
    }
  });
});

describe('check overrides', () => {
  const override = (o: Record<string, unknown>): Command => ({
    type: 'setCheckOverride',
    override: o as never,
  });

  it('takes the most specific factor: subject over all, exact over family, over the setting', () => {
    const stage = createMechEvaluation({ implementation: 1 });
    let doc = withFactors(trainer(), { strength: 2, checks: { 'cable.': 3 } });
    expect(evaluate(stage, doc).entry('cable.tension@pp#2/lc#3').record).toMatchObject({
      limit: 3,
      inputRefs: { n_req: { kind: 'setting', key: 'factors.checks.cable.' } },
    });
    doc = apply(
      doc,
      override({ id: 'chk#5', check: 'cable.', factor: x('4') }),
      override({ id: 'chk#6', check: 'cable.tension', factor: x('5') }),
      override({
        id: 'chk#7',
        check: 'cable.',
        subject: { kind: 'loadCase', loadCase: 'lc#3' },
        factor: x('6'),
      }),
    );
    const { entry } = evaluate(stage, doc);
    expect(entry('cable.tension@pp#2/lc#3').record).toMatchObject({
      limit: 6,
      status: 'warning',
      inputRefs: { n_req: { kind: 'override', id: 'chk#7' } },
    });
    expect(entry('cable.tension@pp#2/lc#4').record.missing).toEqual(['Peak cable tension']);
    expect(entry('cable.tension@pp#2/lc#4').record.inputRefs.n_req).toEqual({
      kind: 'override',
      id: 'chk#6',
    });
  });

  it('replaces an input by its symbol, citing the override', () => {
    const stage = createMechEvaluation({ implementation: 1 });
    const doc = apply(
      withFactors(trainer(), { strength: 2 }),
      override({
        id: 'chk#5',
        check: 'cable.tension',
        subject: { kind: 'loadCase', loadCase: 'lc#4' },
        inputs: { F: x('1000 N'), unused: x('3'), finish: 'polished' },
      }),
    );
    const rep = evaluate(stage, doc).entry('cable.tension@pp#2/lc#4').record;
    expect(rep.status).toBe('ok');
    expect(rep.result).toBeCloseTo(4.5, 9);
    expect(rep.inputRefs.F).toEqual({ kind: 'override', id: 'chk#5' });
    expect(rep.inputs[0]!.source).toBe('your value, override chk#5');
    expect(Object.keys(rep.inputRefs)).not.toContain('unused');
  });

  it('a factor or input that does not evaluate makes the record unknown, and says which', () => {
    const stage = createMechEvaluation({ implementation: 1 });
    const bad = apply(
      withFactors(trainer(), { strength: 2 }),
      override({ id: 'chk#5', check: 'cable.tension', factor: x('0') }),
      override({
        id: 'chk#6',
        check: 'cable.tension',
        subject: { kind: 'loadCase', loadCase: 'lc#4' },
        inputs: { F: x('12 m') },
      }),
    );
    const { entry, warnings } = evaluate(stage, bad);
    const hold = entry('cable.tension@pp#2/lc#3');
    expect(hold.record.status).toBe('unknown');
    expect(hold.record.result).toBeCloseTo(4500 / 890, 9);
    expect(hold.record.limit).toBeUndefined();
    expect(hold.record.note).toMatch(/^Not compared: your factor in chk#5 is 0/);
    expect(hold.text).toMatch(/factor 5\.06; not compared\. Not compared: your factor in chk#5/);
    const rep = entry('cable.tension@pp#2/lc#4');
    expect(rep.record.missing).toEqual(['Peak cable tension']);
    expect(rep.record.note).toMatch(/chk#6 gives "12 m", which does not evaluate/);
    expect(warnings.map((w) => w.code === 'mech-check' && w.status)).toEqual([
      'unknown',
      'unknown',
    ]);
  });
});

describe('records are recomputed only when their inputs change', () => {
  it('serves unchanged records from the cache and recomputes the one whose input changed', () => {
    const stage = createMechEvaluation({ implementation: 1 });
    const doc = withFactors(trainer(), { strength: 2 });
    const first = evaluate(stage, doc);
    expect(stage.cache.computed).toBe(2);
    const again = evaluate(stage, doc);
    expect(stage.cache.computed).toBe(2);
    expect(again.entry('cable.tension@pp#2/lc#3').record).toBe(
      first.entry('cable.tension@pp#2/lc#3').record,
    );
    // An unrelated edit (a variable) changes nothing a record reads.
    const renamed = apply(doc, { type: 'setVariable', name: 'unused', expression: x('3') });
    evaluate(stage, renamed);
    expect(stage.cache.computed).toBe(2);
    // The static pull changes: only that record is computed again.
    const heavier = apply(doc, {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#3',
        name: 'Hold',
        static: [{ kind: 'cable', name: 'Max pull', force: x('1000 N'), angle: x('0 deg') }],
      },
    });
    const third = evaluate(stage, heavier);
    expect(stage.cache.computed).toBe(3);
    expect(third.entry('cable.tension@pp#2/lc#3').record.result).toBeCloseTo(4.5, 9);
    // The factor is an input too.
    evaluate(stage, withFactors(heavier, { strength: 3 }));
    expect(stage.cache.computed).toBe(5);
    // The cache keeps only what the last run used.
    expect(stage.cache.size).toBe(2);
  });
});

describe('measured geometry and the framework’s guards', () => {
  /** A check of one body's mass against a limit the user gives as an override input. */
  const massCheck: CheckDefinition = {
    id: 'test.mass',
    title: 'Mass',
    version: 1,
    measures: () => [{ part: 'part#1', body: 'b1' }],
    subjects: (model) => [
      {
        location: 'part#1/b1',
        title: 'Mass of the box',
        subject: [{ kind: 'body', part: 'part#1', body: 'b1' }],
        inputs: { m: measuredMassInput(model, 'part#1', 'b1') },
      },
    ],
    compute: ({ inputs, options }) =>
      calc(
        {
          id: 'test.mass',
          title: 'Mass',
          method: 'Measured',
          formula: 'm',
          unit: 'kg',
          sources: [{ title: 'test', locator: '-' }],
          inputs: { m: { name: 'Mass', symbol: 'm', unit: 'kg' } },
        },
        { m: inputs.m },
        options,
        (v) => ({ result: v.m }),
      ),
  };

  function docWithPart(material?: string): ManufaktureDocument {
    let doc = apply(createDocument({ id: 'd', name: 'D' }), {
      type: 'setDomainData',
      namespace: 'mech',
      schemaVersion: 1,
      data: {} as never,
    });
    doc = {
      ...doc,
      parts: doc.parts.map((p) => (material ? { ...p, material: material as 'steel' } : p)),
    };
    return doc;
  }

  const box: EvaluationAnswer = {
    type: 'body',
    part: 'part#1',
    body: 'b1',
    measure: {
      volume: 24000,
      area: 5200,
      centerOfMass: [20, 15, 10],
      volumeInertia: null,
      boundingBox: null,
    },
  };

  it('asks regen for the bodies the checks need and reads the answers in SI', () => {
    const registry = new CheckRegistry();
    registry.register(massCheck);
    const stage = createMechEvaluation({ implementation: 1, registry });
    const doc = docWithPart('aluminium-6061');
    expect(stage.measure!(context(doc))).toEqual([{ type: 'body', part: 'part#1', body: 'b1' }]);
    const r = evaluate(stage, doc, [box]).entry('test.mass@part#1/b1').record;
    expect(r.result).toBeCloseTo(24000e-9 * 2700, 6);
    expect(r.inputRefs.m).toEqual({
      kind: 'measured',
      what: 'mass',
      subject: { kind: 'body', part: 'part#1', body: 'b1' },
    });
  });

  it('names a body that was not measured, or has no material', () => {
    const registry = new CheckRegistry();
    registry.register(massCheck);
    const stage = createMechEvaluation({ implementation: 1, registry });
    const gone = evaluate(stage, docWithPart('aluminium-6061'), [
      { ...box, measure: null, message: 'part#1 has no body b1 in this regen' },
    ]).entry('test.mass@part#1/b1').record;
    expect(gone.status).toBe('unknown');
    expect(gone.note).toBe(
      'Missing: Mass of part#1 b1 (part#1 b1 is not measured: part#1 has no body b1 in this regen)',
    );
    const bare = evaluate(stage, docWithPart(), [box]).entry('test.mass@part#1/b1').record;
    expect(bare.note).toMatch(/has no material/);
  });

  it('never lets a non-finite factor read as fine, and contains a check that throws', () => {
    const infinite: CheckDefinition = {
      id: 'test.infinite',
      title: 'Infinite',
      version: 1,
      subjects: () => [{ location: 'x', title: 'Infinite', subject: [], inputs: {} }],
      compute: ({ options }): CalcRecord => ({
        ...options,
        method: 'm',
        formula: 'f',
        inputs: [],
        result: 2,
        unit: '1',
        derived: [],
        limit: 0,
        limitKind: 'at-least',
        margin: Number.POSITIVE_INFINITY,
        assumptions: [],
        sources: [],
        status: 'ok',
      }),
    };
    const throws: CheckDefinition = {
      ...infinite,
      id: 'test.throws',
      compute: () => {
        throw new Error('division by a cat');
      },
    };
    const lost: CheckDefinition = {
      ...infinite,
      id: 'test.lost',
      subjects: () => {
        throw new Error('no subjects today');
      },
    };
    const registry = new CheckRegistry();
    for (const c of [infinite, throws, lost]) registry.register(c);
    const stage = createMechEvaluation({ implementation: 1, registry });
    const { entry, warnings } = evaluate(stage, docWithPart());
    expect(entry('test.infinite@x').record.status).toBe('unknown');
    expect(entry('test.infinite@x').record).not.toHaveProperty('margin');
    expect(entry('test.infinite@x').record.note).toMatch(/no finite margin/);
    expect(entry('test.throws@x').record.note).toBe(
      'The check could not compute: division by a cat',
    );
    expect(entry('test.lost@all').record.note).toMatch(/no subjects today/);
    expect(warnings).toHaveLength(3);
  });
});

describe('reading the evaluation back', () => {
  it('finds the mechanical data in a regen result’s evaluations, and only a shape it knows', () => {
    const data = { version: 1, checks: [], disclaimer: 'x' };
    expect(mechEvaluationOf([{ namespace: 'mech', data }])).toEqual(data);
    expect(
      mechEvaluationOf([{ namespace: 'mech', data: { ...data, version: 9 } }]),
    ).toBeUndefined();
    expect(mechEvaluationOf([{ namespace: 'wood', data }])).toBeUndefined();
    expect(mechEvaluationOf(undefined)).toBeUndefined();
  });

  it('labels a status in words, never the internal ok', () => {
    const stage = createMechEvaluation({
      implementation: 1,
      simulation: () => simulationFrom({ 'lc#4': { 'cable.tension:peak': 2500 } }),
    });
    const labels = (doc: ManufaktureDocument) =>
      evaluate(stage, doc).data!.checks.map((c) => statusLabel(c.record, c.factor !== undefined));
    expect(labels(withFactors(trainer(), { strength: 2 }))).toEqual([
      'above your factor',
      'below your factor',
    ]);
    expect(labels(trainer())).toEqual([
      'not compared: no factor set',
      'not compared: no factor set',
    ]);
    const none = createMechEvaluation({ implementation: 1 });
    expect(evaluate(none, trainer()).data!.checks.map((c) => statusLabel(c.record, true))).toEqual([
      'not compared: no factor set',
      'not computed',
    ]);
  });

  it('formats SI values with a prefix where the unit takes one', () => {
    expect(formatSI(4500, 'N')).toBe('4.50 kN');
    expect(formatSI(182e6, 'Pa')).toBe('182 MPa');
    expect(formatSI(890, 'N')).toBe('890 N');
    expect(formatSI(0.0648, 'kg')).toBe('0.0648 kg');
    expect(formatSI(2.28, '1')).toBe('2.28');
  });

  it('keeps settings defaults when the document has no domains.mech', () => {
    expect(DEFAULT_MECH_SETTINGS.factors).toEqual({});
  });
});
