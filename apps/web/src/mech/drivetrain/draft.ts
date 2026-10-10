// The drivetrain editor's drafts (T9.3a): a drivetrain as the user types it, every expression as
// text, turned into core's `Drivetrain` on save. As in the requirements editor, a field whose text
// is unchanged keeps its stored expression (and the units it was typed under). Fields the editor
// has no control for (a belt's catalog uses, a shaft's bearings, a coupling's use, a gear or
// planetary stage's members past the first two, the spool's fairlead) are kept as stored while the
// stage keeps its kind.

import {
  MECH_COUNTERS,
  peekCounter,
  type DisplayUnits,
  type Drivetrain,
  type Stage,
  type StoredExpression,
} from '@manufakture/core';
import type { OutputKind, StageKind } from '@manufakture/domain-mech';
import { keptExpression } from '../requirements/draft';

type Output = Drivetrain['output'];

export interface StageDraft {
  id: string;
  kind: StageKind;
  /** Motor: its purchased use. */
  use: string;
  /** Motor, shaft, coupling: an instance of the drivetrain's assembly, or ''. */
  instance: string;
  /** Motor: a revolute mate, or ''. */
  mate: string;
  /** Reductions: a ratio, or tooth counts. */
  ratioBy: 'ratio' | 'teeth';
  ratio: string;
  driver: string;
  driven: string;
  efficiency: string;
  /** Gear and planetary: the members measured at the input and at the output speed, or ''. */
  inputMember: string;
  outputMember: string;
  /** A typed inertia, or '' (then the catalog or the kernel gives it). */
  inertia: string;
  original?: Stage;
}

export interface OutputDraft {
  kind: OutputKind;
  instance: string;
  /** Spool. */
  body: string;
  cable: string;
  length: string;
  core: string;
  flange: string;
  width: string;
  /** Linear. */
  lead: string;
  efficiency: string;
  /** Spool and rotary. */
  inertia: string;
  original?: Output;
}

export interface DrivetrainDraft {
  id: string;
  name: string;
  assembly: string;
  stages: StageDraft[];
  output: OutputDraft;
  original?: Drivetrain;
}

const source = (e: StoredExpression | undefined): string => e?.source ?? '';

export function stageDraft(s: Stage): StageDraft {
  const d = newStageDraft(s.id, s.kind);
  d.original = s;
  d.inertia = source(s.inertia);
  switch (s.kind) {
    case 'motor':
      return { ...d, use: s.use, instance: s.instance ?? '', mate: s.mate ?? '' };
    case 'belt':
    case 'gear':
    case 'planetary': {
      const r = s.ratio;
      const ratio =
        'source' in r
          ? { ratioBy: 'ratio' as const, ratio: r.source }
          : { ratioBy: 'teeth' as const, driver: r.driver.source, driven: r.driven.source };
      const members =
        s.kind === 'belt'
          ? {}
          : { inputMember: s.instances?.[0] ?? '', outputMember: s.instances?.[1] ?? '' };
      return { ...d, ...ratio, ...members, efficiency: s.efficiency.source };
    }
    case 'shaft':
    case 'coupling':
      return { ...d, instance: s.instance ?? '' };
  }
}

export function newStageDraft(id: string, kind: StageKind): StageDraft {
  return {
    id,
    kind,
    use: '',
    instance: '',
    mate: '',
    ratioBy: 'ratio',
    ratio: '',
    driver: '',
    driven: '',
    efficiency: '',
    inputMember: '',
    outputMember: '',
    inertia: '',
  };
}

export function outputDraft(o: Output): OutputDraft {
  const d = newOutputDraft(o.kind);
  d.original = o;
  d.instance = o.instance ?? '';
  switch (o.kind) {
    case 'spool':
      return {
        ...d,
        body: o.body ?? '',
        cable: o.cable,
        length: o.length.source,
        core: source(o.core),
        flange: source(o.flange),
        width: source(o.width),
        inertia: source(o.inertia),
      };
    case 'rotary':
      return { ...d, inertia: source(o.inertia) };
    case 'linear':
      return { ...d, lead: o.lead.source, efficiency: o.efficiency.source };
  }
}

export function newOutputDraft(kind: OutputKind): OutputDraft {
  return {
    kind,
    instance: '',
    body: '',
    cable: '',
    length: '',
    core: '',
    flange: '',
    width: '',
    lead: '',
    efficiency: '',
    inertia: '',
  };
}

export function drivetrainDraft(d: Drivetrain): DrivetrainDraft {
  return {
    id: d.id,
    name: d.name,
    assembly: d.assembly ?? '',
    stages: d.stages.map(stageDraft),
    output: outputDraft(d.output),
    original: d,
  };
}

