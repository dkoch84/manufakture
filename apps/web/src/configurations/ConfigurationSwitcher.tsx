// The toolbar's configuration switcher: which row of the configuration table the document is
// built and shown in. Switching is one undo step (core's `setActiveConfiguration`). Shown only
// when the document has configurations.

import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { setActive } from './configurations';
import './configurations.css';

export interface ConfigurationSwitcherProps {
  documents: DocumentStoreApi;
  disabled?: boolean;
}

export function ConfigurationSwitcher({ documents, disabled = false }: ConfigurationSwitcherProps) {
  const table = useStore(documents, (s) => s.document.configurations);
  const rows = table?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <label
      className="configuration-switcher"
      title="The configuration the part is built and shown in"
    >
      Configuration
      <select
        value={table?.active ?? ''}
        disabled={disabled}
        data-testid="configuration-switcher"
        onChange={(e) => {
          const edit = setActive(documents.getState().document, e.target.value || null);
          if (edit) documents.getState().execute(edit.command, edit.label);
        }}
      >
        <option value="">None (as modelled)</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}
