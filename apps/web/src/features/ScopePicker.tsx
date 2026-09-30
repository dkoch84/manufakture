// The Bodies field of a feature dialog: which bodies a feature acts on. **All bodies** (the
// default) stores no scope, so the feature acts on every body there is at that point, including
// ones added later above it; unticking it lists the bodies to choose from.

import type { ScopeBody } from './forms';

export interface ScopePickerProps {
  /** The bodies there are before the feature, in body order. */
  bodies: readonly ScopeBody[];
  /** The chosen bodies; undefined for every body. */
  scope: readonly string[] | undefined;
  error?: string | undefined;
  disabled?: boolean;
  onChange: (scope: readonly string[] | undefined) => void;
}

export function ScopePicker({
  bodies,
  scope,
  error,
  disabled = false,
  onChange,
}: ScopePickerProps) {
  const all = scope === undefined;
  return (
    <fieldset className="dialog-field checks scope-field" data-testid="field-scope">
      <legend>Bodies</legend>
      <label className="dialog-check">
        <input
          type="checkbox"
          checked={all}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? undefined : bodies.map((b) => b.bodyId))}
        />
        All bodies
      </label>
      {!all &&
        bodies.map((b) => (
          <label key={b.bodyId} className="dialog-check scope-body">
            <input
              type="checkbox"
              checked={scope.includes(b.bodyId)}
              disabled={disabled}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? bodies
                        .map((x) => x.bodyId)
                        .filter((id) => id === b.bodyId || scope.includes(id))
                    : scope.filter((id) => id !== b.bodyId),
                )
              }
            />
            {b.name}
          </label>
        ))}
      {error && <span className="field-error">{error}</span>}
    </fieldset>
  );
}
