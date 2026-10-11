// The calc records of a spool and its cable (task T9.3b; M9 plan decision 4): the layers wound,
// the effective radius at full wind and at full payout (with the torque and spool speed they give
// for the force and speed requirements), the flange clearance over the top layer, the bend ratio
// D/d at the core and at the fairlead, the cable length against the travel requirement, and the
// cable's elastic stretch at the force requirement. Every input names where it came from; a record
// whose inputs are missing is `unknown` and names them. Numbers and margins only: a status is
// `warning` when a number is on the wrong side of the limit it is compared with, never a verdict
// on the machine.

import type { CalcInput, CalcSource, CalcValue, LimitKind } from '@manufakture/calc';
import type { SubjectRef } from '@manufakture/core';
import type { InputRef, MechRecord } from '../checks/types';
import type { CableRating, SpoolDimension, SpoolReading, SpoolRequirement } from './spool';
import { MAX_LAYERS, outerSurface, type Winding } from './winding';

export const SPOOL_LAYERS = 'spool.layers';
export const SPOOL_RADIUS_WOUND = 'spool.radius-wound';
export const SPOOL_RADIUS_OUT = 'spool.radius-out';
export const SPOOL_FLANGE_CLEARANCE = 'spool.flange-clearance';
export const SPOOL_BEND_RATIO = 'spool.bend-ratio';
export const SPOOL_FAIRLEAD_BEND_RATIO = 'spool.fairlead-bend-ratio';
export const SPOOL_TRAVEL = 'spool.travel';
export const SPOOL_STRETCH = 'spool.stretch';

/**
 * The flange clearance compared with: this many cable diameters of flange above the top layer. A
 * common winch drum rule of thumb (it keeps the top layer from riding over the flange), stated as
 * a guide, not taken from a standard here; the number is shown either way.
 */
export const FLANGE_CLEARANCE_GUIDE = 2;

const WIRE_ROPE_DRUMS: CalcSource = {
  title: 'Wire Rope Users Manual, 4th ed., Wire Rope Technical Board (2005)',
  locator: 'drums and sheaves: layers, pitch diameter of each layer, D/d ratios',
};

const STACKED =
  'Simple stacked winding: each layer sits straight on the one below and adds one cable diameter to the radius. Real winding nests partly into the layer below (fully nested adds d·√3/2 per layer), so these radii are the upper bound: the most torque per newton of cable tension.';
const LEVEL =
  'Level winding across the whole width between the flanges, floor(w / d) turns in every layer; a cable piling up in one place (no level wind) reaches a larger radius sooner.';
const WHOLE =
  'The whole cable length is wound at zero extension and all of it can be paid out: no dead turns kept on the core, no cable between the spool and the fairlead counted, no stretch in the winding.';
const ROUND = 'The cable is round and keeps its diameter on the spool (no flattening of a braid).';

interface Built {
  inputs: CalcInput[];
  refs: Record<string, InputRef>;
  missing: { name: string; why: string }[];
}

function builder(): Built & {
  add(
    name: string,
    symbol: string,
    value: number | undefined,
    unit: string,
    source: string,
    ref: InputRef,
    why?: string,
  ): number | undefined;
} {
  const b: Built = { inputs: [], refs: {}, missing: [] };
  return {
    ...b,
    add(name, symbol, value, unit, source, ref, why) {
      b.inputs.push({ name, symbol, value: value ?? null, unit, source });
      b.refs[symbol] = ref;
      if (value === undefined) b.missing.push({ name, why: why ?? 'not given' });
      return value;
    },
  };
}

function dimensionInput(
  b: ReturnType<typeof builder>,
  name: string,
  symbol: string,
  d: SpoolDimension,
): number | undefined {
  return b.add(name, symbol, d.value, 'm', d.from, d.ref, d.missing);
}

function ratingInput(
  b: ReturnType<typeof builder>,
  s: SpoolReading,
  name: string,
  symbol: string,
  r: CableRating,
  unit: string,
  field: string,
): number | undefined {
  const source = `${s.cable.from}, ${field}${r.estimated === true ? ', estimated' : ''}`;
  const why = s.cable.missing ?? `the catalog entry gives no ${field}`;
  return b.add(name, symbol, r.value, unit, source, r.ref, why);
}

function requirementInput(
  b: ReturnType<typeof builder>,
  name: string,
  symbol: string,
  r: SpoolRequirement,
  unit: string,
): number {
  b.add(name, symbol, r.value, unit, `requirement ${r.name} (${r.id})`, {
    kind: 'requirement',
    id: r.id,
  });
  return r.value;
}

