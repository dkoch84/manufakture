// The bearing checks (task T9.5c; plan, "The checks"): per rolling bearing on a drivetrain's
// shafts, the L10 life in hours of the governing load case's duty cycle against the user's life
// target, the ISO 76 static factor against the user's strength factor, and the highest speed
// against the maker's limiting speed. Each makes one record per bearing and names the load case
// that governs it: the shortest life, the largest cable tension, the highest speed.
//
// Numbers and margins only (ADR 0017 decision 6). With no life target the life is stated and
// compared with nothing; with no strength factor the static factor is stated and compared with
// nothing. Above the maker's limiting speed is a warning, since the rating does not hold there.

import {
  bearingDutyLife,
  bearingSpeed,
  bearingStaticFactor,
  cubicMeanLoad,
  deepGrooveEquivalentLoad,
  equivalentDynamicLoad,
  type CalcInput,
  type CalcRecord,
  type Given,
} from '@manufakture/calc';
import { refText } from '../../parts/catalog';
import type { CheckDefinition, CheckInput, CheckSubject } from '../types';
import { bearingDuties, type BearingSite, type CaseDuty, type Known, type Turning } from './duty';

export const BEARING_LIFE_CHECK = 'bearing.l10';
export const BEARING_STATIC_CHECK = 'bearing.static';
export const BEARING_SPEED_CHECK = 'bearing.speed';

const TAU = 2 * Math.PI;

/** ISO 281 Table 3, single-row angular contact ball bearing at 40 degrees. */
const ANGULAR_40 = { e: 1.14, X: 0.35, Y: 0.57 };
/** ISO 76 Table 1, single-row angular contact ball bearing at 40 degrees. */
const ANGULAR_40_STATIC = { X0: 0.5, Y0: 0.26 };

/** The life exponent p: 3 for ball, 10/3 for roller bearings (ISO 281). */
function exponent(site: BearingSite): number | undefined {
  if (site.type === undefined) return undefined;
  return site.type === 'needle' ? 10 / 3 : 3;
}

