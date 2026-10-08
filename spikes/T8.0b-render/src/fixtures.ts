// The three fixtures of the M8 plan, built as documents from commands and regenerated in Node on
// the real kernel (libcascade through `createNodeService`) and the real planegcs solver, with the
// domains the app's regen worker registers (stock, wood, construction):
//
// - the M1 bracket (docs/m1-acceptance.md): an L profile extruded 30 mm, two M4 counterbored
//   holes through the foot and a 4 mm fillet in the inside corner. The app's e2e test builds it
//   through the UI (apps/web/e2e/bracket.ts), so it is rebuilt here with commands to the same
//   dimensions (`BRACKET`), and its volume checked against the e2e test's hand computation;
// - the M4 bookshelf (docs/m4-acceptance.md), twelve boards with joints: the same batch as
//   apps/web/e2e/m4-fixtures.ts `buildBookshelf`;
// - the M6 shed, the 12' x 16' framed shed: the same batch as apps/web/e2e/shed-fixture.ts.
//
// `sceneOf` turns a regen result into what the renderers draw: body meshes with their B-rep edge
// polylines, and framing members as instances of shared meshes (a column-major 4x4 per member).

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '../../../packages/core/src/index.ts';
import { registerConstruction } from '../../../packages/domain-construction/src/index.ts';
import { houseCommands } from '../../../packages/domain-construction/src/fixtures/house.ts';
import { registerWood } from '../../../packages/domain-wood/src/index.ts';
import type { KernelService } from '../../../packages/kernel/src/index.ts';
import { createNodeService } from '../../../packages/kernel/src/node.ts';
import {
  ExtensionRegistry,
  RegenEngine,
  type MemberMesh,
  type RegenResult,
} from '../../../packages/regen/src/index.ts';
import { createSolverService } from '../../../packages/sketch/src/index.ts';
import { registerStock } from '../../../packages/stock/src/index.ts';
import { BRACKET, bracketVolume } from '../../../apps/web/e2e/bracket.ts';
import {
  BOARDS,
  INCH_UNITS,
  JOINTS,
  SHELF,
  boardFeature,
  boardNames,
  carcassSketches,
  configurationCommands,
  frameSketch,
  jointFeature,
} from '../../../apps/web/e2e/m4-fixtures.ts';
import { FT_IN_UNITS, SHED } from '../../../apps/web/e2e/shed-fixture.ts';

export type FixtureName = 'bracket' | 'bookshelf' | 'shed' | 'house';
/** The plan's three fixtures. */
export const FIXTURE_NAMES: readonly FixtureName[] = ['bracket', 'bookshelf', 'shed'];
/** Plus the T6.5d house (794 members), for the plan's risk of thousands of framing members. */
export const STRESS_NAMES: readonly FixtureName[] = ['house'];

const PART = 'part#1';
const mm = (v: number | string) => ({ source: String(v), lengthUnit: 'mm', angleUnit: 'deg' });