function base(
  s: SpoolReading,
  check: string,
  title: string,
): Pick<MechRecord, 'id' | 'title' | 'check' | 'subject'> {
  const subject: SubjectRef[] = [{ kind: 'drivetrain', drivetrain: s.drivetrain }];
  return { id: `${check}@${s.drivetrain}`, title: `${title}, ${s.drivetrainName}`, check, subject };
}

/** A record from what was built: unknown when an input is missing, compared with a limit if one. */
function finish(
  b: Built,
  rest: Omit<MechRecord, 'inputs' | 'inputRefs' | 'status' | 'result'> & {
    result: number | undefined;
  },
  limit?: { value: number; kind: LimitKind },
): MechRecord {
  const record: MechRecord = {
    ...rest,
    inputs: b.inputs,
    inputRefs: b.refs,
    result: rest.result ?? null,
    status: 'ok',
  };
  if (b.missing.length > 0 || rest.result === undefined) {
    record.result = null;
    record.status = 'unknown';
    if (b.missing.length > 0) {
      record.missing = b.missing.map((m) => m.name);
      record.note = `Missing: ${b.missing.map((m) => `${m.name} (${m.why})`).join('; ')}`;
    }
    return record;
  }
  if (limit !== undefined && limit.value > 0) {
    record.limit = limit.value;
    record.limitKind = limit.kind;
    const margin =
      limit.kind === 'at-least'
        ? (rest.result - limit.value) / limit.value
        : (limit.value - rest.result) / limit.value;
    record.margin = margin;
    record.status = margin < 0 ? 'warning' : 'ok';
  }
  return record;
}

const round = (v: number, p = 4) => Number(v.toPrecision(p));
const mm = (v: number) => `${round(v * 1000)} mm`;

/** The geometry inputs every winding record shares: d, D_core, w, L. */
function windingInputs(b: ReturnType<typeof builder>, s: SpoolReading): void {
  ratingInput(b, s, 'Cable diameter', 'd', s.cable.diameter, 'm', 'diameter');
  dimensionInput(b, 'Core diameter', 'D_core', s.core);
  dimensionInput(b, 'Width between the flanges', 'w', s.width);
  b.add(
    'Cable length on the spool',
    'L',
    s.length,
    'm',
    'typed on the spool output',
    { kind: 'given' },
    s.lengthMissing ?? 'it does not read',
  );
}

function layersRecord(s: SpoolReading, w: Winding | undefined): MechRecord {
  const b = builder();
  windingInputs(b, s);
  const derived: CalcValue[] = [];
  let result: number | undefined;
  let note: string | undefined;
  if (w !== undefined) {
    derived.push({ name: 'Turns per layer', symbol: 'N', value: w.turnsPerLayer, unit: '1' });
    for (const l of w.layers) {
      derived.push({
        name: `Pitch radius of layer ${l.n}`,
        symbol: `r_${l.n}`,
        value: l.radius,
        unit: 'm',
      });
      derived.push({
        name: `Cable in layer ${l.n}`,
        symbol: `L_${l.n}`,
        value: l.length,
        unit: 'm',
      });
    }
    const last = w.layers[w.layers.length - 1];
    if (last !== undefined) {
      derived.push({
        name: `Turns in layer ${last.n} (the outermost)`,
        symbol: `N_${last.n}`,
        value: last.turns,
        unit: '1',
      });
      derived.push({
        name: 'Turns in all',
        symbol: 'N_total',
        value: w.layers.reduce((t, l) => t + l.turns, 0),
        unit: '1',
      });
      result = w.layers.length;
    } else if (w.tooManyLayers === true) {
      note = `The cable length needs more than ${MAX_LAYERS} layers on this spool: check the cable length, the cable diameter and the core and width.`;
    } else if (w.turnsPerLayer === 0) {
      note = `No turn fits: the width between the flanges (${mm(w.width)}) is less than the cable diameter (${mm(w.cable)}).`;
    }
  }
  const m = s.cable.massPerLength.value;
  if (m !== undefined && s.length !== undefined) {
    derived.push({ name: 'Mass of the cable', symbol: 'm_cable', value: m * s.length, unit: 'kg' });
  }
  const r = finish(b, {
    ...base(s, SPOOL_LAYERS, 'Layers wound'),
    method:
      'Layered winding, stacked: N turns per layer, each layer one cable diameter further out, filled from the core until the cable length is wound',
    formula:
      'N = floor(w / d); r_n = D_core/2 + d/2 + (n - 1) d; L_n = N · 2π r_n; layers = the least n with L_1 + ... + L_n ≥ L',
    result,
    unit: '1',
    derived,
    assumptions: [STACKED, LEVEL, WHOLE, ROUND],
    sources: [WIRE_ROPE_DRUMS],
  });
  // Every input given, yet nothing wound (no turn fits, or too many layers): say why.
  if (note !== undefined && r.missing === undefined) {
    return { ...r, result: null, status: 'unknown', note };
  }
  return r;
}

