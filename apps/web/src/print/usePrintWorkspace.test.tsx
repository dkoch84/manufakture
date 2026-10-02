// The print workspace's export-tolerance meshes against the regens that drop their requests: a
// body is checked on its finer mesh once the kernel is free, however often a document change
// (an item added, one laid flat) superseded the request, and `meshesSettled` never reports a body
// still standing in on its viewport mesh.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshData } from '@manufakture/kernel';
import type { Exchanger } from '../io/exchange';
import { createDocumentStore } from '../state/document';
import { createSelectionStore } from '../state/selection';
import { boxBody } from '../viewport/testMeshes';
import { addItemCommand } from './commands';
import { createPrintMeshes } from './meshes';
import { boxPart, partsDocument, withSetup } from './print.test-fixture';
import { resolveSetup } from './resolve';
import { createPrintUiStore } from './state';
import { meshesSettled, usePrintWorkspace } from './usePrintWorkspace';

type Tessellate = Exchanger['tessellate'];
type Reply = Awaited<ReturnType<Tessellate>>;

const DROPPED: Reply = { ok: false, message: 'The kernel dropped the request; try again.' };

/** The box of `boxPart` meshed again: the same faces, new arrays. */
const finer = (): MeshData => boxBody({ id: 'part#1/extrude#1', named: false }).mesh;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(tessellate: Tessellate) {
  const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
  const documents = createDocumentStore(doc);
  const printUi = createPrintUiStore();
  const parts = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
  const exchanger = { tessellate };
  const hook = renderHook(() =>
    usePrintWorkspace({
      open: true,
      documents,
      printUi,
      selection: createSelectionStore(),
      viewport: null,
      parts,
      exchanger,
      analyzer: null,
    }),
  );
  const inputs = () =>
    hook.result.current.resolved!.items.flatMap((i) => i.bodies.map((b) => b.input.mesh));
  const addItem = () =>
    act(() => {
      const d = documents.getState().document;
      documents.getState().execute(addItemCommand(d, setupId, 'part#1').command, 'Add item');
    });
  return { hook, inputs, addItem };
}

/** Let pending promises settle and run the timers due within `ms`. */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('usePrintWorkspace export-tolerance meshes', () => {
  it('keeps asking while regens drop the request, and checks the finer mesh once one lands', async () => {
    const fine = finer();
    let drops = 6;
    const tessellate = vi.fn<Tessellate>(async () =>
      drops-- > 0 ? DROPPED : { ok: true, value: [{ name: 'Body', mesh: fine }] },
    );
    const { hook, inputs } = mount(tessellate);
    await advance(0);
    expect(inputs()[0]!.positions).not.toBe(fine.positions);
    expect(tessellate).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(tessellate).toHaveBeenCalledTimes(7);
    expect(inputs()[0]!.positions).toBe(fine.positions);
    expect(hook.result.current.bodies[0]!.mesh.positions).toBe(fine.positions);
    // Nothing more is asked once every body has its finer mesh.
    await advance(30_000);
    expect(tessellate).toHaveBeenCalledTimes(7);
  });

  it('takes a reply that lands after an item was added meanwhile', async () => {
    // Adding an item re-runs the request while the first is still on its way: the new run finds
    // the body pending and asks for nothing, so only the first reply can bring the finer mesh.
    const fine = finer();
    let answer!: (r: Reply) => void;
    const tessellate = vi.fn<Tessellate>(
      () =>
        new Promise<Reply>((resolve) => {
          answer = resolve;
        }),
    );
    const { inputs, addItem } = mount(tessellate);
    await advance(0);
    addItem();
    await advance(1000);
    expect(tessellate).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: [{ name: 'Body', mesh: fine }] });
    await advance(1000);
    const meshes = inputs();
    expect(meshes).toHaveLength(2);
    for (const m of meshes) expect(m.positions).toBe(fine.positions);
    expect(tessellate).toHaveBeenCalledTimes(1);
  });

  it('asks again when an item added meanwhile dropped the request', async () => {
    const fine = finer();
    const answers: ((r: Reply) => void)[] = [];
    const tessellate = vi.fn<Tessellate>(
      () =>
        new Promise<Reply>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { inputs, addItem } = mount(tessellate);
    await advance(0);
    addItem();
    answers[0]!(DROPPED);
    await advance(0);
    expect(inputs()[0]!.positions).not.toBe(fine.positions);
    await advance(1000);
    expect(tessellate).toHaveBeenCalledTimes(2);
    answers[1]!({ ok: true, value: [{ name: 'Body', mesh: fine }] });
    await advance(0);
    for (const m of inputs()) expect(m.positions).toBe(fine.positions);
  });
});

describe('meshesSettled', () => {
  it('is false while a body is on its viewport mesh, and until the checks use the finer one', async () => {
    const fine = finer();
    let answer!: (r: Reply) => void;
    const tessellate = vi.fn<Tessellate>(
      () =>
        new Promise<Reply>((resolve) => {
          answer = resolve;
        }),
    );
    const meshes = createPrintMeshes({ tessellate });
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
    const setup = doc.print.setups.find((s) => s.id === setupId)!;
    const before = resolveSetup(doc, setup, parts, { meshOf: meshes.meshOf });
    const views = before.items.flatMap((i) => i.bodies.map((b) => b.view));
    expect(meshesSettled(null, meshes)).toBe(true);
    expect(meshesSettled(before, meshes)).toBe(false);

    // Dropped: still on the viewport mesh, not settled.
    const first = meshes.request(views);
    answer(DROPPED);
    await first;
    expect(meshesSettled(before, meshes)).toBe(false);

    // Arrived, but the checks were resolved before it: not settled until they run again.
    const second = meshes.request(views);
    answer({ ok: true, value: [{ name: 'Body', mesh: fine }] });
    expect(await second).toBe(true);
    expect(meshesSettled(before, meshes)).toBe(false);
    const after = resolveSetup(doc, setup, parts, { meshOf: meshes.meshOf });
    expect(meshesSettled(after, meshes)).toBe(true);
  });
});
