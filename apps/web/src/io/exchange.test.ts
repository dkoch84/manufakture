// The kernel exchange with a scripted client: which ops it sends, at which
// generation, and how it reads the replies. The ops themselves run against
// the real kernel in packages/kernel (exchange.test.ts) and in the e2e.

import type { BatchReply, FeatureOutcome, Frame, KernelOp, OpResult } from '@manufakture/kernel';
import type { KernelClient } from '@manufakture/kernel/client';
import { describe, expect, it, vi } from 'vitest';
import { boxBody } from '../viewport/testMeshes';
import { kernelExchange, type KernelBody } from './exchange';

type Reply = Partial<BatchReply> & { results: OpResult[] };

function scripted(replies: (Reply | null)[]) {
  const sent: { ops: readonly KernelOp[]; generation: number | undefined }[] = [];
  const released: number[][] = [];
  const client = {
    latestGeneration: 7,
    release: vi.fn(async (shapes: number[]) => {
      released.push([...shapes]);
      return { released: shapes, unknown: [] };
    }),
    submit: vi.fn(async (ops: readonly KernelOp[], generation?: number) => {
      sent.push({ ops, generation });
      const r = replies.shift();
      if (r === undefined) throw new Error('no reply scripted');
      return r === null ? null : { status: 'done', names: [], generation: 7, ...r };
    }),
  } as unknown as KernelClient;
  return { client, sent, released };
}

const ok = (op: string, value: unknown): OpResult =>
  ({ ok: true, op, value, ms: 1 }) as unknown as OpResult;
const failed = (op: string, message: string): OpResult =>
  ({ ok: false, op, error: { code: 'kernel', operation: op, message }, ms: 1 }) as OpResult;

const registry = () =>
  new Map<string, KernelBody>([
    ['demo-part', { shape: 3 as never, name: 'Demo part', role: 'part' }],
  ]);

