// A cell's open-circuit voltage curve and the pack builder (T9.2c; ADR 0017 decision 7; T9.0c's
// pack fields). Pure functions over a cell entry's ratings that derive what the simulation (T9.4b)
// and the electrical and thermal checks (T9.5f, T9.5g) read, each value with its working in words
// for a calc record to cite, in the shape of `Normalised` (`./conventions`). They never guess: a
// value whose input is missing is `{ ok: false, missing }`, naming the cell fields.
//
// The pack, for `series` cells in series and `parallel` in parallel:
// - voltages (nominal, full, empty, and the OCV curve) are `series` times the cell's;
// - capacity and current limits (continuous and peak discharge, maximum charge) are `parallel`
//   times the cell's, assuming the parallel cells share current equally;
// - energy is nominal voltage times rated capacity, the figure the airline 100 Wh rule reads;
// - DC resistance is `series * R_cell / parallel` plus the interconnects (given for the whole pack
//   or per joint between series groups, `series - 1` of them);
// - mass is the cells' plus the enclosure's (everything but the cells: interconnects, wiring,
//   BMS, housing), and heat capacity the cells' own (mass times specific heat).
//
// A cell's OCV curve is its `ocv0` to `ocv100` fields when both ends are given (points in between
// may be missing; a partial curve without both ends is refused, not padded), else the generic curve
// of its chemistry, marked `generic` and `estimated`. The generic layered-oxide curve tops out at
// 4.19 V at rest, the usual rest voltage of a 4.2 V cell; it is not rescaled for cells charged to
// another voltage (4.35 V LCO), whose own points should be entered.

import type { CatalogEntry, Rated } from '@manufakture/core';
import { OCV_SOC_PERCENT, ocvField } from '../parts/families';
import type { Normalised } from './conventions';

/** What these functions read of a cell entry: its family, ratings and mass. */
export type CellRatings = Pick<CatalogEntry, 'family' | 'ratings' | 'mass'>;

/** One point of an open-circuit voltage curve: state of charge from 0 to 1, volts. */
export interface OcvPoint {
  soc: number;
  voltage: number;
}

export type OcvCurve =
  | {
      ok: true;
      /** In order of rising state of charge, from 0 to 1. */
      points: readonly OcvPoint[];
      derivation: string;
      /** The chemistry's generic curve, not the cell's own. */
      generic?: true;
      /** A generic curve, or a point marked as an estimate. */
      estimated?: true;
    }
  | { ok: false; missing: string[]; message: string };

/**
 * Generic open-circuit voltage curves per chemistry family at `OCV_SOC_PERCENT`, volts per cell,
 * at rest and room temperature: typical shapes of published curves, not any one cell's. Layered
 * oxides (NMC, NCA, LCO) slope across the whole range; LFP is flat through the middle.
 */
export const GENERIC_OCV = {
  'layered oxide': [3.0, 3.35, 3.47, 3.56, 3.62, 3.67, 3.73, 3.81, 3.9, 3.98, 4.07, 4.12, 4.19],
  LFP: [2.9, 3.15, 3.22, 3.26, 3.29, 3.3, 3.3, 3.31, 3.32, 3.33, 3.34, 3.36, 3.45],
} as const satisfies Record<string, readonly number[]>;

const GENERIC_FOR: Readonly<Record<string, keyof typeof GENERIC_OCV>> = {
  NMC: 'layered oxide',
  NCA: 'layered oxide',
  LCO: 'layered oxide',
  LFP: 'LFP',
};

function num(v: number): string {
  return String(Number(v.toPrecision(4)));
}

type Given = { value: number; estimated?: true };

function given(rated: Rated | undefined): Given | undefined {
  return rated !== undefined && 'value' in rated ? rated : undefined;
}

function textOf(rated: Rated | undefined): string | undefined {
  return rated !== undefined && 'text' in rated ? rated.text : undefined;
}

function missing(fields: string[], message: string): Normalised {
  return { ok: false, missing: fields, message };
}

function ok(value: number, derivation: string, estimated: boolean): Normalised {
  return { ok: true, value, derivation, ...(estimated ? { estimated: true as const } : {}) };
}

/** A cell rating, or why not (a `Normalised`, always `ok: false`). */
function cellValue(cell: CellRatings, field: string, label: string): Given | Normalised {
  const r = given(cell.ratings[field]);
  return r ?? missing([field], `the cell has no ${label}`);
}

const isMissing = (v: Given | Normalised): v is Normalised => 'ok' in v;

