// Fields the feature dialogs share: a reference field (faces or edges picked in the viewport), a
// select and a check box. Apart from FeatureDialog.tsx so the scripted feature's dialog can use
// them too.

import type { RefField } from './forms';

export function RefFieldView({
  field,
  refs,
  active,
  error,
  onActivate,
  onRemove,
}: {
  field: RefField;
  refs: readonly { label: string; lost?: boolean }[];
  active: boolean;
  error: string | undefined;
  onActivate: () => void;
  onRemove: (index: number) => void;
}) {
  const what = field.accepts.map((k) => (field.max === 1 ? `a ${k}` : `${k}s`)).join(' or ');
  return (
    <fieldset
      className={`dialog-field ref-field${active ? ' active' : ''}`}
      data-testid={`ref-${field.key}`}
      onClick={onActivate}
    >
      <legend>{field.label}</legend>
      <button type="button" aria-pressed={active} onClick={onActivate}>
        {active ? `Picking: click ${what} in the view` : `Pick ${what}`}
      </button>
      {refs.length > 0 && (
        <ul>
          {refs.map((r, i) => (
            <li key={`${r.label}/${i}`} className={r.lost ? 'lost' : undefined}>
              <span title={r.label}>
                {r.lost ? `${r.label} (not found: pick it again)` : r.label}
              </span>
              <button
                type="button"
                aria-label={`Remove ${r.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(i);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="field-error">{error}</span>}
    </fieldset>
  );
}

export function Select({
  label,
  name,
  value,
  options,
  error,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  options: readonly (readonly [string, string])[];
  error?: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="dialog-field">
      <label>
        {label}
        <select
          value={value}
          data-testid={`field-${name}`}
          aria-invalid={error !== undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="dialog-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
