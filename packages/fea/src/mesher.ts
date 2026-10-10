// Bodies to a TET10 mesh with gmsh: each body's STEP imported with gmsh's OCC kernel, bonded
// bodies fragmented so shared faces mesh conformally, the element size and refinements set, the
// 3D mesh generated, and nodes, elements and every kernel face's triangles read back.
//
// Face identity (T9.0a): after importing a body's STEP, gmsh's surfaces in tag order are the
// kernel's faces in order. A body that states its kernel face count is checked against gmsh's,
// and a mismatch is a typed error rather than loads landing on the wrong faces.

import { FeaAbort, type RunContext } from './context';
import { type Gmsh, GmshError } from './gmsh';
import { estimateDof, REFINE_SAMPLING, refineBand, REQUEST_LIMITS, sizeForDof } from './limits';
import { edgeOrder, type FaceTriangles, type TetMesh } from './mesh';
import type { MeshedModel } from './solve';
import type { FeaRequest } from './types';

/** gmsh element types. */
const TET10 = 11;
const TRI6 = 9;

export interface MeshTimes {
  import: number;
  mesh: number;
}

const DEFAULT_CURVATURE = 12;

/** Pairs (dim, tag) of one dimension's tags, ascending. */
function tagsOf(dimTags: Int32Array, dim: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dimTags.length; i += 2) if (dimTags[i] === dim) out.push(dimTags[i + 1]!);
  return out.sort((a, b) => a - b);
}

function meshFailed(gmsh: Gmsh, ctx: RunContext, error: unknown): FeaAbort {
  if (error instanceof FeaAbort) return error;
  const bytes = gmsh.bytes();
  // Out of memory inside wasm shows as a failed allocation or an abort near the maximum.
  if (
    bytes >= gmsh.maxBytes - 16 * 1024 * 1024 ||
    /memory|bad_alloc|enlarge/i.test(String(error))
  ) {
    return new FeaAbort({
      code: 'memory-limit',
      message: `The mesher ran out of its memory (${Math.round(gmsh.maxBytes / 1024 ** 2)} MiB). Use a larger element size.`,
      bytes,
      limit: ctx.limits.memoryBytes,
    });
  }
  const detail = error instanceof GmshError ? `${error.message}\n${error.log}` : String(error);
  return new FeaAbort({
    code: 'mesh-failed',
    message: `gmsh could not mesh the bodies: ${error instanceof Error ? error.message : String(error)}`,
    detail: detail.slice(0, 4000),
  });
}

/**
 * Mesh the request's bodies. Refuses before meshing when the DOF estimate exceeds the limit, and
 * after meshing when the real count does.
 */
