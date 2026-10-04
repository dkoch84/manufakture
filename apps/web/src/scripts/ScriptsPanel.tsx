// The Scripts panel: the document's script library (ADR 0010 decision 8). Each script shows its
// name, language and how many scripted features run it; **Edit** opens it in the script editor,
// **New script** opens the editor on a new one (saved only with Save), **Delete** removes one no
// feature runs. The setting **Run scripts in documents automatically** lives here too (policy.ts).

import { scriptUsers } from '@manufakture/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { usersText } from './library';
import type { ScriptGrantsStore } from './policy';
import './scripts.css';

export interface ScriptsPanelProps {
  documents: DocumentStoreApi;
  grants: ScriptGrantsStore;
  /** Open the editor on a script, or on a new one (null). */
  onEdit: (scriptId: string | null) => void;
  disabled?: boolean;
}

export function ScriptsPanel({ documents, grants, onEdit, disabled = false }: ScriptsPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const auto = useStore(grants, (s) => s.auto());
  const autoAvailable = useStore(grants, (s) => s.autoAvailable);
  const [message, setMessage] = useState<string | null>(null);
  const scripts = doc.scripts ?? [];

  const remove = (scriptId: string, name: string) => {
    const done = documents
      .getState()
      .execute({ type: 'deleteScript', scriptId }, `Delete script ${name}`);
    setMessage(done.ok ? null : done.error.message);
  };

  return (
    <aside className="selection-panel scripts-panel" aria-label="Scripts">
      <div className="scripts-head">
        <h2>Scripts</h2>
        <button
          type="button"
          data-testid="script-new"
          disabled={disabled}
          title="Write a script: a feature computed by your own JavaScript or TypeScript"
          onClick={() => onEdit(null)}
        >
          New script
        </button>
      </div>
      {scripts.length === 0 ? (
        <p className="field-note">
          No scripts. A script computes a feature from parameters, in JavaScript or TypeScript.
        </p>
      ) : (
        <ul className="script-list" data-testid="script-list">
          {scripts.map((s) => (
            <li key={s.id} className="script-item" data-testid={`script-${s.id}`}>
              <div className="script-main">
                <span className="script-name">{s.name}</span>
                <span className="badge" title={`Script API version ${s.apiVersion}`}>
                  {s.language === 'ts' ? 'TypeScript' : 'JavaScript'}
                </span>
              </div>
              <p className="script-users">{usersText(doc, s.id)}</p>
              <div className="script-actions">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Edit script ${s.name}`}
                  onClick={() => onEdit(s.id)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={disabled || scriptUsers(doc, s.id).length > 0}
                  aria-label={`Delete script ${s.name}`}
                  title={
                    scriptUsers(doc, s.id).length > 0
                      ? 'Features run it: change or delete those first'
                      : 'Delete the script'
                  }
                  onClick={() => remove(s.id, s.name)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
      <label className="dialog-check script-auto">
        <input
          type="checkbox"
          data-testid="scripts-auto"
          checked={auto}
          disabled={!autoAvailable}
          aria-describedby={autoAvailable ? undefined : 'scripts-auto-locked'}
          onChange={(e) => grants.getState().setAuto(e.target.checked)}
        />
        Run scripts in documents automatically
      </label>
      {!autoAvailable && (
        <p className="field-note" id="scripts-auto-locked" data-testid="scripts-auto-locked">
          Not available until the script sandbox has passed its security review. Until then, a
          document&apos;s scripts run only after you choose Run scripts for it.
        </p>
      )}
    </aside>
  );
}