/**
 * The next id of a counter for an item added in the editor: never below the counter's next, and
 * past every id the unsaved draft already holds at or beyond it.
 */
export function nextMechId(
  nextIds: Readonly<Record<string, number>>,
  counter: string,
  used: readonly string[],
): string {
  const base = peekCounter(nextIds, counter);
  let next = base;
  const pattern = new RegExp(`^${counter}#([0-9]+)$`);
  for (const id of used) {
    const m = pattern.exec(id);
    if (m === null) continue;
    const n = Number(m[1]);
    if (n >= base) next = Math.max(next, n + 1);
  }
  return `${counter}#${next}`;
}

/** A new drivetrain: a motor stage and a rotary output. */
export function newDrivetrainDraft(nextIds: Readonly<Record<string, number>>): DrivetrainDraft {
  return {
    id: nextMechId(nextIds, MECH_COUNTERS.drivetrain, []),
    name: 'Drivetrain',
    assembly: '',
    stages: [newStageDraft(nextMechId(nextIds, MECH_COUNTERS.stage, []), 'motor')],
    output: newOutputDraft('rotary'),
  };
}

/** A draft with a stage of `kind` added at the end. */
export function withStage(
  d: DrivetrainDraft,
  kind: StageKind,
  nextIds: Readonly<Record<string, number>>,
): DrivetrainDraft {
  const id = nextMechId(
    nextIds,
    MECH_COUNTERS.stage,
    d.stages.map((s) => s.id),
  );
  return { ...d, stages: [...d.stages, newStageDraft(id, kind)] };
}

/** A stage draft with its kind changed: what both kinds share stays, the rest starts empty. */
export function withKind(s: StageDraft, kind: StageKind): StageDraft {
  if (s.kind === kind) return s;
  const next = newStageDraft(s.id, kind);
  const reduction = (k: StageKind) => k === 'belt' || k === 'gear' || k === 'planetary';
  return {
    ...next,
    inertia: s.inertia,
    ...(reduction(kind) && reduction(s.kind)
      ? {
          ratioBy: s.ratioBy,
          ratio: s.ratio,
          driver: s.driver,
          driven: s.driven,
          efficiency: s.efficiency,
        }
      : {}),
    ...(kind !== 'belt' && s.kind !== 'belt' ? { instance: s.instance } : {}),
  };
}

type Built<T> = { ok: true; value: T } | { ok: false; message: string };

function stageFromDraft(s: StageDraft, i: number, units: DisplayUnits): Built<Stage> {
  const was = s.original?.kind === s.kind ? s.original : undefined;
  const expr = (old: StoredExpression | undefined, text: string) =>
    keptExpression(old, text, units);
  const optional = (old: StoredExpression | undefined, text: string) =>
    text.trim() === '' ? undefined : expr(old, text);
  const where = `stage ${i + 1} (${s.id})`;
  const inertia = optional(was?.inertia, s.inertia);
  const withInertia = <T extends object>(o: T): T =>
    inertia === undefined ? o : { ...o, inertia };
  switch (s.kind) {
    case 'motor': {
      if (s.use === '')
        return { ok: false, message: `${where}: choose the motor's purchased part` };
      return {
        ok: true,
        value: withInertia({
          id: s.id,
          kind: 'motor',
          use: s.use,
          ...(s.instance !== '' ? { instance: s.instance } : {}),
          ...(s.mate !== '' ? { mate: s.mate } : {}),
        }),
      };
    }
    case 'belt':
    case 'gear':
    case 'planetary': {
      const old = was as Extract<Stage, { kind: 'belt' | 'gear' | 'planetary' }> | undefined;
      const oldRatio = old?.ratio;
      let ratio: Extract<Stage, { kind: 'belt' }>['ratio'];
      if (s.ratioBy === 'ratio') {
        if (s.ratio.trim() === '') return { ok: false, message: `${where}: type its ratio` };
        ratio = expr(
          oldRatio !== undefined && 'source' in oldRatio ? oldRatio : undefined,
          s.ratio,
        );
      } else {
        if (s.driver.trim() === '' || s.driven.trim() === '') {
          return { ok: false, message: `${where}: type both tooth counts` };
        }
        const teeth = oldRatio !== undefined && !('source' in oldRatio) ? oldRatio : undefined;
        ratio = { driver: expr(teeth?.driver, s.driver), driven: expr(teeth?.driven, s.driven) };
      }
      if (s.efficiency.trim() === '')
        return { ok: false, message: `${where}: type its efficiency` };
      const efficiency = expr(old?.efficiency, s.efficiency);
      if (s.kind === 'belt') {
        const b = old?.kind === 'belt' ? old : undefined;
        return {
          ok: true,
          value: withInertia({
            id: s.id,
            kind: 'belt',
            ratio,
            efficiency,
            ...(b?.belt !== undefined ? { belt: b.belt } : {}),
            ...(b?.pulleys !== undefined ? { pulleys: b.pulleys } : {}),
          }),
        };
      }
      const g = old !== undefined && old.kind !== 'belt' ? old : undefined;
      // Members past the first two (a planetary's planets and ring) have no control: kept.
      const extra = g?.instances?.slice(2) ?? [];
      const members = [s.inputMember, s.outputMember, ...extra].filter((m) => m !== '');
      if (s.inputMember === '' && (s.outputMember !== '' || extra.length > 0)) {
        return { ok: false, message: `${where}: choose the input member before the output one` };
      }
      if (s.outputMember === '' && extra.length > 0) {
        return {
          ok: false,
          message: `${where}: choose an output member; the stage also has ${extra.join(', ')}`,
        };
      }
      return {
        ok: true,
        value: withInertia({
          id: s.id,
          kind: s.kind,
          ratio,
          efficiency,
          ...(g?.uses !== undefined ? { uses: g.uses } : {}),
          ...(members.length > 0 ? { instances: members } : {}),
        }),
      };
    }
    case 'shaft': {
      const old = was?.kind === 'shaft' ? was : undefined;
      return {
        ok: true,
        value: withInertia({
          id: s.id,
          kind: 'shaft',
          ...(s.instance !== '' ? { instance: s.instance } : {}),
          bearings: old?.bearings ?? [],
        }),
      };
    }
    case 'coupling': {
      const old = was?.kind === 'coupling' ? was : undefined;
      return {
        ok: true,
        value: withInertia({
          id: s.id,
          kind: 'coupling',
          ...(old?.use !== undefined ? { use: old.use } : {}),
          ...(s.instance !== '' ? { instance: s.instance } : {}),
        }),
      };
    }
  }
}

