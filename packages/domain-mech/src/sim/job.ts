// A load case of the document as a simulation job (T9.4b): its resistance law, motion and duty
// cycle (`requirements/`), the drivetrain it names (`drivetrain/`, `spool/`: ratio, efficiency,
// reflected inertia, effective radius against extension), the motor on the drivetrain's motor
// stage (`catalog/conventions.ts` turns its constants into the internal convention), and the
// electrical system's pack, controller and braking resistor (`electrical/`) with their catalog
// entries. Pure and plain JSON in and out, so the main thread builds a job and a worker runs it,
// and an agent's Node session does both.
//
// It never guesses a number the design depends on: a missing input (no motor on the drivetrain,
// no pack in the electrical system, a pack with no capacity) is named, and no job is made. Model
// constants no datasheet gives (copper's temperature coefficient, a 0.95 modulation limit, the
// charge taper) are stated as assumptions, and so is every catalog loss figure that is unknown and
// so left out (a controller with no loss data loses nothing in the run, and says so).

import {
  mechItems,
  type CatalogEntry,
  type LoadCase,
  type ManufaktureDocument,
  type Rated,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { buildPack, cellOcvCurve, GENERIC_OCV, type OcvPoint } from '../catalog/pack';
import {
  KT_KV_PRODUCT,
  motorInductance,
  motorResistance,
  motorTorqueConstant,
  motorVelocityConstant,
} from '../catalog/conventions';
import { OCV_SOC_PERCENT, OUTPUT_SIDE } from '../parts/families';
import { analyseDrivetrain, type DrivetrainAnalysis } from '../drivetrain/analysis';
import {
  analyseElectrical,
  type ComponentResult,
  type ElectricalAnalysis,
} from '../electrical/model/system';
import {
  findBuiltin,
  latestBuiltin,
  refText,
  resolveEntry,
  type BuiltinEntry,
} from '../parts/catalog';
import { resolveDynamic } from '../requirements/motion';
import { siValue } from '../requirements/values';
import { DEFAULT_MECH_SETTINGS, type MechSettings } from '../settings';
import type { SimComponents, SimJob, SimOptions } from './engine';
import type {
  SimBrake,
  SimController,
  SimMachine,
  SimMotor,
  SimMotorThermal,
  SimNode,
  SimPack,
  SimRadius,
} from './machine';
import { simProfile } from './profile';

/** Copper's resistance coefficient near room temperature, 1/K. */
export const COPPER_ALPHA = 0.00393;
/** A sintered NdFeB magnet's remanence coefficient, 1/K (typical; ferrite and SmCo differ). */
export const NDFEB_ALPHA = -0.0012;
/** The temperature catalog resistances and torque constants are taken at, K (25 °C). */
export const CATALOG_REFERENCE = 298.15;
/** Largest voltage vector over Vbus/√3 assumed when the controller gives none. */
export const DEFAULT_MODULATION = 0.95;
/** Current-loop bandwidth assumed for the full electrical mode, Hz. */
export const DEFAULT_LOOP_HZ = 1000;
/** State of charge from which the charge limit is assumed to fall linearly to none at full. */
export const CHARGE_TAPER_START = 0.85;
/** Kt and Kv further apart than this, relative, give a warning. */
export const KT_KV_TOLERANCE = 0.1;

/** What a simulation reads of the design. */
export interface SimContext {
  document: ManufaktureDocument;
  variables: VariableLookup;
  /** Regen's drivetrains (with measured inertias); absent: read here, with nothing measured. */
  drivetrains?: readonly DrivetrainAnalysis[];
  /** Regen's electrical model; absent: read here. */
  electrical?: ElectricalAnalysis;
  /** `domains.mech`: the step, the transient step, the budget and the ambient temperature. */
  settings?: MechSettings;
}

/** Choices of the run, and values no catalog field holds. */
export interface JobOptions {
  electrical?: 'quasi-static' | 'full';
  /** One rep instead of the session. */
  oneRep?: boolean;
  /** Seconds each set ramps its force in and out at the docked position (default 0). */
  ramp?: number;
  /** The cable path's efficiency (fairlead, bends, the spool's bearings); default 1, stated. */
  cableEfficiency?: number;
  /** The motor's two thermal nodes, over what the catalog gives. */
  motorThermal?: SimMotorThermal;
  /** A thermal node for the pack (it has none otherwise). */
  packThermal?: SimNode;
  /** Controller values over the catalog's (loss model, modulation, loop bandwidth). */
  controller?: Partial<SimController>;
  record?: SimOptions['record'];
  /** Wall-clock budget, ms; default the settings' budget. */
  budgetMs?: number;
}

/** An input the simulation needs and cannot read, by what it is. */
export interface SimMissing {
  input: string;
  message: string;
}

export type JobResult =
  | { ok: true; job: SimJob; assumptions: string[]; warnings: string[] }
  | { ok: false; missing: SimMissing[]; warnings: string[] };

type Entry = CatalogEntry | BuiltinEntry;

function value(rated: Rated | undefined): number | undefined {
  return rated !== undefined && 'value' in rated ? rated.value : undefined;
}

function rating(e: Entry, field: string): number | undefined {
  return value(Object.hasOwn(e.ratings, field) ? e.ratings[field] : undefined);
}

function text(e: Entry, field: string): string | undefined {
  const r = Object.hasOwn(e.ratings, field) ? e.ratings[field] : undefined;
  return r !== undefined && 'text' in r ? r.text : undefined;
}

const fmt = (v: number) => String(Number(v.toPrecision(4)));

/** The entry a purchased use names, or why not. */
function useEntry(
  doc: ManufaktureDocument,
  useId: string,
): { ok: true; entry: Entry; ref: string } | { ok: false; message: string } {
  const use = mechItems(doc.mech, 'purchased').find((u) => u.id === useId);
  if (use === undefined) return { ok: false, message: `the design has no purchased part ${useId}` };
  const r = resolveEntry(doc, use.entry);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, entry: r.entry, ref: refText(use.entry) };
}

