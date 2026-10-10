// Templates of requirements and load cases (T9.4a): a cable trainer, a winch and a linear axis.
// Adding one appends its requirements and load cases to the document's, with fresh ids, in one
// undo step; the user then changes every number to their own.
//
// The cable trainer's targets are the drafted requirement list of the T9.0c research
// (docs/research/electromechanical.md, section 5, R1 to R18), not the plan's illustrative
// numbers: each requirement's name carries its R number, and the load cases the targets name are
// built from the same list (R6 to R9, with the rep timing of the T9.0b spike). Targets the
// requirement model cannot state are left out (R3 force accuracy, R5 cable kind, R15's other
// modes, R16 fault response, R17 parts limits, which are the checks'); so is R5's rope design
// factor: no template fills in a safety factor (the maintainer's decision of 2026-10-10). The
// winch and the linear axis carry example targets, named as such.

import {
  MAX_LOAD_CASES,
  MAX_REQUIREMENTS,
  MECH_COUNTERS,
  bareUnits,
  mechItems,
  peekCounter,
  type Command,
  type LoadCase,
  type ManufaktureDocument,
  type Requirement,
  type StoredExpression,
} from '@manufakture/core';

export type MechTemplateId = 'cable-trainer' | 'winch' | 'linear-axis';

type Expr = (source: string) => StoredExpression;

/** A requirement of a template; `loadCase` is the index of one of the template's load cases. */
type TemplateRequirement = Omit<Requirement, 'id' | 'loadCase'> & { loadCase?: number };

export interface MechTemplate {
  id: MechTemplateId;
  name: string;
  description: string;
  /** The template's contents, with expressions in the given units. */
  build(x: Expr): { requirements: TemplateRequirement[]; loadCases: Omit<LoadCase, 'id'>[] };
}

