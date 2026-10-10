// The domain evaluation stage (ADR 0017 decision 15) against the scripted kernel: a fake domain
// asks for its bodies to be measured, evaluates with the answers and reports data and warnings;
// throws, malformed output and domain data that does not read are errors on its result, never a
// failed regen; measurements are kept by body key between regens.

import type { Command } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from './cache';
import { RegenEngine } from './engine';
import {
  checkEvaluationOutput,
  checkEvaluationQueries,
  MAX_EVALUATION_WARNINGS,
  type DomainEvaluation,
  type EvaluationAnswer,
  type EvaluationContext,
} from './evaluation';
import { ExtensionRegistry, type ExtensionDomain } from './extensions';
import { FakeKernel, FakeSolver } from './fake-kernel';
import { apply, block } from './test-helpers';

function setup(evaluation: DomainEvaluation | undefined, extra: Partial<ExtensionDomain> = {}) {
  const registry = new ExtensionRegistry();
  registry.registerDomain({
    namespace: 'fake',
    implementation: 1,
    data: {
      fake: {
        schemaVersion: 1,
        read: (data) =>
          typeof data === 'object' && data !== null && !Array.isArray(data)
            ? { ok: true, value: data }
            : { ok: false, message: 'expected an object' },
      },
    },
    ...(evaluation === undefined ? {} : { evaluation }),
    ...extra,
  });
  const kernel = new FakeKernel();
  const engine = new RegenEngine({
    kernel,
    solver: new FakeSolver(),
    cache: new MemoryCache(),
    extensions: registry,
  });
  return { kernel, engine };
}

async function regen(engine: RegenEngine, doc = block()) {
  const r = await engine.regen(doc);
  if (r === null) throw new Error('superseded');
  return r;
}

const fakeData = (data: unknown): Command => ({
  type: 'setDomainData',
  namespace: 'fake',
  schemaVersion: 1,
  data: data as never,
});

/** Measures every body of every part and reports their volumes; warns on any above `limit`. */
function volumes(seen: { contexts: EvaluationContext[]; answers: EvaluationAnswer[][] }) {
  return {
    measure(ctx) {
      seen.contexts.push(ctx);
      return ctx.parts.flatMap((p) =>
        p.bodies.map((body) => ({ type: 'body' as const, part: p.partId, body })),
      );
    },
    evaluate(ctx, answers) {
      seen.answers.push([...answers]);
      const limit = (ctx.data.fake as { limit?: number } | undefined)?.limit;
      const records = answers.map((a) => ({
        id: `${a.part}/${a.body}`,
        volume: a.measure?.volume ?? null,
      }));
      return {
        data: { records },
        warnings: records
          .filter((r) => limit !== undefined && (r.volume ?? 0) > limit)
          .map((r) => ({
            code: 'mech-check' as const,
            message: `${r.id}: volume ${r.volume} above ${limit}`,
            check: 'fake.volume',
            recordId: `fake.volume@${r.id}`,
            status: 'warning' as const,
          })),
      };
    },
  } satisfies DomainEvaluation;
}

