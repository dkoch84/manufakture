// The Bodies section of the feature tree, above the features: every body of the part (as regen
// made it; bodies merged away are not listed) with its colour swatch, name, material and solid
// count, and buttons to hide, show or isolate it. Bodies can be gathered into named groups, each a
// collapsible row with its own Hide and Isolate. Names, colours, materials and groups are document
// settings (one undoable command each); hiding is view state, kept per document in the view
// settings, and never an undo step. A group is hidden when its bodies are, so hiding a group hides
// each of its bodies, and a body's own Hide works inside a group as anywhere else.

import {
  MATERIALS,
  findMaterial,
  findPart,
  type Command,
  type MaterialId,
} from '@manufakture/core';
import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  addToGroupCommand,
  bodyPropsCommand,
  deleteGroupCommand,
  groupBodies,
  isolateHidden,
  newGroupCommand,
  partBodies,
  removeFromGroupCommand,
  renameGroupCommand,
  type PartBody,
  type PartBodyGroup,
} from '../model/bodies';
import { useModel, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import {
  createSelectionStore,
  isGeometryRef,
  type SelectableItem,
  type SelectionStore,
} from '../state/selection';
import { hiddenBodiesOf, type ViewSettingsStore } from '../state/viewSettings';

export interface BodiesSectionProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  settings: ViewSettingsStore;
  /**
   * The viewport selection: when no body is ticked in the list, the bodies its faces, edges and
   * vertices are on are the ones a new group is made of.
   */
  selection?: SelectionStore | undefined;
  partId: string;
  /** No document changes while something else edits the document. */
  disabled?: boolean;
  /** Reports a change the document refused. */
  onMessage?: (message: string | null) => void;
}

const NAME_MAX = 200;

type Renaming = { kind: 'body' | 'group'; id: string; text: string };