/** The open-circuit voltage at a state of charge (0 to 1), linear between points, clamped. */
export function ocvAt(points: readonly OcvPoint[], soc: number): number {
  if (points.length === 0) return NaN;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (soc <= first.soc) return first.voltage;
  if (soc >= last.soc) return last.voltage;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (soc <= b.soc) {
      const a = points[i - 1]!;
      return a.voltage + ((b.voltage - a.voltage) * (soc - a.soc)) / (b.soc - a.soc);
    }
  }
  return last.voltage;
}

/** A cell's open-circuit voltage curve: its own points, or its chemistry's generic curve. */
export function cellOcvCurve(cell: CellRatings): OcvCurve {
  if (cell.family !== 'cell') {
    return { ok: false, missing: [], message: `a ${cell.family} has no cell OCV curve` };
  }
  const own: OcvPoint[] = [];
  let estimated = false;
  for (const p of OCV_SOC_PERCENT) {
    const r = given(cell.ratings[ocvField(p)]);
    if (r === undefined) continue;
    own.push({ soc: p / 100, voltage: r.value });
    if (r.estimated) estimated = true;
  }
  if (own.length > 0) {
    const ends = [0, 100].filter((p) => !own.some((o) => o.soc === p / 100)).map(ocvField);
    if (ends.length > 0) {
      return {
        ok: false,
        missing: ends,
        message: `the cell's OCV curve needs both ends (0 % and 100 %); ${ends.join(' and ')} not given`,
      };
    }
    return {
      ok: true,
      points: own,
      derivation: `the cell's own OCV curve, ${own.length} points`,
      ...(estimated ? { estimated: true as const } : {}),
    };
  }
  const chemistry = textOf(cell.ratings.chemistry);
  const family = chemistry === undefined ? undefined : GENERIC_FOR[chemistry];
  if (family === undefined) {
    return {
      ok: false,
      missing: ['ocv0', 'ocv100', ...(chemistry === undefined ? ['chemistry'] : [])],
      message:
        chemistry === undefined
          ? 'the cell has no OCV curve and no chemistry to take a generic one from'
          : `the cell has no OCV curve and there is no generic curve for "${chemistry}"`,
    };
  }
  return {
    ok: true,
    points: OCV_SOC_PERCENT.map((p, i) => ({ soc: p / 100, voltage: GENERIC_OCV[family][i]! })),
    derivation: `the generic ${family} OCV curve (typical of ${chemistry} cells, not this cell's own)`,
    generic: true,
    estimated: true,
  };
}

/** How a pack is built from one cell. */
export interface PackSpec {
  /** Cells in series, a whole number from 1. */
  series: number;
  /** Cells in parallel, a whole number from 1. */
  parallel: number;
  /**
   * Interconnect resistance in ohms: of the whole pack (`per: 'pack'`), or of each joint between
   * series groups (`per: 'series joint'`, `series - 1` of them). Absent: not included.
   */
  interconnect?: { resistance: number; per: 'pack' | 'series joint' };
  /** Kilograms: enclosure, interconnects, wiring and BMS, everything but the cells. Absent: cells only. */
  enclosureMass?: number;
}

/** A pack's derived values, SI, each with its working. */
export interface Pack {
  series: number;
  parallel: number;
  /** `series * parallel`. */
  cells: number;
  /** The whole pack's interconnect resistance, ohms; absent when none was given. */
  interconnectResistance?: number;
  nominalVoltage: Normalised;
  /** At the cell's maximum (charge) voltage. */
  fullVoltage: Normalised;
  /** At the cell's cutoff voltage. */
  emptyVoltage: Normalised;
  /** Coulombs. */
  capacity: Normalised;
  /** Joules: nominal voltage times rated capacity. */
  energy: Normalised;
  /** DC internal resistance, ohms, interconnects included. */
  resistance: Normalised;
  /** Kilograms, cells plus enclosure. */
  mass: Normalised;
  continuousDischarge: Normalised;
  peakDischarge: Normalised;
  maxChargeCurrent: Normalised;
  /** The cells' heat capacity, J/K. */
  heatCapacity: Normalised;
  /** Full voltage over DC resistance, always estimated: a bound for fuse interrupting ratings. */
  shortCircuitCurrent: Normalised;
  /** The cell's OCV curve times `series`. */
  ocv: OcvCurve;
}

export type PackResult = { ok: true; pack: Pack } | { ok: false; message: string };

/** The most cells a pack builder accepts in series or in parallel. */
export const MAX_PACK_COUNT = 1000;

const whole = (v: number) => Number.isInteger(v) && v >= 1 && v <= MAX_PACK_COUNT;

