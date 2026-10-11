// The shaft, key and hub checks (task T9.5b; the plan's "The checks": "bending and torsion at each
// section change, von Mises, fatigue with Marin factors and Goodman, deflection and slope at
// bearings, critical speed, keys and hub press fits"). Each states numbers and a factor against
// the user's own, or a value against a limit the user typed; none ships a limit or a factor.
//
// - `shaft.stress`: von Mises at a section from bending and torsion, with the fatigue
//   stress-concentration factors (Shigley Eq. 7-15), against the yield strength.
// - `shaft.fatigue`: the DE-Goodman factor at a section (or Gerber, ASME elliptic, Soderberg), the
//   endurance limit from the Marin factors for steel, notch factors from Peterson's charts through
//   Neuber's notch sensitivity.
// - `shaft.deflection`: the largest deflection under the transverse load; `shaft.slope`: the slope
//   at each bearing.
// - `shaft.critical-speed`: the first critical speed of the span, with the mass it carries by
//   Dunkerley, beside the fastest the shaft turns.
// - `shaft.key`: a parallel key in a keyseat section, in shear and crushing.
// - `shaft.press-fit`: the torque a press-fitted hub carries by friction; `shaft.press-fit-hub`:
//   the hub's von Mises stress at its bore from the interference, against its yield strength.

import {
  dunkerleyCriticalSpeed,
  fatigueNotchFactor,
  fromRecord,
  grooveKt,
  keyFactor,
  keyseatKt,
  lameStresses,
  marinEnduranceLimit,
  pointLoadDeflectionAt,
  pointLoadMoment,
  pressFitPressure,
  pressFitSlipFactor,
  shaftBearingSlope,
  shaftFatigueFactor,
  shaftPointLoadDeflection,
  shaftStress,
  shoulderFilletKt,
  strengthFactor,
  uniformShaftCriticalSpeed,
  type CalcInput,
  type CalcRecord,
  type CalcValue,
  type FatigueCriterion,
  type Given,
  type SurfaceFinish,
} from '@manufakture/calc';
import type { SubjectRef } from '@manufakture/core';
import { resolveEntry } from '../../parts/catalog';
import { applyInputOverrides, overridesFor } from '../overrides';
import type { CheckCompute, CheckDefinition, CheckInput, CheckModel, CheckSubject } from '../types';
import {
  SECTION_FEATURES,
  featureOf,
  isSteel,
  materialInput,
  namedMaterial,
  sectionSubject,
  shaftMaterial,
  shaftSites,
  speedInput,
  textsFor,
  torqueInput,
  transverseInput,
  typed,
  typeIt,
  type SectionFeature,
  type ShaftSite,
} from './model';
import { compose, computed, given, inputList, notComputed, val, type Inputs } from './working';

export const SHAFT_STRESS = 'shaft.stress';
export const SHAFT_FATIGUE = 'shaft.fatigue';
export const SHAFT_DEFLECTION = 'shaft.deflection';
export const SHAFT_SLOPE = 'shaft.slope';
export const SHAFT_CRITICAL_SPEED = 'shaft.critical-speed';
export const SHAFT_KEY = 'shaft.key';
export const SHAFT_PRESS_FIT = 'shaft.press-fit';
export const SHAFT_PRESS_FIT_HUB = 'shaft.press-fit-hub';

const FINISHES: readonly SurfaceFinish[] = ['ground', 'machined', 'hot-rolled', 'as-forged'];
const CRITERIA: readonly FatigueCriterion[] = ['goodman', 'gerber', 'asme-elliptic', 'soderberg'];
const TORQUE_MODES = ['pulsating', 'steady', 'reversed'] as const;
type TorqueMode = (typeof TORQUE_MODES)[number];

// Gathering --------------------------------------------------------------------------------------

/** The subject list of a record: the stage (at a section) and the load case that governs. */
function subjectsOf(site: ShaftSite, at: string | undefined, loadCase?: string): SubjectRef[] {
  const s: SubjectRef[] = [at === undefined ? site.subject : sectionSubject(site, at)];
  if (loadCase !== undefined) s.push({ kind: 'loadCase', loadCase });
  return s;
}

const MATERIAL_HINT = (site: ShaftSite, symbol: string) => typeIt(site, symbol);

/** The loads and the span every load-carrying record reads. */
function loadInputs(site: ShaftSite): Record<string, CheckInput> {
  return {
    F: transverseInput(site),
    L: typed(site, 'L', 'Span between the bearings', 'length'),
    a: typed(site, 'a', 'Load distance from the first bearing', 'length'),
  };
}

/** The section's own geometry: where it is, its diameters and radius, by its feature. */
function sectionGeometry(
  site: ShaftSite,
  at: string,
  feature: SectionFeature,
): Record<string, CheckInput> {
  const needsD = feature === 'shoulder' || feature === 'groove';
  const needsR = needsD || feature === 'keyseat';
  return {
    x: typed(site, 'x', 'Section distance from the first bearing', 'length', { at }),
    d: typed(site, 'd', 'Shaft diameter', 'length', { at }),
    D: typed(site, 'D', 'Larger diameter beside the section', 'length', {
      at,
      optional: !needsD,
    }),
    r: typed(site, 'r', 'Fillet or root radius', 'length', { at, optional: !needsR }),
  };
}

/** Inputs that refine a section's working (each replaces what the check would compute). */
function refinements(
  site: ShaftSite,
  at: string,
  symbols: readonly [string, string, CheckInput['kind']][],
): Record<string, CheckInput> {
  const out: Record<string, CheckInput> = {};
  for (const [symbol, name, kind] of symbols) {
    out[symbol] = typed(site, symbol, name, kind, {
      at,
      optional: true,
      why: `computed unless you ${typeIt(site, symbol, at)}`,
    });
  }
  return out;
}