function build(name: string, commands: readonly unknown[]): ManufaktureDocument {
  let doc = createDocument({ id: `doc-${name}`, name });
  for (const c of commands) {
    const r = applyCommand(doc, c as Command);
    if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const line = (id: string, a: [number, number], b: [number, number]) => ({
  id,
  kind: 'line',
  construction: false,
  start: a,
  end: b,
});

/** The M1 bracket, to `BRACKET`'s dimensions, at a 6 mm wall. */
export function bracketDocument(t = 6): ManufaktureDocument {
  const { length: L, height: H, width: W, fillet: R, holes, hole } = BRACKET;
  // On Front (XZ): sketch x is world X, sketch y is world Z, so the normal is -Y.
  const front = { type: 'plane', origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
  const footTop = { type: 'plane', origin: [0, 0, t], normal: [0, 0, 1], xDir: [1, 0, 0] };
  return build('Bracket', [
    { type: 'setVariable', name: 'thickness', expression: mm(`${t} mm`) },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'sketch#1',
        kind: 'sketch',
        name: 'Profile',
        suppressed: false,
        plane: front,
        entities: [
          line('e1', [0, 0], [L, 0]),
          line('e2', [L, 0], [L, t]),
          line('e3', [L, t], [t, t]),
          line('e4', [t, t], [t, H]),
          line('e5', [t, H], [0, H]),
          line('e6', [0, H], [0, 0]),
        ],
        constraints: [],
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'extrude#1',
        kind: 'extrude',
        name: 'Extrude 1',
        suppressed: false,
        profile: { sketch: 'sketch#1' },
        operation: 'new',
        extent: { type: 'symmetric', distance: mm(W) },
        reverse: false,
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'sketch#2',
        kind: 'sketch',
        name: 'Hole centres',
        suppressed: false,
        plane: footTop,
        entities: holes.map((x, i) => ({
          id: `e${i + 7}`,
          kind: 'point',
          construction: false,
          position: [x, 0],
        })),
        constraints: [],
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'hole#1',
        kind: 'hole',
        name: 'M4 holes',
        suppressed: false,
        sketch: 'sketch#2',
        points: holes.map((_, i) => `e${i + 7}`),
        diameter: mm(hole.diameter),
        extent: { type: 'throughAll' },
        head: {
          type: 'counterbore',
          diameter: mm(hole.headDiameter),
          depth: mm(hole.headDepth),
        },
        standard: { size: hole.size, fit: 'normal' },
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'fillet#1',
        kind: 'fillet',
        name: 'Fillet 1',
        suppressed: false,
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
        radius: mm(R),
      },
    },
  ]);
}

/** The M4 bookshelf: `buildBookshelf`'s batch. */
export function bookshelfDocument(): ManufaktureDocument {
  const expr = (source: string) => ({ source, lengthUnit: 'in', angleUnit: 'deg' });
  return build('Bookshelf', [
    INCH_UNITS,
    { type: 'renameDocument', name: SHELF.name },
    { type: 'renamePart', partId: PART, name: 'Carcass' },
    { type: 'setVariable', name: 'width', expression: expr(`${SHELF.modelled} in`) },
    { type: 'addFeature', partId: PART, feature: frameSketch() },
    ...BOARDS.slice(0, 4).map((b) => ({
      type: 'addFeature',
      partId: PART,
      feature: boardFeature(b),
    })),
    ...carcassSketches(),
    ...BOARDS.slice(4).map((b) => ({ type: 'addFeature', partId: PART, feature: boardFeature(b) })),
    ...JOINTS.map((j) => ({ type: 'addFeature', partId: PART, feature: jointFeature(j) })),
    ...boardNames(),
    ...configurationCommands(),
  ]);
}

/** The M6 shed: shed-fixture.ts's batch. */
export function shedDocument(): ManufaktureDocument {
  return build('Shed', [FT_IN_UNITS, SHED]);
}

/** The T6.5d house (domain-construction's fixture): 794 members, 28 layer bodies. */
export function houseDocument(): ManufaktureDocument {
  return build('House', [houseCommands(PART)]);
}

export const DOCUMENTS: Record<FixtureName, () => ManufaktureDocument> = {
  bracket: () => bracketDocument(),
  bookshelf: bookshelfDocument,
  shed: shedDocument,
  house: houseDocument,
};

export function registry(): ExtensionRegistry {
  const extensions = new ExtensionRegistry();
  registerStock(extensions);
  registerWood(extensions);
  registerConstruction(extensions);
  return extensions;
}

export interface Session {
  service: KernelService;
  engine: RegenEngine;
  /**
   * Member shape meshes by key: a regen sends a shape once per engine (`memberMeshes.added`) and
   * says when no member uses it any more, as the app's member store keeps them.
   */
  memberMeshes: Map<string, MemberMesh>;
}

export async function session(): Promise<Session> {
  const service = await createNodeService();
  const engine = new RegenEngine({
    kernel: service,
    solver: createSolverService(),
    extensions: registry(),
  });
  return { service, engine, memberMeshes: new Map() };
}

export async function regen(s: Session, doc: ManufaktureDocument): Promise<RegenResult> {
  const st = s.service.stats();
  const generation = Math.max(s.engine.generation, st.generation, st.cancelledThrough) + 1;
  const result = await s.engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  for (const m of result.memberMeshes?.added ?? []) s.memberMeshes.set(m.key, m);
  for (const k of result.memberMeshes?.removed ?? []) s.memberMeshes.delete(k);
  for (const p of result.parts)
    for (const f of p.features)
      if (f.status !== 'ok')
        throw new Error(`${doc.name}: ${f.featureId} ${f.status} ${JSON.stringify(f.errors)}`);
  return result;
}

/** The bracket's volume by hand, for the check that the command-built bracket is the M1 one. */
export const bracketExpectedVolume = (t = 6) => bracketVolume(t);

// Scene -----------------------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** A triangle mesh drawn once per matrix (identity when `matrices` is null). */
export interface SceneMesh {
  /** What it is: a body id, or a member shape key. */
  key: string;
  kind: 'body' | 'member';
  positions: Float32Array;
  /** Per vertex (the Chromium reference needs them; the rasteriser shades per triangle). */
  normals: Float32Array;
  indices: Uint32Array;
  /** Edge polylines in the mesh's own frame: xyz per point, and [first point, count] per edge. */
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
  /** Column-major 4x4 per instance, mesh to world; null for one instance at the identity. */
  matrices: Float32Array | null;
  /** Per instance (one for a body): its colour. */
  colors: Rgb[];
  /** Per instance: a name (body id or member full id), for highlighting. */
  names: string[];
}

export interface Scene {
  meshes: SceneMesh[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
  instances: number;
}

export const BODY_COLOR: Rgb = [0xc2, 0xca, 0xd3];
/** Framing lumber, and sheet goods (sheathing, subfloor) a little paler. */
const MEMBER_COLOR: Rgb = [0xd8, 0xb4, 0x82];

/**
 * Crease edges of a mesh with one normal per vertex: every edge whose two triangles meet at more
 * than `angle`, plus boundary edges. Vertices are matched by position (a flat-shaded mesh repeats
 * them per face). What three.js `EdgesGeometry` does, as the viewport draws members.
 */
export function creaseEdges(
  positions: Float32Array,
  indices: Uint32Array,
  /** cos 20 degrees, as a literal: no transcendental function anywhere in the pipeline. */
  cos = 0.9396926207859084,
): { edgePositions: Float32Array; edgeRanges: Uint32Array } {
  const ids = new Map<string, number>();
  const vid = new Uint32Array(positions.length / 3);
  for (let i = 0; i < vid.length; i++) {
    const k = `${Math.round(positions[3 * i]! * 1e4)},${Math.round(positions[3 * i + 1]! * 1e4)},${Math.round(positions[3 * i + 2]! * 1e4)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = i));
    vid[i] = id;
  }
  const normals: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const ux = positions[3 * b]! - positions[3 * a]!;
    const uy = positions[3 * b + 1]! - positions[3 * a + 1]!;
    const uz = positions[3 * b + 2]! - positions[3 * a + 2]!;
    const vx = positions[3 * c]! - positions[3 * a]!;
    const vy = positions[3 * c + 1]! - positions[3 * a + 1]!;
    const vz = positions[3 * c + 2]! - positions[3 * a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals.push(nx / l, ny / l, nz / l);
  }
  const edges = new Map<string, { a: number; b: number; tris: number[] }>();
  for (let t = 0; t < indices.length / 3; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vid[indices[3 * t + e]!]!;
      const b = vid[indices[3 * t + ((e + 1) % 3)]!]!;
      if (a === b) continue;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let entry = edges.get(k);
      if (!entry) edges.set(k, (entry = { a: Math.min(a, b), b: Math.max(a, b), tris: [] }));
      entry.tris.push(t);
    }
  }
  const out: number[] = [];
  for (const { a, b, tris } of edges.values()) {
    let crease = tris.length !== 2;
    if (!crease) {
      const [s, t] = tris as [number, number];
      const d =
        normals[3 * s]! * normals[3 * t]! +
        normals[3 * s + 1]! * normals[3 * t + 1]! +
        normals[3 * s + 2]! * normals[3 * t + 2]!;
      crease = d < cos;
    }
    if (crease)
      out.push(
        positions[3 * a]!,
        positions[3 * a + 1]!,
        positions[3 * a + 2]!,
        positions[3 * b]!,
        positions[3 * b + 1]!,
        positions[3 * b + 2]!,
      );
  }
  const n = out.length / 6;
  const ranges = new Uint32Array(2 * n);
  for (let i = 0; i < n; i++) {
    ranges[2 * i] = 2 * i;
    ranges[2 * i + 1] = 2;
  }
  return { edgePositions: new Float32Array(out), edgeRanges: ranges };
}

const SHEET_ROLES = /sheath|subfloor|sheet|osb|ply/i;

/** What the renderers draw of a part studio's regen result. */
export function sceneOf(result: RegenResult, shapes: ReadonlyMap<string, MemberMesh>): Scene {
  const meshes: SceneMesh[] = [];
  for (const part of result.parts) {
    for (const body of part.bodies) {
      const m = body.mesh;
      if (!m) continue;
      meshes.push({
        key: body.bodyId,
        kind: 'body',
        positions: m.positions,
        normals: m.normals,
        indices: m.indices,
        edgePositions: m.edgePositions,
        edgeRanges: m.edgeRanges,
        matrices: null,
        colors: [BODY_COLOR],
        names: [body.bodyId],
      });
    }
  }
  const creases = new Map<string, ReturnType<typeof creaseEdges>>();
  for (const part of result.parts) {
    for (const set of part.members ?? []) {
      for (const inst of set.instances ?? []) {
        const shape = shapes.get(inst.shape);
        if (!shape) throw new Error(`no mesh for member shape ${inst.shape}`);
        let edges = creases.get(inst.shape);
        if (!edges) creases.set(inst.shape, (edges = creaseEdges(shape.positions, shape.indices)));
        meshes.push({
          key: inst.shape,
          kind: 'member',
          positions: shape.positions,
          normals: shape.normals,
          indices: shape.indices,
          ...edges,
          matrices: inst.matrices,
          colors: inst.roles.map((r) => (SHEET_ROLES.test(r) ? [0xe6, 0xcf, 0xa8] : MEMBER_COLOR)),
          names: inst.ids,
        });
      }
    }
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let instances = 0;
  for (const m of meshes) {
    const count = m.matrices ? m.matrices.length / 16 : 1;
    instances += count;
    triangles += (m.indices.length / 3) * count;
    for (let i = 0; i < count; i++) {
      const M = m.matrices;
      for (let v = 0; v < m.positions.length; v += 3) {
        let x = m.positions[v]!;
        let y = m.positions[v + 1]!;
        let z = m.positions[v + 2]!;
        if (M) {
          const o = 16 * i;
          const X = M[o]! * x + M[o + 4]! * y + M[o + 8]! * z + M[o + 12]!;
          const Y = M[o + 1]! * x + M[o + 5]! * y + M[o + 9]! * z + M[o + 13]!;
          const Z = M[o + 2]! * x + M[o + 6]! * y + M[o + 10]! * z + M[o + 14]!;
          x = X;
          y = Y;
          z = Z;
        }
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
  }
  return { meshes, bounds: { min, max }, triangles, instances };
}

/**
 * `scene` repeated on an `n` x `n` grid with `gap` mm between copies: a synthetic scene for the
 * cost of many members (the meshes are shared, as regen shares member meshes).
 */
export function tiled(scene: Scene, n: number, gap = 2000): Scene {
  const { min, max } = scene.bounds;
  const dx = max[0] - min[0] + gap;
  const dy = max[1] - min[1] + gap;
  const meshes = scene.meshes.map((m): SceneMesh => {
    const count = m.matrices ? m.matrices.length / 16 : 1;
    const matrices = new Float32Array(16 * count * n * n);
    const colors: Rgb[] = [];
    const names: string[] = [];
    let o = 0;
    for (let gy = 0; gy < n; gy++)
      for (let gx = 0; gx < n; gx++)
        for (let i = 0; i < count; i++) {
          if (m.matrices) matrices.set(m.matrices.subarray(16 * i, 16 * i + 16), o);
          else matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], o);
          matrices[o + 12] = matrices[o + 12]! + gx * dx;
          matrices[o + 13] = matrices[o + 13]! + gy * dy;
          colors.push(m.colors[i]!);
          names.push(`${gx},${gy}/${m.names[i]!}`);
          o += 16;
        }
    return { ...m, matrices, colors, names };
  });
  return {
    meshes,
    bounds: {
      min: [...min],
      max: [max[0] + (n - 1) * dx, max[1] + (n - 1) * dy, max[2]],
    },
    triangles: scene.triangles * n * n,
    instances: scene.instances * n * n,
  };
}
