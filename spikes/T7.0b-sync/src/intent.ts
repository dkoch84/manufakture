// The intent check: convergence and checkDocument cannot see a remap that binds a reference to
// the wrong item of the right kind (a mate connector naming another client's extrude#3 is
// valid to core, since core never reads connector names). So every generated item carries, in
// its name, an id-free signature of what it references:
//
//   <tag>><tags of the features it depends on>|<signatures of the sketch entities its face
//   names point at>
//
// A tag is permanent (`c2.17`: client 2, item 17). An entity's signature is its first
// coordinate, which the generator makes unique. At the end the signature is computed again from
// the converged document and compared: a difference is a misbinding (or, for an entity, a loss
// to a last-writer-wins edit of the sketch, reported apart).

import {
  featureDependencies,
  featureReferences,
  referenceNames,
  type Feature,
  type ManufaktureDocument,
  type Part,
} from '@manufakture/core';
import { bornSubIds, featureIdsOf } from './names.ts';

export function tagOf(name: string): string {
  const i = name.indexOf('>');
  return i < 0 ? name : name.slice(0, i);
}

export function expectedOf(name: string): string | undefined {
  const i = name.indexOf('>');
  return i < 0 ? undefined : name.slice(i + 1);
}

function featureTag(part: Part | undefined, id: string): string {
  const f = part?.features.find((x) => x.id === id);
  return f === undefined ? '?' : tagOf(f.name);
}

/** The signature of entity `sub` in the profile sketch of feature `fid` (an extrude). */
function entitySig(part: Part, fid: string, sub: string): string {
  const f = part.features.find((x) => x.id === fid);
  if (f === undefined) return '?';
  if (f.kind !== 'extrude' && f.kind !== 'revolve') return '-';
  const sketch = part.features.find((x) => x.id === f.profile.sketch);
  if (sketch?.kind !== 'sketch') return '?';
  const base = sub.replace(/#.*$/, '');
  const e = sketch.entities.find((x) => x.id === base);
  if (e === undefined) return '?';
  const p =
    e.kind === 'line'
      ? e.start
      : e.kind === 'circle' || e.kind === 'arc'
        ? e.center
        : e.kind === 'point'
          ? e.position
          : null;
  return p === null ? '-' : String(p[0]);
}

function nameSigs(part: Part, names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    for (const [fid, sub] of bornSubIds(n)) {
      if (sub.startsWith('e')) out.push(entitySig(part, fid, sub));
    }
  }
  return out.sort();
}

export function featureSignature(part: Part, feature: Feature): string {
  const deps = featureDependencies(feature)
    .map((id) => featureTag(part, id))
    .sort();
  const names = featureReferences(feature).flatMap(referenceNames);
  return `${deps.join(',')}|${nameSigs(part, names).join(',')}`;
}

/** Signature of face names and plain feature ids that live in one part (mates, CAM ops). */
export function namesSignature(part: Part | undefined, names: string[], ids: string[]): string {
  if (part === undefined) return '!';
  const tags = [...names.flatMap(featureIdsOf), ...ids].map((id) => featureTag(part, id)).sort();
  return `${tags.join(',')}|${nameSigs(part, names).join(',')}`;
}

/** Every face name in a JSON value (keys `face`, `faces`, `ends`). */
export function facesIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) facesIn(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'face' || k === 'faces' || k === 'ends') && typeof x === 'string') out.push(x);
      else if ((k === 'faces' || k === 'ends') && Array.isArray(x)) {
        for (const s of x) if (typeof s === 'string') out.push(s);
      } else facesIn(x, out);
    }
  }
  return out;
}

export interface IntentReport {
  checked: number;
  misbound: string[];
  lost: number;
}

/** Checks every tagged item of a converged document. */
export function checkIntent(doc: ManufaktureDocument): IntentReport {
  const report: IntentReport = { checked: 0, misbound: [], lost: 0 };
  const parts = new Map(doc.parts.map((p) => [p.id, p]));
  const judge = (what: string, name: string, actual: string) => {
    const expected = expectedOf(name);
    if (expected === undefined) return;
    report.checked++;
    if (expected === actual) return;
    // A '?' where a value was expected: the item is gone (deleted by another client where core
    // does not protect it, or lost to a whole-feature edit). Anything else is a misbinding.
    const e = expected.split(/[,|;]/);
    const a = actual.split(/[,|;]/);
    const left = [...e];
    const extra = a.filter((t) => {
      const i = left.indexOf(t);
      if (i < 0) return true;
      left.splice(i, 1);
      return false;
    });
    if (e.length === a.length && extra.every((t) => t === '?')) report.lost++;
    else report.misbound.push(`${what} "${name}": got "${actual}"`);
  };
  for (const p of doc.parts) {
    for (const f of p.features) judge(`${p.id}/${f.id}`, f.name, featureSignature(p, f));
  }
  for (const a of doc.assemblies) {
    for (const inst of a.instances) {
      const part = 'part' in inst.source ? parts.get(inst.source.part) : undefined;
      judge(`${a.id}/${inst.id}`, inst.name, part === undefined ? '!' : tagOf(part.name));
    }
    for (const m of a.mates) {
      const sig = [m.a, m.b]
        .map((c) => {
          const inst = a.instances.find((i) => i.id === c.instance);
          const part = inst && 'part' in inst.source ? parts.get(inst.source.part) : undefined;
          return namesSignature(part, facesIn(c.origin), []);
        })
        .join(';');
      judge(`${a.id}/${m.id}`, m.name, sig);
    }
  }
  for (const s of doc.cam.setups) {
    const part = parts.get(s.part);
    for (const op of s.operations) {
      const ids: string[] = [];
      for (const g of 'geometry' in op ? op.geometry : []) {
        if (g.kind === 'region') ids.push(g.sketch);
        if (g.kind === 'hole') ids.push(g.feature);
      }
      judge(`${s.id}/${op.id}`, op.name, namesSignature(part, facesIn(op), ids));
    }
  }
  for (const c of doc.configurations?.parameters ?? []) {
    if (c.kind === 'suppression') {
      judge(c.id, c.name, namesSignature(parts.get(c.partId), [], [c.featureId]));
    }
  }
  return report;
}