/** Whether the shaft's material is a steel, which Neuber's notch-sensitivity fit is for. */
function steelInput(mat: ReturnType<typeof shaftMaterial>): CheckInput {
  const steel = isSteel(mat);
  return {
    name: 'A steel (Neuber fit applies)',
    value: steel ? 1 : 0,
    source:
      mat.material === undefined
        ? 'no material is known, so the fit for steel is not used'
        : `${mat.material.name} is ${steel ? '' : 'not '}a steel`,
    ref: { kind: 'given' },
    kind: 'number',
    optional: true,
  };
}

/** A feature that does not read, as an input the record names as missing. */
function badFeature(why: string): CheckInput {
  return {
    name: 'Section feature',
    value: undefined,
    source: 'your feature text',
    ref: { kind: 'given' },
    kind: 'number',
    missing: why,
  };
}

interface SectionContext {
  site: ShaftSite;
  at: string;
  feature: SectionFeature | { unknown: string };
  subject: SubjectRef[];
}

/** Every section of every described shaft, with its feature as the check sees it. */
function sections(model: CheckModel, check: string): SectionContext[] {
  const out: SectionContext[] = [];
  for (const site of shaftSites(model)) {
    for (const at of site.sections) {
      const subject = subjectsOf(site, at, site.governing?.loadCase.id);
      out.push({ site, at, feature: featureOf(model, check, subject), subject });
    }
  }
  return out;
}

function sectionTitle(what: string, site: ShaftSite, at: string): string {
  return `${what}, ${site.name} at ${at}`;
}

// Working -------------------------------------------------------------------------------------

const NREQ = (main: CalcRecord): CalcInput[] => main.inputs.filter((i) => i.symbol === 'n_req');

function featureText(texts: Readonly<Record<string, string>>, inputs: Inputs): SectionFeature {
  const typed = texts.feature?.trim().toLowerCase();
  // A feature that does not read is already a missing input of the record (`badFeature`).
  if (typed !== undefined) {
    return SECTION_FEATURES.includes(typed as SectionFeature) ? (typed as SectionFeature) : 'plain';
  }
  return val(inputs, 'D') !== undefined ? 'shoulder' : 'plain';
}

/** The bending moment at the section: typed, or from the load by statics. */
function moment(inputs: Inputs): { M: Given; derived: CalcValue[]; assumptions: string[] } {
  const typedM = given(inputs, 'M');
  if (typedM?.value !== undefined) return { M: typedM, derived: [], assumptions: [] };
  const F = val(inputs, 'F');
  const L = val(inputs, 'L');
  const x = val(inputs, 'x');
  const a = val(inputs, 'a');
  if (F === undefined || L === undefined || x === undefined || a === undefined) {
    return {
      M: computed(undefined, 'the load, its distance, the span and the section position'),
      derived: [],
      assumptions: [],
    };
  }
  const M = pointLoadMoment(F, a, L, x);
  return {
    M: computed(
      M,
      `statics: F at a = ${(a * 1000).toPrecision(4)} mm on a span of ${(L * 1000).toPrecision(4)} mm, at x`,
    ),
    derived: [{ name: 'Bending moment at the section', symbol: 'M', value: M, unit: 'N·m' }],
    assumptions: [
      'The shaft is a beam on two simple supports (its bearings) with one transverse load',
      ...(a > L ? ['The load overhangs bearing B (a > L)'] : []),
      ...(x > Math.max(L, a) || x < 0
        ? ['The section is outside the loaded length: no bending there']
        : []),
    ],
  };
}

interface Concentration {
  steps: CalcRecord[];
  Kf: Given;
  Kfs: Given;
  assumptions: string[];
}

/**
 * The fatigue stress-concentration factors at a section: typed, or the theoretical factor from
 * Peterson's charts for the feature reduced by Neuber's notch sensitivity (taken as 1, Kf = Kt,
 * outside the steel fit's range).
 */
function concentration(feature: SectionFeature, inputs: Inputs): Concentration {
  const steps: CalcRecord[] = [];
  const assumptions: string[] = [];
  const typedKf = given(inputs, 'Kf');
  const typedKfs = given(inputs, 'Kfs');
  const d = val(inputs, 'd');
  const D = val(inputs, 'D');
  const r = val(inputs, 'r');
  const Sut = given(inputs, 'Sut');
  // Written by the check's subjects from the material: Neuber's fit is for steel only.
  const steel = val(inputs, 'steel') === 1;
  const one = (what: string): Given => ({ value: 1, source: what });
  const kt = (loading: 'bending' | 'torsion'): CalcRecord | undefined => {
    switch (feature) {
      case 'shoulder':
        return shoulderFilletKt({ D, d, r }, loading);
      case 'groove':
        return grooveKt({ D, d, r }, loading);
      case 'keyseat':
        return keyseatKt({ D: d, r }, loading);
      default:
        return undefined;
    }
  };
  const factor = (loading: 'bending' | 'torsion', typedK: Given | undefined): Given => {
    if (typedK?.value !== undefined) return typedK;
    if (feature === 'plain') return one('plain section: no stress concentration');
    if (feature === 'press-fit') {
      return {
        value: undefined,
        source: `a press fit's factor is not charted here: type ${loading === 'bending' ? 'Kf' : 'Kfs'}`,
      };
    }
    const k = kt(loading)!;
    steps.push(k);
    if (k.result === null) return fromRecord(k);
    if (!steel) {
      assumptions.push(
        `${loading === 'bending' ? 'K_f' : 'K_fs'} = K_t (notch sensitivity 1): Neuber's notch-sensitivity fit is for steel, and the material is not a steel (type Kf and Kfs from its data to do better)`,
      );
      return { value: k.result, source: `calc record ${k.id} (notch sensitivity taken as 1)` };
    }
    const q = fatigueNotchFactor({ Kt: fromRecord(k), r, Sut }, loading);
    if (q.result === null) {
      assumptions.push(
        `${loading === 'bending' ? 'K_f' : 'K_fs'} = K_t (notch sensitivity 1): ${q.note ?? 'the Neuber fit does not apply'}`,
      );
      return { value: k.result, source: `calc record ${k.id} (notch sensitivity taken as 1)` };
    }
    steps.push(q);
    return fromRecord(q);
  };
  const Kf = factor('bending', typedKf);
  const Kfs = factor('torsion', typedKfs);
  return { steps, Kf, Kfs, assumptions };
}