/** A rating of the site's catalog entry as an input, with its basis and whether it is checked. */
function rating(
  site: BearingSite,
  field: string,
  name: string,
  kind: CheckInput['kind'],
): CheckInput {
  const entry = site.entry!;
  const { use } = site;
  const rated = Object.hasOwn(entry.ratings, field) ? entry.ratings[field] : undefined;
  const value = rated !== undefined && 'value' in rated ? rated.value : undefined;
  const notes: string[] = [];
  if (rated !== undefined && 'basis' in rated && rated.basis !== undefined) {
    notes.push(rated.basis);
  }
  if (rated !== undefined && 'estimated' in rated && rated.estimated) notes.push('estimated');
  if (!entry.verified) notes.push('catalog data, unverified');
  const input: CheckInput = {
    name,
    value,
    source: `${refText(use.entry)} ${entry.maker} ${entry.partNumber}, ${name.toLowerCase()}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
    ref: { kind: 'catalog', entry: use.entry, field },
    kind,
  };
  if (value === undefined) input.missing = `the catalog entry ${refText(use.entry)} gives none`;
  return input;
}

function known(name: string, k: Known, kind: CheckInput['kind']): CheckInput {
  return k.value === undefined
    ? {
        name,
        value: undefined,
        source: 'not derived',
        ref: { kind: 'given' },
        kind,
        missing: k.missing,
      }
    : { name, value: k.value, source: k.source, ref: { kind: 'given' }, kind };
}

function given(name: string, value: number, source: string, kind: CheckInput['kind']): CheckInput {
  return { name, value, source, ref: { kind: 'given' }, kind };
}

function missing(name: string, why: string, kind: CheckInput['kind']): CheckInput {
  return {
    name,
    value: undefined,
    source: 'not derived',
    ref: { kind: 'given' },
    kind,
    missing: why,
  };
}

/** The radial share k: the load on this bearing per newton of cable tension. */
const shareInput = (site: BearingSite) =>
  known('Radial load per newton of cable tension', site.share, 'number');

/** No axial load unless the user gives one; a needle bearing takes none. */
const axialInput = (): CheckInput => ({
  name: 'Axial load',
  value: 0,
  source: 'none (assumed: the cable pulls square to the shaft; give F_a with an override)',
  ref: { kind: 'given' },
  kind: 'force',
});

const subjectRefs = (site: BearingSite): CheckSubject['subject'] => [
  { kind: 'stage', drivetrain: site.drivetrain.id, stage: site.stage.id },
  { kind: 'purchased', use: site.use.id },
];

const caseText = (c: CaseDuty) => `${c.loadCase.name} (${c.loadCase.id})`;

/** The load cases that turn the spool, with their duty; and the first reason one does not read. */
function turningCases(cases: readonly CaseDuty[]): {
  ok: { c: CaseDuty; t: Turning }[];
  first?: { c: CaseDuty; missing: string };
} {
  const ok: { c: CaseDuty; t: Turning }[] = [];
  let first: { c: CaseDuty; missing: string } | undefined;
  for (const c of cases) {
    if (c.turning === undefined) continue;
    if ('missing' in c.turning) first ??= { c, missing: c.turning.missing };
    else if (c.turning.anglePerRep > 0) ok.push({ c, t: c.turning });
  }
  return first === undefined ? { ok } : { ok, first };
}

/**
 * A load case that does not read, as a missing input: a record that names the case governing it
 * has looked at every load case, so one it could not read makes it `unknown`, named.
 */
function unreadCase(
  first: { c: CaseDuty; missing: string } | undefined,
): Record<string, CheckInput> {
  if (first === undefined) return {};
  return {
    lc_unread: missing(`Load case ${caseText(first.c)}`, first.missing, 'number'),
  };
}

const meanLoad = (t: Turning, p: number) =>
  cubicMeanLoad(
    t.samples.map((s) => ({ load: s.force, revolutions: s.angle })),
    p,
  );

function lifeSubjects(site: BearingSite, cases: readonly CaseDuty[]): CheckSubject | undefined {
  const { ok, first } = turningCases(cases);
  const p = exponent(site);
  const pp = p ?? 3;
  // The shortest life: hours are proportional to t_c / (N_c F_m^p), whatever C and the share.
  let best: { c: CaseDuty; t: Turning; Fm: number; score: number } | undefined;
  for (const { c, t } of ok) {
    const Fm = meanLoad(t, pp);
    if (!(Fm > 0)) continue;
    const score = t.sessionDuration / (t.anglePerRep * t.repsPerSession * Fm ** pp);
    if (best === undefined || score < best.score) best = { c, t, Fm, score };
  }
  if (best === undefined && first === undefined) return undefined;
  const govern = best?.c ?? first!.c;
  const lc = govern.loadCase;
  const title = `L10 life of ${site.label}, governed by ${caseText(govern)}`;
  const inputs: Record<string, CheckInput> = {
    C: rating(site, 'dynamicLoad', 'Basic dynamic load rating', 'force'),
    ...unreadCase(best === undefined ? undefined : first),
  };
  if (best === undefined) {
    inputs.F_m = missing('Mean cable tension over the duty', first!.missing, 'force');
  } else {
    inputs.F_m = given(
      'Mean cable tension over the duty',
      best.Fm,
      `the force law of ${caseText(best.c)} over its motion, averaged with p = ${p === 3 || p === undefined ? '3' : '10/3'} over the spool's turns`,
      'force',
    );
  }
  inputs.k = shareInput(site);
  if (site.type !== 'needle') inputs.F_a = axialInput();
  if (site.type === 'deep groove ball') {
    inputs.C0 = rating(site, 'staticLoad', 'Static load rating', 'force');
  } else if (site.type === 'angular contact') {
    const angle = Object.hasOwn(site.entry!.ratings, 'contactAngle')
      ? site.entry!.ratings.contactAngle
      : undefined;
    const at40 = angle !== undefined && 'value' in angle && angle.value === 40;
    const why = `the X, Y and e factors are built in for a 40 degree contact angle only; give X, Y and e with an override`;
    const src = 'ISO 281 Table 3, single-row angular contact ball bearing at 40 degrees';
    inputs.X = at40
      ? given('Radial factor', ANGULAR_40.X, src, 'number')
      : missing('Radial factor', why, 'number');
    inputs.Y = at40
      ? given('Axial factor', ANGULAR_40.Y, src, 'number')
      : missing('Axial factor', why, 'number');
    inputs.e = at40
      ? given('Limit ratio', ANGULAR_40.e, src, 'number')
      : missing('Limit ratio', why, 'number');
  }
  inputs.p =
    p === undefined
      ? missing(
          'Life exponent',
          `the catalog entry ${refText(site.use.entry)} gives no bearing type`,
          'number',
        )
      : given(
          'Life exponent',
          p,
          site.type === 'needle' ? 'roller bearing (ISO 281)' : 'ball bearing (ISO 281)',
          'number',
        );
  if (best === undefined) {
    inputs.N_c = missing('Shaft revolutions in a session', first!.missing, 'number');
    inputs.t_c = missing('Duration of a session', first!.missing, 'time');
  } else {
    const t = best.t;
    const spoolTurns = (t.anglePerRep * t.repsPerSession) / TAU;
    inputs.N_c =
      site.speedRatio.value === undefined
        ? missing('Shaft revolutions in a session', site.speedRatio.missing, 'number')
        : given(
            'Shaft revolutions in a session',
            spoolTurns * site.speedRatio.value,
            `the spool's turns in one session of ${caseText(best.c)} (${t.reps} ${t.reps === 1 ? 'rep' : 'reps'} in ${t.sets} ${t.sets === 1 ? 'set' : 'sets'}) through the effective radius of the wound layers, times ${site.speedRatio.source}`,
            'number',
          );
    inputs.t_c = given(
      'Duration of a session',
      t.sessionDuration,
      `one session of ${caseText(best.c)}, pauses and rests included`,
      'time',
    );
  }
  inputs.t_req = {
    name: 'Your life target',
    value: undefined,
    source: 'none set (give t_req with an override of bearing.l10)',
    ref: { kind: 'given' },
    kind: 'time',
    optional: true,
  };
  return { location: site.location, title, subject: subjectRefs(site), loadCase: lc.id, inputs };
}

