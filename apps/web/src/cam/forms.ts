// The operation dialogs' logic, free of React (M5 plan, T5.3a): a form of strings per operation
// kind (profile, pocket, facing, drill, V-carve), filled from an operation or with defaults, each
// field checked for its kind and range as it is typed (`values.ts`), and built into one
// `addCamOperation` or `editCamOperation` command. Geometry sources are a list of drafts: faces
// picked in the view (stored under `r<n>` ids from `cam.nextIds`), sketch regions and hole
// features chosen from lists.

import {
  previewIds,
  type CamGeometrySource,
  type CamOperation,
  type CamSetup,
  type CamTool,
  type Command,
  type DisplayUnits,
  type FaceRef,
  type FaceReference,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from '@manufakture/core';
import type { FieldKind } from '../components/expression';
import type { Variables } from '../sketcher/values';
import type { DialogOperationKind } from './state';
import { checkField, storedOf, type Rule } from './values';

/** What each kind is called in the UI ("profile operation" for the cut, ADR 0014 decision 4). */
export const OPERATION_LABELS: Readonly<Record<DialogOperationKind | 'surface3d', string>> = {
  facing: 'Facing',
  profile: 'Profile',
  pocket: 'Pocket',
  drill: 'Drill',
  vcarve: 'V-carve',
  surface3d: '3D surface',
};

/** The operation kinds with a dialog, in toolbar order. */
export const DIALOG_KINDS: readonly DialogOperationKind[] = [
  'facing',
  'profile',
  'pocket',
  'drill',
  'vcarve',
];

/** One geometry source as the dialog holds it, with its label and whether it was lost. */
export type SourceDraft = (
  | {
      kind: 'face';
      /** The stored reference id; null for a face picked in this dialog (a fresh id on apply). */
      id: string | null;
      ref: FaceRef;
      lastResolved?: FaceReference['lastResolved'];
    }
  | { kind: 'region'; sketch: string; entities?: string[] }
  | { kind: 'hole'; feature: string }
) & { label: string; lost?: boolean };

export type FeedKey = 'spindle' | 'cut' | 'plunge' | 'ramp' | 'lead';
export const FEED_KEYS: readonly FeedKey[] = ['spindle', 'cut', 'plunge', 'ramp', 'lead'];

export interface OperationForm {
  kind: DialogOperationKind;
  name: string;
  tool: string;
  sources: SourceDraft[];
  /** `own`: each hole's own depth (a drill only). */
  depthMode: 'blind' | 'through' | 'own';
  /** A blind depth; a facing's depth (how much it removes). */
  depth: string;
  /** Below the stock bottom, for a through cut. */
  extra: string;
  stepdown: string;
  stepover: string;
  finishAllowance: string;
  /** A facing's raster direction. */
  angle: string;
  side: 'outside' | 'inside' | 'on';
  climb: boolean;
  tabs: boolean;
  tabCount: string;
  tabWidth: string;
  tabHeight: string;
  entry: 'plunge' | 'ramp' | 'helix';
  entryAngle: string;
  entryRadius: string;
  leadIn: 'none' | 'line' | 'arc';
  leadInSize: string;
  leadOut: 'none' | 'line' | 'arc';
  leadOutSize: string;
  peck: string;
  dwell: string;
  maxDepth: string;
  feeds: Record<FeedKey, string>;
}

/** A numeric field of the form: its kind, range and whether it may be left empty. */
export interface FieldSpec {
  kind: FieldKind;
  rule: Rule;
  optional: boolean;
  label: string;
}

type NumericKey = Exclude<
  keyof OperationForm,
  | 'kind'
  | 'name'
  | 'tool'
  | 'sources'
  | 'depthMode'
  | 'side'
  | 'climb'
  | 'tabs'
  | 'entry'
  | 'leadIn'
  | 'leadOut'
  | 'feeds'
>;

const spec = (kind: FieldKind, rule: Rule, label: string, optional = false): FieldSpec => ({
  kind,
  rule,
  optional,
  label,
});

/** Every numeric field; `feeds.*` are `FEED_SPECS`. */
export const FIELD_SPECS: Readonly<Record<NumericKey, FieldSpec>> = {
  depth: spec('length', 'positive', 'Depth'),
  extra: spec('length', 'nonNegative', 'Below the stock bottom (optional)', true),
  stepdown: spec('length', 'positive', 'Stepdown (optional: from the tool)', true),
  stepover: spec('number', 'fraction', 'Stepover, fraction of the diameter (optional)', true),
  finishAllowance: spec('length', 'nonNegative', 'Finish allowance (optional)', true),
  angle: spec('angle', 'any', 'Raster angle'),
  tabCount: spec('number', 'whole', 'Tabs per loop'),
  tabWidth: spec('length', 'positive', 'Tab width'),
  tabHeight: spec('length', 'positive', 'Tab height'),
  entryAngle: spec('angle', 'entryAngle', 'Entry angle'),
  entryRadius: spec('length', 'positive', 'Helix radius'),
  leadInSize: spec('length', 'positive', 'Lead-in size'),
  leadOutSize: spec('length', 'positive', 'Lead-out size'),
  peck: spec('length', 'positive', 'Peck depth (optional: one plunge)', true),
  dwell: spec('number', 'nonNegative', 'Dwell at the bottom, seconds (optional)', true),
  maxDepth: spec('length', 'positive', 'Maximum depth (optional: as deep as the bit needs)', true),
};

export const FEED_SPECS: Readonly<Record<FeedKey, FieldSpec>> = {
  spindle: spec('spindleSpeed', 'positive', 'Spindle speed', true),
  cut: spec('feed', 'positive', 'Cutting feed', true),
  plunge: spec('feed', 'positive', 'Plunge feed', true),
  ramp: spec('feed', 'positive', 'Ramp feed', true),
  lead: spec('feed', 'positive', 'Lead feed', true),
};

/** The numeric fields a form uses, as it stands (its kind and its choices). */
export function activeFields(form: OperationForm): NumericKey[] {
  const out: NumericKey[] = [];
  const depthFields = () => {
    if (form.depthMode === 'blind') out.push('depth');
    if (form.depthMode === 'through') out.push('extra');
  };
  const entryFields = () => {
    if (form.entry === 'ramp' || form.entry === 'helix') out.push('entryAngle');
    if (form.entry === 'helix') out.push('entryRadius');
  };
  switch (form.kind) {
    case 'facing':
      out.push('depth', 'stepdown', 'stepover', 'angle');
      break;
    case 'profile':
      depthFields();
      out.push('stepdown', 'finishAllowance');
      if (form.tabs) out.push('tabCount', 'tabWidth', 'tabHeight');
      entryFields();
      if (form.leadIn !== 'none') out.push('leadInSize');
      if (form.leadOut !== 'none') out.push('leadOutSize');
      break;
    case 'pocket':
      depthFields();
      out.push('stepdown', 'stepover', 'finishAllowance');
      entryFields();
      break;
    case 'drill':
      depthFields();
      out.push('peck', 'dwell');
      break;
    case 'vcarve':
      out.push('maxDepth');
      break;
  }
  return out;
}

/** Which source kinds an operation takes (as the geometry stage checks them). */
export function acceptedSources(kind: DialogOperationKind): readonly CamGeometrySource['kind'][] {
  return kind === 'drill' ? ['hole'] : ['face', 'region'];
}

/** The tools of the document that suit `kind`, best first: a V-carve takes V-bits and engravers only. */
export function suitableTools(doc: ManufaktureDocument, kind: DialogOperationKind): CamTool[] {
  const tools = doc.cam.tools;
  if (kind === 'vcarve') return tools.filter((t) => t.kind === 'vbit' || t.kind === 'engraver');
  const rank = (t: CamTool) => {
    if (kind === 'drill') return t.kind === 'drill' ? 0 : t.kind === 'vbit' ? 2 : 1;
    return t.kind === 'flat' ? 0 : t.kind === 'vbit' || t.kind === 'drill' ? 2 : 1;
  };
  return [...tools].sort((a, b) => rank(a) - rank(b));
}

/** What the tool must be for `kind`, or null when it suits. */
export function toolProblem(tool: CamTool | undefined, kind: DialogOperationKind): string | null {
  if (!tool) {
    return kind === 'vcarve'
      ? 'A V-carve cuts with a V-bit or an engraver: choose one (add one with Tools).'
      : 'Choose a tool (add one with Tools if the document has none).';
  }
  if (kind === 'vcarve' && tool.kind !== 'vbit' && tool.kind !== 'engraver') {
    return 'A V-carve cuts with a V-bit or an engraver.';
  }
  return null;
}

/** The label of a sketch region source or a hole source, from the part's features. */
export function sourceLabel(part: Part | undefined, source: CamGeometrySource): string {
  const name = (id: string) => part?.features.find((f) => f.id === id)?.name ?? id;
  switch (source.kind) {
    case 'face':
      return `Face ${source.face.ref.face}`;
    case 'region':
      return source.entities
        ? `Regions of ${name(source.sketch)} (${source.entities.length} entities)`
        : `Regions of ${name(source.sketch)}`;
    case 'hole':
      return `Holes of ${name(source.feature)}`;
  }
}

function draftOf(part: Part | undefined, source: CamGeometrySource, lost: boolean): SourceDraft {
  const label = sourceLabel(part, source);
  const flag = lost ? { lost: true } : {};
  switch (source.kind) {
    case 'face':
      return {
        kind: 'face',
        id: source.face.id,
        ref: source.face.ref,
        ...(source.face.lastResolved ? { lastResolved: source.face.lastResolved } : {}),
        label,
        ...flag,
      };
    case 'region':
      return {
        kind: 'region',
        sketch: source.sketch,
        ...(source.entities ? { entities: [...source.entities] } : {}),
        label,
        ...flag,
      };
    case 'hole':
      return { kind: 'hole', feature: source.feature, label, ...flag };
  }
}

const NO_FEEDS: Record<FeedKey, string> = { spindle: '', cut: '', plunge: '', ramp: '', lead: '' };

/** A new operation's form: the first suitable tool, the kind's defaults, no sources. */
export function newOperationForm(
  doc: ManufaktureDocument,
  kind: DialogOperationKind,
  name: string,
): OperationForm {
  return {
    kind,
    name,
    tool: suitableTools(doc, kind)[0]?.id ?? '',
    sources: [],
    depthMode: kind === 'drill' ? 'own' : kind === 'pocket' ? 'blind' : 'through',
    depth: kind === 'facing' ? '0.5 mm' : '3 mm',
    extra: kind === 'profile' ? '0.2 mm' : '',
    stepdown: '',
    stepover: '',
    finishAllowance: '',
    angle: '0 deg',
    side: 'outside',
    climb: true,
    tabs: false,
    tabCount: '4',
    tabWidth: '6 mm',
    tabHeight: '2 mm',
    entry: 'plunge',
    entryAngle: '3 deg',
    entryRadius: '2 mm',
    leadIn: 'none',
    leadInSize: '2 mm',
    leadOut: 'none',
    leadOutSize: '2 mm',
    peck: '',
    dwell: '',
    maxDepth: '',
    feeds: { ...NO_FEEDS },
  };
}

const text = (e: StoredExpression | undefined, fallback = '') => e?.source ?? fallback;

/**
 * The form of an existing operation. `lost`: indices of its geometry sources the last geometry
 * request could not find (shown for re-pick).
 */
export function formOf(
  doc: ManufaktureDocument,
  setup: CamSetup,
  op: CamOperation,
  lost: ReadonlySet<number> = new Set(),
): OperationForm | null {
  if (op.kind === 'surface3d') return null;
  const part = doc.parts.find((p) => p.id === setup.part);
  const form = newOperationForm(doc, op.kind, op.name);
  form.tool = op.tool;
  form.sources = op.geometry.map((s, i) => draftOf(part, s, lost.has(i)));
  form.feeds = {
    spindle: text(op.feeds?.spindle),
    cut: text(op.feeds?.cut),
    plunge: text(op.feeds?.plunge),
    ramp: text(op.feeds?.ramp),
    lead: text(op.feeds?.lead),
  };
  const depth = (d: (CamOperation & { kind: 'profile' })['depth'] | undefined) => {
    if (d === undefined) {
      form.depthMode = 'own';
    } else if (d.kind === 'blind') {
      form.depthMode = 'blind';
      form.depth = d.depth.source;
    } else {
      form.depthMode = 'through';
      form.extra = text(d.extra);
    }
  };
  const entry = (e: (CamOperation & { kind: 'profile' })['entry']) => {
    form.entry = e.kind;
    if (e.kind !== 'plunge') form.entryAngle = e.angle.source;
    if (e.kind === 'helix') form.entryRadius = e.radius.source;
  };
  switch (op.kind) {
    case 'facing':
      form.depth = op.depth.source;
      form.stepdown = text(op.stepdown);
      form.stepover = text(op.stepover);
      form.angle = op.angle.source;
      break;
    case 'profile':
      depth(op.depth);
      form.side = op.side;
      form.climb = op.climb;
      form.stepdown = text(op.stepdown);
      form.finishAllowance = text(op.finishAllowance);
      form.tabs = op.tabs !== undefined;
      if (op.tabs) {
        form.tabCount = op.tabs.count.source;
        form.tabWidth = op.tabs.width.source;
        form.tabHeight = op.tabs.height.source;
      }
      entry(op.entry);
      form.leadIn = op.leadIn.kind;
      if (op.leadIn.kind === 'line') form.leadInSize = op.leadIn.length.source;
      if (op.leadIn.kind === 'arc') form.leadInSize = op.leadIn.radius.source;
      form.leadOut = op.leadOut.kind;
      if (op.leadOut.kind === 'line') form.leadOutSize = op.leadOut.length.source;
      if (op.leadOut.kind === 'arc') form.leadOutSize = op.leadOut.radius.source;
      break;
    case 'pocket':
      depth(op.depth);
      form.climb = op.climb;
      form.stepdown = text(op.stepdown);
      form.stepover = text(op.stepover);
      form.finishAllowance = text(op.finishAllowance);
      entry(op.entry);
      break;
    case 'drill':
      depth(op.depth);
      form.peck = text(op.peck);
      form.dwell = text(op.dwell);
      break;
    case 'vcarve':
      form.maxDepth = text(op.maxDepth);
      break;
  }
  return form;
}

/** Add a picked face; a face already in the list is not added twice. */
export function addFace(form: OperationForm, ref: FaceRef, replace?: number): OperationForm {
  const draft: SourceDraft = { kind: 'face', id: null, ref, label: `Face ${ref.face}` };
  const sources = form.sources.slice();
  if (replace !== undefined && replace >= 0 && replace < sources.length) {
    sources[replace] = draft;
    return { ...form, sources };
  }
  if (sources.some((s) => s.kind === 'face' && s.ref.face === ref.face)) return form;
  return { ...form, sources: [...sources, draft] };
}

export function addSource(form: OperationForm, draft: SourceDraft): OperationForm {
  const same = (s: SourceDraft) =>
    (s.kind === 'region' &&
      draft.kind === 'region' &&
      s.sketch === draft.sketch &&
      JSON.stringify(s.entities ?? null) === JSON.stringify(draft.entities ?? null)) ||
    (s.kind === 'hole' && draft.kind === 'hole' && s.feature === draft.feature);
  if (form.sources.some(same)) return form;
  return { ...form, sources: [...form.sources, draft] };
}

export function removeSource(form: OperationForm, index: number): OperationForm {
  return { ...form, sources: form.sources.filter((_, i) => i !== index) };
}

export type BuildResult =
  | { ok: true; command: Command; label: string; operationId: string }
  | { ok: false; errors: Record<string, string> };

export interface BuildContext {
  doc: ManufaktureDocument;
  setup: CamSetup;
  /** The operation edited; absent for a new one. */
  existing?: CamOperation;
  units: DisplayUnits;
  variables: Variables;
}

/** The stored expression of a field of the original operation, by form key, to keep its units. */
function originalExpression(
  op: CamOperation | undefined,
  key: string,
): StoredExpression | undefined {
  if (!op) return undefined;
  const o = op as unknown as Record<string, unknown>;
  const pick = (v: unknown): StoredExpression | undefined =>
    v && typeof v === 'object' && 'source' in v ? (v as StoredExpression) : undefined;
  const sub = (field: string, inner: string) => {
    const v = o[field];
    return v && typeof v === 'object' ? pick((v as Record<string, unknown>)[inner]) : undefined;
  };
  switch (key) {
    case 'depth':
      return op.kind === 'facing' ? op.depth : sub('depth', 'depth');
    case 'extra':
      return sub('depth', 'extra');
    case 'tabCount':
      return sub('tabs', 'count');
    case 'tabWidth':
      return sub('tabs', 'width');
    case 'tabHeight':
      return sub('tabs', 'height');
    case 'entryAngle':
      return sub('entry', 'angle');
    case 'entryRadius':
      return sub('entry', 'radius');
    case 'leadInSize':
      return sub('leadIn', 'length') ?? sub('leadIn', 'radius');
    case 'leadOutSize':
      return sub('leadOut', 'length') ?? sub('leadOut', 'radius');
    default:
      if (key.startsWith('feeds.')) return sub('feeds', key.slice(6));
      return pick(o[key]);
  }
}

/** Check the form and build its command; every problem is reported against its field. */
export function buildOperation(form: OperationForm, ctx: BuildContext): BuildResult {
  const { doc, setup, existing, units, variables } = ctx;
  const errors: Record<string, string> = {};
  const values: Partial<Record<string, StoredExpression>> = {};

  const name = form.name.trim();
  if (name === '') errors.name = 'Give the operation a name.';
  const tool = doc.cam.tools.find((t) => t.id === form.tool);
  const toolError = toolProblem(tool, form.kind);
  if (toolError) errors.tool = toolError;

  const take = (key: string, s: FieldSpec, value: string) => {
    const r = checkField(value, s.kind, s.rule, units, variables, s.optional);
    if (!r.ok) errors[key] = r.message;
    else if (!r.empty) values[key] = storedOf(value, units, originalExpression(existing, key));
  };
  for (const key of activeFields(form)) take(key, FIELD_SPECS[key], form[key]);
  for (const key of FEED_KEYS) take(`feeds.${key}`, FEED_SPECS[key], form.feeds[key]);

  // Sources: what the kind takes, and enough of them.
  const accepted = acceptedSources(form.kind);
  if (form.sources.some((s) => !accepted.includes(s.kind))) {
    errors.sources =
      form.kind === 'drill'
        ? 'A drill takes hole features (or none: every round hole it can reach).'
        : 'This operation takes faces and sketch regions.';
  } else if (form.sources.some((s) => s.lost)) {
    errors.sources = 'Some geometry was not found: pick it again or remove it.';
  } else if (
    form.sources.length === 0 &&
    (form.kind === 'profile' || form.kind === 'pocket' || form.kind === 'vcarve')
  ) {
    errors.sources = 'Pick at least one face or add a sketch region.';
  } else if (
    form.kind === 'pocket' &&
    form.sources.some((s) => s.kind === 'face') &&
    form.sources.some((s) => s.kind === 'region')
  ) {
    errors.sources =
      'A pocket takes floor faces or sketch regions, not both: split it into two pockets.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Ids: the operation's own and fresh ones for faces picked here.
  const id = existing?.id ?? previewIds(doc.cam.nextIds, form.kind)[0]!;
  const newFaces = form.sources.filter((s) => s.kind === 'face' && s.id === null).length;
  const freshRefs = previewIds(doc.cam.nextIds, 'r', newFaces);
  let nextRef = 0;
  const geometry: CamGeometrySource[] = form.sources.map((s) => {
    switch (s.kind) {
      case 'face': {
        const refId = s.id ?? freshRefs[nextRef++]!;
        return {
          kind: 'face',
          face: {
            id: refId,
            ref: s.ref,
            ...(s.id !== null && s.lastResolved ? { lastResolved: s.lastResolved } : {}),
          },
        };
      }
      case 'region':
        return {
          kind: 'region',
          sketch: s.sketch,
          ...(s.entities ? { entities: s.entities } : {}),
        };
      case 'hole':
        return { kind: 'hole', feature: s.feature };
    }
  });

  const v = (key: string) => values[key]!;
  const opt = <K extends string>(field: K, key: string) =>
    (values[key] ? { [field]: values[key] } : {}) as Partial<Record<K, StoredExpression>>;
  const feedsEntries = FEED_KEYS.filter((k) => values[`feeds.${k}`]).map(
    (k) => [k, values[`feeds.${k}`]!] as const,
  );
  const base = {
    id,
    name,
    suppressed: existing?.suppressed ?? false,
    tool: form.tool,
    geometry,
    ...(feedsEntries.length > 0 ? { feeds: Object.fromEntries(feedsEntries) } : {}),
  };
  const depth = () =>
    form.depthMode === 'blind'
      ? { kind: 'blind' as const, depth: v('depth') }
      : { kind: 'through' as const, ...opt('extra', 'extra') };
  const entry = () =>
    form.entry === 'plunge'
      ? { kind: 'plunge' as const }
      : form.entry === 'ramp'
        ? { kind: 'ramp' as const, angle: v('entryAngle') }
        : { kind: 'helix' as const, angle: v('entryAngle'), radius: v('entryRadius') };
  const lead = (kind: OperationForm['leadIn'], key: 'leadInSize' | 'leadOutSize') =>
    kind === 'none'
      ? { kind: 'none' as const }
      : kind === 'line'
        ? { kind: 'line' as const, length: v(key) }
        : { kind: 'arc' as const, radius: v(key) };

  let operation: CamOperation;
  switch (form.kind) {
    case 'facing':
      operation = {
        ...base,
        kind: 'facing',
        id,
        depth: v('depth'),
        ...opt('stepdown', 'stepdown'),
        ...opt('stepover', 'stepover'),
        angle: v('angle'),
      };
      break;
    case 'profile':
      operation = {
        ...base,
        kind: 'profile',
        side: form.side,
        depth: depth(),
        ...opt('stepdown', 'stepdown'),
        ...opt('finishAllowance', 'finishAllowance'),
        ...(form.tabs
          ? { tabs: { count: v('tabCount'), width: v('tabWidth'), height: v('tabHeight') } }
          : {}),
        entry: entry(),
        leadIn: lead(form.leadIn, 'leadInSize'),
        leadOut: lead(form.leadOut, 'leadOutSize'),
        climb: form.climb,
      };
      break;
    case 'pocket':
      operation = {
        ...base,
        kind: 'pocket',
        depth: depth(),
        ...opt('stepdown', 'stepdown'),
        ...opt('stepover', 'stepover'),
        ...opt('finishAllowance', 'finishAllowance'),
        entry: entry(),
        climb: form.climb,
      };
      break;
    case 'drill':
      operation = {
        ...base,
        kind: 'drill',
        ...(form.depthMode === 'own' ? {} : { depth: depth() }),
        ...opt('peck', 'peck'),
        ...opt('dwell', 'dwell'),
      };
      break;
    case 'vcarve':
      operation = { ...base, kind: 'vcarve', ...opt('maxDepth', 'maxDepth') };
      break;
  }

  const what = `${OPERATION_LABELS[form.kind].toLowerCase()} operation`;
  if (existing) {
    return {
      ok: true,
      command: { type: 'editCamOperation', setupId: setup.id, operation },
      label: `Edit ${existing.name}`,
      operationId: id,
    };
  }
  return {
    ok: true,
    command: { type: 'addCamOperation', setupId: setup.id, operation },
    label: `Add ${what} ${name}`,
    operationId: id,
  };
}

/** A new operation's name: `Profile 1`, numbered by the kind's next id. */
export function newOperationName(doc: ManufaktureDocument, kind: DialogOperationKind): string {
  const [id] = previewIds(doc.cam.nextIds, kind);
  return `${OPERATION_LABELS[kind]} ${id!.slice(kind.length + 1)}`;
}
