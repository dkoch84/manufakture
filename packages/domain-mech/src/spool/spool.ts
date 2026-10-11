// The spool and its cable as the drivetrain's output (task T9.3b): reads a `spool` output of a
// stored `Drivetrain` into numbers. The geometry (core diameter, flange diameter, width between
// the flanges) is typed on the output or read from the spool body; the cable is a purchased use
// of a `rope` catalog entry (diameter, breaking loads, bend ratios, elongation, mass per length);
// the cable length and the fairlead's bend diameter are typed. The winding itself is ./winding,
// the records ./records.
//
// What the body gives: regen measures it whole (volume, inertia and its tight bounding box in the
// part's coordinates). A spool turns about one of the part's axes: the bounding box has two equal
// extents (the outside diameter) and a third (the overall length along the axis). The outside
// diameter is taken as the flange diameter when none is typed. The core diameter and the width
// between the flanges are inside the body, where a bounding box cannot see, so they are typed; a
// typed width longer than the body is reported.

import {
  mechItems,
  type Assembly,
  type CatalogRef,
  type Drivetrain,
  type Instance,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { NOTHING_MEASURED } from '../checks/measured';
import type { InputRef } from '../checks/types';
import type { DrivetrainContext, DrivetrainProblem } from '../drivetrain/chain';
import { refText, resolveEntry } from '../parts/catalog';
import { siValue } from '../requirements/values';

export type SpoolOutput = Extract<Drivetrain['output'], { kind: 'spool' }>;

/** Two extents of the bounding box within this fraction of the larger are the spool's diameter. */
export const ROUND_TOLERANCE = 0.01;

/** One dimension of the spool, read: typed, measured from the body, or missing. */
export interface SpoolDimension {
  /** m; absent when missing. */
  value?: number;
  source: 'typed' | 'measured' | 'none';
  /** Where it came from, in words. */
  from: string;
  /** Why there is no value. */
  missing?: string;
  ref: InputRef;
}

/** What the bounding box of the spool body says. */
export interface SpoolBox {
  /** The part axis the spool turns about. */
  axis: 'x' | 'y' | 'z';
  /** m: the two equal extents. */
  outerDiameter: number;
  /** m: the extent along the axis. */
  overallLength: number;
  /** In words: "bodies extrude#1 of part#1". */
  from: string;
}

/** A rating of the cable read from its entry; absent value when the entry does not give it. */
export interface CableRating {
  value?: number;
  estimated?: boolean;
  ref: InputRef;
}

/** The cable as read from its catalog entry. */
export interface SpoolCable {
  /** The purchased use. */
  use: string;
  /** For people: "Samson Rope AmSteel-Blue 1/8 in (3 mm), product code 872". */
  name: string;
  entry?: CatalogRef;
  verified?: boolean;
  /** "catalog rope/samson-amsteel-blue-3mm v1 (catalog data, unverified)". */
  from: string;
  /** Why the entry could not be read. */
  missing?: string;
  /** m. */
  diameter: CableRating;
  /** N. */
  minimumBreakingLoad: CableRating;
  averageBreakingLoad: CableRating;
  minimumBendRatio: CableRating;
  suggestedBendRatio: CableRating;
  /** Fraction (0.007 is 0.7 %) at `elongationLoad` (a fraction of the breaking load). */
  elasticElongation: CableRating;
  elongationLoad: CableRating;
  /** kg/m. */
  massPerLength: CableRating;
  /** The strength basis text: spliced, unterminated, terminated. */
  strengthBasis?: string;
}

/** A requirement the spool is compared with: its value in SI and its id. */
export interface SpoolRequirement {
  id: string;
  name: string;
  value: number;
}

/** The spool output read into numbers, before winding. Plain JSON. */
export interface SpoolReading {
  drivetrain: string;
  drivetrainName: string;
  /** m: the cable on the spool at zero extension. */
  length?: number;
  /** Why there is no length. */
  lengthMissing?: string;
  core: SpoolDimension;
  width: SpoolDimension;
  flange: SpoolDimension;
  box?: SpoolBox;
  /** Why the body was not read, when it was wanted. */
  boxMissing?: string;
  cable: SpoolCable;
  /** m: the diameter the cable bends round at the fairlead or pulley. */
  fairlead?: SpoolDimension;
  /** The most demanding requirement of each kind for this drivetrain. */
  travel?: SpoolRequirement;
  maxForce?: SpoolRequirement;
  peakCableSpeed?: SpoolRequirement;
  problems: DrivetrainProblem[];
}

function assemblyOf(doc: ManufaktureDocument, d: Drivetrain): Assembly | undefined {
  return d.assembly === undefined ? undefined : doc.assemblies?.find((a) => a.id === d.assembly);
}

/** The spool's bodies to read the bounding box of, or why there are none. */
function spoolBodies(
  ctx: Pick<DrivetrainContext, 'document' | 'partBodies'>,
  d: Drivetrain,
  o: SpoolOutput,
):
  | { ok: true; part: string; bodies: readonly string[]; instance: Instance }
  | { ok: false; message: string } {
  if (o.instance === undefined) return { ok: false, message: 'the spool names no instance' };
  const inst = assemblyOf(ctx.document, d)?.instances.find((i) => i.id === o.instance);
  if (inst === undefined) {
    return {
      ok: false,
      message:
        d.assembly === undefined
          ? `the drivetrain names no assembly to find ${o.instance} in`
          : `${d.assembly} has no instance ${o.instance}`,
    };
  }
  if (!('part' in inst.source)) {
    return {
      ok: false,
      message: `${inst.name} (${inst.id}) shows a part of another document, which is not measured`,
    };
  }
  if (inst.suppressed) return { ok: false, message: `${inst.name} (${inst.id}) is suppressed` };
  const part = inst.source.part;
  if (o.body !== undefined) return { ok: true, part, bodies: [o.body], instance: inst };
  const bodies = inst.bodies ?? ctx.partBodies?.(part);
  if (bodies === undefined) {
    return {
      ok: false,
      message: `the bodies of ${part} are not known: it has not regenerated, or it did not build`,
    };
  }
  if (bodies.length === 0) return { ok: false, message: `${part} has no bodies` };
  return { ok: true, part, bodies, instance: inst };
}

/** Whether the spool's geometry needs its body measured: only the flange diameter comes from it. */
function wantsBody(o: SpoolOutput): boolean {
  return o.flange === undefined || o.width !== undefined;
}

/** The bodies regen must measure for the spool of one drivetrain. */
export function spoolNeeds(
  doc: ManufaktureDocument,
  d: Drivetrain,
  partBodies: (part: string) => readonly string[] | undefined,
): { part: string; body: string }[] {
  const o = d.output;
  if (o.kind !== 'spool' || !wantsBody(o)) return [];
  const b = spoolBodies({ document: doc, partBodies }, d, o);
  return b.ok ? b.bodies.map((body) => ({ part: b.part, body })) : [];
}

/** The spool's bounding box: its axis, outside diameter and overall length; or why there is none. */
export function readBox(
  ctx: DrivetrainContext,
  d: Drivetrain,
  o: SpoolOutput,
): { ok: true; box: SpoolBox } | { ok: false; message: string } {
  const b = spoolBodies(ctx, d, o);
  if (!b.ok) return b;
  const measured = ctx.measured ?? NOTHING_MEASURED;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of b.bodies) {
    const m = measured.body(b.part, id);
    if (m === undefined) {
      return {
        ok: false,
        message: `${b.part} ${id} is not measured: ${measured.problem(b.part, id)}`,
      };
    }
    if (m.boundingBox === undefined || m.boundingBox === null) {
      return { ok: false, message: `${b.part} ${id} has no bounding box` };
    }
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, m.boundingBox.min[k]!);
      max[k] = Math.max(max[k]!, m.boundingBox.max[k]!);
    }
  }
  const e = [0, 1, 2].map((k) => max[k]! - min[k]!);
  const agree = (a: number, c: number) => Math.abs(a - c) <= ROUND_TOLERANCE * Math.max(a, c);
  const axes = ['x', 'y', 'z'] as const;
  const round: number[] = [];
  for (let k = 0; k < 3; k++) {
    const [i, j] = [0, 1, 2].filter((q) => q !== k) as [number, number];
    if (agree(e[i]!, e[j]!) && !agree(e[k]!, e[i]!)) round.push(k);
  }
  const mm = (v: number) => `${Number((v * 1000).toPrecision(4))} mm`;
  const extents = `${mm(e[0]!)} x ${mm(e[1]!)} x ${mm(e[2]!)}`;
  if (round.length !== 1) {
    return {
      ok: false,
      message: `its bounding box (${extents}) does not show one axis with a round section across it (two equal extents and a different third): type the flange diameter`,
    };
  }
  const k = round[0]!;
  const [i, j] = [0, 1, 2].filter((q) => q !== k) as [number, number];
  return {
    ok: true,
    box: {
      axis: axes[k]!,
      outerDiameter: (e[i]! + e[j]!) / 2,
      overallLength: e[k]!,
      from: `the bounding box of ${b.bodies.join(', ')} of ${b.part}, shown by ${b.instance.name} (${b.instance.id}): ${extents}`,
    },
  };
}