/**
 * A pack of one cell, `series` by `parallel`, with its interconnects and enclosure. Refuses a
 * spec that is not a pack (counts not whole numbers from 1 to `MAX_PACK_COUNT`, a negative or
 * non-finite resistance or mass) or an entry that is not a cell; otherwise each derived value is
 * either a number with its working or the cell fields it lacks.
 */
export function buildPack(cell: CellRatings, spec: PackSpec): PackResult {
  if (cell.family !== 'cell') return { ok: false, message: `a ${cell.family} is not a cell` };
  const { series: s, parallel: p } = spec;
  if (!whole(s) || !whole(p)) {
    return {
      ok: false,
      message: `series and parallel counts are whole numbers from 1 to ${MAX_PACK_COUNT}`,
    };
  }
  const ic = spec.interconnect;
  if (ic !== undefined && !(Number.isFinite(ic.resistance) && ic.resistance >= 0)) {
    return { ok: false, message: 'the interconnect resistance is a number not below zero' };
  }
  const enclosure = spec.enclosureMass;
  if (enclosure !== undefined && !(Number.isFinite(enclosure) && enclosure >= 0)) {
    return { ok: false, message: 'the enclosure mass is a number not below zero' };
  }
  const n = s * p;
  const joints = s - 1;
  const rInter = ic === undefined ? 0 : ic.per === 'pack' ? ic.resistance : ic.resistance * joints;
  const interText =
    ic === undefined
      ? ' (no interconnect resistance given)'
      : ic.per === 'pack'
        ? ` + ${num(rInter)} ohm interconnects`
        : ` + ${num(rInter)} ohm interconnects (${joints} series joints x ${num(ic.resistance)} ohm)`;

  const inSeries = (field: string, label: string, what: string): Normalised => {
    const v = cellValue(cell, field, label);
    if (isMissing(v)) return v;
    const g = v;
    return ok(
      s * g.value,
      `${what} ${num(s * g.value)} V = ${s} in series x ${num(g.value)} V`,
      g.estimated === true,
    );
  };
  const inParallel = (field: string, label: string, what: string): Normalised => {
    const v = cellValue(cell, field, label);
    if (isMissing(v)) return v;
    const g = v;
    return ok(
      p * g.value,
      `${what} ${num(p * g.value)} A = ${p} in parallel x ${num(g.value)} A, assuming the parallel cells share current equally`,
      g.estimated === true,
    );
  };

  const nominalVoltage = inSeries('nominalVoltage', 'nominal voltage', 'nominal voltage');
  const fullVoltage = inSeries('chargeVoltage', 'maximum (charge) voltage', 'full voltage');
  const emptyVoltage = inSeries('cutoffVoltage', 'cutoff voltage', 'empty voltage');

  let capacity: Normalised;
  {
    const v = cellValue(cell, 'capacity', 'capacity');
    if (isMissing(v)) capacity = v;
    else {
      const g = v;
      capacity = ok(
        p * g.value,
        `capacity ${num((p * g.value) / 3600)} Ah = ${p} in parallel x ${num(g.value / 3600)} Ah`,
        g.estimated === true,
      );
    }
  }

  let energy: Normalised;
  if (!nominalVoltage.ok || !capacity.ok) {
    const lacking = [
      ...(nominalVoltage.ok ? [] : nominalVoltage.missing),
      ...(capacity.ok ? [] : capacity.missing),
    ];
    energy = missing(lacking, 'energy needs the nominal voltage and the capacity');
  } else {
    const e = nominalVoltage.value * capacity.value;
    energy = ok(
      e,
      `energy ${num(e / 3600)} Wh = ${num(nominalVoltage.value)} V x ${num(capacity.value / 3600)} Ah (nominal voltage x rated capacity, the figure the airline 100 Wh rule reads)`,
      nominalVoltage.estimated === true || capacity.estimated === true,
    );
  }

  let resistance: Normalised;
  {
    const v = cellValue(cell, 'resistanceDC', 'DC internal resistance');
    if (isMissing(v)) resistance = v;
    else {
      const g = v;
      const r = (s * g.value) / p + rInter;
      resistance = ok(
        r,
        `resistance ${num(r)} ohm = ${s} in series x ${num(g.value)} ohm / ${p} in parallel${interText}`,
        g.estimated === true,
      );
    }
  }

  const cellMass = given(cell.mass);
  let mass: Normalised;
  if (cellMass === undefined) mass = missing(['mass'], 'the cell has no mass');
  else {
    const m = n * cellMass.value + (enclosure ?? 0);
    mass = ok(
      m,
      `mass ${num(m)} kg = ${n} cells x ${num(cellMass.value)} kg${
        enclosure === undefined
          ? ' (cells only: no enclosure mass given)'
          : ` + ${num(enclosure)} kg enclosure, interconnects and wiring`
      }`,
      cellMass.estimated === true,
    );
  }

  const continuousDischarge = inParallel(
    'continuousDischarge',
    'continuous discharge current',
    'continuous discharge',
  );
  const peakDischarge = inParallel(
    'peakDischarge',
    'peak (pulse) discharge current',
    'peak discharge',
  );
  const maxChargeCurrent = inParallel(
    'maxChargeCurrent',
    'maximum charge current',
    'maximum charge current',
  );

  let heatCapacity: Normalised;
  {
    const c = given(cell.ratings.specificHeatCapacity);
    if (cellMass === undefined || c === undefined) {
      heatCapacity = missing(
        [
          ...(cellMass === undefined ? ['mass'] : []),
          ...(c === undefined ? ['specificHeatCapacity'] : []),
        ],
        "the cells' heat capacity needs their mass and specific heat capacity",
      );
    } else {
      const h = n * cellMass.value * c.value;
      heatCapacity = ok(
        h,
        `heat capacity ${num(h)} J/K = ${n} cells x ${num(cellMass.value)} kg x ${num(c.value)} J/(kg*K) (cells only)`,
        cellMass.estimated === true || c.estimated === true,
      );
    }
  }

  let shortCircuitCurrent: Normalised;
  if (!fullVoltage.ok || !resistance.ok) {
    shortCircuitCurrent = missing(
      [
        ...(fullVoltage.ok ? [] : fullVoltage.missing),
        ...(resistance.ok ? [] : resistance.missing),
      ],
      'the short-circuit current needs the full voltage and the DC resistance',
    );
  } else if (!(resistance.value > 0)) {
    shortCircuitCurrent = missing(
      ['resistanceDC'],
      'a pack with no resistance has no finite short-circuit current',
    );
  } else {
    const i = fullVoltage.value / resistance.value;
    shortCircuitCurrent = ok(
      i,
      `short-circuit current about ${num(i)} A = ${num(fullVoltage.value)} V / ${num(resistance.value)} ohm (full voltage over DC resistance; wiring, contacts and the cells' behaviour at that current are not included)`,
      true,
    );
  }

  const cellOcv = cellOcvCurve(cell);
  const ocv: OcvCurve = cellOcv.ok
    ? {
        ...cellOcv,
        points: cellOcv.points.map((pt) => ({ soc: pt.soc, voltage: s * pt.voltage })),
        derivation: `${s} in series x ${cellOcv.derivation}`,
      }
    : cellOcv;

  return {
    ok: true,
    pack: {
      series: s,
      parallel: p,
      cells: n,
      ...(ic === undefined ? {} : { interconnectResistance: rInter }),
      nominalVoltage,
      fullVoltage,
      emptyVoltage,
      capacity,
      energy,
      resistance,
      mass,
      continuousDischarge,
      peakDischarge,
      maxChargeCurrent,
      heatCapacity,
      shortCircuitCurrent,
      ocv,
    },
  };
}