function staticSubject(site: BearingSite, cases: readonly CaseDuty[]): CheckSubject | undefined {
  let best: { c: CaseDuty; value: number; source: string; ref: CheckInput['ref'] } | undefined;
  let first: { c: CaseDuty; missing: string } | undefined;
  for (const c of cases) {
    if (c.peak === undefined) continue;
    if ('missing' in c.peak) {
      first ??= { c, missing: c.peak.missing };
      continue;
    }
    if (best === undefined || c.peak.value > best.value) best = { c, ...c.peak };
  }
  if (best === undefined && first === undefined) return undefined;
  const govern = best?.c ?? first!.c;
  const inputs: Record<string, CheckInput> = {
    C0: rating(site, 'staticLoad', 'Static load rating', 'force'),
    F:
      best === undefined
        ? missing('Largest cable tension', first!.missing, 'force')
        : {
            name: 'Largest cable tension',
            value: best.value,
            source: best.source,
            ref: best.ref,
            kind: 'force',
          },
    k: shareInput(site),
    ...unreadCase(best === undefined ? undefined : first),
  };
  if (site.type !== 'needle') inputs.F_a = axialInput();
  const factors =
    site.type === 'deep groove ball'
      ? { X0: 0.6, Y0: 0.5, src: 'ISO 76, single-row deep groove ball bearing' }
      : site.type === 'needle'
        ? { X0: 1, Y0: 0, src: 'ISO 76, radial roller bearing with no contact angle: P0 = Fr' }
        : undefined;
  if (factors !== undefined) {
    inputs.X0 = given('Static radial factor', factors.X0, factors.src, 'number');
    inputs.Y0 = given('Static axial factor', factors.Y0, factors.src, 'number');
  } else if (site.type === 'angular contact') {
    const angle = Object.hasOwn(site.entry!.ratings, 'contactAngle')
      ? site.entry!.ratings.contactAngle
      : undefined;
    const at40 = angle !== undefined && 'value' in angle && angle.value === 40;
    const src = 'ISO 76 Table 1, single-row angular contact ball bearing at 40 degrees';
    const why =
      'X0 and Y0 are built in for a 40 degree contact angle only; give them with an override';
    inputs.X0 = at40
      ? given('Static radial factor', ANGULAR_40_STATIC.X0, src, 'number')
      : missing('Static radial factor', why, 'number');
    inputs.Y0 = at40
      ? given('Static axial factor', ANGULAR_40_STATIC.Y0, src, 'number')
      : missing('Static axial factor', why, 'number');
  } else {
    const why = `the catalog entry ${refText(site.use.entry)} gives no bearing type`;
    inputs.X0 = missing('Static radial factor', why, 'number');
    inputs.Y0 = missing('Static axial factor', why, 'number');
  }
  return {
    location: site.location,
    title: `Static factor of ${site.label}, governed by ${caseText(govern)}`,
    subject: subjectRefs(site),
    loadCase: govern.loadCase.id,
    inputs,
  };
}

