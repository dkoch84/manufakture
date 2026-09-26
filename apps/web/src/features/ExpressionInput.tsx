// A numeric field that takes an expression (`12`, `1/4"`, `2*#t + 1`), shows what it evaluates
// to in the document's units, and says what is wrong when it does not. The variables-aware input
// of T1.11 (#934) will replace this one.

import type { DisplayUnits } from '@manufakture/core';
import { useId } from 'react';
import { formatValue, type Variables } from '../sketcher/values';
import { checkExpression, type ValueKind } from './forms';

export interface ExpressionInputProps {
  label: string;
  /** The form field, for test ids and error lookup. */
  name: string;
  value: string;
  kind: ValueKind;
  units: DisplayUnits;
  variables: Variables;
  /** An error from the last attempt to apply the dialog. */
  error?: string | undefined;
  onChange: (value: string) => void;
}

export function ExpressionInput({
  label,
  name,
  value,
  kind,
  units,
  variables,
  error,
  onChange,
}: ExpressionInputProps) {
  const id = useId();
  const check = value.trim() === '' ? null : checkExpression(value, kind, units, variables);
  const problem = error ?? (check && !check.ok ? check.message : undefined);
  const preview =
    check && check.ok
      ? kind === 'number'
        ? String(check.value)
        : formatValue(check.value, kind, units)
      : null;
  return (
    <div className="dialog-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem !== undefined}
        aria-describedby={`${id}-note`}
        data-testid={`field-${name}`}
        onChange={(e) => onChange(e.target.value)}
      />
      <span
        id={`${id}-note`}
        className={problem ? 'field-error' : 'field-preview'}
        data-testid={`field-${name}-note`}
      >
        {problem ?? (preview !== null && preview !== value.trim() ? `= ${preview}` : '')}
      </span>
    </div>
  );
}
