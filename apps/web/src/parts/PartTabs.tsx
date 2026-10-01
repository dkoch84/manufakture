// The tabs along the bottom of the editor: one tab per part studio, in document order, then one
// per assembly. A click makes a tab active; the buttons add a part studio or an assembly, and
// rename, duplicate (part studios) or delete the active one; a double click renames too, and
// dragging a part studio tab (or Alt+Left and Alt+Right) moves it. Every change is one undoable
// command.

import { PART_COUNTER, previewIds, type Command } from '@manufakture/core';
import { addAssemblyCommand } from '../assembly/assembly';
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { PART_STUDIO_PANEL_ID, newPartName } from './names';

export interface PartTabsProps {
  documents: DocumentStoreApi;
  /** No switching or changes while something else edits the part (a sketch, a dialog). */
  disabled?: boolean;
  /**
   * Switching tabs only: no adding, renaming, moving, duplicating or deleting (a past version
   * shown read-only).
   */
  readOnly?: boolean;
}

/** The key of a tab's element: part ids and assembly ids could in theory meet. */
function tabKey(tab: { kind: string; id: string }): string {
  return `${tab.kind}:${tab.id}`;
}

/** A tab: a part studio or an assembly. */
interface Tab {
  kind: 'part' | 'assembly';
  id: string;
  name: string;
}

interface Renaming {
  kind: Tab['kind'];
  id: string;
  text: string;
}