function rated(v: Normalised): Rated {
  if (!v.ok) return { unknown: true };
  return v.estimated ? { value: v.value, estimated: true } : { value: v.value };
}

/**
 * A built pack as the ratings and mass of a `pack` catalog entry (fields version 2), for storing
 * it in the document: each derived value, `unknown` where the cell lacked an input. With no
 * interconnects given, `interconnectResistance` is `unknown` (not a stated zero) and the resistance
 * carries the basis "cells only, interconnects not included". `cell` names
 * the cell (`cell/molicel-inr-21700-p45b v1`, or a maker and part number).
 */
export function packRatings(
  pack: Pack,
  cell: string,
): { ratings: CatalogEntry['ratings']; mass: Rated } {
  return {
    ratings: {
      cell: { text: cell },
      series: { value: pack.series },
      parallel: { value: pack.parallel },
      nominalVoltage: rated(pack.nominalVoltage),
      fullVoltage: rated(pack.fullVoltage),
      emptyVoltage: rated(pack.emptyVoltage),
      capacity: rated(pack.capacity),
      energy: rated(pack.energy),
      resistance:
        pack.interconnectResistance === undefined && pack.resistance.ok
          ? { ...rated(pack.resistance), basis: 'cells only, interconnects not included' }
          : rated(pack.resistance),
      interconnectResistance:
        pack.interconnectResistance === undefined
          ? { unknown: true }
          : { value: pack.interconnectResistance },
      continuousDischarge: rated(pack.continuousDischarge),
      peakDischarge: rated(pack.peakDischarge),
      maxChargeCurrent: rated(pack.maxChargeCurrent),
    },
    mass: rated(pack.mass),
  };
}
