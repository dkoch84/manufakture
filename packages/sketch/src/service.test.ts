// The solver service (the worker's API): sessions, drag coalescing, regen
// solves, and surviving a planegcs abort (the stock 16 MiB heap runs out of
// memory from about 130 connected entities, T0.4).

import { lengthQuantity } from '@manufakture/units';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCoordinates, packCoordinates, type DragResult, type SketchInput } from './model';
import { SolverAbortedError } from './planegcs/module';
import { loadPlanegcsBackend } from './planegcs/system';
import { connectSolver, serveSolver } from './rpc';
import { SolverService } from './service';
import type { SketchSolverBackend, SketchSystem } from './solver';
import { chain, end, mm, pointAt, rectangle, start } from './test-helpers';

const underRect = (): SketchInput =>
  rectangle({ stages: ['geometry', 'coincident', 'hv', 'anchor'] });
/** Far past what the stock heap holds (125 entities solved in T0.4, 130 did not). */
const TOO_BIG = () => chain({ entities: 200, mode: 'free' });

/** A real planegcs backend that counts drag solves. */
function counting() {
  const count = { drags: 0 };
  const loadBackend = async (): Promise<SketchSolverBackend> => {
    const real = await loadPlanegcsBackend();
    return {
      get aborted() {
        return real.aborted;
      },
      createSystem(): SketchSystem {
        const system = real.createSystem();
        const drag = system.drag.bind(system);
        system.drag = (target) => {
          count.drags++;
          return drag(target);
        };
        return system;
      },
    };
  };
  return { count, loadBackend };
}

/** A schedule the test runs by hand, so coalescing is deterministic. */
function manualSchedule() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => void queue.push(fn),
    run: () => queue.splice(0).forEach((fn) => fn()),
    get size() {
      return queue.length;
    },
  };
}

describe('sessions', () => {
  it('update opens a session and solves it', async () => {
    const service = new SolverService();
    const r = await service.update('sketch#1', rectangle({ perturb: 1 }));
    expect(r.status).toBe('solved');
    expect(r.diagnosis.dof).toBe(0);
    expect(service.sessionIds).toEqual(['sketch#1']);
    await service.close('sketch#1');
    expect(service.sessionIds).toEqual([]);
  });

  it('takes variables as plain data', async () => {
    const service = new SolverService();
    const sketch = rectangle();
    const constraints = sketch.constraints.map((c) =>
      c.id === 'width' ? { ...c, value: mm('#w * 2') } : c,
    );
    const r = await service.update('s', { entities: sketch.entities, constraints } as SketchInput, {
      w: lengthQuantity(30),
    });
    expect(pointAt(r.entities, end('bottom'))[0]).toBeCloseTo(60, 9);
    // Inherited object keys are not variables.
    const bad = await service.update(
      's',
      {
        entities: sketch.entities,
        constraints: constraints.map((c) =>
          c.id === 'width' ? { ...c, value: mm('#toString') } : c,
        ),
      } as SketchInput,
      {},
    );
    expect(bad.status).toBe('invalid');
  });

  it('keeps sessions apart', async () => {
    const service = new SolverService();
    await service.update('a', underRect());
    await service.update('b', rectangle());
    await service.dragStart('a', end('right'));
    const move = await service.dragMove('a', [70, 20]);
    expect(move?.status).toBe('solved');
    const b = await service.update('b', rectangle());
    expect(pointAt(b.entities, end('right'))).toEqual([
      expect.closeTo(40, 9),
      expect.closeTo(25, 9),
    ]);
    const a = await service.dragEnd('a');
    expect(pointAt(a.entities, end('right'))).toEqual([
      expect.closeTo(70, 9),
      expect.closeTo(20, 9),
    ]);
  });

  it('rejects calls that make no sense', async () => {
    const service = new SolverService();
    await expect(service.dragStart('nope', end('right'))).rejects.toThrow(/No solver session/);
    await service.update('s', underRect());
    await expect(service.dragMove('s', [1, 1])).rejects.toThrow(/No drag in progress/);
    await expect(service.dragStart('s', start('missing'))).rejects.toThrow(/unknown entity/);
  });
});

