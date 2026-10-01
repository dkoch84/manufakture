// The OrcaSlicer command-line matrix (M3 plan, T3.0a): load every slicer fixture with
// OrcaSlicer's CLI, write it back as a project 3MF, slice it for a Bambu Lab X1 Carbon with a
// 0.4 mm nozzle and two filaments, and report what Orca made of the file: objects, parts, names,
// filament slot per object and part, where each object ended up, and whether slicing worked.
//
//   node scripts/orca-matrix.ts [fixture.3mf ...]          (from packages/io)
//   pnpm --filter @manufakture/io orca:matrix
//
// Environment:
//   ORCA_CMD        the command, whitespace-separated (default `orca-slicer`). An extracted
//                   AppImage works: `<dir>/squashfs-root/AppRun`. Needs no display. Bambu
//                   Studio's CLI takes the same flags and profiles, so `bambu-studio` works too.
//   ORCA_PROFILES   the `resources/profiles` directory of that install (default: found next to
//                   the command, `<dir of command>/resources/profiles`).
//   ORCA_OUT        where to write the results (default: a new directory under the OS temp dir).
//
// The CLI does not resolve a profile's `inherits` chain: given a system profile such as
// "Bambu Lab X1 Carbon 0.4 nozzle.json" it applies only the keys in that one file and leaves
// the rest at Orca's built-in defaults (a 200 x 200 x 100 mm bed, one filament colour). So the
// script flattens each profile with its parents into ORCA_OUT first. The profiles are AGPL
// data from the install; they are read at run time and never copied into this repository (keep
// ORCA_OUT outside it). Each filament profile also gets its own `filament_colour`: with one
// colour for two filaments, slicing a two-colour model fails ("Grouping error: PLA can not be
// placed in the right nozzle"), and `--filament-colour` on the command line crashes Orca 2.4.2.
//
// Prints a JSON report on stdout and writes it to ORCA_OUT/matrix.json.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

export const PRINTER = 'Bambu Lab X1 Carbon 0.4 nozzle';
export const PROCESS = '0.20mm Standard @BBL X1C';
export const FILAMENT = 'Bambu PLA Basic @BBL X1C';
/** Two filament slots, red and blue, as an AMS would hold them. */
export const FILAMENT_COLOURS = ['#FF0000', '#0000FF'];

type Json = Record<string, unknown>;

/** A profile merged with every profile it inherits from, child keys winning. */
export function flattenProfile(dir: string, name: string, seen: string[] = []): Json {
  if (seen.includes(name)) throw new Error(`profile ${name} inherits from itself`);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`no profile ${file}`);
  const own = JSON.parse(readFileSync(file, 'utf8')) as Json;
  const parent = typeof own.inherits === 'string' && own.inherits ? own.inherits : null;
  const merged = parent ? { ...flattenProfile(dir, parent, [...seen, name]), ...own } : own;
  delete merged.inherits;
  return merged;
}

export interface OrcaPart {
  id: number;
  name: string;
  subtype: string;
  extruder: string | null;
}

export interface OrcaObject {
  id: number;
  name: string;
  extruder: string | null;
  parts: OrcaPart[];
  /** World bounding box of the object's meshes as placed by its build item, mm. */
  bounds: { min: number[]; max: number[] } | null;
}

export interface OrcaRun {
  status: number | null;
  /** `error_string` and `return_code` from Orca's result.json. */
  result: { error_string?: string; return_code?: number } | null;
  objects: OrcaObject[];
  /** Filament slots the sliced plate uses (slice_info.config), 1-based. */
  filamentsUsed: number[] | null;
  /** The project's filament colours after the run. */
  filamentColours: string[] | null;
  /**
   * Per object name, the filament slots (1-based) its G-code is printed with; `'labels
   * unresolved'` when the G-code names its objects only by label id and the header's ids could
   * not be matched to the objects (see `gcodeSlots`).
   */
  gcodeSlots: Record<string, number[]> | 'labels unresolved' | null;
  /** The last lines of output when the run failed. */
  tail?: string;
}

export interface FixtureResult {
  fixture: string;
  /** Load and write back: no profiles, nothing moved (`--arrange 0`). */
  load: OrcaRun;
  /** Load, slice plate 1 for the X1 Carbon with two PLA slots, write back. */
  slice: OrcaRun;
}

const attr = (source: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] ?? null;

function metadataOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/<metadata key="([^"]*)" value="([^"]*)"\s*\/>/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Objects and parts from `Metadata/model_settings.config`. */
export function readModelSettings(xml: string): Omit<OrcaObject, 'bounds'>[] {
  const objects: Omit<OrcaObject, 'bounds'>[] = [];
  for (const m of xml.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const body = m[2]!;
    const parts: OrcaPart[] = [];
    for (const p of body.matchAll(/<part ([^>]*)>([\s\S]*?)<\/part>/g)) {
      const pm = metadataOf(p[2]!);
      parts.push({
        id: Number(attr(p[1]!, 'id')),
        name: pm.name ?? '',
        subtype: attr(p[1]!, 'subtype') ?? '',
        extruder: pm.extruder ?? null,
      });
    }
    const om = metadataOf(body.replace(/<part [\s\S]*?<\/part>/g, ''));
    objects.push({ id: Number(m[1]), name: om.name ?? '', extruder: om.extruder ?? null, parts });
  }
  return objects;
}

type Mat = number[]; // 12 numbers, 3MF row-vector convention

const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMat(text: string | null): Mat {
  return text ? text.trim().split(/\s+/).map(Number) : IDENTITY;
}

/** `a` then `b`, for row vectors: p * a * b. */
function compose(a: Mat, b: Mat): Mat {
  const r: Mat = [];
  for (let i = 0; i < 4; i++) {
    const row = [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
    for (let j = 0; j < 3; j++) {
      r.push(
        row[0]! * b[j]! + row[1]! * b[3 + j]! + row[2]! * b[6 + j]! + (i === 3 ? b[9 + j]! : 0),
      );
    }
  }
  return r;
}

/**
 * World bounds per build item in a project 3MF Orca wrote: its root model holds objects of
 * components pointing (by `p:path`) at mesh objects in `3D/Objects/*.model`.
 */
export function placedBounds(files: Record<string, Uint8Array>): Map<number, OrcaObject['bounds']> {
  const text = (path: string) => strFromU8(files[path.replace(/^\//, '')] ?? new Uint8Array());
  const meshes = new Map<string, number[][]>(); // `${path}#${id}` to vertices
  const objectsIn = (path: string, model: string) => {
    for (const m of model.matchAll(/<object ([^>]*)>([\s\S]*?)<\/object>/g)) {
      const vertices = [...m[2]!.matchAll(/<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"/g)].map(
        (v) => [Number(v[1]), Number(v[2]), Number(v[3])],
      );
      meshes.set(`${path}#${attr(m[1]!, 'id')}`, vertices);
    }
  };
  const root = text('3D/3dmodel.model');
  objectsIn('/3D/3dmodel.model', root);
  for (const path of Object.keys(files)) {
    if (path.startsWith('3D/Objects/')) objectsIn(`/${path}`, text(path));
  }
  const components = new Map<number, { key: string; m: Mat }[]>();
  for (const m of root.matchAll(/<object ([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = Number(attr(m[1]!, 'id'));
    const list = [...m[2]!.matchAll(/<component ([^>]*?)\/>/g)].map((c) => ({
      key: `${attr(c[1]!, 'p:path') ?? '/3D/3dmodel.model'}#${attr(c[1]!, 'objectid')}`,
      m: parseMat(attr(c[1]!, 'transform')),
    }));
    components.set(id, list.length ? list : [{ key: `/3D/3dmodel.model#${id}`, m: IDENTITY }]);
  }
  const out = new Map<number, OrcaObject['bounds']>();
  for (const item of root.matchAll(/<item ([^>]*?)\/>/g)) {
    const id = Number(attr(item[1]!, 'objectid'));
    const im = parseMat(attr(item[1]!, 'transform'));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const c of components.get(id) ?? []) {
      const m = compose(c.m, im);
      for (const [x, y, z] of meshes.get(c.key) ?? []) {
        for (let j = 0; j < 3; j++) {
          const w = x! * m[j]! + y! * m[3 + j]! + z! * m[6 + j]! + m[9 + j]!;
          min[j] = Math.min(min[j]!, w);
          max[j] = Math.max(max[j]!, w);
        }
      }
    }
    const round = (v: number) => Math.round(v * 1000) / 1000;
    out.set(id, Number.isFinite(min[0]) ? { min: min.map(round), max: max.map(round) } : null);
  }
  return out;
}

/**
 * Which filament each object is printed with, from a Bambu-style G-code: `M620 S<n>A` selects
 * AMS slot n (0-based), and an object's block ends with `; stop printing object <name> id:`
 * (OrcaSlicer) or `; stop printing object, unique label id: <id>` (both; Bambu Studio writes
 * only this one), the id being looked up in `labels` (see `gcodeLabels`).
 */
export function slotsPerObject(
  gcode: string,
  labels: ReadonlyMap<string, string> = new Map(),
): Record<string, number[]> {
  const out: Record<string, Set<number>> = {};
  let slot: number | null = null;
  for (const line of gcode.split('\n')) {
    const change = /^M620 S(\d+)A/.exec(line);
    if (change) slot = Number(change[1]) + 1;
    const named = /^; stop printing object (.*) id:\d+ copy \d+/.exec(line)?.[1];
    const id = /^; stop printing object, unique label id: (\d+)/.exec(line)?.[1];
    const name = named ?? (id === undefined ? undefined : labels.get(id));
    if (name !== undefined && slot !== null) (out[name] ??= new Set()).add(slot);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

/**
 * Label id to object name. A Bambu-style G-code lists its objects' label ids in model order in
 * its header (`; model label id: 8,12`), and model_settings.config lists the objects in the
 * same order; Bambu Studio's G-code names no object anywhere else.
 */
export function gcodeLabels(gcode: string, objectNames: readonly string[]): Map<string, string> {
  const ids =
    /^; model label id: (.*)$/m
      .exec(gcode)?.[1]
      ?.split(',')
      .map((x) => x.trim()) ?? [];
  if (ids.length !== objectNames.length) return new Map();
  return new Map(ids.map((id, i) => [id, objectNames[i]!]));
}

/**
 * `slotsPerObject` with the label ids resolved through `gcodeLabels`. When the G-code names
 * objects only by label id and those ids cannot be matched (their count differs from the
 * objects'), says so rather than reporting an empty map that reads like "no objects printed".
 */
export function gcodeSlots(
  gcode: string,
  objectNames: readonly string[],
): Record<string, number[]> | 'labels unresolved' {
  const labels = gcodeLabels(gcode, objectNames);
  const slots = slotsPerObject(gcode, labels);
  const byLabelOnly = /^; stop printing object, unique label id: \d+/m.test(gcode);
  return Object.keys(slots).length === 0 && labels.size === 0 && byLabelOnly
    ? 'labels unresolved'
    : slots;
}

function readRun(outDir: string, project: string, status: number | null, log: string): OrcaRun {
  const resultPath = join(outDir, 'result.json');
  const result = existsSync(resultPath)
    ? (JSON.parse(readFileSync(resultPath, 'utf8')) as OrcaRun['result'])
    : null;
  const run: OrcaRun = {
    status,
    result,
    objects: [],
    filamentsUsed: null,
    filamentColours: null,
    gcodeSlots: null,
  };
  const projectPath = join(outDir, project);
  if (!existsSync(projectPath)) {
    run.tail = log.split('\n').slice(-15).join('\n');
    return run;
  }
  const files = unzipSync(readFileSync(projectPath));
  const settings = files['Metadata/model_settings.config'];
  const bounds = placedBounds(files);
  if (settings) {
    run.objects = readModelSettings(strFromU8(settings)).map((o) => ({
      ...o,
      bounds: bounds.get(o.id) ?? null,
    }));
  }
  const info = files['Metadata/slice_info.config'];
  if (info) {
    const used = [...strFromU8(info).matchAll(/<filament ([^>]*?)\/>/g)].map((f) =>
      Number(attr(f[1]!, 'id')),
    );
    run.filamentsUsed = used.length ? used : null;
  }
  const project_settings = files['Metadata/project_settings.config'];
  if (project_settings) {
    const config = JSON.parse(strFromU8(project_settings)) as Json;
    run.filamentColours = (config.filament_colour as string[] | undefined) ?? null;
  }
  const gcode = join(outDir, 'plate_1.gcode');
  if (existsSync(gcode)) {
    run.gcodeSlots = gcodeSlots(
      readFileSync(gcode, 'utf8'),
      run.objects.map((o) => o.name),
    );
  }
  if (status !== 0) run.tail = log.split('\n').slice(-15).join('\n');
  return run;
}

export function runMatrix(fixtures: string[], orca: string[], profiles: string, out: string) {
  const bbl = join(profiles, 'BBL');
  const flat = join(out, 'profiles');
  mkdirSync(flat, { recursive: true });
  const write = (kind: string, name: string, file = name, extra: Json = {}) => {
    const path = join(flat, `${file}.json`);
    writeFileSync(path, JSON.stringify({ ...flattenProfile(join(bbl, kind), name), ...extra }));
    return path;
  };
  const machine = write('machine', PRINTER);
  const processProfile = write('process', PROCESS);
  const filaments = FILAMENT_COLOURS.map((colour, i) =>
    write('filament', FILAMENT, `filament-${i + 1}`, { filament_colour: [colour] }),
  );
  // Orca writes a result.json into --outputdir, so every run gets its own directory.
  const orcaRun = (fixture: string, label: string, args: string[]) => {
    const dir = join(out, basename(fixture, '.3mf'), label);
    mkdirSync(dir, { recursive: true });
    const r = spawnSync(
      orca[0]!,
      [...orca.slice(1), '--outputdir', dir, ...args, '--export-3mf', 'project.3mf', fixture],
      { cwd: dir, encoding: 'utf8', timeout: 600_000, env: { ...process.env, LC_ALL: 'C' } },
    );
    const log = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`;
    writeFileSync(join(dir, 'orca.log'), log);
    return readRun(dir, 'project.3mf', r.status, log);
  };
  const results: FixtureResult[] = fixtures.map((fixture) => ({
    fixture: basename(fixture),
    load: orcaRun(fixture, 'load', ['--arrange', '0']),
    slice: orcaRun(fixture, 'slice', [
      '--arrange',
      '0',
      '--slice',
      '0',
      '--load-settings',
      `${machine};${processProfile}`,
      '--load-filaments',
      filaments.join(';'),
    ]),
  }));
  return results;
}

/**
 * Refuses an output directory inside the repository: the flattened profiles written there are
 * AGPL data from the slicer install and must never be committed here.
 */
export function assertOutsideRepo(out: string, repoRoot: string): void {
  const real = (p: string) => {
    // The directory may not exist yet: resolve the nearest existing ancestor.
    let base = resolve(p);
    let rest = '';
    while (!existsSync(base) && dirname(base) !== base) {
      rest = join(basename(base), rest);
      base = dirname(base);
    }
    return join(realpathSync(base), rest);
  };
  const rel = relative(real(repoRoot), real(out));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(
      `ORCA_OUT ${out} is inside the repository; put it outside (it holds AGPL profiles)`,
    );
  }
}

/** The command's install directory's `resources/profiles`, for an extracted AppImage. */
function defaultProfiles(orca: string[]): string {
  const bin = spawnSync('sh', ['-c', `command -v "${orca[0]}"`], { encoding: 'utf8' });
  const path = realpathSync(bin.stdout.trim() || orca[0]!);
  for (const base of [dirname(path), dirname(dirname(path))]) {
    const p = join(base, 'resources', 'profiles');
    if (existsSync(p)) return p;
  }
  throw new Error(`no resources/profiles next to ${path}; set ORCA_PROFILES`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const orca = (process.env.ORCA_CMD?.trim() || 'orca-slicer').split(/\s+/);
  const profiles = process.env.ORCA_PROFILES || defaultProfiles(orca);
  const out = process.env.ORCA_OUT || mkdtempSync(join(tmpdir(), 'orca-matrix-'));
  assertOutsideRepo(out, fileURLToPath(new URL('../../../', import.meta.url)));
  mkdirSync(out, { recursive: true });
  const fixturesDir = fileURLToPath(new URL('../src/fixtures/slicers/', import.meta.url));
  const fixtures = process.argv.slice(2).length
    ? process.argv.slice(2).map((f) => resolve(f))
    : readdirSync(fixturesDir)
        .filter((f) => f.endsWith('.3mf'))
        .sort()
        .map((f) => join(fixturesDir, f));
  // Orca writes a result.json into the working directory even for --help.
  const version = spawnSync(orca[0]!, [...orca.slice(1), '--help'], {
    cwd: out,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  })
    .stdout?.split('\n')
    .find((line) => /^\w+-\d/.test(line))
    ?.replace(/:$/, '');
  const report = { version, profiles, out, results: runMatrix(fixtures, orca, profiles, out) };
  writeFileSync(join(out, 'matrix.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
