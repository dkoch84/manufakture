// Persistent names for faces and edges, built from OCCT history: the
// production naming layer (T0.5 naming scheme, `docs/spikes/T0.5-topo-naming.md`,
// ported from `spikes/topo-naming/src/naming.ts`). Pure TypeScript over plain
// data; it runs in the kernel worker next to the feature operations.
//
// Faces are named where they are born and carried through every later
// operation by history:
//   extrude#1:cap:start, extrude#1:cap:end   the caps of an extrusion (or revolve)
//   extrude#1:side:e2                        the face swept by sketch edge e2
//   fillet#3:round:r1                        the face a fillet made from its reference r1
//   fillet#3:round:A&B                       a round OCCT added along a tangent chain,
//                                            named by the faces of the edge it replaced
//   fillet#3:corner:A&B&C                    a corner blend made from a vertex
//   chamfer#4:bevel:r1, chamfer#4:corner:... the same for chamfers
//   shell#5:offset:X                         the wall face a shell grew from face X
//   hole#6:wall:p1                           a hole's faces, by part and sketch point
//   pattern#7:i2/X, mirror#8:image/X         face X of pattern instance 2, of a mirror image
//   import#9:face:4                          face 4 of an imported file, by its position in
//                                            the file (no history: always fragile)
//   X#1, X#2                                 face X split by the kernel into pieces, or
//                                            several faces born with one name (fragile)
//   (A+B)                                    faces A and B merged into one
// Every face also carries its lineage (itself and every name it descends
// from), so a reference to X can still find X#1 or e2#a when it is unique.
//
// The `#` separator has two meanings, told apart by what follows it: a letter
// (`e2#a`) is a sketch split, made by the sketcher and deterministic; digits
// (`s3#1`) are a positional piece, fragile. Feature ids (`cut#4`) always
// have `:` after their digits. Sketch region edge ids (`e2#1`, from
// `@manufakture/sketch`'s regions) use the positional form on purpose.
//
// Edges are named by their adjacent faces:
//   A|B                    the one edge between faces A and B
//   A|A                    the seam of periodic face A
//   A|B[C,D]               one of several A|B edges, told apart by the other
//                          faces meeting at its end vertices
//   A|B[C,D]#k             still not unique: ordered by position (fragile)

import type { EdgeInfo, HistoryEntry, Topology, Vec3 } from './types';

