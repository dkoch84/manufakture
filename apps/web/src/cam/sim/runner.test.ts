import {
  SimulationSession,
  packToolpath,
  type CamSimulateProgramRequest,
  type CamSimFrame,
  type Toolpath,
} from '@manufakture/cam';
import type { CamSimulateProgramResult } from '@manufakture/cam/client';
import { describe, expect, it } from 'vitest';
import { SimulationRunner, type SimulationClient } from './runner';

const tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
} as const;
const toolpath: Toolpath = {
  start: [5, 5, 5],
  entries: [
    { kind: 'toolChange', tool: tool.id, name: tool.name },
    { kind: 'rapid', to: [5, 5, 1], op: 't', pass: 0 },
    { kind: 'linear', to: [5, 5, -1], feed: 300, feedClass: 'plunge', op: 't', pass: 0 },
    { kind: 'linear', to: [25, 5, -1], feed: 1000, feedClass: 'cut', op: 't', pass: 0 },
    { kind: 'rapid', to: [25, 5, 5], op: 't', pass: 0 },
  ],
};
const program = () => ({
  toolpath: packToolpath(toolpath),
  tools: [tool],
  stock: { min: [0, 0, -5] as const, max: [30, 10, 0] as const },
  options: { cell: 0.5 },
});

/** A client on an in-process session, recording requests and resolving them on demand. */
function fakeClient() {
  let session = new SimulationSession();
  const requests: Omit<CamSimulateProgramRequest, 'generation'>[] = [];
  const pending: (() => void)[] = [];
  const client: SimulationClient = {
    simulateProgram(request) {
      requests.push(request);
      return new Promise<CamSimulateProgramResult | null>((resolve) => {
        pending.push(() => {
          void session
            .run(request, { checkpoint: async () => {} })
            .then((out) =>
              resolve(
                out.ok
                  ? { status: 'done', generation: 1, frame: out.frame, ms: 0 }
                  : out.needsProgram
                    ? { status: 'needs-program', generation: 1, programId: request.programId }
                    : { status: 'failed', generation: 1, ...out.error },
              ),
            );
        });
      });
    },
  };
  return {
    client,
    requests,
    restart: () => (session = new SimulationSession()),
    /** Answer the oldest request and let the runner react. */
    async answer() {
      pending.shift()?.();
      for (let k = 0; k < 10; k++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('SimulationRunner', () => {
  it('sends the program once, keeps one request in flight and asks only for the newest move', async () => {
    const fake = fakeClient();
    const frames: CamSimFrame[] = [];
    const runner = new SimulationRunner(fake.client, {
      onFrame: (f) => frames.push(f),
      onError: (m) => {
        throw new Error(m);
      },
    });
    runner.setProgram(program);
    runner.request(1);
    runner.request(2);
    runner.request(3);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.program).toBeDefined();
    await fake.answer();
    // Moves 2 was skipped: only the newest wanted after the first reply.
    expect(fake.requests.map((r) => r.upTo)).toEqual([1, 3]);
    expect(fake.requests[1]!.program).toBeUndefined();
    await fake.answer();
    expect(frames.map((f) => f.report.done)).toEqual([1, 3]);
    expect(runner.running).toBe(false);
  });

  it('sends the program again when the worker no longer holds it', async () => {
    const fake = fakeClient();
    const frames: CamSimFrame[] = [];
    const runner = new SimulationRunner(fake.client, {
      onFrame: (f) => frames.push(f),
      onError: () => {},
    });
    runner.setProgram(program);
    runner.request(4);
    await fake.answer();
    fake.restart();
    runner.request(2);
    await fake.answer();
    expect(fake.requests[2]!.program).toBeDefined();
    await fake.answer();
    expect(frames.map((f) => f.report.done)).toEqual([4, 2]);
  });

  it('reports a failure, and drops replies once stopped', async () => {
    const fake = fakeClient();
    const errors: string[] = [];
    const frames: CamSimFrame[] = [];
    const runner = new SimulationRunner(fake.client, {
      onFrame: (f) => frames.push(f),
      onError: (m) => errors.push(m),
    });
    runner.setProgram(() => ({ ...program(), tools: [] }));
    runner.request(1);
    await fake.answer();
    expect(errors[0]).toMatch(/tool#1/);
    runner.setProgram(program);
    runner.request(1);
    runner.stop();
    await fake.answer();
    expect(frames).toEqual([]);
  });
});
