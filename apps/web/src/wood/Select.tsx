// A labelled select for the woodworking dialogs (Board, Joint), with its error under it, styled
// as the feature dialogs' fields (features.css).

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
