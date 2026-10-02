// Test fixtures for the drawing workspace: a document with one part studio holding a box (40 x 30 x
// 20 mm, X from 0 to 40, Y from -15 to 15, Z from 0 to 20) with a round edge of radius 5 on its
// top, and a fake drawer that does what the regen drawing stage does for it, without a kernel:
// projects the box's edges into each view, gives the picking data, resolves the dimensions by
// their references (a reference this fixture does not know is lost) and lays the sheet out with
// `packages/drawing`, so the screen gets a real display list.

import {
  applyCommand,
  createDocument,
  type Command,
  type DimensionRef,
  type ManufaktureDocument,
} from '@manufakture/core';
import { layoutSheet, type DrawingInput, type ViewInput } from '@manufakture/drawing';
import {
  dimensionInput,
  titleBlockInput,
  valueFormat,
  type DimensionResult,
  type DrawingSheetResult,
  type DrawingViewResult,
  type PickEdge,
  type PickVertex,
  type RefGeometry,
} from '@manufakture/regen';
import type { Drawer } from './drawer';
import { frameOf, sheetPaperSize } from './model';

type Vec3 = [number, number, number];

export const BODY = 'extrude#1';
const X = [0, 40];
const Y = [-15, 15];
const Z = [0, 20];
const HOLE = { center: [20, 0, 20] as Vec3, radius: 5 };

export function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** A document with one part studio, `part#1`, named Box. */
export function boxDocument(): ManufaktureDocument {
  return apply(createDocument({ id: 'd', name: 'Box drawing' }), {
    type: 'renamePart',
    partId: 'part#1',
    name: 'Box',
  });
}

const corner = (i: number, j: number, k: number): Vec3 => [X[i]!, Y[j]!, Z[k]!];
const vertexRef = (i: number, j: number, k: number) => ({
  faces: [`${BODY}:x${i}`, `${BODY}:y${j}`, `${BODY}:z${k}`],
});

/** The box's corners and its twelve edges, each with the reference a pick stores. */
function boxGeometry(): { vertices: PickVertex[]; edges: PickEdge[]; lines: [Vec3, Vec3][] } {
  const vertices: PickVertex[] = [];
  for (const i of [0, 1])
    for (const j of [0, 1])
      for (const k of [0, 1]) {
        vertices.push({ ref: vertexRef(i, j, k), point: corner(i, j, k) });
      }
  const edges: PickEdge[] = [];
  const lines: [Vec3, Vec3][] = [];
  const add = (a: Vec3, b: Vec3, faces: string[]) => {
    edges.push({ ref: { faces }, points: [a, b] });
    lines.push([a, b]);
  };
  for (const j of [0, 1])
    for (const k of [0, 1])
      add(corner(0, j, k), corner(1, j, k), [`${BODY}:y${j}`, `${BODY}:z${k}`]);
  for (const i of [0, 1])
    for (const k of [0, 1])
      add(corner(i, 0, k), corner(i, 1, k), [`${BODY}:x${i}`, `${BODY}:z${k}`]);
  for (const i of [0, 1])
    for (const j of [0, 1])
      add(corner(i, j, 0), corner(i, j, 1), [`${BODY}:x${i}`, `${BODY}:y${j}`]);
  // The round edge on the top, as the mesh's closed polyline.
  const ring: Vec3[] = [];
  for (let n = 0; n <= 32; n++) {
    const t = (2 * Math.PI * n) / 32;
    ring.push([
      HOLE.center[0] + HOLE.radius * Math.cos(t),
      HOLE.center[1] + HOLE.radius * Math.sin(t),
      HOLE.center[2],
    ]);
  }
  edges.push({ ref: { faces: [`${BODY}:hole`, `${BODY}:z1`] }, points: ring });
  return { vertices, edges, lines };
}

/** What a reference resolves to on the box, or null (lost). */
export function refGeometry(ref: DimensionRef): RefGeometry | null {
  const { vertices, edges } = boxGeometry();
  const key = JSON.stringify;
  if ('vertex' in ref) {
    const v = vertices.find((x) => key(x.ref) === key(ref.vertex));
    return v ? { kind: 'point', point: v.point } : null;
  }
  if ('edge' in ref) {
    const e = edges.find((x) => key(x.ref) === key(ref.edge));
    if (!e) return null;
    if (e.points.length > 2)
      return { kind: 'circle', center: HOLE.center, radius: HOLE.radius, axis: [0, 0, 1] };
    return { kind: 'line', a: e.points[0]!, b: e.points[1]! };
  }
  return null;
}

const num = (source: string) => Number(source);

export interface FakeDrawer extends Drawer {
  calls: { drawingId: string; sheetId: string; pick: boolean }[];
}

