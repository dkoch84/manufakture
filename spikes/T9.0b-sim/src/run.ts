// Runs every case of the spike and writes the raw results to results/. Run from the repository
// root with `node spikes/T9.0b-sim/src/run.ts` (Node 26 strips the types).

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareWinding,
  curveError,
  FAULHABER_4221_BXT_H,
  MAXON_EC90_FLAT,
  motorFromDatasheet,
} from './datasheets.ts';
import {
  cellOcvIntegral,
  packEnergy,
  simulate,
  torqueConstant,
  type Machine,
  type SimOptions,
  type SimResult,
} from './model.ts';
import { BELT, DIRECT, FORCE_MAX, hold, LBF, PACK, REP, reps, session } from './trainer.ts';

const RESULTS = fileURLToPath(new URL('../results', import.meta.url));

function machineInfo() {
  return {
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    date: new Date().toISOString().slice(0, 10),
  };
}

function write(name: string, data: object): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, `${name}.json`),
    `${JSON.stringify({ machine: machineInfo(), ...data }, null, 2)}\n`,
  );
  console.log(`wrote results/${name}.json`);
}

const r = (x: number, d = 3): number => Number(x.toFixed(d));

/** Rounded copy of a result without its time series. */
function summary(res: SimResult, ms: number) {
  const round = (o: Record<string, number>, d = 3) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r(v, d)]));
  return {
    runtimeMs: Math.round(ms),
    steps: res.steps,
    ledgerJ: {
      ...round(res.ledger as unknown as Record<string, number>, 3),
      residualRelative: Number(res.ledger.residualRelative.toExponential(3)),
    },
    thermalJ: round(res.thermal as unknown as Record<string, number>, 4),
    phases: Object.fromEntries(
      Object.entries(res.phases).map(([k, v]) => [
        k,
        round(v as unknown as Record<string, number>),
      ]),
    ),
    end: round(res.end, 4),
    peaks: round(res.peaks, 3),
    flags: res.flags,
    forceErrorN: round(res.forceError, 3),
  };
}

function run(
  m: Machine,
  profile: Parameters<typeof simulate>[1],
  opts: SimOptions,
): { res: SimResult; ms: number } {
  const t = performance.now();
  const res = simulate(m, profile, opts);
  return { res, ms: performance.now() - t };
}

const FULL: Omit<SimOptions, 'soc'> = { dt: 50e-6, theta: 0.5, electrical: 'full' };

