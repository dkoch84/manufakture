// Generate on demand when the user moves on: a generation whose setup is no longer shown stores
// nothing (no geometry, no outcomes, no message) and only clears the running flag.

import type { CamClient } from '@manufakture/cam/client';
import type { CamGeometryResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { addSetupCommand } from './commands';
import { apply, setupDocument } from './cam.test-fixture';
import type { CamGeometer } from './geometer';
import { generateSetup } from './run';
import { createCamUiStore } from './state';

function twoSetups() {
  const doc = setupDocument();
  return apply(doc, addSetupCommand(doc, 'part#1').command);
}

/** A geometer whose one reply the test settles by hand. */
function heldGeometer() {
  let settle: { resolve: (r: CamGeometryResult | null) => void; reject: (e: unknown) => void };
  const geometer: CamGeometer = {
    geometry: vi.fn(
      () =>
        new Promise<CamGeometryResult | null>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    ),
  };
  return { geometer, settle: () => settle };
}

describe('generateSetup', () => {
  it('drops the geometry of a setup the user left while it was resolved', async () => {
    const doc = twoSetups();
    const camUi = createCamUiStore();
    camUi.getState().setSetup('setup#1');
    const generate = vi.fn();
    const client = { generate } as unknown as CamClient;
    const { geometer, settle } = heldGeometer();
    const running = generateSetup(doc, doc.cam.setups[0]!, geometer, client, camUi);
    expect(camUi.getState().generating).toBe(true);
    camUi.getState().setSetup('setup#2');
    settle().resolve({ setupId: 'setup#1' } as CamGeometryResult);
    await running;
    expect(camUi.getState()).toMatchObject({
      setupId: 'setup#2',
      geometry: null,
      generating: false,
      generateMessage: null,
    });
    expect(camUi.getState().generated.size).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not report a failure of a setup the user left', async () => {
    const doc = twoSetups();
    const camUi = createCamUiStore();
    camUi.getState().setSetup('setup#1');
    const { geometer, settle } = heldGeometer();
    const running = generateSetup(
      doc,
      doc.cam.setups[0]!,
      geometer,
      { generate: vi.fn() } as unknown as CamClient,
      camUi,
    );
    camUi.getState().setSetup('setup#2');
    settle().reject(new Error('worker stopped'));
    await running;
    expect(camUi.getState().generateMessage).toBeNull();
    expect(camUi.getState().generating).toBe(false);
  });

  it('still reports on the setup shown', async () => {
    const doc = twoSetups();
    const camUi = createCamUiStore();
    camUi.getState().setSetup('setup#1');
    const { geometer, settle } = heldGeometer();
    const running = generateSetup(
      doc,
      doc.cam.setups[0]!,
      geometer,
      { generate: vi.fn() } as unknown as CamClient,
      camUi,
    );
    settle().resolve(null);
    await running;
    expect(camUi.getState().generateMessage).toBe('The model changed meanwhile; generate again.');
  });

  it("reports a V-carve's clearing on the V-carve: generated only when both are", async () => {
    const doc = setupDocument();
    const camUi = createCamUiStore();
    camUi.getState().setSetup('setup#1');
    const tool = {
      id: 'tool#1',
      name: 'Flat',
      kind: 'flat' as const,
      diameter: 6,
      fluteLength: 20,
      flutes: 2,
    };
    const vbit = { ...tool, id: 'tool#2', kind: 'vbit' as const, angle: Math.PI / 2 };
    const feeds = { spindle: 18000, cut: 1000, plunge: 300 };
    const p: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const square = {
      segments: p.map((start, i) => ({ kind: 'line' as const, start, end: p[(i + 1) % 4]! })),
    };
    const geometry = {
      generation: 1,
      setupId: 'setup#1',
      partId: 'part#1',
      bodyId: 'b',
      bodyKey: 'b',
      key: 'k',
      status: 'ok',
      errors: [],
      warnings: [],
      references: [],
      bounds: { min: [0, 0, 0], max: [10, 10, 5] },
      setup: {
        machine: 'shapeoko-5-pro-4x4',
        post: 'grbl',
        stock: {
          kind: 'fromBody',
          margins: { xMin: 0, xMax: 0, yMin: 0, yMax: 0, top: 0, bottom: 0 },
        },
        wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
        heights: { clearance: 10, retract: 5 },
        stockZ: { top: 0, bottom: -5 },
      },
      operations: [
        {
          operationId: 'vcarve#1',
          kind: 'vcarve',
          key: 'vkey',
          status: 'ok',
          errors: [],
          warnings: [],
          references: [],
          sources: [
            {
              source: 0,
              kind: 'region',
              z: 0,
              planar: { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, 0, 1], loops: [square] },
            },
          ],
          values: {
            id: 'vcarve#1',
            name: 'Letters',
            tool: vbit,
            feeds,
            kind: 'vcarve',
            top: 0,
            maxDepth: 1,
            clearing: { tool, feeds, stepdown: 1, stepover: 0.4 },
          },
        },
      ],
      cached: false,
      ms: 1,
    } as unknown as CamGeometryResult;
    const geometer: CamGeometer = { geometry: vi.fn(() => Promise.resolve(geometry)) };
    const toolpath = { start: [0, 0, 10], entries: [] };
    const generate = vi.fn((setup: { operations: { id: string }[] }) =>
      Promise.resolve({
        status: 'ok',
        operations: setup.operations.map((o) =>
          o.id === 'vcarve#1/clearing'
            ? {
                id: o.id,
                kind: 'vcarveClearing',
                key: 'c',
                ok: false,
                error: { code: 'invalid-input', message: 'too big' },
              }
            : {
                id: o.id,
                kind: 'vcarve',
                key: 'v',
                ok: true,
                toolpath,
                warnings: [{ code: 'w', message: 'carved' }],
                cached: false,
              },
        ),
      }),
    );
    await generateSetup(
      doc,
      doc.cam.setups[0]!,
      geometer,
      { generate } as unknown as CamClient,
      camUi,
    );
    expect(generate.mock.calls[0]![0].operations.map((o) => o.id)).toEqual([
      'vcarve#1/clearing',
      'vcarve#1',
    ]);
    const state = camUi.getState();
    expect([...state.generated.keys()]).toEqual(['vcarve#1']);
    expect(state.generated.get('vcarve#1')).toEqual({
      key: 'vkey',
      ok: false,
      message: 'Clearing: too big',
      warnings: ['carved'],
      cached: false,
    });
    expect(state.generateMessage).toBe('Generated 0 of 1 operation; 1 failed.');
  });
});
