// The dependency graph of a part, and the dirty subgraph of an edit.
//
// Edges run from a feature to what it needs:
//
// - features it names by id or by face name (core's `featureDependencies`: profiles, hole
//   sketches, pattern and mirror sources, `dependsOn`, and every feature whose id starts a face
//   name in one of its references);
// - the bodies it reads: a kernel feature depends on the last feature that changed each body in
//   its scope, or that owns one of its references (a fillet's edges, an up-to-face face), and a
//   feature with no scope on the last feature that changed each body; a sketch on a face depends
//   on the last change of the body owning the face. This is the `body` edge, one per body;
// - the variables its expressions read, directly or through other variables.
//
// A feature whose own inputs changed is a seed; the dirty subgraph is the seeds plus everything
// that depends on them, through any edge. A variable edit therefore dirties only the features
// that read it (and what depends on those), not everything after the first of them.

import {
  bodyCreator,
  expressionVariableNames,
  featureDependencies,
  featureExpressions,
  featureIdsInName,
  featureReferences,
  referenceNames,
  type Feature,
  type ManufaktureDocument,
  type Part,
  type Variable,
} from '@manufakture/core';

/** Features the kernel builds: each takes the bodies before it and gives the bodies after it. */
export const BODY_KINDS: ReadonlySet<Feature['kind']> = new Set([
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'pattern',
  'mirror',
  'derived',
]);

export function isBodyFeature(feature: Feature): boolean {
  // An import is built unless it is only a reference body (kept aside, never built).
  if (feature.kind === 'import') return feature.operation !== 'reference';
  return BODY_KINDS.has(feature.kind);
}

/** Whether a feature needs the body set before it: kernel features, and sketches placed on a face. */
export function readsBody(feature: Feature): boolean {
  return isBodyFeature(feature) || (feature.kind === 'sketch' && feature.plane.type === 'face');
}

/**
 * What a feature reads of the part's bodies (M2 plan, decisions 2 and 3):
 *
 * - `all`: every body at that point. A feature with an operation and no `scope` (an `add`, a cut,
 *   a hole, a pattern or mirror of bodies), a through-all `new` extrusion (its length is measured
 *   against the bodies) and a closed hollow (a shell removing no face) read them all;
 * - `scope`: the bodies its scope lists;
 * - `refs`: the face names of each of its references, one group per reference, all on one body:
 *   a fillet's edges, a shell's faces, an up-to-face face, an edge axis, a pattern direction, a
 *   mirror plane, the face a sketch lies on.
 *
 * A `new` feature reads only the bodies its references lie on (a blind extrusion reads none), so
 * a body made later does not depend on earlier bodies. A pattern or mirror of features reads what
 * the features it repeats read, plus its own references. Null for a feature that reads no body
 * (a sketch on a plane, an extension, a reference import).
 */
export interface BodyUse {
  all: boolean;
  scope: readonly string[];
  refs: readonly (readonly string[])[];
}

/** `bodyUse`; `features` looks up the features a pattern or mirror repeats. */
export function bodyUse(
  feature: Feature,
  features: (id: string) => Feature | undefined = () => undefined,
): BodyUse | null {
  if (!readsBody(feature)) return null;
  const refs = featureReferences(feature).map((r) => referenceNames(r));
  switch (feature.kind) {
    case 'sketch':
      return { all: false, scope: [], refs };
    case 'extrude':
    case 'revolve':
    case 'import':
    case 'derived':
    case 'hole': {
      const scope = feature.scope ?? [];
      if (feature.kind !== 'hole' && feature.operation === 'new') {
        const through = feature.kind === 'extrude' && feature.extent.type === 'throughAll';
        return { all: through, scope: [], refs };
      }
      return { all: feature.scope === undefined, scope, refs };
    }
    case 'fillet':
    case 'chamfer':
      return { all: false, scope: [], refs };
    case 'shell':
      return { all: feature.faces.length === 0, scope: [], refs };
    case 'pattern':
    case 'mirror': {
      if (feature.body === true) {
        return { all: feature.scope === undefined, scope: feature.scope ?? [], refs };
      }
      let all = false;
      const scope = new Set<string>();
      const groups: (readonly string[])[] = [...refs];
      for (const id of feature.features) {
        const source = features(id);
        const use = source === undefined ? null : bodyUse(source, features);
        if (source === undefined) all = true;
        if (use === null) continue;
        all ||= use.all;
        for (const b of use.scope) scope.add(b);
        groups.push(...use.refs);
      }
      return { all, scope: [...scope], refs: groups };
    }
    default:
      return null;
  }
}

