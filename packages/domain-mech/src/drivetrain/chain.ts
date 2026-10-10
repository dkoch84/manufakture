// The drivetrain as a chain (ADR 0017 decision 9, task T9.3a): one degree of freedom from the motor
// to the output, through belts, gears, planetaries, shafts and couplings. This file reads a stored
// `Drivetrain` into numbers: each reduction's ratio and efficiency, the speed of every element
// relative to the motor, and every element's moment of inertia with where it came from, then the
// inertia reflected to the motor and to the output. The records that state those numbers are in
// ./records; the torque through the chain in ./torque.
//
// Conventions:
// - A ratio is input speed over output speed (a 5:1 reduction is 5), so a stage's tooth counts
//   give driven / driver. `n` is the motor's speed over an element's speed: 1 at the motor, the
//   product of the ratios between the motor and the element further down.
// - Inertia comes from, in order: a typed value on the stage (it wins: the user typed it on
//   purpose), the catalog's `rotorInertia` for the motor, or the kernel's mass properties of the
//   named instance's bodies (T9.1c). A motor's instance is never measured: its housing is not its
//   rotor. A reduction's typed inertia is referred to its input, as gearbox datasheets give it; a
//   gear or planetary stage's instances are measured with the first at the input speed and the
//   others at the output speed (the order of `{ driver, driven }`). A belt's inertia is typed or
//   not counted. An element with no source at all counts as zero and the records say so; an
//   element whose source cannot give a value (a missing instance, an unmeasured body, a catalog
//   entry with no rotor inertia) makes the records that need it `unknown`, naming why.
// - Instances of parts from another document (and so nested sub-assemblies) are not measured,
//   like the session's assembly mass: their inertia must be typed.