export function BodiesSection({
  documents,
  model,
  settings,
  selection,
  partId,
  disabled = false,
  onMessage,
}: BodiesSectionProps) {
  const document = useStore(documents, (s) => s.document);
  const parts = useModel(model, (s) => s.parts);
  const hiddenIds = useStore(settings, (s) => hiddenBodiesOf(s, document.id));
  const selected = useSelected(selection);
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
  const grouping = useMemo(() => groupBodies(part, bodies), [part, bodies]);
  const [renaming, setRenamingState] = useState<Renaming | null>(null);
  // Enter and the blur after it must commit one rename, whatever each render saw.
  const renamingRef = useRef<Renaming | null>(null);
  const setRenaming = (next: Renaming | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };
  // Bodies ticked in the list, by body id: what a new group is made of. View state of this list.
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);

  if (!part || bodies.length === 0) return null;
  const partMaterial = part.material ? findMaterial(part.material) : undefined;
  const ids = bodies.map((b) => b.viewId);
  const anyHidden = bodies.some((b) => b.hidden);
  // Ticked bodies that still exist; else the bodies the viewport selection is on.
  const tickedHere = bodies.filter((b) => ticked.includes(b.bodyId)).map((b) => b.bodyId);
  const fromViewport = bodies
    .filter((b) => selected.some((i) => isGeometryRef(i) && i.bodyId === b.viewId))
    .map((b) => b.bodyId);
  const chosen = tickedHere.length > 0 ? tickedHere : fromViewport;

  const run = (command: Command | null, label: string) => {
    if (!command) return false;
    const r = documents.getState().execute(command, label);
    onMessage?.(r.ok ? null : r.error.message);
    return r.ok;
  };
  const setHidden = (body: PartBody, hidden: boolean) =>
    settings.getState().setBodyHidden(document.id, body.viewId, hidden);
  const isolate = (keep: readonly string[]) =>
    settings.getState().setHiddenBodies(document.id, ids, isolateHidden(ids, keep));
  const setGroupHidden = (g: PartBodyGroup, hidden: boolean) => {
    const members = g.members.map((b) => b.viewId);
    settings.getState().setHiddenBodies(document.id, members, hidden ? members : []);
  };
  const toggleTick = (bodyId: string) =>
    setTicked((now) => (now.includes(bodyId) ? now.filter((b) => b !== bodyId) : [...now, bodyId]));
  const toggleCollapsed = (groupId: string) =>
    setCollapsed((now) =>
      now.includes(groupId) ? now.filter((g) => g !== groupId) : [...now, groupId],
    );

  const newGroup = () => {
    const { command, groupId, name } = newGroupCommand(part, chosen);
    if (run(command, `Group ${chosen.length === 1 ? 'a body' : `${chosen.length} bodies`}`)) {
      setTicked([]);
      // Straight into naming it: Enter keeps the default name.
      setRenaming({ kind: 'group', id: groupId, text: name });
    }
  };

  const commitRename = () => {
    const current = renamingRef.current;
    if (!current) return;
    setRenaming(null);
    const text = current.text.trim();
    if (text.length > NAME_MAX) {
      onMessage?.(`A name has at most ${NAME_MAX} characters.`);
      return;
    }
    if (current.kind === 'group') {
      const g = part.bodyGroups?.find((x) => x.id === current.id);
      // A group always has a name: an empty one keeps the old name.
      if (!g || text === '') return;
      run(renameGroupCommand(part, g.id, text), `Rename group ${g.name}`);
      return;
    }
    const body = bodies.find((b) => b.bodyId === current.id);
    if (!body) return;
    // An empty name goes back to the default one.
    if (text === body.name || (text === '' && !body.named)) return;
    run(bodyPropsCommand(partId, body, { name: text === '' ? null : text }), `Rename ${body.name}`);
  };

  const renameInput = (label: string) => (
    <input
      className="rename"
      aria-label={label}
      value={renaming?.text ?? ''}
      autoFocus
      onChange={(e) => renaming && setRenaming({ ...renaming, text: e.target.value })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') setRenaming(null);
      }}
      onBlur={commitRename}
    />
  );

  const bodyRow = (b: PartBody, group?: PartBodyGroup) => (
    <li
      key={b.bodyId}
      className={`body-row${b.hidden ? ' hidden' : ''}`}
      data-testid={`body-${b.bodyId}`}
      data-body={b.viewId}
      data-group={group?.group.id}
    >
      <input
        type="checkbox"
        className="pick"
        aria-label={`Select ${b.name}`}
        title="Select for a group"
        data-testid={`body-pick-${b.bodyId}`}
        checked={ticked.includes(b.bodyId)}
        onChange={() => toggleTick(b.bodyId)}
      />
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
      {renaming?.kind === 'body' && renaming.id === b.bodyId ? (
        renameInput(`New name for ${b.name}`)
      ) : (
        <span
          className="name"
          title={b.viewId}
          onDoubleClick={() =>
            !disabled && setRenaming({ kind: 'body', id: b.bodyId, text: b.name })
          }
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
          const name = next === null ? 'the part material' : (findMaterial(next)?.name ?? next);
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
          onClick={() => setRenaming({ kind: 'body', id: b.bodyId, text: b.name })}
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
            onClick={() => isolate([b.viewId])}
          >
            Isolate
          </button>
        )}
        {group && (
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${b.name} from ${group.group.name}`}
            title="Take it out of the group (the body stays)"
            onClick={() =>
              run(
                removeFromGroupCommand(part, group.group.id, [b.bodyId]),
                `Remove ${b.name} from ${group.group.name}`,
              )
            }
          >
            Remove
          </button>
        )}
      </span>
    </li>
  );

  const groupRow = (g: PartBodyGroup) => {
    const { id, name } = g.group;
    const open = !collapsed.includes(id);
    const addable = chosen.filter((b) => !g.group.bodies.includes(b));
    const count = g.members.length;
    return (
      <li
        key={id}
        className={`body-group${g.hidden ? ' hidden' : ''}${g.partlyHidden ? ' partly-hidden' : ''}`}
        data-testid={`body-group-${id}`}
        data-group={id}
      >
        <div className="body-group-row">
          <button
            type="button"
            className="group-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
            data-testid={`body-group-toggle-${id}`}
            onClick={() => toggleCollapsed(id)}
          >
            {open ? '▾' : '▸'}
          </button>
          {renaming?.kind === 'group' && renaming.id === id ? (
            renameInput(`New name for group ${name}`)
          ) : (
            <span
              className="name"
              title={id}
              onDoubleClick={() => !disabled && setRenaming({ kind: 'group', id, text: name })}
            >
              {name}
            </span>
          )}
          <span className="group-count" data-testid={`body-group-count-${id}`}>
            {count === 1 ? '1 body' : `${count} bodies`}
          </span>
          <span className="body-actions">
            <button
              type="button"
              disabled={disabled}
              aria-label={`Rename group ${name}`}
              title="Rename the group"
              onClick={() => setRenaming({ kind: 'group', id, text: name })}
            >
              Rename
            </button>
            <button
              type="button"
              disabled={count === 0}
              aria-label={`${g.hidden ? 'Show' : 'Hide'} group ${name}`}
              aria-pressed={g.partlyHidden ? 'mixed' : g.hidden}
              title={g.hidden ? 'Show its bodies in the view' : 'Hide its bodies in the view'}
              onClick={() => setGroupHidden(g, !g.hidden)}
            >
              {g.hidden ? 'Show' : 'Hide'}
            </button>
            <button
              type="button"
              disabled={count === 0}
              aria-label={`Isolate group ${name}`}
              title="Show only this group's bodies"
              onClick={() => isolate(g.members.map((b) => b.viewId))}
            >
              Isolate
            </button>
            <button
              type="button"
              disabled={disabled || addable.length === 0}
              aria-label={`Add selected bodies to ${name}`}
              title="Add the selected bodies to this group"
              onClick={() => {
                const label = `Add ${addable.length === 1 ? 'a body' : `${addable.length} bodies`} to ${name}`;
                if (run(addToGroupCommand(part, id, addable), label)) setTicked([]);
              }}
            >
              Add
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Delete group ${name}`}
              title="Delete the group (its bodies stay)"
              onClick={() => run(deleteGroupCommand(partId, id), `Delete group ${name}`)}
            >
              Delete
            </button>
          </span>
        </div>
        {open && count > 0 && (
          <ul className="body-list group-members" aria-label={`Bodies in ${name}`}>
            {g.members.map((b) => bodyRow(b, g))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className="bodies-section" aria-label="Bodies" data-testid="bodies">
      <h3>
        Bodies
        <span className="bodies-actions">
          {bodies.length > 1 && (
            <button
              type="button"
              className="new-group"
              data-testid="new-body-group"
              disabled={disabled || chosen.length === 0}
              aria-label="Group selected bodies"
              title={
                chosen.length === 0
                  ? 'Select bodies (tick them, or pick their faces) to group them'
                  : `Make a group of ${chosen.length === 1 ? 'the selected body' : `the ${chosen.length} selected bodies`}`
              }
              onClick={newGroup}
            >
              Group
            </button>
          )}
          {anyHidden && (
            <button
              type="button"
              className="show-all"
              onClick={() => settings.getState().setHiddenBodies(document.id, ids, [])}
            >
              Show all
            </button>
          )}
        </span>
      </h3>
      <ul className="body-list">
        {grouping.groups.map(groupRow)}
        {grouping.ungrouped.map((b) => bodyRow(b))}
      </ul>
    </section>
  );
}

function useSelected(selection: SelectionStore | undefined): readonly SelectableItem[] {
  // An empty store of its own when there is none, so the hooks are the same either way.
  const [own] = useState(createSelectionStore);
  return useStore(selection ?? own, (s) => s.selected);
}
