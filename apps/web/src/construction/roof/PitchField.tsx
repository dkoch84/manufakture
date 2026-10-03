// The roof pitch field: a slope field (ADR 0005 as amended by T6.0b). It takes `6/12`, `6:12`,
// degrees (`30deg`, `30°`) and percent (`25%`), refuses a bare number as ambiguous with the
// parser's message, and shows the pitch back under it as `p/12` and degrees while it is typed.

import type { DisplayUnits } from '@manufakture/core';
import type { Variables } from '../../sketcher/values';
import { checkPitch, pitchSummary } from './pitch';

export function PitchField({
  value,
  units,
  variables,
  error,
  testId = 'roof-pitch',
  onChange,
}: {
  value: string;
  units: DisplayUnits;
  variables?: Variables;
  /** An error from the last OK, shown until the text changes. */
  error?: string | undefined;
  testId?: string;
  onChange: (value: string) => void;
}) {
  const r = value.trim() === '' ? null : checkPitch(value, units, variables);
  const message = error ?? (r && !r.ok ? r.message : undefined);
  return (
    <div className="dialog-field">
      <label>
        Pitch
        <input
          type="text"
          value={value}
          maxLength={200}
          placeholder="6/12"
          data-testid={testId}
          aria-invalid={message !== undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {r?.ok && (
        <span className="field-note" data-testid={`${testId}-shown`}>
          {pitchSummary(r.value)}
        </span>
      )}
      {message !== undefined && (
        <span className="field-error" data-testid={`${testId}-error`}>
          {message}
        </span>
      )}
      <span className="field-note">
        Rise in 12 (6/12 or 6:12), degrees (30deg) or percent (25%).
      </span>
    </div>
  );
}
