// The stock picker: the catalog of one region at a time, grouped by kind (sheet goods, lumber),
// each entry with its nominal and actual sizes in the document's display units. It opens on the
// region the document's units suggest (inch and foot documents US stock, the rest metric); the
// other region is one click away. Which region is shown is not stored anywhere.

import type { DisplayUnits } from '@manufakture/core';
import { findStock, type BoardParams, type StockRegion } from '@manufakture/domain-wood';
import { useState } from 'react';
import { REGION_LABELS, documentRegion, stockGroups, stockLabel } from './catalog';

export interface StockPickerProps {
  value: string;
  units: DisplayUnits;
  /** Sticks are cut from lumber only; without a form every stock is offered. */
  form?: BoardParams['form'];
  /** Offer one kind of stock only (construction: studs from lumber, layers from sheets). */
  only?: 'lumber' | 'sheet' | undefined;
  label?: string;
  testId?: string;
  error?: string | undefined;
  onChange: (stockId: string) => void;
}

const REGIONS: readonly StockRegion[] = ['us', 'metric'];

export function StockPicker({
  value,
  units,
  form = 'panel',
  only,
  label = 'Stock',
  testId = 'field-stock',
  error,
  onChange,
}: StockPickerProps) {
  const chosen = findStock(value);
  // The chosen stock's region when there is one (an edited board), else the units'.
  const [region, setRegion] = useState<StockRegion>(() => chosen?.region ?? documentRegion(units));
  const groups = stockGroups(region, form, only);
  const inRegion = groups.some((g) => g.entries.some((e) => e.id === value));
  return (
    <div className="dialog-field stock-picker">
      <div className="stock-regions" role="group" aria-label="Stock sizes">
        {REGIONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={region === r}
            data-testid={`stock-region-${r}`}
            onClick={() => setRegion(r)}
          >
            {REGION_LABELS[r]}
          </button>
        ))}
      </div>
      <label>
        {label}
        <select
          value={inRegion ? value : ''}
          data-testid={testId}
          aria-invalid={error !== undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          {!inRegion && (
            <option value="" disabled>
              {chosen
                ? `${stockLabel(chosen, units)}: in ${REGION_LABELS[chosen.region]}`
                : 'Choose a stock'}
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {stockLabel(e, units)}
                  {e.verified.actual ? '' : ' (unverified)'}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {chosen && !chosen.verified.actual && (
        <span className="field-note" data-testid="stock-unverified">
          Typical size, not checked against its source ({chosen.source.actual}). Measure your stock
          and set its thickness in the Stock panel.
        </span>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
