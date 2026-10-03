// Which domains a sheet shows (M6 plan T6.4a): a domain's title note (the construction
// disclaimer) goes on every sheet that shows that domain's work, however it is shown. That is
// the namespace of each domain view on the sheet, and the namespace of every extension feature of
// every part a view shows: directly, as an assembly's instance, or through a derived feature or a
// pinned instance (a part of another document, carried inside this one as its JSON text).
//
// Assemblies do not nest (an instance shows a part), so the traversal follows parts, derived
// sources and pinned instances only. It is bounded: each assembly is read once, through a map
// built once; each (pinned document, part) is visited once, breadth first so at its least depth;
// each pinned document's text is parsed once, and pins are followed at most `MAX_DERIVED_DEPTH`
// deep, the depth regen builds derived parts to. The pinned text is untrusted: anything that is
// not the expected shape is skipped.

import {
  MAX_DERIVED_DEPTH,
  isDomainViewSource,
  type ManufaktureDocument,
  type ViewSource,
} from '@manufakture/core';
import { extensionNamespace } from './extensions';

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** The namespaces a sheet showing `sources` of `document` shows, sorted. */
export function shownNamespaces(
  document: ManufaktureDocument,
  sources: readonly ViewSource[],
  maxDepth = MAX_DERIVED_DEPTH,
): string[] {
  const namespaces = new Set<string>();
  const parsed = new Map<string, Obj | null>();
  const visited = new Set<string>();
  // Parts to read: in which document (`''` this one, else a pin's sha256), how deep.
  const queue: { doc: Obj; key: string; part: string; depth: number }[] = [];
  const root = document as unknown as Obj;

  const push = (doc: Obj, key: string, part: unknown, depth: number) => {
    if (typeof part !== 'string') return;
    const id = `${key}\n${part}`;
    if (visited.has(id)) return;
    visited.add(id);
    queue.push({ doc, key, part, depth });
  };
  /** A pinned source's document, parsed once per sha256; null when it does not parse. */
  const pinned = (source: Obj): { doc: Obj; key: string } | null => {
    const sha = source.sha256;
    const data = source.data;
    if (typeof sha !== 'string' || typeof data !== 'string') return null;
    let doc = parsed.get(sha);
    if (doc === undefined) {
      try {
        const v: unknown = JSON.parse(data);
        doc = isObj(v) ? v : null;
      } catch {
        doc = null;
      }
      parsed.set(sha, doc);
    }
    return doc === null ? null : { doc, key: sha };
  };
  const follow = (source: unknown, depth: number) => {
    if (!isObj(source) || depth >= maxDepth) return;
    const pin = pinned(source);
    if (pin !== null) push(pin.doc, pin.key, source.partId, depth + 1);
  };
  // This document's assemblies by id, built once; each assembly is read once however many
  // views show it.
  const assemblies = new Map<string, Obj>();
  for (const a of list(root.assemblies))
    if (isObj(a) && typeof a.id === 'string' && !assemblies.has(a.id)) assemblies.set(a.id, a);
  const seenAssemblies = new Set<string>();
  // Pinned instances are depth 1: queued after every depth-0 part of every view.
  const pinnedInstances: Obj[] = [];
  const assembly = (id: string) => {
    if (seenAssemblies.has(id)) return;
    seenAssemblies.add(id);
    const a = assemblies.get(id);
    if (a === undefined) return;
    for (const i of list(a.instances)) {
      if (!isObj(i) || !isObj(i.source)) continue;
      if (typeof i.source.part === 'string') push(root, '', i.source.part, 0);
      else pinnedInstances.push(i.source);
    }
  };

  for (const v of sources) {
    if (isDomainViewSource(v)) {
      namespaces.add(v.domain);
      push(root, '', v.part, 0);
    } else if ('part' in v) push(root, '', v.part, 0);
    else assembly(v.assembly);
  }
  for (const source of pinnedInstances) follow(source, 0);
  // Parts by id, per document, so each lookup is one map read.
  const byId = new Map<string, Map<string, Obj>>();
  const partOf = (doc: Obj, key: string, id: string): Obj | undefined => {
    let parts = byId.get(key);
    if (parts === undefined) {
      parts = new Map();
      for (const p of list(doc.parts)) if (isObj(p) && typeof p.id === 'string') parts.set(p.id, p);
      byId.set(key, parts);
    }
    return parts.get(id);
  };
  // First in, first out: every edge adds one level, so a part is first reached (and marked
  // visited) at its smallest depth, and a longer path can never lock it out at a deeper one.
  for (let head = 0; head < queue.length; head++) {
    const { doc, key, part, depth } = queue[head]!;
    const p = partOf(doc, key, part);
    if (p === undefined) continue;
    for (const f of list(p.features)) {
      if (!isObj(f)) continue;
      if (f.kind === 'extension' && typeof f.extension === 'string')
        namespaces.add(extensionNamespace(f.extension));
      else if (f.kind === 'derived') follow(f.source, depth);
    }
  }
  return [...namespaces].sort();
}
