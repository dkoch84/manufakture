// The simulation's worker protocol (T9.4b): a run through the worker gives the same numbers as
// the model called directly, reports progress, cancels, and fails loudly when the worker dies.
// The worker is a fake that clones every message, as postMessage does, and serves it with the
// worker's own handler.

import { simProfile, simulate, type SimJob, type SimMachine } from '@manufakture/domain-mech';
import { describe, expect, it } from 'vitest';
import {
  localSimulator,
  serveSimulations,
  workerSimulator,
  type SimReply,
  type SimRequest,
  type SimWorker,
} from './simulator';

const machine: SimMachine = {
  motor: {
    kt: 0.5,
    resistance: 0.04,
    inductance: 1e-4,
    polePairs: 14,
    frictionCoulomb: 0.03,
    frictionViscous: 1e-4,
    ironHysteresis: 0.06,
    ironEddy: 8e-4,
    copperAlpha: 0.00393,
    magnetAlpha: -0.0012,
    reference: 298.15,
  },
  motorThermal: {
    windingCapacity: 200,
    windingToHousing: 0.3,
    housingCapacity: 1000,
    housingToAmbient: 1,
  },
  transmission: {
    radius: { kind: 'constant', radius: 0.025 },
    ratio: 1,
    efficiency: 1,
    cableEfficiency: 0.97,
    inertia: 3.2e-3,
  },
  controller: {
    currentLimit: 60,
    modulation: 0.95,
    loopHz: 1000,
    fixedLoss: 1.5,
    legResistance: 0.004,
    switchingTime: 1e-7,
    switchingFrequency: 20e3,
  },
  pack: {
    ocv: [
      { soc: 0, voltage: 48 },
      { soc: 1, voltage: 67 },
    ],
    capacity: 1.7 * 3600,
    resistance: 0.42,
    chargeLimit: 3.4,
    taperStart: 0.85,
  },
  brake: { resistance: 2.5 },
  aux: 2.5,
  ambient: 298.15,
};

function job(sets: number): SimJob {
  const p = simProfile({
    law: { kind: 'constant', force: 890 },
    motion: { kind: 'half-cosine', stroke: 0.6, pullSpeed: 1.5, returnSpeed: 1, pause: 0.2 },
    reps: 10,
    sets,
    rest: 60,
  });
  if (!p.ok) throw new Error(p.message);
  return {
    machine,
    law: { kind: 'constant', force: 890 },
    segments: p.segments,
    start: { soc: 0.5 },
  };
}

/** A worker on this thread: messages are cloned both ways, as a real one's are. */
function fakeWorker(): SimWorker & { terminated: boolean; fail(message: string): void } {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const emit = (type: string, e: unknown) => listeners[type]?.forEach((l) => l(e));
  const handle = serveSimulations((reply: SimReply) =>
    queueMicrotask(() => emit('message', { data: structuredClone(reply) })),
  );
  const w = {
    terminated: false,
    postMessage(message: SimRequest) {
      const copy = structuredClone(message);
      queueMicrotask(() => handle(copy));
    },
    addEventListener(type: string, l: (e: unknown) => void) {
      (listeners[type] ??= []).push(l);
    },
    terminate() {
      w.terminated = true;
    },
    fail(message: string) {
      emit('error', { message });
    },
  };
  return w as unknown as SimWorker & { terminated: boolean; fail(message: string): void };
}

describe('the simulation worker', () => {
  it('gives the numbers the model gives, with progress', async () => {
    const sim = workerSimulator(fakeWorker);
    const progress: number[] = [];
    const res = await sim.run(job(1), { onProgress: (f) => progress.push(f) });
    const direct = simulate(job(1));
    expect(res.status).toBe('done');
    expect(res.envelopes).toEqual(direct.envelopes);
    expect(res.ledger).toEqual(direct.ledger);
    expect(progress.at(-1)).toBe(1);
  });

  it('runs load cases side by side and cancels one without the other', async () => {
    const sim = workerSimulator(fakeWorker);
    const c = new AbortController();
    const long = sim.run(job(13), { signal: c.signal, onProgress: () => c.abort() });
    const short = sim.run(job(1));
    const [a, b] = await Promise.all([long, short]);
    expect(a.status).toBe('cancelled');
    expect(a.time).toBeLessThan(a.duration);
    expect(b.status).toBe('done');
  });

  it('starts the worker on the first run and rejects pending runs when it dies', async () => {
    let spawned = 0;
    let w: ReturnType<typeof fakeWorker> | undefined;
    const sim = workerSimulator(() => {
      spawned++;
      w = fakeWorker();
      return w;
    });
    expect(spawned).toBe(0);
    const run = sim.run(job(13));
    expect(spawned).toBe(1);
    w!.fail('out of memory');
    await expect(run).rejects.toThrow('out of memory');
    expect(w!.terminated).toBe(true);
    // The next run starts a fresh worker.
    await sim.run(job(1));
    expect(spawned).toBe(2);
  });

  it('a job the model refuses rejects with its message', async () => {
    const sim = workerSimulator(fakeWorker);
    await expect(sim.run({ ...job(1), segments: [] })).rejects.toThrow('no segments');
  });
});

describe('the in-process simulator', () => {
  it('runs in slices and cancels', async () => {
    const sim = localSimulator();
    const done = await sim.run(job(1));
    expect(done.status).toBe('done');
    const c = new AbortController();
    c.abort();
    expect((await sim.run(job(13), { signal: c.signal })).status).toBe('cancelled');
  });
});
