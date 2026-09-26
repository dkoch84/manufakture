// Low-level helpers over the raw libcascade bindings. Internal to the
// package: nothing in this file is exported from the package entry.
//
// Memory rule (T0.2, ADR 0002 decision 5): every embind object handed to JS
// owns C++ memory that garbage collection never frees, and for 2102 of
// libcascade 3.0.2's classes (TopoDS_Shape and every builder among them)
// `delete()` is an empty function. So every object is owned by a Scope, which
// first releases what the object owns through public OCCT methods and only
// then calls `delete()`.

import type { OpenCascadeInstance, TopAbs_ShapeEnum, TopoDS_Shape } from 'libcascade/single/init';
import type { SubShapeKind, Vec3 } from './types';

export type Oc = OpenCascadeInstance;

export interface Deletable {
  delete(): void;
}

type Releasable = Deletable & Record<string, unknown>;

/**
 * Release what an object owns without relying on its destructor. Only calls
 * public OCCT methods; the object stays valid (but empty) until `delete()`.
 * The table is T0.2's "release before delete" rules.
 */
export function releaseOwned(oc: Oc, item: Deletable): void {
  const o = item as Releasable;
  const name = (o.constructor as { name?: string }).name ?? '';
  if (name.startsWith('TopoDS_')) {
    // Drops the TShape handle (the whole B-rep) and the location.
    (o.Nullify as () => void).call(o);
  } else if (name === 'TopLoc_Location') {
    (o.Clear as () => void).call(o);
  } else if (name.startsWith('BRepAlgoAPI_')) {
    // Frees the pave filler, builder and history; the argument and tool lists
    // hold the input shapes, so replace them with empty lists.
    (o.Clear as () => void).call(o);
    const empty = new oc.NCollection_List_TopoDS_Shape();
    try {
      (o.SetArguments as (l: unknown) => void).call(o, empty);
      if (typeof o.SetTools === 'function') (o.SetTools as (l: unknown) => void).call(o, empty);
    } finally {
      empty.delete();
    }
  } else if (name === 'BRepFilletAPI_MakeFillet' || name === 'BRepFilletAPI_MakeChamfer') {
    (o.Reset as () => void).call(o);
  } else if (name === 'BRepOffsetAPI_DraftAngle') {
    (o.Clear as () => void).call(o);
  } else if (name === 'BRepExtrema_DistShapeShape') {
    // Holds both input shapes; loading null shapes drops their handles.
    const empty = new oc.TopoDS_Shape();
    try {
      (o.LoadS1 as (s: unknown) => void).call(o, empty);
      (o.LoadS2 as (s: unknown) => void).call(o, empty);
    } finally {
      empty.delete();
    }
  }
}

/** Owns embind objects and releases them in reverse order of ownership. */
export class Scope {
  private readonly items: Deletable[] = [];
  private readonly oc: Oc;

  constructor(oc: Oc) {
    this.oc = oc;
  }

  own<T extends Deletable>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Release and delete one object now (for hot loops); it must not also be owned. */
  free(item: Deletable): void {
    try {
      releaseOwned(this.oc, item);
    } finally {
      item.delete();
    }
  }

  /** Release everything, even when releasing one object throws; rethrows the first error. */
  dispose(): void {
    let first: unknown = null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.free(this.items[i]!);
      } catch (error) {
        first ??= error;
      }
    }
    this.items.length = 0;
    if (first !== null) throw first;
  }
}

/** Run `fn` with a scope that is always disposed. */
export function withScope<T>(oc: Oc, fn: (s: Scope) => T): T {
  const s = new Scope(oc);
  try {
    return fn(s);
  } finally {
    s.dispose();
  }
}

export type IndexedMap = InstanceType<
  Oc['NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher']
>;
export type ShapeList = InstanceType<Oc['NCollection_List_TopoDS_Shape']>;

/** Index every sub-shape of one kind, in `TopExp.MapShapes` order (1-based). */
export function mapShapes(oc: Oc, s: Scope, shape: TopoDS_Shape, kind: SubShapeKind): IndexedMap {
  // An indexed map rather than TopExp_Explorer: the map's destructor works,
  // the explorer's does not (T0.2).
  const map = s.own(new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher());
  oc.TopExp.MapShapes(shape, shapeEnum(oc, kind), map);
  return map;
}

export function shapeEnum(oc: Oc, kind: SubShapeKind): TopAbs_ShapeEnum {
  const e = oc.TopAbs_ShapeEnum;
  return kind === 'face' ? e.TopAbs_FACE : kind === 'edge' ? e.TopAbs_EDGE : e.TopAbs_VERTEX;
}

export function kindOf(oc: Oc, shape: TopoDS_Shape): SubShapeKind | null {
  const t = shape.ShapeType();
  const e = oc.TopAbs_ShapeEnum;
  if (t === e.TopAbs_FACE) return 'face';
  if (t === e.TopAbs_EDGE) return 'edge';
  if (t === e.TopAbs_VERTEX) return 'vertex';
  return null;
}

/** Drain a copy of an OCCT shape list, calling `fn` with each item (owned by `s`). */
export function eachInList(
  oc: Oc,
  s: Scope,
  list: ShapeList,
  fn: (item: TopoDS_Shape) => void,
): void {
  // No list iterator is needed: pop the front of a copy until it is empty.
  const copy = s.own(new oc.NCollection_List_TopoDS_Shape(list));
  while (copy.Size() > 0) {
    const item = s.own(copy.First());
    copy.RemoveFirst();
    fn(item);
  }
}

export function toVec3(p: { X(): number; Y(): number; Z(): number }): Vec3 {
  return [p.X(), p.Y(), p.Z()];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
