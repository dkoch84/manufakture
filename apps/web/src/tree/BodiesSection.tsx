// The Bodies section of the feature tree, above the features: every body of the part (as regen
// made it; bodies merged away are not listed) with its colour swatch, name, material and solid
// count, and buttons to hide, show or isolate it. Names, colours and materials are document
// settings (one undoable `setBodyProps` each); hiding is view state, kept per document in the
// view settings, and never an undo step.

import {
  MATERIALS,
  findMaterial,
  findPart,
  type Command,
  type MaterialId,
} from '@manufakture/core';
import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { bodyPropsCommand, partBodies, type PartBody } from '../model/bodies';
import { useModel, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import { hiddenBodiesOf, type ViewSettingsStore } from '../state/viewSettings';

export interface BodiesSectionProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  settings: ViewSettingsStore;
  partId: string;
  /** No document changes while something else edits the document. */
  disabled?: boolean;
  /** Reports a change the document refused. */
  onMessage?: (message: string | null) => void;
}

const NAME_MAX = 200;

export function BodiesSection({
  documents,
  model,
  settings,
  partId,
  disabled = false,
  onMessage,
}: BodiesSectionProps) {
  const document = useStore(documents, (s) => s.document);
  const parts = useModel(model, (s) => s.parts);
  const hiddenIds = useStore(settings, (s) => hiddenBodiesOf(s, document.id));
  const part = findPart(document, partId);
  const bodies = useMemo(
    () =>
      partBodies(
        part,
        parts.find((p) => p.partId === partId),
        new Set(hiddenIds),
      ),
    [part, parts, partId, hiddenIds],
  );
  const [renaming, setRenamingState] = useState<{ id: string; text: string } | null>(null);
  // Enter and the blur after it must commit one rename, whatever each render saw.
  const renamingRef = useRef<{ id: string; text: string } | null>(null);
  const setRenaming = (next: { id: string; text: string } | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };

  if (!part || bodies.length === 0) return null;
  const partMaterial = part.material ? findMaterial(part.material) : undefined;
  const ids = bodies.map((b) => b.viewId);
  const anyHidden = bodies.some((b) => b.hidden);

  const run = (command: Command | null, label: string) => {
    if (!command) return;
    const r = documents.getState().execute(command, label);
    onMessage?.(r.ok ? null : r.error.message);
  };
  const setHidden = (body: PartBody, hidden: boolean) =>
    settings.getState().setBodyHidden(document.id, body.viewId, hidden);
  const isolate = (body: PartBody) =>
    settings.getState().setHiddenBodies(
      document.id,
      ids,
      ids.filter((id) => id !== body.viewId),
    );

  const commitRename = () => {
    const current = renamingRef.current;
    if (!current) return;
    setRenaming(null);
    const body = bodies.find((b) => b.bodyId === current.id);
    if (!body) return;
    const text = current.text.trim();
    if (text.length > NAME_MAX) {
      onMessage?.(`A name has at most ${NAME_MAX} characters.`);
      return;
    }
    // An empty name goes back to the default one.
    if (text === body.name || (text === '' && !body.named)) return;
    run(bodyPropsCommand(partId, body, { name: text === '' ? null : text }), `Rename ${body.name}`);
  };

  return (
    <section className="bodies-section" aria-label="Bodies" data-testid="bodies">
      <h3>
        Bodies
        {anyHidden && (
          <button
            type="button"
            className="show-all"
            onClick={() => settings.getState().setHiddenBodies(document.id, ids, [])}
          >
            Show all
          </button>
        )}
      </h3>
      <ul className="body-list">
        {bodies.map((b) => (
          <li
            key={b.bodyId}
            className={`body-row${b.hidden ? ' hidden' : ''}`}
            data-testid={`body-${b.bodyId}`}
            data-body={b.viewId}
          >
            <input
              type="color"
              className="swatch"
              aria-label={`Colour of ${b.name}`}
              title="Colour"
              disabled={disabled}
              value={b.color}
              onChange={(e) =>
                run(
                  bodyPropsCommand(partId, b, { color: e.target.value.toLowerCase() }),
                  `Colour ${b.name}`,
                )
              }
            />
            {renaming?.id === b.bodyId ? (
              <input
                className="rename"
                aria-label={`New name for ${b.name}`}
                value={renaming.text}
                autoFocus
                onChange={(e) => setRenaming({ id: b.bodyId, text: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={commitRename}
              />
            ) : (
              <span
                className="name"
                title={b.viewId}
                onDoubleClick={() => !disabled && setRenaming({ id: b.bodyId, text: b.name })}
              >
                {b.name}
              </span>
            )}
            {b.solids > 1 && (
              <span className="solids" title="Separate pieces in this body">
                {b.solids} solids
              </span>
            )}
            <select
              className="material"
              aria-label={`Material of ${b.name}`}
              disabled={disabled}
              value={b.ownMaterial ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                const next = value === '' ? null : (value as MaterialId);
                const name =
                  next === null ? 'the part material' : (findMaterial(next)?.name ?? next);
                run(bodyPropsCommand(partId, b, { material: next }), `Set ${b.name} to ${name}`);
              }}
            >
              <option value="">
                {partMaterial ? `Part material (${partMaterial.name})` : 'Part material (none)'}
              </option>
              {MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="body-actions">
              <button
                type="button"
                disabled={disabled}
                aria-label={`Rename ${b.name}`}
                title="Rename"
                onClick={() => setRenaming({ id: b.bodyId, text: b.name })}
              >
                Rename
              </button>
              <button
                type="button"
                aria-label={`${b.hidden ? 'Show' : 'Hide'} ${b.name}`}
                aria-pressed={b.hidden}
                title={b.hidden ? 'Show it in the view' : 'Hide it in the view'}
                onClick={() => setHidden(b, !b.hidden)}
              >
                {b.hidden ? 'Show' : 'Hide'}
              </button>
              {bodies.length > 1 && (
                <button
                  type="button"
                  aria-label={`Isolate ${b.name}`}
                  title="Show only this body"
                  onClick={() => isolate(b)}
                >
                  Isolate
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
