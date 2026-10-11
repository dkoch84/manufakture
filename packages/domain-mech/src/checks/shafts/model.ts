// What the shaft checks read (task T9.5b): each shaft stage of a drivetrain that the user has
// described, the loads its load cases put on it, its material, and the inputs geometry does not
// give, which come from check overrides (ADR 0017 decision 2: "check inputs that geometry and the
// catalog do not give are `CheckOverride.inputs`").
//
// A shaft is described by overrides of the `shaft.` family (or of one shaft check) whose subject is
// its stage. One with no `at` gives the whole shaft's inputs: the span between its bearings `L`,
// the load's position `a`, the material, a plain diameter. One with an `at` names a section, a
// place where the shaft changes (a shoulder, a groove, a keyseat, a press-fitted hub), with its
// position `x` from bearing A, its diameter `d` and the rest. Every shaft stage with bearings, or
// named by an override, is checked: until it is described its records are not computed and name
// what is missing (the span, the diameter, the material). The locations `bearing A` and
// `bearing B` are the slope records' own, never sections.
//
// The loads: the shaft carries one transverse load and one torque. On the spool's shaft (the
// shaft stage nearest the spool with no belt, gear or planetary between them) the transverse load
// is the cable tension at the spool and the torque is that tension at the spool's largest
// effective radius. A shaft further up the chain carries that torque through the ratios after it
// (divided by their efficiencies: the motor driving, the larger torque), and its transverse load
// (a belt pull, a gear force) is the user's. Each load case gives a peak cable tension: a static
// one its largest cable pull, a dynamic one the peak of its force law over its motion, or the
// simulation's peak cable tension where that is larger (it carries the inertia and the controller
// the force law leaves out). The load case with the largest tension governs, and every record
// names it.