/** A component's entry from the electrical model. */
function componentEntry(
  doc: ManufaktureDocument,
  c: ComponentResult,
): { ok: true; entry: Entry; ref: string } | { ok: false; message: string } {
  if (c.use === undefined)
    return { ok: false, message: `${c.name} (${c.id}) has no purchased part` };
  return useEntry(doc, c.use);
}

/** A cell entry from a pack's `cell` text (`cell/molicel-inr-21700-p45b v1`, or the bare id). */
function cellFromText(t: string | undefined): Entry | undefined {
  if (t === undefined) return undefined;
  const m = /^\s*(\S+?)(?:\s+v(\d+))?\s*$/.exec(t);
  if (m === null) return undefined;
  const e = m[2] !== undefined ? findBuiltin(m[1]!, Number(m[2])) : latestBuiltin(m[1]!);
  return e?.family === 'cell' ? e : undefined;
}

/** The simulation job of one load case, or every input it lacks. */
export function simulationJob(
  ctx: SimContext,
  loadCaseId: string,
  options: JobOptions = {},
): JobResult {
  const doc = ctx.document;
  const settings = ctx.settings ?? DEFAULT_MECH_SETTINGS;
  const missing: SimMissing[] = [];
  const assumptions: string[] = [];
  const warnings: string[] = [];
  const miss = (input: string, message: string) => missing.push({ input, message });
  const assume = (a: string) => assumptions.push(a);

  // The load case.
  const lc: LoadCase | undefined = mechItems(doc.mech, 'loadCases').find(
    (l) => l.id === loadCaseId,
  );
  if (lc === undefined) {
    return {
      ok: false,
      missing: [{ input: 'load case', message: `there is no load case ${loadCaseId}` }],
      warnings,
    };
  }
  if (lc.dynamic === undefined) {
    return {
      ok: false,
      missing: [
        {
          input: 'motion',
          message: `${lc.name} (${lc.id}) has no force law and motion to simulate`,
        },
      ],
      warnings,
    };
  }
  const dyn = resolveDynamic(lc.dynamic, ctx.variables);
  if (!dyn.ok) {
    for (const p of dyn.problems) miss(`load case ${p.path.join('.')}`, p.message);
  }

  // The drivetrain.
  const drivetrains = mechItems(doc.mech, 'drivetrains');
  let dtId = lc.drivetrain;
  if (dtId === undefined) {
    if (drivetrains.length === 1) dtId = drivetrains[0]!.id;
    else
      miss(
        'drivetrain',
        drivetrains.length === 0
          ? 'the design has no drivetrain'
          : `${lc.name} names no drivetrain and the design has ${drivetrains.length}`,
      );
  }
  const dt = dtId === undefined ? undefined : drivetrains.find((d) => d.id === dtId);
  if (dtId !== undefined && dt === undefined) miss('drivetrain', `there is no drivetrain ${dtId}`);
  const analysis =
    dt === undefined
      ? undefined
      : (ctx.drivetrains?.find((a) => a.id === dt.id) ??
        analyseDrivetrain({ document: doc, variables: ctx.variables }, dt));

  let motor: SimMotor | undefined;
  let motorThermal: SimMotorThermal | undefined = options.motorThermal;
  let transmission: SimMachine['transmission'] | undefined;
  if (dt !== undefined && analysis !== undefined) {
    const stage = dt.stages.find((s) => s.kind === 'motor');
    let entry: Entry | undefined;
    if (stage === undefined || stage.kind !== 'motor')
      miss('motor', `${dt.name} has no motor stage`);
    else {
      const e = useEntry(doc, stage.use);
      if (!e.ok) miss('motor', e.message);
      else if (e.entry.family !== 'motor')
        miss('motor', `${stage.use} is a ${e.entry.family}, not a motor`);
      else entry = e.entry;
    }
    // Geared actuators: the internal gear joins the chain's reductions.
    let gearRatio = 1;
    let gearEff = 1;
    if (entry !== undefined) {
      const gr = rating(entry, 'ratio');
      if (gr !== undefined && gr !== 1) {
        const ge = rating(entry, 'gearEfficiency');
        if (ge === undefined)
          miss('motor gear efficiency', 'a geared actuator needs its gear efficiency');
        else {
          gearRatio = gr;
          gearEff = ge;
          assume(
            `The motor's own ${fmt(gr)}:1 gear (efficiency ${fmt(ge)}) is a reduction between the rotor and the drivetrain.`,
          );
        }
      }
    }
    if (analysis.ratio === undefined) miss('drivetrain ratio', 'a reduction’s ratio does not read');
    if (analysis.efficiency === undefined)
      miss('drivetrain efficiency', 'a reduction’s efficiency does not read');
    let inertia: number | undefined;
    if (analysis.inertiaAtMotor === undefined) {
      const why = analysis.elements
        .filter((e) => e.missing !== undefined)
        .map((e) => `${e.name}: ${e.missing}`);
      miss(
        'inertia',
        `the inertia at the motor is unknown${why.length ? ` (${why.join('; ')})` : ''}`,
      );
    } else if (gearRatio === 1) inertia = analysis.inertiaAtMotor;
    else {
      const rotor = analysis.elements.find((e) => e.at === stage?.id)?.value ?? 0;
      inertia = rotor + (analysis.inertiaAtMotor - rotor) / (gearRatio * gearRatio);
    }
    for (const e of analysis.elements) {
      if (e.source === 'none') assume(`${e.name}: ${e.from}.`);
    }

    // The output's effective radius.
    let radius: SimRadius | undefined;
    let outputEff = 1;
    const o = dt.output;
    if (o.kind === 'spool') {
      const steps = analysis.spool?.steps;
      if (steps === undefined || steps.length === 0) {
        miss(
          'spool radius',
          'the spool’s winding is not known (its cable, core, width and cable length must read)',
        );
      } else {
        radius = {
          kind: 'steps',
          steps: steps.map((s) => ({ from: s.from, to: s.to, radius: s.radius })),
        };
        assume(
          'The effective radius steps down one cable diameter as each layer empties, blended over one turn of cable.',
        );
      }
    } else if (o.kind === 'linear') {
      const lead = siValue(o.lead, 'length', ctx.variables);
      const eff = siValue(o.efficiency, 'number', ctx.variables);
      if (!lead.ok || !(lead.value > 0))
        miss('screw lead', lead.ok ? 'the lead must be above 0' : lead.message);
      if (!eff.ok || !(eff.value > 0 && eff.value <= 1))
        miss('screw efficiency', eff.ok ? 'the efficiency is above 0 and at most 1' : eff.message);
      if (lead.ok && eff.ok) {
        radius = { kind: 'constant', radius: lead.value / (2 * Math.PI) };
        outputEff = eff.value;
        assume(
          'The screw is an effective radius of lead / 2π with its efficiency; the force is the carriage’s thrust and the motion its travel.',
        );
      }
    } else {
      miss('output', 'a rotary output has no cable force to simulate; use a spool or a screw');
    }

    if (entry !== undefined) {
      const kt = motorTorqueConstant(entry);
      const r = motorResistance(entry);
      const l = motorInductance(entry);
      if (!kt.ok) miss('motor Kt', kt.message);
      if (!r.ok) miss('motor resistance', r.message);
      let ind = 0;
      if (l.ok) ind = l.value;
      else if (options.electrical === 'full') miss('motor inductance', l.message);
      else
        assume('No winding inductance: the voltage the motor needs leaves out its inductive drop.');
      let poles = rating(entry, 'polePairs');
      if (poles === undefined) {
        if (options.electrical === 'full')
          miss('motor pole pairs', 'the full electrical mode needs the pole pairs');
        else assume('No pole pairs: the voltage the motor needs leaves out its inductive drop.');
        poles = 0;
      }
      if (kt.ok) {
        assume(kt.derivation + (kt.estimated ? ' (estimated)' : '') + '.');
        const kv = motorVelocityConstant(entry);
        if (kv.ok && !kt.derived) {
          const fromKv = Math.sqrt(3) / 2 / kv.value;
          const diff = Math.abs(kt.value / fromKv - 1);
          if (diff > KT_KV_TOLERANCE) {
            warnings.push(
              `The motor's Kt (${fmt(kt.value)} N*m/A) and Kv (${fmt((kv.value * 60) / (2 * Math.PI))} rpm/V) disagree by ${Math.round(diff * 100)} %: Kt should be about ${fmt(KT_KV_PRODUCT)} / Kv = ${fmt(fromKv)} N*m/A. The simulation uses Kt; check both against the datasheet.`,
            );
          }
        }
      }
      if (r.ok) assume(r.derivation + (r.estimated ? ' (estimated)' : '') + '.');
      // Losses: drag torques, else the no-load current split half constant, half viscous.
      let coulomb = 0;
      let viscous = 0;
      const drag = rating(entry, 'dragTorque');
      const visc = rating(entry, 'viscousDrag');
      const i0 = rating(entry, 'noLoadCurrent');
      const n0 = rating(entry, 'noLoadSpeed');
      if (drag !== undefined || visc !== undefined) {
        coulomb = drag ?? 0;
        viscous = visc ?? 0;
        assume(
          `Motor friction and iron loss from the catalog's loss torques: ${fmt(coulomb)} N*m constant, ${fmt(viscous)} N*m*s/rad with speed.`,
        );
      } else if (i0 !== undefined && n0 !== undefined && n0 > 0 && kt.ok) {
        // Kt x I0 in the catalog's own convention and side; a geared actuator's no-load speed is
        // at its output. Both go to the rotor: an output-side torque over the ratio, the speed
        // times it.
        const ktRated = Object.hasOwn(entry.ratings, 'kt') ? entry.ratings.kt : undefined;
        const ktGiven = ktRated !== undefined && 'value' in ktRated ? ktRated : undefined;
        const outputSide = ktGiven?.convention?.endsWith(OUTPUT_SIDE) === true;
        let t0 = (ktGiven?.value ?? kt.value) * i0;
        let w0 = n0;
        if (gearRatio !== 1) {
          if (outputSide) t0 /= gearRatio;
          w0 = n0 * gearRatio;
        }
        coulomb = t0 / 2;
        viscous = t0 / 2 / w0;
        assume(
          `Motor friction and iron loss from the no-load current: ${fmt(t0)} N*m at the rotor (Kt x I0, in the catalog's own convention${gearRatio !== 1 && outputSide ? ', over the gear ratio from the output side' : ''}) at ${fmt(w0)} rad/s at the rotor${gearRatio !== 1 ? ' (the no-load speed taken at the output, times the gear ratio)' : ''}, half constant and half with speed.`,
        );
      } else {
        assume(
          'No loss torque or no-load current in the catalog: motor friction and iron loss are left out.',
        );
      }
      if (kt.ok && r.ok) {
        motor = {
          kt: kt.value,
          resistance: r.value,
          inductance: ind,
          polePairs: poles,
          frictionCoulomb: coulomb,
          frictionViscous: viscous,
          ironHysteresis: 0,
          ironEddy: 0,
          copperAlpha: COPPER_ALPHA,
          magnetAlpha: NDFEB_ALPHA,
          reference: CATALOG_REFERENCE,
        };
        const rotor = rating(entry, 'rotorInertia');
        if (rotor !== undefined) motor.rotorInertia = rotor;
        assume(
          'Commutation is modelled as field-oriented control (sinusoidal currents); a six-step (block-commutated) drive has about 9 % more copper loss for the same torque, which this understates.',
        );
        assume(
          `Copper resistance rises ${COPPER_ALPHA * 100} % per K and Kt falls ${-NDFEB_ALPHA * 100} % per K of housing temperature (NdFeB), from their catalog values at 25 °C.`,
        );
      }
      // Thermal: C_w = τ_w / R_wh, R_ha = R_th - R_wh, C_h = τ_h / R_ha.
      if (motorThermal === undefined) {
        const rwh = rating(entry, 'windingHousingResistance');
        const rth = rating(entry, 'thermalResistance');
        const tw = rating(entry, 'thermalTimeConstant');
        const th = rating(entry, 'housingTimeConstant');
        if (
          rwh !== undefined &&
          rth !== undefined &&
          tw !== undefined &&
          th !== undefined &&
          rth > rwh
        ) {
          motorThermal = {
            windingCapacity: tw / rwh,
            windingToHousing: rwh,
            housingCapacity: th / (rth - rwh),
            housingToAmbient: rth - rwh,
          };
          assume(
            'The winding and housing heat capacities are the catalog time constants over their thermal resistances, for the maker’s test mounting.',
          );
        } else {
          assume(
            'The motor’s thermal data is incomplete (winding to housing and to ambient resistances, both time constants): its temperatures are not simulated and the winding stays at ambient.',
          );
        }
      }
    }
    if (
      radius !== undefined &&
      analysis.ratio !== undefined &&
      analysis.efficiency !== undefined &&
      inertia !== undefined
    ) {
      transmission = {
        radius,
        ratio: analysis.ratio * gearRatio,
        efficiency: analysis.efficiency * gearEff * outputEff,
        cableEfficiency: options.cableEfficiency ?? 1,
        inertia,
      };
      if (options.cableEfficiency === undefined && o.kind === 'spool') {
        assume('The cable path (fairlead, bends, the spool’s bearings) loses nothing.');
      }
      assume(
        'The inertia is reflected to the rotor without the reductions’ losses on its acceleration torque; the chain is rigid.',
      );
    }
  }

  // The electrical system.
  const el = ctx.electrical ?? analyseElectrical({ document: doc, variables: ctx.variables });
  const byRole = (role: string) => el.components.filter((c) => c.role === role);
  const components: SimComponents = {};

  let pack: SimPack | undefined;
  let nominal: number | undefined;
  const packs = byRole('pack');
  if (packs.length !== 1) {
    miss(
      'pack',
      packs.length === 0
        ? 'the electrical system has no pack'
        : `the electrical system has ${packs.length} packs; the simulation models one`,
    );
  } else {
    const pe = componentEntry(doc, packs[0]!);
    if (!pe.ok) miss('pack', pe.message);
    else {
      const p = readPack(pe.entry, pe.ref, miss, assume);
      if (p !== undefined) {
        pack = p.pack;
        nominal = p.nominal;
        if (options.packThermal !== undefined) pack.thermal = options.packThermal;
        else assume('The pack’s temperature is not simulated.');
      }
    }
  }

  let controller: SimController | undefined;
  const ctls = byRole('controller');
  if (ctls.length !== 1) {
    miss(
      'controller',
      ctls.length === 0
        ? 'the electrical system has no motor controller'
        : `the electrical system has ${ctls.length} motor controllers; the simulation models one`,
    );
  } else {
    components.controller = ctls[0]!.id;
    const ce = componentEntry(doc, ctls[0]!);
    if (!ce.ok) miss('controller', ce.message);
    else controller = readController(ce.entry, options.controller ?? {}, assume);
  }

  let brake: SimBrake | undefined;
  const res = byRole('brake-resistor');
  if (res.length > 1)
    miss(
      'braking resistor',
      `the electrical system has ${res.length} braking resistors; the simulation models one`,
    );
  else if (res.length === 1) {
    components.resistor = res[0]!.id;
    const re = componentEntry(doc, res[0]!);
    if (!re.ok) miss('braking resistor', re.message);
    else {
      const ohm = rating(re.entry, 'resistance');
      if (ohm === undefined || !(ohm > 0))
        miss('braking resistor', `${re.ref} gives no resistance`);
      else {
        brake = { resistance: ohm };
        assume(
          `The braking resistor (${fmt(ohm)} ohm) is on an ideal chopper: it takes whatever the pack does not accept, up to V²/R.`,
        );
        const rth = rating(re.entry, 'thermalResistance');
        const tau = rating(re.entry, 'thermalTimeConstant');
        if (rth !== undefined && tau !== undefined && rth > 0) {
          brake.thermal = { capacity: tau / rth, toAmbient: rth };
          assume(
            'The resistor is one thermal node: heat capacity its time constant over its thermal resistance.',
          );
        } else
          assume(
            'The braking resistor’s temperature is not simulated (no thermal resistance and time constant).',
          );
      }
    }
  } else {
    assume(
      'There is no braking resistor: regenerated power the pack does not accept is counted as unabsorbed.',
    );
  }
  const chop = byRole('chopper');
  if (chop.length === 1) components.chopper = chop[0]!.id;

  let aux = 0;
  for (const c of el.components) {
    if (c.load?.current === undefined) continue;
    const v = c.load.voltage ?? nominal;
    if (v === undefined) continue;
    aux += c.load.current * v;
  }
  if (aux > 0) {
    assume(
      `Always-on loads ${fmt(aux)} W: each typed load current times its voltage (the pack's nominal voltage where none is typed), converters lossless.`,
    );
  }

  if (
    missing.length > 0 ||
    !dyn.ok ||
    motor === undefined ||
    transmission === undefined ||
    pack === undefined ||
    controller === undefined
  ) {
    return { ok: false, missing, warnings };
  }
  const d = dyn.value;
  const profile = simProfile(d, {
    ...(options.ramp !== undefined ? { ramp: options.ramp } : {}),
    ...(options.oneRep ? { oneRep: true } : {}),
  });
  if (!profile.ok)
    return { ok: false, missing: [{ input: 'motion', message: profile.message }], warnings };

  const ambient = d.ambient ?? settings.ambient;
  const soc = d.startCharge ?? 1;
  if (d.startCharge === undefined)
    assume('The run starts with the pack full (the load case gives no start charge).');
  assume('The motor, pack and resistor start at the ambient temperature.');
  const full = options.electrical === 'full';
  const machine: SimMachine = {
    motor,
    transmission,
    controller,
    pack,
    aux,
    ambient,
    ...(motorThermal !== undefined ? { motorThermal } : {}),
    ...(brake !== undefined ? { brake } : {}),
  };
  const job: SimJob = {
    machine,
    law: d.law,
    segments: profile.segments,
    start: { soc },
    options: {
      dt: full ? settings.simulation.transientStep : settings.simulation.step,
      electrical: full ? 'full' : 'quasi-static',
      budgetMs: options.budgetMs ?? settings.simulation.budget * 1000,
      ...(options.record !== undefined ? { record: options.record } : {}),
    },
    components,
  };
  return { ok: true, job, assumptions, warnings };
}

