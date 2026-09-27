// Interoperability with other programs, when they are installed: FreeCAD
// reopens our STEP (volume, face count, bounding box) and PrusaSlicer's CLI
// slices our 3MF and STL (OrcaSlicer's CLI takes other flags, so it is not
// picked up; OrcaSlicer itself is checked by hand, see
// docs/user/import-export.md). Each check is
// skipped when its program is missing, so local runs need neither; the
// `interop` CI job installs them. Commands can be overridden with FREECADCMD
// and SLICER_CMD (whitespace-separated, e.g. `xvfb-run -a prusa-slicer`).
// Set INTEROP_KEEP=1 to keep the files it writes.
//
// INTEROP_BRACKET_DIR points at the M1 bracket as the app exported it in the browser
// (bracket.step, bracket.3mf, bracket.stl and expected.json, written by
// apps/web/e2e/m1-bracket.spec.ts to apps/web/test-results/m1-bracket/); the same checks then
// run on those files. Unset or missing, they are skipped.

import type { Kernel, ShapeId } from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_TOLERANCES, deflectionOf, export3mf, exportStl } from './export';

function command(envName: string, candidates: string[]): string[] | null {
  const given = process.env[envName]?.trim();
  if (given) return given.split(/\s+/);
  for (const c of candidates) {
    const r = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return [r.stdout.trim()];
  }
  return null;
}

const freecad = command('FREECADCMD', ['freecadcmd', 'FreeCADCmd']);
const slicer = command('SLICER_CMD', ['prusa-slicer', 'PrusaSlicer']);

let k: Kernel;
let dir: string;
let part: ShapeId;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'manufakture-interop-'));
  console.log(
    `interop: FreeCAD ${freecad ? freecad.join(' ') : 'not found, skipped'}; ` +
      `slicer ${slicer ? slicer.join(' ') : 'not found, skipped'}`,
  );
  if (!freecad && !slicer) return;
  k = await createNodeKernel();
  // The app's demo part, moved onto the print bed's positive quadrant.
  const box = k.box(60, 40, 20, [10, 10, 0]);
  const filleted = k.fillet(box, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3).shape;
  const tool = k.cylinder(8, 30, [40, 30, -5]);
  part = k.boolean('cut', filleted, [tool]).shape;
}, 60_000);

afterAll(() => {
  if (process.env.INTEROP_KEEP) console.log(`interop files kept in ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
});

function run(cmd: string[], args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd[0]!, [...cmd.slice(1), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}

describe.skipIf(!freecad)('FreeCAD reopens our STEP', () => {
  it('with the same volume, face count and bounding box', () => {
    const step = join(dir, 'demo.step');
    writeFileSync(step, k.exportStep([{ shape: part, name: 'Demo part' }]));
    const got = freecadReads(step);
    const ours = k.properties(part);
    expect(got.valid).toBe(true);
    expect(got.solids).toBe(1);
    expect(got.faces).toBe(ours.faces);
    expect(Math.abs(got.volume - ours.volume) / ours.volume).toBeLessThan(1e-6);
    got.min.forEach((v, i) => expect(v).toBeCloseTo([10, 10, 0][i]!, 3));
    got.max.forEach((v, i) => expect(v).toBeCloseTo([70, 50, 20][i]!, 3));
  });
});

describe.skipIf(!slicer)('a slicer slices our files', () => {
  it('3MF', () => {
    const mesh = k.mesh(part, deflectionOf(EXPORT_TOLERANCES.normal));
    const file = join(dir, 'demo.3mf');
    writeFileSync(file, export3mf([{ name: 'Demo part', mesh }]));
    slice(file, 20);
  });

  it('STL', () => {
    const mesh = k.mesh(part, deflectionOf(EXPORT_TOLERANCES.normal));
    const file = join(dir, 'demo.stl');
    writeFileSync(file, exportStl([{ name: 'Demo part', mesh }])[0]!.bytes);
    slice(file, 20);
  });
});

/** Slice `file` with the slicer; the G-code must reach the part's full `height`. */
function slice(file: string, height: number) {
  const out = `${file}.gcode`;
  const r = run(slicer!, ['--export-gcode', '--output', out, file]);
  expect(r.error, r.out).toBeUndefined();
  expect(r.status, r.out).toBe(0);
  expect(existsSync(out), r.out).toBe(true);
  const gcode = readFileSync(out, 'utf8');
  expect(statSync(out).size).toBeGreaterThan(10_000);
  // Moves up to the part's full height, so the whole part was sliced.
  const zs = [...gcode.matchAll(/^G1 Z([\d.]+)/gm)].map((m) => Number(m[1]));
  expect(Math.max(...zs)).toBeGreaterThan(height - 1);
}

/** FreeCAD's view of a STEP file: validity, volume, faces, solids and bounding box. */
function freecadReads(step: string) {
  const script = join(dir, 'check_step.py');
  writeFileSync(
    script,
    [
      'import json, os, Part',
      'shape = Part.read(os.environ["INTEROP_STEP"])',
      'box = shape.BoundBox',
      'print("INTEROP " + json.dumps({"valid": shape.isValid(), "volume": shape.Volume,',
      '  "faces": len(shape.Faces), "solids": len(shape.Solids),',
      '  "min": [box.XMin, box.YMin, box.ZMin], "max": [box.XMax, box.YMax, box.ZMax]}))',
      '',
    ].join('\n'),
  );
  const r = run(freecad!, [script], { INTEROP_STEP: step });
  const line = r.out.split('\n').find((l) => l.startsWith('INTEROP '));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line!.slice('INTEROP '.length)) as {
    valid: boolean;
    volume: number;
    faces: number;
    solids: number;
    min: number[];
    max: number[];
  };
}

// The M1 bracket, exported by the app (see the top of this file).
const bracketDir = process.env.INTEROP_BRACKET_DIR?.trim();
const bracket =
  bracketDir && existsSync(join(bracketDir, 'expected.json'))
    ? {
        dir: bracketDir,
        expected: JSON.parse(readFileSync(join(bracketDir, 'expected.json'), 'utf8')) as {
          volume: number;
          faces: number;
          min: number[];
          max: number[];
        },
      }
    : null;

describe.skipIf(!bracket)('the M1 bracket as the app exported it', () => {
  it.skipIf(!freecad)('FreeCAD reopens its STEP with the same volume, faces and box', () => {
    const got = freecadReads(join(bracket!.dir, 'bracket.step'));
    const want = bracket!.expected;
    expect(got.valid).toBe(true);
    expect(got.solids).toBe(1);
    expect(got.faces).toBe(want.faces);
    expect(Math.abs(got.volume - want.volume) / want.volume).toBeLessThan(1e-6);
    got.min.forEach((v, i) => expect(v).toBeCloseTo(want.min[i]!, 3));
    got.max.forEach((v, i) => expect(v).toBeCloseTo(want.max[i]!, 3));
  });

  it.skipIf(!slicer)('the slicer slices its 3MF', () => {
    slice(copyToWorkDir('bracket.3mf'), bracket!.expected.max[2]! - bracket!.expected.min[2]!);
  });

  it.skipIf(!slicer)('the slicer slices its STL', () => {
    slice(copyToWorkDir('bracket.stl'), bracket!.expected.max[2]! - bracket!.expected.min[2]!);
  });

  /** The slicer writes its G-code next to the file: work on a copy in the scratch directory. */
  function copyToWorkDir(name: string): string {
    const to = join(dir, name);
    writeFileSync(to, readFileSync(join(bracket!.dir, name)));
    return to;
  }
});
