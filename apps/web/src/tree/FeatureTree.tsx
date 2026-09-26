// The feature tree (Onshape style): the part's features in regen order with their icons, names
// and statuses, and the rollback bar. Click selects a feature (Shift adds, Ctrl toggles), a
// double-click edits it, hovering highlights its faces in the viewport. Rows are dragged to
// reorder (a move the document refuses is explained and not made), and the rollback bar is
// dragged between rows. Every change is one core command, so Undo and Redo cover all of it.

import { DEFAULT_PART_ID, findPart, type Command } from '@manufakture/core';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { useModel, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import { featureItem, isFeatureItem, selectModeFor, type SelectionStore } from '../state/selection';
import { ActionIcon, KindIcon, StatusIcon } from './icons';
import {
  KIND_LABELS,
  STATUS_LABELS,
  deleteFeature,
  dropIndex,
  moveFeature,
  renameFeature,
  repicks,
  rollbackPosition,
  rowMessages,
  setRollback,
  suppressFeature,
  treeRows,
  type Check,
  type TreeRow,
} from './tree';

export interface FeatureTreeProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  partId?: string;
  /** No changes while something else edits the document (a sketch, a feature dialog). */
  disabled?: boolean;
  /** Open a feature for editing; `repick` names a reference to pick again. */
  onEdit: (featureId: string, options?: { repick?: string }) => void;
}

type Drag =
  | { kind: 'feature'; id: string; from: number; slot: number; check: Check | null }
  | { kind: 'bar'; slot: number };

interface Pending {
  kind: 'feature' | 'bar';
  id: string;
  from: number;
  startY: number;
}

interface ConfirmDelete {
  featureId: string;
  name: string;
  dependents: string[];
}

const DRAG_THRESHOLD_PX = 4;