/** A pack (or a single cell) entry as the simulation's pack. */
function readPack(
  e: Entry,
  ref: string,
  miss: (input: string, message: string) => void,
  assume: (a: string) => void,
): { pack: SimPack; nominal?: number } | undefined {
  if (e.family === 'cell') {
    const built = buildPack(e, { series: 1, parallel: 1 });
    if (!built.ok) {
      miss('pack', built.message);
      return undefined;
    }
    const b = built.pack;
    let ok = true;
    for (const [what, v] of [
      ['capacity', b.capacity],
      ['resistance', b.resistance],
    ] as const) {
      if (!v.ok) {
        miss(`pack ${what}`, v.message);
        ok = false;
      }
    }
    if (!b.ocv.ok) {
      miss('pack OCV curve', b.ocv.message);
      ok = false;
    }
    if (!ok || !b.capacity.ok || !b.resistance.ok || !b.ocv.ok) return undefined;
    assume(`The pack is one cell, ${ref}; ${b.ocv.derivation}.`);
    const pack: SimPack = {
      ocv: b.ocv.points.map((p) => ({ soc: p.soc, voltage: p.voltage })),
      capacity: b.capacity.value,
      resistance: b.resistance.value,
      taperStart: CHARGE_TAPER_START,
      ...(b.maxChargeCurrent.ok ? { chargeLimit: b.maxChargeCurrent.value } : {}),
      ...(b.emptyVoltage.ok ? { cutoff: b.emptyVoltage.value } : {}),
    };
    chargeAssumption(pack, assume);
    return { pack, ...(b.nominalVoltage.ok ? { nominal: b.nominalVoltage.value } : {}) };
  }
  if (e.family !== 'pack') {
    miss('pack', `${ref} is a ${e.family}, not a pack or a cell`);
    return undefined;
  }
  const capacity = rating(e, 'capacity');
  const resistance = rating(e, 'resistance');
  const series = rating(e, 'series');
  const full = rating(e, 'fullVoltage');
  const nominal = rating(e, 'nominalVoltage');
  if (capacity === undefined || !(capacity > 0)) miss('pack capacity', `${ref} gives no capacity`);
  if (resistance === undefined || resistance < 0)
    miss('pack resistance', `${ref} gives no DC internal resistance`);
  // OCV: the named cell's curve, else the generic curve of the chemistry the full voltage suggests.
  let ocv: OcvPoint[] | undefined;
  const cell = cellFromText(text(e, 'cell'));
  if (series === undefined || !(series >= 1))
    miss('pack series', `${ref} gives no cells in series, which the OCV curve needs`);
  else if (cell !== undefined) {
    const c = cellOcvCurve(cell);
    if (c.ok) {
      ocv = c.points.map((p) => ({ soc: p.soc, voltage: series * p.voltage }));
      assume(`The pack's OCV curve is ${series} in series x ${c.derivation}.`);
    } else miss('pack OCV curve', c.message);
  } else if (full !== undefined) {
    const perCell = full / series;
    const family: keyof typeof GENERIC_OCV = perCell >= 3.9 ? 'layered oxide' : 'LFP';
    ocv = OCV_SOC_PERCENT.map((p, i) => ({
      soc: p / 100,
      voltage: series * GENERIC_OCV[family][i]!,
    }));
    assume(
      `The pack's cell is not in the catalog, so its OCV curve is the generic ${family} curve (from ${fmt(perCell)} V a cell at full), ${series} in series; enter the cell for its own.`,
    );
  } else {
    miss(
      'pack OCV curve',
      `${ref} names no catalog cell and gives no full voltage to choose a generic curve by`,
    );
  }
  if (ocv === undefined || capacity === undefined || resistance === undefined) return undefined;
  const charge = rating(e, 'maxChargeCurrent');
  const empty = rating(e, 'emptyVoltage');
  const pack: SimPack = {
    ocv,
    capacity,
    resistance,
    taperStart: CHARGE_TAPER_START,
    ...(charge !== undefined ? { chargeLimit: charge } : {}),
    ...(empty !== undefined ? { cutoff: empty } : {}),
  };
  chargeAssumption(pack, assume);
  if (empty === undefined) assume('The pack gives no empty voltage: its cutoff is not watched.');
  return { pack, ...(nominal !== undefined ? { nominal } : {}) };
}

