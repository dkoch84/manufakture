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
});