export interface FaceName {
  name: string;
  /** This name and every name it descends from. */
  lineage: string[];
  /** True when the name depends on a geometric ordering (a positional piece). */
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

export type TopoRef = FaceRef | EdgeRef;

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

/** Prefix of the placeholder name a face gets when no history reached it. */
export const UNNAMED_PREFIX = '?face';

// Ids and formatting -------------------------------------------------------------

/** Characters that structure names; they can never be part of an id. */
const RESERVED = /[\s:|[\],+()&/?{}]/;

/**
 * Why `id` cannot be a sketch edge id (or a reference id), or null. Ids are
 * plain tokens, optionally with sketch splits (`e2#a#b`) and, for sketch
 * region edges only, one final positional piece (`e2#1`, `e2#a#3`). An id
 * with `#<digits>` anywhere else would be read as a kernel split.
 */
export function invalidSketchId(id: unknown, positional = true): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'an id must be a non-empty string';
  if (RESERVED.test(id)) return `id '${id}' contains a reserved character`;
  const pattern = positional
    ? /^[A-Za-z0-9_.@-]+(#[a-z]+)*(#[1-9][0-9]*)?$/
    : /^[A-Za-z0-9_.@-]+(#[a-z]+)*$/;
  if (!pattern.test(id)) {
    return positional
      ? `id '${id}' must be a token with letter splits (#a) and at most one final #<digits>`
      : `id '${id}' must be a token with letter splits (#a) only`;
  }
  return null;
}

/** Why `id` cannot be a feature id (`kind#n`), or null. */
export function invalidFeatureId(id: unknown): string | null {
  return typeof id === 'string' && /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/.test(id)
    ? null
    : `feature id ${JSON.stringify(id)} must look like "extrude#1"`;
}

export function edgeRefName(ref: EdgeRef): string {
  let name = ref.faces.join('|');
  if (ref.ends && ref.ends.length > 0) name += `[${ref.ends.join(',')}]`;
  if (ref.ordinal) name += `#${ref.ordinal}`;
  return name;
}

/** A reference as a readable name. */
export function refName(ref: TopoRef): string {
  return 'face' in ref ? ref.face : edgeRefName(ref);
}

/**
 * Whether a name contains a positional piece number: `#<digits>` closing a
 * name segment (`X#2`, `(X#2+Y)`, `A&X#2`, `pattern#7:i2/X#2`), or is built
 * on a face of an imported file (`import#9:face:4`), which is numbered by its
 * position in the file. Feature ids (`cut#4:`) and sketch splits (`e2#a`) do
 * not count.
 */
export function isPositional(name: string): boolean {
  return /#\d+(?=$|[#+)&,|\]/])/.test(name) || IMPORTED_FACE.test(name);
}

/** A face of an imported file, anywhere in a name. */
const IMPORTED_FACE = /(?<![A-Za-z0-9#])import#[1-9][0-9]*:face:\d+/;

/**
 * Whether a name is, or was built from, the placeholder of a face no history
 * reached. `?` is reserved in ids, so any name containing it (a bare `?face3`,
 * or one a feature wrapped, `shell#2:offset:?face3`, `hole#2:?face3`,
 * `pattern#3:i2/?face1`) came from a placeholder.
 */
export function isUnnamed(name: string): boolean {
  return name.includes('?');
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

/** Names a sketch id descends from: `e2#a` was split from `e2`, `e2#a#1` from both. */
export function sketchAncestors(id: string): string[] {
  const out: string[] = [];
  let current = id;
  let at = current.lastIndexOf('#');
  while (at > 0) {
    current = current.slice(0, at);
    out.push(current);
    at = current.lastIndexOf('#');
  }
  return out;
}

// Birth ---------------------------------------------------------------------------

/** A face named at birth: `<feature>:<role>:<id>`, with the ancestors of a split sketch id. */
export function bornFace(feature: string, role: string, id?: string): FaceName {
  if (id === undefined) {
    const name = `${feature}:${role}`;
    return { name, lineage: [name], fragile: false };
  }
  const name = `${feature}:${role}:${id}`;
  return {
    name,
    lineage: [name, ...sketchAncestors(id).map((a) => `${feature}:${role}:${a}`)],
    fragile: isPositional(id),
  };
}

/**
 * Face `index` (1-based, in the file's face order) of a shape imported by
 * feature `feature`: `import#k:face:<index>`. Imported topology has no
 * history, so the name is positional and always fragile.
 */
export function importedFace(feature: string, index: number): FaceName {
  const name = `${feature}:face:${index}`;
  return { name, lineage: [name], fragile: true };
}

export interface SweepFaces {
  /** 0 when the sweep has no such cap (a full revolution). */
  capStart: number;
  capEnd: number;
  /** Result face of every profile entity by entity id. */
  sideIds: Record<string, number>;
}

/**
 * Name the faces of a fresh sweep (extrusion or revolution). Returns the
 * names and the faces nothing named, which a correct sweep does not have.
 */
export function nameSweep(
  feature: string,
  faces: SweepFaces,
  topology: Topology,
  roles: { cap?: string; side?: string } = {},
): { faces: FaceName[]; unnamed: number[] } {
  const out: (FaceName | undefined)[] = new Array(topology.faces.length);
  const set = (index: number, face: FaceName) => {
    if (index < 1 || index > out.length) throw new Error(`face ${index} is not in the sweep`);
    if (out[index - 1]) throw new Error(`face ${index} named twice`);
    out[index - 1] = face;
  };
  const cap = roles.cap ?? 'cap';
  const side = roles.side ?? 'side';
  if (faces.capStart > 0) set(faces.capStart, bornFace(feature, cap, 'start'));
  if (faces.capEnd > 0) set(faces.capEnd, bornFace(feature, cap, 'end'));
  for (const [id, index] of Object.entries(faces.sideIds)) set(index, bornFace(feature, side, id));
  return fill(out);
}

/** Give every face without a name the `?faceN` placeholder and report it. */
function fill(out: (FaceName | undefined)[]): { faces: FaceName[]; unnamed: number[] } {
  const unnamed: number[] = [];
  const faces = Array.from(out, (f, i) => {
    if (f) return f;
    unnamed.push(i + 1);
    const name = `${UNNAMED_PREFIX}${i + 1}`;
    return { name, lineage: [name], fragile: true };
  });
  return { faces, unnamed };
}

/**
 * The faces of a transformed copy (a pattern instance, a mirror image):
 * every name gets `prefix/`. The lineage is prefixed too and does not
 * include the source names, so a reference to the source never finds a copy.
 */
export function prefixFaces(faces: readonly FaceName[], prefix: string): FaceName[] {
  return faces.map((f) => ({
    name: `${prefix}/${f.name}`,
    lineage: f.lineage.map((n) => `${prefix}/${n}`),
    fragile: f.fragile,
  }));
}

// Propagation through an operation ------------------------------------------------

/**
 * Name the faces an operation generated from an input sub-shape. Gets the
 * history entry and, for a face input, the input face's name. Return null
 * when the operation does not name what that input generated.
 */
export type GeneratedNamer = (entry: HistoryEntry, input: FaceName | null) => string | null;

export interface Propagation {
  faces: FaceName[];
  /** Result faces no history reached; a correct operation has none. */
  unnamed: number[];
}

/**
 * Carry face names from the operands to the result:
 *
 * - kept and modified faces inherit their input's name; an input face split
 *   into pieces gives `#k` suffixes ordered by position (fragile);
 * - several inputs landing on one face merge into `(A+B)`;
 * - faces generated from an edge or vertex are named by `generated`;
 * - faces generated from a face are named by `generated` too (a shell's
 *   offset wall); when it has no name for them and the input face was
 *   neither kept nor modified, they replace it and inherit its name (a
 *   drafted face is Generated, not Modified, by OCCT's draft);
 * - finally, faces that still share one name are numbered by position.
 */
export function propagateFaces(
  operands: readonly (readonly FaceName[])[],
  history: readonly HistoryEntry[],
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
  const inherit = (input: FaceName, targets: number[]) => {
    if (targets.length === 1) {
      sources[targets[0]! - 1]!.push(input);
      return;
    }
    // One input face became several: order the pieces by position.
    byPosition(targets).forEach((target, k) => {
      const name = `${input.name}#${k + 1}`;
      sources[target - 1]!.push({ name, lineage: [name, ...input.lineage], fragile: true });
    });
  };
  const bear = (name: string, faces: number[]) => {
    if (faces.length === 1) {
      born[faces[0]! - 1]!.push({ name, lineage: [name], fragile: isPositional(name) });
      return;
    }
    // One input generated several faces: number them by position, like a
    // split, never by the kernel's index order.
    byPosition(faces).forEach((target, k) => {
      const piece = `${name}#${k + 1}`;
      born[target - 1]!.push({ name: piece, lineage: [piece, name], fragile: true });
    });
  };

  for (const entry of history) {
    const genFaces = entry.generated.filter((r) => r.kind === 'face').map((r) => r.index);
    if (entry.input.kind === 'face') {
      const input = operands[entry.operand]?.[entry.input.index - 1];
      if (!input) throw new Error(`no name for operand ${entry.operand} face ${entry.input.index}`);
      const targets =
        entry.kept > 0
          ? [entry.kept]
          : entry.modified.filter((r) => r.kind === 'face').map((r) => r.index);
      if (targets.length > 0) inherit(input, targets);
      if (genFaces.length === 0) continue;
      const name = generated(entry, input);
      if (name !== null) bear(name, genFaces);
      else if (targets.length === 0) inherit(input, genFaces);
    } else {
      if (genFaces.length === 0) continue;
      const name = generated(entry, null);
      if (name !== null) bear(name, genFaces);
    }
  }

  const out = sources.map((from, i): FaceName | undefined => {
    if (from.length > 0) return merge(from);
    if (born[i]!.length > 0) return merge(born[i]!);
    return undefined;
  });
  const filled = fill(out);
  return { faces: disambiguate(filled.faces, topology), unnamed: filled.unnamed };
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

/**
 * Faces that ended up with the same name (a fillet round that OCCT carried
 * along a tangent chain, two generated faces named alike) are numbered by
 * position, like kernel splits, and flagged fragile.
 */
export function disambiguate(faces: FaceName[], topology: Topology): FaceName[] {
  const groups = new Map<string, number[]>();
  faces.forEach((f, i) => {
    if (!isUnnamed(f.name)) groups.set(f.name, [...(groups.get(f.name) ?? []), i]);
  });
  const out = [...faces];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((p, q) =>
      comparePoints(topology.faces[p]!.centroid, topology.faces[q]!.centroid),
    );
    ordered.forEach((i, k) => {
      const f = faces[i]!;
      const name = `${f.name}#${k + 1}`;
      out[i] = { name, lineage: [name, ...f.lineage], fragile: true };
    });
  }
  return out;
}

/** Name a vertex of a shape by the sorted names of the faces around it, joined by `&`. */
export function vertexName(faces: readonly FaceName[], topology: Topology, vertex: number): string {
  const around = topology.vertices[vertex - 1]!.faces.map((f) => faces[f - 1]!.name);
  return [...new Set(around)].sort().join('&');
}

/** Name an edge of a shape by the sorted names of its faces, joined by `&` (for face names). */
export function edgeFacesName(
  faces: readonly FaceName[],
  topology: Topology,
  edge: number,
): string {
  const e = topology.edges[edge - 1]!;
  return [...new Set(e.faces.map((f) => faces[f - 1]!.name))].sort().join('&');
}

// Edges ----------------------------------------------------------------------------

export function comparePoints(a: Vec3, b: Vec3): number {
  const tol = 1e-6;
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (Math.abs(d) > tol) return d;
  }
  return 0;
}

function facePair(faces: readonly FaceName[], edge: EdgeInfo): string[] {
  const names = edge.faces.map((f) => faces[f - 1]!.name);
  if (edge.seam && names.length === 1) names.push(names[0]!);
  return names.sort();
}

function endFaces(faces: readonly FaceName[], topology: Topology, edge: EdgeInfo): string[] {
  const own = new Set(edge.faces);
  const out = new Set<string>();
  for (const v of edge.vertices) {
    for (const f of topology.vertices[v - 1]!.faces) if (!own.has(f)) out.add(faces[f - 1]!.name);
  }
  return [...out].sort();
}

/** Name every edge of a shape from the names of its faces. */
export function nameEdges(faces: readonly FaceName[], topology: Topology): EdgeName[] {
  const fragileFace = new Map(faces.map((f) => [f.name, f.fragile]));
  const edges: EdgeName[] = topology.edges.map((edge) => {
    const pair = facePair(faces, edge);
    return {
      name: pair.join('|'),
      faces: pair,
      ends: [],
      ordinal: 0,
      fragile: pair.some((n) => fragileFace.get(n) === true),
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

/**
 * The reference a click on face `index` is stored as, or null when the face
 * has no real name (a `?faceN` placeholder can never be stored).
 */
export function pickFace(names: Names, index: number): FaceRef | null {
  const f = names.faces[index - 1];
  return f && !isUnnamed(f.name) ? { face: f.name } : null;
}

/** The reference a click on edge `index` is stored as: only what is needed to be unique. */
export function pickEdge(names: Names, index: number): EdgeRef | null {
  const e = names.edges[index - 1];
  if (!e || e.faces.some(isUnnamed) || e.ends.some(isUnnamed)) return null;
  const ref: EdgeRef = { faces: [...e.faces] };
  if (e.ends.length > 0) ref.ends = [...e.ends];
  if (e.ordinal > 0) ref.ordinal = e.ordinal;
  return ref;
}

/**
 * The face a positional piece came from: `X#2` gives `X`; anything else
 * gives null. A name ending in a nested positional component (a corner
 * `fillet#3:corner:A&B&C#2`, where `C#2` is a piece of C) reads the same
 * way: its "parent" is the same corner around the whole C, which is the
 * right face when C is whole again, and such a resolution is always
 * `fragile` because the name is positional.
 */
export function splitParent(name: string): string | null {
  const match = /^(.*)#\d+$/.exec(name);
  if (!match) return null;
  const parent = match[1]!;
  // Face names never contain `|`: `A|B[C,D]#1` is an edge ordinal, not a face piece.
  if (parent.length === 0 || parent.includes('|')) return null;
  return parent;
}

export function resolveFace(names: Names, ref: FaceRef): Resolution {
  if (isUnnamed(ref.face)) return { ok: false, status: 'lost', missing: [ref.face] };
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
 * from them, then the whole faces of split pieces; `ends` and `ordinal` are
 * consulted only to choose between several candidates, never to find one
 * that the faces do not match. The result is fragile when a positional face
 * name (in `faces`, or in `ends` when they were used) or the ordinal took
 * part in the choice.
 */
export function resolveEdge(names: Names, topology: Topology, ref: EdgeRef): Resolution {
  const unnamed = ref.faces.filter(isUnnamed);
  if (unnamed.length > 0) return { ok: false, status: 'lost', missing: unnamed };
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
    const lineageOf = new Map(names.faces.map((f) => [f.name, f.lineage]));
    const score = (i: number) => {
      const around = endFaces(names.faces, topology, topology.edges[i - 1]!);
      const lineages = around.map((n) => lineageOf.get(n) ?? [n]);
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

export function resolve(names: Names, topology: Topology, ref: TopoRef): Resolution {
  return 'face' in ref ? resolveFace(names, ref) : resolveEdge(names, topology, ref);
}

function indicesWhere<T>(list: readonly T[], test: (item: T) => boolean): number[] {
  const out: number[] = [];
  list.forEach((item, i) => {
    if (test(item)) out.push(i + 1);
  });
  return out;
}
