// `domains.mech` (ADR 0017 decision 2): the mechanical domain's document-level settings. Settings,
// not model (ADR 0013 decision 3): plain constants, no variables, nothing that names a document
// object. Everything that does (requirements, load cases, drivetrains, studies, check overrides)
// is in core's typed `mech` section.
//
// Stored shape, version 1 (every field optional; absent means the default below):
//
//   {
//     factors: { strength?: n, fatigue?: n, checks?: { [check id or family prefix]: n } },
//     ambient?: n,                 // K
//     printedKnockdown?: n,        // a fraction, 0 < n <= 1
//     simulation?: { step?: n, transientStep?: n, budget?: n },   // s, s, s of wall time
//     fea?: { targetDof?: n },
//     report?: { unitSystem?: 'si' | 'us', sections?: string[], titleBlock?: { [field]: string } },
//   }
//
// No safety factor ships (the maintainer's decision of 2026-10-10, ADR 0017 decision 6): a new
// design has none, starting the domain asks for a strength factor on yield and a fatigue factor,
// both optional, and a check with no factor reports its value and its factor with nothing to
// compare against, and no warning. The other defaults are starting points the user may change,
// none of them a safety judgement.

import { PRINTED_KNOCKDOWN_START, type DomainData, type SimpleCommand } from '@manufakture/core';

export const MECH_NAMESPACE = 'mech';
/** The version of `domains.mech` this build reads and writes. */
export const MECH_SETTINGS_VERSION = 1;

/** The largest safety factor a setting may hold: far past any real one, to catch typos. */
export const MAX_SAFETY_FACTOR = 100;

export interface MechFactors {
  /** The user's safety factor on yield, for strength checks; absent: none set. */
  readonly strength?: number;
  /** The user's safety factor for fatigue and life checks; absent: none set. */
  readonly fatigue?: number;
  /** Per check id (`bolt.preload`) or family prefix (`shaft.`), over the two above. */
  readonly checks?: Readonly<Record<string, number>>;
}

export interface MechSettings {
  readonly factors: MechFactors;
  /** The default ambient temperature, K. */
  readonly ambient: number;
  /** The factor on an XY strength when a printed material gives no Z strength. */
  readonly printedKnockdown: number;
  readonly simulation: {
    /** Session and envelope step, s (quasi-static currents). */
    readonly step: number;
    /** Transient step, s (the full current loop, on request only). */
    readonly transientStep: number;
    /** Wall time automatic runs after a regen may take per document, s (decision 16). */
    readonly budget: number;
  };
  readonly fea: {
    /** The degrees of freedom the default mesh aims at (decision 13: 150k to 200k). */
    readonly targetDof: number;
  };
  readonly report: {
    /** The reports' display unit system; absent: the document's. */
    readonly unitSystem?: 'si' | 'us';
    /** Sections to include, by id; absent: all. */
    readonly sections?: readonly string[];
    /** Title block fields by label. */
    readonly titleBlock?: Readonly<Record<string, string>>;
  };
}

/** The settings of a document whose `domains.mech` is absent or empty: no factors. */
export const DEFAULT_MECH_SETTINGS: MechSettings = {
  factors: {},
  ambient: 298.15,
  printedKnockdown: PRINTED_KNOCKDOWN_START.value,
  simulation: { step: 1e-3, transientStep: 50e-6, budget: 2 },
  fea: { targetDof: 175_000 },
  report: {},
};

export type ReadSettings =
  { ok: true; value: MechSettings } | { ok: false; message: string; field?: (string | number)[] };

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Bad extends Error {
  constructor(
    message: string,
    readonly field: (string | number)[],
  ) {
    super(message);
  }
}

function only(o: Obj, keys: readonly string[], at: (string | number)[]): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw new Bad(`unknown setting "${k}"`, [...at, k]);
  }
}

function obj(v: unknown, at: (string | number)[]): Obj {
  if (v === undefined) return {};
  if (!isObject(v)) throw new Bad('expected an object', at);
  return v;
}

function num(
  v: unknown,
  at: (string | number)[],
  fallback: number,
  check: (n: number) => boolean,
  what: string,
): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || !check(v)) {
    throw new Bad(`expected ${what}`, at);
  }
  return v;
}

function factor(v: unknown, at: (string | number)[]): number | undefined {
  if (v === undefined) return undefined;
  return num(
    v,
    at,
    0,
    (n) => n > 0 && n <= MAX_SAFETY_FACTOR,
    `a factor above 0 and at most ${MAX_SAFETY_FACTOR}`,
  );
}