import {
  documentMaterial,
  mechItems,
  type Drivetrain,
  type LoadCase,
  type Material,
  type PurchasedUse,
  type Stage,
  type SubjectRef,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { analyseDrivetrain, type DrivetrainAnalysis } from '../../drivetrain/analysis';
import { REDUCTION_KINDS, STAGE_KIND_TEXT } from '../../drivetrain/chain';
import { refText, resolveEntry } from '../../parts/catalog';
import { forceAt } from '../../requirements/laws';
import { repSegments, resolveDynamic, segmentKinematics } from '../../requirements/motion';
import { siValue } from '../../requirements/values';
import { effectiveRadius } from '../../spool/winding';
import { CABLE_TENSION_SERIES } from '../cable';
import { applyInputOverrides, overridesFor } from '../overrides';
import type { CheckInput, CheckModel, InputRef } from '../types';

/** The family every shaft check belongs to, as an override names it. */
export const SHAFT_FAMILY = 'shaft.';

export type ShaftStage = Extract<Stage, { kind: 'shaft' }>;

/** What a section is, from its `feature` text. */
export type SectionFeature = 'plain' | 'shoulder' | 'groove' | 'keyseat' | 'press-fit';
export const SECTION_FEATURES: readonly SectionFeature[] = [
  'plain',
  'shoulder',
  'groove',
  'keyseat',
  'press-fit',
];

/** A peak cable tension, or why there is none. */
export type Tension =
  { value: number; source: string; ref: InputRef } | { value: undefined; missing: string };

/** One load case as a shaft sees it. */
export interface ShaftCase {
  loadCase: LoadCase;
  tension: Tension;
  /** rad/s of the spool, the fastest in the load case's motion; dynamic load cases only. */
  spoolSpeed?: number;
}

/** One shaft stage of one drivetrain, as the checks read it. */
export interface ShaftSite {
  /** `drive#1/stage#3`. */
  location: string;
  drivetrain: Drivetrain;
  stage: ShaftStage;
  /** "Shaft (stage#3) of Main". */
  name: string;
  subject: Extract<SubjectRef, { kind: 'stage' }>;
  analysis: DrivetrainAnalysis;
  /** The spool's shaft: the cable's tension is its transverse load. */
  carriesCable: boolean;
  /** The sections the overrides name, in the order they first appear. */
  sections: string[];
  /** Its bearings, A then B. */
  bearings: { use: PurchasedUse | undefined; id: string; name: string }[];
  /** Every load case that pulls the drivetrain's cable. */
  cases: ShaftCase[];
  /** The load case with the largest tension, when every case has one. */
  governing?: ShaftCase & { tension: { value: number; source: string; ref: InputRef } };
  /** Why no load case governs. */
  governingMissing?: string;
  /** rad/s of this shaft, the fastest over every load case, with the case. */
  peakSpeed?: { value: number; loadCase: LoadCase };
}

/** Samples of each moving piece of a rep, for its peak force and speed. */
const SAMPLES = 64;

function variablesOf(model: CheckModel): VariableLookup {
  return (n) => model.variables.get(n);
}

/** Whether an override's check field covers a shaft check. */
function coversShafts(check: string): boolean {
  return check.startsWith(SHAFT_FAMILY);
}

/** A static load case's largest cable pull, or undefined when it pulls none. */
function staticTension(lc: LoadCase, variables: VariableLookup): Tension | undefined {
  const pulls = (lc.static ?? []).filter((l) => l.kind === 'cable');
  if (pulls.length === 0) return undefined;
  let best: { value: number; name: string } | undefined;
  for (const pull of pulls) {
    const f = siValue(pull.force, 'force', variables);
    if (!f.ok) {
      return {
        value: undefined,
        missing: `the force "${pull.force.source}" of cable pull "${pull.name}" in ${lc.name} (${lc.id}) does not evaluate: ${f.message}`,
      };
    }
    if (best === undefined || Math.abs(f.value) > best.value) {
      best = { value: Math.abs(f.value), name: pull.name };
    }
  }
  return {
    value: best!.value,
    source: `load case ${lc.name} (${lc.id}), cable pull "${best!.name}"`,
    ref: { kind: 'given' },
  };
}

/** A dynamic load case's peak force over its rep, and the spool's fastest turning. */
function dynamicPeak(
  model: CheckModel,
  lc: LoadCase,
  analysis: DrivetrainAnalysis,
): { tension: Tension; spoolSpeed?: number } {
  const resolved = resolveDynamic(lc.dynamic!, variablesOf(model));
  if (!resolved.ok) {
    return {
      tension: {
        value: undefined,
        missing: `${lc.name} (${lc.id}) does not read: ${resolved.problems.map((p) => p.message).join('; ')}`,
      },
    };
  }
  const { law, motion } = resolved.value;
  const winding = analysis.spool?.winding;
  let force = 0;
  let speed = 0;
  for (const seg of repSegments(law, motion)) {
    if (seg.shape === 'still' || seg.from === seg.to || !(seg.duration > 0)) {
      force = Math.max(force, forceAt(law, seg.from, 0));
      continue;
    }
    for (let i = 0; i <= SAMPLES; i++) {
      const k = segmentKinematics(seg, (i * seg.duration) / SAMPLES);
      force = Math.max(force, forceAt(law, k.x, k.v));
      const r = winding === undefined ? undefined : effectiveRadius(winding, k.x);
      if (r !== undefined && r > 0) speed = Math.max(speed, Math.abs(k.v) / r);
    }
  }
  let tension: Tension = {
    value: force,
    source: `peak of the force law of ${lc.name} (${lc.id}) over its motion`,
    ref: { kind: 'given' },
  };
  const simulated = model.simulation.envelope(lc.id, CABLE_TENSION_SERIES, 'peak');
  if (simulated !== undefined && Number.isFinite(simulated) && Math.abs(simulated) > force) {
    tension = {
      value: Math.abs(simulated),
      source: `peak of ${CABLE_TENSION_SERIES} in the simulation of ${lc.name} (${lc.id})`,
      ref: { kind: 'simulation', loadCase: lc.id, series: CABLE_TENSION_SERIES, statistic: 'peak' },
    };
  }
  return { tension, ...(winding !== undefined && speed > 0 ? { spoolSpeed: speed } : {}) };
}

/** The shaft stage nearest the spool with no reduction between them, if there is one. */
function cableShaft(d: Drivetrain): string | undefined {
  if (d.output.kind !== 'spool') return undefined;
  for (let i = d.stages.length - 1; i >= 0; i--) {
    const s = d.stages[i]!;
    if (REDUCTION_KINDS.includes(s.kind)) return undefined;
    if (s.kind === 'shaft') return s.id;
  }
  return undefined;
}

/** The `at` of a slope record's subject: a bearing, not a section. */
export const BEARING_AT = /^bearing [AB]$/;

/** The sections the overrides name for a stage, and whether any override names it at all. */
function described(
  model: CheckModel,
  d: Drivetrain,
  s: ShaftStage,
): { named: boolean; sections: string[] } {
  let named = false;
  const sections: string[] = [];
  for (const o of mechItems(model.document.mech, 'checks')) {
    if (!coversShafts(o.check)) continue;
    const sub = o.subject;
    if (sub?.kind !== 'stage' || sub.drivetrain !== d.id || sub.stage !== s.id) continue;
    named = true;
    if (sub.at === undefined || BEARING_AT.test(sub.at)) continue;
    if (!sections.includes(sub.at)) sections.push(sub.at);
  }
  return { named, sections };
}

function siteOf(
  model: CheckModel,
  d: Drivetrain,
  s: ShaftStage,
  sections: string[],
  analysis: DrivetrainAnalysis,
): ShaftSite {
  const doc = model.document;
  const uses = mechItems(doc.mech, 'purchased');
  const carriesCable = cableShaft(d) === s.id;
  const cases: ShaftCase[] = [];
  if (d.output.kind === 'spool') {
    for (const lc of mechItems(doc.mech, 'loadCases')) {
      if (lc.drivetrain !== undefined && lc.drivetrain !== d.id) continue;
      if (lc.dynamic !== undefined) {
        cases.push({ loadCase: lc, ...dynamicPeak(model, lc, analysis) });
        continue;
      }
      const t = staticTension(lc, variablesOf(model));
      if (t !== undefined) cases.push({ loadCase: lc, tension: t });
    }
  }
  const site: ShaftSite = {
    location: `${d.id}/${s.id}`,
    drivetrain: d,
    stage: s,
    name: `${STAGE_KIND_TEXT.shaft} (${s.id}) of ${d.name}`,
    subject: { kind: 'stage', drivetrain: d.id, stage: s.id },
    analysis,
    carriesCable,
    sections,
    bearings: s.bearings.slice(0, 2).map((b, i) => {
      const use = uses.find((u) => u.id === b.use);
      const resolved = use === undefined ? undefined : resolveEntry(doc, use.entry);
      const label =
        use?.name ??
        (resolved?.ok === true
          ? `${resolved.entry.maker} ${resolved.entry.partNumber}`.trim()
          : use !== undefined
            ? refText(use.entry)
            : b.use);
      return { use, id: b.use, name: `${label} (${b.use}), bearing ${i === 0 ? 'A' : 'B'}` };
    }),
    cases,
  };
  const missing = cases.filter((c) => c.tension.value === undefined);
  if (d.output.kind !== 'spool') {
    site.governingMissing = `the output of ${d.name} is not a spool, so no load case pulls a cable on it`;
  } else if (cases.length === 0) {
    site.governingMissing = `no load case pulls the cable of ${d.name}`;
  } else if (missing.length > 0) {
    site.governingMissing = missing
      .map((c) => (c.tension.value === undefined ? c.tension.missing : ''))
      .join('; ');
  } else {
    let best = cases[0]!;
    for (const c of cases) if (c.tension.value! > best.tension.value!) best = c;
    site.governing = best as NonNullable<ShaftSite['governing']>;
  }
  // The shaft turns at the spool's speed times the ratios after it.
  const stage = analysis.stages.find((x) => x.id === s.id);
  const ratioAfter =
    analysis.ratio !== undefined && stage?.nIn !== undefined
      ? analysis.ratio / stage.nIn
      : undefined;
  if (ratioAfter !== undefined) {
    for (const c of cases) {
      if (c.spoolSpeed === undefined) continue;
      const w = c.spoolSpeed * ratioAfter;
      if (site.peakSpeed === undefined || w > site.peakSpeed.value) {
        site.peakSpeed = { value: w, loadCase: c.loadCase };
      }
    }
  }
  return site;
}

const CACHE = new WeakMap<CheckModel, ShaftSite[]>();

/** Every shaft stage with bearings or named by an override, of every drivetrain, in order. */
export function shaftSites(model: CheckModel): ShaftSite[] {
  const hit = CACHE.get(model);
  if (hit !== undefined) return hit;
  const out: ShaftSite[] = [];
  for (const d of mechItems(model.document.mech, 'drivetrains')) {
    let analysis: DrivetrainAnalysis | undefined;
    for (const s of d.stages) {
      if (s.kind !== 'shaft') continue;
      const { named, sections } = described(model, d, s);
      if (!named && s.bearings.length === 0) continue;
      analysis ??= analyseDrivetrain(
        {
          document: model.document,
          variables: variablesOf(model),
          measured: model.measured,
        },
        d,
      );
      out.push(siteOf(model, d, s, sections, analysis));
    }
  }
  CACHE.set(model, out);
  return out;
}

/** The subject of a section's records. */
export function sectionSubject(site: ShaftSite, at: string): SubjectRef {
  return { ...site.subject, at };
}

/** The override texts that apply to one subject of a check (a feature, a material, a finish). */
export function textsFor(
  model: CheckModel,
  check: string,
  subject: readonly SubjectRef[],
): Record<string, string> {
  const overrides = overridesFor(model, check, subject);
  return applyInputOverrides(
    model,
    { location: '', title: '', subject: [...subject], inputs: {} },
    overrides,
  ).texts;
}

/** A section's feature from its texts: `feature`, else a shoulder when `D` is set, else plain. */
export function featureOf(
  model: CheckModel,
  check: string,
  subject: readonly SubjectRef[],
): SectionFeature | { unknown: string } {
  const texts = textsFor(model, check, subject);
  const typed = texts.feature;
  if (typed !== undefined) {
    const f = typed.trim().toLowerCase() as SectionFeature;
    return SECTION_FEATURES.includes(f)
      ? f
      : { unknown: `"${typed}" is not a section feature (${SECTION_FEATURES.join(', ')})` };
  }
  // A larger diameter beside the section makes it a shoulder unless the user says otherwise.
  const withD = overridesFor(model, check, subject).some(
    (o) => o.inputs !== undefined && Object.hasOwn(o.inputs, 'D') && typeof o.inputs.D !== 'string',
  );
  return withD ? 'shoulder' : 'plain';
}

// Inputs ---------------------------------------------------------------------------------------

/** Where to type an input the model does not give. */
export function typeIt(site: ShaftSite, symbol: string, at?: string): string {
  const where = at === undefined ? `${site.stage.id}` : `${site.stage.id} at "${at}"`;
  return `type ${symbol} in a \`${SHAFT_FAMILY}\` override for ${where}`;
}

/** The source of an optional input the model leaves out. */
export const OPTIONAL = 'optional, not given: ';

/** An input only an override gives. */
export function typed(
  site: ShaftSite,
  symbol: string,
  name: string,
  kind: CheckInput['kind'],
  opts: { at?: string; optional?: boolean; why?: string } = {},
): CheckInput {
  const why = opts.why ?? typeIt(site, symbol, opts.at);
  const input: CheckInput = {
    name,
    value: undefined,
    // An optional input left out says what is used instead; the working leaves it out.
    source: opts.optional === true ? `${OPTIONAL}${why}` : 'not given',
    ref: { kind: 'given' },
    kind,
    missing: why,
  };
  if (opts.optional === true) input.optional = true;
  return input;
}

/** The transverse load on the shaft from the governing load case. */
export function transverseInput(site: ShaftSite): CheckInput {
  const name = 'Transverse load on the shaft';
  if (!site.carriesCable) {
    return typed(site, 'F', name, 'force', {
      why: `${site.name} is not the spool's shaft, and the belt or gear force on it is not derived: ${typeIt(site, 'F')}`,
    });
  }
  const g = site.governing;
  if (g === undefined) {
    return typed(site, 'F', name, 'force', {
      why: `${site.governingMissing ?? 'no load case governs'}; or ${typeIt(site, 'F')}`,
    });
  }
  return {
    name,
    value: g.tension.value,
    source: `the cable tension at the spool: ${g.tension.source}, which governs`,
    ref: g.tension.ref,
    kind: 'force',
  };
}

/** The torque through the shaft from the governing load case. */
export function torqueInput(site: ShaftSite): CheckInput {
  const name = 'Torque through the shaft';
  const a = site.analysis;
  const g = site.governing;
  if (g === undefined) {
    return typed(site, 'T', name, 'torque', {
      why: `${site.governingMissing ?? 'no load case governs'}; or ${typeIt(site, 'T')}`,
    });
  }
  const radius = a.spool?.radiusWound;
  if (radius === undefined) {
    return typed(site, 'T', name, 'torque', {
      why: `the spool of ${site.drivetrain.name} has no effective radius (its cable, core, width or length does not read); or ${typeIt(site, 'T')}`,
    });
  }
  const stage = a.stages.find((x) => x.id === site.stage.id);
  const element = a.elements.find((e) => e.at === site.stage.id);
  if (
    a.ratio === undefined ||
    a.efficiency === undefined ||
    stage?.nIn === undefined ||
    element?.efficiencyBefore === undefined
  ) {
    return typed(site, 'T', name, 'torque', {
      why: `a ratio or efficiency of ${site.drivetrain.name} does not read; or ${typeIt(site, 'T')}`,
    });
  }
  const ratioAfter = a.ratio / stage.nIn;
  const etaAfter = a.efficiency / element.efficiencyBefore;
  const torque = (g.tension.value * radius) / (ratioAfter * etaAfter);
  const through =
    ratioAfter === 1 && etaAfter === 1
      ? ''
      : `, through the ratio ${Number(ratioAfter.toPrecision(4))} and efficiency ${Number(etaAfter.toPrecision(4))} after the shaft`;
  return {
    name,
    value: torque,
    source: `${g.tension.source}, which governs, at the spool's largest effective radius ${Number((radius * 1000).toPrecision(4))} mm${through}`,
    ref: g.tension.ref,
    kind: 'torque',
  };
}

/** The shaft's speed in its fastest load case. */
export function speedInput(site: ShaftSite): CheckInput {
  const p = site.peakSpeed;
  if (p === undefined) {
    return typed(site, 'omega', 'Highest operating speed', 'angularSpeed', {
      optional: true,
      why: `no dynamic load case gives the spool's speed; ${typeIt(site, 'omega')}`,
    });
  }
  return {
    name: 'Highest operating speed',
    value: p.value,
    source: `the fastest turning of the spool in ${p.loadCase.name} (${p.loadCase.id}), through the ratios after the shaft`,
    ref: { kind: 'given' },
    kind: 'angularSpeed',
    optional: true,
  };
}

// Materials ------------------------------------------------------------------------------------

/** A material, with where its id came from, or why there is none. */
export type ResolvedMaterial =
  { material: Material; id: string; from: string } | { material: undefined; why: string };

/** The shaft's material: a `material` text, else its instance's part's material. */
export function shaftMaterial(
  model: CheckModel,
  site: ShaftSite,
  texts: Readonly<Record<string, string>>,
): ResolvedMaterial {
  const doc = model.document;
  const typedId = texts.material;
  if (typedId !== undefined) {
    const m = documentMaterial(doc, typedId);
    return m === undefined
      ? { material: undefined, why: `there is no material "${typedId}"` }
      : { material: m, id: typedId, from: 'your override' };
  }
  const inst = site.stage.instance;
  const how = `name the shaft's instance on ${site.stage.id}, or type material in a \`${SHAFT_FAMILY}\` override`;
  if (inst === undefined) return { material: undefined, why: `no material: ${how}` };
  const assembly = doc.assemblies?.find((x) => x.id === site.drivetrain.assembly);
  const instance = assembly?.instances.find((x) => x.id === inst);
  if (instance === undefined || !('part' in instance.source)) {
    return { material: undefined, why: `instance ${inst} is not a part of this document: ${how}` };
  }
  const partId = instance.source.part;
  const part = doc.parts.find((p) => p.id === partId);
  const id = part?.material ?? part?.bodies?.find((b) => b.material !== undefined)?.material;
  const m = id === undefined ? undefined : documentMaterial(doc, id);
  return m === undefined || id === undefined
    ? { material: undefined, why: `${partId} has no material: ${how}` }
    : { material: m, id, from: `the material of ${partId}, shown by ${instance.name} (${inst})` };
}

/** Another member's material from a text (`hubMaterial`, `keyMaterial`). */
export function namedMaterial(
  model: CheckModel,
  texts: Readonly<Record<string, string>>,
  key: string,
): ResolvedMaterial {
  const id = texts[key];
  if (id === undefined) return { material: undefined, why: `type ${key} (a material id)` };
  const m = documentMaterial(model.document, id);
  return m === undefined
    ? { material: undefined, why: `there is no material "${id}"` }
    : { material: m, id, from: `your ${key}` };
}

type StrengthKey = 'yieldStrength' | 'ultimateStrength';
type PlainKey = 'elasticModulus' | 'poissonRatio';

/**
 * One property of a material as a check input. A printed material's strength is across the layers
 * (Z) where published, else the XY value times your printed knockdown (ADR 0017 decision 4).
 */
export function materialInput(
  model: CheckModel,
  resolved: ResolvedMaterial,
  key: StrengthKey | PlainKey,
  name: string,
  kind: CheckInput['kind'],
  missingHint: string,
): CheckInput {
  const base = { name, kind } as const;
  if (resolved.material === undefined) {
    return {
      ...base,
      value: undefined,
      source: 'not given',
      ref: { kind: 'given' },
      missing: `${resolved.why}; or ${missingHint}`,
    };
  }
  const m = resolved.material;
  const ref: InputRef = { kind: 'material', id: resolved.id, property: key };
  if (m.form === 'printed' && (key === 'yieldStrength' || key === 'ultimateStrength')) {
    const z = key === 'yieldStrength' ? m.yieldStrengthZ : m.ultimateStrengthZ;
    if (z !== undefined) {
      return {
        ...base,
        value: z.value,
        source: `${m.name} (${resolved.from}), across the layers (Z): ${z.source}`,
        ref: { ...ref, property: key === 'yieldStrength' ? 'yieldStrengthZ' : 'ultimateStrengthZ' },
      };
    }
    const xy = m[key];
    if (xy !== undefined) {
      const k = model.settings.printedKnockdown;
      return {
        ...base,
        value: xy.value * k,
        source: `${m.name} (${resolved.from}), in the XY plane times your printed knockdown ${k}: ${xy.source}`,
        ref,
      };
    }
  }
  const p = m[key];
  if (p === undefined) {
    return {
      ...base,
      value: undefined,
      source: `${m.name}`,
      ref,
      missing: `${m.name} gives no ${name.toLowerCase()}; ${missingHint}`,
    };
  }
  return { ...base, value: p.value, source: `${m.name} (${resolved.from}): ${p.source}`, ref };
}

/** Whether a material is a steel, which the Marin factors and Neuber's fit are for. */
export function isSteel(resolved: ResolvedMaterial): boolean {
  if (resolved.material === undefined) return false;
  const m = resolved.material;
  if (m.category !== 'metal' || m.form === 'printed') return false;
  return /steel/i.test(m.name) || resolved.id.startsWith('steel');
}
