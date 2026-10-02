// The drawing tabs (M4 plan, T4.4g), next to the part studio and assembly tabs: one per drawing,
// in document order. A click opens the drawing over the part studio; `+ Drawing` opens the New
// drawing form; the open drawing can be renamed (double click, or Rename) and deleted. Every
// change is one undoable command.

import type { Command } from '@manufakture/core';
import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import type { DrawingUiStore } from './state';
import './drawing.css';

export interface DrawingTabsProps {
  documents: DocumentStoreApi;
  drawingUi: DrawingUiStore;
  /** No switching while something else edits the part (a sketch, a dialog). */
  disabled?: boolean;
  /** Switching only (a past version shown read-only). */
  readOnly?: boolean;
}

const NO_DRAWINGS: readonly never[] = [];

export function DrawingTabs({
  documents,
  drawingUi,
  disabled = false,
  readOnly = false,
}: DrawingTabsProps) {
  const drawings = useStore(documents, (s) => s.document.drawings) ?? NO_DRAWINGS;
  const openId = useStore(drawingUi, (s) => s.drawingId);
  const creating = useStore(drawingUi, (s) => s.creating);
  const [renaming, setRenamingState] = useState<{ id: string; text: string } | null>(null);
  const renamingRef = useRef<{ id: string; text: string } | null>(null);
  const setRenaming = (next: { id: string; text: string } | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };
  const [message, setMessage] = useState<string | null>(null);
  const open = drawings.find((d) => d.id === openId);

  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  const commitRename = () => {
    const current = renamingRef.current;
    if (!current) return;
    setRenaming(null);
    const drawing = documents.getState().document.drawings?.find((d) => d.id === current.id);
    const text = current.text.trim();
    if (!drawing || text === drawing.name) return;
    run(
      { type: 'renameDrawing', drawingId: drawing.id, name: current.text },
      `Rename ${drawing.name} to ${text}`,
    );
  };

  const remove = () => {
    if (!open) return;
    if (run({ type: 'deleteDrawing', drawingId: open.id }, `Delete ${open.name}`)) {
      drawingUi.getState().close();
    }
  };

  return (
    <nav className="drawing-tabs" aria-label="Drawings">
      <div className="part-tab-list" role="tablist" aria-label="Drawings">
        {drawings.map((d) => {
          const selected = d.id === openId;
          return (
            <button
              key={d.id}
              type="button"
              role="tab"
              id={`drawing-tab-${d.id}`}
              className={selected ? 'part-tab drawing-tab active' : 'part-tab drawing-tab'}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled && !selected}
              data-testid={`drawing-tab-${d.id}`}
              title={readOnly ? d.name : `${d.name}: double-click to rename`}
              onClick={() => {
                if (!disabled) drawingUi.getState().open(d.id);
              }}
              onDoubleClick={() => {
                if (!disabled && !readOnly) setRenaming({ id: d.id, text: d.name });
              }}
            >
              <span className="drawing-tab-icon" aria-hidden="true">
                {'□ '}
              </span>
              {d.name}
            </button>
          );
        })}
      </div>
      {renaming && (
        <input
          className="part-tab-rename"
          aria-label="Rename the drawing"
          data-testid="drawing-rename-input"
          value={renaming.text}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setRenaming({ ...renaming, text: e.currentTarget.value })}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenaming(null);
            }
          }}
        />
      )}
      {!readOnly && (
        <div className="part-tab-actions">
          <button
            type="button"
            disabled={disabled}
            aria-pressed={creating}
            data-testid="drawing-add"
            title="Add a drawing: sheets of views of a part studio or an assembly, dimensioned"
            onClick={() => drawingUi.getState().create()}
          >
            + Drawing
          </button>
          {open && (
            <>
              <button
                type="button"
                disabled={disabled}
                data-testid="drawing-rename"
                onClick={() => setRenaming({ id: open.id, text: open.name })}
              >
                Rename
              </button>
              <button
                type="button"
                disabled={disabled}
                data-testid="drawing-delete"
                title="Delete the drawing with its sheets"
                onClick={remove}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {message && (
        <span className="part-tabs-error" role="alert" data-testid="drawing-tabs-error">
          {message}
        </span>
      )}
    </nav>
  );
}