/** A body as the routing of references sees it. */
export interface RoutedBody {
  id: string;
  /**
   * Features whose faces the body may carry: the feature that made it, every feature that
   * changed it, and everything the bodies merged into it carried. A face name belongs to a body
   * carrying one of the feature ids in it.
   */
  carries: ReadonlySet<string>;
}

/**
 * The bodies a feature reads, as ids in `bodies` order (creator order). References go to the
 * bodies that carry a feature of every name of the reference (face names never include a body
 * id; which body owns which name follows merges through `carries`). A reference that no body
 * carries sends the feature every body, so the kernel reports it as it would with one body: a
 * lost reference is lost on every body, never on the wrong one. Scope entries that are not
 * bodies are left out; the kernel (or translation) reports them.
 */
export function routeBodies(use: BodyUse, bodies: readonly RoutedBody[]): string[] {
  if (use.all) return bodies.map((b) => b.id);
  const read = new Set(use.scope);
  for (const names of use.refs) {
    const owners = bodies.filter((b) =>
      names.every((name) => {
        const ids = featureIdsInName(name);
        return ids.length === 0 || ids.some((id) => b.carries.has(id));
      }),
    );
    if (owners.length === 0) return bodies.map((b) => b.id);
    for (const b of owners) read.add(b.id);
  }
  return bodies.filter((b) => read.has(b.id)).map((b) => b.id);
}

export interface DependencyGraph {
  /** Features before the rollback bar, in document order (suppressed ones included). */
  readonly active: readonly Feature[];
  /** Features after the bar. */
  readonly rolledBack: readonly Feature[];
  readonly byId: ReadonlyMap<string, Feature>;
  readonly index: ReadonlyMap<string, number>;
  /** Features named by id or face name (not the body edge), sorted. */
  readonly depends: ReadonlyMap<string, readonly string[]>;
  /**
   * For features that read bodies: the kernel features that last changed the bodies they read
   * (active and unsuppressed), in document order; empty when there is none yet or they read no
   * body (a blind `new` extrusion).
   */
  readonly body: ReadonlyMap<string, readonly string[]>;
  /** Variables each feature reads, directly or through other variables, sorted. */
  readonly variables: ReadonlyMap<string, readonly string[]>;
  /** Reverse edges (named dependencies and body edges), in document order. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

/** Every variable an expression set reads, following variables through other variables. */
export function variableClosure(
  variables: readonly Variable[],
  direct: Iterable<string>,
): Set<string> {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const out = new Set<string>();
  const stack = [...direct];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (out.has(name)) continue;
    out.add(name);
    const v = byName.get(name);
    if (v) stack.push(...expressionVariableNames(v.expression));
  }
  return out;
}

/** Variables a feature's expressions name directly. */
export function directVariables(feature: Feature): string[] {
  const out = new Set<string>();
  for (const site of featureExpressions(feature)) {
    for (const n of expressionVariableNames(site.expression)) out.add(n);
  }
  return [...out];
}

/** A body as the graph sees it before any regen: an estimate from operations and scopes. */
interface StaticBody extends RoutedBody {
  carries: Set<string>;
  /** The last feature that may have changed it. */
  last: string;
}

/**
 * The bodies a feature acts on (changes), as far as the document says: the bodies in its scope,
 * or every body without one; for fillets, chamfers and shells the bodies owning their
 * references. `read` is what `routeBodies` gave; a `new` feature changes none (it adds a body).
 */
function actsOn(
  f: Feature,
  use: BodyUse,
  read: readonly string[],
  bodies: readonly StaticBody[],
  features: (id: string) => Feature | undefined,
): { ids: string[]; merges: boolean } {
  const all = bodies.map((b) => b.id);
  const scoped = (scope: readonly string[] | undefined) =>
    scope === undefined ? all : all.filter((id) => scope.includes(id));
  switch (f.kind) {
    case 'extrude':
    case 'revolve':
    case 'import':
    case 'derived':
      if (f.operation === 'new') return { ids: [], merges: false };
      return { ids: scoped(f.scope), merges: f.operation === 'add' };
    case 'hole':
      return { ids: scoped(f.scope), merges: false };
    case 'fillet':
    case 'chamfer':
    case 'shell':
      return { ids: [...read], merges: false };
    case 'pattern':
    case 'mirror': {
      // `new` copies stay bodies of their own; `add` (the default) fuses them where they touch.
      if (f.body === true) return { ids: scoped(f.scope), merges: f.mode !== 'new' };
      const ids = new Set<string>();
      let merges = false;
      for (const id of f.features) {
        const source = features(id);
        if (source === undefined) {
          for (const b of all) ids.add(b);
          continue;
        }
        if ('operation' in source && source.operation === 'new') continue;
        for (const b of actsOn(source, use, read, bodies, features).ids) ids.add(b);
        merges ||= 'operation' in source && source.operation === 'add';
      }
      return { ids: all.filter((b) => ids.has(b)), merges };
    }
    default:
      return { ids: [], merges: false };
  }
}