/** Torque and speed at one radius for the force and speed requirements, as derived values. */
function atRadius(
  b: ReturnType<typeof builder>,
  s: SpoolReading,
  radius: number,
  derived: CalcValue[],
): void {
  derived.push({
    name: 'Spool torque per newton of cable tension',
    symbol: 'T/F',
    value: radius,
    unit: 'N·m/N',
  });
  derived.push({
    name: 'Spool speed per metre per second of cable',
    symbol: 'ω/v',
    value: 1 / radius,
    unit: 'rad/m',
  });
  if (s.maxForce !== undefined) {
    const f = requirementInput(b, 'Maximum force', 'F', s.maxForce, 'N');
    derived.push({
      name: 'Spool torque at the maximum force',
      symbol: 'T',
      value: f * radius,
      unit: 'N·m',
    });
  }
  if (s.peakCableSpeed !== undefined) {
    const v = requirementInput(b, 'Peak cable speed', 'v', s.peakCableSpeed, 'm/s');
    derived.push({
      name: 'Spool speed at the peak cable speed',
      symbol: 'ω',
      value: v / radius,
      unit: 'rad/s',
    });
    derived.push({
      name: 'Spool speed at the peak cable speed, rpm',
      symbol: 'n',
      value: (v / radius) * (60 / (2 * Math.PI)),
      unit: 'rpm',
    });
  }
}

function radiusRecord(
  s: SpoolReading,
  w: Winding | undefined,
  layers: MechRecord,
  wound: boolean,
): MechRecord {
  const b = builder();
  windingInputs(b, s);
  b.add(
    'Layers wound',
    'n',
    layers.result ?? undefined,
    '1',
    `calc record ${layers.id}`,
    { kind: 'record', id: layers.id },
    `calc record ${layers.id} is unknown`,
  );
  const derived: CalcValue[] = [];
  let result: number | undefined;
  if (w !== undefined && w.layers.length > 0) {
    result = wound ? w.layers[w.layers.length - 1]!.radius : w.layers[0]!.radius;
    atRadius(b, s, result, derived);
    if (wound) {
      const out = w.layers[0]!.radius;
      derived.push({
        name: 'Torque per newton at full wind over at full payout',
        symbol: 'r_wound/r_out',
        value: result / out,
        unit: '1',
      });
    }
  }
  return finish(b, {
    ...base(
      s,
      wound ? SPOOL_RADIUS_WOUND : SPOOL_RADIUS_OUT,
      wound ? 'Effective radius at full wind (zero extension)' : 'Effective radius at full payout',
    ),
    method: wound
      ? 'The cable leaves from the outermost layer first: at zero extension the effective radius is that layer’s pitch radius'
      : 'The last turn to leave is in layer 1: at full payout the effective radius is the first layer’s pitch radius',
    formula: wound ? 'r_wound = D_core/2 + d/2 + (n - 1) d' : 'r_out = D_core/2 + d/2',
    result,
    unit: 'm',
    derived,
    assumptions: [
      STACKED,
      LEVEL,
      WHOLE,
      'Spool torque is the cable tension times the effective radius, and spool speed the cable speed over it; the radius steps down one cable diameter each time a layer empties.',
    ],
    sources: [WIRE_ROPE_DRUMS],
  });
}

