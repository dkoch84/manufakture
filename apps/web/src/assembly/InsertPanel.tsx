// Insert (M2 plan, T2.3e): an instance of a part studio of this document, or of a part of another
// document at a named version, chosen with the derived part's pinned-part picker (T2.2c). The
// pin carries the version's document inside this one, so the instance still shows after the
// other document changes or is deleted. Each insert is one undoable command; the panel stays
// open for the next.

import { findPart, type DerivedSource } from '@manufakture/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { CreateVersion } from '../history/history';
import type { PinLibrary, PinnedPart } from '../features/derived';
import { PinnedPartPicker } from '../features/PinnedPartPicker';
import type { DocumentStoreApi } from '../state/document';
import { insertCommand } from './assembly';

export interface InsertPanelProps {
  documents: DocumentStoreApi;
  assemblyId: string;
  /** Other documents to insert from; without one only this document's part studios. */
  library?: PinLibrary | null;
  createVersion?: CreateVersion | null;
  onClose: () => void;
}

export function InsertPanel({
  documents,
  assemblyId,
  library = null,
  createVersion = null,
  onClose,
}: InsertPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const [pinned, setPinned] = useState<PinnedPart | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  if (!assembly) return null;

  const insert = (source: Parameters<typeof insertCommand>[1], name: string) => {
    const current = documents.getState().document.assemblies.find((a) => a.id === assemblyId);
    if (!current) return;
    const { command, label } = insertCommand(current, source, name);
    const r = documents.getState().execute(command, label);
    setMessage(
      r.ok
        ? { error: false, text: `${label.replace(/^Insert /, 'Inserted ')}.` }
        : { error: true, text: r.error.message },
    );
  };

  return (
    <aside
      className="selection-panel feature-dialog insert-panel"
      aria-label="Insert"
      data-testid="insert-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Insert</h2>
      <h3>Part studios of this document</h3>
      <ul className="insert-parts">
        {doc.parts.map((part) => (
          <li key={part.id}>
            <button
              type="button"
              data-testid={`insert-part-${part.id}`}
              onClick={() => insert({ part: part.id }, part.name)}
            >
              Insert {part.name}
            </button>
          </li>
        ))}
      </ul>
      {library && (
        <>
          <h3>A part of another document, at a version</h3>
          <PinnedPartPicker
            library={library}
            currentDocumentId={doc.id}
            createVersion={createVersion}
            onChange={setPinned}
          />
          <button
            type="button"
            className="primary"
            disabled={pinned === null}
            data-testid="insert-pinned"
            onClick={() => {
              if (!pinned) return;
              const source: DerivedSource = pinned.source;
              const name = findPart(pinned.document, source.partId)?.name ?? source.partId;
              insert(source, name);
            }}
          >
            {pinned
              ? `Insert ${findPart(pinned.document, pinned.source.partId)?.name ?? pinned.source.partId} at ${pinned.source.versionName}`
              : 'Insert'}
          </button>
        </>
      )}
      {message && (
        <p
          className={message.error ? 'field-error' : 'field-note'}
          role={message.error ? 'alert' : 'status'}
          data-testid="insert-message"
        >
          {message.text}
        </p>
      )}
      <div className="dialog-buttons">
        <button type="button" data-testid="insert-close" onClick={onClose}>
          Done
        </button>
      </div>
    </aside>
  );
}