function stressRecord(c: CheckCompute): CalcRecord {
  const { inputs, factor, texts, options } = c;
  const feature = featureText(texts, inputs);
  const m = moment(inputs);
  const k = concentration(feature, inputs);
  const stress = shaftStress({
    M: m.M,
    T: given(inputs, 'T'),
    d: given(inputs, 'd'),
    di: given(inputs, 'd_i'),
    Kf: k.Kf,
    Kfs: k.Kfs,
  });
  const main = strengthFactor(
    { stress: fromRecord(stress), strength: given(inputs, 'Sy'), requiredFactor: factor },
    options,
  );
  return compose({
    main,
    steps: [...k.steps, stress],
    method:
      'Von Mises stress at the section from the bending moment (statics of the shaft on its bearings) and the torque, with the fatigue stress-concentration factors, against the yield strength',
    formula: `${
      (val(inputs, 'a') ?? 0) > (val(inputs, 'L') ?? Infinity)
        ? 'M = F (a - L) x / L (x <= L), F (a - x) (L <= x <= a)'
        : 'M = F (L - a) x / L (x <= a), F a (L - x) / L (x >= a)'
    }; σ' = √((K_f 32 M / π d³)² + 3 (K_fs 16 T / π d³)²); n = S_y / σ'`,
    inputs: [
      {
        name: 'Von Mises stress',
        symbol: "σ'",
        value: stress.result,
        unit: 'Pa',
        source: 'computed at the section from M, T, d, K_f and K_fs',
      },
      ...inputList(inputs, [
        'Sy',
        'F',
        'T',
        'L',
        'a',
        'x',
        'd',
        'D',
        'r',
        'd_i',
        'Sut',
        'M',
        'Kf',
        'Kfs',
      ]),
      ...NREQ(main),
    ],
    derived: m.derived,
    assumptions: [
      ...m.assumptions,
      ...k.assumptions,
      'The peak torque and the peak bending act together, at the peak cable tension',
      'The whole torque acts at the section (a section outside the torque path carries less: type T for it)',
      `Section: ${feature}`,
    ],
  });
}

/** Alternating and mean torques by the torque's pattern. */
function torques(inputs: Inputs, mode: TorqueMode): { Ta: Given; Tm: Given; assumption: string } {
  const T = val(inputs, 'T');
  const half = T === undefined ? undefined : T / 2;
  const by: Record<TorqueMode, [number | undefined, number | undefined, string]> = {
    pulsating: [
      half,
      half,
      'The torque rises from zero to its peak and back each rep: T_a = T_m = T/2',
    ],
    steady: [0, T, 'The torque is steady: T_a = 0, T_m = T'],
    reversed: [T, 0, 'The torque reverses fully: T_a = T, T_m = 0'],
  };
  const [a, m, assumption] = by[mode];
  return {
    Ta:
      given(inputs, 'Ta')?.value !== undefined
        ? given(inputs, 'Ta')!
        : computed(a, `the torque, ${mode}`),
    Tm:
      given(inputs, 'Tm')?.value !== undefined
        ? given(inputs, 'Tm')!
        : computed(m, `the torque, ${mode}`),
    assumption,
  };
}

function fatigueRecord(c: CheckCompute): CalcRecord {
  const { inputs, factor, texts, options } = c;
  const method =
    'Distortion-energy fatigue factor at the section: fully reversed bending as the shaft turns under a load of fixed direction, the torque by its pattern, the endurance limit from the Marin factors, notch factors from Peterson through Neuber';
  const unit = { id: options.id, title: options.title, unit: '1' };
  const criterion = (texts.criterion?.trim().toLowerCase() ?? 'goodman') as FatigueCriterion;
  const finish = (texts.finish?.trim().toLowerCase() ?? 'machined') as SurfaceFinish;
  const mode = (texts.torque?.trim().toLowerCase() ?? 'pulsating') as TorqueMode;
  const bad = !CRITERIA.includes(criterion)
    ? `"${texts.criterion}" is not a criterion (${CRITERIA.join(', ')})`
    : !FINISHES.includes(finish)
      ? `"${texts.finish}" is not a finish (${FINISHES.join(', ')})`
      : !TORQUE_MODES.includes(mode)
        ? `"${texts.torque}" is not a torque pattern (${TORQUE_MODES.join(', ')})`
        : undefined;
  if (bad !== undefined) return notComputed(unit, method, '', [], bad);
  if ((val(inputs, 'd_i') ?? 0) > 0) {
    return notComputed(
      unit,
      method,
      '',
      [],
      'The fatigue factor here is for a solid shaft; the shaft has a bore',
    );
  }
  const feature = featureText(texts, inputs);
  const m = moment(inputs);
  const k = concentration(feature, inputs);
  const t = torques(inputs, mode);
  const steps: CalcRecord[] = [...k.steps];
  let Se = given(inputs, 'Se');
  const assumptions: string[] = [];
  if (Se?.value === undefined) {
    const marin = marinEnduranceLimit(
      { Sut: given(inputs, 'Sut'), d: given(inputs, 'd'), reliability: given(inputs, 'R') },
      { surface: finish, loading: 'bending', rotating: true },
    );
    steps.push(marin);
    Se = fromRecord(marin);
    if (texts.finish === undefined) assumptions.push('Machined surface (type finish to change it)');
  }
  const typedMa = given(inputs, 'Ma');
  const typedMm = given(inputs, 'Mm');
  const main = shaftFatigueFactor(
    {
      Ma:
        typedMa?.value !== undefined
          ? typedMa
          : { ...m.M, source: `${m.M.source} (fully reversed)` },
      Mm:
        typedMm?.value !== undefined
          ? typedMm
          : computed(0, 'a rotating shaft under a load of fixed direction'),
      Ta: t.Ta,
      Tm: t.Tm,
      d: given(inputs, 'd'),
      Kf: k.Kf,
      Kfs: k.Kfs,
      Se,
      Sut: given(inputs, 'Sut'),
      Sy: given(inputs, 'Sy'),
      requiredFactor: factor,
    },
    criterion,
    options,
  );
  return compose({
    main,
    steps,
    method,
    formula: `${main.formula}; A = √(4 (K_f M_a)² + 3 (K_fs T_a)²), B = √(4 (K_f M_m)² + 3 (K_fs T_m)²)`,
    inputs: [
      {
        name: 'Endurance limit at the section',
        symbol: 'S_e',
        value: Se.value ?? null,
        unit: 'Pa',
        source: Se.source,
      },
      ...inputList(inputs, [
        'Sut',
        'Sy',
        'F',
        'T',
        'L',
        'a',
        'x',
        'd',
        'D',
        'r',
        'M',
        'Ma',
        'Mm',
        'Ta',
        'Tm',
        'Kf',
        'Kfs',
        'R',
      ]),
      ...NREQ(main),
    ],
    derived: m.derived,
    assumptions: [
      ...m.assumptions,
      ...k.assumptions,
      ...(typedMa?.value === undefined ? ['Bending is fully reversed: M_a = M, M_m = 0'] : []),
      t.assumption,
      ...assumptions,
      `Section: ${feature}; criterion: ${criterion}`,
    ],
  });
}

