// Measured variables (#1202): `distance("face", "face")` and `angle("face", "face")` in a
// variable's expression, answered from the part's geometry at regen.
//
// What is measured: the part built from every feature that does not depend on a measured
// variable still unknown (`featuresReading` of `graph.ts`), so the features reading the variable
// come after the measurement, and so does everything depending on them. Measured variables are
// resolved in rounds: one may measure faces made by features reading another, which is measured
// first. A variable measuring faces of a feature that reads it, directly or through other
// variables or features, is a cycle: its measurement is an error naming the variable, the face
// and the feature, never a stale value. So is a face that is not found (lost after an edit): the
// variable, every variable reading it and every feature reading those fail with it, rather than
// keep the last value.
//
// Which part: a face written `part#2/<face>` is on that part; otherwise on the part whose features
// include every feature its name starts with (`featureIdsInName`), which must be one. Both faces
// of a call are on one part (there is no common placement between two parts outside an
// assembly). Which body: whichever body of that part carries the face; the two may be different
// bodies (#1206).
//
// This module is the part of it that needs no kernel: the calls, their parts and the cycle check.
// The engine builds and measures.

import {
  featureIdsInName,
  measuredVariables,
  measurementKey,
  splitMeasuredFace,
  type ManufaktureDocument,
  type MeasuredFace,
  type Measurement,
  type Part,
  type Variable,
} from '@manufakture/core';
import type { MeasureFunction } from '@manufakture/units';
import { buildGraph, featuresReading, variableReaders, type DependencyGraph } from './graph';

/** One distinct `distance(...)` or `angle(...)` call of the variables table. */
export interface MeasuredCall {
  key: string;
  fn: MeasureFunction;
  /** As written between the quotes. */
  written: [string, string];
  faces: [MeasuredFace, MeasuredFace];
  /** The variables whose own expressions make this call, in table order. */
  variables: string[];
}

/** Every distinct call of the variables table, in table order (first use). */
export function measuredCalls(variables: readonly Variable[]): MeasuredCall[] {
  const out = new Map<string, MeasuredCall>();
  for (const { name, calls } of measuredVariables(variables)) {
    for (const c of calls) {
      const written: [string, string] = [c.faces[0]!.name, c.faces[1]!.name];
      const key = measurementKey(c.fn, written);
      const known = out.get(key);
      if (known !== undefined) {
        if (!known.variables.includes(name)) known.variables.push(name);
        continue;
      }
      out.set(key, {
        key,
        fn: c.fn,
        written,
        faces: [splitMeasuredFace(written[0]), splitMeasuredFace(written[1])],
        variables: [name],
      });
    }
  }
  return [...out.values()];
}

/** A failed measurement of `call`, with `message`. */
export function failedMeasurement(
  call: MeasuredCall,
  partId: string | null,
  message: string,
): Measurement {
  return { fn: call.fn, faces: call.written, partId, value: null, error: message };
}

/** `#a`, or `#a and #b`, for messages. */
export function variableList(names: readonly string[]): string {
  const hashed = names.map((n) => `#${n}`);
  return hashed.length <= 1
    ? (hashed[0] ?? '')
    : `${hashed.slice(0, -1).join(', ')} and ${hashed[hashed.length - 1]}`;
}

function hasFeatures(part: Part, ids: readonly string[]): boolean {
  return ids.every((id) => part.features.some((f) => f.id === id));
}

