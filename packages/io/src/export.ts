// From kernel tessellations to export files. The kernel meshes a body per
// B-rep face with its own copy of every vertex; export welds that into one
// closed mesh, checks it is watertight and writes STL or 3MF.

import { checkManifold, type ManifoldReport } from './manifold';
import { mergeMeshes, weld, type NamedMesh, type TriangleSoup, type TriMesh } from './mesh';
import { writeBinaryStl } from './stl';
import { write3mf, type ThreeMfWriteOptions } from './threemf';

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

/** A 3MF package with one object per body, named after it, in millimetres. */
export function export3mf(
  bodies: readonly ExportBody[],
  options: ThreeMfWriteOptions = {},
): Uint8Array {
  return write3mf(bodies.map(exportMesh), options);
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
