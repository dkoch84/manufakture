// The Opening tool's logic, free of React: a door, window or plain opening in a wall
// (`construction.opening`, ADR 0015 decision 2), by its rough opening, placed on one segment of
// the wall from its start, from its end or centred, with the header it asks for. ADR 0015
// decision 7: an opening's header is its own explicit one, else the narrowest of the user's
// header rules that covers its width, else its wall type's default; the tool says which one
// applies before the opening is added (`headerPreview`), and the panel says which one regen used
// (`headerUsed`, from the member stage's report).

import {
  previewIds,
  type Command,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import {
  OPENING_SCHEMA_VERSION,
  OPENING_TYPE,
  readOpeningParams,
  type ConstructionSettings,
  type HeaderData,
  type WallType,
} from '@manufakture/domain-construction';
import { findStock } from '@manufakture/stock';
import { formatLength } from '@manufakture/units';
import { lengthFormat, type Variables } from '../sketcher/values';
import { checkLength, coordinateExpression } from './lengths';
import { isOpening, isWall } from './settings';
import { newFeatureName } from './walls';

export type OpeningKind = 'door' | 'window' | 'opening';
export type Placement = 'start' | 'end' | 'centre';
export type HeaderChoice = 'auto' | 'default' | 'explicit';

export const KIND_LABELS: Record<OpeningKind, string> = {
  door: 'Door',
  window: 'Window',
  opening: 'Opening',
};

export interface OpeningForm {
  wall: string;
  /** 1-based segment of the wall's path. */
  segment: number;
  kind: OpeningKind;
  width: string;
  height: string;
  /** Windows (and optionally plain openings): the rough opening's bottom above the wall's base. */
  sill: string;
  placement: Placement;
  /** From the start or end of the segment to the opening's centre line. */
  position: string;
  header: HeaderChoice;
  headerStock: string;
  headerPlies: string;
  headerJacks: string;
}

export function newOpeningForm(wall = ''): OpeningForm {
  return {
    wall,
    segment: 1,
    kind: 'door',
    width: '',
    height: '',
    sill: '',
    placement: 'centre',
    position: '',
    header: 'auto',
    headerStock: '',
    headerPlies: '',
    headerJacks: '',
  };
}

/** The form for an existing opening. */
export function openingFormOf(f: ExtensionFeature): OpeningForm {
  const p = f.params as Record<string, unknown>;
  const h = (p.header ?? { kind: 'auto' }) as Record<string, unknown>;
  const src = (k: string) => f.expressions[k]?.source ?? '';
  return {
    wall: f.dependsOn[0] ?? '',
    segment: typeof p.segment === 'number' ? p.segment : 1,
    kind: (p.kind as OpeningKind) ?? 'door',
    width: src('width'),
    height: src('height'),
    sill: src('sill'),
    placement: p.from === 'end' ? 'end' : 'start',
    position: src('position'),
    header: (h.kind as HeaderChoice) ?? 'auto',
    headerStock: typeof h.stock === 'string' ? h.stock : '',
    headerPlies: typeof h.plies === 'number' ? String(h.plies) : '',
    headerJacks: typeof h.jacks === 'number' ? String(h.jacks) : '',
  };
}

export type OpeningBuild =
  | { ok: true; feature: ExtensionFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

export interface OpeningContext {
  doc: ManufaktureDocument;
  partId: string;
  variables: Variables;
  /** The length of the chosen segment, mm, from the wall's last regen: needed to centre. */
  segmentLength: number | undefined;
  existing?: ExtensionFeature | undefined;
}

const COUNT = /^[1-4]$/;

/** The opening a filled form describes, and the command that adds it or edits `existing`. */
export function buildOpening(form: OpeningForm, ctx: OpeningContext): OpeningBuild {
  const { doc, partId, variables } = ctx;
  const units = doc.units;
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, errors: { form: 'The part studio is gone.' } };
  const errors: Record<string, string> = {};
  const wall = part.features.find((f) => f.id === form.wall);
  if (!wall || !isWall(wall)) errors.wall = 'Pick a wall.';
  const expressions: Record<string, StoredExpression> = {};
  const length = (
    key: 'width' | 'height' | 'sill' | 'position',
    sign: 'positive' | 'non-negative',
  ) => {
    const r = checkLength(form[key], units, variables, { sign });
    if (r.ok) expressions[key] = r.expression;
    else errors[key] = r.message;
    return r.ok ? r.value : undefined;
  };
  const width = length('width', 'positive');
  length('height', 'positive');
  if (form.kind === 'window' || (form.kind === 'opening' && form.sill.trim() !== '')) {
    length('sill', 'non-negative');
  }
  let from: 'start' | 'end' = 'start';
  if (form.placement === 'centre') {
    if (ctx.segmentLength === undefined) {
      errors.position = 'The wall has not been built yet, so its length is not known.';
    } else {
      expressions.position = coordinateExpression(ctx.segmentLength / 2, units);
    }
  } else {
    from = form.placement;
    length('position', 'non-negative');
  }
  if (ctx.segmentLength !== undefined && width !== undefined && width > ctx.segmentLength + 1e-6) {
    errors.width = `Wider than the wall segment (${formatLength(ctx.segmentLength, lengthFormat(units))}).`;
  }
  let header: Record<string, string | number> = { kind: form.header };
  if (form.header === 'explicit') {
    if (form.headerStock === '' || !findStock(form.headerStock))
      errors.headerStock = 'Choose the header stock.';
    if (!COUNT.test(form.headerPlies)) errors.headerPlies = 'Choose how many plies.';
    if (!COUNT.test(form.headerJacks)) errors.headerJacks = 'Choose how many jack studs.';
    header = {
      kind: 'explicit',
      stock: form.headerStock,
      plies: Number(form.headerPlies),
      jacks: Number(form.headerJacks),
    };
  }
  const existingParams = (ctx.existing?.params ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = {
    // Keep what the tool does not edit (overrides, kings, a door's swing).
    ...existingParams,
    kind: form.kind,
    segment: form.segment,
    from,
    header,
  };
  if (form.kind !== 'door') {
    delete params.swing;
    delete params.hand;
  }
  // Nudges of the opening's own member overrides stay as they were.
  if (ctx.existing) {
    for (const [k, v] of Object.entries(ctx.existing.expressions)) {
      if (/^move_[1-9][0-9]*$/.test(k)) expressions[k] = v;
    }
  }
  if (Object.keys(errors).length === 0) {
    const r = readOpeningParams(params as never, OPENING_SCHEMA_VERSION);
    if (!r.ok) errors.form = r.message;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const id = ctx.existing?.id ?? previewIds(part.nextIds, 'extension')[0]!;
  const name =
    ctx.existing?.name ??
    newFeatureName(
      part,
      KIND_LABELS[form.kind],
      (f) => isOpening(f) && f.params.kind === form.kind,
    );
  const feature: ExtensionFeature = {
    id,
    kind: 'extension',
    name,
    suppressed: ctx.existing?.suppressed ?? false,
    extension: OPENING_TYPE,
    schemaVersion: OPENING_SCHEMA_VERSION,
    dependsOn: [form.wall],
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
  };
  const command: Command = ctx.existing
    ? { type: 'editFeature', partId, feature }
    : { type: 'addFeature', partId, feature };
  return { ok: true, feature, command, label: `${ctx.existing ? 'Edit' : 'Add'} ${name}` };
}

// Headers ------------------------------------------------------------------------------------------

/** The wall type's default header: its framing layer's. */
export function defaultHeader(type: WallType | undefined): HeaderData | undefined {
  const framing = type?.layers.find((l) => l.kind === 'framing');
  return framing && framing.kind === 'framing' ? framing.header : undefined;
}

export type HeaderPreview =
  | { source: 'rule'; rule: number; maxWidth: number; header: HeaderData }
  | { source: 'default'; header: HeaderData | undefined; uncovered: boolean }
  | { source: 'opening'; header: HeaderData };

/**
 * Which header an opening of `width` would use (ADR 0015 decision 7): its own when explicit; else
 * the narrowest rule at least as wide, whatever the table's order; else the wall type's default
 * (`uncovered` when rules exist and none is wide enough: regen warns about that).
 */
export function headerPreview(
  settings: ConstructionSettings | undefined,
  type: WallType | undefined,
  width: number | undefined,
  choice: HeaderChoice,
  explicit?: HeaderData,
): HeaderPreview {
  if (choice === 'explicit' && explicit) return { source: 'opening', header: explicit };
  const rules = settings?.headerRules ?? [];
  if (choice === 'auto' && width !== undefined) {
    let best = -1;
    for (let i = 0; i < rules.length; i++) {
      const w = rules[i]!.maxWidth;
      if (w + 1e-6 >= width && (best < 0 || w < rules[best]!.maxWidth)) best = i;
    }
    if (best >= 0) {
      const r = rules[best]!;
      return { source: 'rule', rule: best, maxWidth: r.maxWidth, header: r.header };
    }
  }
  return {
    source: 'default',
    header: defaultHeader(type),
    uncovered: choice === 'auto' && rules.length > 0,
  };
}

/** `2 plies of 2x8 on 1 jack stud each end`. */
export function headerSpecText(h: HeaderData): string {
  const stock = findStock(h.stock)?.name ?? h.stock;
  return `${h.plies} ${h.plies === 1 ? 'ply' : 'plies'} of ${stock} on ${h.jacks} jack stud${h.jacks === 1 ? '' : 's'} each end`;
}

/** What the tool and the panel say about a header and where it came from. */
export function headerSourceText(p: HeaderPreview, units: DisplayUnits): string {
  if (p.source === 'opening') return `Set on this opening: ${headerSpecText(p.header)}.`;
  if (p.source === 'rule') {
    const w = formatLength(p.maxWidth, lengthFormat(units));
    return `Your header rule for openings up to ${w}: ${headerSpecText(p.header)}.`;
  }
  const spec = p.header ? `: ${headerSpecText(p.header)}` : '';
  return p.uncovered
    ? `No header rule is this wide, so the wall type's default${spec}.`
    : `The wall type's default header${spec}.`;
}

/** The header a framed opening used, as the member stage reported it with its wall's set. */
export interface HeaderUsed {
  source: 'opening' | 'rule' | 'default';
  rule?: number;
  stock: string;
  plies: number;
  jacks: number;
  framed: boolean;
}

/** Find an opening's header report in its wall's set metadata. */
export function headerUsed(metadata: unknown, openingId: string): HeaderUsed | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const openings = (metadata as { openings?: unknown }).openings;
  if (!Array.isArray(openings)) return undefined;
  for (const o of openings as Record<string, unknown>[]) {
    if (o?.id !== openingId) continue;
    const h = o.header as Record<string, unknown> | undefined;
    if (!h || typeof h.stock !== 'string') return undefined;
    const source = h.source === 'rule' || h.source === 'opening' ? h.source : 'default';
    return {
      source,
      ...(typeof h.rule === 'number' ? { rule: h.rule } : {}),
      stock: h.stock,
      plies: Number(h.plies),
      jacks: Number(h.jacks),
      framed: o.framed !== false,
    };
  }
  return undefined;
}

/** The used header as a preview, for `headerSourceText`. */
export function usedAsPreview(
  used: HeaderUsed,
  settings: ConstructionSettings | undefined,
  choice: HeaderChoice,
): HeaderPreview {
  const header: HeaderData = { stock: used.stock, plies: used.plies, jacks: used.jacks };
  if (used.source === 'opening') return { source: 'opening', header };
  if (used.source === 'rule' && used.rule !== undefined) {
    const rule = settings?.headerRules[used.rule];
    if (rule) return { source: 'rule', rule: used.rule, maxWidth: rule.maxWidth, header };
  }
  return {
    source: 'default',
    header,
    uncovered: choice === 'auto' && (settings?.headerRules.length ?? 0) > 0,
  };
}
