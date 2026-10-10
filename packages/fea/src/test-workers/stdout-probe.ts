// Runs one analysis through the Node worker runner in a process of its own, as an MCP host does,
// so a test can check that nothing reached this process's stdout (the stdio transport's channel).
// Arguments: a STEP file, then a JSON object `{ faceCount, fixed, loaded, size }`. The outcome is
// written to stderr; the exit code is 0 when the analysis succeeded.
//
// Run with `node --import ./src/worker/node-hooks.ts src/test-workers/stdout-probe.ts ...`.

import { readFileSync } from 'node:fs';
import { createFeaRunner } from '../client';
import { spawnNodeFeaWorker } from '../node';

const [stepPath, json] = process.argv.slice(2);
const args = JSON.parse(json!) as {
  faceCount: number;
  fixed: number;
  loaded: number;
  size: number;
};
const runner = createFeaRunner(() => spawnNodeFeaWorker());
const out = await runner.run({
  bodies: [
    {
      step: new Uint8Array(readFileSync(stepPath!)),
      material: { elasticModulus: 200e9, poissonRatio: 0.3 },
      faceCount: args.faceCount,
    },
  ],
  mesh: { size: args.size },
  fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: args.fixed }] }],
  loads: [{ kind: 'force', faces: [{ body: 0, face: args.loaded }], force: [0, 0, -2000] }],
});
runner.dispose();
process.stderr.write(
  `${JSON.stringify(out.ok ? { ok: true, dof: out.result.summary.dof } : { ok: false, error: out.error })}\n`,
);
process.exitCode = out.ok ? 0 : 1;
