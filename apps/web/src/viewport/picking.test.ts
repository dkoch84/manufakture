import { describe, expect, it } from 'vitest';
import { GEOMETRY_KINDS, type GeometryKind } from '../state/selection';
import {
  edgePickId,
  edgePickIds,
  facePickId,
  pickIdAttribute,
  prepareBodies,
  vertexPickId,
  vertexPickPoints,
  type ViewBody,
} from './bodies';
import { fillPlaceholderNames, isPlaceholderName, placeholderName } from './naming';
import {
  choosePick,
  decodePickId,
  decodePickTarget,
  edgeCandidates,
  encodePickId,
  hitToRef,
  pointSegmentDistance,
  readPickWindow,
  vertexCandidates,
  type PickCandidates,
  type PickWindow,
} from './picking';
import { BOX_FACE_NAMES, boxBody } from './testMeshes';

const all = () => true;
const only =
  (...kinds: GeometryKind[]) =>
  (k: GeometryKind) =>
    kinds.includes(k);

function faceIndex(name: (typeof BOX_FACE_NAMES)[number]) {
  return BOX_FACE_NAMES.indexOf(name) + 1;
}

/**
 * A pick window as read back from the GPU: `size` x `size` RGBA pixels, row 0
 * at the bottom. `paint(col, row)` gives the id of each pixel.
 */
function window(size: number, paint: (col: number, row: number) => number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const [r, g, b] = encodePickId(paint(p % size, Math.floor(p / size)));
    px.set([r, g, b, 255], p * 4);
  }
  return px;
}

describe('pick id encoding', () => {
  it('round-trips 24-bit ids through RGB', () => {
    for (const id of [0, 1, 255, 256, 65_535, 65_536, 0xabcdef, 0xffffff]) {
      const [r, g, b] = encodePickId(id);
      expect([r, g, b].every((c) => c >= 0 && c <= 255)).toBe(true);
      expect(decodePickId(r, g, b)).toBe(id);
    }
  });

  it('gives each body consecutive ids for its faces, edges and vertices', () => {
    const bodies = prepareBodies([boxBody({ id: 'a' }), boxBody({ id: 'b' })]);
    const [a, b] = bodies as [ViewBody, ViewBody];
    // A box: 6 faces, 12 edges, 8 vertices.
    expect(a.pickBase).toBe(1);
    expect(a.pickCount).toBe(26);
    expect(b.pickBase).toBe(27);
    expect(decodePickTarget(bodies, 0)).toBeNull();
    expect(decodePickTarget(bodies, 1)).toEqual({ body: 0, kind: 'face', index: 1 });
    expect(decodePickTarget(bodies, 6)).toEqual({ body: 0, kind: 'face', index: 6 });
    expect(decodePickTarget(bodies, 7)).toEqual({ body: 0, kind: 'edge', index: 1 });
    expect(decodePickTarget(bodies, 18)).toEqual({ body: 0, kind: 'edge', index: 12 });
    expect(decodePickTarget(bodies, 19)).toEqual({ body: 0, kind: 'vertex', index: 1 });
    expect(decodePickTarget(bodies, 26)).toEqual({ body: 0, kind: 'vertex', index: 8 });
    expect(decodePickTarget(bodies, 27)).toEqual({ body: 1, kind: 'face', index: 1 });
    expect(decodePickTarget(bodies, 53)).toBeNull();
    for (const body of bodies) {
      const i = bodies.indexOf(body);
      expect(decodePickTarget(bodies, facePickId(body, 4))).toEqual({
        body: i,
        kind: 'face',
        index: 4,
      });
      expect(decodePickTarget(bodies, edgePickId(body, 5))).toEqual({
        body: i,
        kind: 'edge',
        index: 5,
      });
      expect(decodePickTarget(bodies, vertexPickId(body, 3))).toEqual({
        body: i,
        kind: 'vertex',
        index: 3,
      });
    }
  });

  it('writes each face pick id on exactly that face vertices', () => {
    const [, body] = prepareBodies([boxBody({ id: 'a' }), boxBody({ id: 'b' })]);
    const ids = pickIdAttribute(body!);
    for (let t = 0; t < body!.mesh.triangleFaces.length; t++) {
      for (let k = 0; k < 3; k++) {
        const v = body!.indices[t * 3 + k]!;
        expect(ids[v]).toBe(facePickId(body!, body!.mesh.triangleFaces[t]!));
      }
    }
  });

  it('tags both ends of every edge segment and every vertex with its pick id', () => {
    const [body] = prepareBodies([boxBody()]) as [ViewBody];
    const ids = edgePickIds(body);
    expect(ids).toHaveLength(body.segmentEdges.length * 2);
    body.segmentEdges.forEach((edge, s) => {
      expect(ids[s * 2]).toBe(edgePickId(body, edge));
      expect(ids[s * 2 + 1]).toBe(edgePickId(body, edge));
    });
    const points = vertexPickPoints(body);
    expect(points.ids).toHaveLength(8);
    body.vertices.forEach((v, i) => {
      expect([...points.positions.subarray(i * 3, i * 3 + 3)]).toEqual(v.point);
      expect(points.ids[i]).toBe(vertexPickId(body, v.index));
    });
  });
});

