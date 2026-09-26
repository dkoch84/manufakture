// Interoperability with other programs, when they are installed: FreeCAD
// reopens our STEP (volume, face count, bounding box) and PrusaSlicer's CLI
// slices our 3MF and STL (OrcaSlicer's CLI takes other flags, so it is not
// picked up; OrcaSlicer itself is checked by hand, see
// docs/user/import-export.md). Each check is
// skipped when its program is missing, so local runs need neither; the
// `interop` CI job installs them. Commands can be overridden with FREECADCMD
// and SLICER_CMD (whitespace-separated, e.g. `xvfb-run -a prusa-slicer`).
// Set INTEROP_KEEP=1 to keep the files it writes.

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
    const got = JSON.parse(line!.slice('INTEROP '.length)) as {
      valid: boolean;
      volume: number;
      faces: number;
      solids: number;
      min: number[];
      max: number[];
    };
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
  const slice = (file: string) => {
    const out = `${file}.gcode`;
    const r = run(slicer!, ['--export-gcode', '--output', out, file]);
    expect(r.error, r.out).toBeUndefined();
    expect(r.status, r.out).toBe(0);
    expect(existsSync(out), r.out).toBe(true);
    const gcode = readFileSync(out, 'utf8');
    expect(statSync(out).size).toBeGreaterThan(10_000);
    // Moves up to the part's full height (20 mm), so the whole part was sliced.
    const zs = [...gcode.matchAll(/^G1 Z([\d.]+)/gm)].map((m) => Number(m[1]));
    expect(Math.max(...zs)).toBeGreaterThan(19);
  };

  it('3MF', () => {
    const mesh = k.mesh(part, deflectionOf(EXPORT_TOLERANCES.normal));
    const file = join(dir, 'demo.3mf');
    writeFileSync(file, export3mf([{ name: 'Demo part', mesh }]));
    slice(file);
  });

  it('STL', () => {
    const mesh = k.mesh(part, deflectionOf(EXPORT_TOLERANCES.normal));
    const file = join(dir, 'demo.stl');
    writeFileSync(file, exportStl([{ name: 'Demo part', mesh }])[0]!.bytes);
    slice(file);
  });
});