export function meshBodies(
  gmsh: Gmsh,
  request: FeaRequest,
  ctx: RunContext,
): { model: MeshedModel; estimatedDof: number; times: MeshTimes } {
  const { bodies, mesh: opts } = request;
  ctx.enter('import');
  let t = ctx.elapsed();
  // Per body: its volumes and its faces in kernel order.
  const volumes: number[][] = [];
  const faces: number[][] = [];
  try {
    gmsh.initialize();
    gmsh.setNumber('General.Terminal', 0);
    gmsh.setNumber('General.Verbosity', 2);
    gmsh.setNumber('General.NumThreads', 1);
    gmsh.addModel('fea');
    const seen = new Set<number>();
    for (let b = 0; b < bodies.length; b++) {
      ctx.check();
      const imported = gmsh.importStep(bodies[b]!.step, `body${b}`);
      gmsh.synchronize();
      const vols = tagsOf(imported, 3);
      if (vols.length === 0) {
        throw new FeaAbort({
          code: 'invalid-input',
          message: `Body ${b} has no solid in its STEP: only solids can be analysed.`,
          path: `bodies[${b}].step`,
        });
      }
      const surfs = tagsOf(gmsh.entities(2), 2).filter((s) => !seen.has(s));
      for (const s of surfs) seen.add(s);
      if (surfs.length > REQUEST_LIMITS.facesPerBody) {
        throw new FeaAbort({
          code: 'invalid-input',
          message: `Body ${b} has ${surfs.length} faces, more than ${REQUEST_LIMITS.facesPerBody}.`,
          path: `bodies[${b}].step`,
        });
      }
      const expected = bodies[b]!.faceCount;
      if (expected !== undefined && expected !== surfs.length) {
        throw new FeaAbort({
          code: 'face-mapping',
          message: `Body ${b} has ${expected} faces in the kernel but ${surfs.length} after import into the mesher, so faces cannot be matched.`,
          body: b,
          expected,
          found: surfs.length,
        });
      }
      volumes.push(vols);
      faces.push(surfs);
    }
  } catch (error) {
    throw meshFailed(gmsh, ctx, error);
  }

  // Check every face reference against the face counts before meshing. The path is built only
  // for the reference being reported.
  const checkRefs = (
    items: readonly { faces: readonly { body: number; face: number }[] }[],
    path: string,
  ) => {
    for (let i = 0; i < items.length; i++) {
      const refs = items[i]!.faces;
      for (let j = 0; j < refs.length; j++) {
        const r = refs[j]!;
        if (r.face >= faces[r.body]!.length) {
          throw new FeaAbort({
            code: 'invalid-input',
            message: `Body ${r.body} has no face ${r.face} (it has ${faces[r.body]!.length}).`,
            path: `${path}[${i}].faces[${j}]`,
          });
        }
      }
    }
  };
  checkRefs(request.fixtures, 'fixtures');
  checkRefs(request.loads, 'loads');
  checkRefs(opts.refine ?? [], 'mesh.refine');

  // Estimate the DOF from the volumes and the refined faces' areas, and refuse before meshing.
  let volume = 0;
  let surface = 0;
  const refined: { area: number; size: number }[] = [];
  try {
    for (const vols of volumes) for (const v of vols) volume += gmsh.mass(3, v);
    for (const fs of faces) for (const f of fs) surface += gmsh.mass(2, f);
    for (const r of opts.refine ?? []) {
      let area = 0;
      for (const f of r.faces) area += gmsh.mass(2, faces[f.body]![f.face]!);
      refined.push({ area, size: r.size });
    }
  } catch (error) {
    throw meshFailed(gmsh, ctx, error);
  }
  // The element size: the request's, or the default aimed at about 175k DOF. Refinements and
  // the smallest size are kept within [size / 50, size].
  const size = opts.size ?? sizeForDof(volume, surface);
  if (!(size >= REQUEST_LIMITS.minSize && size <= REQUEST_LIMITS.maxSize)) {
    throw new FeaAbort({
      code: 'invalid-input',
      message: 'The bodies have no volume to mesh.',
      path: 'bodies',
    });
  }
  const sizeMin = Math.min(
    size,
    Math.max(opts.sizeMin ?? size / 10, size / REQUEST_LIMITS.sizeRatio),
  );
  for (const r of refined) r.size = Math.min(size, Math.max(r.size, sizeMin));
  const estimatedDof = estimateDof(volume, size, refined, surface);
  ctx.dof = estimatedDof;
  if (estimatedDof > ctx.limits.maxDof) {
    throw new FeaAbort({
      code: 'dof-limit',
      message: `A mesh of element size ${+size.toPrecision(3)} mm would have about ${estimatedDof} degrees of freedom, more than the limit of ${ctx.limits.maxDof}. Use a larger element size.`,
      dof: estimatedDof,
      limit: ctx.limits.maxDof,
      estimated: true,
    });
  }

  // Bond the bodies: fragment volumes and faces together, and follow each face to its pieces.
  const faceImages: number[][][] = faces.map((fs) => fs.map((s) => [s]));
  const volumeImages: number[][] = volumes.map((vs) => vs.slice());
  try {
    if (bodies.length > 1) {
      const objects: number[] = [];
      const order: { kind: 'volume' | 'face'; body: number; index: number }[] = [];
      volumes.forEach((vs, b) =>
        vs.forEach((v, i) => {
          objects.push(3, v);
          order.push({ kind: 'volume', body: b, index: i });
        }),
      );
      faces.forEach((fs, b) =>
        fs.forEach((s, i) => {
          objects.push(2, s);
          order.push({ kind: 'face', body: b, index: i });
        }),
      );
      const { map } = gmsh.fragment(objects);
      if (map.length !== order.length) {
        throw new FeaAbort({
          code: 'face-mapping',
          message: `The mesher's fragment returned ${map.length} entries for ${order.length} entities.`,
          body: 0,
        });
      }
      for (const b of volumeImages) b.length = 0;
      order.forEach((o, k) => {
        const tags = tagsOf(map[k]!, o.kind === 'volume' ? 3 : 2);
        if (o.kind === 'volume') volumeImages[o.body]!.push(...tags);
        else faceImages[o.body]![o.index] = tags;
      });
      gmsh.synchronize();
    }
  } catch (error) {
    throw meshFailed(gmsh, ctx, error);
  }
  const times: MeshTimes = { import: ctx.elapsed() - t, mesh: 0 };

  // Sizes and the 3D mesh.
  ctx.enter('mesh');
  t = ctx.elapsed();
  ctx.mesherBytes = gmsh.bytes();
  let nodeTags: Uint32Array, coords: Float64Array;
  const perVolume: { body: number; nodes: Uint32Array }[] = [];
  try {
    gmsh.setNumber('Mesh.MeshSizeMax', size);
    gmsh.setNumber('Mesh.MeshSizeMin', sizeMin);
    gmsh.setNumber('Mesh.MeshSizeFromCurvature', opts.curvature ?? DEFAULT_CURVATURE);
    gmsh.setNumber('Mesh.Algorithm3D', opts.algorithm === 'delaunay' ? 1 : 10);
    gmsh.setNumber('Mesh.ElementOrder', 2);
    gmsh.setNumber('Mesh.HighOrderOptimize', 0);
    gmsh.setNumber('Mesh.SecondOrderLinear', 0);
    if (opts.refine && opts.refine.length > 0) {
      // Per refinement: the distance to its faces, and a size growing linearly from its own at
      // REFINE_INNER sizes away to the element size REFINE_GROWTH times the difference further.
      const fields = opts.refine.map((r) => {
        const local = Math.min(size, Math.max(r.size, sizeMin));
        const band = refineBand(local, size);
        const surfaces = r.faces.flatMap((f) => faceImages[f.body]![f.face]!);
        const dist = gmsh.addField('Distance');
        gmsh.fieldNumbers(dist, 'SurfacesList', surfaces);
        gmsh.fieldNumber(dist, 'Sampling', REFINE_SAMPLING);
        const thr = gmsh.addField('Threshold');
        gmsh.fieldNumber(thr, 'InField', dist);
        gmsh.fieldNumber(thr, 'SizeMin', local);
        gmsh.fieldNumber(thr, 'SizeMax', size);
        gmsh.fieldNumber(thr, 'DistMin', band.inner);
        gmsh.fieldNumber(thr, 'DistMax', band.outer);
        return thr;
      });
      const min = gmsh.addField('Min');
      gmsh.fieldNumbers(min, 'FieldsList', fields);
      gmsh.backgroundField(min);
    }
    gmsh.generate(3);
    ctx.mesherBytes = gmsh.bytes();
    ctx.check();

    const all = gmsh.nodes(-1, -1, true);
    nodeTags = all.tags;
    coords = all.coords;
    volumeImages.forEach((vs, b) => {
      for (const v of vs) perVolume.push({ body: b, nodes: gmsh.elementsByType(TET10, v) });
    });
  } catch (error) {
    throw meshFailed(gmsh, ctx, error);
  }

  // Compact gmsh's node tags to the nodes the elements use, in our TET10 order.
  let maxTag = 0;
  for (let i = 0; i < nodeTags.length; i++) maxTag = Math.max(maxTag, nodeTags[i]!);
  const slot = new Int32Array(maxTag + 1).fill(-1);
  for (let i = 0; i < nodeTags.length; i++) slot[nodeTags[i]!] = i;
  const index = new Int32Array(maxTag + 1).fill(-1);
  let count = 0;
  let ne = 0;
  for (const pv of perVolume) {
    ne += pv.nodes.length / 10;
    for (let i = 0; i < pv.nodes.length; i++) {
      const tag = pv.nodes[i]!;
      if (tag > maxTag || slot[tag] === -1) {
        throw new FeaAbort({
          code: 'mesh-failed',
          message: 'The mesh refers to a node it does not have.',
        });
      }
      if (index[tag] === -1) index[tag] = count++;
    }
  }
  if (ne === 0) {
    throw new FeaAbort({ code: 'mesh-failed', message: 'gmsh produced no volume elements.' });
  }
  ctx.dof = 3 * count;
  if (3 * count > ctx.limits.maxDof) {
    throw new FeaAbort({
      code: 'dof-limit',
      message: `The mesh has ${3 * count} degrees of freedom, more than the limit of ${ctx.limits.maxDof}. Use a larger element size or fewer refinements.`,
      dof: 3 * count,
      limit: ctx.limits.maxDof,
      estimated: false,
    });
  }
  const nodes = new Float64Array(3 * count);
  for (let tag = 0; tag <= maxTag; tag++) {
    const k = index[tag]!;
    if (k < 0) continue;
    const s = slot[tag]!;
    nodes[3 * k] = coords[3 * s]!;
    nodes[3 * k + 1] = coords[3 * s + 1]!;
    nodes[3 * k + 2] = coords[3 * s + 2]!;
  }
  const first = perVolume.find((pv) => pv.nodes.length > 0)!;
  const perm = edgeOrder(
    (e, p, c) => nodes[3 * index[first.nodes[10 * e + p]!]! + c]!,
    first.nodes.length / 10,
  );
  const tets = new Uint32Array(10 * ne);
  const tetBody = new Uint16Array(ne);
  let e = 0;
  for (const pv of perVolume) {
    const n = pv.nodes.length / 10;
    for (let k = 0; k < n; k++, e++) {
      for (let a = 0; a < 4; a++) tets[10 * e + a] = index[pv.nodes[10 * k + a]!]!;
      for (let q = 0; q < 6; q++) tets[10 * e + 4 + q] = index[pv.nodes[10 * k + perm[q]!]!]!;
      tetBody[e] = pv.body;
    }
  }

  // Every kernel face's triangles (corners only; the solver takes the edge nodes from the tets).
  const faceTriangles: FaceTriangles[] = [];
  try {
    faceImages.forEach((fs, b) =>
      fs.forEach((images, f) => {
        const parts = images.map((s) => gmsh.elementsByType(TRI6, s));
        let nt = 0;
        for (const p of parts) nt += p.length / 6;
        const corners = new Uint32Array(3 * nt);
        let k = 0;
        for (const p of parts) {
          for (let i = 0; i < p.length / 6; i++, k++) {
            for (let c = 0; c < 3; c++) {
              const id = index[p[6 * i + c]!] ?? -1;
              if (id < 0) {
                throw new FeaAbort({
                  code: 'mesh-failed',
                  message: `A boundary triangle of face ${f} of body ${b} has a corner that is no element's node.`,
                });
              }
              corners[3 * k + c] = id;
            }
          }
        }
        faceTriangles.push({ body: b, face: f, corners });
      }),
    );
  } catch (error) {
    throw meshFailed(gmsh, ctx, error);
  }
  times.mesh = ctx.elapsed() - t;
  const mesh: TetMesh = { nodes, tets, tetBody };
  return {
    model: { mesh, faces: faceTriangles, faceCounts: faces.map((f) => f.length) },
    estimatedDof,
    times,
  };
}