import {
  documentMaterial,
  mechItems,
  type Assembly,
  type CatalogRef,
  type Drivetrain,
  type Instance,
  type ManufaktureDocument,
  type Stage,
  type StoredExpression,
  type SubjectRef,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { NOTHING_MEASURED, type MeasuredGeometry } from '../checks/measured';
import type { InputRef } from '../checks/types';
import { refText, resolveEntry } from '../parts/catalog';
import { siValue } from '../requirements/values';
import { combineBodies, principalMoments, spinMoment, type BodyMass } from './inertia';

export type StageKind = Stage['kind'];
export type OutputKind = Drivetrain['output']['kind'];

/** The stage kinds that change speed. */
export const REDUCTION_KINDS: readonly StageKind[] = ['belt', 'gear', 'planetary'];

/** What each stage kind is, for people. */
export const STAGE_KIND_TEXT: Readonly<Record<StageKind, string>> = {
  motor: 'Motor',
  belt: 'Belt',
  gear: 'Gear pair',
  planetary: 'Planetary',
  shaft: 'Shaft',
  coupling: 'Coupling',
};

export const OUTPUT_KIND_TEXT: Readonly<Record<OutputKind, string>> = {
  spool: 'Spool',
  rotary: 'Rotary output',
  linear: 'Linear output (screw)',
};

/** What is wrong with a drivetrain, by its path from the drivetrain. */
export interface DrivetrainProblem {
  path: readonly (string | number)[];
  message: string;
  /**
   * `reference`: it names an instance, mate, use or body that is not there (regen's
   * `mech-reference` warning); `value`: an expression that does not read or is out of range;
   * `structure`: the chain itself (no motor first, a mate that is not revolute).
   */
  kind: 'reference' | 'value' | 'structure';
  /** For a reference: the id that is missing. */
  target?: string;
}

export type InertiaSource = 'typed' | 'catalog' | 'measured' | 'none';

/** One turning element of the chain: a rotor, a pulley set, a shaft, a spool. */
export interface InertiaElement {
  /** The stage id, or `output`. */
  at: string;
  /** For people: "Rotor of Drive motor (stage#1)". */
  name: string;
  /** kg·m², about its own axis; absent when `none` or missing. */
  value?: number;
  source: InertiaSource;
  /** Where the value came from, in words. */
  from: string;
  /** Why a source that should give a value gives none. */
  missing?: string;
  /** The motor's speed over this element's: absent when a ratio before it does not read. */
  n?: number;
  /** The product of the efficiencies of the reductions between the motor and this element. */
  efficiencyBefore?: number;
  /** Stated in the records that use it (the axis of a measured element). */
  assumption?: string;
  ref: InputRef;
}

/** One stage as read. */
export interface StageResult {
  id: string;
  kind: StageKind;
  /** For people: "Belt (stage#2)". */
  name: string;
  /** Reductions only: input speed over output speed. */
  ratio?: number;
  /** Reductions only, 0 to 1. */
  efficiency?: number;
  /** How the ratio was given, for the records: "60 / 20 teeth", "5". */
  ratioText?: string;
  /** The motor's speed over the stage's input and output speeds. */
  nIn?: number;
  nOut?: number;
}

/** A drivetrain read into numbers. Plain JSON (it crosses regen's worker boundary). */
export interface DrivetrainChain {
  id: string;
  name: string;
  assembly?: string;
  stages: StageResult[];
  output: { kind: OutputKind; name: string; n?: number };
  /** Every turning element, from the motor to the output. */
  elements: InertiaElement[];
  /** The reductions' product; 1 with none; absent when one does not read. */
  ratio?: number;
  efficiency?: number;
  problems: DrivetrainProblem[];
}

/** What a chain is read from. */
export interface DrivetrainContext {
  document: ManufaktureDocument;
  variables: VariableLookup;
  /** What regen measured; outside regen nothing is. */
  measured?: MeasuredGeometry;
  /** A part's final body ids as regen built them; undefined when not known. */
  partBodies?: (part: string) => readonly string[] | undefined;
}

/** How an element's inertia will be found, before anything is measured. */
type Plan =
  | { kind: 'typed'; expr: StoredExpression; path: readonly (string | number)[] }
  | { kind: 'catalog'; use: string; path: readonly (string | number)[] }
  | { kind: 'measured'; instance: string; body?: string; path: readonly (string | number)[] }
  | { kind: 'none'; why: string };

interface PlannedElement {
  at: string;
  name: string;
  plan: Plan;
  /** At the speed of its stage's input or output (a reduction's two sides differ). */
  side: 'in' | 'out';
  stageIndex: number;
}

function stageName(s: Stage, doc: ManufaktureDocument): string {
  if (s.kind === 'motor') {
    const use = mechItems(doc.mech, 'purchased').find((p) => p.id === s.use);
    return `${use?.name ?? 'Motor'} (${s.id})`;
  }
  return `${STAGE_KIND_TEXT[s.kind]} (${s.id})`;
}

/** The elements of a drivetrain and how each one's inertia is found. */
function planElements(d: Drivetrain, doc: ManufaktureDocument): PlannedElement[] {
  const out: PlannedElement[] = [];
  const typed = (
    expr: StoredExpression | undefined,
    path: readonly (string | number)[],
  ): Plan | undefined => (expr === undefined ? undefined : { kind: 'typed', expr, path });
  d.stages.forEach((s, i) => {
    const name = stageName(s, doc);
    const at = s.id;
    const p = (...rest: (string | number)[]) => ['stages', i, ...rest];
    switch (s.kind) {
      case 'motor':
        out.push({
          at,
          name: `Rotor of ${name}`,
          plan: typed(s.inertia, p('inertia')) ?? { kind: 'catalog', use: s.use, path: p('use') },
          side: 'in',
          stageIndex: i,
        });
        break;
      case 'belt':
        out.push({
          at,
          name: `${name}, pulleys and belt, referred to its input`,
          plan: typed(s.inertia, p('inertia')) ?? {
            kind: 'none',
            why: 'no inertia typed for the belt and its pulleys',
          },
          side: 'in',
          stageIndex: i,
        });
        break;
      case 'gear':
      case 'planetary': {
        const t = typed(s.inertia, p('inertia'));
        if (t !== undefined || (s.instances ?? []).length === 0) {
          out.push({
            at,
            name: `${name}, referred to its input`,
            plan: t ?? { kind: 'none', why: 'no inertia typed and no instances named' },
            side: 'in',
            stageIndex: i,
          });
          break;
        }
        s.instances!.forEach((inst, k) => {
          // A member fixed in the assembly (a planetary's ring) does not turn: not counted.
          const fixed = findInstance(doc, d, inst)?.fixed === true;
          out.push({
            at,
            name: `${name}, ${k === 0 ? 'input' : 'output'} member ${inst}`,
            plan: fixed
              ? { kind: 'none', why: `${inst} is fixed in the assembly, so it does not turn` }
              : { kind: 'measured', instance: inst, path: p('instances', k) },
            side: k === 0 ? 'in' : 'out',
            stageIndex: i,
          });
        });
        break;
      }
      case 'shaft':
      case 'coupling':
        out.push({
          at,
          name,
          plan:
            typed(s.inertia, p('inertia')) ??
            (s.instance !== undefined
              ? { kind: 'measured', instance: s.instance, path: p('instance') }
              : { kind: 'none', why: 'no inertia typed and no instance named' }),
          side: 'in',
          stageIndex: i,
        });
        break;
    }
  });
  const o = d.output;
  if (o.kind === 'linear') {
    out.push({
      at: 'output',
      name: `${OUTPUT_KIND_TEXT.linear} and the load it carries (output)`,
      plan: {
        kind: 'none',
        why: 'the screw’s inertia and the mass it carries are not modelled for a linear output',
      },
      side: 'out',
      stageIndex: d.stages.length,
    });
  } else {
    out.push({
      at: 'output',
      name: `${OUTPUT_KIND_TEXT[o.kind]} (output)`,
      plan:
        typed(o.inertia, ['output', 'inertia']) ??
        (o.instance !== undefined
          ? {
              kind: 'measured',
              instance: o.instance,
              ...(o.kind === 'spool' && o.body !== undefined ? { body: o.body } : {}),
              path: ['output', 'instance'],
            }
          : { kind: 'none', why: 'no inertia typed and no instance named' }),
      side: 'out',
      stageIndex: d.stages.length,
    });
  }
  return out;
}

function assemblyOf(doc: ManufaktureDocument, d: Drivetrain): Assembly | undefined {
  return d.assembly === undefined ? undefined : doc.assemblies?.find((a) => a.id === d.assembly);
}

function findInstance(doc: ManufaktureDocument, d: Drivetrain, id: string): Instance | undefined {
  return assemblyOf(doc, d)?.instances.find((i) => i.id === id);
}

/** The bodies of an instance to measure, or why there are none. */
function instanceBodies(
  ctx: DrivetrainContext,
  inst: Instance,
  body: string | undefined,
): { ok: true; part: string; bodies: readonly string[] } | { ok: false; message: string } {
  if (!('part' in inst.source)) {
    return {
      ok: false,
      message: `${inst.name} (${inst.id}) shows a part of another document, which is not measured: type its inertia`,
    };
  }
  if (inst.suppressed) return { ok: false, message: `${inst.name} (${inst.id}) is suppressed` };
  const part = inst.source.part;
  if (body !== undefined) return { ok: true, part, bodies: [body] };
  const bodies = inst.bodies ?? ctx.partBodies?.(part);
  if (bodies === undefined) {
    return {
      ok: false,
      message: `the bodies of ${part} are not known: it has not regenerated, or it did not build`,
    };
  }
  if (bodies.length === 0) return { ok: false, message: `${part} has no bodies` };
  return { ok: true, part, bodies };
}

/** The bodies regen must measure for every drivetrain of the document. */
export function drivetrainNeeds(
  doc: ManufaktureDocument,
  partBodies: (part: string) => readonly string[] | undefined,
): { part: string; body: string }[] {
  const out: { part: string; body: string }[] = [];
  const seen = new Set<string>();
  for (const d of mechItems(doc.mech, 'drivetrains')) {
    for (const e of planElements(d, doc)) {
      if (e.plan.kind !== 'measured') continue;
      const inst = findInstance(doc, d, e.plan.instance);
      if (inst === undefined) continue;
      const b = instanceBodies(
        { document: doc, variables: () => undefined, partBodies },
        inst,
        e.plan.body,
      );
      if (!b.ok) continue;
      for (const body of b.bodies) {
        const k = `${b.part}\n${body}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ part: b.part, body });
      }
    }
  }
  return out;
}

/** A measured element's inertia about its spin axis. */
function measureInstance(
  ctx: DrivetrainContext,
  d: Drivetrain,
  inst: Instance,
  body: string | undefined,
  name: string,
): Pick<InertiaElement, 'value' | 'from' | 'missing' | 'assumption'> {
  const b = instanceBodies(ctx, inst, body);
  const from = `measured: ${inst.name} (${inst.id}) in ${d.assembly}`;
  if (!b.ok) return { from, missing: b.message };
  const doc = ctx.document;
  const measured = ctx.measured ?? NOTHING_MEASURED;
  const p = doc.parts.find((x) => x.id === b.part);
  const masses: BodyMass[] = [];
  const materials = new Set<string>();
  for (const id of b.bodies) {
    const m = measured.body(b.part, id);
    if (m === undefined) {
      return { from, missing: `${b.part} ${id} is not measured: ${measured.problem(b.part, id)}` };
    }
    if (m.centerOfMass === null || m.volumeInertia === null) {
      return { from, missing: `${b.part} ${id} has no volume` };
    }
    const materialId = p?.bodies?.find((x) => x.id === id)?.material ?? p?.material;
    const material = materialId === undefined ? undefined : documentMaterial(doc, materialId);
    if (material === undefined) return { from, missing: `${b.part} ${id} has no material` };
    materials.add(material.name);
    const rho = material.density;
    masses.push({
      mass: m.volume * rho,
      centerOfMass: m.centerOfMass,
      inertia: m.volumeInertia.map((row) =>
        row.map((v) => v * rho),
      ) as unknown as BodyMass['inertia'],
    });
  }
  const total = combineBodies(masses);
  if (total === null) return { from, missing: `${inst.name} (${inst.id}) has no mass` };
  const moments = principalMoments(total.inertia);
  const value = spinMoment(moments);
  const [l1, l2, l3] = moments;
  const agree = (a: number, b: number) => Math.abs(a - b) <= SYMMETRY_TOLERANCE * Math.max(a, b);
  const guess =
    agree(l1, l2) || agree(l2, l3)
      ? ''
      : `; no two principal moments agree within ${SYMMETRY_TOLERANCE * 100} %, so the part has no clear axis of symmetry and this axis is a guess: type its inertia about the real axis`;
  return {
    value,
    from: `measured: ${b.bodies.join(', ')} of ${b.part}, shown by ${inst.name} (${inst.id}), times the density of ${[...materials].join(' and ')}`,
    assumption: `${name} turns about its axis of symmetry through its centre of mass, taken as the principal axis whose moment differs most from the other two (principal moments ${moments.map((v) => Number(v.toPrecision(4))).join(', ')} kg·m^2)${guess}`,
  };
}

/** Two principal moments within this fraction of the larger agree (an axis of symmetry). */
export const SYMMETRY_TOLERANCE = 0.05;

const RANGE_RATIO = { above: 0, what: 'the ratio' };
const RANGE_TEETH = { min: 1, integer: true, what: 'a tooth count' };
const RANGE_EFFICIENCY = { above: 0, max: 1, what: 'the efficiency' };

/** Read one expression as a number in SI, with a range; a problem when it does not read. */
function read(
  ctx: DrivetrainContext,
  problems: DrivetrainProblem[],
  path: readonly (string | number)[],
  expr: StoredExpression,
  kind: 'number' | 'inertia',
  range: { min?: number; above?: number; max?: number; integer?: boolean; what?: string },
): number | undefined {
  const r = siValue(expr, kind, ctx.variables);
  const what = range.what ?? 'it';
  const refuse = (message: string) => {
    problems.push({ path, message, kind: 'value' });
    return undefined;
  };
  if (!r.ok) return refuse(r.message);
  const v = r.value;
  if (range.integer === true && !Number.isInteger(v))
    return refuse(`${what} must be a whole number`);
  if (range.above !== undefined && !(v > range.above))
    return refuse(`${what} must be above ${range.above}`);
  if (range.min !== undefined && v < range.min)
    return refuse(`${what} must be at least ${range.min}`);
  if (range.max !== undefined && v > range.max)
    return refuse(`${what} must be at most ${range.max}`);
  return v;
}

/** Problems with what the drivetrain names: the assembly, instances, mates, uses, the body. */
function referenceProblems(ctx: DrivetrainContext, d: Drivetrain): DrivetrainProblem[] {
  const doc = ctx.document;
  const out: DrivetrainProblem[] = [];
  const assembly = assemblyOf(doc, d);
  if (d.assembly !== undefined && assembly === undefined) {
    out.push({
      path: ['assembly'],
      message: `there is no assembly ${d.assembly}`,
      kind: 'reference',
      target: d.assembly,
    });
  }
  const instance = (path: readonly (string | number)[], id: string | undefined) => {
    if (id === undefined) return;
    if (d.assembly === undefined) {
      out.push({
        path,
        message: `names instance ${id}, but the drivetrain names no assembly`,
        kind: 'reference',
        target: id,
      });
    } else if (assembly !== undefined && !assembly.instances.some((i) => i.id === id)) {
      out.push({
        path,
        message: `names instance ${id}, which ${assembly.name} does not have`,
        kind: 'reference',
        target: id,
      });
    }
  };
  const uses = mechItems(doc.mech, 'purchased');
  const use = (path: readonly (string | number)[], id: string | undefined) => {
    if (id !== undefined && !uses.some((u) => u.id === id)) {
      out.push({
        path,
        message: `names purchased part ${id}, which the design does not have`,
        kind: 'reference',
        target: id,
      });
    }
  };
  if (d.stages.length === 0) {
    out.push({ path: ['stages'], message: 'the chain starts at a motor stage', kind: 'structure' });
  }
  d.stages.forEach((s, i) => {
    const p = (...rest: (string | number)[]) => ['stages', i, ...rest];
    if (i === 0 && s.kind !== 'motor') {
      out.push({
        path: p(),
        message: 'the chain starts at a motor stage: put it first',
        kind: 'structure',
      });
    }
    if (i > 0 && s.kind === 'motor') {
      out.push({
        path: p(),
        message: 'only the first stage can be a motor: a drivetrain is one chain from one motor',
        kind: 'structure',
      });
    }
    switch (s.kind) {
      case 'motor': {
        use(p('use'), s.use);
        const u = uses.find((x) => x.id === s.use);
        if (u !== undefined) {
          const e = resolveEntry(doc, u.entry);
          if (e.ok && e.entry.family !== 'motor') {
            out.push({
              path: p('use'),
              message: `${s.use} is a ${e.entry.family}, not a motor`,
              kind: 'structure',
            });
          }
        }
        instance(p('instance'), s.instance);
        if (s.mate !== undefined) {
          if (d.assembly === undefined) {
            out.push({
              path: p('mate'),
              message: `names mate ${s.mate}, but the drivetrain names no assembly`,
              kind: 'reference',
              target: s.mate,
            });
          } else if (assembly !== undefined) {
            const m = assembly.mates.find((x) => x.id === s.mate);
            if (m === undefined) {
              out.push({
                path: p('mate'),
                message: `names mate ${s.mate}, which ${assembly.name} does not have`,
                kind: 'reference',
                target: s.mate,
              });
            } else if (m.kind !== 'revolute') {
              out.push({
                path: p('mate'),
                message: `${m.name} (${m.id}) is a ${m.kind} mate; the motor's shaft turns on a revolute`,
                kind: 'structure',
              });
            }
          }
        }
        break;
      }
      case 'belt':
        use(p('belt'), s.belt);
        (s.pulleys ?? []).forEach((u, k) => use(p('pulleys', k), u));
        break;
      case 'gear':
      case 'planetary':
        (s.uses ?? []).forEach((u, k) => use(p('uses', k), u));
        (s.instances ?? []).forEach((inst, k) => instance(p('instances', k), inst));
        break;
      case 'shaft':
        instance(p('instance'), s.instance);
        s.bearings.forEach((b, k) => {
          use(p('bearings', k, 'use'), b.use);
          instance(p('bearings', k, 'instance'), b.instance);
        });
        break;
      case 'coupling':
        use(p('use'), s.use);
        instance(p('instance'), s.instance);
        break;
    }
  });
  const o = d.output;
  instance(['output', 'instance'], o.instance);
  if (o.kind === 'spool') {
    use(['output', 'cable'], o.cable);
    if (o.fairlead !== undefined) instance(['output', 'fairlead', 'instance'], o.fairlead.instance);
    if (o.body !== undefined && o.instance !== undefined) {
      const inst = findInstance(doc, d, o.instance);
      const part = inst !== undefined && 'part' in inst.source ? inst.source.part : undefined;
      const bodies = part === undefined ? undefined : ctx.partBodies?.(part);
      if (bodies !== undefined && !bodies.includes(o.body)) {
        out.push({
          path: ['output', 'body'],
          message: `names body ${o.body}, which ${part} does not have`,
          kind: 'reference',
          target: o.body,
        });
      }
    }
  }
  return out;
}