function clearanceRecord(s: SpoolReading, w: Winding | undefined, layers: MechRecord): MechRecord {
  const b = builder();
  windingInputs(b, s);
  const df = dimensionInput(b, 'Flange diameter', 'D_f', s.flange);
  b.add(
    'Layers wound',
    'n',
    layers.result ?? undefined,
    '1',
    `calc record ${layers.id}`,
    { kind: 'record', id: layers.id },
    `calc record ${layers.id} is unknown`,
  );
  const derived: CalcValue[] = [];
  let result: number | undefined;
  const surface = w === undefined ? undefined : outerSurface(w);
  if (df !== undefined && surface !== undefined && w !== undefined) {
    derived.push({
      name: 'Radius of the top layer’s surface',
      symbol: 'r_top',
      value: surface,
      unit: 'm',
    });
    result = df / 2 - surface;
    derived.push({
      name: 'Clearance in cable diameters',
      symbol: 'c/d',
      value: result / w.cable,
      unit: '1',
    });
  }
  const d = s.cable.diameter.value;
  return finish(
    b,
    {
      ...base(s, SPOOL_FLANGE_CLEARANCE, 'Flange clearance over the top layer'),
      method: `The flange radius less the radius of the top layer’s surface at full wind, compared with ${FLANGE_CLEARANCE_GUIDE} cable diameters (a common winch drum rule of thumb, not a standard); below zero the cable stands above the flange`,
      formula: `c = D_f/2 - (D_core/2 + n d); compared with ${FLANGE_CLEARANCE_GUIDE} d`,
      result,
      unit: 'm',
      derived,
      assumptions: [
        STACKED,
        LEVEL,
        WHOLE,
        ...(s.flange.source === 'measured'
          ? [
              'The flange diameter is the spool body’s outside diameter, read from its bounding box: a hub or rim larger than the flanges would be read instead.',
            ]
          : []),
      ],
      sources: [WIRE_ROPE_DRUMS],
    },
    d !== undefined ? { value: FLANGE_CLEARANCE_GUIDE * d, kind: 'at-least' } : undefined,
  );
}

function bendRecord(s: SpoolReading, at: 'core' | 'fairlead'): MechRecord {
  const b = builder();
  const d = ratingInput(b, s, 'Cable diameter', 'd', s.cable.diameter, 'm', 'diameter');
  const big =
    at === 'core'
      ? dimensionInput(b, 'Core diameter', 'D', s.core)
      : dimensionInput(b, 'Fairlead or pulley bend diameter', 'D', s.fairlead!);
  const min = s.cable.minimumBendRatio.value;
  const suggested = s.cable.suggestedBendRatio.value;
  const ref = (field: string, r: CableRating) =>
    `${s.cable.from}, ${field}${r.estimated === true ? ', estimated' : ''}`;
  if (min !== undefined) {
    b.inputs.push({
      name: 'Minimum bend ratio',
      symbol: 'D/d_min',
      value: min,
      unit: '1',
      source: ref('minimum bend ratio', s.cable.minimumBendRatio),
    });
    b.refs['D/d_min'] = s.cable.minimumBendRatio.ref;
  }
  if (suggested !== undefined) {
    b.inputs.push({
      name: 'Suggested bend ratio',
      symbol: 'D/d_sug',
      value: suggested,
      unit: '1',
      source: ref('suggested bend ratio', s.cable.suggestedBendRatio),
    });
    b.refs['D/d_sug'] = s.cable.suggestedBendRatio.ref;
  }
  const result = d !== undefined && big !== undefined ? big / d : undefined;
  const derived: CalcValue[] = [];
  if (result !== undefined && suggested !== undefined) {
    derived.push({
      name: 'Against the suggested bend ratio',
      symbol: '(D/d)/D/d_sug',
      value: result / suggested,
      unit: '1',
    });
  }
  const r = finish(
    b,
    {
      ...base(
        s,
        at === 'core' ? SPOOL_BEND_RATIO : SPOOL_FAIRLEAD_BEND_RATIO,
        at === 'core'
          ? 'Bend ratio D/d at the spool core'
          : 'Bend ratio D/d at the fairlead or pulley',
      ),
      method:
        'The diameter the cable bends round over the cable diameter, compared with the rope’s minimum bend ratio from its catalog entry; the suggested ratio is shown beside it',
      formula: 'D/d',
      result,
      unit: '1',
      derived,
      assumptions: [
        at === 'core'
          ? 'D is the core diameter, where the first layer bends tightest; outer layers bend round larger diameters.'
          : 'D is the typed bend diameter at the fairlead or pulley, measured at its tread (where the cable touches).',
        'Bend ratios are the rope maker’s or a guide’s general figures; bending fatigue life is not computed here.',
      ],
      sources: [WIRE_ROPE_DRUMS],
    },
    min !== undefined ? { value: min, kind: 'at-least' } : undefined,
  );
  if (r.status !== 'unknown') {
    const notes: string[] = [];
    if (min === undefined)
      notes.push(
        'The catalog entry gives no minimum bend ratio: the ratio is shown with nothing to compare.',
      );
    if (suggested !== undefined && result !== undefined && result < suggested) {
      notes.push(`Below the suggested ratio of ${round(suggested)}.`);
    }
    if (notes.length > 0) r.note = notes.join(' ');
  }
  return r;
}