/** The part a face is on, or why it cannot be told. */
function facePart(
  document: ManufaktureDocument,
  face: MeasuredFace,
  written: string,
): { ok: true; part: Part } | { ok: false; message: string } {
  const ids = featureIdsInName(face.face);
  if (ids.length === 0) {
    return {
      ok: false,
      message: `"${written}" is not a face name: a face name starts with the feature that made it, like "extrude#1:cap:end"`,
    };
  }
  if (face.partId !== undefined) {
    const part = document.parts.find((p) => p.id === face.partId);
    if (part === undefined) return { ok: false, message: `There is no part ${face.partId}` };
    if (!hasFeatures(part, ids)) {
      const missing = ids.filter((id) => !part.features.some((f) => f.id === id));
      return {
        ok: false,
        message: `Face "${face.face}" is not found on ${part.id}: it has no ${missing.join(' or ')}`,
      };
    }
    return { ok: true, part };
  }
  // The part that has the feature the face starts with; its other features must be there too.
  const owners = document.parts.filter((p) => hasFeatures(p, [ids[0]!]));
  if (owners.length === 0) {
    return { ok: false, message: `Face "${face.face}" is not found: no part has ${ids[0]}` };
  }
  const parts = owners.length === 1 ? owners : owners.filter((p) => hasFeatures(p, ids));
  if (parts.length !== 1) {
    const ps = (parts.length === 0 ? owners : parts).map((p) => p.id);
    return {
      ok: false,
      message: `Face "${face.face}" could be on ${ps.join(' or ')}: write the part before it, as "${ps[0]}/${face.face}"`,
    };
  }
  const missing = ids.filter((id) => !parts[0]!.features.some((f) => f.id === id));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Face "${face.face}" is not found on ${parts[0]!.id}: it has no ${missing.join(' or ')}`,
    };
  }
  return { ok: true, part: parts[0]! };
}

/** The part both faces of `call` are on, or why there is none. */
export function callPart(
  document: ManufaktureDocument,
  call: MeasuredCall,
): { ok: true; part: Part } | { ok: false; message: string } {
  const a = facePart(document, call.faces[0], call.written[0]);
  if (!a.ok) return a;
  const b = facePart(document, call.faces[1], call.written[1]);
  if (!b.ok) return b;
  if (a.part.id !== b.part.id) {
    return {
      ok: false,
      message: `${call.fn}() measures within one part: "${call.faces[0].face}" is on ${a.part.id} and "${call.faces[1].face}" on ${b.part.id}`,
    };
  }
  return a;
}

/** The features of the part whose faces `call` names (the first feature id of each name's parts). */
export function callOwners(call: MeasuredCall): string[] {
  return [...new Set(call.faces.flatMap((f) => featureIdsInName(f.face)))];
}

/**
 * Why each of `waiting` cannot be measured, when no order measures any of them: each measures
 * faces made by features reading another waiting variable. A variable waits on another when one
 * of its calls names a face of a feature reading it. A call of a variable on a loop of such waits
 * says the loop's variables read one another; one that only waits on a loop says which variables
 * it waits on.
 */
export function stuckMessages(
  document: ManufaktureDocument,
  waiting: readonly MeasuredCall[],
  parts: ReadonlyMap<string, Part>,
): Map<string, string> {
  const names = [...new Set(waiting.flatMap((c) => c.variables))];
  const graphs = new Map<Part, DependencyGraph>();
  const graphOf = (part: Part) => {
    let g = graphs.get(part);
    if (g === undefined) graphs.set(part, (g = buildGraph(part, document.variables)));
    return g;
  };
  // Variable -> the waiting variables it waits on.
  const needs = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const c of waiting) {
    const part = parts.get(c.key);
    if (part === undefined) continue;
    const graph = graphOf(part);
    for (const w of names) {
      const reading = featuresReading(graph, variableReaders(document.variables, [w]));
      if (!callOwners(c).some((id) => reading.has(id))) continue;
      for (const v of c.variables) needs.get(v)!.add(w);
    }
  }
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(needs.get(from) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(needs.get(n) ?? []));
    }
    return seen;
  };
  const reached = new Map(names.map((n) => [n, reach(n)]));
  const out = new Map<string, string>();
  for (const c of waiting) {
    const looping = c.variables.find((v) => reached.get(v)!.has(v));
    if (looping !== undefined) {
      const loop = names.filter(
        (n) => n === looping || (reached.get(looping)!.has(n) && reached.get(n)!.has(looping)),
      );
      out.set(
        c.key,
        `${variableList(loop)} measure faces made by features that read one another: no order measures them`,
      );
      continue;
    }
    const on = names.filter((n) => c.variables.some((v) => needs.get(v)!.has(n)));
    out.set(
      c.key,
      `${variableList(c.variables)} waits on ${variableList(on)}, which cannot be measured: measured variables there read one another`,
    );
  }
  return out;
}