describe('kernelExchange', () => {
  it('tessellates the bodies at the latest generation, so an export never cancels an edit', async () => {
    const mesh = boxBody().mesh;
    const { client, sent } = scripted([{ results: [ok('tessellate', mesh)] }]);
    const { exchanger } = kernelExchange(() => client, registry());
    expect(exchanger.bodies()).toEqual([{ id: 'demo-part', name: 'Demo part' }]);
    const r = await exchanger.tessellate(['demo-part'], { linear: 0.02, angular: 0.25 });
    expect(r).toEqual({ ok: true, value: [{ name: 'Demo part', mesh }] });
    expect(sent).toEqual([
      {
        ops: [{ op: 'tessellate', shape: 3, deflection: { linear: 0.02, angular: 0.25 } }],
        generation: 7,
      },
    ]);
  });

  it('exports STEP with the body names', async () => {
    const data = new TextEncoder().encode('ISO-10303-21;');
    const { client, sent } = scripted([{ results: [ok('exportStep', { data })] }]);
    const { exchanger } = kernelExchange(() => client, registry());
    expect(await exchanger.exportStep(['demo-part'])).toEqual({ ok: true, value: data });
    expect(sent[0]!.ops).toEqual([{ op: 'exportStep', bodies: [{ shape: 3, name: 'Demo part' }] }]);
  });

  it('exports STEP with members through the regen worker, the bodies written with them', async () => {
    const data = new TextEncoder().encode('ISO-10303-21;');
    const { client } = scripted([]);
    const memberBodies = vi.fn(async () => ({
      generation: 7,
      partId: 'part#1',
      bodies: [
        { id: 'wall:s0', ok: true },
        { id: 'wall:s1', ok: false, error: 'no' },
      ],
      missing: ['wall:gone'],
      step: data as Uint8Array | null,
      batches: 2,
      ms: 1,
    }));
    const withMembers = { ...client, memberBodies } as typeof client & {
      memberBodies: typeof memberBodies;
    };
    const { exchanger } = kernelExchange(() => withMembers, registry());
    const names = new Map([['demo-part', 'Sheathing']]);
    expect(
      await exchanger.exportStepWithMembers!(['demo-part'], names, 'part#1', [
        'wall:s0',
        'wall:s1',
        'wall:gone',
      ]),
    ).toEqual({ ok: true, value: { data, members: 1, failed: ['wall:s1', 'wall:gone'] } });
    expect(memberBodies).toHaveBeenCalledWith('part#1', ['wall:s0', 'wall:s1', 'wall:gone'], {
      step: true,
      with: [{ shape: 3, name: 'Sheathing' }],
    });
    // Superseded by a newer regen, or nothing built: no file.
    memberBodies.mockResolvedValueOnce(null as never);
    expect((await exchanger.exportStepWithMembers!([], undefined, 'part#1', ['x'])).ok).toBe(false);
    // A plain kernel client builds no members.
    const plain = kernelExchange(() => client, registry()).exchanger;
    expect(await plain.exportStepWithMembers!([], undefined, 'part#1', ['x'])).toEqual({
      ok: false,
      message: 'This kernel builds no framing members.',
    });
  });

  it('says the kernel restarted when it was recycled during a STEP member export', async () => {
    const { client } = scripted([]);
    // The bodies written with the members belong to the instance before the recycle: the
    // export op fails with `unknown-shape`, and the regen worker rejects with its message.
    const memberBodies = vi.fn(async (): Promise<null> => {
      throw new Error('the STEP export of the members failed: unknown shape id 3');
    });
    const withMembers = { ...client, memberBodies } as typeof client & {
      memberBodies: typeof memberBodies;
    };
    const { exchanger } = kernelExchange(() => withMembers, registry());
    const want = { ok: false, message: 'The kernel restarted during the export; try again.' };
    expect(
      await exchanger.exportStepWithMembers!(['demo-part'], undefined, 'part#1', ['x']),
    ).toEqual(want);
    // The worker's retries ran out against repeated recycles: the same message.
    memberBodies.mockRejectedValueOnce(new Error('kernel shapes were lost to a recycle'));
    expect(await exchanger.exportStepWithMembers!([], undefined, 'part#1', ['x'])).toEqual(want);
    // Any other failure is not mistaken for one.
    memberBodies.mockRejectedValueOnce(new Error('member bodies need a completed regen'));
    await expect(exchanger.exportStepWithMembers!([], undefined, 'part#1', ['x'])).rejects.toThrow(
      'member bodies need a completed regen',
    );
  });

  it('sections a part body at the latest generation, and refuses an unknown one', async () => {
    const section = { height: 2, regions: [], open: [] };
    const { client, sent } = scripted([
      { results: [ok('section', section)] },
      { results: [failed('section', 'no plane')] },
    ]);
    const { exchanger } = kernelExchange(() => client, registry());
    const f: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
    expect(await exchanger.section!('demo-part', f, 2)).toEqual({ ok: true, value: section });
    expect(sent).toEqual([
      { ops: [{ op: 'section', shape: 3, frame: f, height: 2 }], generation: 7 },
    ]);
    expect(await exchanger.section!('demo-part', f, 2, 0.05)).toEqual({
      ok: false,
      message: 'The section failed: no plane',
    });
    expect(sent[1]!.ops).toEqual([
      { op: 'section', shape: 3, frame: f, height: 2, deflection: 0.05 },
    ]);
    expect((await exchanger.section!('nope', f, 0)).ok).toBe(false);
  });

  it('imports STEP as an import feature, registers the body and fills its names', async () => {
    const box = boxBody({ named: false });
    const outcome = {
      ok: true,
      bodies: [{ id: 'import#1', shape: 12 }],
      errors: [],
    } as unknown as FeatureOutcome;
    const { client, sent } = scripted([
      {
        results: [ok('feature', outcome), ok('tessellate', box.mesh), ok('topology', box.topology)],
        names: [],
      },
    ]);
    const reg = registry();
    const { exchanger, measurer } = kernelExchange(() => client, reg);
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    const r = await exchanger.importStep(bytes, 'import#1', 'Bracket');
    if (!r.ok) throw new Error(r.message);
    expect(r.value.id).toBe('import#1');
    expect(r.value.names).toContain('placeholder:face:1');
    expect(sent[0]!.ops[0]).toEqual({
      op: 'feature',
      bodies: [],
      feature: { kind: 'import', id: 'import#1', step: bytes, mode: 'new' },
    });
    // At the latest generation: an import must not cancel the regen in flight, which would
    // leave the model stale when the import then fails.
    expect(sent[0]!.generation).toBe(7);
    expect(reg.get('import#1')).toEqual({ shape: 12, name: 'Bracket', role: 'reference' });
    // A reference body: measured, never exported.
    expect(exchanger.bodies().map((b) => b.id)).toEqual(['demo-part']);
    expect(await exchanger.tessellate(['import#1'], { linear: 1, angular: 1 })).toEqual({
      ok: false,
      message: 'The kernel has no body import#1.',
    });

    // The measurer finds the new body.
    const measured = scripted([{ results: [ok('measure', { items: [], body: null })] }]);
    const m = kernelExchange(() => measured.client, reg).measurer;
    await m.measure('import#1', [], true);
    expect(measured.sent[0]!.ops).toEqual([{ op: 'measure', shape: 12, targets: [], body: true }]);
    expect(await measurer.measure('nope', [], true)).toEqual({
      ok: false,
      message: 'The kernel has no body nope.',
    });
  });

  it('retain releases the reference bodies it is not given, outside the batch queue', async () => {
    const { client, sent, released } = scripted([]);
    const reg = registry();
    reg.set('import#1', { shape: 12 as never, name: 'A', role: 'reference' });
    reg.set('import#2', { shape: 13 as never, name: 'B', role: 'reference' });
    const { exchanger } = kernelExchange(() => client, reg);
    expect(exchanger.retain(new Set(['import#2']))).toEqual(['import#1']);
    expect([...reg.keys()]).toEqual(['demo-part', 'import#2']);
    // Not a batch: the regen that follows the edit cancels every batch up to the latest
    // generation, and a cancelled release would leak the shape.
    expect(sent).toEqual([]);
    expect(released).toEqual([[12]]);
    // Part bodies are never dropped; nothing to release sends nothing.
    expect(exchanger.retain(new Set(['import#2']))).toEqual([]);
    expect(released).toHaveLength(1);
    // Without a kernel the entry is still forgotten.
    const none = kernelExchange(() => null, reg).exchanger;
    expect(none.retain(new Set())).toEqual(['import#2']);
    expect([...reg.keys()]).toEqual(['demo-part']);
  });

  it('re-imports the reference bodies it still holds after the kernel lost every shape', async () => {
    const box = boxBody({ named: false });
    const reply = (shape: number) => ({
      results: [
        ok('feature', { ok: true, bodies: [{ id: 'import#1', shape }], errors: [] }),
        ok('tessellate', box.mesh),
        ok('topology', box.topology),
      ],
    });
    const { client, sent, released } = scripted([reply(40)]);
    const reg = registry();
    reg.set('import#1', { shape: 12 as never, name: 'A', role: 'reference' });
    const { exchanger } = kernelExchange(() => client, reg);
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    // import#2 was pruned meanwhile: nothing to rebuild.
    const rebuilt = await exchanger.reimport(
      new Map([
        ['import#1', bytes],
        ['import#2', bytes],
      ]),
    );
    expect(rebuilt).toEqual(['import#1']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.generation).toBe(7);
    expect(sent[0]!.ops[0]).toMatchObject({ op: 'feature', feature: { id: 'import#1' } });
    expect(reg.get('import#1')).toEqual({ shape: 40, name: 'A', role: 'reference' });
    // The old id died with the instance: nothing to release.
    expect(released).toEqual([]);
  });

  it('releases a re-imported body that was pruned while it was being rebuilt', async () => {
    const box = boxBody({ named: false });
    const reg = registry();
    reg.set('import#1', { shape: 12 as never, name: 'A', role: 'reference' });
    const { client, released } = scripted([]);
    (client.submit as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // The import feature can no longer come back: pruned while the kernel reads the file.
      exchanger.retain(new Set());
      return {
        status: 'done',
        names: [],
        generation: 7,
        results: [
          ok('feature', { ok: true, bodies: [{ id: 'import#1', shape: 41 }], errors: [] }),
          ok('tessellate', box.mesh),
          ok('topology', box.topology),
        ],
      };
    });
    const { exchanger } = kernelExchange(() => client, reg);
    expect(await exchanger.reimport(new Map([['import#1', new Uint8Array([1])]]))).toEqual([]);
    expect(reg.has('import#1')).toBe(false);
    expect(released).toEqual([[12], [41]]);
  });

  it('reports import failures without registering anything', async () => {
    const outcome = {
      ok: false,
      bodies: [],
      errors: [{ message: 'this is not a readable STEP file' }],
    } as unknown as FeatureOutcome;
    const { client } = scripted([{ results: [ok('feature', outcome)] }, null]);
    const reg = registry();
    const { exchanger } = kernelExchange(() => client, reg);
    const bytes = new Uint8Array([1]);
    expect(await exchanger.importStep(bytes, 'import#1', 'x')).toEqual({
      ok: false,
      message: 'The STEP file could not be imported: this is not a readable STEP file',
    });
    expect(reg.has('import#1')).toBe(false);
    // A superseded request is dropped.
    expect((await exchanger.importStep(bytes, 'import#1', 'x')).ok).toBe(false);
  });

  it('reports kernel failures, unknown bodies and a missing kernel', async () => {
    const { client } = scripted([{ results: [failed('exportStep', 'boom')] }]);
    const { exchanger } = kernelExchange(() => client, registry());
    expect(await exchanger.exportStep(['demo-part'])).toEqual({
      ok: false,
      message: 'STEP export failed: boom',
    });
    expect(await exchanger.exportStep(['nope'])).toEqual({
      ok: false,
      message: 'The kernel has no body nope.',
    });
    expect(await exchanger.tessellate([], { linear: 1, angular: 1 })).toEqual({
      ok: false,
      message: 'There is nothing to export.',
    });
    const none = kernelExchange(() => null, registry()).exchanger;
    expect(await none.exportStep(['demo-part'])).toEqual({
      ok: false,
      message: 'The kernel is not running.',
    });
  });
});
