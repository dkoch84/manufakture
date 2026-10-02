// An assembled job (T5.2g), from the real operation generators through the posts, checked by the
// G-code verifier (T5.4d): one file per tool for Grbl, one file with M6 for the M6 posts.

import { describe, expect, it } from 'vitest';
import { assembleJob, type JobOperation } from '../src/job';
import { rect } from '../src/offset/test-shapes';
import { generateDrill, type DrillOperation } from '../src/ops/drill';
import { generatePocket, type PocketOperation } from '../src/ops/pocket';
import { generateProfile, type ProfileOperation } from '../src/ops/profile';
import { GRBL_DIALECT, postGrbl } from '../src/post/grbl';
import { CARBIDE_MOTION_DIALECT, postCarbideMotion } from '../src/post/carbide-motion';
import type { PostJob } from '../src/post/writer';
import type { CamResult, OperationInput, Setup, Tool } from '../src/types';
import type { GeneratedToolpath, OperationContext } from '../src/worker/registry';
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
const drill3: Tool = {
  id: 'tool#3',
  name: '3 mm drill',
  kind: 'drill',
  number: 3,
  diameter: 3,
  fluteLength: 30,
  flutes: 2,
  angle: (118 * Math.PI) / 180,
};
const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500 };
const STOCK = { min: [0, 0, -12], max: [200, 150, 0] } as const;

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

const profile: ProfileOperation = {
  kind: 'profile',
  id: 'profile#1',
  name: 'Outline',
  tool: flat6,
  feeds,
  loops: [rect(20, 20, 60, 40)],
  side: 'outside',
  depth: { top: 0, bottom: -6 },
  stepdown: 3,
  finishAllowance: 0,
  tabs: { count: 2, width: 5, height: 1.5 },
  entry: { kind: 'ramp', angle: (5 * Math.PI) / 180 },
  leadIn: { kind: 'none' },
  leadOut: { kind: 'none' },
  climb: true,
};
const pocket: PocketOperation = {
  kind: 'pocket',
  id: 'pocket#1',
  name: 'Recess',
  tool: flat6,
  feeds,
  loops: [rect(120, 30, 40, 30)],
  depth: { top: 0, bottom: -4 },
  stepdown: 2,
  stepover: 0.5,
  finishAllowance: 0,
  entry: { kind: 'helix', angle: (3 * Math.PI) / 180, radius: 2 },
  climb: true,
};
const holes: DrillOperation = {
  kind: 'drill',
  id: 'drill#1',
  name: 'Holes',
  tool: drill3,
  feeds: { ...feeds, spindle: 12000 },
  points: [
    [190, 140],
    [10, 10],
    [100, 120],
    [10, 140],
  ].map(([x, y]) => ({ at: [x!, y!] as const, depth: { top: 0, bottom: -8 }, diameter: 3 })),
  peck: 3,
};

async function generate(op: OperationInput): Promise<JobOperation> {
  let r: CamResult<GeneratedToolpath>;
  if (op.kind === 'profile') r = await generateProfile(op, context);
  else if (op.kind === 'pocket') r = await generatePocket(op, context);
  else if (op.kind === 'drill') r = await generateDrill(op, context);
  else throw new Error(op.kind);
  if (!r.ok) throw new Error(r.error.message);
  return {
    id: op.id,
    name: op.name,
    tool: op.tool,
    feeds: op.feeds,
    result: { ok: true, toolpath: r.value.toolpath },
  };
}

describe('an assembled job through the posts', () => {
  it('passes the G-code verifier as Grbl files per tool and as one Carbide Motion file', async () => {
    const ops = await Promise.all([holes, profile, pocket].map(generate));
    const assembled = assembleJob(setup, ops, { groupByTool: true });
    if (!assembled.ok) throw new Error(assembled.error.message);
    const j = assembled.value;
    const postJob: PostJob = {
      toolpath: j.toolpath,
      job: 'Job test',
      setup: 'Top',
      date: '2026-10-02',
      origin: 'stock top, front left corner',
      heights: { clearance: j.clearance, retract: j.retract },
    };
    const verify = (text: string, dialect: typeof GRBL_DIALECT, tools: readonly Tool[]) => {
      const report = verifyGcode(text, {
        dialect,
        stock: STOCK,
        machine: SHAPEOKO_5_PRO_4X4_FIXTURE,
        origin: [100, 100, 60],
        tools,
      });
      if (!report.ok) throw new Error(report.error.message);
      expect(report.value.issues).toEqual([]);
      return report.value;
    };

    const grbl = postGrbl(postJob);
    if (!grbl.ok) throw new Error(grbl.error.message);
    expect(grbl.value.files.map((f) => f.tools)).toEqual([['tool#3'], ['tool#1']]);
    verify(grbl.value.files[0]!.text, GRBL_DIALECT, [drill3]);
    verify(grbl.value.files[1]!.text, GRBL_DIALECT, [flat6]);

    const cm = postCarbideMotion(postJob);
    if (!cm.ok) throw new Error(cm.error.message);
    expect(cm.value.files).toHaveLength(1);
    const report = verify(cm.value.files[0]!.text, CARBIDE_MOTION_DIALECT, [drill3, flat6]);
    expect(report.toolChanges).toBe(2);
  });
});