function speedSubject(site: BearingSite, cases: readonly CaseDuty[]): CheckSubject | undefined {
  const { ok, first } = turningCases(cases);
  let best: { c: CaseDuty; t: Turning } | undefined;
  for (const x of ok)
    if (best === undefined || x.t.peakSpoolSpeed > best.t.peakSpoolSpeed) best = x;
  if (best === undefined && first === undefined) return undefined;
  const govern = best?.c ?? first!.c;
  let n: CheckInput;
  if (best === undefined) n = missing('Highest speed', first!.missing, 'angularSpeed');
  else if (site.speedRatio.value === undefined) {
    n = missing('Highest speed', site.speedRatio.missing, 'angularSpeed');
  } else {
    n = given(
      'Highest speed',
      best.t.peakSpoolSpeed * site.speedRatio.value,
      `the highest cable speed over the effective radius in ${caseText(best.c)}, times ${site.speedRatio.source}`,
      'angularSpeed',
    );
  }
  return {
    location: site.location,
    title: `Speed of ${site.label}, governed by ${caseText(govern)}`,
    subject: subjectRefs(site),
    loadCase: govern.loadCase.id,
    inputs: {
      n,
      n_lim: rating(site, 'limitingSpeed', 'Limiting speed', 'angularSpeed'),
      ...unreadCase(best === undefined ? undefined : first),
    },
  };
}

function subjectsOf(
  what: string,
  make: (site: BearingSite, cases: readonly CaseDuty[]) => CheckSubject | undefined,
): CheckDefinition['subjects'] {
  return (model) => {
    const out: CheckSubject[] = [];
    for (const d of bearingDuties(model)) {
      for (const site of d.sites) {
        if (site.unresolved !== undefined) {
          // Never computed from a guess: the record names the entry it could not find.
          out.push({
            location: site.location,
            title: `${what} of ${site.label}`,
            subject: subjectRefs(site),
            inputs: { entry: missing('Catalog entry', site.unresolved, 'number') },
          });
          continue;
        }
        const s = make(site, d.cases);
        if (s !== undefined) out.push(s);
      }
    }
    return out;
  };
}

/** A calc input from a gathered one, for the working. */
function inputOf(name: string, symbol: string, g: Given | undefined, unit: string): CalcInput {
  return { name, symbol, value: g?.value ?? null, unit, source: g?.source ?? 'not given' };
}

const has = (o: object, k: string) => Object.hasOwn(o, k);

/** k F: the radial load on the bearing. */
function radial(k: Given | undefined, F: Given | undefined, what: string): Given {
  const kv = k?.value;
  const fv = F?.value;
  if (kv === undefined || fv === undefined) return { value: undefined, source: `k × ${what}` };
  return {
    value: kv * fv,
    source: `k × ${what} = ${kv.toPrecision(3)} × ${fv.toPrecision(4)} N`,
  };
}

/** Merge a step's record into the final one: its derived values and assumptions first. */
function joined(final: CalcRecord, before: CalcRecord[], inputs: CalcInput[]): CalcRecord {
  const notes = before.filter((r) => r.status === 'unknown' && r.note !== undefined);
  const out: CalcRecord = {
    ...final,
    inputs,
    derived: [...before.flatMap((r) => r.derived), ...final.derived],
    assumptions: [...new Set([...before.flatMap((r) => r.assumptions), ...final.assumptions])],
    sources: [...before.flatMap((r) => r.sources), ...final.sources].filter(
      (s, i, all) => all.findIndex((x) => x.title === s.title && x.locator === s.locator) === i,
    ),
  };
  if (final.status === 'unknown' && notes.length > 0) out.note = notes[0]!.note!;
  return out;
}

