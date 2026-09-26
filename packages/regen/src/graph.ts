// The dependency graph of a part, and the dirty subgraph of an edit.
//
// Edges run from a feature to what it needs:
//
// - features it names by id or by face name (core's `featureDependencies`: profiles, hole
//   sketches, pattern and mirror sources, `dependsOn`, and every feature whose id starts a face
//   name in one of its references);
// - the body before it: every kernel feature takes the body the previous kernel feature left,
//   and a sketch on a face resolves that face on it. This is the `body` edge;
// - the variables its expressions read, directly or through other variables.
//
// A feature whose own inputs changed is a seed; the dirty subgraph is the seeds plus everything
// that depends on them, through any edge. A variable edit therefore dirties only the features
// that read it (and what depends on those), not everything after the first of them.

import {
  expressionVariableNames,
  featureDependencies,
  featureExpressions,
  type Feature,
  type ManufaktureDocument,
  type Part,
  type Variable,
} from '@manufakture/core';

/** Features the kernel builds: each takes the body before it and gives the body after it. */
export const BODY_KINDS: ReadonlySet<Feature['kind']> = new Set([
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'pattern',
  'mirror',
]);

export function isBodyFeature(feature: Feature): boolean {
  return BODY_KINDS.has(feature.kind);
}

/** Whether a feature needs the body before it: kernel features, and sketches placed on a face. */
export function readsBody(feature: Feature): boolean {
  return isBodyFeature(feature) || (feature.kind === 'sketch' && feature.plane.type === 'face');
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
   * For features that read the body: the kernel feature that made it (the last active,
   * unsuppressed kernel feature before them), or null when there is none yet.
   */
  readonly body: ReadonlyMap<string, string | null>;
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

export function buildGraph(part: Part, variables: readonly Variable[]): DependencyGraph {
  const bar = part.rollbackIndex ?? part.features.length;
  const active = part.features.slice(0, bar);
  const rolledBack = part.features.slice(bar);
  const byId = new Map(part.features.map((f) => [f.id, f]));
  const index = new Map(part.features.map((f, i) => [f.id, i]));
  const depends = new Map<string, string[]>();
  const body = new Map<string, string | null>();
  const vars = new Map<string, string[]>();
  const dependents = new Map<string, string[]>(active.map((f) => [f.id, []]));

  let lastBody: string | null = null;
  for (const f of active) {
    const deps = featureDependencies(f).filter((d) => byId.has(d));
    depends.set(f.id, deps);
    for (const d of deps) dependents.get(d)?.push(f.id);
    if (readsBody(f)) {
      body.set(f.id, lastBody);
      if (lastBody !== null && !deps.includes(lastBody)) dependents.get(lastBody)?.push(f.id);
    }
    vars.set(f.id, [...variableClosure(variables, directVariables(f))].sort());
    if (isBodyFeature(f) && !f.suppressed) lastBody = f.id;
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
      return b ? [...graph.depends.get(id)!, b] : graph.depends.get(id)!;
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
 * order: the seeds (new or newly active features, changed inputs, a different body before them,
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
      (graph.body.get(f.id) ?? null) !== (old.body.get(f.id) ?? null) ||
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