// The checks ------------------------------------------------------------------------------------

function sectionCheck(
  model: CheckModel,
  check: string,
  what: string,
  extra: (s: SectionContext, texts: Record<string, string>) => Record<string, CheckInput>,
  keep: (feature: SectionFeature) => boolean = () => true,
): CheckSubject[] {
  const out: CheckSubject[] = [];
  for (const s of sections(model, check)) {
    if (typeof s.feature === 'string' && !keep(s.feature)) continue;
    const texts = textsFor(model, check, s.subject);
    const feature = typeof s.feature === 'string' ? s.feature : 'plain';
    const inputs: Record<string, CheckInput> = {
      ...loadInputs(s.site),
      T: torqueInput(s.site),
      ...sectionGeometry(s.site, s.at, feature),
      ...extra(s, texts),
    };
    if (typeof s.feature !== 'string') inputs.feature = badFeature(s.feature.unknown);
    out.push({
      location: `${s.site.location}/${s.at}`,
      title: sectionTitle(what, s.site, s.at),
      subject: s.subject,
      ...(s.site.governing !== undefined ? { loadCase: s.site.governing.loadCase.id } : {}),
      inputs,
    });
  }
  return out;
}

export const shaftStressCheck: CheckDefinition = {
  id: SHAFT_STRESS,
  title: 'Shaft stress at a section against the yield strength',
  version: 1,
  factor: 'strength',
  subjects(model) {
    return sectionCheck(model, SHAFT_STRESS, 'Shaft stress', (s, texts) => {
      const mat = shaftMaterial(model, s.site, texts);
      const pressFit = s.feature === 'press-fit';
      return {
        Sy: materialInput(
          model,
          mat,
          'yieldStrength',
          'Yield strength',
          'pressure',
          MATERIAL_HINT(s.site, 'Sy'),
        ),
        steel: steelInput(mat),
        // For the notch sensitivity only: without it K_f = K_t.
        Sut: {
          ...materialInput(
            model,
            mat,
            'ultimateStrength',
            'Ultimate tensile strength',
            'pressure',
            MATERIAL_HINT(s.site, 'Sut'),
          ),
          optional: true,
        },
        d_i: typed(s.site, 'd_i', 'Bore diameter (hollow shaft)', 'length', {
          optional: true,
          why: 'a solid shaft',
        }),
        ...refinements(s.site, s.at, [['M', 'Bending moment at the section', 'torque']]),
        Kf: typed(s.site, 'Kf', 'Fatigue stress-concentration factor, bending', 'number', {
          at: s.at,
          optional: !pressFit,
        }),
        Kfs: typed(s.site, 'Kfs', 'Fatigue stress-concentration factor, torsion', 'number', {
          at: s.at,
          optional: !pressFit,
        }),
      };
    });
  },
  compute: stressRecord,
};