describe('drag coalescing', () => {
  it('solves only the latest of the moves queued before a solve; the rest resolve to null', async () => {
    const { count, loadBackend } = counting();
    const manual = manualSchedule();
    const service = new SolverService({ loadBackend, schedule: manual.schedule });
    await service.update('s', underRect());
    await service.dragStart('s', end('right'));
    const moves = [10, 20, 30, 40, 50].map((x) => service.dragMove('s', [x, 30]));
    expect(manual.size).toBe(1);
    manual.run();
    const results = await Promise.all(moves);
    expect(results.slice(0, 4)).toEqual([null, null, null, null]);
    expect(results[4]?.status).toBe('solved');
    expect(count.drags).toBe(1);
    const entities = applyCoordinates(underRect().entities, results[4]!.coordinates);
    expect(pointAt(entities, end('right'))).toEqual([expect.closeTo(50, 9), expect.closeTo(30, 9)]);
  });

  it('with the default schedule, moves sent together are coalesced too', async () => {
    const { count, loadBackend } = counting();
    const service = new SolverService({ loadBackend });
    await service.update('s', underRect());
    await service.dragStart('s', end('right'));
    const results = await Promise.all(
      [1, 2, 3].map((k) => service.dragMove('s', [40 + k, 25 + k])),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(count.drags).toBe(1);
    // A later move is solved on its own.
    expect((await service.dragMove('s', [45, 26]))?.status).toBe('solved');
    expect(count.drags).toBe(2);
  });

  it('dragEnd solves a pending move first, and ends where it went', async () => {
    const manual = manualSchedule();
    const service = new SolverService({ schedule: manual.schedule });
    await service.update('s', underRect());
    await service.dragStart('s', end('right'));
    const move = service.dragMove('s', [55, 35]);
    const ended = await service.dragEnd('s');
    expect((await move)?.status).toBe('solved');
    expect(pointAt(ended.entities, end('right'))).toEqual([
      expect.closeTo(55, 9),
      expect.closeTo(35, 9),
    ]);
    manual.run(); // the scheduled flush finds nothing left to do
  });

  it('close resolves pending moves with null', async () => {
    const manual = manualSchedule();
    const service = new SolverService({ schedule: manual.schedule });
    await service.update('s', underRect());
    await service.dragStart('s', end('right'));
    const move = service.dragMove('s', [55, 35]);
    await service.close('s');
    expect(await move).toBeNull();
  });
});

describe('regen solves', () => {
  it('are never coalesced or dropped, and ignore interactive sessions', async () => {
    const manual = manualSchedule();
    const service = new SolverService({ schedule: manual.schedule });
    await service.update('sketch#1', underRect());
    await service.dragStart('sketch#1', end('right'));
    const pending = service.dragMove('sketch#1', [80, 80]);
    // Regen asks for the stored sketch#1 and another sketch, several times.
    const results = await Promise.all([
      service.solve(underRect()),
      service.solve(rectangle({ perturb: 1 })),
      service.solve(underRect()),
    ]);
    expect(results.map((r) => r.status)).toEqual(['solved', 'solved', 'solved']);
    // The stored sketch solves where it is stored, not where the drag is.
    expect(pointAt(results[0]!.entities, end('right'))).toEqual([
      expect.closeTo(40, 9),
      expect.closeTo(25, 9),
    ]);
    expect(results[1]!.diagnosis.dof).toBe(0);
    manual.run();
    expect((await pending)?.status).toBe('solved');
  });

  it('do not depend on what was solved before, even when ids collide across sketches', async () => {
    const pinned = (x: number, y: number): SketchInput => ({
      entities: [
        { id: 'p1', kind: 'point', construction: false, position: [x, y] },
        { id: 'l1', kind: 'line', construction: false, start: [x, y], end: [x + 10, y + 3] },
      ],
      constraints: [
        { id: 'c1', kind: 'fix', point: { entity: 'p1' } },
        { id: 'c2', kind: 'coincident', a: { entity: 'p1' }, b: start('l1') },
      ],
    });
    const fresh = (await loadPlanegcsBackend()).createSystem().update(pinned(5, 5));
    const service = new SolverService();
    const a = await service.solve(pinned(0, 0));
    expect(pointAt(a.entities, { entity: 'p1' })).toEqual([0, 0]);
    const b = await service.solve(pinned(5, 5));
    expect(pointAt(b.entities, { entity: 'p1' })).toEqual([5, 5]);
    expect(b).toEqual(fresh);
  });

  it('report redundancy by the order of the sketch solved, not of an earlier one', async () => {
    const twice = (order: string[]): SketchInput => ({
      entities: [{ id: 'l1', kind: 'line', construction: false, start: [0, 0], end: [9, 1] }],
      constraints: order.map((id) => ({
        id,
        kind: 'distance',
        a: start('l1'),
        b: end('l1'),
        value: mm(10),
      })),
    });
    const service = new SolverService();
    expect((await service.solve(twice(['x', 'y']))).diagnosis.redundant).toEqual(['y']);
    expect((await service.solve(twice(['y', 'x']))).diagnosis.redundant).toEqual(['x']);
  });
});

describe('out of memory', () => {
  it('a sketch too big for the stock heap reports aborted with a clear message; the system stays dead', async () => {
    const backend = await loadPlanegcsBackend();
    const system = backend.createSystem();
    const r = system.update(TOO_BIG());
    expect(r.status).toBe('aborted');
    expect(r.message).toMatch(/ran out of memory/);
    expect(r.message).toMatch(/Aborted\(OOM\)/);
    expect(r.entities).toEqual(TOO_BIG().entities);
    expect(backend.aborted).toMatch(/OOM/);
    expect(system.aborted).toBeTruthy();
    // Every later call on the dead instance reports it, instead of crashing.
    expect(system.update(rectangle()).status).toBe('aborted');
    expect(backend.createSystem().update(rectangle()).status).toBe('aborted');
    expect(() => system.beginDrag(end('right'))).toThrow();
  });

  it('SolverAbortedError says what happened', () => {
    expect(new SolverAbortedError('OOM').message).toMatch(/ran out of memory/);
    expect(new SolverAbortedError('something else').message).toMatch(/aborted: something else/);
  });

  it('the service discards the dead instance, loads a new one and reloads its sessions', async () => {
    const service = new SolverService();
    await service.update('small', underRect());
    await service.dragStart('small', end('right'));
    expect((await service.dragMove('small', [50, 30]))?.status).toBe('solved');
    expect(service.loads).toBe(1);

    const big = await service.solve(TOO_BIG());
    expect(big.status).toBe('aborted');

    // The session comes back on its next use, mid-drag, from where it was.
    const move = (await service.dragMove('small', [60, 35])) as DragResult;
    expect(service.loads).toBe(2);
    expect(move.status).toBe('solved');
    expect(pointAt(applyCoordinates(underRect().entities, move.coordinates), end('right'))).toEqual(
      [expect.closeTo(60, 9), expect.closeTo(35, 9)],
    );
    const ended = await service.dragEnd('small');
    expect(ended.status).toBe('solved');
    expect(ended.diagnosis.dof).toBe(2);
    // Regen solves work again too.
    expect((await service.solve(rectangle())).status).toBe('solved');
  });

  it('an interactive session that is too big reports aborted, and a smaller edit recovers', async () => {
    const service = new SolverService();
    const r = await service.update('s', TOO_BIG());
    expect(r.status).toBe('aborted');
    const small = await service.update('s', chain({ entities: 20, mode: 'free' }));
    expect(small.status).toBe('solved');
    expect(service.loads).toBe(2);
  });
});

describe('over a message channel', () => {
  const channels: MessageChannel[] = [];
  afterEach(() => {
    for (const c of channels.splice(0)) {
      c.port1.close();
      c.port2.close();
    }
  });

  it('serves the API, transfers coordinates and passes errors back as rejections', async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    serveSolver(channel.port1 as never, new SolverService());
    const remote = connectSolver(channel.port2 as never);

    const r = await remote.update('s', underRect());
    expect(r.status).toBe('solved');
    expect(r.diagnosis.entities).toEqual({
      bottom: 'under',
      right: 'under',
      top: 'under',
      left: 'under',
    });
    await remote.dragStart('s', end('right'));
    const move = await remote.dragMove('s', [44, 33]);
    expect(move?.coordinates).toBeInstanceOf(Float64Array);
    expect(move!.coordinates.length).toBe(packCoordinates(underRect().entities).length);
    const ended = await remote.dragEnd('s');
    expect(pointAt(ended.entities, end('right'))).toEqual([
      expect.closeTo(44, 9),
      expect.closeTo(33, 9),
    ]);
    await expect(remote.dragStart('missing', end('right'))).rejects.toThrow(
      /No solver session 'missing'/,
    );
    const regen = await remote.solve(rectangle());
    expect(regen.diagnosis.dof).toBe(0);
    await remote.close('s');
  });

  it('answers unknown methods with an error', async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    serveSolver(channel.port1 as never, new SolverService());
    const reply = new Promise((resolve) =>
      channel.port2.addEventListener('message', (e) => resolve(e.data)),
    );
    channel.port2.start();
    channel.port2.postMessage({ id: 7, method: 'explode', args: [] });
    expect(await reply).toEqual({ id: 7, ok: false, message: "Unknown solver method 'explode'" });
  });
});
