// Interoperability with other programs, when they are installed: FreeCAD
// reopens our STEP (volume, face count, bounding box) and PrusaSlicer's CLI
// slices our 3MF and STL, an assembly's included, and a coloured, oriented 3MF in both layouts.
// OrcaSlicer's CLI (M3 plan, T3.3c) loads what export3mfAssembly writes and the slicer fixtures
// (src/fixtures/slicers/), writes each back as a project 3MF and slices it for a Bambu Lab X1
// Carbon with two filament slots, through scripts/orca-matrix.ts; the names and filament slots
// it records in Metadata/model_settings.config, the positions and the G-code's slots must be
// what docs/research/slicer-handoff.md section 6 found. Each check is
// skipped when its program is missing (or, for OrcaSlicer, does not start), so local runs need
// none of them; the `interop` CI job installs them. Commands can be overridden with FREECADCMD,
// SLICER_CMD and ORCA_CMD (whitespace-separated, e.g. `xvfb-run -a prusa-slicer`, or
// `<dir>/squashfs-root/AppRun` for an extracted OrcaSlicer AppImage; ORCA_PROFILES names its
// `resources/profiles` when they are not next to the command).
// Drawings (T4.4f): Inkscape converts our SVG of the M1 bracket drawing to PNG, and LibreCAD's
// console mode (`librecad dxf2pdf`, run with QT_QPA_PLATFORM=offscreen) converts our DXF to PDF;
// overridden with INKSCAPE_CMD and LIBRECAD_CMD, skipped when missing like the others.
// Set INTEROP_KEEP=1 to keep the files it writes.
//
// INTEROP_BRACKET_DIR points at the M1 bracket as the app exported it in the browser
// (bracket.step, bracket.3mf, bracket.stl and expected.json, written by
// apps/web/e2e/m1-bracket.spec.ts to apps/web/test-results/m1-bracket/); the same checks then
// run on those files. Unset or missing, they are skipped.

import type { Kernel, ShapeId } from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertOutsideRepo,
  defaultProfiles,
  orcaVersion,
  placedBounds,
  runMatrix,
  type FixtureResult,
  type OrcaObject,
  type OrcaRun,
} from '../scripts/orca-matrix';
import {
  EXPORT_TOLERANCES,
  deflectionOf,
  export3mf,
  export3mfAssembly,
  exportStl,
  exportStlAssembly,
  type ExportAssembly,
} from './export';
import { drawingToDxf, drawingToSvg } from './drawing-export';
import { bracketSheet } from './sheet-test-helpers';
import { boxMesh } from './test-helpers';
import { validate3mf } from './threemf';

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
const orca = orcaSlicer();
const inkscape = command('INKSCAPE_CMD', ['inkscape']);
const librecad = command('LIBRECAD_CMD', ['librecad']);

/**
 * OrcaSlicer's command, version and profiles, or why it is skipped: not installed, does not
 * start (a missing library, say: the job skips rather than fails), or no profiles found.
 */
