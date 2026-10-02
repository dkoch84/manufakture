// 3D surfacing (T5.5a) end to end: z-level roughing with a flat end mill and a parallel finish
// with a ball, on a filleted block, assembled into a job (T5.2g), posted for Grbl (one file per
// tool) and checked by the G-code verifier (T5.4d).

import { describe, expect, it } from 'vitest';
import { assembleJob, type JobOperation } from '../src/job';
import { filletedBlock } from '../src/mesh/test-meshes';
import { generateSurface3d, type Surface3dOperation } from '../src/ops/surface3d';
import { GRBL_DIALECT, postGrbl } from '../src/post/grbl';
import type { PostJob } from '../src/post/writer';
import type { Setup, Tool } from '../src/types';
import type { OperationContext } from '../src/worker/registry';
import { SHAPEOKO_5_PRO_4X4_FIXTURE } from './gcode-fixtures';
import { verifyGcode } from './verify-gcode';

const flat6: Tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  number: 1,
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const ball6: Tool = { ...flat6, id: 'tool#2', name: '6 mm ball', kind: 'ball', number: 2 };
const feeds = { spindle: 18000, cut: 1500, plunge: 400 };
const STOCK = { min: [0, 0, -20], max: [70, 50, 0] } as const;
const MESH = filletedBlock({
  x0: 5,
  y0: 5,
  x1: 65,
  y1: 45,
  bottom: -20,
  top: -2,
  radius: 8,
  segments: 24,
});

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

const rough: Surface3dOperation = {
  kind: 'surface3d',
  id: 'surface3d#1',
  name: 'Rough',
  tool: flat6,
  feeds,
  mesh: MESH,
  stepover: 2.4,
  angle: 0,
  allowance: 0.5,
  strategy: 'zlevel',
  stepdown: 3,
};
const finish: Surface3dOperation = {
  kind: 'surface3d',
  id: 'surface3d#2',
  name: 'Finish',
  tool: ball6,
  feeds,
  mesh: MESH,
  stepover: 1,
  angle: Math.PI / 2,
  allowance: 0,
};

async function generate(op: Surface3dOperation): Promise<JobOperation> {
  const r = await generateSurface3d(op, context);
  if (!r.ok) throw new Error(r.error.message);
  return {
    id: op.id,
    name: op.name,
    tool: op.tool,
    feeds: op.feeds,
    result: { ok: true, toolpath: r.value.toolpath },
  };
}

describe('3D surfacing through the Grbl post', () => {
  it('passes the G-code verifier, one file per tool', async () => {
    const ops = await Promise.all([rough, finish].map(generate));
    const assembled = assembleJob(setup, ops);
    if (!assembled.ok) throw new Error(assembled.error.message);
    const j = assembled.value;
    expect(j.toolChanges).toEqual(['tool#1', 'tool#2']);
    const postJob: PostJob = {
      toolpath: j.toolpath,
      job: 'Filleted block',
      setup: 'Top',
      date: '2026-10-02',
      origin: 'stock top, front left corner',
      heights: { clearance: j.clearance, retract: j.retract },
    };
    const grbl = postGrbl(postJob);
    if (!grbl.ok) throw new Error(grbl.error.message);
    expect(grbl.value.files.map((f) => f.tools)).toEqual([['tool#1'], ['tool#2']]);
    for (const [file, tool] of [
      [grbl.value.files[0]!, flat6],
      [grbl.value.files[1]!, ball6],
    ] as const) {
      const report = verifyGcode(file.text, {
        dialect: GRBL_DIALECT,
        stock: STOCK,
        machine: SHAPEOKO_5_PRO_4X4_FIXTURE,
        origin: [100, 100, 60],
        tools: [tool],
      });
      if (!report.ok) throw new Error(report.error.message);
      expect(report.value.issues).toEqual([]);
      expect(report.value.lines).toBeGreaterThan(1000);
    }
  });
});