const RANGE = { above: 0 };

/** One typed length in metres, or a value problem. */
function typedLength(
  ctx: DrivetrainContext,
  problems: DrivetrainProblem[],
  path: readonly (string | number)[],
  expr: StoredExpression,
  what: string,
): SpoolDimension {
  const r = siValue(expr, 'length', ctx.variables);
  const from = `typed: ${expr.source.trim()}`;
  if (!r.ok || !(r.value > RANGE.above)) {
    const message = r.ok ? `the ${what} must be above zero` : r.message;
    problems.push({ path, message, kind: 'value' });
    return {
      source: 'typed',
      from,
      missing: r.ok
        ? `the typed ${what} "${expr.source.trim()}" must be above zero`
        : `the typed ${what} "${expr.source.trim()}" does not read`,
      ref: { kind: 'given' },
    };
  }
  return { value: r.value, source: 'typed', from, ref: { kind: 'given' } };
}

const NO_RATING = (ref: InputRef): CableRating => ({ ref });

/** The cable's purchased use and catalog entry, read. */
function readCable(
  doc: ManufaktureDocument,
  problems: DrivetrainProblem[],
  useId: string,
): SpoolCable {
  const given: InputRef = { kind: 'given' };
  const empty = (from: string, missing: string, name = useId): SpoolCable => ({
    use: useId,
    name,
    from,
    missing,
    diameter: NO_RATING(given),
    minimumBreakingLoad: NO_RATING(given),
    averageBreakingLoad: NO_RATING(given),
    minimumBendRatio: NO_RATING(given),
    suggestedBendRatio: NO_RATING(given),
    elasticElongation: NO_RATING(given),
    elongationLoad: NO_RATING(given),
    massPerLength: NO_RATING(given),
  });
  const use = mechItems(doc.mech, 'purchased').find((u) => u.id === useId);
  if (use === undefined) return empty('catalog', `the design has no purchased part ${useId}`);
  const resolved = resolveEntry(doc, use.entry);
  const name = use.name ?? useId;
  if (!resolved.ok) return empty(`catalog ${refText(use.entry)}`, resolved.message, name);
  const e = resolved.entry;
  if (e.family !== 'rope') {
    const message = `${useId} is a ${e.family}, not a rope or cable`;
    problems.push({ path: ['output', 'cable'], message, kind: 'structure' });
    return empty(`catalog ${refText(use.entry)}`, message, name);
  }
  const rating = (field: string, scale = 1): CableRating => {
    const ref: InputRef = { kind: 'catalog', entry: use.entry, field };
    const r = Object.hasOwn(e.ratings, field) ? e.ratings[field] : undefined;
    if (r === undefined || !('value' in r)) return { ref };
    return { value: r.value * scale, ...(r.estimated === true ? { estimated: true } : {}), ref };
  };
  const dim = e.dimensions?.diameter;
  const diameter: CableRating = {
    ...(dim !== undefined && 'value' in dim ? { value: dim.value / 1000 } : {}),
    ...(dim !== undefined && 'value' in dim && dim.estimated === true ? { estimated: true } : {}),
    ref: { kind: 'catalog', entry: use.entry, field: 'diameter', derivation: 'dimension, mm to m' },
  };
  const basis = e.ratings.strengthBasis;
  return {
    use: useId,
    name: use.name ?? `${e.maker} ${e.partNumber}`,
    entry: use.entry,
    verified: e.verified,
    from: `catalog ${refText(use.entry)} ${e.maker} ${e.partNumber}${e.verified ? '' : ' (catalog data, unverified)'}`,
    diameter,
    minimumBreakingLoad: rating('minimumBreakingLoad'),
    averageBreakingLoad: rating('averageBreakingLoad'),
    minimumBendRatio: rating('minimumBendRatio'),
    suggestedBendRatio: rating('suggestedBendRatio'),
    elasticElongation: rating('elasticElongation'),
    elongationLoad: rating('elongationLoad'),
    massPerLength: rating('massPerLength'),
    ...(basis !== undefined && 'text' in basis ? { strengthBasis: basis.text } : {}),
  };
}

