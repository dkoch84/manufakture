// The simulation panel on its own, with an in-process session for a client: the part's mesh is
// fetched when the preview has none, and fetched again for another loader or another setup; the
// gouge line states the sideways allowance; the preview is told when the simulated stock shows.

import {
  SIM_DEFLECTION,
  SIM_TOLERANCE,
  SimulationSession,
  type Mesh,
  type Toolpath,
} from '@manufakture/cam';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimulationClient } from './runner';
import { SimulationPanel, type SimulationSource } from './SimulationPanel';

afterEach(cleanup);

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
    { kind: 'rapid', to: [5, 5, 5], op: 't', pass: 0 },
  ],
};
const frame = {
  origin: [0, 0, 0],
  xAxis: [1, 0, 0],
  yAxis: [0, 1, 0],
  zAxis: [0, 0, 1],
} as const;
const source = (setupId: string): SimulationSource => ({
  setupId,
  toolpath,
  tools: [tool],
  stock: { min: [0, 0, -5], max: [30, 10, 0] },
  frame,
  part: null,
});

/** A 30 x 10 slab, top at Z 0: a part the plunge cuts into. */
const slab: Mesh = {
  positions: new Float32Array([0, 0, 0, 30, 0, 0, 30, 10, 0, 0, 10, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

function client(): SimulationClient {
  const session = new SimulationSession();
  return {
    async simulateProgram(request) {
      const out = await session.run(request, { checkpoint: async () => {} });
      if (out.ok) return { status: 'done', generation: 1, frame: out.frame, ms: 0 };
      if (out.needsProgram) {
        return { status: 'needs-program', generation: 1, programId: request.programId };
      }
      return { status: 'failed', generation: 1, ...out.error };
    },
  };
}

describe('SimulationPanel', () => {
  it('fetches the part again for a new loader or another setup, and states the allowance', async () => {
    const c = client();
    const first = vi.fn(() => Promise.resolve<Mesh | null>(slab));
    const shown = vi.fn();
    const view = render(
      <SimulationPanel
        source={source('setup#1')}
        done={3}
        client={c}
        loadPartMesh={first}
        onShownChange={shown}
      />,
    );
    expect(first).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cam-sim-toggle'));
    expect(shown).toHaveBeenLastCalledWith(true);
    await waitFor(() =>
      expect(screen.getByTestId('cam-sim-gouges').textContent).toMatch(/^Gouges: /),
    );
    expect(first).toHaveBeenCalledTimes(1);
    const side = `${(SIM_TOLERANCE + SIM_DEFLECTION).toFixed(2)} mm`;
    expect(screen.getByTestId('cam-sim-gouges').textContent).toContain(
      `cuts within ${side} of a wall are not checked`,
    );

    // Another loader (the document changed): fetched again.
    const second = vi.fn(() => Promise.resolve<Mesh | null>(null));
    view.rerender(
      <SimulationPanel
        source={source('setup#1')}
        done={3}
        client={c}
        loadPartMesh={second}
        onShownChange={shown}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('cam-sim-gouges').textContent).toMatch(/No part mesh/),
    );
    expect(second).toHaveBeenCalledTimes(1);

    // Same loader, another setup: fetched again, and not before.
    view.rerender(
      <SimulationPanel
        source={source('setup#2')}
        done={3}
        client={c}
        loadPartMesh={second}
        onShownChange={shown}
      />,
    );
    await waitFor(() => expect(second).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('cam-sim-toggle'));
    expect(shown).toHaveBeenLastCalledWith(false);
  });

  it('states the allowance when there is no gouge', async () => {
    const above: Mesh = {
      positions: new Float32Array([0, 0, -2, 30, 0, -2, 30, 10, -2, 0, 10, -2]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    render(
      <SimulationPanel source={{ ...source('setup#1'), part: above }} done={3} client={client()} />,
    );
    fireEvent.click(screen.getByTestId('cam-sim-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('cam-sim-gouges').textContent).toBe(
        `No gouge (tolerance ${SIM_TOLERANCE.toFixed(2)} mm; a cut within ${(SIM_TOLERANCE + SIM_DEFLECTION).toFixed(2)} mm of a wall is not checked).`,
      ),
    );
  });
});
