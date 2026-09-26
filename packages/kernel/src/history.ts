// Kinded operation history (ADR 0007, decision 9; T0.5 recommendation 1).

import type { TopoDS_Shape } from 'libcascade/single/init';
import {
  eachInList,
  kindOf,
  mapShapes,
  type IndexedMap,
  type Oc,
  type Scope,
  type ShapeList,
} from './occt';
import type { HistoryEntry, SubShapeKind, SubShapeRef } from './types';

/** The OCCT history interface shared by BRepBuilderAPI_MakeShape and the BRepAlgoAPI builders. */
export interface HistorySource {
  Modified(x: TopoDS_Shape): ShapeList;
  Generated(x: TopoDS_Shape): ShapeList;
  IsDeleted(x: TopoDS_Shape): boolean;
}

const KINDS: readonly SubShapeKind[] = ['face', 'edge', 'vertex'];
const KIND_ORDER: Record<SubShapeKind, number> = { face: 0, edge: 1, vertex: 2 };

export type ResultMaps = Record<SubShapeKind, IndexedMap>;

export function resultMaps(oc: Oc, s: Scope, result: TopoDS_Shape): ResultMaps {
  return {
    face: mapShapes(oc, s, result, 'face'),
    edge: mapShapes(oc, s, result, 'edge'),
    vertex: mapShapes(oc, s, result, 'vertex'),
  };
}

/**
 * Ask the builder what became of every face, edge and vertex of every input.
 * Outputs are named by kind and 1-based index in the result, sorted by kind
 * (faces, edges, vertices) and then index, without duplicates. Outputs that
 * are not faces, edges or vertices (a generated solid) are left out.
 */
export function collectHistory(
  oc: Oc,
  s: Scope,
  builder: HistorySource,
  inputs: readonly TopoDS_Shape[],
  maps: ResultMaps,
): HistoryEntry[] {
  const toRefs = (list: ShapeList): SubShapeRef[] => {
    const out: SubShapeRef[] = [];
    eachInList(oc, s, list, (item) => {
      const kind = kindOf(oc, item);
      if (kind === null) return;
      const index = maps[kind].FindIndex(item);
      if (index > 0 && !out.some((r) => r.kind === kind && r.index === index)) {
        out.push({ kind, index });
      }
    });
    return out.sort((p, q) =>
      p.kind === q.kind ? p.index - q.index : KIND_ORDER[p.kind] - KIND_ORDER[q.kind],
    );
  };
  const entries: HistoryEntry[] = [];
  inputs.forEach((input, operand) => {
    for (const kind of KINDS) {
      const map = mapShapes(oc, s, input, kind);
      for (let i = 1; i <= map.Extent(); i++) {
        const sub = s.own(map.FindKey(i));
        entries.push({
          operand,
          input: { kind, index: i },
          kept: maps[kind].FindIndex(sub),
          modified: toRefs(s.own(builder.Modified(sub))),
          generated: toRefs(s.own(builder.Generated(sub))),
          deleted: builder.IsDeleted(sub),
        });
      }
    }
  });
  return entries;
}