function chargeAssumption(pack: SimPack, assume: (a: string) => void): void {
  if (pack.chargeLimit === undefined) {
    assume('The pack gives no charge current limit: it accepts every regenerated watt.');
  } else {
    assume(
      `The pack accepts up to ${fmt(pack.chargeLimit)} A of charge, falling linearly to none between ${CHARGE_TAPER_START * 100} % and 100 % charge.`,
    );
  }
}

/** A controller entry, with what the run assumes for the values no maker publishes. */
function readController(
  e: Entry,
  over: Partial<SimController>,
  assume: (a: string) => void,
): SimController {
  const peak = rating(e, 'peakPhaseCurrent');
  const cont = rating(e, 'continuousPhaseCurrent');
  const limit = over.currentLimit ?? peak ?? cont;
  if (over.currentLimit === undefined) {
    if (peak !== undefined)
      assume(`The controller's current limit is its peak phase current, ${fmt(peak)} A.`);
    else if (cont !== undefined)
      assume(
        `The controller's current limit is its continuous phase current, ${fmt(cont)} A (no peak given).`,
      );
    else assume('The controller gives no phase current rating: the current is not limited.');
  }
  const loss = (
    field: string,
    key: 'fixedLoss' | 'legResistance' | 'switchingTime',
    what: string,
  ) => {
    if (over[key] !== undefined) return over[key];
    const v = rating(e, field);
    if (v === undefined) assume(`The controller gives no ${what}: none is counted.`);
    return v ?? 0;
  };
  const fixedLoss = loss('fixedLoss', 'fixedLoss', 'fixed loss');
  const legResistance = loss('legResistance', 'legResistance', 'conduction resistance');
  const switchingTime = loss('switchingTime', 'switchingTime', 'switching time');
  const switchingFrequency = over.switchingFrequency ?? rating(e, 'pwmFrequency') ?? 0;
  if (over.modulation === undefined) {
    assume(
      `The largest voltage vector is ${DEFAULT_MODULATION} of Vbus/√3 (space-vector modulation; the catalog gives none).`,
    );
  }
  return {
    ...(limit !== undefined ? { currentLimit: limit } : {}),
    modulation: over.modulation ?? DEFAULT_MODULATION,
    loopHz: over.loopHz ?? DEFAULT_LOOP_HZ,
    fixedLoss,
    legResistance,
    switchingTime,
    switchingFrequency,
  };
}
