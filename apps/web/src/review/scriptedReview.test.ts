// @vitest-environment node
/// <reference types="node" />
// A scripted feature on Main and one the agent adds (ADR 0016 decision 2): a real headless session
// on the worker engine runs only the agent's script, the real bundle builder records its bodies,
// and the regen check of a reviewer who allowed every script of the branch (**Run scripts** on an
// agent branch) matches the bundle: the bodies of Main's scripted feature, which the session never
// runs, are left out of the comparison with a note. Without the branch's base nothing is left out,
// and Main's pin is a mismatch.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import type { RegenResult } from '@manufakture/regen';
import { readBundle } from '@manufakture/review/data';
import { bundleBuilder } from '@manufakture/review';
import { BackendBundleStore, WorkerEngine } from '@manufakture/session';
import { PART, bracketDocument } from '@manufakture/session/test-fixtures';
import { ok, seeded } from '@manufakture/session/test-setup';
import { describe, expect, it } from 'vitest';
import type { PartModel } from '../model/model';
import { compareRegen, scriptedNotRunBySession, type MeasuredHere } from './review';

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

const pin = (x: number) =>
  "export const params = { height: { kind: 'length', default: 10 } };\n" +
  'export function run(ctx, p) {\n' +
  `  const s = ctx.sketch('base', { plane: 'XY', loops: [[{ kind: 'circle', id: 'rim', center: [${x}, 0], radius: 2 }]] });\n` +
  "  ctx.extrude('pin', s, { distance: p.height });\n" +
  '}\n';

function scripted(scriptId: string, featureId: string, source: string, height: string): Command[] {
  return [
    {
      type: 'setScript',
      script: { id: scriptId, name: scriptId, language: 'js', apiVersion: 1, source },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: featureId,
        kind: 'scripted',
        name: featureId,
        suppressed: false,
        script: scriptId,
        params: { height: { kind: 'expression', expression: mm(height) } },
        seed: 0,
        dependsOn: [],
      },
    },
  ] as unknown as Command[];
}

function applied(doc: ManufaktureDocument, commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** A reviewer's regen of `head` with every script of the branch allowed, and its measurements. */
async function reviewerRegen(head: ManufaktureDocument) {
  const engine = await WorkerEngine.start({ heapThresholdBytes: 1024 ** 3 });
  // Against a base with no scripts every script of the head is granted by its source: what **Run
  // scripts** on an agent branch allows.
  engine.scriptBase = { ...head, scripts: [] };
  const result = (await engine.api.regen(head, { generation: 1 })) as RegenResult;
  const parts: PartModel[] = result.parts.map((p) => ({
    partId: p.partId,
    features: p.features,
    bodies: p.bodies.map((b) => ({
      bodyId: b.bodyId,
      creator: b.creator,
      solids: 1,
      view: { id: `${p.partId}/${b.bodyId}` } as PartModel['bodies'][number]['view'],
    })),
  }));
  const shapes = new Map<string, RegenResult['parts'][number]['bodies'][number]['shape']>(
    result.parts.flatMap((p) => p.bodies.map((b) => [`${p.partId}/${b.bodyId}`, b.shape] as const)),
  );
  const measure = async (viewId: string): Promise<MeasuredHere> => {
    const shape = shapes.get(viewId);
    if (shape === undefined) return { ok: false, message: 'No such body.' };
    const reply = await engine.api.run({ generation: 1, ops: [{ op: 'properties', shape }] });
    const r = reply.results[0]!;
    if (!r.ok) return { ok: false, message: r.error.message };
    const v = r.value as unknown as {
      volume: number;
      area: number;
      boundingBox: { min: number[]; max: number[] } | null;
    };
    return { ok: true, volume: v.volume, area: v.area, boundingBox: v.boundingBox };
  };
  return { engine, parts, measure };
}

describe('a review with a scripted feature on Main and one the agent added', () => {
  it("matches the bundle with every script allowed, leaving out Main's scripted bodies", async () => {
    const main = applied(bracketDocument(), scripted('script#1', 'scripted#1', pin(25), '5 mm'));
    const seed = await seeded(main, { engine: 'worker' });
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Agent' }));
    try {
      const report = ok(
        await s.apply({
          label: 'Add a pin',
          commands: scripted('script#$own', 'scripted#$pin', pin(40), '12 mm'),
        }),
      );
      const agentPin = report.symbols['$pin']!;
      // The session ran the agent's script and not Main's.
      expect(report.errors.map((e) => e.featureId)).toEqual(['scripted#1']);
      ok(await s.submit(bundleBuilder({ imageSize: { width: 64, height: 64 } }), 'A pin'));
      const stored = await new BackendBundleStore(seed.backend).latest(seed.documentId, s.branch);
      const read = readBundle(stored!.bundle);
      if (!read.ok) throw new Error(read.message);
      const bundle = read.bundle;
      const head = s.document;
      const base = main;
      expect([...scriptedNotRunBySession(head, base)]).toEqual([`${PART}/scripted#1`]);

      const reviewer = await reviewerRegen(head);
      try {
        // Both pins are built here.
        const creators = reviewer.parts[0]!.bodies.map((b) => b.creator);
        expect(creators).toEqual(expect.arrayContaining(['scripted#1', agentPin]));
        const check = await compareRegen({
          bundle,
          document: head,
          parts: reviewer.parts,
          measure: reviewer.measure,
          base,
        });
        expect(check.mismatches).toEqual([]);
        expect(check.unverified).toEqual([]);
        expect(check.notes).toContainEqual(
          expect.stringMatching(/^Not compared: a body of scripted/),
        );
        // Without the base nothing is left out: Main's pin is a body the bundle cannot have.
        const blind = await compareRegen({
          bundle,
          document: head,
          parts: reviewer.parts,
          measure: reviewer.measure,
        });
        expect(blind.mismatches).toContainEqual(
          expect.stringMatching(/scripted#1.*in this regen, not in the bundle/),
        );
      } finally {
        await reviewer.engine.close();
      }
    } finally {
      await s.close();
    }
  }, 300_000);
});