describe('the domain evaluation stage', () => {
  it('measures what the first step asks, then reports the second step’s data and warnings', async () => {
    const seen = { contexts: [] as EvaluationContext[], answers: [] as EvaluationAnswer[][] };
    const { engine, kernel } = setup(volumes(seen));
    const r = await regen(engine, apply(block(), fakeData({ limit: 1000 })));
    const ctx = seen.contexts[0]!;
    expect(ctx.parts).toHaveLength(1);
    expect(ctx.parts[0]!.built).toBe(true);
    expect(ctx.data).toEqual({ fake: { limit: 1000 } });
    expect(ctx.variables.get('width')).toBeDefined();
    expect(kernel.measureOps).toHaveLength(1);
    expect(kernel.measureOps[0]).toMatchObject({ op: 'measure', targets: [], body: true });
    const answer = seen.answers[0]![0]!;
    expect(answer.measure?.volume).toBe(24000);
    expect(answer.measure?.centerOfMass).toEqual([20, 15, 10]);
    expect(r.evaluations).toHaveLength(1);
    const ev = r.evaluations![0]!;
    expect(ev.namespace).toBe('fake');
    expect(ev.error).toBeUndefined();
    expect(ev.data).toEqual({ records: [{ id: `part#1/${answer.body}`, volume: 24000 }] });
    expect(ev.warnings).toEqual([
      expect.objectContaining({ code: 'mech-check', check: 'fake.volume', status: 'warning' }),
    ]);
    expect(ev.ms).toBeGreaterThanOrEqual(0);
  });

  it('keeps measurements by body key: an unchanged body is not measured again', async () => {
    const seen = { contexts: [] as EvaluationContext[], answers: [] as EvaluationAnswer[][] };
    const { engine, kernel } = setup(volumes(seen));
    const doc = block();
    await regen(engine, doc);
    await regen(engine, apply(doc, fakeData({ limit: 1 })));
    expect(kernel.measureOps).toHaveLength(1);
    expect(seen.answers[1]![0]!.measure?.volume).toBe(24000);
  });

  it('answers a body that is not there with no measure and a message', async () => {
    const seen: EvaluationAnswer[][] = [];
    const { engine, kernel } = setup({
      measure: () => [{ type: 'body', part: 'part#9', body: 'nope' }],
      evaluate: (_ctx, answers) => {
        seen.push([...answers]);
        return {};
      },
    });
    const r = await regen(engine);
    expect(kernel.measureOps).toHaveLength(0);
    expect(seen[0]).toEqual([
      { type: 'body', part: 'part#9', body: 'nope', measure: null, message: expect.any(String) },
    ]);
    // Nothing to report: no entry, and no `evaluations` at all.
    expect(r.evaluations).toBeUndefined();
  });

  it('turns a throw, a malformed result or unreadable domain data into an error, not a failed regen', async () => {
    const thrown = setup({
      evaluate: () => {
        throw new Error('the gauge is broken');
      },
    });
    const a = await regen(thrown.engine);
    expect(a.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    expect(a.evaluations![0]!.error).toMatchObject({
      code: 'extension',
      message: expect.stringContaining('the gauge is broken'),
    });

    const badCode = setup({
      evaluate: () => ({ warnings: [{ code: 'thin-wall', message: 'x' }] as never }),
    });
    expect((await regen(badCode.engine)).evaluations![0]!.error?.message).toMatch(/warning 0/);

    const badQueries = setup({ measure: () => 'all' as never, evaluate: () => ({}) });
    expect((await regen(badQueries.engine)).evaluations![0]!.error?.message).toMatch(/queries/);

    const unread = setup({ evaluate: () => ({ data: { ran: true } }) });
    const d = await regen(unread.engine, apply(block(), fakeData([1, 2])));
    expect(d.evaluations![0]!.error?.message).toMatch(/expected an object/);
    expect(d.evaluations![0]!.data).toBeUndefined();
  });

  it('gives no evaluations when no domain has a stage', async () => {
    const { engine, kernel } = setup(undefined);
    const r = await regen(engine);
    expect(r.evaluations).toBeUndefined();
    expect(kernel.measureOps).toHaveLength(0);
  });

  it('refuses a stage without an evaluate function at registration', () => {
    expect(() => setup({} as DomainEvaluation)).toThrow(/evaluate function/);
  });
});

describe('checking what a stage returns', () => {
  it('accepts body queries only, up to the limit', () => {
    expect(checkEvaluationQueries('x', [{ type: 'body', part: 'p', body: 'b' }]).ok).toBe(true);
    expect(checkEvaluationQueries('x', [{ type: 'obb', body: 'b' }]).ok).toBe(false);
    expect(
      checkEvaluationQueries('x', new Array(10_001).fill({ type: 'body', part: 'p', body: 'b' }))
        .ok,
    ).toBe(false);
  });

  it('copies the data as JSON and caps the warnings with a count', () => {
    const many = Array.from({ length: MAX_EVALUATION_WARNINGS + 10 }, (_, i) => ({
      code: 'mech-check',
      message: `w${i}`,
      check: 'c',
      recordId: `c@${i}`,
      status: 'unknown',
    }));
    const r = checkEvaluationOutput('x', { data: { a: 1, f: undefined }, warnings: many });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data).toEqual({ a: 1 });
    expect(r.value.warnings).toHaveLength(MAX_EVALUATION_WARNINGS);
    expect(r.value.warnings.at(-1)!.message).toBe('11 more warnings not shown');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(checkEvaluationOutput('x', { data: cyclic }).ok).toBe(false);
  });
});
