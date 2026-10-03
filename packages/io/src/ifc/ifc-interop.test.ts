// Opens the test building's IFC with IfcOpenShell (T6.6a acceptance): its validator checks the file against
// the IFC4 schema (and the schema's WHERE rules when pytest is installed next to it), and its
// geometry kernel builds every product's shape. Skipped when no Python with `ifcopenshell` is
// found; IFC_PYTHON names the interpreter (default `python3`), for example a virtualenv's with
// `pip install ifcopenshell pytest`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testBuilding } from './test-building';
import { writeIfc } from './writer';

const python = process.env.IFC_PYTHON ?? 'python3';

function run(args: string[]) {
  return spawnSync(python, args, { encoding: 'utf8', timeout: 300_000 });
}

const probe = run(['-c', 'import ifcopenshell; print(ifcopenshell.version)']);
const available = probe.status === 0;
const rules = available && run(['-c', 'import _pytest']).status === 0;

const GEOMETRY = `
import sys, ifcopenshell, ifcopenshell.geom
f = ifcopenshell.open(sys.argv[1])
s = ifcopenshell.geom.settings()
ok = 0
for e in f.by_type('IfcProduct'):
    if e.Representation is None:
        continue
    ifcopenshell.geom.create_shape(s, e)
    ok += 1
print(ok)
`;

describe.skipIf(!available)('IfcOpenShell reads the test building', () => {
  let dir: string;
  let file: string;
  let products: number;

  beforeAll(async () => {
    console.log(
      `IfcOpenShell ${probe.stdout.trim()} (${python}); WHERE rules ${rules ? 'on' : 'off'}`,
    );
    dir = mkdtempSync(join(tmpdir(), 'manufakture-ifc-'));
    file = join(dir, 'building.ifc');
    const b = testBuilding();
    // Members, wall layers (3), openings (2) with their door and window (2), the slab and the
    // roof's sheet.
    products = b.members!.length + 3 + 2 + 2 + 1 + 1;
    writeFileSync(file, await writeIfc(b));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds no schema errors', () => {
    const r = run(['-m', 'ifcopenshell.validate', ...(rules ? ['--rules'] : []), file]);
    expect(r.stderr + r.stdout).toContain('No validation issues found');
    expect(r.status).toBe(0);
  });

  it('builds the shape of every product with a body', () => {
    const r = run(['-c', GEOMETRY, file]);
    expect(r.stderr).toBe('');
    expect(Number(r.stdout.trim())).toBe(products);
  });
});