describe('reading the pick window', () => {
  const bodies = prepareBodies([boxBody()]);
  const body = bodies[0]!;
  const top = faceIndex('top');
  const front = faceIndex('front');

  it('reports the face under the centre pixel', () => {
    const r = readPickWindow(
      window(5, (col) => facePickId(body, col < 2 ? front : top)),
      5,
      bodies,
    );
    expect(r.center).toEqual({ body: 0, face: top });
    expect(r.edges[0]!.size).toBe(0);
    expect(r.vertices[0]!.size).toBe(0);
  });

  it('reports each visible edge and vertex with its nearest pixel distance', () => {
    // 7 x 7 window, centre (3, 3). Edge 2 runs down column 5; vertex 4 at (1, 0).
    const r = readPickWindow(
      window(7, (col, row) => {
        if (col === 1 && row === 0) return vertexPickId(body, 4);
        if (col === 5) return edgePickId(body, 2);
        return facePickId(body, top);
      }),
      7,
      bodies,
    );
    expect(r.center).toEqual({ body: 0, face: top });
    expect([...r.edges[0]!]).toEqual([[2, 2]]);
    expect([...r.vertices[0]!.keys()]).toEqual([4]);
    expect(r.vertices[0]!.get(4)).toBeCloseTo(Math.hypot(2, 3));
  });

  it('takes the nearest face pixel when an edge covers the centre', () => {
    const r = readPickWindow(
      window(5, (col) =>
        col === 2 ? edgePickId(body, 1) : facePickId(body, col < 2 ? front : top),
      ),
      5,
      bodies,
    );
    expect(r.center?.body).toBe(0);
    expect([front, top]).toContain(r.center?.face);
    expect(r.edges[0]!.get(1)).toBe(0);
  });

  it('reports nothing over the background', () => {
    const r = readPickWindow(
      window(3, () => 0),
      3,
      bodies,
    );
    expect(r.center).toBeNull();
    expect(r.edges[0]!.size).toBe(0);
  });

  it('picks no face when the centre is background, even with a face nearby', () => {
    const r = readPickWindow(
      window(5, (col) => (col === 0 ? facePickId(body, top) : 0)),
      5,
      bodies,
    );
    expect(r.center).toBeNull();
  });
});

describe('screen-space edge and vertex candidates', () => {
  it('measures distance to a segment, clamped to its ends', () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(pointSegmentDistance(-4, 3, 0, 0, 10, 0)).toBe(5);
    expect(pointSegmentDistance(1, 1, 2, 2, 2, 2)).toBeCloseTo(Math.SQRT2);
  });

  it('keeps the nearest segment per edge within the tolerance and skips hidden ones', () => {
    const screen = new Float32Array([
      0,
      0,
      10,
      0, // edge 1, 2 px below the cursor
      10,
      0,
      20,
      0, // edge 1 again, farther
      0,
      5,
      10,
      5, // edge 2, 3 px above
      NaN,
      NaN,
      NaN,
      NaN, // edge 3, clipped
      0,
      50,
      10,
      50, // edge 4, far away
    ]);
    const edges = new Uint32Array([1, 1, 2, 3, 4]);
    const c = edgeCandidates(0, screen, edges, { x: 5, y: 2 }, 6);
    expect(c.sort((a, b) => a.index - b.index)).toEqual([
      { body: 0, index: 1, distance: 2 },
      { body: 0, index: 2, distance: 3 },
    ]);
  });

  it('finds vertices within the tolerance', () => {
    const screen = new Float32Array([0, 0, 3, 4, NaN, NaN, 100, 100]);
    expect(vertexCandidates(1, screen, { x: 0, y: 0 }, 5)).toEqual([
      { body: 1, index: 1, distance: 0 },
      { body: 1, index: 2, distance: 5 },
    ]);
  });
});

