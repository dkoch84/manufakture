// From kernel tessellations to export files. The kernel meshes a body per
// B-rep face with its own copy of every vertex; export welds that into one
// closed mesh, checks it is watertight and writes STL or 3MF.

import { checkManifold, type ManifoldReport } from './manifold';
import { mergeMeshes, weld, type NamedMesh, type TriangleSoup, type TriMesh } from './mesh';
import { placementMatrix, transformMesh, type Placement } from './placement';
import { writeBinaryStl } from './stl';
import {
  write3mf,
  type ThreeMfBuildItem,
  type ThreeMfMeshInput,
  type ThreeMfObjectInput,
  type ThreeMfWriteOptions,
} from './threemf';

/**
 * Export-time tessellation tolerances, the kernel's `Deflection`: `chordal`
 * is the largest distance (mm) between a triangle and the true surface,
 * `angular` the largest angle (radians) between neighbouring facets.
 */
export interface ExportTolerance {
  chordal: number;
  angular: number;
}

/** Named presets; `fine` is what a 0.4 mm nozzle cannot tell from the exact surface. */
export const EXPORT_TOLERANCES = {
  draft: { chordal: 0.1, angular: 0.5 },
  normal: { chordal: 0.02, angular: 0.25 },
  fine: { chordal: 0.005, angular: 0.1 },
} as const satisfies Record<string, ExportTolerance>;

export type ExportTolerancePreset = keyof typeof EXPORT_TOLERANCES;

export const DEFAULT_EXPORT_TOLERANCE: ExportTolerance = EXPORT_TOLERANCES.normal;

/** The kernel's `tessellate` deflection for a tolerance. */
export function deflectionOf(t: ExportTolerance): { linear: number; angular: number } {
  if (!(t.chordal > 0) || !(t.angular > 0)) {
    throw new RangeError('export tolerances must be positive');
  }
  return { linear: t.chordal, angular: t.angular };
}

export interface ExportBody {
  name: string;
  /** A kernel mesh (`MeshData`) or any triangle soup, wound counter-clockwise from outside. */
  mesh: TriangleSoup;
  /** `#rrggbb`; 3MF writes it as the object's colour (STL has none). */
  color?: string;
}

export class NotWatertightError extends Error {
  override readonly name = 'NotWatertightError';
  constructor(
    readonly body: string,
    readonly report: ManifoldReport,
  ) {
    super(`${body} is not watertight: ${report.problems.join('; ')}`);
  }
}

/**
 * Weld a body's mesh and check it is watertight. Throws `NotWatertightError`
 * rather than write a file a slicer would have to repair.
 */
export function exportMesh(body: ExportBody): NamedMesh {
  const mesh = weld(body.mesh);
  const report = checkManifold(mesh);
  if (!report.ok) throw new NotWatertightError(body.name, report);
  return { name: body.name, mesh };
}

export interface StlFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Binary STL: one file of every body (`merge`, the default) or one file per
 * body. File names are the body names with `.stl`.
 */
export function exportStl(
  bodies: readonly ExportBody[],
  options: { merge?: boolean; fileName?: string } = {},
): StlFile[] {
  const meshes = bodies.map(exportMesh);
  if (options.merge ?? true) {
    const name = options.fileName ?? (meshes.length === 1 ? meshes[0]!.name : 'bodies');
    const merged: TriMesh = mergeMeshes(meshes.map((m) => m.mesh));
    return [{ name: fileName(name, 'stl'), bytes: writeBinaryStl(merged, { header: name }) }];
  }
  return meshes.map((m) => ({
    name: fileName(m.name, 'stl'),
    bytes: writeBinaryStl(m.mesh, { header: m.name }),
  }));
}

/** A 3MF package with one object per body, named and coloured after it, in millimetres. */
export function export3mf(
  bodies: readonly ExportBody[],
  options: ThreeMfWriteOptions = {},
): Uint8Array {
  return write3mf(bodies.map(meshInput), options);
}

/** A body welded and checked, with its colour, as `write3mf` takes it. */
function meshInput(body: ExportBody): ThreeMfMeshInput {
  const named = exportMesh(body);
  return body.color === undefined ? named : { ...named, color: body.color };
}

/**
 * An assembly to export: the bodies of its parts, each meshed once in its part's coordinates,
 * the parts (by body index), and the instances placing them.
 */
export interface ExportAssembly {
  bodies: readonly ExportBody[];
  /**
   * Each part's name and its bodies, by index in `bodies`. `oneObject` keeps a part of several
   * bodies as one 3MF object with a part per body (a sign with inlaid letters, bodies that touch)
   * instead of an object per body; see `export3mfAssembly`.
   */
  parts: readonly { name: string; bodies: readonly number[]; oneObject?: boolean }[];
  /** Each instance: its part (by index in `parts`), its name and where it is. */
  instances: readonly { part: number; name: string; placement: Placement }[];
}

