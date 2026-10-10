// The editor's drafts of requirements and load cases (T9.4a): every field as the text the user
// typed, turned into core's shapes on save. Expressions are stored with the display units they
// were typed under: a draft carries the item it was made from, and a field whose text is unchanged
// keeps its stored expression, so changing the display units never re-reads an untouched value
// (600 typed under mm stays 600 mm). Tables are typed one point per line ("0.3, 450"), in SI.

import {
  MECH_COUNTERS,
  REQUIREMENT_QUANTITIES,
  peekCounter,
  storedExpression,
  type DisplayUnits,
  type LoadCase,
  type Requirement,
  type StoredExpression,
} from '@manufakture/core';
import type { ResistanceModeKind } from '@manufakture/domain-mech';

type Dynamic = NonNullable<LoadCase['dynamic']>;

export type Comparison = Requirement['comparison'];

/** A requirement as typed. `quantity` is a named quantity; others are kept as they are. */
export interface RequirementDraft {
  id: string;
  name: string;
  quantity: Requirement['quantity'];
  comparison: Comparison;
  /** One value, or three for an envelope. */
  value: string[];
  tolerance: string;
  loadCase: string;
  /** Kept as stored: the editor has no field for it. */
  drivetrain?: string;
  /** The stored requirement this draft was made from (absent for a new one). */
  original?: Requirement;
}

/**
 * The expression for a field's text: the stored one when the text is unchanged (it keeps the
 * units it was typed under), else the text under the current display units.
 */
export function keptExpression(
  original: StoredExpression | undefined,
  text: string,
  units: DisplayUnits,
): StoredExpression {
  const source = text.trim();
  return original !== undefined && original.source.trim() === source
    ? original
    : storedExpression(source, units);
}

function storedValues(r: Requirement | undefined): readonly StoredExpression[] {
  if (r === undefined) return [];
  return Array.isArray(r.value)
    ? (r.value as readonly StoredExpression[])
    : [r.value as StoredExpression];
}

export function requirementDraft(r: Requirement): RequirementDraft {
  const values = Array.isArray(r.value)
    ? (r.value as readonly StoredExpression[]).map((v) => v.source)
    : [(r.value as StoredExpression).source];
  return {
    id: r.id,
    name: r.name,
    quantity: r.quantity,
    comparison: r.comparison,
    value: values,
    tolerance: r.tolerance?.source ?? '',
    loadCase: r.loadCase ?? '',
    ...(r.drivetrain !== undefined ? { drivetrain: r.drivetrain } : {}),
    original: r,
  };
}

/**
 * The id of a requirement added in the editor: one more than the highest id the unsaved rows hold,
 * and never below the counter's next (`mech.nextIds`). Unsaved rows are those at or past the
 * counter; removing one never makes the next row reuse an id still in the list.
 */
export function nextRequirementId(
  nextIds: Readonly<Record<string, number>>,
  rows: readonly { id: string }[],
): string {
  const base = peekCounter(nextIds, MECH_COUNTERS.requirement);
  let next = base;
  const pattern = new RegExp(`^${MECH_COUNTERS.requirement}#([0-9]+)$`);
  for (const r of rows) {
    const m = pattern.exec(r.id);
    if (m === null) continue;
    const n = Number(m[1]);
    if (n >= base) next = Math.max(next, n + 1);
  }
  return `${MECH_COUNTERS.requirement}#${next}`;
}

export function newRequirementDraft(id: string): RequirementDraft {
  return {
    id,
    name: 'New requirement',
    quantity: 'maxForce',
    comparison: '>=',
    value: [''],
    tolerance: '',
    loadCase: '',
  };
}

/** A draft with its quantity changed: an envelope takes three values and `within`. */
export function withQuantity(d: RequirementDraft, quantity: string): RequirementDraft {
  if (!(REQUIREMENT_QUANTITIES as readonly string[]).includes(quantity)) return d;
  const q = quantity as Requirement['quantity'];
  const envelope = q === 'envelope';
  return {
    ...d,
    quantity: q,
    comparison: envelope ? 'within' : d.comparison === 'within' ? '<=' : d.comparison,
    value: envelope ? [d.value[0] ?? '', d.value[1] ?? '', d.value[2] ?? ''] : [d.value[0] ?? ''],
  };
}