export function FeatureTree({
  documents,
  model,
  selection,
  partId = DEFAULT_PART_ID,
  disabled = false,
  onEdit,
}: FeatureTreeProps) {
  const document = useStore(documents, (s) => s.document);
  const available = useModel(model, (s) => s.available);
  const built = useModel(model, (s) => s.document);
  const parts = useModel(model, (s) => s.parts);
  const pending = useModel(model, (s) => s.pending);
  const regenError = useModel(model, (s) => s.error);
  const selected = useStore(selection, (s) => s.selected);
  const part = findPart(document, partId);

  const rows = useMemo(() => {
    if (!part) return [];
    const results = new Map(
      (parts.find((p) => p.partId === partId)?.features ?? []).map((f) => [f.featureId, f]),
    );
    return treeRows(part, results, { available, built, current: document });
  }, [part, parts, partId, available, built, document]);
  const bar = part ? rollbackPosition(part) : 0;
  const selectedIds = useMemo(
    () => new Set(selected.filter(isFeatureItem).map((i) => i.id)),
    [selected],
  );

  const [renaming, setRenamingState] = useState<{ id: string; text: string } | null>(null);
  // The rename in progress, read by `commitRename`: Enter and the blur that follows it must
  // record one rename, whatever each handler's render saw.
  const renamingRef = useRef<{ id: string; text: string } | null>(null);
  const setRenaming = (next: { id: string; text: string } | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmDelete | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const pendingDrag = useRef<Pending | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  // Drags capture the pointer on the list, which stays put while rows and the bar move in it.
  const listRef = useRef<HTMLOListElement>(null);

  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  // The gap the pointer is over: 0 above the first row, n below the last.
  const slotAt = (clientY: number): number => {
    let slot = 0;
    for (const row of rows) {
      const el = rowRefs.current.get(row.feature.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) slot = row.index + 1;
    }
    return slot;
  };

  const onPointerDown = (
    e: PointerEvent<HTMLElement>,
    kind: 'feature' | 'bar',
    id: string,
    from: number,
  ) => {
    if (disabled || e.button !== 0) return;
    // A drag may start on a row's buttons too (a click without moving still clicks them).
    if (kind === 'feature' && (e.target as HTMLElement).closest('input')) return;
    // Captured once the pointer really drags, so a plain click still lands on the row.
    pendingDrag.current = { kind, id, from, startY: e.clientY };
    if (kind === 'bar') e.preventDefault();
  };

  // A press that ended where the list did not see it (released over the viewport, or outside
  // the window) must not turn a later hover into a drag with no button down.
  const forgetPress = () => {
    pendingDrag.current = null;
    setDrag(null);
  };

  useEffect(() => {
    // React's pointerup on the list runs first when the press ends over it; this catches the
    // rest.
    const onUp = () => {
      if (!pendingDrag.current) return;
      pendingDrag.current = null;
      setDrag(null);
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const p = pendingDrag.current;
    if (!p) return;
    if (e.buttons === 0) {
      // The release went unseen (outside the window): whatever was dragged goes back.
      if (listRef.current?.hasPointerCapture?.(e.pointerId)) {
        listRef.current.releasePointerCapture(e.pointerId);
      }
      forgetPress();
      return;
    }
    if (drag === null && Math.abs(e.clientY - p.startY) < DRAG_THRESHOLD_PX) return;
    if (drag === null) listRef.current?.setPointerCapture?.(e.pointerId);
    const slot = slotAt(e.clientY);
    if (p.kind === 'bar') {
      if (drag?.kind !== 'bar' || drag.slot !== slot) setDrag({ kind: 'bar', slot });
      return;
    }
    if (drag?.kind === 'feature' && drag.slot === slot) return;
    const to = dropIndex(p.from, slot);
    const check =
      to === p.from ? null : moveFeature(documents.getState().document, partId, p.id, to);
    setDrag({ kind: 'feature', id: p.id, from: p.from, slot, check });
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const p = pendingDrag.current;
    pendingDrag.current = null;
    if (listRef.current?.hasPointerCapture?.(e.pointerId)) {
      listRef.current.releasePointerCapture(e.pointerId);
    }
    const d = drag;
    setDrag(null);
    if (!p || !d || !part) return;
    if (d.kind === 'bar') {
      const r = setRollback(part, d.slot);
      if (r) run(r.command, r.label);
      return;
    }
    if (d.check === null) return;
    if (!d.check.ok) {
      setMessage(d.check.message);
      return;
    }
    const name = part.features[d.from]?.name ?? d.id;
    run(d.check.command, `Move ${name}`);
  };

  const move = (row: TreeRow, by: -1 | 1) => {
    const check = moveFeature(
      documents.getState().document,
      partId,
      row.feature.id,
      row.index + by,
    );
    if (!check.ok) setMessage(check.message);
    else run(check.command, `Move ${row.feature.name}`);
  };

  const startDelete = (row: TreeRow) => {
    const d = deleteFeature(documents.getState().document, partId, row.feature.id);
    if (!d) return;
    if (d.dependents.length === 0) {
      run(d.command, d.label);
      return;
    }
    setConfirm({ featureId: row.feature.id, name: row.feature.name, dependents: d.dependents });
  };

  const confirmDelete = () => {
    if (!confirm) return;
    const d = deleteFeature(documents.getState().document, partId, confirm.featureId);
    const index = rows.findIndex((r) => r.feature.id === confirm.featureId);
    setConfirm(null);
    if (d) run(d.command, d.label);
    // The row is gone: focus the one that took its place, once the list has re-rendered.
    focusAfterRender.current = { index };
  };

  const cancelDelete = () => {
    if (!confirm) return;
    const id = confirm.featureId;
    setConfirm(null);
    rowRefs.current.get(id)?.focus();
  };

  // The delete question takes focus when it opens, so the keyboard can answer it.
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.querySelector<HTMLElement>('button[data-cancel]')?.focus();
  }, [confirm]);
  const focusAfterRender = useRef<{ index: number } | null>(null);
  useEffect(() => {
    const target = focusAfterRender.current;
    if (!target) return;
    focusAfterRender.current = null;
    const row = rows[Math.max(0, Math.min(target.index, rows.length - 1))];
    if (row) rowRefs.current.get(row.feature.id)?.focus();
  });

  const commitRename = () => {
    const current = renamingRef.current;
    if (!current || !part) return;
    setRenaming(null);
    // The document as it is now, not as this render saw it.
    const feature = findPart(documents.getState().document, partId)?.features.find(
      (f) => f.id === current.id,
    );
    if (!feature) return;
    const r = renameFeature(partId, feature, current.text);
    if (!r.ok) setMessage(r.message);
    else if (r.command) run(r.command, r.label);
  };

  const toggleSuppress = (row: TreeRow) => {
    const s = suppressFeature(partId, row.feature);
    run(s.command, s.label);
  };

  const focusRow = (index: number) => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (row) rowRefs.current.get(row.feature.id)?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLLIElement>, row: TreeRow) => {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!disabled) move(row, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(row.index + (e.key === 'ArrowUp' ? -1 : 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!disabled) onEdit(row.feature.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      if (!disabled) setRenaming({ id: row.feature.id, text: row.feature.name });
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (!disabled) startDelete(row);
    } else if (e.key === ' ') {
      e.preventDefault();
      selection.getState().click(featureItem(row.feature.id), selectModeFor(e));
    }
  };

  const onBarKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (!part || disabled) return;
    const to =
      e.key === 'ArrowUp'
        ? bar - 1
        : e.key === 'ArrowDown'
          ? bar + 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? part.features.length
              : null;
    if (to === null) return;
    e.preventDefault();
    const r = setRollback(part, to);
    if (r) run(r.command, r.label);
  };

  const hover = (id: string | null) => {
    const s = selection.getState();
    if (id !== null) s.setHovered(featureItem(id));
    else if (isFeatureItem(s.hovered)) s.setHovered(null);
  };

  if (!part) return null;

  const barSlot = drag?.kind === 'bar' ? drag.slot : null;
  const dropSlot = drag?.kind === 'feature' && drag.check !== null ? drag.slot : null;
  const dropOk = drag?.kind === 'feature' && drag.check?.ok === true;
  const barName = bar === 0 ? 'the start' : (part.features[bar - 1]?.name ?? '');

  const rollbackBar = (
    <li
      key="rollback-bar"
      className={`rollback-bar${barSlot !== null ? ' dragging' : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Rollback bar"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={part.features.length}
      aria-valuenow={bar}
      aria-valuetext={bar === part.features.length ? 'At the end' : `After ${barName}`}
      aria-disabled={disabled}
      data-testid="rollback-bar"
      title="Rollback bar: drag it up to see the part as it was at that feature"
      onPointerDown={(e) => onPointerDown(e, 'bar', 'bar', bar)}
      onKeyDown={onBarKey}
    />
  );

  // While dragged, the bar is drawn where it would land.
  const shownBar = barSlot ?? bar;
  const items: ReactNode[] = [];
  for (const row of rows) {
    if (row.index === shownBar) items.push(rollbackBar);
    const f = row.feature;
    const isSelected = selectedIds.has(f.id);
    const messages = rowMessages(row);
    const picks = repicks(row.result);
    const statusLabel = `${STATUS_LABELS[row.status]}${row.stale && row.status !== 'suppressed' && row.status !== 'rolled-back' ? ' (rebuilding)' : ''}`;
    const tipId = `feature-tip-${f.id.replace('#', '-')}`;
    const classes = [
      'feature-row',
      `status-${row.status}`,
      isSelected ? 'selected' : '',
      row.stale ? 'stale' : '',
      drag?.kind === 'feature' && drag.id === f.id ? 'dragged' : '',
      dropSlot === row.index ? (dropOk ? 'drop-before' : 'drop-before refused') : '',
      dropSlot === rows.length && row.index === rows.length - 1
        ? dropOk
          ? 'drop-after'
          : 'drop-after refused'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    items.push(
      <li
        key={f.id}
        ref={(el) => {
          if (el) rowRefs.current.set(f.id, el);
          else rowRefs.current.delete(f.id);
        }}
        className={classes}
        data-feature={f.id}
        data-status={row.status}
        data-testid={`feature-${f.id}`}
        aria-selected={isSelected}
        tabIndex={0}
        onClick={(e) => selection.getState().click(featureItem(f.id), selectModeFor(e))}
        onDoubleClick={() => !disabled && onEdit(f.id)}
        onMouseEnter={() => hover(f.id)}
        onMouseLeave={() => {
          hover(null);
          setTip((t) => (t === f.id ? null : t));
        }}
        onKeyDown={(e) => onRowKey(e, row)}
        onPointerDown={(e) => onPointerDown(e, 'feature', f.id, row.index)}
      >
        <span className="kind" title={KIND_LABELS[f.kind]}>
          <KindIcon kind={f.kind} />
        </span>
        {renaming?.id === f.id ? (
          <input
            className="rename"
            aria-label={`New name for ${f.name}`}
            value={renaming.text}
            autoFocus
            onChange={(e) => setRenaming({ id: f.id, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(null);
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className="name">{f.name}</span>
        )}
        <button
          type="button"
          className="status"
          aria-label={`${f.name}: ${statusLabel}`}
          aria-describedby={tip === f.id && messages.length > 0 ? tipId : undefined}
          data-testid={`status-${f.id}`}
          onMouseEnter={() => setTip(f.id)}
          onFocus={() => setTip(f.id)}
          onBlur={() => setTip((t) => (t === f.id ? null : t))}
          onClick={(e) => {
            e.stopPropagation();
            setTip(tip === f.id ? null : f.id);
          }}
        >
          <StatusIcon status={row.status} />
        </button>
        <span className="row-actions">
          <button
            type="button"
            disabled={disabled}
            aria-label={`Edit ${f.name}`}
            title="Edit (double-click, Enter)"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(f.id);
            }}
          >
            <ActionIcon name="edit" />
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Rename ${f.name}`}
            title="Rename (F2)"
            onClick={(e) => {
              e.stopPropagation();
              setRenaming({ id: f.id, text: f.name });
            }}
          >
            <ActionIcon name="rename" />
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={`${f.suppressed ? 'Unsuppress' : 'Suppress'} ${f.name}`}
            title={f.suppressed ? 'Unsuppress' : 'Suppress: leave it out of the part'}
            onClick={(e) => {
              e.stopPropagation();
              toggleSuppress(row);
            }}
          >
            <ActionIcon name={f.suppressed ? 'unsuppress' : 'suppress'} />
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Delete ${f.name}`}
            title="Delete (Del)"
            onClick={(e) => {
              e.stopPropagation();
              startDelete(row);
            }}
          >
            <ActionIcon name="delete" />
          </button>
        </span>
        {tip === f.id && (
          <div
            className="feature-tip"
            role="tooltip"
            id={tipId}
            data-testid="feature-tip"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="tip-status">{statusLabel}</p>
            {messages.map((m, i) => (
              <p key={i} className={`tip-${m.severity}`}>
                {m.text}
              </p>
            ))}
            {picks.map((p) => (
              <button
                key={p.referenceId}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setTip(null);
                  onEdit(f.id, { repick: p.referenceId });
                }}
              >
                Re-pick {p.referenceId}
              </button>
            ))}
          </div>
        )}
      </li>,
    );
  }
  if (shownBar >= rows.length) items.push(rollbackBar);

  return (
    <section className="feature-tree" aria-label="Feature tree" data-testid="feature-tree">
      <h2>
        {part.name}
        {pending && (
          <span className="regen-pending" role="status">
            Rebuilding...
          </span>
        )}
      </h2>
      {rows.length === 0 ? (
        <p className="tree-empty">No features yet. Start with New sketch.</p>
      ) : (
        <ol
          ref={listRef}
          className={`feature-list${drag ? ' dragging' : ''}`}
          aria-label="Features"
          onPointerLeave={() => hover(null)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={forgetPress}
        >
          {items}
        </ol>
      )}
      {confirm && (
        <div
          ref={confirmRef}
          className="tree-confirm"
          role="alertdialog"
          aria-label={`Delete ${confirm.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelDelete();
            }
          }}
        >
          <p>
            Delete {confirm.name}? {confirm.dependents.join(', ')}{' '}
            {confirm.dependents.length === 1 ? 'is' : 'are'} built from it and{' '}
            {confirm.dependents.length === 1 ? 'is' : 'are'} deleted too.
          </p>
          <button type="button" onClick={confirmDelete}>
            Delete {1 + confirm.dependents.length} features
          </button>
          <button type="button" data-cancel onClick={cancelDelete}>
            Cancel
          </button>
        </div>
      )}
      {message && (
        <p className="tree-message" role="alert" data-testid="tree-message">
          {message}{' '}
          <button type="button" onClick={() => setMessage(null)}>
            Dismiss
          </button>
        </p>
      )}
      {regenError && (
        <p className="tree-message" role="alert">
          The part could not be rebuilt: {regenError}
        </p>
      )}
      {drag?.kind === 'bar' && (
        <p className="tree-hint" role="status">
          Drop to roll back to{' '}
          {drag.slot === 0 ? 'the start' : `after ${part.features[drag.slot - 1]?.name}`}
        </p>
      )}
      {drag?.kind === 'feature' && drag.check && !drag.check.ok && (
        <p className="tree-hint refused" role="status">
          {drag.check.message}
        </p>
      )}
    </section>
  );
}