/** The motor's rotor inertia from its catalog entry. */
function catalogInertia(
  doc: ManufaktureDocument,
  useId: string,
): Pick<InertiaElement, 'value' | 'from' | 'missing'> & { entry?: CatalogRef } {
  const use = mechItems(doc.mech, 'purchased').find((u) => u.id === useId);
  if (use === undefined)
    return { from: 'catalog', missing: `the design has no purchased part ${useId}` };
  const resolved = resolveEntry(doc, use.entry);
  if (!resolved.ok) return { from: `catalog ${refText(use.entry)}`, missing: resolved.message };
  const e = resolved.entry;
  const rated = Object.hasOwn(e.ratings, 'rotorInertia') ? e.ratings.rotorInertia : undefined;
  const from = `catalog ${refText(use.entry)} ${e.maker} ${e.partNumber}, rotor inertia${e.verified ? '' : ' (catalog data, unverified)'}`;
  if (rated === undefined || !('value' in rated)) {
    return {
      from,
      entry: use.entry,
      missing: `the catalog entry ${refText(use.entry)} gives no rotor inertia`,
    };
  }
  return {
    from: rated.estimated === true ? `${from}, estimated` : from,
    value: rated.value,
    entry: use.entry,
  };
}

/** One drivetrain read into numbers. */
export function drivetrainChain(ctx: DrivetrainContext, d: Drivetrain): DrivetrainChain {
  const doc = ctx.document;
  const problems = referenceProblems(ctx, d);
  const stages: StageResult[] = [];
  // n and the efficiency product so far, carried down the chain (undefined once a ratio fails).
  let n: number | undefined = 1;
  let eta: number | undefined = 1;
  const nIn: (number | undefined)[] = [];
  const nOut: (number | undefined)[] = [];
  const etaIn: (number | undefined)[] = [];
  const etaOut: (number | undefined)[] = [];
  d.stages.forEach((s, i) => {
    const r: StageResult = { id: s.id, kind: s.kind, name: stageName(s, doc) };
    nIn[i] = n;
    etaIn[i] = eta;
    if (n !== undefined) r.nIn = n;
    if (s.kind === 'belt' || s.kind === 'gear' || s.kind === 'planetary') {
      let ratio: number | undefined;
      if ('source' in s.ratio) {
        ratio = read(ctx, problems, ['stages', i, 'ratio'], s.ratio, 'number', RANGE_RATIO);
        r.ratioText = s.ratio.source.trim();
      } else {
        const driver = read(
          ctx,
          problems,
          ['stages', i, 'ratio', 'driver'],
          s.ratio.driver,
          'number',
          RANGE_TEETH,
        );
        const driven = read(
          ctx,
          problems,
          ['stages', i, 'ratio', 'driven'],
          s.ratio.driven,
          'number',
          RANGE_TEETH,
        );
        ratio = driver !== undefined && driven !== undefined ? driven / driver : undefined;
        r.ratioText = `${s.ratio.driven.source.trim()} / ${s.ratio.driver.source.trim()} teeth`;
      }
      const efficiency = read(
        ctx,
        problems,
        ['stages', i, 'efficiency'],
        s.efficiency,
        'number',
        RANGE_EFFICIENCY,
      );
      if (ratio !== undefined) r.ratio = ratio;
      if (efficiency !== undefined) r.efficiency = efficiency;
      n = n !== undefined && ratio !== undefined ? n * ratio : undefined;
      eta = eta !== undefined && efficiency !== undefined ? eta * efficiency : undefined;
    }
    nOut[i] = n;
    etaOut[i] = eta;
    if (n !== undefined) r.nOut = n;
    stages.push(r);
  });

  const elements: InertiaElement[] = [];
  for (const e of planElements(d, doc)) {
    const last = e.stageIndex >= d.stages.length;
    const en = last ? n : e.side === 'in' ? nIn[e.stageIndex] : nOut[e.stageIndex];
    const eEta = last ? eta : e.side === 'in' ? etaIn[e.stageIndex] : etaOut[e.stageIndex];
    const base = {
      at: e.at,
      name: e.name,
      ...(en !== undefined ? { n: en } : {}),
      ...(eEta !== undefined ? { efficiencyBefore: eEta } : {}),
    };
    const plan = e.plan;
    switch (plan.kind) {
      case 'typed': {
        const value = read(ctx, problems, plan.path, plan.expr, 'inertia', {
          min: 0,
          what: 'an inertia',
        });
        elements.push({
          ...base,
          source: 'typed',
          from: `typed: ${plan.expr.source.trim()}`,
          ...(value !== undefined
            ? { value }
            : { missing: `the typed inertia "${plan.expr.source.trim()}" does not read` }),
          ref: { kind: 'given' },
        });
        break;
      }
      case 'catalog': {
        const c = catalogInertia(doc, plan.use);
        elements.push({
          ...base,
          source: 'catalog',
          from: c.from,
          ...(c.value !== undefined ? { value: c.value } : {}),
          ...(c.missing !== undefined ? { missing: c.missing } : {}),
          ref:
            c.entry !== undefined
              ? { kind: 'catalog', entry: c.entry, field: 'rotorInertia' }
              : { kind: 'given' },
        });
        break;
      }
      case 'measured': {
        const inst = findInstance(doc, d, plan.instance);
        const subject = {
          kind: 'instance',
          assembly: d.assembly ?? '',
          instance: plan.instance,
        } as SubjectRef;
        const ref: InputRef = { kind: 'measured', what: 'inertia', subject };
        if (inst === undefined) {
          elements.push({
            ...base,
            source: 'measured',
            from: `measured: ${plan.instance}`,
            missing:
              d.assembly === undefined
                ? `the drivetrain names no assembly to find ${plan.instance} in`
                : `${d.assembly} has no instance ${plan.instance}`,
            ref,
          });
          break;
        }
        const m = measureInstance(ctx, d, inst, plan.body, e.name);
        elements.push({ ...base, source: 'measured', ...m, ref });
        break;
      }
      case 'none':
        elements.push({
          ...base,
          source: 'none',
          from: `none given (${plan.why}); counted as zero`,
          ref: { kind: 'given' },
        });
        break;
    }
  }

  return {
    id: d.id,
    name: d.name,
    ...(d.assembly !== undefined ? { assembly: d.assembly } : {}),
    stages,
    output: {
      kind: d.output.kind,
      name: OUTPUT_KIND_TEXT[d.output.kind],
      ...(n !== undefined ? { n } : {}),
    },
    elements,
    ...(n !== undefined ? { ratio: n } : {}),
    ...(eta !== undefined ? { efficiency: eta } : {}),
    problems,
  };
}

/** Every problem with a drivetrain, as one line each: "stages.2.instance: names instance ...". */
export function drivetrainProblemText(p: DrivetrainProblem): string {
  return p.path.length === 0 ? p.message : `${p.path.join('.')}: ${p.message}`;
}
