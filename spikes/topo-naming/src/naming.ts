// Persistent names for faces and edges, built from OCCT history.
//
// Faces are named where they are born and carried through every later
// operation by history:
//   extrude#1:cap:start, extrude#1:cap:end   the two caps of an extrusion
//   extrude#1:side:e2                        the face swept by sketch edge e2
//   fillet#3:round:r1                        the face a fillet made from its reference r1
//   fillet#3:corner:<vertex>                 a corner blend made from a vertex
//   X#1, X#2                                 face X split by the kernel into pieces, or
//                                            several faces generated as X (fragile)
//   (A+B)                                    faces A and B merged into one
// Every face also carries its lineage (itself and every name it descends
// from), so a reference to X can still find X#1 or e2#a when it is unique.
//
// The `#` separator has two meanings, told apart by what follows it: a letter
// (`e2#a`) is a sketch split, made by the sketcher and deterministic; digits
// (`s3#1`) are a positional piece, numbered by this layer in centroid order and
// fragile. Feature ids (`cut#4`) always have `:` after their digits.
//
// Edges are not tracked by edge history. They are named by their adjacent
// faces, which is what they mean to a user ("the edge between the top and
// the front"):
//   A|B                    the one edge between faces A and B
//   A|A                    the seam of periodic face A
//   A|B[C,D]               one of several A|B edges, told apart by the other
//                          faces meeting at its end vertices
//   A|B[C,D]#k             still not unique: ordered by position (fragile)

import type { EdgeInfo, HistoryEntry, Topology, Vec3 } from './kernel.ts';

export interface FaceName {
  name: string;
  /** This name and every name it descends from. */
  lineage: string[];
  /** True when the name depends on a geometric ordering (a kernel split). */
  fragile: boolean;
}

export interface EdgeName {
  name: string;
  /** Adjacent face names, sorted; a seam lists its face twice. */
  faces: string[];
  /** Names of the other faces at the end vertices, sorted; empty unless needed. */
  ends: string[];
  /** 1-based position among edges with the same faces and ends; 0 unless needed. */
  ordinal: number;
  fragile: boolean;
}

/** The names of one shape, indexed like its topology (entry i is sub-shape i + 1). */
export interface Names {
  faces: FaceName[];
  edges: EdgeName[];
}

export interface FaceRef {
  face: string;
}

export interface EdgeRef {
  /** Adjacent face names, sorted. */
  faces: string[];
  ends?: string[];
  ordinal?: number;
}

/**
 * How a reference was resolved: `exact` by name; the others are weaker and
 * reported. `ancestor`: the reference named a kernel-split piece (`X#2`) and
 * the split is gone, so it resolved to the whole face `X`. `ends`: the end
 * faces were needed to choose and no longer match exactly.
 */
export type Via = 'exact' | 'descendant' | 'ancestor' | 'ends' | 'ordinal';

export type Resolution =
  | {
      ok: true;
      index: number;
      via: Via;
      /**
       * True when the choice rested on position: the reference names a
       * positional piece (`X#2`) or an edge ordinal picked it. Such a
       * resolution can land on a different piece after an edit, even when
       * `via` is `exact`, so it is always reported.
       */
      fragile: boolean;
    }
  | { ok: false; status: 'lost'; missing: string[] }
  | { ok: false; status: 'ambiguous'; candidates: string[] };

export type Failure = Extract<Resolution, { ok: false }>;

// Formatting ----------------------------------------------------------------

export function edgeRefName(ref: EdgeRef): string {
  let name = ref.faces.join('|');
  if (ref.ends && ref.ends.length > 0) name += `[${ref.ends.join(',')}]`;
  if (ref.ordinal) name += `#${ref.ordinal}`;
  return name;
}

/**
 * Whether a name contains a positional piece number: `#<digits>` closing a
 * name segment (`X#2`, `(X#2+Y)`, `A&X#2`). Feature ids (`cut#4:`) and sketch
 * splits (`e2#a`) do not count.
 */
export function isPositional(name: string): boolean {
  return /#\d+(?=$|[#+)&,|\]])/.test(name);
}

/** A readable message for a failed resolution of `target`. */
export function describeFailure(target: string, failure: Failure): string {
  if (failure.status === 'ambiguous') {
    return `${target} is ambiguous: it matches ${failure.candidates.join(', ')}; pick one`;
  }
  if (failure.missing.length > 0) {
    const verb = failure.missing.length === 1 ? 'no longer exists' : 'no longer exist';
    return `${target} is lost: ${failure.missing.join(', ')} ${verb}`;
  }
  return `${target} is lost: its faces all still exist but no longer share an edge`;
}

