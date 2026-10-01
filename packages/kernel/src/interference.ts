// Interference between placed items (M2 plan, T2.3d): which assembly instances overlap, and by how
// much. Each item is the bodies one instance shows at its placement. A bounding-box prefilter on
// the placed bodies keeps the costly part, a `common` boolean per pair of bodies, to the pairs
// whose boxes overlap by more than the tolerance; a pair of items is reported when the volumes of
// its commons add up to more than the tolerance. Touching bodies therefore never are: their boxes
// overlap by a sliver at most, and their common has no volume.
//
// Nothing here enters the arena. Placed copies are located handles (`Moved`) on the arena's
// shapes, so nothing is copied; the booleans run non-destructively, so the arena's bodies are
// never retouched; and every temporary of a pair is released before the next pair starts (T0.2).

import type { TopoDS_Shape } from 'libcascade/single/init';
import { KernelError } from './errors';
import { tessellate } from './mesh';
import { Scope, withScope, type Oc } from './occt';
import type {
  Deflection,
  InterferenceOptions,
  InterferencePair,
  InterferenceResult,
  Placement,
} from './types';

/** Overlaps of at most this volume (mm3) are not interference. */
export const DEFAULT_INTERFERENCE_TOLERANCE = 1e-3;

/** An item for `interferenceOf`: the bodies' OCCT shapes (the arena's) and the placement. */
export interface PlacedItem {
  shapes: TopoDS_Shape[];
  transform?: Placement;
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

/** The volume two boxes share (0 when they are apart or only touch). */
export function boxOverlap(a: Box, b: Box): number {
  let v = 1;
  for (let i = 0; i < 3; i++) {
    const d = Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!);
    if (!(d > 0)) return 0;
    v *= d;
  }
  return v;
}

function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const out: Box = { min: [...boxes[0]!.min], max: [...boxes[0]!.max] };
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      out.min[i] = Math.min(out.min[i]!, b.min[i]!);
      out.max[i] = Math.max(out.max[i]!, b.max[i]!);
    }
  }
  return out;
}

/** Why `p` is not a usable placement, or null. */
function placementProblem(p: Placement): string | null {
  const t = p.translation;
  const r = p.rotation;
  if (!Array.isArray(t) || t.length !== 3 || !t.every(Number.isFinite)) {
    return 'transform.translation must be three finite numbers';
  }
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) {
    return 'transform.rotation must be four finite numbers (a quaternion x, y, z, w)';
  }
  if (!(Math.hypot(...r) > 1e-12)) return 'transform.rotation is a zero quaternion';
  return null;
}

/** `shape` placed by `p`: a located handle on the same B-rep, owned by `s`. */
function placed(oc: Oc, s: Scope, shape: TopoDS_Shape, p: Placement | undefined): TopoDS_Shape {
  if (p === undefined) return shape;
  const n = Math.hypot(...p.rotation);
  const [x, y, z, w] = p.rotation.map((c) => c / n) as [number, number, number, number];
  const trsf = s.own(new oc.gp_Trsf());
  trsf.SetRotation(s.own(new oc.gp_Quaternion(x, y, z, w)));
  const [tx, ty, tz] = p.translation;
  trsf.SetTranslationPart(s.own(new oc.gp_Vec(tx, ty, tz)));
  const loc = s.own(new oc.TopLoc_Location(trsf));
  return s.own(shape.Moved(loc, false));
}

/** The bounding box of a placed shape, enlarged by its tolerances (so never too small). */
function boxOf(oc: Oc, shape: TopoDS_Shape): Box | null {
  return withScope(oc, (bs) => {
    const box = bs.own(new oc.Bnd_Box());
    oc.BRepBndLib.Add(shape, box, false);
    if (box.IsVoid()) return null;
    const min = bs.own(box.CornerMin());
    const max = bs.own(box.CornerMax());
    return { min: [min.X(), min.Y(), min.Z()], max: [max.X(), max.Y(), max.Z()] };
  });
}