export function PartTabs({ documents, disabled = false, readOnly = false }: PartTabsProps) {
  const parts = useStore(documents, (s) => s.document.parts);
  const assemblies = useStore(documents, (s) => s.document.assemblies);
  const activePartId = useStore(documents, (s) => s.activePartId);
  const activeAssemblyId = useStore(documents, (s) => s.activeAssemblyId);
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenamingState] = useState<Renaming | null>(null);
  // Read by `commitRename`: Enter and the blur that follows it must record one rename.
  const renamingRef = useRef<Renaming | null>(null);
  const setRenaming = (next: Renaming | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabs: Tab[] = [
    ...parts.map((p) => ({ kind: 'part' as const, id: p.id, name: p.name })),
    ...assemblies.map((a) => ({ kind: 'assembly' as const, id: a.id, name: a.name })),
  ];
  const activeTab: Tab | undefined =
    activeAssemblyId !== null
      ? tabs.find((t) => t.kind === 'assembly' && t.id === activeAssemblyId)
      : tabs.find((t) => t.kind === 'part' && t.id === activePartId);
  const isActive = (t: Tab) => t === activeTab;
  const active = activeTab?.kind === 'part' ? parts.find((p) => p.id === activeTab.id) : undefined;
  const renamingTab = renaming
    ? tabs.find((t) => t.kind === renaming.kind && t.id === renaming.id)
    : undefined;

  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  const activate = (tab: Tab) => {
    if (disabled) return;
    if (tab.kind === 'part') documents.getState().setActivePart(tab.id);
    else documents.getState().setActiveAssembly(tab.id);
    setMessage(null);
  };

  const addAssembly = () => {
    const { command, label } = addAssemblyCommand(documents.getState().document);
    run(command, label);
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
    if (activeTab?.kind === 'assembly') {
      run({ type: 'deleteAssembly', assemblyId: activeTab.id }, `Delete ${activeTab.name}`);
      return;
    }
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
    const doc = documents.getState().document;
    const text = current.text.trim();
    if (current.kind === 'assembly') {
      const assembly = doc.assemblies.find((a) => a.id === current.id);
      if (!assembly || text === assembly.name) return;
      run(
        { type: 'renameAssembly', assemblyId: assembly.id, name: current.text },
        `Rename ${assembly.name} to ${text}`,
      );
      return;
    }
    const part = doc.parts.find((p) => p.id === current.id);
    if (!part || text === part.name) return;
    run(
      { type: 'renamePart', partId: part.id, name: current.text },
      `Rename ${part.name} to ${text}`,
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, tab: Tab, index: number) => {
    if (disabled) return;
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      if (e.altKey) {
        // Only part studios move.
        if (readOnly || tab.kind !== 'part') return;
        move(tab.id, index + step);
        return;
      }
      const next = tabs[index + step];
      if (!next) return;
      activate(next);
      tabRefs.current.get(tabKey(next))?.focus();
    } else if (e.key === 'F2' && !readOnly) {
      e.preventDefault();
      setRenaming({ kind: tab.kind, id: tab.id, text: tab.name });
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
          const tab = tabs[index]!;
          const selected = isActive(tab);
          const classes = ['part-tab'];
          if (selected) classes.push('active');
          if (dragged === part.id) classes.push('dragged');
          if (dropAt === part.id && dragged !== part.id) classes.push('drop-target');
          return (
            <button
              key={part.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tabKey(tab), el);
                else tabRefs.current.delete(tabKey(tab));
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
              title={readOnly ? part.name : `${part.name}: double-click to rename, drag to move`}
              draggable={!disabled && !readOnly}
              onClick={() => activate(tab)}
              onDoubleClick={() => {
                if (!disabled && !readOnly) {
                  setRenaming({ kind: 'part', id: part.id, text: part.name });
                }
              }}
              onKeyDown={(e) => onKeyDown(e, tab, index)}
              onDragStart={(e) => {
                if (readOnly) return;
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
        {assemblies.map((assembly, i) => {
          const index = parts.length + i;
          const tab = tabs[index]!;
          const selected = isActive(tab);
          return (
            <button
              key={assembly.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tabKey(tab), el);
                else tabRefs.current.delete(tabKey(tab));
              }}
              type="button"
              role="tab"
              id={`assembly-tab-${assembly.id}`}
              className={selected ? 'part-tab assembly-tab active' : 'part-tab assembly-tab'}
              aria-selected={selected}
              aria-controls={PART_STUDIO_PANEL_ID}
              tabIndex={selected ? 0 : -1}
              disabled={disabled && !selected}
              data-testid={`assembly-tab-${assembly.id}`}
              title={readOnly ? assembly.name : `${assembly.name}: double-click to rename`}
              onClick={() => activate(tab)}
              onDoubleClick={() => {
                if (!disabled && !readOnly) {
                  setRenaming({ kind: 'assembly', id: assembly.id, text: assembly.name });
                }
              }}
              onKeyDown={(e) => onKeyDown(e, tab, index)}
            >
              <span className="assembly-tab-icon" aria-hidden="true">
                {'\u29c9 '}
              </span>
              {assembly.name}
            </button>
          );
        })}
      </div>
      {/* Outside the tab list, which holds tabs only. */}
      {renamingTab && renaming && (
        <input
          className="part-tab-rename"
          aria-label={`Rename ${renamingTab.name}`}
          data-testid="part-rename-input"
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
            onClick={add}
            data-testid="part-add"
            title="Add a part studio"
            aria-label="Add a part studio"
          >
            +
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={addAssembly}
            data-testid="assembly-add"
            title="Add an assembly: instances of part studios, placed by mates"
          >
            + Assembly
          </button>
          <button
            type="button"
            disabled={disabled || !activeTab}
            onClick={() =>
              activeTab &&
              setRenaming({ kind: activeTab.kind, id: activeTab.id, text: activeTab.name })
            }
            data-testid="part-rename"
          >
            Rename
          </button>
          <button
            type="button"
            disabled={disabled || !active}
            onClick={duplicate}
            data-testid="part-duplicate"
            title={
              activeTab?.kind === 'assembly' ? 'Only part studios can be duplicated' : undefined
            }
          >
            Duplicate
          </button>
          <button
            type="button"
            disabled={disabled || (activeTab?.kind !== 'assembly' && parts.length < 2)}
            onClick={remove}
            data-testid="part-delete"
            title={
              activeTab?.kind !== 'assembly' && parts.length < 2
                ? 'A document keeps at least one part studio'
                : undefined
            }
          >
            Delete
          </button>
        </div>
      )}
      {message && (
        <span className="part-tabs-error" role="alert" data-testid="part-tabs-error">
          {message}
        </span>
      )}
    </nav>
  );
}