function trainerCase(m: Machine) {
  const motor = m.motor;
  const kt = torqueConstant(motor);
  const shaftTorque = (FORCE_MAX * m.drivetrain.spoolRadius) / m.drivetrain.ratio;
  const holdCurrent = shaftTorque / kt;
  const holdCopper = 1.5 * motor.rPhase * holdCurrent * holdCurrent;

  const set = run(m, reps(10), { ...FULL, soc: 0.5 });
  const pull = set.res.phases.pull!;
  const ret = set.res.phases.return!;
  const perRep = {
    userWorkPullJ: r(pull.userWork / 10, 1),
    busReturnedPerPullJ: r(pull.busReturned / 10, 1),
    busReturnedPeakW: r(pull.busReturnedPeakW, 0),
    busReturnedMeanOverPullW: r(pull.busReturnedMeanW, 0),
    packAcceptedPerPullJ: r(pull.packCharged / 10, 1),
    resistorPerPullJ: r(pull.resistor / 10, 1),
    copperPerRepJ: r(set.res.ledger.copper / 10, 1),
    returnBusDrawPerRepJ: r(ret.busEnergy / 10, 1),
    machineWorkOnUserPerReturnJ: r(-ret.userWork / 10, 1),
    packChemicalPerRepJ: r(set.res.ledger.packChemical / 10, 1),
  };

  const h = run(m, hold(30), { ...FULL, soc: 0.5 });
  const sess = run(m, session(), { ...FULL, soc: 0.5 });
  // The same session if the pack accepted every regenerated watt (no charge limit), to show what
  // the acceptance limit costs.
  const open = simulate({ ...m, pack: { ...m.pack, chargeLimit: 1e6, taperStart: 1 } }, session(), {
    dt: 1e-3,
    theta: 0.5,
    electrical: 'quasi-static',
    soc: 0.5,
  });

  const socs = [1.0, 0.5, 0.1].map((soc) => {
    const x = run(m, reps(10), { ...FULL, soc });
    return {
      soc,
      resistorPerPullJ: r(x.res.phases.pull!.resistor / 10, 1),
      packAcceptedPerPullJ: r(x.res.phases.pull!.packCharged / 10, 1),
      packChemicalPerRepJ: r(x.res.ledger.packChemical / 10, 1),
      minTerminalV: r(x.res.peaks.minTerminalV, 2),
      maxTerminalV: r(x.res.peaks.maxTerminalV, 2),
      peakPackDischargeA: r(x.res.peaks.packDischargeA, 2),
      belowCutoffSteps: x.res.flags.belowCutoff,
    };
  });

  // Sessions per charge: back-to-back max sessions from a full pack, the motor cooled between them,
  // quasi-static electrics at 1 ms (see convergence.json for what that costs in accuracy).
  const perCharge: {
    session: number;
    socStart: number;
    socEnd: number;
    packWh: number;
    minTerminalV: number;
    belowCutoffSteps: number;
  }[] = [];
  let soc = 1.0;
  for (let s = 1; s <= 40 && soc > 0; s++) {
    const x = simulate(m, session(), { dt: 1e-3, theta: 0.5, electrical: 'quasi-static', soc });
    perCharge.push({
      session: s,
      socStart: r(soc, 4),
      socEnd: r(x.end.soc, 4),
      packWh: r(x.ledger.packChemical / 3600, 3),
      minTerminalV: r(x.peaks.minTerminalV, 2),
      belowCutoffSteps: x.flags.belowCutoff,
    });
    soc = x.end.soc;
    if (x.flags.belowCutoff > 0) break;
  }
  const completed = perCharge.filter((p) => p.belowCutoffSteps === 0 && p.socEnd > 0).length;

  // Energy per rep against force, the same rep at 200, 100 and 60 lbf: the ratio between 100 and
  // 60 lbf can be set against the Voltra's published sessions per charge at those forces.
  const forceSweep = [200, 100, 60].map((lbf) => {
    const x = simulate(m, reps(10, { ...REP, force: lbf * LBF }), {
      dt: 1e-3,
      theta: 0.5,
      electrical: 'quasi-static',
      soc: 0.5,
    });
    return {
      lbf,
      packChemicalPerRepJ: r(x.ledger.packChemical / 10, 1),
      copperPerRepJ: r(x.ledger.copper / 10, 1),
      resistorPerRepJ: r(x.ledger.resistor / 10, 1),
      packAcceptedPerPullJ: r(x.phases.pull!.packCharged / 10, 1),
    };
  });

  return {
    machine: m,
    closedForm: {
      shaftTorqueNm: r(shaftTorque, 3),
      holdCurrentA: r(holdCurrent, 3),
      holdCopperW25C: r(holdCopper, 2),
      reflectedInertiaKgM2: r(
        m.motor.inertia + m.drivetrain.spoolInertia / m.drivetrain.ratio ** 2,
        6,
      ),
      inertiaAtSpoolKgM2: r(
        m.motor.inertia * m.drivetrain.ratio ** 2 + m.drivetrain.spoolInertia,
        6,
      ),
      peakShaftSpeedRadS: r((1.5 * m.drivetrain.ratio) / m.drivetrain.spoolRadius, 2),
      peakMechanicalW: r(FORCE_MAX * 1.5, 1),
    },
    set10: { perRep, ...summary(set.res, set.ms) },
    hold30: summary(h.res, h.ms),
    session: { packWh: r(sess.res.ledger.packChemical / 3600, 3), ...summary(sess.res, sess.ms) },
    sessionUnlimitedAcceptance: {
      packWh: r(open.ledger.packChemical / 3600, 3),
      resistorJ: r(open.ledger.resistor, 1),
      packResistanceJ: r(open.ledger.packResistance, 1),
      peakChargeA: r(open.peaks.packChargeA, 2),
    },
    socVariants: socs,
    perCharge: { completed, sessions: perCharge },
    forceSweep,
  };
}

function convergence() {
  const profile = reps(10);
  const ref = run(DIRECT, profile, { dt: 10e-6, theta: 0.5, electrical: 'full', soc: 0.5 });
  const pick = (x: SimResult) => ({
    copper: x.ledger.copper,
    resistor: x.ledger.resistor,
    packChemical: x.ledger.packChemical,
    tWindingEnd: x.end.tWinding,
  });
  const refV = pick(ref.res);
  const rows = [];
  const cases: { electrical: 'full' | 'quasi-static'; theta: number; dt: number }[] = [];
  for (const theta of [0.5, 1]) {
    for (const dt of [200e-6, 100e-6, 50e-6, 25e-6, 10e-6])
      cases.push({ electrical: 'full', theta, dt });
    for (const dt of [10e-3, 1e-3, 100e-6]) cases.push({ electrical: 'quasi-static', theta, dt });
  }
  for (const c of cases) {
    const x = run(DIRECT, profile, { ...c, soc: 0.5 });
    const v = pick(x.res);
    rows.push({
      ...c,
      dtUs: r(c.dt * 1e6, 1),
      runtimeMs: Math.round(x.ms),
      residualRelative: Number(x.res.ledger.residualRelative.toExponential(3)),
      residualJ: r(x.res.ledger.residual, 6),
      copperJ: r(v.copper, 3),
      resistorJ: r(v.resistor, 3),
      packChemicalJ: r(v.packChemical, 3),
      tWindingEnd: r(v.tWindingEnd, 4),
      errVsRef: {
        copper: Number(((v.copper - refV.copper) / refV.copper).toExponential(2)),
        resistor: Number(((v.resistor - refV.resistor) / refV.resistor).toExponential(2)),
        packChemical: Number(
          ((v.packChemical - refV.packChemical) / refV.packChemical).toExponential(2),
        ),
        tRiseWinding: Number(
          ((v.tWindingEnd - refV.tWindingEnd) / (refV.tWindingEnd - 25)).toExponential(2),
        ),
      },
      forceErrorMaxN: r(x.res.forceError.maxAbs, 2),
      voltageLimitedSteps: x.res.flags.voltageLimited,
    });
  }
  return {
    profile: '10 reps at 200 lbf, direct drive, SoC 0.5',
    reference: { dtUs: 10, theta: 0.5, electrical: 'full', ...refV },
    rows,
  };
}

