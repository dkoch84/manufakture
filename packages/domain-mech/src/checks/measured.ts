// Measured geometry for the checks (ADR 0017 decision 15): bodies regen measured in the
// evaluation stage's first step, in SI. Regen measures in millimetres; everything here is metres
// (m³, m², m⁵), as `@manufakture/calc` takes it.

import { documentMaterial, type SubjectRef } from '@manufakture/core';
import type { EvaluationAnswer } from '@manufakture/regen';
import type { CheckInput, CheckModel } from './types';

type Vec3 = readonly [number, number, number];
type Matrix3 = readonly [Vec3, Vec3, Vec3];

/** One body, measured whole, in its part's coordinates, SI. */
export interface MeasuredBody {
  /** m³. */
  volume: number;
  /** m². */
  area: number;
  /** m; null for a body without volume. */
  centerOfMass: Vec3 | null;
  /** m⁵, at unit density about the centre of mass (times a density: kg·m²). */
  volumeInertia: Matrix3 | null;
}

export interface MeasuredGeometry {
  /** The body as measured, or undefined (then `problem` says why). */
  body(part: string, body: string): MeasuredBody | undefined;
  /** Why a body has no measurement: not asked for, not there, or the kernel could not measure. */
  problem(part: string, body: string): string | undefined;
}

const key = (part: string, body: string) => `${part}\n${body}`;

/** Nothing measured: what checks read outside regen (a test, an export with no kernel). */
export const NOTHING_MEASURED: MeasuredGeometry = {
  body: () => undefined,
  problem: () => 'not measured',
};

/** Measured geometry from the answers to the evaluation stage's queries. */
export function measuredFrom(answers: readonly EvaluationAnswer[]): MeasuredGeometry {
  const bodies = new Map<string, MeasuredBody>();
  const problems = new Map<string, string>();
  for (const a of answers) {
    const k = key(a.part, a.body);
    const m = a.measure;
    if (m === null) {
      problems.set(k, a.message ?? 'the kernel could not measure it');
      continue;
    }
    const mm = 1e-3;
    bodies.set(k, {
      volume: m.volume * mm ** 3,
      area: m.area * mm ** 2,
      centerOfMass:
        m.centerOfMass === null ? null : (m.centerOfMass.map((v) => v * mm) as unknown as Vec3),
      volumeInertia:
        m.volumeInertia === null
          ? null
          : (m.volumeInertia.map((row) => row.map((v) => v * mm ** 5)) as unknown as Matrix3),
    });
  }
  return {
    body: (part, body) => bodies.get(key(part, body)),
    problem: (part, body) =>
      bodies.has(key(part, body)) ? undefined : (problems.get(key(part, body)) ?? 'not measured'),
  };
}

/**
 * The mass of one body as a check input: its measured volume times its material's density (the
 * body's own material, else its part's). Missing, with the reason, when either is not there.
 */
export function measuredMassInput(model: CheckModel, part: string, body: string): CheckInput {
  const subject: SubjectRef = { kind: 'body', part, body } as SubjectRef;
  const input: CheckInput = {
    name: `Mass of ${part} ${body}`,
    value: undefined,
    source: `measured volume of ${part} ${body} times its material's density`,
    ref: { kind: 'measured', what: 'mass', subject },
    kind: 'mass',
  };
  const doc = model.document;
  const p = doc.parts.find((x) => x.id === part);
  const materialId = p?.bodies?.find((b) => b.id === body)?.material ?? p?.material;
  const material = materialId === undefined ? undefined : documentMaterial(doc, materialId);
  const measured = model.measured.body(part, body);
  if (measured === undefined) {
    input.missing = `${part} ${body} is not measured: ${model.measured.problem(part, body)}`;
  } else if (material === undefined) {
    input.missing = `${part} ${body} has no material`;
  } else {
    input.value = measured.volume * material.density;
    input.source = `measured volume of ${part} ${body} times the density of ${material.name}`;
  }
  return input;
}