export const shaftFatigueCheck: CheckDefinition = {
  id: SHAFT_FATIGUE,
  title: 'Shaft fatigue at a section (distortion energy)',
  version: 1,
  factor: 'fatigue',
  subjects(model) {
    return sectionCheck(model, SHAFT_FATIGUE, 'Shaft fatigue', (s, texts) => {
      const mat = shaftMaterial(model, s.site, texts);
      const steel = isSteel(mat);
      const pressFit = s.feature === 'press-fit';
      return {
        steel: steelInput(mat),
        Sut: materialInput(
          model,
          mat,
          'ultimateStrength',
          'Ultimate tensile strength',
          'pressure',
          MATERIAL_HINT(s.site, 'Sut'),
        ),
        Sy: materialInput(
          model,
          mat,
          'yieldStrength',
          'Yield strength',
          'pressure',
          MATERIAL_HINT(s.site, 'Sy'),
        ),
        Se: typed(s.site, 'Se', 'Endurance limit at the section', 'pressure', {
          at: s.at,
          optional: steel,
          why: steel
            ? `from the Marin factors unless you ${typeIt(s.site, 'Se', s.at)}`
            : mat.material === undefined
              ? `no material is known, so the Marin estimate (for steel) does not apply: name a steel material or ${typeIt(s.site, 'Se', s.at)}`
              : `the Marin estimate is for steel, and ${mat.material.name} is not a steel: ${typeIt(s.site, 'Se', s.at)}`,
        }),
        R: typed(s.site, 'R', 'Reliability', 'number', {
          optional: true,
          why: `mean values (k_e = 1) unless you ${typeIt(s.site, 'R')}`,
        }),
        d_i: typed(s.site, 'd_i', 'Bore diameter (hollow shaft)', 'length', {
          optional: true,
          why: 'a solid shaft',
        }),
        ...refinements(s.site, s.at, [
          ['M', 'Bending moment at the section', 'torque'],
          ['Ma', 'Alternating bending moment', 'torque'],
          ['Mm', 'Mean bending moment', 'torque'],
          ['Ta', 'Alternating torque', 'torque'],
          ['Tm', 'Mean torque', 'torque'],
        ]),
        Kf: typed(s.site, 'Kf', 'Fatigue stress-concentration factor, bending', 'number', {
          at: s.at,
          optional: !pressFit,
        }),
        Kfs: typed(s.site, 'Kfs', 'Fatigue stress-concentration factor, torsion', 'number', {
          at: s.at,
          optional: !pressFit,
        }),
      };
    }).map((sub) => {
      // The title names the criterion the record uses.
      const c = textsFor(model, SHAFT_FATIGUE, sub.subject).criterion?.trim().toLowerCase();
      const label =
        c === undefined || c === 'goodman'
          ? 'DE-Goodman'
          : c === 'gerber'
            ? 'DE-Gerber'
            : c === 'asme-elliptic'
              ? 'DE-ASME elliptic'
              : c === 'soderberg'
                ? 'DE-Soderberg'
                : c;
      return { ...sub, title: sub.title.replace(/^Shaft fatigue/, `Shaft fatigue (${label})`) };
    });
  },
  compute: fatigueRecord,
};

/** The shaft's diameter for its deflection: typed for the stage, else its smallest section's. */
function deflectionDiameter(model: CheckModel, check: string, site: ShaftSite): CheckInput {
  const base = typed(site, 'd', 'Shaft diameter', 'length', {
    why: `${typeIt(site, 'd')} (or give its sections their diameters: the smallest is used)`,
  });
  let best: CheckInput | undefined;
  let at: string | undefined;
  for (const s of site.sections) {
    const subject = [sectionSubject(site, s)];
    const { inputs } = applyInputOverrides(
      model,
      { location: '', title: '', subject, inputs: { d: base } },
      overridesFor(model, check, subject),
    );
    const d = inputs.d!;
    if (d.value !== undefined && (best === undefined || d.value < best.value!)) {
      best = d;
      at = s;
    }
  }
  if (best === undefined) return base;
  return {
    ...best,
    name: 'Shaft diameter',
    source: `the smallest section diameter, at ${at}: ${best.source}`,
  };
}

function shaftInputs(
  model: CheckModel,
  check: string,
  site: ShaftSite,
): Record<string, CheckInput> {
  const texts = textsFor(model, check, [site.subject]);
  const mat = shaftMaterial(model, site, texts);
  return {
    ...loadInputs(site),
    d: deflectionDiameter(model, check, site),
    d_i: typed(site, 'd_i', 'Bore diameter (hollow shaft)', 'length', {
      optional: true,
      why: 'a solid shaft',
    }),
    E: materialInput(
      model,
      mat,
      'elasticModulus',
      "Young's modulus",
      'pressure',
      MATERIAL_HINT(site, 'E'),
    ),
  };
}

const DEFLECTION_ASSUMPTIONS = [
  'A stepped shaft is taken as uniform at its smallest diameter, which overstates the deflection',
];

export const shaftDeflectionCheck: CheckDefinition = {
  id: SHAFT_DEFLECTION,
  title: 'Shaft deflection under the transverse load',
  version: 1,
  subjects(model) {
    return shaftSites(model).map((site) => ({
      location: site.location,
      title: `Shaft deflection, ${site.name}`,
      subject: subjectsOf(site, undefined, site.governing?.loadCase.id),
      ...(site.governing !== undefined ? { loadCase: site.governing.loadCase.id } : {}),
      inputs: {
        ...shaftInputs(model, SHAFT_DEFLECTION, site),
        y_max: typed(site, 'y_max', 'Your allowed deflection', 'length', {
          optional: true,
          why: `nothing to compare with unless you ${typeIt(site, 'y_max')}`,
        }),
      },
    }));
  },
  compute({ inputs, options }) {
    const r = shaftPointLoadDeflection(
      {
        F: given(inputs, 'F'),
        a: given(inputs, 'a'),
        L: given(inputs, 'L'),
        E: given(inputs, 'E'),
        d: given(inputs, 'd'),
        di: given(inputs, 'd_i'),
        maxDeflection: given(inputs, 'y_max'),
      },
      options,
    );
    return { ...r, assumptions: [...r.assumptions, ...DEFLECTION_ASSUMPTIONS] };
  },
};

/** Shigley 10th ed. Table 7-2's typical range of the largest slope at bearings of a type, rad. */
const TYPICAL_SLOPES: Readonly<Record<string, readonly [number, number]>> = {
  'deep groove ball': [0.001, 0.003],
  'cylindrical roller': [0.0008, 0.0012],
  'tapered roller': [0.0005, 0.0012],
  'spherical ball': [0.026, 0.052],
  'self-aligning ball': [0.026, 0.052],
};