function sensitivity() {
  const rows = [];
  for (const cw of [0.5, 1, 2]) {
    for (const rwh of [0.5, 1, 2]) {
      const m: Machine = {
        ...DIRECT,
        thermal: {
          ...DIRECT.thermal,
          cWinding: DIRECT.thermal.cWinding * cw,
          rWindingHousing: DIRECT.thermal.rWindingHousing * rwh,
        },
      };
      const h = simulate(m, hold(30), {
        dt: 1e-3,
        theta: 0.5,
        electrical: 'quasi-static',
        soc: 0.5,
      });
      const s = simulate(m, reps(10), {
        dt: 1e-3,
        theta: 0.5,
        electrical: 'quasi-static',
        soc: 0.5,
      });
      rows.push({
        cWinding: m.thermal.cWinding,
        rWindingHousing: m.thermal.rWindingHousing,
        tWindingHold30: r(h.end.tWinding, 2),
        tWindingAfter10Reps: r(s.end.tWinding, 2),
      });
    }
  }
  return { machine: 'direct drive', rows };
}

function oneRepSeries() {
  const x = simulate(DIRECT, reps(1), { ...FULL, soc: 0.5, recordEvery: 1e-3 });
  const s = x.series!;
  const keys = Object.keys(s);
  const lines = [keys.join(',')];
  for (let i = 0; i < s.t!.length; i++)
    lines.push(keys.map((k) => Number(s[k]![i]!.toPrecision(6))).join(','));
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'rep-direct.csv'), `${lines.join('\n')}\n`);
  console.log('wrote results/rep-direct.csv');
}

function datasheets() {
  return {
    lossSplit: 'no-load loss torque k·I0 split half constant, half proportional to speed',
    sheets: [MAXON_EC90_FLAT, FAULHABER_4221_BXT_H].map((ds) => ({
      maker: ds.maker,
      model: ds.model,
      source: ds.source,
      url: ds.url,
      notes: ds.notes,
      windings: ds.windings.map((w) => {
        const cmp = compareWinding(ds, w);
        const curve = curveError(ds, w);
        return {
          id: w.id,
          modelMotor: motorFromDatasheet(ds, w),
          comparisons: cmp.map((c) => ({
            ...c,
            published: r(c.published, 5),
            model: r(c.model, 5),
            error: r(c.error, 5),
          })),
          curve: {
            maxSpeedErrorOfNoLoad: r(curve.maxSpeedError, 5),
            maxEfficiencyErrorPoints: r(curve.maxEfficiencyErrorPoints, 3),
            rows: curve.rows.map((x) => ({
              torque: r(x.torque, 4),
              speedPublishedRpm: r(x.speedPublishedRpm, 1),
              speedModelRpm: r(x.speedModelRpm, 1),
              etaPublished: r(x.etaPublished, 4),
              etaModel: r(x.etaModel, 4),
            })),
          },
        };
      }),
    })),
  };
}

const only = process.argv[2];
if (!only || only === 'trainer') {
  write('trainer', {
    rep: REP,
    pack: {
      ...PACK,
      nominalV: 57.6,
      ratedWh: 97.9,
      chemicalWhFromCurve: r(packEnergy(PACK, 1) / 3600, 2),
      meanCellOcv: r(cellOcvIntegral(PACK, 1), 4),
    },
    direct: trainerCase(DIRECT),
    belt: trainerCase(BELT),
  });
}
if (!only || only === 'convergence') write('convergence', convergence());
if (!only || only === 'sensitivity') write('sensitivity', sensitivity());
if (!only || only === 'datasheets') write('datasheets', datasheets());
if (!only || only === 'series') oneRepSeries();