/** Names a sketch id descends from: `e2#a` was split from `e2`. */
function sketchAncestors(id: string): string[] {
  const out: string[] = [];
  let at = id.lastIndexOf('#');
  let current = id;
  while (at > 0) {
    current = current.slice(0, at);
    out.push(current);
    at = current.lastIndexOf('#');
  }
  return out;
}

// Birth: extrusions ---------------------------------------------------------------

export interface ExtrudeFaces {
  capStart: number;
  capEnd: number;
  /** Result face index per sketch edge, parallel to `sketchIds`. */
  sides: number[];
}

/** Name the faces of a fresh extrusion from its sketch edge ids. */
export function nameExtrusion(
  feature: string,
  sketchIds: string[],
  faces: ExtrudeFaces,
  topology: Topology,
): FaceName[] {
  const out: (FaceName | undefined)[] = new Array(topology.faces.length);
  const set = (index: number, name: string, lineage: string[]) => {
    if (out[index - 1]) throw new Error(`face ${index} named twice`);
    out[index - 1] = { name, lineage: [name, ...lineage], fragile: false };
  };
  set(faces.capStart, `${feature}:cap:start`, []);
  set(faces.capEnd, `${feature}:cap:end`, []);
  faces.sides.forEach((index, i) => {
    const id = sketchIds[i]!;
    set(
      index,
      `${feature}:side:${id}`,
      sketchAncestors(id).map((a) => `${feature}:side:${a}`),
    );
  });
  return out.map((f, i) => {
    if (!f) throw new Error(`extrusion face ${i + 1} has no name`);
    return f;
  });
}

// Propagation through an operation ------------------------------------------------

/**
 * Name the faces generated from an input edge or vertex (fillet faces). Return
 * null when the operation does not name that input.
 */
export type GeneratedNamer = (entry: HistoryEntry) => string | null;

export interface Propagation {
  faces: FaceName[];
  /** Result faces no history reached; a correct operation has none. */
  unnamed: number[];
}

/**
 * Carry face names from the operands to the result: kept and modified faces
 * inherit their input's name, a face split into pieces gets `#k` suffixes
 * ordered by position, several inputs landing on one face merge, and faces
 * generated from edges or vertices are named by `generated`.
 */
export function propagateFaces(
  operands: FaceName[][],
  history: HistoryEntry[],
  topology: Topology,
  generated: GeneratedNamer = () => null,
): Propagation {
  const count = topology.faces.length;
  const sources: FaceName[][] = Array.from({ length: count }, () => []);
  const born: FaceName[][] = Array.from({ length: count }, () => []);
  const byPosition = (indices: number[]) =>
    [...indices].sort((p, q) =>
      comparePoints(topology.faces[p - 1]!.centroid, topology.faces[q - 1]!.centroid),
    );

  for (const entry of history) {
    if (entry.input.kind === 'face') {
      const input = operands[entry.operand]?.[entry.input.index - 1];
      if (!input) throw new Error(`no name for operand ${entry.operand} face ${entry.input.index}`);
      const targets =
        entry.kept > 0
          ? [entry.kept]
          : entry.modified.filter((r) => r.kind === 'face').map((r) => r.index);
      if (targets.length === 1) {
        sources[targets[0]! - 1]!.push(input);
      } else if (targets.length > 1) {
        // One input face became several: order the pieces by position.
        byPosition(targets).forEach((target, k) => {
          const name = `${input.name}#${k + 1}`;
          sources[target - 1]!.push({ name, lineage: [name, ...input.lineage], fragile: true });
        });
      }
    } else {
      const faces = entry.generated.filter((r) => r.kind === 'face').map((r) => r.index);
      if (faces.length === 0) continue;
      const name = generated(entry);
      if (name === null) continue;
      if (faces.length === 1) {
        born[faces[0]! - 1]!.push({ name, lineage: [name], fragile: false });
        continue;
      }
      // One input generated several faces: number them by position, like a
      // split, never by the kernel's index order.
      byPosition(faces).forEach((target, k) => {
        const piece = `${name}#${k + 1}`;
        born[target - 1]!.push({ name: piece, lineage: [piece, name], fragile: true });
      });
    }
  }

  const unnamed: number[] = [];
  const faces = sources.map((from, i): FaceName => {
    if (from.length === 0) {
      if (born[i]!.length === 0) {
        unnamed.push(i + 1);
        const name = `?face${i + 1}`;
        return { name, lineage: [name], fragile: true };
      }
      return merge(born[i]!);
    }
    return merge(from);
  });
  return { faces, unnamed };
}

