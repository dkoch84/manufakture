// Generate on demand (M5 plan, T5.3a; ADR 0014 decision 8): one setup's geometry asked of the
// regen worker's CAM stage for the document as it is now, converted (`generate.ts`) and sent to
// the CAM worker in one `generate` call; the outcomes are kept in the workspace's state per
// operation, with the geometry key each came from, so a later edit marks it stale. Results of a
// setup the workspace no longer shows (the user picked another meanwhile) are dropped.

import type { CamSetup, ManufaktureDocument } from '@manufakture/core';
import type { CamClient } from '@manufakture/cam/client';
import { machineById } from './commands';
import { setupInput } from './generate';
import type { CamGeometer } from './geometer';
import { activeCamSetup, type CamUiStore } from './state';
import type { GeneratedOutcome } from './status';

/**
 * Generate the setup's toolpaths: its geometry from the stage (fresh, for the document as it is
 * now), converted to the CAM worker's evaluated setup, then one `generate` call for every
 * operation whose geometry resolved. The outcomes are kept per operation with the geometry key
 * they came from, so a later edit marks them stale.
 */
export async function generateSetup(
  doc: ManufaktureDocument,
  setup: CamSetup,
  geometer: CamGeometer,
  client: CamClient,
  camUi: CamUiStore,
): Promise<void> {
  const ui = camUi.getState();
  // The workspace still shows this setup. When it does not, nothing is stored (another setup's
  // geometry and outcomes are not this one's); only the running flag is cleared, since a setup
  // change leaves it set and Generate stays disabled until it is.
  const shown = () => activeCamSetup(doc, camUi.getState().setupId)?.id === setup.id;
  const dropped = () => {
    if (shown()) return false;
    camUi.getState().setGenerating(false);
    return true;
  };
  ui.setGenerating(true, 'Resolving geometry...');
  try {
    const machine = machineById(setup.machine);
    if (!machine) {
      ui.setGenerated(new Map(), `Unknown machine ${setup.machine}: choose a machine first.`);
      return;
    }
    const geometry = await geometer.geometry(doc, setup.id);
    if (dropped()) return;
    if (geometry === null) {
      ui.setGenerating(false, 'The model changed meanwhile; generate again.');
      return;
    }
    ui.setGeometry(geometry);
    const built = setupInput(geometry, setup);
    if (!built.ok) {
      ui.setGenerated(new Map(), built.message);
      return;
    }
    const keys = new Map(geometry.operations.map((o) => [o.operationId, o.key]));
    const generated = new Map<string, GeneratedOutcome>();
    for (const [id, message] of Object.entries(built.failed)) {
      generated.set(id, { key: keys.get(id) ?? '', ok: false, message, warnings: [] });
    }
    if (built.setup.operations.length === 0) {
      ui.setGenerated(generated, 'Nothing to generate: no operation has resolved geometry.');
      return;
    }
    camUi.getState().setGenerating(true, 'Generating toolpaths...');
    const reply = await client.generate(built.setup, { machine });
    if (dropped()) return;
    if (reply === null) {
      ui.setGenerating(false, 'Superseded by a newer request.');
      return;
    }
    if (reply.status === 'failed') {
      ui.setGenerated(generated, `Generation failed: ${reply.message}`);
      return;
    }
    let ok = 0;
    for (const r of reply.operations) {
      const key = keys.get(r.id) ?? '';
      if (r.ok) {
        ok++;
        generated.set(r.id, {
          key,
          ok: true,
          warnings: r.warnings.map((w) => w.message),
          cached: r.cached,
        });
      } else {
        generated.set(r.id, { key, ok: false, message: r.error.message, warnings: [] });
      }
    }
    const failed = reply.operations.length - ok;
    camUi
      .getState()
      .setGenerated(
        generated,
        `Generated ${ok} of ${reply.operations.length} ${reply.operations.length === 1 ? 'operation' : 'operations'}${failed > 0 ? `; ${failed} failed` : ''}.`,
      );
  } catch (e) {
    if (dropped()) return;
    camUi
      .getState()
      .setGenerated(new Map(), `Generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