/** A drawer that projects the box as the regen stage would. `failSheet`: no display list. */
export function fakeDrawer(options: { failSheet?: boolean } = {}): FakeDrawer {
  const calls: FakeDrawer['calls'] = [];
  return {
    calls,
    sheet(doc, drawingId, sheetId, opts = {}) {
      calls.push({ drawingId, sheetId, pick: !!opts.pick });
      const drawing = doc.drawings?.find((d) => d.id === drawingId);
      const sheet = drawing?.sheets.find((s) => s.id === sheetId);
      if (!drawing || !sheet) return Promise.resolve(null);
      const { vertices, edges, lines } = boxGeometry();
      const views: DrawingViewResult[] = sheet.views.map((view) => {
        const f = frameOf(view.direction);
        const frame = {
          origin: [0, 0, 0] as Vec3,
          x: [...f.x] as Vec3,
          y: [...f.y] as Vec3,
          z: [...f.z] as Vec3,
        };
        const P = (p: readonly number[]): [number, number] => [
          p[0]! * f.x[0] + p[1]! * f.x[1] + p[2]! * f.x[2],
          p[0]! * f.y[0] + p[1]! * f.y[1] + p[2]! * f.y[2],
        ];
        const scale = { paper: num(view.scale.paper.source), model: num(view.scale.model.source) };
        const s = scale.paper / scale.model;
        const projected = lines.map(([a, b]) => ({
          item: 0,
          cls: 'sharp' as const,
          visible: true,
          curve: { kind: 'line' as const, a: P(a), b: P(b) },
        }));
        const pts = vertices.map((v) => P(v.point));
        const bounds = {
          min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))] as [
            number,
            number,
          ],
          max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as [
            number,
            number,
          ],
        };
        const dimensions: DimensionResult[] = sheet.dimensions
          .filter((d) => d.view === view.id)
          .map((d) => {
            const geometry = d.refs.map((r) => refGeometry(r));
            const base = {
              dimensionId: d.id,
              viewId: view.id,
              kind: d.kind,
              references: [],
              warnings: [],
            };
            if (geometry.some((g) => g === null)) {
              return {
                ...base,
                outcome: 'lost' as const,
                errors: [
                  { code: 'reference-lost', message: `${d.id}: a reference is lost` } as never,
                ],
                value: null,
                input: null,
              };
            }
            const r = dimensionInput(
              d,
              geometry as RefGeometry[],
              frame,
              s,
              valueFormat(doc.units, d),
            );
            return r.ok
              ? { ...base, outcome: 'exact' as const, errors: [], value: r.value, input: r.input }
              : {
                  ...base,
                  outcome: 'error' as const,
                  errors: [{ code: 'dimension', message: r.message } as never],
                  value: null,
                  input: null,
                };
          });
        const centre: [number, number] = [
          (bounds.min[0] + bounds.max[0]) / 2,
          (bounds.min[1] + bounds.max[1]) / 2,
        ];
        const input: ViewInput = {
          id: view.id,
          edges: projected,
          bounds,
          scale,
          position: [view.position[0] + s * centre[0], view.position[1] + s * centre[1]],
          display: { hidden: view.options.hidden, smooth: 'omit' },
        };
        return {
          generation: 1,
          drawingId,
          sheetId,
          viewId: view.id,
          frame,
          scale,
          items: [
            {
              item: 0,
              key: BODY,
              body: BODY,
              pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
              bodyKey: 'k',
            },
          ],
          edges: projected,
          bounds,
          diagnostics: [],
          dimensions,
          input,
          pick: opts.pick
            ? { frame, items: [{ item: 0, body: BODY, edges, vertices, cylinders: [] }] }
            : null,
          cached: false,
        };
      });
      if (options.failSheet) {
        return Promise.resolve({
          generation: 1,
          drawingId,
          sheetId,
          views,
          diagnostics: [
            {
              code: 'sheet-size',
              severity: 'error',
              subject: sheet.id,
              message: "The sheet's width must be a positive length",
            },
          ],
          input: null,
          display: null,
        });
      }
      const placed = new Map(sheet.views.map((v) => [v.id, v.position]));
      const size = sheetPaperSize(sheet);
      const input: DrawingInput = {
        sheet:
          typeof sheet.size === 'string'
            ? { size: sheet.size, orientation: sheet.orientation }
            : { size, orientation: sheet.orientation },
        projection: 'third',
        views: views.flatMap((v) => (v.input ? [v.input] : [])),
        dimensions: views.flatMap((v) => v.dimensions.flatMap((d) => (d.input ? [d.input] : []))),
        notes: sheet.notes.map((n) => {
          const o = n.view === undefined ? undefined : placed.get(n.view);
          return {
            id: n.id,
            text: n.text,
            at: o ? [o[0] + n.position[0], o[1] + n.position[1]] : [n.position[0], n.position[1]],
          };
        }),
        titleBlock: sheet.titleBlock ? titleBlockInput(sheet.titleBlock).input : false,
        format: valueFormat(doc.units),
      };
      const result: DrawingSheetResult = {
        generation: 1,
        drawingId,
        sheetId,
        views,
        diagnostics: [],
        input,
        display: layoutSheet(input),
      };
      return Promise.resolve(result);
    },
  };
}
