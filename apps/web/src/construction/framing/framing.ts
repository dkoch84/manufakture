// The document's framing settings as the Framing settings section edits them, free of React: the
// framing defaults every wall uses unless its wall type or the wall itself overrides them
// (`domains.construction` `framing`, T6.1a), and the user's header rules (ADR 0015 decision 7: a
// new document has none, and nothing here offers template rows or sizes). Settings are constants
// (ADR 0013 decision 3), so no field takes a variable. Each Save is one `setDomainData`, one undo
// step, checked by the domain's reader first. Lists are bounded (`MAX_LENGTHS` lengths,
// `MAX_HEADER_RULES` rules) before anything is parsed, and every loop is linear in them.

import type { DisplayUnits, ManufaktureDocument, StoredExpression } from '@manufakture/core';
import {
  MAX_HEADER_RULES,
  MAX_LENGTHS,
  MAX_SETTING_LENGTH,
  MIN_PLATE_STOCK,
  MIN_SPACING,
  type FramingSettings,
  type HeaderData,
  type HeaderRuleData,
} from '@manufakture/domain-construction';
import { findStock } from '@manufakture/stock';
import { checkLength } from '../lengths';
import { settingsCommand, storedOrDefault, type Outcome } from '../settings';

export type CornerChoice = '' | 'two-stud' | 'three-stud' | 'ladder';
export type BlockingChoice = '' | 'none' | 'mid-height' | 'heights';

/** The form: empty text and `''` choices leave the generator's default. */
export interface FramingForm {
  spacing: string;
  layoutOrigin: string;
  layoutFrom: '' | 'start' | 'end';
  bottomPlates: '' | '1' | '2' | '3';
  topPlates: '' | '1' | '2' | '3';
  kings: '' | '1' | '2' | '3' | '4';
  cornerStyle: CornerChoice;
  blocking: BlockingChoice;
  /** Blocking heights above the wall's base, comma separated (`blocking: 'heights'`). */
  heights: string;
  spliceOffset: string;
  /** Lengths the yard sells plates in, comma separated: `8', 10', 12'`. */
  plateStockLengths: string;
  /** Precut stud lengths, comma separated. */
  precutLengths: string;
  ladderSpacing: string;
}

type Stored = FramingSettings<StoredExpression>;

const list = (v: readonly StoredExpression[] | undefined) =>
  v === undefined ? '' : v.map((e) => e.source).join(', ');

export function framingFormOf(f: Stored): FramingForm {
  const count = <T extends string>(n: number | undefined) =>
    (n === undefined ? '' : String(n)) as T;
  return {
    spacing: f.spacing?.source ?? '',
    layoutOrigin: f.layoutOrigin?.source ?? '',
    layoutFrom: f.layoutFrom ?? '',
    bottomPlates: count(f.bottomPlates),
    topPlates: count(f.topPlates),
    kings: count(f.kings),
    cornerStyle: f.cornerStyle ?? '',
    blocking: f.blocking?.kind ?? '',
    heights: f.blocking?.kind === 'heights' ? list(f.blocking.heights) : '',
    spliceOffset: f.spliceOffset?.source ?? '',
    plateStockLengths: list(f.plateStockLengths),
    precutLengths: list(f.precutLengths),
    ladderSpacing: f.ladderSpacing?.source ?? '',
  };
}

/** The longest list text a field takes (20 lengths of 100 characters with separators). */
const MAX_LIST_TEXT = MAX_LENGTHS * 102;

/** A comma-separated list of constant lengths, at most `MAX_LENGTHS`. */
export function lengthList(
  text: string,
  units: DisplayUnits,
  min?: { value: number; text: string },
): { ok: true; value: StoredExpression[] } | { ok: false; message: string } {
  if (text.length > MAX_LIST_TEXT) return { ok: false, message: 'That list is too long.' };
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return { ok: false, message: 'Enter at least one length.' };
  if (parts.length > MAX_LENGTHS) {
    return { ok: false, message: `At most ${MAX_LENGTHS} lengths.` };
  }
  const out: StoredExpression[] = [];
  for (const p of parts) {
    const r = checkLength(p, units, {}, { constant: true, ...(min ? { min } : {}) });
    if (!r.ok) return { ok: false, message: `${p}: ${r.message}` };
    out.push(r.expression);
  }
  return { ok: true, value: out };
}