const CHECK_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\.?$/;

function readV1(data: unknown): MechSettings {
  const d = obj(data, []);
  only(d, ['factors', 'ambient', 'printedKnockdown', 'simulation', 'fea', 'report'], []);
  const f = obj(d.factors, ['factors']);
  only(f, ['strength', 'fatigue', 'checks'], ['factors']);
  const factors: { strength?: number; fatigue?: number; checks?: Record<string, number> } = {};
  const strength = factor(f.strength, ['factors', 'strength']);
  const fatigue = factor(f.fatigue, ['factors', 'fatigue']);
  if (strength !== undefined) factors.strength = strength;
  if (fatigue !== undefined) factors.fatigue = fatigue;
  if (f.checks !== undefined) {
    const c = obj(f.checks, ['factors', 'checks']);
    const checks: Record<string, number> = {};
    for (const [k, v] of Object.entries(c)) {
      if (!CHECK_KEY.test(k) || k.length > 128) {
        throw new Bad(`"${k}" is not a check id or family`, ['factors', 'checks', k]);
      }
      checks[k] = factor(v, ['factors', 'checks', k])!;
    }
    factors.checks = checks;
  }
  const s = obj(d.simulation, ['simulation']);
  only(s, ['step', 'transientStep', 'budget'], ['simulation']);
  const fea = obj(d.fea, ['fea']);
  only(fea, ['targetDof'], ['fea']);
  const r = obj(d.report, ['report']);
  only(r, ['unitSystem', 'sections', 'titleBlock'], ['report']);
  const report: {
    unitSystem?: 'si' | 'us';
    sections?: string[];
    titleBlock?: Record<string, string>;
  } = {};
  if (r.unitSystem !== undefined) {
    if (r.unitSystem !== 'si' && r.unitSystem !== 'us') {
      throw new Bad('expected "si" or "us"', ['report', 'unitSystem']);
    }
    report.unitSystem = r.unitSystem;
  }
  if (r.sections !== undefined) {
    if (!Array.isArray(r.sections) || r.sections.length > 100) {
      throw new Bad('expected a list of at most 100 section ids', ['report', 'sections']);
    }
    report.sections = r.sections.map((x, i) => {
      if (typeof x !== 'string' || x.length === 0 || x.length > 64) {
        throw new Bad('expected a section id', ['report', 'sections', i]);
      }
      return x;
    });
  }
  if (r.titleBlock !== undefined) {
    const t = obj(r.titleBlock, ['report', 'titleBlock']);
    const entries = Object.entries(t);
    if (entries.length > 100)
      throw new Bad('at most 100 title block fields', ['report', 'titleBlock']);
    const titleBlock: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || v.length > 1000 || k.length > 100) {
        throw new Bad('expected a short text', ['report', 'titleBlock', k]);
      }
      titleBlock[k] = v;
    }
    report.titleBlock = titleBlock;
  }
  const D = DEFAULT_MECH_SETTINGS;
  return {
    factors,
    ambient: num(
      d.ambient,
      ['ambient'],
      D.ambient,
      (n) => n > 0 && n < 2000,
      'a temperature in kelvin',
    ),
    printedKnockdown: num(
      d.printedKnockdown,
      ['printedKnockdown'],
      D.printedKnockdown,
      (n) => n > 0 && n <= 1,
      'a fraction above 0 and at most 1',
    ),
    simulation: {
      step: num(
        s.step,
        ['simulation', 'step'],
        D.simulation.step,
        (n) => n >= 1e-6 && n <= 1,
        'a step of 1 µs to 1 s',
      ),
      transientStep: num(
        s.transientStep,
        ['simulation', 'transientStep'],
        D.simulation.transientStep,
        (n) => n >= 1e-7 && n <= 1e-2,
        'a step of 0.1 µs to 10 ms',
      ),
      budget: num(
        s.budget,
        ['simulation', 'budget'],
        D.simulation.budget,
        (n) => n >= 0 && n <= 600,
        '0 to 600 s',
      ),
    },
    fea: {
      targetDof: num(
        fea.targetDof,
        ['fea', 'targetDof'],
        D.fea.targetDof,
        (n) => Number.isInteger(n) && n >= 1000 && n <= 500_000,
        'a whole number of degrees of freedom from 1000 to 500000',
      ),
    },
    report,
  };
}

