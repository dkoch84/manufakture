// The part studio tabs along the bottom of the editor: one tab per part studio, in document
// order. A click makes a tab active; the buttons add a part studio, and rename, duplicate or
// delete the active one; a double click renames too, and dragging a tab (or Alt+Left and
// Alt+Right) moves it. Every change is one undoable command.

import { PART_COUNTER, previewIds, type Command } from '@manufakture/core';
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { PART_STUDIO_PANEL_ID, newPartName } from './names';

export interface PartTabsProps {
  documents: DocumentStoreApi;
  /** No switching or changes while something else edits the part (a sketch, a dialog). */
  disabled?: boolean;
}

export function PartTabs({ documents, disabled = false }: PartTabsProps) {
  const parts = useStore(documents, (s) => s.document.parts);
  const activePartId = useStore(documents, (s) => s.activePartId);
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenamingState] = useState<{ id: string; text: string } | null>(null);
  // Read by `commitRename`: Enter and the blur that follows it must record one rename.
  const renamingRef = useRef<{ id: string; text: string } | null>(null);
  const setRenaming = (next: { id: string; text: string } | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const active = parts.find((p) => p.id === activePartId);
  const renamingPart = renaming ? parts.find((p) => p.id === renaming.id) : undefined;

  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  const activate = (id: string) => {
    if (disabled) return;
    documents.getState().setActivePart(id);
    setMessage(null);
  };

  const add = () => {
    const [id] = previewIds(documents.getState().document.nextIds, PART_COUNTER);
    const name = newPartName(id!);
    run({ type: 'addPart', partId: id!, name }, `Add ${name}`);
  };

  const duplicate = () => {
    if (!active) return;
    const [id] = previewIds(documents.getState().document.nextIds, PART_COUNTER);
    run(
      { type: 'duplicatePart', sourcePartId: active.id, partId: id!, name: `${active.name} copy` },
      `Duplicate ${active.name}`,
    );
  };

  const remove = () => {
    if (!active) return;
    run({ type: 'deletePart', partId: active.id }, `Delete ${active.name}`);
  };

  const move = (id: string, index: number) => {
    const from = parts.findIndex((p) => p.id === id);
    if (from < 0 || index < 0 || index >= parts.length || index === from) return;
    const name = parts[from]!.name;
    run({ type: 'reorderParts', partId: id, index }, `Move ${name}`);
  };

  const commitRename = () => {
    const current = renamingRef.current;
    if (!current) return;
    setRenaming(null);
    const part = documents.getState().document.parts.find((p) => p.id === current.id);
    if (!part || current.text.trim() === part.name) return;
    run(
      { type: 'renamePart', partId: part.id, name: current.text },
      `Rename ${part.name} to ${current.text.trim()}`,
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string, index: number) => {
    if (disabled) return;
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      if (e.altKey) {
        move(id, index + step);
        return;
      }
      const next = parts[index + step];
      if (!next) return;
      activate(next.id);
      tabRefs.current.get(next.id)?.focus();
    } else if (e.key === 'F2') {
      e.preventDefault();
      const part = parts[index]!;
      setRenaming({ id: part.id, text: part.name });
    }
  };

  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    const id = dragged;
    setDragged(null);
    setDropAt(null);
    if (id === null || id === targetId) return;
    move(
      id,
      parts.findIndex((p) => p.id === targetId),
    );
  };

  return (
    <nav className="part-tabs" aria-label="Part studios">
      <div className="part-tab-list" role="tablist" aria-label="Part studios">
        {parts.map((part, index) => {
          const selected = part.id === activePartId;
          const classes = ['part-tab'];
          if (selected) classes.push('active');
          if (dragged === part.id) classes.push('dragged');
          if (dropAt === part.id && dragged !== part.id) classes.push('drop-target');
          return (
            <button
              key={part.id}
              ref={(el) => {
                if (el) tabRefs.current.set(part.id, el);
                else tabRefs.current.delete(part.id);
              }}
              type="button"
              role="tab"
              id={`part-tab-${part.id}`}
              className={classes.join(' ')}
              aria-selected={selected}
              aria-controls={PART_STUDIO_PANEL_ID}
              tabIndex={selected ? 0 : -1}
              disabled={disabled && !selected}
              data-testid={`part-tab-${part.id}`}
              title={`${part.name}: double-click to rename, drag to move`}
              draggable={!disabled}
              onClick={() => activate(part.id)}
              onDoubleClick={() => {
                if (!disabled) setRenaming({ id: part.id, text: part.name });
              }}
              onKeyDown={(e) => onKeyDown(e, part.id, index)}
              onDragStart={(e) => {
                setDragged(part.id);
                e.dataTransfer?.setData('text/plain', part.id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                setDragged(null);
                setDropAt(null);
              }}
              onDragOver={(e) => {
                if (dragged === null) return;
                e.preventDefault();
                if (dropAt !== part.id) setDropAt(part.id);
              }}
              onDrop={(e) => onDrop(e, part.id)}
            >
              {part.name}
            </button>
          );
        })}
      </div>
      {/* Outside the tab list, which holds tabs only. */}
      {renamingPart && renaming && (
        <input
          className="part-tab-rename"
          aria-label={`Rename ${renamingPart.name}`}
          data-testid="part-rename-input"
          value={renaming.text}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setRenaming({ id: renaming.id, text: e.currentTarget.value })}
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
      <div className="part-tab-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={add}
          data-testid="part-add"
          title="Add a part studio"
          aria-label="Add a part studio"
        >
          +
        </button>
        <button
          type="button"
          disabled={disabled || !active}
          onClick={() => active && setRenaming({ id: active.id, text: active.name })}
          data-testid="part-rename"
        >
          Rename
        </button>
        <button
          type="button"
          disabled={disabled || !active}
          onClick={duplicate}
          data-testid="part-duplicate"
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={disabled || parts.length < 2}
          onClick={remove}
          data-testid="part-delete"
          title={parts.length < 2 ? 'A document keeps at least one part studio' : undefined}
        >
          Delete
        </button>
      </div>
      {message && (
        <span className="part-tabs-error" role="alert" data-testid="part-tabs-error">
          {message}
        </span>
      )}
    </nav>
  );
}
