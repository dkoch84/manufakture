// The shared numeric input: every feature dialog field, the sketch dimension box and the variables
// table use it. It takes an expression with units (`12`, `1/4"`, `2*#t + 1`), shows what it
// evaluates to in the document's display units, points at what is wrong (unknown variable, wrong
// kind of value, a syntax error with its range highlighted), and completes `#` variable names.
//
// The completion list follows the ARIA combobox pattern: the input is the combobox, the list a
// listbox. Typing `#` opens it (a name typed in full, with no other match, leaves it closed); ArrowDown and ArrowUp move through it, Enter or Tab insert the
// active name, Escape closes it. While the list is open those keys are the list's and do not
// reach the surrounding dialog (so Enter does not apply it and Escape does not close it); while
// it is closed they go to `onKeyDown` as usual.

import type { DisplayUnits } from '@manufakture/core';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import type { Variables } from '../sketcher/values';
import {
  analyzeExpression,
  applyCompletion,
  completionToken,
  formatQuantity,
  highlightParts,
  matchingNames,
  moveActive,
  worthOffering,
  type Analysis,
  type FieldKind,
} from './expression';
import './components.css';

export interface ExpressionFieldProps {
  value: string;
  onChange: (value: string) => void;
  kind: FieldKind;
  units: DisplayUnits;
  /** Evaluated variables, by name without the `#`. */
  variables: Variables;
  /** Names offered by the completion list, in order (default: the evaluated ones). */
  names?: readonly string[] | undefined;
  /** A visible label; without it give `ariaLabel`. */
  label?: string;
  ariaLabel?: string;
  /** An error from outside (the last attempt to apply), shown instead of the live check. */
  error?: string | undefined;
  /** An extra check of the value; returns what is wrong, or null. */
  validate?: ((value: number) => string | null) | undefined;
  /** `field`: a dialog field with its note under it. `compact`: the sketch's dimension box. */
  variant?: 'field' | 'compact';
  testId?: string;
  /** Test ids of the note while it shows an error, and while it shows the value. */
  errorTestId?: string;
  previewTestId?: string;
  autoFocus?: boolean;
  selectOnFocus?: boolean;
  /** Keys the completion list does not take. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>, analysis: Analysis) => void;
}

export function ExpressionField({
  value,
  onChange,
  kind,
  units,
  variables,
  names,
  label,
  ariaLabel,
  error,
  validate,
  variant = 'field',
  testId,
  errorTestId,
  previewTestId,
  autoFocus,
  selectOnFocus,
  onKeyDown,
  onBlur,
}: ExpressionFieldProps) {
  const id = useId();
  const listId = `${id}-list`;
  const noteId = `${id}-note`;
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  // Where the caret goes after a completion is inserted (the value arrives on the next render).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !input.current) return;
    pendingCaret.current = null;
    input.current.setSelectionRange(at, at);
  });

  const analysis = analyzeExpression(value, kind, units, variables, validate);
  const token = caret === null ? null : completionToken(value, caret);
  const options = token ? matchingNames(names ?? Object.keys(variables), token.prefix) : [];
  const open = !dismissed && token !== null && worthOffering(options, token);
  const current = open ? Math.min(Math.max(active, 0), options.length - 1) : -1;

  const trackCaret = () => setCaret(input.current?.selectionStart ?? null);
  const choose = (name: string) => {
    if (!token) return;
    const next = applyCompletion(value, token, name);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    setDismissed(true);
    onChange(next.text);
  };

  const problem = error ?? (analysis.state === 'error' ? analysis.message : undefined);
  const highlight = error === undefined ? highlightParts(value, analysis) : null;
  const preview =
    analysis.state === 'ok' && analysis.formatted !== value.trim() ? `= ${analysis.formatted}` : '';
  const note = problem !== undefined ? 'error' : preview ? 'preview' : 'none';

  const field = (
    <div className={`expr${variant === 'compact' ? ' expr-compact' : ''}`}>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-label={label ? undefined : ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? `${id}-opt-${current}` : undefined}
        aria-invalid={problem !== undefined}
        aria-describedby={noteId}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        data-testid={testId}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          setDismissed(false);
          setActive(0);
          onChange(e.target.value);
        }}
        onSelect={trackCaret}
        onFocus={(e) => {
          if (selectOnFocus) e.currentTarget.select();
        }}
        onBlur={(e) => {
          setCaret(null);
          onBlur?.(e, analysis);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              setActive(moveActive(current, options.length, e.key));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              e.stopPropagation();
              choose(options[current]!);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      <ul
        id={listId}
        role="listbox"
        className="expr-options"
        aria-label="Variables"
        hidden={!open}
        data-testid={testId ? `${testId}-options` : undefined}
      >
        {open &&
          options.map((name, i) => {
            const q = variables[name];
            const shown = q === undefined ? null : formatQuantity(q, units);
            return (
              <li
                key={name}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === current}
                className={i === current ? 'active' : undefined}
                // Keep the focus (and the caret) in the input.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(name)}
              >
                <span className="expr-option-name">#{name}</span>
                {shown !== null && <span className="expr-option-value">{shown}</span>}
              </li>
            );
          })}
      </ul>
    </div>
  );

  const noteBody =
    note === 'error' ? (
      <>
        {problem}
        {highlight && (
          <code className="expr-source" aria-hidden="true">
            {highlight.before}
            <mark>{highlight.error}</mark>
            {highlight.after}
          </code>
        )}
      </>
    ) : (
      preview
    );
  const noteTestId =
    note === 'error'
      ? (errorTestId ?? (testId ? `${testId}-note` : undefined))
      : (previewTestId ?? (testId ? `${testId}-note` : undefined));

  if (variant === 'compact') {
    return (
      <>
        {field}
        {note !== 'none' && (
          <div
            id={noteId}
            className={note === 'error' ? 'sk-editor-error' : 'sk-editor-value'}
            role={note === 'error' ? 'alert' : undefined}
            data-testid={noteTestId}
          >
            {noteBody}
          </div>
        )}
      </>
    );
  }
  return (
    <div className="dialog-field">
      {label && <label htmlFor={id}>{label}</label>}
      {field}
      <span
        id={noteId}
        className={note === 'error' ? 'field-error' : 'field-preview'}
        data-testid={noteTestId}
      >
        {noteBody}
      </span>
    </div>
  );
}