/** Why `assembly` cannot be exported, or null; every body and part must be used. */
function assemblyProblem(assembly: ExportAssembly): string | null {
  const { bodies, parts, instances } = assembly;
  if (instances.length === 0) return 'the assembly has no instances';
  const owner = new Set<number>();
  for (const [p, part] of parts.entries()) {
    if (part.bodies.length === 0) return `part ${p} has no bodies`;
    for (const b of part.bodies) {
      if (!Number.isInteger(b) || b < 0 || b >= bodies.length || owner.has(b)) {
        return `part ${p}: body ${b} is not in the list, or in another part`;
      }
      owner.add(b);
    }
  }
  if (owner.size !== bodies.length) return 'every body must belong to a part';
  const used = new Set<number>();
  for (const i of instances) {
    if (!Number.isInteger(i.part) || i.part < 0 || i.part >= parts.length) {
      return `instance ${i.name} names part ${i.part}, which is not in the list`;
    }
    used.add(i.part);
  }
  if (used.size !== parts.length) return 'every part needs an instance';
  return null;
}

/**
 * A 3MF package of an assembly, laid out the way OrcaSlicer, Bambu Studio and PrusaSlicer all
 * keep names, colours and positions (docs/research/slicer-handoff.md, section 6): every body
 * is welded and checked once, then written once per instance that shows it, as a mesh object of
 * its own (in its part's coordinates, with its colour) placed by a build item at the instance's
 * transform. The object is named after the part when the part has one body, after the body
 * otherwise. One object placed by several build items is avoided on purpose: those slicers split
 * it and drop the name and colour of every copy after the first.
 *
 * A part of several bodies marked `oneObject` is instead written, per instance, as its bodies'
 * mesh objects plus one components object named after the part (placed by the build item), with
 * the `Metadata/model_settings.config` `write3mf` adds for components, so the slicers show one
 * object with a named part per body, each in its colour's slot. PrusaSlicer shows the bodies as
 * separate objects either way.
 */
export function export3mfAssembly(
  assembly: ExportAssembly,
  options: Omit<ThreeMfWriteOptions, 'items'> = {},
): Uint8Array {
  const why = assemblyProblem(assembly);
  if (why !== null) throw new RangeError(why);
  const meshes = assembly.bodies.map(meshInput);
  const objects: ThreeMfObjectInput[] = [];
  const items: ThreeMfBuildItem[] = [];
  for (const instance of assembly.instances) {
    const part = assembly.parts[instance.part]!;
    const transform = placementMatrix(instance.placement);
    if (part.oneObject && part.bodies.length > 1) {
      const first = objects.length;
      for (const b of part.bodies) objects.push(meshes[b]!);
      objects.push({
        name: part.name,
        components: part.bodies.map((_, k) => ({ object: first + k })),
      });
      items.push({ object: objects.length - 1, transform });
      continue;
    }
    for (const b of part.bodies) {
      const body = meshes[b]!;
      objects.push(part.bodies.length === 1 ? { ...body, name: part.name } : body);
      items.push({ object: objects.length - 1, transform });
    }
  }
  return write3mf(objects, { ...options, items });
}

/**
 * One binary STL of an assembly: every instance's bodies moved into place and merged (STL has
 * no instances or transforms). Each body is welded and checked once.
 */
export function exportStlAssembly(
  assembly: ExportAssembly,
  options: { fileName?: string } = {},
): StlFile {
  const why = assemblyProblem(assembly);
  if (why !== null) throw new RangeError(why);
  const meshes = assembly.bodies.map(exportMesh);
  const placed: TriMesh[] = [];
  for (const i of assembly.instances) {
    const m = placementMatrix(i.placement);
    for (const b of assembly.parts[i.part]!.bodies) placed.push(transformMesh(meshes[b]!.mesh, m));
  }
  const name = options.fileName ?? 'assembly';
  return {
    name: fileName(name, 'stl'),
    bytes: writeBinaryStl(mergeMeshes(placed), { header: name }),
  };
}

/** Longest base name `fileName` returns, in UTF-8 bytes (file systems allow 255 with the extension). */
export const MAX_FILE_NAME_BYTES = 200;

/**
 * Bidirectional formatting characters: embeddings and overrides (U+202A to U+202E), isolates
 * (U+2066 to U+2069) and the marks (U+200E, U+200F, U+061C). An override in a name can make
 * `evil\u202Eexe.stl` display as `evilstl.exe`, so none of them reaches a file name.
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/**
 * A file name from a body or document name: path separators, reserved and control characters
 * replaced, bidirectional controls removed, and the base cut to `MAX_FILE_NAME_BYTES` of UTF-8
 * on a character boundary, without trailing dots or spaces (Windows drops them).
 */
export function fileName(name: string, extension: string): string {
  const printable = [...name.replace(BIDI_CONTROLS, '')]
    .map((c) => {
      const code = c.codePointAt(0)!;
      // Controls, DEL, and unpaired surrogates (which no file system name can hold).
      return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff) ? '_' : c;
    })
    .join('');
  const safe = printable.replace(/[\\/:*?"<>|]+/g, '_').trim();
  const encoder = new TextEncoder();
  let base = '';
  let bytes = 0;
  for (const c of safe) {
    bytes += encoder.encode(c).length;
    if (bytes > MAX_FILE_NAME_BYTES) break;
    base += c;
  }
  base = base.replace(/[. ]+$/, '');
  return `${base || 'export'}.${extension}`;
}