const cableTrainer: MechTemplate = {
  id: 'cable-trainer',
  name: 'Cable trainer',
  description:
    'A portable cable trainer: 5 to 200 lbf in 1 lbf steps, 2.85 m of cable, 1.5 m/s at full force, a 30 s hold, 6 and 14 sessions per charge, a pack under 100 Wh, at most 6 kg in 330 x 140 x 100 mm (T9.0c research, R1 to R18).',
  build(x) {
    const rep = (force: string, pullSpeed: string, returnSpeed: string) => ({
      force: x(force),
      motion: {
        kind: 'half-cosine' as const,
        stroke: x('0.6 m'),
        pullSpeed: x(pullSpeed),
        returnSpeed: x(returnSpeed),
        pause: x('0.2 s'),
      },
    });
    const loadCases: Omit<LoadCase, 'id'>[] = [
      {
        name: 'Full force rep (R6)',
        dynamic: {
          mode: { kind: 'constant' },
          ...rep('200 lbf', '1.5 m/s', '1.5 m/s'),
          reps: x('9'),
        },
      },
      {
        name: 'Light rowing (R7)',
        dynamic: {
          mode: { kind: 'rowing', coefficient: x('50 lbf / (3 m/s)^2') },
          ...rep('50 lbf', '3 m/s', '1.5 m/s'),
          reps: x('9'),
        },
      },
      {
        name: 'Isometric hold at 40 °C (R8, R14)',
        dynamic: {
          mode: { kind: 'isometric', duration: x('30 s') },
          ...rep('200 lbf', '1.5 m/s', '1.5 m/s'),
          reps: x('1'),
          ambient: x('40 degC'),
        },
      },
      ...(['100', '60'] as const).map((lbf) => ({
        name: `Session at ${lbf} lbf (R9)`,
        dynamic: {
          mode: { kind: 'constant' as const },
          ...rep(`${lbf} lbf`, '1.5 m/s', '1 m/s'),
          reps: x('9'),
          sets: x('13'),
          rest: x('60 s'),
          startCharge: x('1'),
        },
      })),
    ];
    const requirements: TemplateRequirement[] = [
      { name: 'R1 Maximum force', quantity: 'maxForce', comparison: '>=', value: x('200 lbf') },
      { name: 'R1 Minimum force', quantity: 'minForce', comparison: '<=', value: x('5 lbf') },
      { name: 'R2 Force step', quantity: 'forceStep', comparison: '<=', value: x('1 lbf') },
      { name: 'R4 Cable travel', quantity: 'travel', comparison: '>=', value: x('2.85 m') },
      {
        name: 'R6 Speed at full force',
        quantity: 'peakCableSpeed',
        comparison: '>=',
        value: x('1.5 m/s'),
        loadCase: 0,
      },
      {
        name: 'R7 Cable speed at reduced force',
        quantity: 'peakCableSpeed',
        comparison: '>=',
        value: x('3 m/s'),
        loadCase: 1,
      },
      {
        name: 'R8 Isometric hold',
        quantity: 'holdDuration',
        comparison: '>=',
        value: x('30 s'),
        loadCase: 2,
      },
      {
        name: 'R9 Sessions per charge at 100 lbf',
        quantity: 'sessionsPerCharge',
        comparison: '>=',
        value: x('6'),
        loadCase: 3,
      },
      {
        name: 'R9 Sessions per charge at 60 lbf',
        quantity: 'sessionsPerCharge',
        comparison: '>=',
        value: x('14'),
        loadCase: 4,
      },
      { name: 'R10 Pack energy', quantity: 'packEnergy', comparison: '<', value: x('100 Wh') },
      {
        name: 'R11 Full charge at 65 W',
        quantity: 'chargeTime',
        comparison: '<=',
        value: x('2.5 h'),
      },
      { name: 'R12 Mass', quantity: 'mass', comparison: '<=', value: x('6 kg') },
      {
        name: 'R13 Envelope',
        quantity: 'envelope',
        comparison: 'within',
        value: [x('330 mm'), x('140 mm'), x('100 mm')],
      },
      {
        name: 'R18 Touchable surfaces (60 °C is an estimate: set your limit)',
        quantity: 'surfaceTemperature',
        comparison: '<=',
        value: x('60 degC'),
      },
    ];
    return { requirements, loadCases };
  },
};

const winch: MechTemplate = {
  id: 'winch',
  name: 'Winch',
  description:
    'A small electric winch with example targets: 2 kN line pull at 0.15 m/s over 15 m of line, a minute held at full pull, at most 10 kg.',
  build(x) {
    return {
      loadCases: [
        {
          name: 'Rated pull (example)',
          dynamic: {
            mode: { kind: 'constant' },
            force: x('2 kN'),
            motion: {
              kind: 'table',
              points: [
                [0, 0],
                [100, 15],
              ],
            },
            reps: x('1'),
          },
        },
        {
          name: 'Held at rated pull (example)',
          dynamic: {
            mode: { kind: 'isometric', duration: x('60 s') },
            force: x('2 kN'),
            motion: {
              kind: 'table',
              points: [
                [0, 0],
                [1, 0],
              ],
            },
            reps: x('1'),
          },
        },
      ],
      requirements: [
        { name: 'Line pull (example)', quantity: 'maxForce', comparison: '>=', value: x('2 kN') },
        {
          name: 'Line speed at rated pull (example)',
          quantity: 'peakCableSpeed',
          comparison: '>=',
          value: x('0.15 m/s'),
          loadCase: 0,
        },
        { name: 'Line length (example)', quantity: 'travel', comparison: '>=', value: x('15 m') },
        {
          name: 'Hold at rated pull (example)',
          quantity: 'holdDuration',
          comparison: '>=',
          value: x('60 s'),
          loadCase: 1,
        },
        { name: 'Mass (example)', quantity: 'mass', comparison: '<=', value: x('10 kg') },
      ],
    };
  },
};