/** The framing defaults from the form, or the field errors. */
export function framingOf(
  form: FramingForm,
  units: DisplayUnits,
): { ok: true; value: Stored } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const max = { value: MAX_SETTING_LENGTH, text: `${MAX_SETTING_LENGTH / 1000} m` };
  const one = (
    key: keyof FramingForm & keyof Stored,
    options: Parameters<typeof checkLength>[3] = {},
  ) => {
    const text = form[key] as string;
    if (text.trim() === '') return;
    const r = checkLength(text, units, {}, { constant: true, ...options });
    if (!r.ok) errors[key] = r.message;
    else if (Math.abs(r.value) > max.value) errors[key] = `Must be at most ${max.text}.`;
    else out[key] = r.expression;
  };
  const spacingMin = { value: MIN_SPACING, text: `${MIN_SPACING} mm` };
  one('spacing', { min: spacingMin });
  one('layoutOrigin', { sign: 'any' });
  one('spliceOffset', { sign: 'non-negative' });
  one('ladderSpacing', { min: spacingMin });
  if (form.layoutFrom !== '') out.layoutFrom = form.layoutFrom;
  if (form.cornerStyle !== '') out.cornerStyle = form.cornerStyle;
  for (const k of ['bottomPlates', 'topPlates', 'kings'] as const) {
    if (form[k] !== '') out[k] = Number(form[k]);
  }
  if (form.blocking === 'none' || form.blocking === 'mid-height') {
    out.blocking = { kind: form.blocking };
  } else if (form.blocking === 'heights') {
    const r = lengthList(form.heights, units);
    if (!r.ok) errors.heights = r.message;
    else out.blocking = { kind: 'heights', heights: r.value };
  }
  for (const [key, min] of [
    ['plateStockLengths', { value: MIN_PLATE_STOCK, text: `${MIN_PLATE_STOCK} mm` }],
    ['precutLengths', undefined],
  ] as const) {
    if (form[key].trim() === '') continue;
    const r = lengthList(form[key], units, min);
    if (!r.ok) errors[key] = r.message;
    else out[key] = r.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out as Stored };
}

/** Store the framing defaults: one undo step (null command when nothing changed). */
export function saveFraming(doc: ManufaktureDocument, framing: Stored): Outcome {
  const s = storedOrDefault(doc);
  if (!s.ok) return s;
  return settingsCommand(doc, { ...s.stored, framing }, 'Set the framing defaults');
}

// Header rules ------------------------------------------------------------------------------------

/** A header rule as edited: every field the user's. */
export interface HeaderRuleForm {
  maxWidth: string;
  stock: string;
  plies: string;
  jacks: string;
  /** A spacer stock the rule already had (kept; not edited here). */
  spacer?: string;
}

export function headerRuleFormOf(r: HeaderRuleData<StoredExpression>): HeaderRuleForm {
  return {
    maxWidth: r.maxWidth.source,
    stock: r.header.stock,
    plies: String(r.header.plies),
    jacks: String(r.header.jacks),
    ...(r.header.spacer !== undefined ? { spacer: r.header.spacer } : {}),
  };
}

/** An empty row: nothing filled in (no template sizes, ADR 0015 decision 7). */
export const EMPTY_RULE: HeaderRuleForm = { maxWidth: '', stock: '', plies: '', jacks: '' };

/**
 * The header rules from the rows, or each row's errors (keyed `<row>.<field>`). Two rules for the
 * same width are refused, as the domain refuses them.
 */
export function headerRulesOf(
  rows: readonly HeaderRuleForm[],
  units: DisplayUnits,
):
  | { ok: true; value: HeaderRuleData<StoredExpression>[] }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (rows.length > MAX_HEADER_RULES) {
    return { ok: false, errors: { form: `At most ${MAX_HEADER_RULES} header rules.` } };
  }
  const out: HeaderRuleData<StoredExpression>[] = [];
  const widths = new Map<number, number>();
  rows.forEach((row, i) => {
    const at = (k: string) => `${i}.${k}`;
    const w = checkLength(row.maxWidth, units, {}, { constant: true });
    if (!w.ok) errors[at('maxWidth')] = w.message;
    else if (w.value > MAX_SETTING_LENGTH) {
      errors[at('maxWidth')] = `Must be at most ${MAX_SETTING_LENGTH / 1000} m.`;
    } else {
      const key = Math.round(w.value * 1000);
      const same = widths.get(key);
      if (same !== undefined) {
        errors[at('maxWidth')] = `Rule ${same + 1} is for the same width.`;
      }
      widths.set(key, i);
    }
    if (row.stock === '' || findStock(row.stock)?.kind !== 'lumber') {
      errors[at('stock')] = 'Choose the header stock.';
    }
    if (!/^[1-4]$/.test(row.plies)) errors[at('plies')] = 'Choose how many plies.';
    if (!/^[1-4]$/.test(row.jacks)) errors[at('jacks')] = 'Choose how many jack studs.';
    if (w.ok) {
      const spacer = row.spacer;
      const header: HeaderData = {
        stock: row.stock,
        plies: Number(row.plies),
        jacks: Number(row.jacks),
        ...(spacer !== undefined ? { spacer } : {}),
      };
      out.push({ maxWidth: w.expression, header });
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

/** Store the header rules: one undo step (null command when nothing changed). */
export function saveHeaderRules(
  doc: ManufaktureDocument,
  rules: readonly HeaderRuleData<StoredExpression>[],
): Outcome {
  const s = storedOrDefault(doc);
  if (!s.ok) return s;
  return settingsCommand(doc, { ...s.stored, headerRules: [...rules] }, 'Set the header rules');
}