/**
 * Read `domains.mech` stored at `schemaVersion` as this build's settings, filling defaults. Pure;
 * refuses unknown keys and out-of-range values with the field at fault.
 */
export function readMechSettings(data: unknown, schemaVersion: number): ReadSettings {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { ok: false, message: `mech settings version ${schemaVersion} is not a version` };
  }
  if (schemaVersion > MECH_SETTINGS_VERSION) {
    return {
      ok: false,
      message: `mech settings version ${schemaVersion} is newer than this build reads (${MECH_SETTINGS_VERSION})`,
    };
  }
  try {
    return { ok: true, value: readV1(data) };
  } catch (e) {
    if (e instanceof Bad)
      return { ok: false, message: `mech settings: ${e.message}`, field: e.field };
    throw e;
  }
}

/** A document's mechanical settings: its `domains.mech`, else the defaults (no factors). */
export function mechSettings(
  domains: Readonly<Record<string, DomainData>> | undefined,
): ReadSettings {
  const entry =
    domains !== undefined && Object.hasOwn(domains, MECH_NAMESPACE)
      ? domains[MECH_NAMESPACE]
      : undefined;
  if (entry === undefined) return { ok: true, value: DEFAULT_MECH_SETTINGS };
  return readMechSettings(entry.data, entry.schemaVersion);
}

/** Whether the mechanical domain has been started in a document (it has `domains.mech`). */
export function mechStarted(domains: Readonly<Record<string, DomainData>> | undefined): boolean {
  return domains !== undefined && Object.hasOwn(domains, MECH_NAMESPACE);
}

/** What the first-run prompt asks: both optional. */
export interface StartFactors {
  readonly strength?: number;
  readonly fatigue?: number;
}

/**
 * The command that starts the mechanical domain, or (once started) sets its two factors: a
 * `setDomainData` of `mech` that keeps every other stored setting. A factor left out is not set,
 * and no default takes its place. Refuses a factor that is not a positive number up to
 * `MAX_SAFETY_FACTOR`.
 */
export function setFactorsCommand(
  domains: Readonly<Record<string, DomainData>> | undefined,
  factors: StartFactors,
): { ok: true; command: SimpleCommand } | { ok: false; message: string } {
  for (const key of ['strength', 'fatigue'] as const) {
    const v = factors[key];
    if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= MAX_SAFETY_FACTOR)) {
      return {
        ok: false,
        message: `The ${key} factor must be above 0 and at most ${MAX_SAFETY_FACTOR}`,
      };
    }
  }
  const entry =
    domains !== undefined && Object.hasOwn(domains, MECH_NAMESPACE)
      ? domains[MECH_NAMESPACE]
      : undefined;
  const stored = entry !== undefined && isObject(entry.data) ? entry.data : {};
  const old = isObject(stored.factors) ? stored.factors : {};
  const next: Obj = { ...old };
  delete next.strength;
  delete next.fatigue;
  if (factors.strength !== undefined) next.strength = factors.strength;
  if (factors.fatigue !== undefined) next.fatigue = factors.fatigue;
  const data = { ...stored, factors: next } as DomainData['data'];
  return {
    ok: true,
    command: {
      type: 'setDomainData',
      namespace: MECH_NAMESPACE,
      schemaVersion: MECH_SETTINGS_VERSION,
      data,
    },
  };
}

/**
 * How a check's factor reads for the user (decision 6): the factor reached against theirs, or
 * with nothing to compare when they set none. Never "safe", "OK", "pass" or "fail".
 */
export function factorText(reached: number, wanted: number | undefined, decimals = 2): string {
  const r = reached.toFixed(decimals);
  if (wanted === undefined) return `factor ${r}; not compared: no factor set`;
  const w = String(wanted);
  if (reached > wanted) return `factor ${r}, above your ${w}`;
  return reached === wanted ? `factor ${r}, at your ${w}` : `factor ${r}, below your ${w}`;
}

/** The factor that applies to a check: its own, else its family's (longest prefix), else the kind's. */
export function factorFor(
  settings: MechSettings,
  check: string,
  kind: 'strength' | 'fatigue',
): number | undefined {
  const checks = settings.factors.checks ?? {};
  if (Object.hasOwn(checks, check)) return checks[check];
  let best: string | undefined;
  for (const k of Object.keys(checks)) {
    if (k.endsWith('.') && check.startsWith(k) && (best === undefined || k.length > best.length))
      best = k;
  }
  if (best !== undefined) return checks[best];
  return settings.factors[kind];
}