export function requirementFromDraft(d: RequirementDraft, units: DisplayUnits): Requirement {
  const was = storedValues(d.original);
  // A value keeps its stored expression only in the same place of the same shape.
  const at = (i: number) => (was.length === d.value.length ? was[i] : undefined);
  const e = (i: number) => keptExpression(at(i), d.value[i] ?? '', units);
  const value = d.value.length === 3 ? ([e(0), e(1), e(2)] as const) : e(0);
  return {
    id: d.id,
    name: d.name.trim(),
    quantity: d.quantity,
    comparison: d.comparison,
    value,
    ...(d.tolerance.trim() !== ''
      ? { tolerance: keptExpression(d.original?.tolerance, d.tolerance, units) }
      : {}),
    ...(d.loadCase !== '' ? { loadCase: d.loadCase } : {}),
    ...(d.drivetrain !== undefined ? { drivetrain: d.drivetrain } : {}),
  };
}

/** A load case as typed. Static loads and the drivetrain are kept as stored. */
export interface LoadCaseDraft {
  id: string;
  name: string;
  /** Whether it has a motion (a dynamic part); one with static loads only may not. */
  dynamic: boolean;
  mode: ResistanceModeKind;
  /** The mode's parameters by name: factor, rate, from, speed, coefficient, duration. */
  params: Record<string, string>;
  tableBy: 'position' | 'speed';
  tablePoints: string;
  force: string;
  motion: 'half-cosine' | 'table';
  stroke: string;
  pullSpeed: string;
  returnSpeed: string;
  pause: string;
  motionPoints: string;
  reps: string;
  sets: string;
  rest: string;
  startCharge: string;
  ambient: string;
  keep: Pick<LoadCase, 'drivetrain' | 'static'>;
  /** The stored load case this draft was made from (absent for a new one). */
  original?: LoadCase;
}

/** The parameters of each mode, with a label and a hint of the unit. */
export const MODE_PARAMS: Readonly<
  Record<ResistanceModeKind, readonly { key: string; label: string; hint: string }[]>
> = {
  constant: [],
  eccentric: [{ key: 'factor', label: 'Return factor', hint: '1.3' }],
  band: [{ key: 'rate', label: 'Rate', hint: '200 N/m' }],
  chains: [
    { key: 'rate', label: 'Rate', hint: '300 N/m' },
    { key: 'from', label: 'Chains leave the floor at', hint: '0.2 m' },
  ],
  isokinetic: [{ key: 'speed', label: 'Speed limit', hint: '0.5 m/s' }],
  damper: [{ key: 'coefficient', label: 'Coefficient', hint: '100 N*s/m' }],
  rowing: [{ key: 'coefficient', label: 'Coefficient', hint: '25 N*s^2/m^2' }],
  isometric: [{ key: 'duration', label: 'Hold for', hint: '30 s' }],
  table: [],
};

export function pointsText(points: readonly (readonly [number, number])[]): string {
  return points.map(([a, b]) => `${a}, ${b}`).join('\n');
}

/** Points typed one per line, two numbers separated by a comma, spaces or a tab. */
export function parsePoints(
  text: string,
  what: string,
): { ok: true; points: [number, number][] } | { ok: false; message: string } {
  const points: [number, number][] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    const parts = line.split(/[\s,;]+/).filter((p) => p !== '');
    const nums = parts.map(Number);
    if (parts.length !== 2 || !nums.every(Number.isFinite)) {
      return { ok: false, message: `${what}, line ${i + 1}: write two numbers, "0.3, 450"` };
    }
    points.push([nums[0]!, nums[1]!]);
  }
  if (points.length < 2) return { ok: false, message: `${what}: at least two points` };
  return { ok: true, points };
}

export function loadCaseDraft(lc: LoadCase): LoadCaseDraft {
  const d = lc.dynamic;
  const keep: LoadCaseDraft['keep'] = {};
  if (lc.drivetrain !== undefined) keep.drivetrain = lc.drivetrain;
  if (lc.static !== undefined) keep.static = lc.static;
  const params: Record<string, string> = {};
  let tableBy: LoadCaseDraft['tableBy'] = 'position';
  let tablePoints = '';
  if (d !== undefined) {
    for (const [k, v] of Object.entries(d.mode)) {
      if (k === 'kind' || k === 'by' || k === 'points') continue;
      params[k] = (v as StoredExpression).source;
    }
    if (d.mode.kind === 'table') {
      tableBy = d.mode.by;
      tablePoints = pointsText(d.mode.points);
    }
  }
  const m = d?.motion;
  return {
    id: lc.id,
    name: lc.name,
    dynamic: d !== undefined,
    mode: d?.mode.kind ?? 'constant',
    params,
    tableBy,
    tablePoints,
    force: d?.force.source ?? '',
    motion: m?.kind ?? 'half-cosine',
    stroke: m?.kind === 'half-cosine' ? m.stroke.source : '',
    pullSpeed: m?.kind === 'half-cosine' ? m.pullSpeed.source : '',
    returnSpeed: m?.kind === 'half-cosine' ? m.returnSpeed.source : '',
    pause: m?.kind === 'half-cosine' ? m.pause.source : '',
    motionPoints: m?.kind === 'table' ? pointsText(m.points) : '',
    reps: d?.reps.source ?? '',
    sets: d?.sets?.source ?? '',
    rest: d?.rest?.source ?? '',
    startCharge: d?.startCharge?.source ?? '',
    ambient: d?.ambient?.source ?? '',
    keep,
    original: lc,
  };
}