/** The bearing's type's typical largest slope, as an input stated beside the slope. */
function typicalSlope(model: CheckModel, site: ShaftSite, index: number): CheckInput | undefined {
  const use = site.bearings[index]?.use;
  if (use === undefined) return undefined;
  const e = resolveEntry(model.document, use.entry);
  if (!e.ok) return undefined;
  const t = Object.hasOwn(e.entry.ratings, 'type') ? e.entry.ratings.type : undefined;
  const text = t !== undefined && 'text' in t ? t.text : undefined;
  const range =
    text === undefined || !Object.hasOwn(TYPICAL_SLOPES, text) ? undefined : TYPICAL_SLOPES[text];
  if (range === undefined) return undefined;
  return {
    name: 'Typical largest slope for the bearing type',
    value: range[1],
    source: `Shigley 10th ed. Table 7-2, unverified (from memory of the book, not checked against a copy): ${range[0]} to ${range[1]} rad at a ${text} bearing (the upper end; a typical range, not your limit)`,
    ref: { kind: 'given' },
    kind: 'angle',
    optional: true,
  };
}

export const shaftSlopeCheck: CheckDefinition = {
  id: SHAFT_SLOPE,
  title: 'Shaft slope at its bearings',
  version: 1,
  subjects(model) {
    const out: CheckSubject[] = [];
    for (const site of shaftSites(model)) {
      for (const [i, side] of (['A', 'B'] as const).entries()) {
        const bearing = site.bearings[i];
        const subject: SubjectRef[] = [
          { ...site.subject, at: `bearing ${side}` },
          ...(bearing?.use !== undefined ? [{ kind: 'purchased' as const, use: bearing.id }] : []),
          ...(site.governing !== undefined
            ? [{ kind: 'loadCase' as const, loadCase: site.governing.loadCase.id }]
            : []),
        ];
        const typical = typicalSlope(model, site, i);
        out.push({
          location: `${site.location}/bearing-${side}`,
          title: `Shaft slope, ${site.name} at ${bearing?.name ?? `bearing ${side}`}`,
          subject,
          ...(site.governing !== undefined ? { loadCase: site.governing.loadCase.id } : {}),
          inputs: {
            ...shaftInputs(model, SHAFT_SLOPE, site),
            theta_max: typed(site, 'theta_max', 'Your allowed slope', 'angle', {
              optional: true,
              why: `nothing to compare with unless you ${typeIt(site, 'theta_max')}`,
            }),
            ...(typical !== undefined ? { theta_typ: typical } : {}),
          },
        });
      }
    }
    return out;
  },
  compute({ inputs, options }) {
    const side = options.id.endsWith('/bearing-B') ? 'B' : 'A';
    const r = shaftBearingSlope(
      {
        F: given(inputs, 'F'),
        a: given(inputs, 'a'),
        L: given(inputs, 'L'),
        E: given(inputs, 'E'),
        d: given(inputs, 'd'),
        di: given(inputs, 'd_i'),
        maxSlope: given(inputs, 'theta_max'),
      },
      side,
      options,
    );
    const typical = given(inputs, 'theta_typ');
    const out: CalcRecord = {
      ...r,
      assumptions: [...r.assumptions, ...DEFLECTION_ASSUMPTIONS],
    };
    if (typical?.value !== undefined) {
      out.inputs = [
        ...r.inputs,
        {
          name: 'Typical largest slope for the bearing type',
          symbol: 'θ_typ',
          value: typical.value,
          unit: 'rad',
          source: typical.source,
        },
      ];
      out.sources = [...r.sources, { title: r.sources[0]!.title, locator: 'Table 7-2' }];
      if (r.result !== null) {
        out.derived = [
          ...r.derived,
          {
            name: 'Slope over the typical largest slope',
            symbol: 'θ/θ_typ',
            value: r.result / typical.value,
            unit: '1',
          },
        ];
      }
    }
    return out;
  },
};

export const shaftCriticalSpeedCheck: CheckDefinition = {
  id: SHAFT_CRITICAL_SPEED,
  title: 'First critical speed of the shaft',
  version: 1,
  subjects(model) {
    return shaftSites(model).map((site) => {
      const texts = textsFor(model, SHAFT_CRITICAL_SPEED, [site.subject]);
      const mat = shaftMaterial(model, site, texts);
      const lc = site.peakSpeed?.loadCase.id;
      const density: CheckInput =
        mat.material === undefined
          ? {
              name: 'Density',
              value: undefined,
              source: 'not given',
              ref: { kind: 'given' },
              kind: 'number',
              missing: mat.why,
            }
          : {
              name: 'Density',
              value: mat.material.density,
              source: `${mat.material.name} (${mat.from}): ${mat.material.source}`,
              ref: { kind: 'material', id: mat.id, property: 'density' },
              kind: 'number',
            };
      const inputs = shaftInputs(model, SHAFT_CRITICAL_SPEED, site);
      delete inputs.F;
      // The bare shaft does not use the load's position; with a mass m, compute names it.
      inputs.a = { ...inputs.a!, optional: true };
      return {
        location: site.location,
        title: `Critical speed, ${site.name}`,
        subject: subjectsOf(site, undefined, lc),
        ...(lc !== undefined ? { loadCase: lc } : {}),
        inputs: {
          ...inputs,
          rho: density,
          m: typed(site, 'm', 'Mass carried on the shaft', 'mass', {
            optional: true,
            why: `the bare shaft unless you ${typeIt(site, 'm')} (the spool and what turns with it)`,
          }),
          omega: speedInput(site),
        },
      };
    });
  },
  compute({ inputs, options }) {
    const alone = uniformShaftCriticalSpeed({
      L: given(inputs, 'L'),
      d: given(inputs, 'd'),
      E: given(inputs, 'E'),
      density: given(inputs, 'rho'),
      di: given(inputs, 'd_i'),
    });
    const m = val(inputs, 'm');
    const a = val(inputs, 'a');
    const L = val(inputs, 'L');
    const E = val(inputs, 'E');
    const d = val(inputs, 'd');
    const order = ['L', 'd', 'd_i', 'E', 'rho', 'm', 'a', 'omega'];
    const method =
      "The bare span's first bending mode, combined with the mass the shaft carries by Dunkerley's equation (a lower estimate)";
    const formula =
      'ω_s = (π / L)² √(E I / (ρ A)); 1/ω₁² = 1/ω_s² + m a₁₁; a₁₁ = deflection at the mass per newton';
    if (m !== undefined && a === undefined) {
      // Where the mass sits is not guessed.
      return notComputed(
        { id: options.id, title: options.title, unit: 'rad/s' },
        method,
        formula,
        inputList(inputs, order),
        'Missing: Load distance from the first bearing (where the mass m sits)',
        ['Load distance from the first bearing'],
      );
    }
    const steps: CalcRecord[] = [alone];
    let main: CalcRecord;
    const assumptions: string[] = [];
    const derived: CalcValue[] = [];
    if (
      m !== undefined &&
      a !== undefined &&
      L !== undefined &&
      E !== undefined &&
      d !== undefined
    ) {
      const di = val(inputs, 'd_i') ?? 0;
      const EI = (E * Math.PI * (d ** 4 - di ** 4)) / 64;
      const influence = pointLoadDeflectionAt(1, a, L, EI, a);
      derived.push({
        name: 'Deflection at the mass per newton',
        symbol: 'a_11',
        value: influence,
        unit: 'm/N',
      });
      main = dunkerleyCriticalSpeed(
        [{ mass: given(inputs, 'm'), influence }],
        fromRecord(alone),
        options,
      );
      assumptions.push('The mass sits where the transverse load does (a)');
      const omega = val(inputs, 'omega');
      if (main.result !== null && omega !== undefined && omega > 0) {
        derived.push({
          name: 'Critical speed over the highest operating speed',
          symbol: 'ω₁/ω',
          value: main.result / omega,
          unit: '1',
        });
        assumptions.push(
          'Shigley suggests keeping the first critical speed at least twice the operating speed',
        );
      }
    } else {
      main = { ...alone, id: options.id, title: options.title };
      steps.length = 0;
      assumptions.push(
        'No mass on the shaft is given (type m and a): this is the bare shaft alone, faster than with the spool on it, so it is not compared with the operating speed',
      );
    }
    return compose({
      main,
      steps,
      method:
        m === undefined
          ? "The bare shaft's first bending mode only, without the mass it carries (no m given): not compared with the operating speed"
          : method,
      formula,
      inputs: inputList(inputs, order),
      derived,
      assumptions: [
        ...assumptions,
        'Simply supported span; an overhung part of the shaft is not counted in the bare shaft term',
        ...DEFLECTION_ASSUMPTIONS,
      ],
    });
  },
};