/** The most demanding requirement of a quantity (the largest at-least value) for a drivetrain. */
function requirementFor(
  ctx: DrivetrainContext,
  d: Drivetrain,
  quantity: 'travel' | 'maxForce' | 'peakCableSpeed',
): SpoolRequirement | undefined {
  const kind = quantity === 'travel' ? 'length' : quantity === 'maxForce' ? 'force' : 'speed';
  let best: SpoolRequirement | undefined;
  for (const r of mechItems(ctx.document.mech, 'requirements')) {
    if (r.quantity !== quantity) continue;
    if (r.drivetrain !== undefined && r.drivetrain !== d.id) continue;
    if (r.comparison !== '>=' && r.comparison !== '>') continue;
    if (Array.isArray(r.value)) continue;
    const v = siValue(r.value as StoredExpression, kind, ctx.variables);
    if (!v.ok) continue;
    if (best === undefined || v.value > best.value)
      best = { id: r.id, name: r.name, value: v.value };
  }
  return best;
}

/** The spool output of a drivetrain read into numbers. */
export function readSpool(ctx: DrivetrainContext, d: Drivetrain, o: SpoolOutput): SpoolReading {
  const problems: DrivetrainProblem[] = [];
  const out: Partial<SpoolReading> = {};
  const lengthRead = typedLength(ctx, problems, ['output', 'length'], o.length, 'cable length');
  const notTyped = (what: string, why: string): SpoolDimension => ({
    source: 'none',
    from: 'not typed',
    missing: why.length > 0 ? `type the ${what}: ${why}` : `type the ${what}`,
    ref: { kind: 'given' },
  });

  let box: SpoolBox | undefined;
  let boxMissing: string | undefined;
  if (wantsBody(o)) {
    const b = readBox(ctx, d, o);
    if (b.ok) box = b.box;
    else boxMissing = b.message;
  }
  const inside =
    box !== undefined
      ? `the body's bounding box gives only its outside diameter (${Number((box.outerDiameter * 1000).toPrecision(4))} mm) and overall length (${Number((box.overallLength * 1000).toPrecision(4))} mm)`
      : 'a body is read for its outside diameter only';

  const core =
    o.core !== undefined
      ? typedLength(ctx, problems, ['output', 'core'], o.core, 'core diameter')
      : notTyped('core diameter', inside);
  const width =
    o.width !== undefined
      ? typedLength(ctx, problems, ['output', 'width'], o.width, 'width between the flanges')
      : notTyped('width between the flanges', inside);
  let flange: SpoolDimension;
  if (o.flange !== undefined) {
    flange = typedLength(ctx, problems, ['output', 'flange'], o.flange, 'flange diameter');
  } else if (box !== undefined) {
    const subject = {
      kind: 'instance',
      assembly: d.assembly ?? '',
      instance: o.instance ?? '',
    } as const;
    flange = {
      value: box.outerDiameter,
      source: 'measured',
      from: `measured: the outside diameter of ${box.from}`,
      ref: { kind: 'measured', what: 'distance', subject },
    };
  } else {
    flange = notTyped('flange diameter', boxMissing ?? '');
  }

  if (core.value !== undefined && flange.value !== undefined && flange.value < core.value) {
    problems.push({
      path: ['output', o.flange !== undefined ? 'flange' : 'core'],
      message: 'the flange diameter is smaller than the core diameter',
      kind: 'value',
    });
  }
  if (
    width.value !== undefined &&
    box !== undefined &&
    width.value > box.overallLength * (1 + ROUND_TOLERANCE)
  ) {
    problems.push({
      path: ['output', 'width'],
      message: `the width between the flanges is longer than the spool body (${Number((box.overallLength * 1000).toPrecision(4))} mm along its axis)`,
      kind: 'value',
    });
  }

  const cable = readCable(ctx.document, problems, o.cable);
  if (o.fairlead !== undefined) {
    out.fairlead = typedLength(
      ctx,
      problems,
      ['output', 'fairlead', 'bendDiameter'],
      o.fairlead.bendDiameter,
      'fairlead bend diameter',
    );
  }
  const travel = requirementFor(ctx, d, 'travel');
  const maxForce = requirementFor(ctx, d, 'maxForce');
  const peakCableSpeed = requirementFor(ctx, d, 'peakCableSpeed');
  return {
    drivetrain: d.id,
    drivetrainName: d.name,
    ...(lengthRead.value !== undefined ? { length: lengthRead.value } : {}),
    ...(lengthRead.missing !== undefined ? { lengthMissing: lengthRead.missing } : {}),
    core,
    width,
    flange,
    ...(box !== undefined ? { box } : {}),
    ...(boxMissing !== undefined ? { boxMissing } : {}),
    cable,
    ...(out.fairlead !== undefined ? { fairlead: out.fairlead } : {}),
    ...(travel !== undefined ? { travel } : {}),
    ...(maxForce !== undefined ? { maxForce } : {}),
    ...(peakCableSpeed !== undefined ? { peakCableSpeed } : {}),
    problems,
  };
}