const linearAxis: MechTemplate = {
  id: 'linear-axis',
  name: 'Linear axis',
  description:
    'A screw- or belt-driven linear axis with example targets: 500 N of thrust at 0.25 m/s over 300 mm, 100 strokes a cycle.',
  build(x) {
    return {
      loadCases: [
        {
          name: 'Pressing strokes (example)',
          dynamic: {
            mode: { kind: 'constant' },
            force: x('500 N'),
            motion: {
              kind: 'half-cosine',
              stroke: x('300 mm'),
              pullSpeed: x('0.25 m/s'),
              returnSpeed: x('0.25 m/s'),
              pause: x('0.5 s'),
            },
            reps: x('100'),
          },
        },
      ],
      requirements: [
        { name: 'Thrust (example)', quantity: 'maxForce', comparison: '>=', value: x('500 N') },
        {
          name: 'Carriage speed (example)',
          quantity: 'peakCableSpeed',
          comparison: '>=',
          value: x('0.25 m/s'),
          loadCase: 0,
        },
        { name: 'Travel (example)', quantity: 'travel', comparison: '>=', value: x('300 mm') },
      ],
    };
  },
};

/** Every template, in the order the editor lists them. */
export const MECH_TEMPLATES: readonly MechTemplate[] = [cableTrainer, winch, linearAxis];

/** The template with this id, if there is one. */
export function mechTemplate(id: string): MechTemplate | undefined {
  return MECH_TEMPLATES.find((t) => t.id === id);
}

export type TemplateCommandResult =
  | {
      ok: true;
      command: Command;
      label: string;
      requirementIds: string[];
      loadCaseIds: string[];
    }
  | { ok: false; message: string };

/**
 * One batch that appends a template's load cases (`setMechLoadCase`, fresh `lc#n`) and then its
 * requirements (one `setMechRequirements` with the document's own first), so it is one undo step.
 */
export function templateCommand(doc: ManufaktureDocument, id: string): TemplateCommandResult {
  const template = mechTemplate(id);
  if (template === undefined) return { ok: false, message: `there is no template "${id}"` };
  const units = bareUnits(doc.units);
  const { requirements, loadCases } = template.build((source) => ({ source, ...units }));
  const haveReqs = mechItems(doc.mech, 'requirements');
  const haveCases = mechItems(doc.mech, 'loadCases');
  if (haveReqs.length + requirements.length > MAX_REQUIREMENTS) {
    return { ok: false, message: `a document holds at most ${MAX_REQUIREMENTS} requirements` };
  }
  if (haveCases.length + loadCases.length > MAX_LOAD_CASES) {
    return { ok: false, message: `a document holds at most ${MAX_LOAD_CASES} load cases` };
  }
  const nextIds = doc.mech?.nextIds ?? {};
  const lc0 = peekCounter(nextIds, MECH_COUNTERS.loadCase);
  const req0 = peekCounter(nextIds, MECH_COUNTERS.requirement);
  const loadCaseIds = loadCases.map((_, i) => `${MECH_COUNTERS.loadCase}#${lc0 + i}`);
  const requirementIds = requirements.map((_, i) => `${MECH_COUNTERS.requirement}#${req0 + i}`);
  const commands: Command[] = loadCases.map((lc, i) => ({
    type: 'setMechLoadCase',
    loadCase: { id: loadCaseIds[i]!, ...lc },
  }));
  const added: Requirement[] = requirements.map(({ loadCase, ...r }, i) => ({
    id: requirementIds[i]!,
    ...r,
    ...(loadCase !== undefined ? { loadCase: loadCaseIds[loadCase]! } : {}),
  }));
  commands.push({ type: 'setMechRequirements', requirements: [...haveReqs, ...added] });
  return {
    ok: true,
    command: { type: 'batch', commands },
    label: `Add the ${template.name.toLowerCase()} template`,
    requirementIds,
    loadCaseIds,
  };
}