export const shaftKeyCheck: CheckDefinition = {
  id: SHAFT_KEY,
  title: 'Parallel key in shear and crushing',
  version: 1,
  factor: 'strength',
  subjects(model) {
    return sectionCheck(
      model,
      SHAFT_KEY,
      'Key',
      (s, texts) => {
        const key = namedMaterial(model, texts, 'keyMaterial');
        return {
          w: typed(s.site, 'w', 'Key width', 'length', { at: s.at }),
          h: typed(s.site, 'h', 'Key height', 'length', { at: s.at }),
          Sy: materialInput(
            model,
            shaftMaterial(model, s.site, texts),
            'yieldStrength',
            'Yield strength',
            'pressure',
            MATERIAL_HINT(s.site, 'Sy'),
          ),
          Sy_hub: materialInput(
            model,
            namedMaterial(model, texts, 'hubMaterial'),
            'yieldStrength',
            'Yield strength of the hub',
            'pressure',
            typeIt(s.site, 'Sy_hub', s.at),
          ),
          l_key: typed(s.site, 'l_key', 'Key length', 'length', { at: s.at }),
          Sy_key: materialInput(
            model,
            key,
            'yieldStrength',
            'Yield strength of the key',
            'pressure',
            typeIt(s.site, 'Sy_key', s.at),
          ),
        };
      },
      (f) => f === 'keyseat',
    ).map((s) => {
      // The key reads the torque and the section's diameter only.
      const { F: _f, L: _l, a: _a, x: _x, D: _d, r: _r, ...inputs } = s.inputs;
      void [_f, _l, _a, _x, _d, _r];
      return { ...s, inputs };
    });
  },
  compute({ inputs, factor, options }) {
    return keyFactor(
      {
        T: given(inputs, 'T'),
        d: given(inputs, 'd'),
        w: given(inputs, 'w'),
        h: given(inputs, 'h'),
        l: given(inputs, 'l_key'),
        Sy: given(inputs, 'Sy_key'),
        SyShaft: given(inputs, 'Sy'),
        SyHub: given(inputs, 'Sy_hub'),
        requiredFactor: factor,
      },
      options,
    );
  },
};

/** The fit's own inputs: the interference, the hub and the two materials. */
function fitInputs(model: CheckModel, s: SectionContext, texts: Record<string, string>) {
  const shaft = shaftMaterial(model, s.site, texts);
  const hub = namedMaterial(model, texts, 'hubMaterial');
  return {
    delta: typed(s.site, 'delta', 'Diametral interference', 'length', { at: s.at }),
    D_hub: typed(s.site, 'D_hub', 'Hub outside diameter', 'length', { at: s.at }),
    d_i: typed(s.site, 'd_i', 'Bore diameter (hollow shaft)', 'length', {
      optional: true,
      why: 'a solid shaft',
    }),
    E: materialInput(
      model,
      shaft,
      'elasticModulus',
      "Young's modulus",
      'pressure',
      typeIt(s.site, 'E'),
    ),
    nu: materialInput(
      model,
      shaft,
      'poissonRatio',
      "Poisson's ratio",
      'number',
      typeIt(s.site, 'nu'),
    ),
    E_hub: materialInput(
      model,
      hub,
      'elasticModulus',
      "Young's modulus of the hub",
      'pressure',
      typeIt(s.site, 'E_hub', s.at),
    ),
    nu_hub: materialInput(
      model,
      hub,
      'poissonRatio',
      "Poisson's ratio of the hub",
      'number',
      typeIt(s.site, 'nu_hub', s.at),
    ),
  } satisfies Record<string, CheckInput>;
}

