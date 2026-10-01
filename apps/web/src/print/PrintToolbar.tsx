// The print workspace's toolbar (M3 plan, T3.1d): the orientation tools for the active item (Lay
// flat on face, a quarter turn about each bed axis, Reset to as modelled) and the shading modes
// (normal, overhang, thickness). Every orientation change is one undoable command.

import type { Command } from '@manufakture/core';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { resetOrientationCommand, rotateCommand, type BedAxis } from './commands';
import type { ResolvedSetup } from './resolve';
import { activeItemId, activeSetup, type PrintShading, type PrintUiStore } from './state';

export interface PrintToolbarProps {
  documents: DocumentStoreApi;
  printUi: PrintUiStore;
  resolved: ResolvedSetup | null;
  disabled?: boolean;
}

const SHADINGS: readonly [PrintShading, string, string][] = [
  ['normal', 'Normal', 'The bodies in their own colours'],
  ['overhang', 'Overhang', 'Colour faces by how steeply they overhang, from vertical'],
  [
    'thickness',
    'Thickness',
    'Colour faces by wall thickness: thin walls and features too small to print',
  ],
];

export function PrintToolbar({
  documents,
  printUi,
  resolved,
  disabled = false,
}: PrintToolbarProps) {
  const doc = useStore(documents, (s) => s.document);
  const setupId = useStore(printUi, (s) => s.setupId);
  const itemId = useStore(printUi, (s) => s.itemId);
  const shading = useStore(printUi, (s) => s.shading);
  const layingFlat = useStore(printUi, (s) => s.layingFlat);
  const setup = activeSetup(doc, setupId);
  const activeId = activeItemId(setup, itemId);
  const item = setup?.items.find((i) => i.id === activeId);
  const current = resolved?.items.find((i) => i.item.id === activeId)?.orientation ?? null;
  const off = disabled || !setup || !item;

  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    printUi.getState().setMessage(r.ok ? null : r.error.message);
  };
  const turn = (axis: BedAxis) => {
    if (!setup || !item) return;
    run(rotateCommand(doc, setup.id, item, current, axis), `Turn about ${axis.toUpperCase()}`);
  };

  return (
    <div className="print-toolbar" role="toolbar" aria-label="Print">
      <button
        type="button"
        aria-pressed={layingFlat}
        disabled={off}
        data-testid="print-lay-flat"
        title="Click a flat face of the item: it goes face down on the bed"
        onClick={() => printUi.getState().setLayingFlat(!layingFlat)}
      >
        Lay flat on face
      </button>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <button
          key={axis}
          type="button"
          disabled={off}
          data-testid={`print-rotate-${axis}`}
          title={`Turn the item 90° about the bed's ${axis.toUpperCase()} axis`}
          onClick={() => turn(axis)}
        >
          {axis.toUpperCase()} 90°
        </button>
      ))}
      <button
        type="button"
        disabled={off || item?.orientation.kind === 'asModelled'}
        data-testid="print-reset"
        title="Put the item back as modelled"
        onClick={() =>
          setup && item && run(resetOrientationCommand(setup.id, item), 'Reset orientation')
        }
      >
        Reset
      </button>
      <span className="print-toolbar-gap" />
      <div className="print-shading" role="radiogroup" aria-label="Shading">
        {SHADINGS.map(([value, label, title]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={shading === value}
            data-testid={`print-shading-${value}`}
            title={title}
            onClick={() => printUi.getState().setShading(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {layingFlat && (
        <span className="print-hint" role="status" data-testid="print-lay-flat-hint">
          Click a flat face of {item ? 'the item' : 'an item'} to put it face down on the bed.
        </span>
      )}
    </div>
  );
}