function merge(from: FaceName[]): FaceName {
  const unique = new Map<string, FaceName>();
  for (const f of from) unique.set(f.name, f);
  if (unique.size === 1) return [...unique.values()][0]!;
  const parts = [...unique.values()].sort((p, q) => (p.name < q.name ? -1 : 1));
  const name = `(${parts.map((p) => p.name).join('+')})`;
  return {
    name,
    lineage: [name, ...new Set(parts.flatMap((p) => p.lineage))],
    fragile: parts.some((p) => p.fragile),
  };
}

/** Name a vertex of an input by the sorted names of the faces around it. */
export function vertexName(faces: FaceName[], topology: Topology, vertex: number): string {
  const around = topology.vertices[vertex - 1]!.faces.map((f) => faces[f - 1]!.name);
  return [...new Set(around)].sort().join('&');
}

// Edges ----------------------------------------------------------------------------

function comparePoints(a: Vec3, b: Vec3): number {
  const tol = 1e-6;
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (Math.abs(d) > tol) return d;
  }
  return 0;
}

function facePair(faces: FaceName[], edge: EdgeInfo): string[] {
  const names = edge.faces.map((f) => faces[f - 1]!.name);
  if (edge.seam && names.length === 1) names.push(names[0]!);
  return names.sort();
}

function endFaces(faces: FaceName[], topology: Topology, edge: EdgeInfo): string[] {
  const own = new Set(edge.faces);
  const out = new Set<string>();
  for (const v of edge.vertices) {
    for (const f of topology.vertices[v - 1]!.faces) if (!own.has(f)) out.add(faces[f - 1]!.name);
  }
  return [...out].sort();
}

/** Name every edge of a shape from the names of its faces. */
export function nameEdges(faces: FaceName[], topology: Topology): EdgeName[] {
  const edges: EdgeName[] = topology.edges.map((edge) => {
    const pair = facePair(faces, edge);
    return {
      name: pair.join('|'),
      faces: pair,
      ends: [],
      ordinal: 0,
      fragile: pair.some((n) => faces.find((f) => f.name === n)?.fragile),
    };
  });
  const groups = (key: (e: EdgeName) => string) => {
    const map = new Map<string, number[]>();
    edges.forEach((e, i) => map.set(key(e), [...(map.get(key(e)) ?? []), i]));
    return [...map.values()].filter((g) => g.length > 1);
  };
  for (const group of groups((e) => e.name)) {
    for (const i of group) {
      const e = edges[i]!;
      e.ends = endFaces(faces, topology, topology.edges[i]!);
      e.name = edgeRefName({ faces: e.faces, ends: e.ends });
    }
  }
  for (const group of groups((e) => e.name)) {
    const ordered = [...group].sort((p, q) =>
      comparePoints(topology.edges[p]!.midpoint, topology.edges[q]!.midpoint),
    );
    ordered.forEach((i, k) => {
      const e = edges[i]!;
      e.ordinal = k + 1;
      e.fragile = true;
      e.name = edgeRefName(e);
    });
  }
  return edges;
}

export function nameShape(faces: FaceName[], topology: Topology): Names {
  return { faces, edges: nameEdges(faces, topology) };
}

// References -------------------------------------------------------------------------

/** The reference a user's click on face `index` is stored as. */
export function pickFace(names: Names, index: number): FaceRef {
  return { face: names.faces[index - 1]!.name };
}

/** The reference a user's click on edge `index` is stored as: only what is needed to be unique. */
export function pickEdge(names: Names, index: number): EdgeRef {
  const e = names.edges[index - 1]!;
  const ref: EdgeRef = { faces: [...e.faces] };
  if (e.ends.length > 0) ref.ends = [...e.ends];
  if (e.ordinal > 0) ref.ordinal = e.ordinal;
  return ref;
}

/** The face a positional piece came from: `X#2` gives `X`; anything else gives null. */
export function splitParent(name: string): string | null {
  const match = /^(.*)#\d+$/.exec(name);
  return match && !match[1]!.endsWith('|') ? match[1]! : null;
}