function pressure(inputs: Inputs): CalcRecord {
  return pressFitPressure({
    delta: given(inputs, 'delta'),
    d: given(inputs, 'd'),
    do: given(inputs, 'D_hub'),
    di: given(inputs, 'd_i'),
    Eo: given(inputs, 'E_hub'),
    nuo: given(inputs, 'nu_hub'),
    Ei: given(inputs, 'E'),
    nui: given(inputs, 'nu'),
  });
}

export const shaftPressFitCheck: CheckDefinition = {
  id: SHAFT_PRESS_FIT,
  title: 'Press-fitted hub: torque capacity against the torque',
  version: 1,
  factor: 'strength',
  subjects(model) {
    return sectionCheck(
      model,
      SHAFT_PRESS_FIT,
      'Press fit',
      (s, texts) => ({
        ...fitInputs(model, s, texts),
        l_hub: typed(s.site, 'l_hub', 'Fit length', 'length', { at: s.at }),
        f: typed(s.site, 'f', 'Friction coefficient', 'number', { at: s.at }),
      }),
      (f) => f === 'press-fit',
    ).map((s) => {
      const { F: _f, L: _l, a: _a, x: _x, D: _d, r: _r, ...inputs } = s.inputs;
      void [_f, _l, _a, _x, _d, _r];
      return { ...s, inputs };
    });
  },
  compute({ inputs, factor, options }) {
    const p = pressure(inputs);
    const main = pressFitSlipFactor(
      {
        T: given(inputs, 'T'),
        p: fromRecord(p),
        f: given(inputs, 'f'),
        l: given(inputs, 'l_hub'),
        d: given(inputs, 'd'),
        requiredFactor: factor,
      },
      options,
    );
    return compose({
      main,
      steps: [p],
      method:
        'Interface pressure from the interference (Lamé, hub and shaft elastic), then the torque friction carries over the fit, against the torque through the shaft',
      formula: `${p.formula}; ${main.formula}`,
      inputs: [
        {
          name: 'Interface pressure',
          symbol: 'p',
          value: p.result,
          unit: 'Pa',
          source: `calc record ${p.id}`,
        },
        ...inputList(inputs, [
          'T',
          'f',
          'l_hub',
          'd',
          'delta',
          'D_hub',
          'd_i',
          'E',
          'nu',
          'E_hub',
          'nu_hub',
        ]),
        ...NREQ(main),
      ],
      assumptions: [
        'The smallest interference the tolerances allow gives the least torque: type that one',
      ],
    });
  },
};

export const shaftPressFitHubCheck: CheckDefinition = {
  id: SHAFT_PRESS_FIT_HUB,
  title: 'Press-fitted hub: von Mises at its bore against its yield strength',
  version: 1,
  factor: 'strength',
  subjects(model) {
    return sectionCheck(
      model,
      SHAFT_PRESS_FIT_HUB,
      'Hub stress',
      (s, texts) => {
        const hub = namedMaterial(model, texts, 'hubMaterial');
        return {
          ...fitInputs(model, s, texts),
          Sy_hub: materialInput(
            model,
            hub,
            'yieldStrength',
            'Yield strength of the hub',
            'pressure',
            typeIt(s.site, 'Sy_hub', s.at),
          ),
        };
      },
      (f) => f === 'press-fit',
    ).map((s) => {
      // The fit's own stress: no load case changes it.
      const { F: _f, T: _t, L: _l, a: _a, x: _x, D: _d, r: _r, ...inputs } = s.inputs;
      void [_f, _t, _l, _a, _x, _d, _r];
      const { loadCase: _lc, ...rest } = s;
      void _lc;
      return { ...rest, subject: [s.subject[0]!], inputs };
    });
  },
  compute({ inputs, factor, options }) {
    const p = pressure(inputs);
    const d = val(inputs, 'd');
    const Do = val(inputs, 'D_hub');
    const hub = lameStresses({
      ri: computed(d === undefined ? undefined : d / 2, 'half the fit diameter'),
      ro: computed(Do === undefined ? undefined : Do / 2, 'half the hub outside diameter'),
      pi: fromRecord(p),
    });
    const vm = hub.derived.find((v) => v.symbol === "σ'")?.value;
    const main = strengthFactor(
      {
        stress: computed(vm, `calc record ${hub.id}, σ'`),
        strength: given(inputs, 'Sy_hub'),
        requiredFactor: factor,
      },
      options,
    );
    return compose({
      main,
      steps: [p, hub],
      method:
        'Interface pressure from the interference, then the hub as a thick cylinder under that pressure at its bore (Lamé), its von Mises stress against its yield strength',
      formula: `${p.formula}; σ_t = p (d_o² + d²)/(d_o² - d²), σ_r = -p; σ' = √(σ_t² - σ_t σ_r + σ_r²); n = S_y,hub / σ'`,
      inputs: [
        {
          name: 'Von Mises stress at the hub bore',
          symbol: "σ'",
          value: vm ?? null,
          unit: 'Pa',
          source: `calc record ${hub.id}`,
        },
        ...inputList(inputs, [
          'Sy_hub',
          'delta',
          'd',
          'D_hub',
          'd_i',
          'E',
          'nu',
          'E_hub',
          'nu_hub',
        ]),
        ...NREQ(main),
      ],
      assumptions: [
        'The fit alone stresses the hub; no load case changes it',
        'The largest interference the tolerances allow gives the highest stress: type that one',
      ],
    });
  },
};

/** Every shaft check, registered by the evaluation stage. */
export const SHAFT_CHECKS: readonly CheckDefinition[] = [
  shaftStressCheck,
  shaftFatigueCheck,
  shaftDeflectionCheck,
  shaftSlopeCheck,
  shaftCriticalSpeedCheck,
  shaftKeyCheck,
  shaftPressFitCheck,
  shaftPressFitHubCheck,
];
