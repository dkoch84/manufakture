// Picking the text regions of a sketch in the extrude dialog with one click (T3.2d): emboss with
// Add, deboss with Remove; or everything but the text, as a stencil.

import {
  applyCommand,
  createDocument,
  type ExtrudeFeature,
  type ManufaktureDocument,
  type SketchFeature,
} from '@manufakture/core';
import { INTER_BOLD } from '@manufakture/regen/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createModelStore } from '../model/model';
import { createDocumentStore } from '../state/document';
import { createSelectionStore } from '../state/selection';
import { FeatureDialog } from './FeatureDialog';
import { entitiesFor, otherEntities, regionChoice, textEntities } from './regions';

const line = (id: string, start: [number, number], end: [number, number]) => ({
  id,
  kind: 'line' as const,
  construction: false,
  start,
  end,
});

const plate = (): SketchFeature => ({
  id: 'sketch#1',
  kind: 'sketch',
  name: 'Sketch 1',
  suppressed: false,
  plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  entities: [
    line('e1', [-20, -10], [20, -10]),
    line('e2', [20, -10], [20, 10]),
    line('e3', [20, 10], [-20, 10]),
    line('e4', [-20, 10], [-20, -10]),
    {
      id: 'e5',
      kind: 'outline',
      construction: false,
      anchor: [0, 0],
      angle: 0,
      source: {
        kind: 'text',
        text: 'OK',
        font: 'font#1',
        size: { source: '6', lengthUnit: 'mm', angleUnit: 'deg' },
        align: { horizontal: 'center', vertical: 'middle' },
      },
    },
    {
      id: 'e6',
      kind: 'outline',
      construction: true,
      anchor: [0, 5],
      angle: 0,
      source: {
        kind: 'text',
        text: 'guide',
        font: 'font#1',
        size: { source: '3', lengthUnit: 'mm', angleUnit: 'deg' },
        align: { horizontal: 'center', vertical: 'middle' },
      },
    },
    { id: 'e7', kind: 'point', construction: false, position: [15, 5] },
  ],
  constraints: [],
});

function document(): ManufaktureDocument {
  const doc = createDocument({ id: 'd', name: 'Label' });
  const r = applyCommand(doc, {
    type: 'batch',
    commands: [
      {
        type: 'addFont',
        font: {
          id: 'font#1',
          family: 'Inter',
          style: 'Bold',
          source: { kind: 'bundled', id: INTER_BOLD.id, sha256: INTER_BOLD.sha256 },
        },
      },
      { type: 'addFeature', partId: 'part#1', feature: plate() },
      {
        type: 'addFeature',
        partId: 'part#1',
        feature: {
          id: 'extrude#1',
          kind: 'extrude',
          name: 'Plate',
          suppressed: false,
          profile: { sketch: 'sketch#1', entities: ['e1', 'e2', 'e3', 'e4'] },
          operation: 'new',
          extent: { type: 'blind', distance: { source: '3', lengthUnit: 'mm', angleUnit: 'deg' } },
          reverse: false,
        },
      },
    ],
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

describe('the regions of a sketch with text', () => {
  it('names the text entities and the others that bound regions', () => {
    const sketch = plate();
    expect(textEntities(sketch)).toEqual(['e5']);
    expect(otherEntities(sketch)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(regionChoice(sketch, undefined)).toBe('all');
    expect(regionChoice(sketch, ['e5'])).toBe('text');
    expect(regionChoice(sketch, ['e4', 'e3', 'e2', 'e1'])).toBe('others');
    expect(regionChoice(sketch, ['e1'])).toBe('custom');
    expect(entitiesFor(sketch, 'all')).toBeUndefined();
    expect(entitiesFor(sketch, 'text')).toEqual(['e5']);
  });
});

describe('the extrude dialog on a sketch with text', () => {
  function open(request: { kind: 'extrude'; featureId?: string }) {
    const documents = createDocumentStore(document());
    const onClose = vi.fn();
    render(
      <FeatureDialog
        request={request}
        documents={documents}
        model={createModelStore()}
        selection={createSelectionStore()}
        resolve={vi.fn()}
        onClose={onClose}
      />,
    );
    const features = () => documents.getState().document.parts[0]!.features;
    return { documents, onClose, features };
  }

  it('debosses the text: its regions in one click, removed from the plate', () => {
    const t = open({ kind: 'extrude' });
    expect(screen.getByTestId('field-regions')).toBeTruthy();
    expect(screen.getByTestId('regions-all')).toHaveProperty('checked', true);
    fireEvent.click(screen.getByTestId('regions-text'));
    expect(screen.getByTestId('field-regions').textContent).toMatch(/debossed/);
    fireEvent.change(screen.getByTestId('field-operation'), { target: { value: 'cut' } });
    fireEvent.change(screen.getByTestId('field-distance'), { target: { value: '0.6' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).toHaveBeenCalled();
    expect(t.features().at(-1)).toMatchObject({
      kind: 'extrude',
      profile: { sketch: 'sketch#1', entities: ['e5'] },
      operation: 'cut',
      extent: { type: 'blind', distance: { source: '0.6' } },
    });
  });

  it('shows how an existing profile picks, and goes back to every region', () => {
    const t = open({ kind: 'extrude', featureId: 'extrude#1' });
    expect(screen.getByTestId('regions-others')).toHaveProperty('checked', true);
    fireEvent.click(screen.getByTestId('regions-all'));
    fireEvent.click(screen.getByTestId('dialog-ok'));
    const plateFeature = t.features().find((f) => f.id === 'extrude#1') as ExtrudeFeature;
    expect(plateFeature.profile).toEqual({ sketch: 'sketch#1' });
  });
});