function orcaSlicer(): { cmd: string[]; version: string; profiles: string } | { skipped: string } {
  const cmd = command('ORCA_CMD', ['orca-slicer', 'OrcaSlicer']);
  if (!cmd) return { skipped: 'not found' };
  const probe = mkdtempSync(join(tmpdir(), 'manufakture-orca-probe-'));
  try {
    const version = orcaVersion(cmd, probe);
    if (!version) return { skipped: `${cmd.join(' ')} does not start` };
    const profiles = process.env.ORCA_PROFILES?.trim() || defaultProfiles(cmd);
    return { cmd, version, profiles };
  } catch (e) {
    return { skipped: String(e) };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

let k: Kernel;
let dir: string;
let part: ShapeId;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'manufakture-interop-'));
  console.log(
    `interop: FreeCAD ${freecad ? freecad.join(' ') : 'not found, skipped'}; ` +
      `slicer ${slicer ? slicer.join(' ') : 'not found, skipped'}; ` +
      `OrcaSlicer ${'cmd' in orca ? `${orca.version} (${orca.cmd.join(' ')})` : `${orca.skipped}, skipped`}`,
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

describe.skipIf(!slicer)('a slicer slices our assembly files', () => {
  /** The demo part twice: as it is, and turned a quarter about z next to it, both on the bed. */
  const assembly = (): ExportAssembly => ({
    bodies: [{ name: 'Demo part', mesh: k.mesh(part, deflectionOf(EXPORT_TOLERANCES.normal)) }],
    parts: [{ name: 'Demo part', bodies: [0] }],
    instances: [
      { part: 0, name: 'Left', placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
      {
        part: 0,
        name: 'Right',
        // x 10..70, y 10..50 turns to x -50..-10, y 10..70; then x 80..120.
        placement: { translation: [130, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      },
    ],
  });

  it('3MF with two placed instances', () => {
    const file = join(dir, 'assembly.3mf');
    writeFileSync(file, export3mfAssembly(assembly()));
    slice(file, 20);
  });

  it('STL of the placed instances merged', () => {
    const file = join(dir, 'assembly.stl');
    writeFileSync(file, exportStlAssembly(assembly()).bytes);
    slice(file, 20);
  });
});

describe.skipIf(!slicer)('a slicer slices our coloured, oriented files', () => {
  /**
   * The demo part (red) and a peg beside it (blue) as one part, stood on its side: a quarter
   * turn about x takes the part's 40 mm depth to its height, and a move puts it back on the bed.
   */
  const assembly = (oneObject: boolean): ExportAssembly => {
    const deflection = deflectionOf(EXPORT_TOLERANCES.normal);
    const peg = k.box(10, 10, 30, [80, 10, 0]);
    const bodies = [
      { name: 'Demo part', mesh: k.mesh(part, deflection), color: '#ff0000' },
      { name: 'Peg', mesh: k.mesh(peg, deflection), color: '#0000ff' },
    ];
    k.release(peg);
    return {
      bodies,
      parts: [{ name: 'Jig', bodies: [0, 1], oneObject }],
      instances: [
        {
          part: 0,
          name: 'Jig',
          // (x, y, z) to (x, -z, y), then down 10 (z 0..40) and towards the middle of the bed,
          // clear of the excluded corner some printers have near the origin.
          placement: {
            translation: [60, 120, -10],
            rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          },
        },
      ],
    };
  };

  it('3MF with an object per body, colour groups and a turned build item', () => {
    const file = join(dir, 'coloured.3mf');
    writeFileSync(file, export3mfAssembly(assembly(false), { title: 'Coloured jig' }));
    slice(file, 40);
  });

  it('3MF with a components object and its model_settings.config', () => {
    const file = join(dir, 'coloured-one-object.3mf');
    writeFileSync(file, export3mfAssembly(assembly(true), { title: 'Coloured jig' }));
    slice(file, 40);
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

// OrcaSlicer (see the top of this file).

/** What OrcaSlicer must record for an object: its name and slot, and its parts' when it has some. */
interface OrcaExpected {
  name: string;
  /** The `extruder` (1-based filament slot) in model_settings.config. */
  slot: number;
  /** For a components object: each part's name and slot, the parts printing in their own slots. */
  parts?: { name: string; slot: number }[];
}

const SLOT_RED = { slot: 1 };
const SLOT_BLUE = { slot: 2 };

/**
 * The slicer fixtures whose OrcaSlicer 2.4.2 results the export relies on (section 6 of the
 * research note). 03, 04 and 08 are layouts the writer avoids (components without
 * model_settings.config, `pindex`, an object placed twice), so they only have to load and slice.
 */
const FIXTURE_EXPECTED: Record<string, OrcaExpected[] | null> = {
  '01-core.3mf': [
    { name: 'Red box', ...SLOT_RED },
    { name: 'Blue box', ...SLOT_RED },
  ],
  '02-colorgroups.3mf': [
    { name: 'Red box', ...SLOT_RED },
    { name: 'Blue box', ...SLOT_BLUE },
  ],
  '03-components.3mf': null,
  '04-pindex-triangles.3mf': null,
  '05-model-settings.3mf': [
    { name: 'Red box', ...SLOT_RED },
    { name: 'Blue box', ...SLOT_BLUE },
  ],
  '06-transforms.3mf': [
    { name: 'Red box', ...SLOT_RED },
    { name: 'Blue box', ...SLOT_BLUE },
  ],
  '07-components-model-settings.3mf': [
    {
      name: 'Two boxes',
      ...SLOT_RED,
      parts: [
        { name: 'Red box', ...SLOT_RED },
        { name: 'Blue box', ...SLOT_BLUE },
      ],
    },
  ],
  '08-instances.3mf': null,
};

/** The X1 Carbon's printable area and the corner it excludes at the bed origin, mm. */
const X1C_BED = 256;
const X1C_EXCLUDED = { x: 18, y: 28 };

/**
 * A red box and a blue box as one part, as the export writes it (T3.3a): an object per body,
 * placed twice (once as modelled, once turned a quarter about x), or one components object.
 * Everything sits near the middle of the bed, clear of the X1 Carbon's excluded corner.
 */
function twoColourJig(oneObject: boolean): ExportAssembly {
  return {
    bodies: [
      { name: 'Red box', mesh: boxMesh([0, 0, 0], [20, 20, 10]), color: '#ff0000' },
      { name: 'Blue box', mesh: boxMesh([25, 0, 0], [30, 15, 8]), color: '#0000ff' },
    ],
    parts: [{ name: 'Jig', bodies: [0, 1], oneObject }],
    instances: oneObject
      ? [{ part: 0, name: 'Jig', placement: { translation: [90, 110, 0], rotation: [0, 0, 0, 1] } }]
      : [
          {
            part: 0,
            name: 'Jig',
            placement: { translation: [90, 110, 0], rotation: [0, 0, 0, 1] },
          },
          {
            part: 0,
            name: 'Jig 2',
            // (x, y, z) to (x, -z, y): the boxes stand on their sides, y 170..180.
            placement: {
              translation: [90, 180, 0],
              rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            },
          },
        ],
  };
}

/** Our exports for the load check: file name, bytes, and what OrcaSlicer must record. */
function ourExports(): { file: string; bytes: Uint8Array; expected: OrcaExpected[] }[] {
  return [
    {
      file: 'jig-objects.3mf',
      bytes: export3mfAssembly(twoColourJig(false), { title: 'Two-colour jig' }),
      // Two bodies, so each object is named after its body; each placement its own objects.
      expected: [
        { name: 'Red box', ...SLOT_RED },
        { name: 'Blue box', ...SLOT_BLUE },
        { name: 'Red box', ...SLOT_RED },
        { name: 'Blue box', ...SLOT_BLUE },
      ],
    },
    {
      file: 'jig-one-object.3mf',
      bytes: export3mfAssembly(twoColourJig(true), { title: 'Two-colour jig' }),
      expected: [
        {
          name: 'Jig',
          ...SLOT_RED,
          parts: [
            { name: 'Red box', ...SLOT_RED },
            { name: 'Blue box', ...SLOT_BLUE },
          ],
        },
      ],
    },
  ];
}

/**
 * The 3MF with its materials namespace bound to another prefix (`mat:colorgroup`): still a valid
 * 3MF, but OrcaSlicer 2.4.2 reads colour groups by the prefix `m` and puts every object in slot 1.
 * The deliberately broken input the check must fail on.
 */
function withMaterialsPrefix(bytes: Uint8Array, prefix: string): Uint8Array {
  const files = unzipSync(bytes);
  const model = strFromU8(files['3D/3dmodel.model']!)
    .replace('xmlns:m=', `xmlns:${prefix}=`)
    .replace(/<(\/?)m:/g, `<$1${prefix}:`);
  files['3D/3dmodel.model'] = strToU8(model);
  return zipSync(files, { level: 6 });
}

type Bounds = NonNullable<OrcaObject['bounds']>;

const boundsKey = (b: Bounds | null) =>
  b ? [...b.min, ...b.max].map((v) => (Math.round(v * 100) / 100 + 0).toFixed(2)).join(' ') : '-';

/** What is wrong with what OrcaSlicer made of a file; empty when all is as expected. */
function orcaProblems(
  result: FixtureResult,
  expected: OrcaExpected[] | null,
  input: Uint8Array,
): string[] {
  const problems: string[] = [];
  const ran = (label: string, run: OrcaRun) => {
    if (run.status !== 0 || run.result?.return_code !== 0) {
      problems.push(
        `${label}: exit ${run.status}, ${run.result?.error_string ?? 'no result.json'}\n${run.tail ?? ''}`,
      );
      return false;
    }
    if (run.objects.length === 0) problems.push(`${label}: no model_settings.config objects`);
    return true;
  };
  const loaded = ran('load', result.load);
  const sliced = ran('slice', result.slice);
  if (sliced && result.slice.gcodeSlots === null) problems.push('slice: no G-code');
  if (!expected) return problems;

  const summary = (
    o: Omit<OrcaExpected, 'parts'> & { parts?: OrcaExpected['parts'] | undefined },
  ) =>
    `${o.name} slot ${o.slot}` +
    (o.parts ? ` [${o.parts.map((p) => `${p.name} slot ${p.slot}`).join(', ')}]` : '');
  const want = expected.map(summary).sort();
  // Positions as the file places them: the runs do not arrange the plate.
  const wantBounds = [...placedBounds(unzipSync(input)).values()].map(boundsKey).sort();
  for (const [label, run] of [
    ['load', result.load],
    ['slice', result.slice],
  ] as const) {
    if (label === 'load' ? !loaded : !sliced) continue;
    const got = run.objects
      .map((o) =>
        summary({
          name: o.name,
          slot: Number(o.extruder),
          // Plain objects have one part named after them with no slot of its own.
          parts: expected.some((e) => e.name === o.name && e.parts)
            ? o.parts.map((p) => ({ name: p.name, slot: Number(p.extruder) }))
            : undefined,
        }),
      )
      .sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`${label}: objects ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    const gotBounds = run.objects.map((o) => boundsKey(o.bounds)).sort();
    if (JSON.stringify(gotBounds) !== JSON.stringify(wantBounds)) {
      problems.push(
        `${label}: positions ${JSON.stringify(gotBounds)}, want ${JSON.stringify(wantBounds)}`,
      );
    }
  }
  if (sliced && result.slice.gcodeSlots !== null) {
    // Each object printed with its own slot, or its parts' slots.
    const wantSlots: Record<string, number[]> = {};
    for (const o of expected) {
      const slots = new Set([
        ...(wantSlots[o.name] ?? []),
        ...(o.parts?.map((p) => p.slot) ?? [o.slot]),
      ]);
      wantSlots[o.name] = [...slots].sort((a, b) => a - b);
    }
    const got = result.slice.gcodeSlots;
    const sorted = (r: Record<string, number[]> | string) =>
      typeof r === 'string' ? r : JSON.stringify(Object.entries(r).sort());
    if (sorted(got) !== sorted(wantSlots)) {
      problems.push(
        `slice: G-code slots ${JSON.stringify(got)}, want ${JSON.stringify(wantSlots)}`,
      );
    }
    const usedSlots = [...new Set(Object.values(wantSlots).flat())].sort((a, b) => a - b);
    if (JSON.stringify(result.slice.filamentsUsed) !== JSON.stringify(usedSlots)) {
      problems.push(
        `slice: filaments used ${JSON.stringify(result.slice.filamentsUsed)}, want ${JSON.stringify(usedSlots)}`,
      );
    }
  }
  return problems;
}

/** Whether a placed box overlaps the X1 Carbon's excluded corner or leaves its bed. */
function offBed(b: Bounds): boolean {
  const inCorner = b.min[0]! < X1C_EXCLUDED.x && b.min[1]! < X1C_EXCLUDED.y;
  return inCorner || b.min[0]! < 0 || b.min[1]! < 0 || b.max[0]! > X1C_BED || b.max[1]! > X1C_BED;
}

describe.skipIf(!('cmd' in orca))('OrcaSlicer loads and slices our 3MF', () => {
  const fixturesDir = fileURLToPath(new URL('./fixtures/slicers/', import.meta.url));
  const fixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.3mf'))
    .sort();
  const ours = ourExports();
  const broken = withMaterialsPrefix(readFileSync(join(fixturesDir, '02-colorgroups.3mf')), 'mat');
  const results = new Map<string, FixtureResult>();

  beforeAll(() => {
    if (!('cmd' in orca)) return;
    // The flattened profiles are the slicer's AGPL data: never inside the repository.
    const out = join(dir, 'orca');
    assertOutsideRepo(out, fileURLToPath(new URL('../../../', import.meta.url)));
    const inputs = join(out, 'inputs');
    mkdirSync(inputs, { recursive: true });
    const files = [
      ...fixtures.map((f) => join(fixturesDir, f)),
      ...ours.map(({ file, bytes }) => {
        writeFileSync(join(inputs, file), bytes);
        return join(inputs, file);
      }),
    ];
    writeFileSync(join(inputs, 'broken-prefix.3mf'), broken);
    files.push(join(inputs, 'broken-prefix.3mf'));
    for (const r of runMatrix(files, orca.cmd, orca.profiles, out)) results.set(r.fixture, r);
  }, 600_000);

  it('has an expectation for every slicer fixture', () => {
    expect(fixtures).toEqual(Object.keys(FIXTURE_EXPECTED).sort());
  });

  it.each(fixtures)('fixture %s', (file) => {
    const problems = orcaProblems(
      results.get(file)!,
      FIXTURE_EXPECTED[file] ?? null,
      readFileSync(join(fixturesDir, file)),
    );
    expect(problems).toEqual([]);
  });

  it.each(ours.map((o) => o.file))('our export %s', (file) => {
    const { bytes, expected } = ours.find((o) => o.file === file)!;
    expect(validate3mf(bytes).problems).toEqual([]);
    const result = results.get(file)!;
    expect(orcaProblems(result, expected, bytes)).toEqual([]);
    for (const o of result.slice.objects) {
      expect(offBed(o.bounds!), `${o.name} ${boundsKey(o.bounds)}`).toBe(false);
    }
  });

  it('fails a colour group under another prefix (a deliberately broken fixture)', () => {
    // A valid 3MF to us; OrcaSlicer prints both boxes in slot 1, and the check says so.
    expect(validate3mf(broken).problems).toEqual([]);
    const problems = orcaProblems(
      results.get('broken-prefix.3mf')!,
      FIXTURE_EXPECTED['02-colorgroups.3mf']!,
      broken,
    );
    expect(problems.join('\n')).toMatch(/load: objects .*Blue box slot 1/);
    expect(problems.join('\n')).toMatch(/slice: G-code slots/);
  });
});

describe.skipIf(!inkscape)('Inkscape opens our drawing SVG', () => {
  it('exports the M1 bracket drawing to PNG', () => {
    const svg = join(dir, 'bracket-drawing.svg');
    const png = join(dir, 'bracket-drawing.png');
    writeFileSync(svg, drawingToSvg(bracketSheet()));
    const r = run(inkscape!, ['--export-type=png', `--export-filename=${png}`, svg]);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(png) && statSync(png).size > 1000, r.out).toBe(true);
  });
});

describe.skipIf(!librecad)('LibreCAD opens our drawing DXF', () => {
  it('converts the M1 bracket drawing to PDF', () => {
    const dxf = join(dir, 'bracket-drawing.dxf');
    const pdf = join(dir, 'bracket-drawing.pdf');
    writeFileSync(dxf, drawingToDxf(bracketSheet()));
    const r = run(librecad!, ['dxf2pdf', '-o', pdf, dxf], { QT_QPA_PLATFORM: 'offscreen' });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(pdf), r.out).toBe(true);
    expect(readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