export function buildGraph(part: Part, variables: readonly Variable[]): DependencyGraph {
  const bar = part.rollbackIndex ?? part.features.length;
  const active = part.features.slice(0, bar);
  const rolledBack = part.features.slice(bar);
  const byId = new Map(part.features.map((f) => [f.id, f]));
  const index = new Map(part.features.map((f, i) => [f.id, i]));
  const depends = new Map<string, string[]>();
  const body = new Map<string, string[]>();
  const vars = new Map<string, string[]>();
  const dependents = new Map<string, string[]>(active.map((f) => [f.id, []]));
  const lookup = (id: string) => byId.get(id);

  // The bodies as far as the document tells: made by `new` features, changed by the features
  // acting on them, merged by `add`s. Regen knows the real set only from the kernel; this
  // estimate errs on the side of more edges (an unscoped feature reads and changes every body).
  const bodies: StaticBody[] = [];
  const materialize = (id: string) => {
    // A body named in a scope that no `new` feature made here: an `add` that touched nothing,
    // or a pattern copy. It starts with its creator.
    if (bodies.some((b) => b.id === id)) return;
    const creator = bodyCreator(id);
    if (creator === undefined || !byId.has(creator)) return;
    bodies.push({ id, carries: new Set([creator]), last: creator });
  };
  for (const f of active) {
    const deps = featureDependencies(f).filter((d) => byId.has(d));
    depends.set(f.id, deps);
    for (const d of deps) dependents.get(d)?.push(f.id);
    const use = bodyUse(f, lookup);
    if (use !== null) {
      for (const id of use.scope) materialize(id);
      const read = routeBodies(use, bodies);
      const last = [...new Set(read.map((id) => bodies.find((b) => b.id === id)!.last))].sort(
        (a, b) => index.get(a)! - index.get(b)!,
      );
      body.set(f.id, last);
      for (const l of last) if (!deps.includes(l)) dependents.get(l)?.push(f.id);
      if (isBodyFeature(f) && !f.suppressed) {
        const acts = actsOn(f, use, read, bodies, lookup);
        const changed = bodies.filter((b) => acts.ids.includes(b.id));
        const merged = new Set(acts.merges ? changed.flatMap((b) => [...b.carries]) : []);
        for (const b of changed) {
          b.last = f.id;
          b.carries.add(f.id);
          for (const c of merged) b.carries.add(c);
        }
        const makes =
          ('operation' in f && f.operation === 'new') ||
          ((f.kind === 'pattern' || f.kind === 'mirror') &&
            f.features.some((id) => {
              const source = lookup(id);
              return source !== undefined && 'operation' in source && source.operation === 'new';
            }));
        if (makes) bodies.push({ id: f.id, carries: new Set([f.id]), last: f.id });
      }
    }
    vars.set(f.id, [...variableClosure(variables, directVariables(f))].sort());
  }
  for (const list of dependents.values()) list.sort((a, b) => index.get(a)! - index.get(b)!);
  return { active, rolledBack, byId, index, depends, body, variables: vars, dependents };
}

/**
 * A topological order of `nodes` under `deps` (node to the nodes it needs), stable: among nodes
 * whose dependencies are met, the one earliest in `nodes` comes first, so a list that is already
 * in dependency order comes back unchanged. Dependencies outside `nodes` are ignored. Throws on a
 * cycle, naming the nodes on it.
 */
export function topologicalOrder(
  nodes: readonly string[],
  deps: (node: string) => readonly string[],
): string[] {
  const position = new Map(nodes.map((n, i) => [n, i]));
  const waiting = new Map<string, number>();
  const users = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const n of nodes) {
    const ds = [...new Set(deps(n))].filter((d) => position.has(d) && d !== n);
    waiting.set(n, ds.length);
    for (const d of ds) users.get(d)!.push(n);
  }
  // A small binary heap on document position keeps the order stable.
  const ready: string[] = [];
  const push = (n: string) => {
    ready.push(n);
    let i = ready.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (position.get(ready[p]!)! <= position.get(ready[i]!)!) break;
      [ready[p], ready[i]] = [ready[i]!, ready[p]!];
      i = p;
    }
  };
  const pop = (): string => {
    const top = ready[0]!;
    const last = ready.pop()!;
    if (ready.length > 0) {
      ready[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < ready.length && position.get(ready[l]!)! < position.get(ready[m]!)!) m = l;
        if (r < ready.length && position.get(ready[r]!)! < position.get(ready[m]!)!) m = r;
        if (m === i) break;
        [ready[m], ready[i]] = [ready[i]!, ready[m]!];
        i = m;
      }
    }
    return top;
  };
  for (const n of nodes) if (waiting.get(n) === 0) push(n);
  const out: string[] = [];
  while (ready.length > 0) {
    const n = pop();
    out.push(n);
    for (const u of users.get(n)!) {
      const w = waiting.get(u)! - 1;
      waiting.set(u, w);
      if (w === 0) push(u);
    }
  }
  if (out.length < nodes.length) {
    const stuck = nodes.filter((n) => waiting.get(n)! > 0);
    throw new Error(`dependency cycle among ${stuck.join(', ')}`);
  }
  return out;
}