function volumeOf(oc: Oc, s: Scope, shape: TopoDS_Shape): number {
  const props = s.own(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass();
}

/** The common of two placed bodies, owned by `s`; throws when OCCT cannot compute it. */
function common(oc: Oc, s: Scope, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const builder = s.own(new oc.BRepAlgoAPI_Common());
  const args = s.own(new oc.NCollection_List_TopoDS_Shape([a]));
  const tools = s.own(new oc.NCollection_List_TopoDS_Shape([b]));
  builder.SetArguments(args);
  builder.SetTools(tools);
  // The bodies are the arena's (and shared by every instance of a part): leave them untouched.
  builder.SetNonDestructive(true);
  builder.SetToFillHistory(false);
  builder.Build();
  if (!builder.IsDone() || builder.HasErrors()) throw new Error('common failed');
  return s.own(builder.Shape());
}

function checkPairs(
  count: number,
  pairs: InterferenceOptions['pairs'],
): readonly (readonly [number, number])[] {
  if (pairs === undefined) {
    const all: [number, number][] = [];
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) all.push([i, j]);
    return all;
  }
  for (const [i, j] of pairs) {
    const ok = (k: number) => Number.isInteger(k) && k >= 0 && k < count;
    if (!ok(i) || !ok(j) || i === j) {
      throw new KernelError('interference', `pair [${i}, ${j}] does not name two of the items`, {
        code: 'invalid-argument',
      });
    }
  }
  return pairs;
}

/**
 * Which pairs of `items` overlap, and by how much (see the file comment). `fail` turns an error a
 * boolean threw into a `KernelError` (decoding OCCT's exception); a `fatal` one ends the check,
 * any other is that pair's failure and the check goes on.
 */
export function interferenceOf(
  oc: Oc,
  s: Scope,
  items: readonly PlacedItem[],
  options: InterferenceOptions,
  deflection: Deflection,
  fail: (error: unknown) => KernelError,
): InterferenceResult {
  const tolerance = options.tolerance ?? DEFAULT_INTERFERENCE_TOLERANCE;
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) {
    throw new KernelError('interference', 'tolerance must be a finite number, 0 or more', {
      code: 'invalid-argument',
    });
  }
  for (const item of items) {
    const problem = item.transform === undefined ? null : placementProblem(item.transform);
    if (problem !== null) {
      throw new KernelError('interference', problem, { code: 'invalid-argument' });
    }
  }
  const pairs = checkPairs(items.length, options.pairs);

  // Placed bodies and their boxes, only for items some pair names.
  const used = new Set(pairs.flat());
  const bodies = new Map<number, { shape: TopoDS_Shape; box: Box }[]>();
  const boxes = new Map<number, Box | null>();
  for (const i of [...used].sort((x, y) => x - y)) {
    const item = items[i]!;
    const list: { shape: TopoDS_Shape; box: Box }[] = [];
    for (const shape of item.shapes) {
      const moved = placed(oc, s, shape, item.transform);
      const box = boxOf(oc, moved);
      if (box !== null) list.push({ shape: moved, box });
    }
    bodies.set(i, list);
    boxes.set(i, union(list.map((b) => b.box)));
  }

  const result: InterferenceResult = { candidates: [], booleans: 0, pairs: [], failures: [] };
  for (const [i, j] of pairs) {
    const bi = boxes.get(i);
    const bj = boxes.get(j);
    if (!bi || !bj || boxOverlap(bi, bj) <= tolerance) continue;
    // Body pairs whose boxes overlap enough to hold more than the tolerance between them.
    const work: [TopoDS_Shape, TopoDS_Shape][] = [];
    for (const x of bodies.get(i)!) {
      for (const y of bodies.get(j)!) {
        if (boxOverlap(x.box, y.box) > tolerance) work.push([x.shape, y.shape]);
      }
    }
    if (work.length === 0) continue;
    result.candidates.push([i, j]);
    if (options.prefilterOnly) continue;
    // A scope per pair, so the booleans of one pair are freed before the next pair's run.
    const ps = new Scope(oc);
    let fatal = false;
    try {
      let volume = 0;
      const overlaps: TopoDS_Shape[] = [];
      try {
        for (const [a, b] of work) {
          result.booleans++;
          const c = common(oc, ps, a, b);
          const v = volumeOf(oc, ps, c);
          if (v > 0) {
            volume += v;
            overlaps.push(c);
          }
        }
      } catch (error) {
        const e = fail(error);
        if (e.code === 'fatal') {
          // Nothing more may be released into a dead instance.
          fatal = true;
          throw e;
        }
        result.failures.push({ a: i, b: j, message: e.message });
        continue;
      }
      if (!(volume > tolerance)) continue;
      const pair: InterferencePair = { a: i, b: j, volume };
      if (options.mesh) {
        const builder = ps.own(new oc.BRep_Builder());
        const compound = ps.own(new oc.TopoDS_Compound());
        builder.MakeCompound(compound);
        for (const c of overlaps) builder.Add(compound, c);
        pair.mesh = tessellate(oc, ps, compound, deflection);
      }
      result.pairs.push(pair);
    } finally {
      if (!fatal) ps.dispose();
    }
  }
  return result;
}
