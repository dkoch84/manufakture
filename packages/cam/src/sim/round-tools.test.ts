// The simulation with round tools (T5.5b): a 3D parallel finish on the filleted block, simulated
// with the ball and bull nose stamps, reports no gouge, and the same path cut by a flat end mill
// (the wrong tool) does, so the check can see one.

import { describe, expect, it } from 'vitest';
import { filletedBlock, type FilletedBlock } from '../mesh/test-meshes';
import { generateSurface3d, type Surface3dOperation } from '../ops/surface3d';
import type { Toolpath } from '../ir';
import type { Box3, Setup, Tool } from '../types';
import type { OperationContext } from '../worker/registry';
import { MaterialSimulation, SIM_CLASS } from './simulation';

const BLOCK: FilletedBlock = {
  x0: 5,
  y0: 5,
  x1: 45,
  y1: 35,
  bottom: -15,
  top: -2,
  radius: 6,
  segments: 24,
};
const MESH = filletedBlock(BLOCK);
const STOCK: Box3 = { min: [0, 0, -15], max: [50, 40, 0] };

const ball: Tool = {
  id: 'tool#1',
  name: '6 mm ball',
  kind: 'ball',
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const bull: Tool = { ...ball, id: 'tool#2', name: '6 mm bull', kind: 'bull', cornerRadius: 1.5 };
const flat: Tool = { ...ball, id: 'tool#3', name: '6 mm flat', kind: 'flat' };

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: STOCK,
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};
const context: OperationContext = {
  generation: 1,
  cancelled: false,
  setup,
  checkpoint: () => Promise.resolve(),
};

async function finish(tool: Tool): Promise<Toolpath> {
  const op: Surface3dOperation = {
    kind: 'surface3d',
    id: 'surface3d#1',
    name: 'Finish',
    tool,
    feeds: { spindle: 18000, cut: 1500, plunge: 400 },
    mesh: MESH,
    stepover: 0.8,
    angle: 0,
    allowance: 0,
  };
  const r = await generateSurface3d(op, context);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.toolpath;
}

function run(toolpath: Toolpath, tool: Tool) {
  const sim = MaterialSimulation.create({ toolpath, tools: [tool], stock: STOCK, part: MESH });
  if (!sim.ok) throw new Error(sim.error.message);
  sim.value.runTo(Infinity);
  const comparison = sim.value.compare();
  if (!comparison) throw new Error('no comparison with the part');
  return { sim: sim.value, comparison };
}

function simulate(toolpath: Toolpath, tool: Tool) {
  const { sim, comparison } = run(toolpath, tool);
  return sim.report(comparison);
}

describe('simulating a 3D finish with round tools', () => {
  for (const tool of [ball, bull]) {
    it(`finds no gouge in a ${tool.kind} finish of a filleted block`, async () => {
      const { sim, comparison } = run(await finish(tool), tool);
      const report = sim.report(comparison);
      expect(report.gougeCells).toBe(0);
      expect(report.collisions).toEqual([]);
      // The finish did cut: every cell of the block's flat top (inside the fillets) is within the
      // tolerance of the part, and at most a quarter of all the cells over the part are left
      // over (those along the foot of the walls, where a round tool cannot reach).
      let top = 0;
      let topOk = 0;
      const m = BLOCK.radius + 1;
      for (let x = BLOCK.x0 + m; x <= BLOCK.x1 - m; x += report.cell) {
        for (let y = BLOCK.y0 + m; y <= BLOCK.y1 - m; y += report.cell) {
          top++;
          if (comparison.classes[sim.cellAt(x, y)] === SIM_CLASS.ok) topOk++;
        }
      }
      expect(top).toBeGreaterThan(1000);
      expect(topOk).toBe(top);
      const compared = comparison.classes.filter((c) => c !== SIM_CLASS.none).length;
      expect(compared).toBeGreaterThan(5000);
      expect(report.leftoverCells!).toBeLessThan(compared / 4);
    });
  }

  it('reports gouges when the same path is cut with a flat end mill', async () => {
    const report = simulate(await finish(ball), flat);
    expect(report.gougeCells).toBeGreaterThan(0);
    expect(report.worstGouge!.depth).toBeGreaterThan(0.5);
  });
});