export const bearingLife: CheckDefinition = {
  id: BEARING_LIFE_CHECK,
  title: 'Bearing L10 life over the duty cycle',
  version: 1,
  subjects: subjectsOf('L10 life', lifeSubjects),
  compute({ inputs, options }) {
    const Fr = radial(inputs.k, inputs.F_m, 'F_m');
    const steps: CalcRecord[] = [];
    let P: Given = Fr;
    if (has(inputs, 'C0')) {
      const eq = deepGrooveEquivalentLoad({ Fr, Fa: inputs.F_a, C0: inputs.C0 });
      // With no axial load X = 1 whatever F_a/C₀ is, so the table's range does not matter.
      if (inputs.F_a?.value === 0) {
        eq.assumptions = eq.assumptions.filter((a) => !a.startsWith('F_a/C₀ outside'));
      }
      steps.push(eq);
      P = {
        value: eq.result ?? undefined,
        source: 'equivalent dynamic load, from F_r, F_a and C₀',
      };
    } else if (has(inputs, 'X')) {
      const fr = Fr.value;
      const fa = inputs.F_a?.value;
      const e = inputs.e?.value;
      const heavy =
        fr !== undefined && fa !== undefined && e !== undefined && (fr > 0 ? fa / fr > e : fa > 0);
      const eq = equivalentDynamicLoad({
        Fr,
        Fa: inputs.F_a,
        X: heavy ? inputs.X : { value: 1, source: `F_a/F_r at most e: X = 1` },
        Y: heavy ? inputs.Y : { value: 0, source: `F_a/F_r at most e: Y = 0` },
      });
      steps.push(eq);
      P = {
        value: eq.result ?? undefined,
        source: 'equivalent dynamic load, from F_r, F_a, X, Y and e',
      };
    }
    const t_req = inputs.t_req?.value;
    const life = bearingDutyLife(
      {
        C: inputs.C,
        P,
        exponent: inputs.p,
        revolutionsPerCycle: inputs.N_c,
        cycleDuration: inputs.t_c,
        requiredLife:
          t_req === undefined ? undefined : { value: t_req / 3600, source: inputs.t_req!.source },
      },
      options,
    );
    const working: CalcInput[] = [
      inputOf('Mean cable tension over the duty', 'F_m', inputs.F_m, 'N'),
      inputOf('Radial load per newton of cable tension', 'k', inputs.k, '1'),
    ];
    if (has(inputs, 'F_a')) working.push(inputOf('Axial load', 'F_a', inputs.F_a, 'N'));
    if (has(inputs, 'C0')) working.push(inputOf('Static load rating', 'C₀', inputs.C0, 'N'));
    if (has(inputs, 'X')) {
      working.push(
        inputOf('Radial factor', 'X', inputs.X, '1'),
        inputOf('Axial factor', 'Y', inputs.Y, '1'),
        inputOf('Limit ratio', 'e', inputs.e, '1'),
      );
    }
    const record = joined(life, steps, [
      ...working,
      ...life.inputs.filter((i) => i.symbol !== 'P'),
    ]);
    record.derived = [
      ...(Fr.value !== undefined
        ? [{ name: 'Mean radial load on the bearing', symbol: 'F_r', value: Fr.value, unit: 'N' }]
        : []),
      ...steps.flatMap((r) => r.derived),
      ...(P !== Fr && P.value !== undefined
        ? [{ name: 'Equivalent dynamic load', symbol: 'P', value: P.value, unit: 'N' }]
        : []),
      ...life.derived,
    ];
    record.method =
      'ISO 281 basic rating life of the mean equivalent load over the duty cycle, in hours of that duty';
    record.assumptions = [
      ...record.assumptions,
      'The cable tension follows the load case’s force law over its motion; inertia and the controller’s ripple are left out of the mean.',
      'The mean is taken over the turns of the shaft (Palmgren-Miner with the life exponent); a hold turns nothing and adds no wear.',
      'Hours count the duty repeated back to back, pauses and rests included.',
      'The governing load case is the one with the shortest life ranked by mean cable tension, which is exact while F_a is 0; with an axial load the ranking is approximate.',
    ];
    return record;
  },
};

export const bearingStatic: CheckDefinition = {
  id: BEARING_STATIC_CHECK,
  title: 'Bearing static factor under the largest cable tension',
  version: 1,
  factor: 'strength',
  subjects: subjectsOf('Static factor', staticSubject),
  compute({ inputs, factor, options }) {
    const Fr = radial(inputs.k, inputs.F, 'F');
    const record = bearingStaticFactor(
      {
        C0: inputs.C0,
        Fr,
        Fa: inputs.F_a ?? 0,
        X0: inputs.X0,
        Y0: inputs.Y0,
        requiredFactor: factor,
      },
      options,
    );
    return {
      ...record,
      inputs: [
        inputOf('Largest cable tension', 'F', inputs.F, 'N'),
        inputOf('Radial load per newton of cable tension', 'k', inputs.k, '1'),
        ...record.inputs,
      ],
      assumptions: [
        ...record.assumptions,
        'The largest cable tension of the governing load case, held still on the bearing; shock beyond it is not included.',
      ],
    };
  },
};

export const bearingSpeedCheck: CheckDefinition = {
  id: BEARING_SPEED_CHECK,
  title: 'Bearing speed against its limiting speed',
  version: 1,
  subjects: subjectsOf('Speed', speedSubject),
  compute({ inputs, options }) {
    return bearingSpeed({ speed: inputs.n, limitingSpeed: inputs.n_lim }, options);
  },
};

/** The bearing checks, in the order they register. */
export const BEARING_CHECKS: readonly CheckDefinition[] = [
  bearingLife,
  bearingStatic,
  bearingSpeedCheck,
];