/** The graph's regen order: dependencies and body edges respected, document order otherwise. */
export function regenOrder(graph: DependencyGraph): string[] {
  return topologicalOrder(
    graph.active.map((f) => f.id),
    (id) => {
      const b = graph.body.get(id);
      return b ? [...graph.depends.get(id)!, ...b] : graph.depends.get(id)!;
    },
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

/** A feature's inputs: everything but its display name. */
export function sameInputs(a: Feature, b: Feature): boolean {
  if (a === b) return true;
  const { name: _a, ...ra } = a;
  const { name: _b, ...rb } = b;
  void _a;
  void _b;
  return deepEqual(ra, rb);
}

/** Variables whose value may differ between two variable tables (edited, added, removed, or reading one). */
export function changedVariables(
  previous: readonly Variable[],
  next: readonly Variable[],
): Set<string> {
  const p = new Map(previous.map((v) => [v.name, v]));
  const n = new Map(next.map((v) => [v.name, v]));
  const touched = new Set<string>();
  for (const v of next) {
    const old = p.get(v.name);
    if (!old || !deepEqual(old.expression, v.expression)) touched.add(v.name);
  }
  for (const v of previous) if (!n.has(v.name)) touched.add(v.name);
  // Close over readers: a variable reading a changed one changes too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of next) {
      if (touched.has(v.name)) continue;
      if (expressionVariableNames(v.expression).some((d) => touched.has(d))) {
        touched.add(v.name);
        grew = true;
      }
    }
  }
  return touched;
}

export interface DirtyOptions {
  /**
   * Core's `firstAffectedIndex` for this part (from the store's change event): features before
   * it are known clean and are not compared. `null` means nothing in the part changed.
   */
  firstAffectedIndex?: number | null;
}

/**
 * The features of `next` whose result may differ from the one built for `previous`, in document
 * order: the seeds (new or newly active features, changed inputs, different body edges,
 * a changed variable they read) and everything depending on a seed. Without a previous part,
 * every active feature is dirty.
 */
export function dirtyFeatures(
  previous: { part: Part; variables: readonly Variable[] } | null,
  next: { part: Part; variables: readonly Variable[] },
  options: DirtyOptions = {},
): string[] {
  const graph = buildGraph(next.part, next.variables);
  if (previous === null) return graph.active.map((f) => f.id);
  if (options.firstAffectedIndex === null) return [];
  const from = options.firstAffectedIndex ?? 0;
  const old = buildGraph(previous.part, previous.variables);
  const oldActive = new Map(old.active.map((f) => [f.id, f]));
  const vars = changedVariables(previous.variables, next.variables);

  const dirty = new Set<string>();
  const visit = (id: string) => {
    if (dirty.has(id)) return;
    dirty.add(id);
    for (const d of graph.dependents.get(id) ?? []) visit(d);
  };
  graph.active.forEach((f, i) => {
    if (i < from) return;
    const was = oldActive.get(f.id);
    const seed =
      !was ||
      !sameInputs(was, f) ||
      !deepEqual(graph.body.get(f.id) ?? null, old.body.get(f.id) ?? null) ||
      graph.variables.get(f.id)!.some((v) => vars.has(v));
    if (seed) visit(f.id);
  });
  return graph.active.filter((f) => dirty.has(f.id)).map((f) => f.id);
}

/** `dirtyFeatures` for one part of two documents. */
export function dirtyFeaturesOf(
  previous: ManufaktureDocument | null,
  next: ManufaktureDocument,
  partId: string,
  options: DirtyOptions = {},
): string[] {
  const part = next.parts.find((p) => p.id === partId);
  if (!part) return [];
  const old = previous?.parts.find((p) => p.id === partId);
  return dirtyFeatures(
    old ? { part: old, variables: previous!.variables } : null,
    { part, variables: next.variables },
    options,
  );
}