export function resolveFace(names: Names, ref: FaceRef): Resolution {
  const fragile = isPositional(ref.face);
  const exact = indicesWhere(names.faces, (f) => f.name === ref.face);
  if (exact.length === 1) return { ok: true, index: exact[0]!, via: 'exact', fragile };
  const found =
    exact.length > 0 ? exact : indicesWhere(names.faces, (f) => f.lineage.includes(ref.face));
  if (found.length === 1) return { ok: true, index: found[0]!, via: 'descendant', fragile };
  if (found.length === 0) {
    const parent = splitParent(ref.face);
    if (parent !== null) {
      const whole = indicesWhere(names.faces, (f) => f.name === parent);
      if (whole.length === 1) return { ok: true, index: whole[0]!, via: 'ancestor', fragile };
    }
    return { ok: false, status: 'lost', missing: [ref.face] };
  }
  return {
    ok: false,
    status: 'ambiguous',
    candidates: found.map((i) => names.faces[i - 1]!.name).sort(),
  };
}

/**
 * Resolve an edge reference. Exact face names first, then faces descending
 * from them; `ends` and `ordinal` are consulted only to choose between
 * several candidates, never to find one that the faces do not match. The
 * result is fragile when a positional face name (in `faces`, or in `ends`
 * when they were used) or the ordinal took part in the choice.
 */
export function resolveEdge(names: Names, topology: Topology, ref: EdgeRef): Resolution {
  const faceOf = (i: number) => names.faces[i - 1]!;
  const edgeFaces = (i: number): FaceName[] => {
    const e = topology.edges[i - 1]!;
    const list = e.faces.map(faceOf);
    if (e.seam && list.length === 1) list.push(list[0]!);
    return list;
  };
  const matches = (i: number, test: (f: FaceName, want: string) => boolean) => {
    const have = edgeFaces(i);
    if (have.length !== ref.faces.length) return false;
    // Try both assignments of a pair (faces are sorted by name, lineage matching is not).
    const [a, b] = ref.faces;
    if (have.length !== 2 || a === undefined || b === undefined) {
      return ref.faces.every((w, k) => test(have[k]!, w));
    }
    return (test(have[0]!, a) && test(have[1]!, b)) || (test(have[0]!, b) && test(have[1]!, a));
  };
  const all = topology.edges.map((e) => e.index);
  let via: Via = 'exact';
  let fragile = ref.faces.some(isPositional);
  let candidates = all.filter((i) => matches(i, (f, w) => f.name === w));
  if (candidates.length === 0) {
    via = 'descendant';
    candidates = all.filter((i) => matches(i, (f, w) => f.lineage.includes(w)));
  }
  if (candidates.length === 0 && ref.faces.some((w) => splitParent(w) !== null)) {
    via = 'ancestor';
    candidates = all.filter((i) =>
      matches(i, (f, w) => f.lineage.includes(w) || f.name === splitParent(w)),
    );
  }
  if (candidates.length === 0) {
    const missing = ref.faces.filter((w) => !names.faces.some((f) => f.lineage.includes(w)));
    return { ok: false, status: 'lost', missing: missing.length > 0 ? [...new Set(missing)] : [] };
  }
  if (candidates.length > 1 && ref.ends && ref.ends.length > 0) {
    const wanted = ref.ends;
    const score = (i: number) => {
      const around = endFaces(names.faces, topology, topology.edges[i - 1]!);
      const lineages = around.map((n) => names.faces.find((f) => f.name === n)!.lineage);
      return wanted.filter((w) => lineages.some((l) => l.includes(w))).length;
    };
    const scores = candidates.map(score);
    const best = Math.max(...scores);
    if (best > 0) {
      candidates = candidates.filter((_, k) => scores[k] === best);
      fragile ||= wanted.some(isPositional);
      // Ends that still match by name exactly are not a weaker resolution;
      // a partial or lineage-only match is.
      const key = [...wanted].sort().join(',');
      const unchanged = candidates.every(
        (i) => endFaces(names.faces, topology, topology.edges[i - 1]!).join(',') === key,
      );
      if (!unchanged) via = 'ends';
    }
  }
  if (candidates.length > 1 && ref.ordinal) {
    const ordered = [...candidates].sort((p, q) =>
      comparePoints(topology.edges[p - 1]!.midpoint, topology.edges[q - 1]!.midpoint),
    );
    const pick = ordered[ref.ordinal - 1];
    if (pick !== undefined) return { ok: true, index: pick, via: 'ordinal', fragile: true };
  }
  if (candidates.length === 1) return { ok: true, index: candidates[0]!, via, fragile };
  return {
    ok: false,
    status: 'ambiguous',
    candidates: candidates.map((i) => names.edges[i - 1]!.name).sort(),
  };
}

function indicesWhere<T>(list: T[], test: (item: T) => boolean): number[] {
  const out: number[] = [];
  list.forEach((item, i) => {
    if (test(item)) out.push(i + 1);
  });
  return out;
}