describe('choosing what the cursor picks', () => {
  const bodies = prepareBodies([boxBody()]);
  const top = faceIndex('top');
  const front = faceIndex('front');
  // Edge between front and top, from the box topology.
  const frontTop = bodies[0]!.edgeFaces!.findIndex((f) => f.includes(front) && f.includes(top)) + 1;
  const back = faceIndex('back');
  // Edge between top and back: one of its faces (top) is visible under the cursor.
  const topBack = bodies[0]!.edgeFaces!.findIndex((f) => f.includes(top) && f.includes(back)) + 1;
  const vertexOnTop = bodies[0]!.vertices.find((v) => v.faces.includes(top))!.index;

  /** A window showing the top face, plus the given visible edges and vertices. */
  function seen(
    edges: [number, number][] = [],
    vertices: [number, number][] = [],
    center: PickWindow['center'] = { body: 0, face: top },
  ): PickWindow {
    return { center, edges: [new Map(edges)], vertices: [new Map(vertices)] };
  }

  function candidates(overrides: Partial<PickCandidates> = {}): PickCandidates {
    return { window: seen(), edges: [], vertices: [], ...overrides };
  }

  it('picks the face under the cursor when nothing else is near', () => {
    expect(choosePick(candidates(), all)).toEqual({ kind: 'face', body: 0, index: top });
  });

  it('prefers a visible edge within tolerance over the face', () => {
    const c = candidates({
      window: seen([[frontTop, 3]]),
      edges: [{ body: 0, index: frontTop, distance: 3 }],
    });
    expect(choosePick(c, all)).toEqual({ kind: 'edge', body: 0, index: frontTop });
  });

  it('prefers a vertex over an edge, and the nearest of each kind', () => {
    const c = candidates({
      window: seen([[frontTop, 1]], [[vertexOnTop, 2]]),
      edges: [{ body: 0, index: frontTop, distance: 1 }],
      vertices: [
        { body: 0, index: vertexOnTop, distance: 4 },
        { body: 0, index: vertexOnTop, distance: 2 },
      ],
    });
    expect(choosePick(c, all)).toEqual({ kind: 'vertex', body: 0, index: vertexOnTop });
  });

  it('ignores an edge or vertex the pick window does not show, even next to its visible face', () => {
    // The regression: a tangent edge behind a fillet has a visible face next
    // to it, but its own pixels all lost the depth test.
    const c = candidates({
      edges: [{ body: 0, index: topBack, distance: 0 }],
      vertices: [{ body: 0, index: vertexOnTop, distance: 0 }],
    });
    expect(choosePick(c, all)).toEqual({ kind: 'face', body: 0, index: top });
  });

  it('ignores an edge whose only visible pixels are beyond the tolerance', () => {
    const c = candidates({
      window: seen([[topBack, 8]]),
      edges: [{ body: 0, index: topBack, distance: 1 }],
    });
    expect(choosePick(c, all, 6)).toEqual({ kind: 'face', body: 0, index: top });
  });

  it('ranks a partly hidden edge by its nearest visible pixel', () => {
    // Geometrically `topBack` is nearer, but only a part 5 px away is visible.
    const c = candidates({
      window: seen([
        [topBack, 5],
        [frontTop, 3],
      ]),
      edges: [
        { body: 0, index: topBack, distance: 1 },
        { body: 0, index: frontTop, distance: 3 },
      ],
    });
    expect(choosePick(c, all)).toEqual({ kind: 'edge', body: 0, index: frontTop });
  });

  it('keeps the exact geometric distance when the nearest pixel agrees with it', () => {
    const c = candidates({
      window: seen([
        [topBack, 2.5],
        [frontTop, 2],
      ]),
      edges: [
        { body: 0, index: topBack, distance: 2 },
        { body: 0, index: frontTop, distance: 2.4 },
      ],
    });
    expect(choosePick(c, all)).toEqual({ kind: 'edge', body: 0, index: topBack });
  });

  it('honours the selection filter', () => {
    const c = candidates({
      window: seen([[frontTop, 1]], [[vertexOnTop, 1]]),
      edges: [{ body: 0, index: frontTop, distance: 1 }],
      vertices: [{ body: 0, index: vertexOnTop, distance: 1 }],
    });
    expect(choosePick(c, only('face'))).toEqual({ kind: 'face', body: 0, index: top });
    expect(choosePick(c, only('edge'))).toEqual({ kind: 'edge', body: 0, index: frontTop });
    expect(choosePick(candidates(), only('edge', 'vertex'))).toBeNull();
    expect(choosePick(candidates({ window: seen([], [], null) }), all)).toBeNull();
  });

  it('picks edges of a body without topology when the window shows them', () => {
    const c = candidates({
      window: seen([[1, 1]], [], null),
      edges: [{ body: 0, index: 1, distance: 1 }],
    });
    expect(choosePick(c, all)).toEqual({ kind: 'edge', body: 0, index: 1 });
  });
});

