// The configuration row a derived part or an assembly instance is built in (T2.4c): a choice of
// the source document's rows, with **Default** first (the row the source has active, or the
// document as it is). Shown only when the source has rows, or a row is already named (which then
// stays listed, marked missing, until another is chosen).

import { useId } from 'react';
import type { RowChoice } from './derived';

export interface ConfigurationPickerProps {
  rows: readonly RowChoice[];
  /** The row named; undefined: the default. */
  value: string | undefined;
  /** What the default shows, from `defaultRowLabel`. */
  defaultLabel: string;
  onChange: (row: string | undefined) => void;
  label?: string;
  testId?: string;
  disabled?: boolean;
}

/** The option value of the default (no row ids look like it). */
const DEFAULT = '';

export function ConfigurationPicker({
  rows,
  value,
  defaultLabel,
  onChange,
  label = 'Configuration',
  testId = 'field-configuration',
  disabled = false,
}: ConfigurationPickerProps) {
  const id = useId();
  if (rows.length === 0 && value === undefined) return null;
  const missing = value !== undefined && !rows.some((r) => r.id === value);
  return (
    <div className="dialog-field configuration-picker">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? DEFAULT}
        data-testid={testId}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === DEFAULT ? undefined : e.target.value)}
      >
        <option value={DEFAULT}>{defaultLabel}</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
        {missing && <option value={value}>{`${value} (not in the source)`}</option>}
      </select>
    </div>
  );
}
