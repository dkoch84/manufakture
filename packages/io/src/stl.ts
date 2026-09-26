// STL: binary writer, binary and ASCII parser. STL has no units; by the
// convention every slicer follows, the numbers are millimetres.

import { cross, sub, weld, type TriMesh, type Vec3, type WeldOptions } from './mesh';

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

export interface StlWriteOptions {
  /** Up to 80 ASCII characters. Must not start with `solid`, which marks ASCII STL. */
  header?: string;
}

/** Binary STL of one mesh, facet normals from the winding (counter-clockwise from outside). */
export function writeBinaryStl(
  mesh: TriMesh,
  options: StlWriteOptions = {},
): Uint8Array<ArrayBuffer> {
  const triangles = Math.floor(mesh.indices.length / 3);
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles * TRIANGLE_BYTES);
  const bytes = new Uint8Array(buffer);
  const header = sanitizeHeader(options.header ?? 'manufakture binary STL, millimetres');
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  const view = new DataView(buffer);
  view.setUint32(HEADER_BYTES, triangles, true);
  const p = mesh.positions;
  const point = (i: number): Vec3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
  let o = HEADER_BYTES + 4;
  for (let t = 0; t < triangles; t++) {
    const a = point(mesh.indices[t * 3]!);
    const b = point(mesh.indices[t * 3 + 1]!);
    const c = point(mesh.indices[t * 3 + 2]!);
    const n = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(n[0], n[1], n[2]);
    for (const v of [len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 0], a, b, c]) {
      view.setFloat32(o, v[0]!, true);
      view.setFloat32(o + 4, v[1]!, true);
      view.setFloat32(o + 8, v[2]!, true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

function sanitizeHeader(text: string): string {
  let h = text.replace(/[^\x20-\x7e]/g, '?').slice(0, HEADER_BYTES);
  if (/^\s*solid/i.test(h)) h = `STL ${h}`.slice(0, HEADER_BYTES);
  return h;
}

export interface ParsedStl {
  /** The ASCII `solid` name, or the binary header's text (trimmed); may be empty. */
  name: string;
  format: 'binary' | 'ascii';
  /** Welded: one vertex per distinct point, so edges can be checked and measured. */
  mesh: TriMesh;
  /** Triangles in the file, before welding dropped degenerate ones. */
  fileTriangles: number;
}

export class StlParseError extends Error {
  override readonly name = 'StlParseError';
}

/**
 * Parse an STL file, binary or ASCII. Binary is recognised by its size
 * (80 + 4 + 50 n bytes), not by the header: many binary files start with
 * `solid` too.
 */
export function parseStl(bytes: Uint8Array, options: WeldOptions = {}): ParsedStl {
  if (bytes.length >= HEADER_BYTES + 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(HEADER_BYTES, true);
    if (bytes.length === HEADER_BYTES + 4 + count * TRIANGLE_BYTES) {
      return parseBinary(bytes, view, count, options);
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (/^\s*solid\b/.test(text)) return parseAscii(text, options);
  throw new StlParseError('this is not an STL file (neither binary nor ASCII STL)');
}

function parseBinary(
  bytes: Uint8Array,
  view: DataView,
  count: number,
  options: WeldOptions,
): ParsedStl {
  const soup = new Float32Array(count * 9);
  let o = HEADER_BYTES + 4;
  for (let t = 0; t < count; t++) {
    o += 12; // The stored normal: recomputed from the winding wherever it is needed.
    for (let k = 0; k < 9; k++) {
      soup[t * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  checkFinite(soup);
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, HEADER_BYTES));
  const name = header.replace(/\0.*$/s, '').trim();
  return { name, format: 'binary', mesh: fromSoup(soup, options), fileTriangles: count };
}

function parseAscii(text: string, options: WeldOptions): ParsedStl {
  const name = /^\s*solid[ \t]*([^\r\n]*)/.exec(text)?.[1]?.trim() ?? '';
  const values: number[] = [];
  const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (const m of text.matchAll(vertex)) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (values.length === 0) throw new StlParseError('the STL file has no triangles');
  if (values.length % 9 !== 0) {
    throw new StlParseError('the STL file has a facet without exactly three vertices');
  }
  const soup = new Float32Array(values);
  checkFinite(soup);
  return {
    name,
    format: 'ascii',
    mesh: fromSoup(soup, options),
    fileTriangles: values.length / 9,
  };
}

function checkFinite(values: Float32Array): void {
  for (const v of values) {
    if (!Number.isFinite(v))
      throw new StlParseError('the STL file has a coordinate that is not a number');
  }
}

function fromSoup(soup: Float32Array, options: WeldOptions): TriMesh {
  const indices = new Uint32Array(soup.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return weld({ positions: soup, indices }, options);
}
