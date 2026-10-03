// Representation A: a B-rep body per member through the real kernel service, the way regen
// builds M1 bodies: a named `extrude` feature per member (its cross-section extruded along its
// length), a `tools` feature (T4.2a) for its cuts, then `tessellate` and `topology` in the same
// batch, one batch per group (wall, floor, roof). Plane cuts are box tools on the removed side;
// a birdsmouth (two perpendicular half-spaces) is one box tool in the corner they make.

import {
  meshBuffers,
  type FeatureInput,
  type FeatureOutcome,
  type KernelOp,
  type KernelService,
  type MeshData,
  type ShapeId,
  type ToolItem,
  type Topology,
} from '@manufakture/kernel';
import { add, cross, dot, normalize, scale, type Plane, type Vec3 } from './geom.ts';
import { worldPlane, type Member } from './members.ts';

export interface GroupBuild {
  /** Live body shapes of the group's members, to release on the next regen of the group. */
  shapes: ShapeId[];
  triangles: number;
  /** Mesh and topology bytes handed to the main thread. */
  transferBytes: number;
  /** Time spent copying them as a worker would (structuredClone with transfer). */
  transferMs: number;
  ops: number;
  failed: number;
  /** The first few failure messages. */
  errors: string[];
}

let generation = 0;

/** Any unit vector perpendicular to `n`. */
function perpendicular(n: Vec3): Vec3 {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(n, a));
}

/** A box tool filling the half-space `dot(n, p) >= k` around `near` (the member's origin). */
function halfSpaceTool(id: string, body: string, p: Plane, size: number, near: Vec3): ToolItem {
  const x = perpendicular(p.n);
  const y = cross(p.n, x);
  const on = add(near, scale(p.n, p.k - dot(p.n, near)));
  const origin = add(on, add(scale(x, -size / 2), scale(y, -size / 2)));
  return {
    id,
    body,
    mode: 'subtract',
    primitive: { type: 'box', frame: { origin, xDir: x, normal: p.n }, size: [size, size, size] },
  };
}

/** A box tool filling the corner `dot(a.n, p) >= a.k` and `dot(b.n, p) >= b.k` (a perpendicular to b). */
function cornerTool(
  id: string,
  body: string,
  a: Plane,
  b: Plane,
  size: number,
  near: Vec3,
): ToolItem {
  if (Math.abs(dot(a.n, b.n)) > 1e-6)
    throw new Error(`${body}: notch planes are not perpendicular`);
  const y = cross(a.n, b.n);
  // The point of the planes' common line nearest `near`.
  const line = add(scale(a.n, a.k), scale(b.n, b.k));
  const origin = add(add(line, scale(y, dot(y, near) - dot(y, line))), scale(y, -size / 2));
  return {
    id,
    body,
    mode: 'subtract',
    primitive: { type: 'box', frame: { origin, xDir: b.n, normal: a.n }, size: [size, size, size] },
  };
}

function memberFeatures(m: Member, n: number): FeatureInput[] {
  const p = m.placement;
  const w = m.stock.width;
  const d = m.stock.depth;
  const id = `extrude#${n}`;
  const extrude: FeatureInput = {
    kind: 'extrude',
    id,
    profile: {
      frame: { origin: p.origin, xDir: p.y, normal: p.x },
      loops: [
        {
          entities: [
            { kind: 'line', id: 'e1', start: [0, 0], end: [w, 0] },
            { kind: 'line', id: 'e2', start: [w, 0], end: [w, d] },
            { kind: 'line', id: 'e3', start: [w, d], end: [0, d] },
            { kind: 'line', id: 'e4', start: [0, d], end: [0, 0] },
          ],
        },
      ],
    },
    extent: { type: 'blind', distance: m.length },
    mode: 'new',
  };
  if (m.cuts.length === 0) return [extrude];
  const size = 2 * m.length + 500;
  const items = m.cuts.map((c, i) =>
    c.kind === 'plane'
      ? halfSpaceTool(`c${i + 1}`, id, worldPlane(p, c.plane), size, p.origin)
      : cornerTool(`c${i + 1}`, id, worldPlane(p, c.a), worldPlane(p, c.b), size, p.origin),
  );
  return [extrude, { kind: 'tools', id: `extension#${n}`, items }];
}

let counter = 0;

/**
 * Build, mesh and "transfer" one group's members. With `mesh: false`, only the bodies (the
 * on-demand path for STEP export and drawings).
 */
export async function buildGroup(
  service: KernelService,
  members: readonly Member[],
  options: { mesh: boolean } = { mesh: true },
): Promise<GroupBuild> {
  const ops: KernelOp[] = [];
  const finals: Array<{ op: number; body: string }> = [];
  const meshOps: number[] = [];
  for (const m of members) {
    const n = ++counter;
    const features = memberFeatures(m, n);
    features.forEach((f, i) => {
      const last = i === features.length - 1;
      ops.push({
        op: 'feature',
        featureId: f.id,
        bodies: i === 0 ? [] : { result: ops.length - 1 },
        feature: f,
        keep: last,
      });
    });
    const at = ops.length - 1;
    const body = `extrude#${n}`;
    finals.push({ op: at, body });
    if (options.mesh) {
      meshOps.push(ops.length);
      ops.push({ op: 'tessellate', shape: { result: at, body } });
      ops.push({ op: 'topology', shape: { result: at, body } });
    }
  }
  const reply = await service.run({ generation: ++generation, ops });
  let failed = 0;
  const errors: string[] = [];
  const shapes: ShapeId[] = [];
  for (const f of finals) {
    const r = reply.results[f.op]!;
    if (!r.ok) {
      failed++;
      if (errors.length < 5) errors.push(`${f.body}: ${r.error.message}`);
      continue;
    }
    const outcome = r.value as FeatureOutcome;
    if (!outcome.ok) {
      failed++;
      if (errors.length < 5)
        errors.push(`${f.body}: ${outcome.errors.map((e) => e.message).join('; ')}`);
    }
    for (const b of outcome.bodies) shapes.push(b.shape);
  }
  let triangles = 0;
  let transferBytes = 0;
  let transferMs = 0;
  for (const i of meshOps) {
    const mr = reply.results[i]!;
    const tr = reply.results[i + 1]!;
    if (!mr.ok || !tr.ok) {
      failed++;
      if (errors.length < 5)
        errors.push(`mesh: ${!mr.ok ? mr.error.message : !tr.ok ? tr.error.message : ''}`);
      continue;
    }
    const mesh = mr.value as MeshData;
    const topology = tr.value as Topology;
    triangles += mesh.indices.length / 3;
    const buffers = meshBuffers(mesh);
    transferBytes +=
      buffers.reduce((s, b) => s + b.byteLength, 0) + JSON.stringify(topology).length;
    const t0 = performance.now();
    structuredClone({ mesh, topology }, { transfer: buffers });
    transferMs += performance.now() - t0;
  }
  if (meshOps.length > 0) {
    const t0 = performance.now();
    structuredClone(reply.names);
    transferMs += performance.now() - t0;
    transferBytes += JSON.stringify(reply.names).length;
  }
  return { shapes, triangles, transferBytes, transferMs, ops: ops.length, failed, errors };
}
