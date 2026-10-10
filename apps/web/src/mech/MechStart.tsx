// The Mechanical toolbar group and its first-run prompt (ADR 0017 decision 6). Starting the
// mechanical domain asks for a strength factor on yield and a fatigue factor, both optional and
// never prefilled; once started, the same dialog changes them. The notice (decision 17) is shown
// in the dialog. Later M9 tasks add the mechanical panels to this group.

import {
  DISCLAIMER_SHORT,
  mechSettings,
  mechStarted,
  setFactorsCommand,
} from '@manufakture/domain-mech';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { factorField, parseFactors } from './factors';
import './mech.css';

export function MechStartDialog({
  documents,
  onClose,
}: {
  documents: DocumentStoreApi;
  onClose: () => void;
}) {
  const domains = useStore(documents, (s) => s.document.domains);
  const started = mechStarted(domains);
  const settings = mechSettings(domains);
  const factors = settings.ok ? settings.value.factors : {};
  const [strength, setStrength] = useState(() => factorField(factors.strength));
  const [fatigue, setFatigue] = useState(() => factorField(factors.fatigue));
  const [error, setError] = useState<string | null>(settings.ok ? null : settings.message);

  const save = () => {
    const parsed = parseFactors(strength, fatigue);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const r = setFactorsCommand(documents.getState().document.domains, parsed.value);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const label = started ? 'Safety factors' : 'Start mechanical design';
    const done = documents.getState().execute(r.command, label);
    if (!done.ok) {
      setError(done.error.message);
      return;
    }
    onClose();
  };

  return (
    <div className="mech-start-backdrop">
      <section
        className="mech-start"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mech-start-title"
        data-testid="mech-start-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="mech-start-title">{started ? 'Safety factors' : 'Start mechanical design'}</h2>
        <p className="field-note" data-testid="mech-disclaimer">
          {DISCLAIMER_SHORT}
        </p>
        <p className="field-note">
          Strength and life checks report the factor they reach against the factors you set here.
          Both are optional and nothing is filled in for you: a check without a factor shows its
          factor with nothing to compare it to.
        </p>
        <label className="dialog-field">
          <span>Strength factor on yield</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="mech-factor-strength"
            value={strength}
            placeholder="not set"
            onChange={(e) => setStrength(e.target.value)}
          />
        </label>
        <label className="dialog-field">
          <span>Fatigue factor</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="mech-factor-fatigue"
            value={fatigue}
            placeholder="not set"
            onChange={(e) => setFatigue(e.target.value)}
          />
        </label>
        {error !== null && (
          <p className="text-error" role="alert" data-testid="mech-start-error">
            {error}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" data-testid="mech-start-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" data-testid="mech-start-save" onClick={save}>
            {started ? 'Save' : 'Start'}
          </button>
        </div>
      </section>
    </div>
  );
}

/** The Mechanical group of the part studio's toolbar. */
export function MechToolbar({
  documents,
  disabled,
}: {
  documents: DocumentStoreApi;
  disabled: boolean;
}) {
  const started = useStore(documents, (s) => mechStarted(s.document.domains));
  const [open, setOpen] = useState(false);
  return (
    <div className="toolbar-group mech-toolbar" role="toolbar" aria-label="Mechanical">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="mech-open"
        title={
          started
            ? 'Mechanical design: your safety factors'
            : 'Start mechanical design: asks for your safety factors, both optional'
        }
        onClick={() => setOpen(true)}
      >
        Mechanical
      </button>
      {open && <MechStartDialog documents={documents} onClose={() => setOpen(false)} />}
    </div>
  );
}