function travelRecord(s: SpoolReading): MechRecord {
  const b = builder();
  const l = b.add(
    'Cable length on the spool',
    'L',
    s.length,
    'm',
    'typed on the spool output',
    { kind: 'given' },
    s.lengthMissing ?? 'it does not read',
  );
  let limit: number | undefined;
  if (s.travel !== undefined) limit = requirementInput(b, 'Travel', 'travel', s.travel, 'm');
  const r = finish(
    b,
    {
      ...base(s, SPOOL_TRAVEL, 'Cable length against the travel'),
      method: 'The cable length that can be paid out, compared with the travel requirement',
      formula: 'L ≥ travel',
      result: l,
      unit: 'm',
      derived:
        s.travel !== undefined && l !== undefined
          ? [
              {
                name: 'Cable left over at full travel',
                symbol: 'L - travel',
                value: l - s.travel.value,
                unit: 'm',
              },
            ]
          : [],
      assumptions: [WHOLE],
      sources: [],
    },
    limit !== undefined ? { value: limit, kind: 'at-least' } : undefined,
  );
  if (s.travel === undefined && r.status !== 'unknown') {
    r.note =
      'No travel requirement names this drivetrain (or none at all): the length is shown with nothing to compare.';
  }
  return r;
}

function stretchRecord(s: SpoolReading): MechRecord {
  const b = builder();
  const eps = ratingInput(
    b,
    s,
    'Elastic elongation at the reference load',
    'ε_ref',
    s.cable.elasticElongation,
    '1',
    'elastic elongation',
  );
  const f = ratingInput(
    b,
    s,
    'Reference load, as a fraction of the breaking load',
    'f_ref',
    s.cable.elongationLoad,
    '1',
    'elongation load',
  );
  const useAverage =
    s.cable.minimumBreakingLoad.value === undefined &&
    s.cable.averageBreakingLoad.value !== undefined;
  const mbl = useAverage
    ? ratingInput(
        b,
        s,
        'Average breaking load',
        'F_break',
        s.cable.averageBreakingLoad,
        'N',
        'average breaking load',
      )
    : ratingInput(
        b,
        s,
        'Minimum breaking load',
        'F_break',
        s.cable.minimumBreakingLoad,
        'N',
        'minimum breaking load',
      );
  const force =
    s.maxForce !== undefined
      ? requirementInput(b, 'Maximum force', 'F', s.maxForce, 'N')
      : b.add(
          'Maximum force',
          'F',
          undefined,
          'N',
          'requirement',
          { kind: 'given' },
          'no maximum force requirement names this drivetrain',
        );
  const l = b.add(
    'Cable length on the spool',
    'L',
    s.length,
    'm',
    'typed on the spool output',
    { kind: 'given' },
    s.lengthMissing ?? 'it does not read',
  );
  const derived: CalcValue[] = [];
  let result: number | undefined;
  if (
    eps !== undefined &&
    f !== undefined &&
    mbl !== undefined &&
    force !== undefined &&
    l !== undefined &&
    f > 0 &&
    mbl > 0
  ) {
    const strain = (eps * force) / (f * mbl);
    derived.push({ name: 'Strain at the maximum force', symbol: 'ε', value: strain, unit: '1' });
    result = strain * l;
  }
  return finish(b, {
    ...base(s, SPOOL_STRETCH, 'Cable stretch at full payout and the maximum force'),
    method:
      'Elastic elongation taken as proportional to load through the catalog’s one point (ε_ref at f_ref of the breaking load), over the whole cable length paid out',
    formula: 'ΔL = ε_ref · F / (f_ref · F_break) · L',
    result,
    unit: 'm',
    derived,
    assumptions: [
      'Linear elasticity through one catalog point (the line from zero to ε_ref at f_ref): braided fibre ropes stiffen with load, so their real strain curve lies above that line below the reference load and below it above; this understates the stretch below the reference load and overstates it above.',
      'Creep under sustained load and the bedding-in of a new rope are not counted.',
      ...(useAverage
        ? ['The catalog entry gives no minimum breaking load: the average is used.']
        : []),
    ],
    sources: [],
  });
}

/** The spool's records, in order. */
export function spoolRecords(s: SpoolReading, w: Winding | undefined): MechRecord[] {
  const layers = layersRecord(s, w);
  const out = [
    layers,
    radiusRecord(s, w, layers, true),
    radiusRecord(s, w, layers, false),
    clearanceRecord(s, w, layers),
    bendRecord(s, 'core'),
  ];
  if (s.fairlead !== undefined) out.push(bendRecord(s, 'fairlead'));
  out.push(travelRecord(s), stretchRecord(s));
  return out;
}
