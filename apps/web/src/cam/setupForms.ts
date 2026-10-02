// The setup panel's stock and heights drafts, free of React (M5 plan, T5.3a): each field checked
// for its range as typed (margins and offsets zero or more, sizes and heights above zero, the
// retract height not above the clearance), then built into one `editCamSetup` change.

import type { CamSetup, CamStock, ManufaktureDocument, StoredExpression } from '@manufakture/core';
import type { Variables } from '../sketcher/values';
import type { SetupChanges } from './commands';
import { checkField, storedOf, type Rule } from './values';

export type StockKey =
  | 'xMin'
  | 'xMax'
  | 'yMin'
  | 'yMax'
  | 'top'
  | 'bottom'
  | 'sizeX'
  | 'sizeY'
  | 'sizeZ'
  | 'offsetX'
  | 'offsetY'
  | 'offsetZ'
  | 'clearance'
  | 'retract';

export const STOCK_FIELDS: Readonly<Record<StockKey, { label: string; rule: Rule }>> = {
  xMin: { label: 'Margin left (-X)', rule: 'nonNegative' },
  xMax: { label: 'Margin right (+X)', rule: 'nonNegative' },
  yMin: { label: 'Margin front (-Y)', rule: 'nonNegative' },
  yMax: { label: 'Margin back (+Y)', rule: 'nonNegative' },
  top: { label: 'Margin above', rule: 'nonNegative' },
  bottom: { label: 'Margin below', rule: 'nonNegative' },
  sizeX: { label: 'Stock X', rule: 'positive' },
  sizeY: { label: 'Stock Y', rule: 'positive' },
  sizeZ: { label: 'Stock thickness (Z)', rule: 'positive' },
  offsetX: { label: 'Part in from the left', rule: 'nonNegative' },
  offsetY: { label: 'Part in from the front', rule: 'nonNegative' },
  offsetZ: { label: 'Part up from the bottom', rule: 'nonNegative' },
  clearance: { label: 'Clearance height', rule: 'positive' },
  retract: { label: 'Retract height', rule: 'positive' },
};

export const MARGIN_KEYS = ['xMin', 'xMax', 'yMin', 'yMax', 'top', 'bottom'] as const;
export const SIZE_KEYS = ['sizeX', 'sizeY', 'sizeZ', 'offsetX', 'offsetY', 'offsetZ'] as const;

/** The stock and heights as stored expressions, by draft key. */
export function storedFields(setup: CamSetup): Partial<Record<StockKey, StoredExpression>> {
  const out: Partial<Record<StockKey, StoredExpression>> = {
    clearance: setup.heights.clearance,
    retract: setup.heights.retract,
  };
  const s = setup.stock;
  if (s.kind === 'fromBody') for (const k of MARGIN_KEYS) out[k] = s.margins[k];
  else {
    out.sizeX = s.size.x;
    out.sizeY = s.size.y;
    out.sizeZ = s.size.z;
    out.offsetX = s.offset.x;
    out.offsetY = s.offset.y;
    out.offsetZ = s.offset.z;
  }
  return out;
}

/**
 * Check the stock and heights drafts and build the `editCamSetup` changes, or the errors by key.
 * The retract height must not be above the clearance height.
 */
export function buildStockAndHeights(
  setup: CamSetup,
  kind: CamStock['kind'],
  drafts: Readonly<Record<StockKey, string>>,
  doc: ManufaktureDocument,
  variables: Variables,
): { ok: true; changes: SetupChanges } | { ok: false; errors: Record<string, string> } {
  const units = doc.units;
  const before = storedFields(setup);
  const errors: Record<string, string> = {};
  const values: Partial<Record<StockKey, { stored: StoredExpression; value: number }>> = {};
  const keys: readonly StockKey[] = [
    ...(kind === 'fromBody' ? MARGIN_KEYS : SIZE_KEYS),
    'clearance',
    'retract',
  ];
  for (const k of keys) {
    const r = checkField(drafts[k], 'length', STOCK_FIELDS[k].rule, units, variables);
    if (!r.ok) errors[k] = r.message;
    else if (!r.empty)
      values[k] = { stored: storedOf(drafts[k], units, before[k]), value: r.value };
  }
  const c = values.clearance?.value;
  const rv = values.retract?.value;
  if (c !== undefined && rv !== undefined && rv > c) {
    errors.retract = 'The retract height must not be above the clearance height.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const v = (k: StockKey) => values[k]!.stored;
  const material = setup.stock.material !== undefined ? { material: setup.stock.material } : {};
  const stock: CamStock =
    kind === 'fromBody'
      ? {
          kind: 'fromBody',
          margins: {
            xMin: v('xMin'),
            xMax: v('xMax'),
            yMin: v('yMin'),
            yMax: v('yMax'),
            top: v('top'),
            bottom: v('bottom'),
          },
          ...material,
        }
      : {
          kind: 'explicit',
          size: { x: v('sizeX'), y: v('sizeY'), z: v('sizeZ') },
          offset: { x: v('offsetX'), y: v('offsetY'), z: v('offsetZ') },
          ...material,
        };
  return {
    ok: true,
    changes: { stock, heights: { clearance: v('clearance'), retract: v('retract') } },
  };
}
