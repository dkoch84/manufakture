// The takeoff settings form (M6 plan T6.3b): precut studs on or off, a waste percentage for sheet
// goods, the currency, and the lengths the yard sells per lumber stock, stored in
// `domains.construction` (`takeoff`) by one `setDomainData`, so one undo step. Empty fields take
// the defaults: precuts on, no waste, the currency the prices state, the catalog's lengths. Lengths
// are typed as a list (`8', 10', 12'`); `cut` buys each piece at its own length.

import type {
  Command,
  DisplayUnits,
  ManufaktureDocument,
  StoredExpression,
} from '@manufakture/core';
import {
  MAX_LENGTHS,
  MAX_TAKEOFF_STOCKS,
  MAX_WASTE_PERCENT,
  MIN_PLATE_STOCK,
  type StoredConstructionSettings,
  type TakeoffSettingsData,
} from '@manufakture/domain-construction';
import { checkLength } from '../lengths';
import { settingsCommand, storedOrDefault } from '../settings';

/** The word that buys each piece at its own length. */
export const AS_CUT = 'cut';
/** The longest list of lengths a field takes, in characters. */
export const MAX_LENGTHS_TEXT = 400;

export interface TakeoffForm {
  precuts: boolean;
  /** Percent; empty for none. */
  waste: string;
  /** Empty: the currency the prices state. */
  currency: string;
  /** By lumber stock id: the lengths sold as typed; empty for the catalog's. */
  lengths: Record<string, string>;
}

export type TakeoffFormErrors = Partial<Record<'waste' | 'currency', string>> & {
  lengths?: Record<string, string>;
};

/** The form for the document's stored settings, with a field for each of `stocks` too. */
export function takeoffForm(
  stored: TakeoffSettingsData<StoredExpression> | undefined,
  stocks: readonly string[],
): TakeoffForm {
  const lengths: Record<string, string> = {};
  for (const id of stocks) lengths[id] = '';
  for (const [id, list] of Object.entries(stored?.lengths ?? {})) {
    lengths[id] = list.length === 0 ? AS_CUT : list.map((e) => e.source).join(', ');
  }
  return {
    precuts: stored?.precuts ?? true,
    waste: stored?.wastePercent === undefined ? '' : String(stored.wastePercent),
    currency: stored?.currency ?? '',
    lengths,
  };
}

/** The stored settings for a form, or the errors per field. */
export function readTakeoffForm(
  form: TakeoffForm,
  units: DisplayUnits,
):
  | { ok: true; value: TakeoffSettingsData<StoredExpression> }
  | { ok: false; errors: TakeoffFormErrors } {
  const errors: TakeoffFormErrors = {};
  const out: {
    precuts?: boolean;
    wastePercent?: number;
    currency?: string;
    lengths?: Record<string, StoredExpression[]>;
  } = {};
  if (!form.precuts) out.precuts = false;
  const waste = form.waste.trim();
  if (waste !== '') {
    const n = waste.length <= 20 ? Number(waste.replace(/%$/, '')) : Number.NaN;
    if (!(n >= 0 && n <= MAX_WASTE_PERCENT)) {
      errors.waste = `A percentage from 0 to ${MAX_WASTE_PERCENT}.`;
    } else if (n > 0) {
      out.wastePercent = n;
    }
  }
  const currency = form.currency.trim().toUpperCase();
  if (currency !== '') {
    if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'A three-letter code such as USD.';
    else out.currency = currency;
  }
  const entries = Object.entries(form.lengths);
  if (entries.length > MAX_TAKEOFF_STOCKS) {
    errors.lengths = { '': `At most ${MAX_TAKEOFF_STOCKS} stocks.` };
  } else {
    const lengths: [string, StoredExpression[]][] = [];
    for (const [id, text] of entries) {
      const t = text.trim();
      if (t === '') continue;
      if (t.toLowerCase() === AS_CUT) {
        lengths.push([id, []]);
        continue;
      }
      const parts = t.length <= MAX_LENGTHS_TEXT ? t.split(',').map((p) => p.trim()) : [];
      if (parts.length === 0 || parts.length > MAX_LENGTHS) {
        (errors.lengths ??= {})[id] =
          `Up to ${MAX_LENGTHS} lengths, separated by commas, or "${AS_CUT}".`;
        continue;
      }
      const list: StoredExpression[] = [];
      for (const p of parts) {
        const r = checkLength(p, units, undefined, {
          constant: true,
          min: { value: MIN_PLATE_STOCK, text: '300 mm (about 1 ft)' },
        });
        if (!r.ok) {
          (errors.lengths ??= {})[id] = `${p || 'An empty length'}: ${r.message}`;
          break;
        }
        list.push(r.expression);
      }
      if (list.length === parts.length) lengths.push([id, list]);
    }
    if (lengths.length > 0) out.lengths = Object.fromEntries(lengths);
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

export type TakeoffSettingsBuild =
  | { ok: true; command: Command | null; label: string }
  | { ok: false; errors: TakeoffFormErrors; message?: string };

/** The command storing the form's settings (null when nothing changes), or why not. */
export function takeoffSettingsCommand(
  doc: ManufaktureDocument,
  form: TakeoffForm,
): TakeoffSettingsBuild {
  const read = readTakeoffForm(form, doc.units);
  if (!read.ok) return { ok: false, errors: read.errors };
  const current = storedOrDefault(doc);
  if (!current.ok) return { ok: false, errors: {}, message: current.message };
  const rest: StoredConstructionSettings = { ...current.stored };
  delete (rest as { takeoff?: unknown }).takeoff;
  const next = Object.keys(read.value).length > 0 ? { ...rest, takeoff: read.value } : rest;
  const r = settingsCommand(doc, next, 'Change takeoff settings');
  return r.ok ? r : { ok: false, errors: {}, message: r.message };
}
