import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompiledDialect } from '../src/post/dialect';
import { GRBL } from '../src/post/grbl';
import {
  FIXTURE_ORIGIN,
  GOLDEN_STOCK,
  GRBL_GOLDENS,
  SHAPEOKO_4_XXL_FIXTURE,
  SHAPEOKO_5_PRO_4X4_FIXTURE,
} from './gcode-fixtures';
import type { GoldenFixture } from './gcode-fixtures';
import { verifyGcode } from './verify-gcode';
import type { GcodeReport, VerifyMachine } from './verify-gcode';

// The golden runner (T5.4d): every golden G-code file under `packages/cam/test/` passes the
// verifier, on both machines. Each subdirectory holding `.nc` files is one post's goldens and must
// be in `GOLDEN_SETS` with its dialect and a fixture per file. The firmware validators (grbl-sim's
// `gvalidate`, grblHAL's `grblHAL_validator`) run on the GRBL files in CI's optional
// `gcode-validate` job (`firmware-validate.sh`).

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));

interface GoldenSet {
  readonly dialect: CompiledDialect;
  readonly fixtures: Readonly<Record<string, GoldenFixture>>;
}

/** Each golden directory (relative to `packages/cam/test/`) and its dialect. */
const GOLDEN_SETS: Readonly<Record<string, GoldenSet>> = {
  grbl: { dialect: GRBL, fixtures: GRBL_GOLDENS },
};

/** Every directory under `test/` (the test directory itself included) that holds `.nc` files. */
function goldenDirs(): string[] {
  const entries = readdirSync(TEST_DIR, { recursive: true, withFileTypes: true });
  const dirs = new Set<string>();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.nc')) continue;
    const rel = e.parentPath
      .slice(TEST_DIR.length)
      .replace(/[\\/]+$/, '')
      .replace(/\\/g, '/');
    dirs.add(rel);
  }
  return [...dirs].sort();
}

function ncFiles(dir: string): string[] {
  return readdirSync(TEST_DIR + dir)
    .filter((f) => f.endsWith('.nc'))
    .sort();
}

function verify(
  dir: string,
  name: string,
  machine: VerifyMachine = SHAPEOKO_5_PRO_4X4_FIXTURE,
): GcodeReport {
  const set = GOLDEN_SETS[dir];
  if (!set) throw new Error(`test/${dir} holds .nc files but is not in GOLDEN_SETS`);
  const fixture = set.fixtures[name];
  if (!fixture) throw new Error(`test/${dir}/${name} has no fixture in gcode-fixtures.ts`);
  const r = verifyGcode(readFileSync(`${TEST_DIR}${dir}/${name}`, 'utf8'), {
    dialect: set.dialect,
    toolChange: fixture.toolChange,
    stock: GOLDEN_STOCK,
    machine,
    origin: FIXTURE_ORIGIN,
    tools: fixture.tools,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const DIRS = goldenDirs();

describe('golden G-code files', () => {
  it('live only in directories with a known dialect', () => {
    expect(DIRS.length).toBeGreaterThan(0);
    const unknown = DIRS.filter((d) => !Object.hasOwn(GOLDEN_SETS, d));
    expect(
      unknown,
      `these directories hold .nc goldens but have no dialect in GOLDEN_SETS: ${unknown.map((d) => `test/${d || '.'}`).join(', ')}`,
    ).toEqual([]);
  });

  for (const dir of DIRS) {
    it(`test/${dir}: every file has a fixture, and every fixture a file`, () => {
      const set = GOLDEN_SETS[dir];
      expect(set, `test/${dir} has no dialect in GOLDEN_SETS`).toBeDefined();
      expect(ncFiles(dir)).toEqual(Object.keys(set!.fixtures).sort());
    });

    for (const name of ncFiles(dir)) {
      for (const machine of [SHAPEOKO_5_PRO_4X4_FIXTURE, SHAPEOKO_4_XXL_FIXTURE]) {
        it(`test/${dir}/${name} passes on the ${machine.name}`, () => {
          const report = verify(dir, name, machine);
          expect(report.issues).toEqual([]);
          expect(report.ok).toBe(true);
          expect(report.moves.linear + report.moves.arc).toBeGreaterThan(0);
          expect(report.extents).toBeDefined();
        });
      }
    }
  }
});

describe('GRBL golden files', () => {
  const grbl = (name: string): GcodeReport => verify('grbl', name);

  it('reports the extents of each file', () => {
    const profile = grbl('profile-tabs.nc');
    // The tool centre runs 3.175 mm outside the 60 x 40 mm outline, down to Z -6.5, up to 15.
    expect(profile.cuttingExtents).toEqual({
      min: [-3.175, -3.175, -6.5],
      max: [63.175, 43.175, 5],
    });
    expect(profile.extents).toEqual({ min: [-3.175, -3.175, -6.5], max: [63.175, 43.175, 15] });
    expect(profile.units).toBe('mm');
    // The inch file is the same job, within the 4-decimal inch rounding.
    const inch = grbl('profile-tabs-inch.nc');
    expect(inch.units).toBe('inch');
    for (const k of ['min', 'max'] as const) {
      for (let axis = 0; axis < 3; axis++) {
        expect(inch.extents![k][axis]).toBeCloseTo(profile.extents![k][axis]!, 2);
      }
    }
    // The pocket's helical entry, arcs by their true extremes: radius 2 about (100, 15).
    const pocket = grbl('pocket.nc');
    expect(pocket.cuttingExtents!.min[1]).toBeCloseTo(3.175, 9);
    expect(pocket.moves.arc).toBe(10);
    expect(grbl('drilling.nc').cuttingExtents!.min[2]).toBe(-8);
    expect(grbl('two-tools-pause.nc').toolChanges).toBe(1);
    expect(grbl('two-tools-files-1.nc').toolChanges).toBe(0);
  });
});