describe('pick results are names, never indices', () => {
  it('maps a face pick to the name from the name table', () => {
    const bodies = prepareBodies([boxBody({ id: 'part1' })]);
    const ref = hitToRef(bodies, { kind: 'face', body: 0, index: faceIndex('top') });
    expect(ref).toEqual({
      kind: 'face',
      id: 'part1/part1/top',
      bodyId: 'part1',
      name: 'part1/top',
      fragile: false,
      placeholder: false,
    });
  });

  it('maps an edge pick to its name and carries the fragile flag', () => {
    const input = boxBody({ id: 'part1' });
    input.mesh.edgeFragile[0] = 1;
    const bodies = prepareBodies([input]);
    const ref = hitToRef(bodies, { kind: 'edge', body: 0, index: 1 })!;
    expect(ref.kind).toBe('edge');
    expect(ref.name).toMatch(/^part1\/\w+\|\w+$/);
    expect(ref.fragile).toBe(true);
    expect(ref.placeholder).toBe(false);
  });

  it('falls back to a placeholder, marked as such, for unnamed slots', () => {
    const bodies = prepareBodies([boxBody({ named: false })]);
    const ref = hitToRef(bodies, { kind: 'face', body: 0, index: 3 })!;
    expect(ref.name).toBe(placeholderName('face', 3));
    expect(ref.placeholder).toBe(true);
    expect(ref.fragile).toBe(true);
  });

  it('always names vertices with placeholders (no vertex slots yet)', () => {
    const bodies = prepareBodies([boxBody()]);
    const ref = hitToRef(bodies, { kind: 'vertex', body: 0, index: 2 })!;
    expect(ref.kind).toBe('vertex');
    expect(isPlaceholderName(ref.name)).toBe(true);
    expect(ref.placeholder).toBe(true);
  });

  it('returns null for an unknown body or index', () => {
    const bodies = prepareBodies([boxBody()]);
    expect(hitToRef(bodies, { kind: 'face', body: 3, index: 1 })).toBeNull();
    expect(hitToRef(bodies, { kind: 'face', body: 0, index: 99 })).toBeNull();
  });

  it('covers every geometry kind', () => {
    const bodies = prepareBodies([boxBody()]);
    for (const kind of GEOMETRY_KINDS) {
      expect(hitToRef(bodies, { kind, body: 0, index: 1 })?.kind).toBe(kind);
    }
  });
});

describe('placeholder naming seam', () => {
  it('fills only unnamed slots, keeps existing names and their indices', () => {
    const input = boxBody();
    const before = [...input.names];
    // Pretend the naming layer left face 2 and edge 5 unnamed.
    input.mesh.faceNames[1] = 0xffffffff;
    input.mesh.edgeNames[4] = 0xffffffff;
    const names = fillPlaceholderNames(input.mesh, input.names);
    expect(names.slice(0, before.length)).toEqual(before);
    expect(names[input.mesh.faceNames[1]!]).toBe('placeholder:face:2');
    expect(names[input.mesh.edgeNames[4]!]).toBe('placeholder:edge:5');
    expect(input.mesh.faceFragile[1]).toBe(1);
    expect(names[input.mesh.faceNames[0]!]).toBe('box/left');
    expect(input.mesh.faceFragile[0]).toBe(0);
  });

  it('is a no-op for a fully named mesh', () => {
    const input = boxBody();
    expect(fillPlaceholderNames(input.mesh, input.names)).toEqual(input.names);
  });
});