function outputFromDraft(o: OutputDraft, units: DisplayUnits): Built<Output> {
  const was = o.original?.kind === o.kind ? o.original : undefined;
  const expr = (old: StoredExpression | undefined, text: string) =>
    keptExpression(old, text, units);
  const optional = (old: StoredExpression | undefined, text: string) =>
    text.trim() === '' ? undefined : expr(old, text);
  const instance = o.instance !== '' ? { instance: o.instance } : {};
  switch (o.kind) {
    case 'spool': {
      const old = was?.kind === 'spool' ? was : undefined;
      if (o.cable === '')
        return { ok: false, message: "output: choose the cable's purchased part" };
      if (o.length.trim() === '') return { ok: false, message: 'output: type the cable length' };
      const fields = {
        core: optional(old?.core, o.core),
        flange: optional(old?.flange, o.flange),
        width: optional(old?.width, o.width),
        inertia: optional(old?.inertia, o.inertia),
      };
      return {
        ok: true,
        value: {
          kind: 'spool',
          ...instance,
          ...(o.body.trim() !== '' ? { body: o.body.trim() } : {}),
          cable: o.cable,
          length: expr(old?.length, o.length),
          ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
          ...(old?.fairlead !== undefined ? { fairlead: old.fairlead } : {}),
        },
      };
    }
    case 'rotary': {
      const old = was?.kind === 'rotary' ? was : undefined;
      const inertia = optional(old?.inertia, o.inertia);
      return {
        ok: true,
        value: { kind: 'rotary', ...instance, ...(inertia !== undefined ? { inertia } : {}) },
      };
    }
    case 'linear': {
      const old = was?.kind === 'linear' ? was : undefined;
      if (o.lead.trim() === '' || o.efficiency.trim() === '') {
        return { ok: false, message: 'output: type the lead and the efficiency of the screw' };
      }
      return {
        ok: true,
        value: {
          kind: 'linear',
          lead: expr(old?.lead, o.lead),
          efficiency: expr(old?.efficiency, o.efficiency),
          ...instance,
        },
      };
    }
  }
}

/** The drivetrain a draft gives, or the first thing missing from it. */
export function drivetrainFromDraft(d: DrivetrainDraft, units: DisplayUnits): Built<Drivetrain> {
  if (d.name.trim() === '') return { ok: false, message: 'give it a name' };
  const stages: Stage[] = [];
  for (const [i, s] of d.stages.entries()) {
    const built = stageFromDraft(s, i, units);
    if (!built.ok) return built;
    stages.push(built.value);
  }
  const output = outputFromDraft(d.output, units);
  if (!output.ok) return output;
  return {
    ok: true,
    value: {
      id: d.id,
      name: d.name.trim(),
      ...(d.assembly !== '' ? { assembly: d.assembly } : {}),
      stages,
      output: output.value,
    },
  };
}