export function newLoadCaseDraft(id: string): LoadCaseDraft {
  const blank = loadCaseDraft({ id, name: 'New load case' });
  // A new load case has nothing stored to keep.
  delete blank.original;
  return {
    ...blank,
    dynamic: true,
    force: '100 N',
    stroke: '0.6 m',
    pullSpeed: '1 m/s',
    returnSpeed: '1 m/s',
    pause: '0.2 s',
    reps: '10',
  };
}

/**
 * The load case a draft describes, or why it cannot be built (a table that does not read). Values
 * are not evaluated here: `loadCaseProblems` does that.
 */
export function loadCaseFromDraft(
  d: LoadCaseDraft,
  units: DisplayUnits,
): { ok: true; loadCase: LoadCase } | { ok: false; message: string } {
  const e = keptExpression;
  if (!d.dynamic) return { ok: true, loadCase: { id: d.id, name: d.name.trim(), ...d.keep } };
  const was = d.original?.dynamic;
  // A mode's parameter keeps its stored expression only under the same mode.
  const wasMode =
    was?.mode.kind === d.mode
      ? (was.mode as unknown as Record<string, StoredExpression | undefined>)
      : undefined;
  const p = (key: string) => e(wasMode?.[key], d.params[key] ?? '', units);
  let mode: Dynamic['mode'];
  switch (d.mode) {
    case 'constant':
      mode = { kind: 'constant' };
      break;
    case 'eccentric':
      mode = { kind: 'eccentric', factor: p('factor') };
      break;
    case 'band':
      mode = { kind: 'band', rate: p('rate') };
      break;
    case 'chains':
      mode = { kind: 'chains', rate: p('rate'), from: p('from') };
      break;
    case 'isokinetic':
      mode = { kind: 'isokinetic', speed: p('speed') };
      break;
    case 'damper':
    case 'rowing':
      mode = { kind: d.mode, coefficient: p('coefficient') };
      break;
    case 'isometric':
      mode = { kind: 'isometric', duration: p('duration') };
      break;
    case 'table': {
      const pts = parsePoints(d.tablePoints, 'The force table');
      if (!pts.ok) return pts;
      mode = { kind: 'table', by: d.tableBy, points: pts.points };
      break;
    }
  }
  let motion: Dynamic['motion'];
  if (d.motion === 'table') {
    const pts = parsePoints(d.motionPoints, 'The motion table');
    if (!pts.ok) return pts;
    motion = { kind: 'table', points: pts.points };
  } else {
    const wm = was?.motion.kind === 'half-cosine' ? was.motion : undefined;
    motion = {
      kind: 'half-cosine',
      stroke: e(wm?.stroke, d.stroke, units),
      pullSpeed: e(wm?.pullSpeed, d.pullSpeed, units),
      returnSpeed: e(wm?.returnSpeed, d.returnSpeed, units),
      pause: e(wm?.pause, d.pause, units),
    };
  }
  const opt = (old: StoredExpression | undefined, s: string) =>
    s.trim() === '' ? undefined : e(old, s, units);
  const dynamic: Dynamic = {
    mode,
    force: e(was?.force, d.force, units),
    motion,
    reps: e(was?.reps, d.reps, units),
  };
  const sets = opt(was?.sets, d.sets);
  const rest = opt(was?.rest, d.rest);
  const startCharge = opt(was?.startCharge, d.startCharge);
  const ambient = opt(was?.ambient, d.ambient);
  if (sets) dynamic.sets = sets;
  if (rest) dynamic.rest = rest;
  if (startCharge) dynamic.startCharge = startCharge;
  if (ambient) dynamic.ambient = ambient;
  return { ok: true, loadCase: { id: d.id, name: d.name.trim(), ...d.keep, dynamic } };
}
