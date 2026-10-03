import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../../model/model';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore } from '../../state/selection';
import { createMemberStore } from '../../viewport/memberStore';
import { ConstructionPanel } from '../ConstructionPanel';
import { ConstructionTools } from '../ConstructionTools';
import { FT, PART, constructionDocument, settingsOf } from '../construction.test-fixture';
import { createConstructionUiStore } from '../state';
import { buildWall, pathPoints } from '../walls';

function setup(withWalls = true) {
  const documents = createDocumentStore(constructionDocument());
  let wall = '';
  if (withWalls) {
    const doc = documents.getState().document;
    const r = buildWall(doc, PART, settingsOf(doc).settings, {
      level: 'level-1',
      wallType: 'exterior-2x4',
      points: pathPoints(
        [0, 0],
        [
          { kind: 'typed', dir: 0, length: 16 * FT, text: '' },
          { kind: 'typed', dir: 90, length: 12 * FT, text: '' },
          { kind: 'typed', dir: 180, length: 16 * FT, text: '' },
        ],
      ),
      closed: true,
    });
    if (!r.ok) throw new Error(r.message);
    documents.getState().execute(r.command, r.label);
    wall = r.feature.id;
  }
  const model = createModelStore();
  const ui = createConstructionUiStore();
  render(
    <>
      <ConstructionPanel
        documents={documents}
        model={model}
        members={createMemberStore()}
        selection={createSelectionStore()}
        ui={ui}
        partId={PART}
      />
      <ConstructionTools
        documents={documents}
        model={model}
        selection={createSelectionStore()}
        ui={ui}
        partId={PART}
        viewport={null}
      />
    </>,
  );
  return { documents, ui, wall };
}

const change = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('the floor tool', () => {
  it('adds a floor on skids under the walls with a new floor type, as one undo step', () => {
    const t = setup();
    act(() => t.ui.getState().startTool({ kind: 'floor', featureId: null }));
    expect((screen.getByTestId(`floor-wall-${t.wall}`) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('floor-skids'));
    fireEvent.click(screen.getByTestId('floor-ok'));
    // Sizes are the user's: joist and skid stock start unchosen.
    expect(screen.getByTestId('floor-type-joist').closest('.dialog-field')!.textContent).toContain(
      'Choose the joist stock.',
    );
    expect(screen.getByTestId('floor-skid-stock').closest('.dialog-field')!.textContent).toContain(
      'Choose the skid stock.',
    );
    change('floor-type-joist', 'us-2x6');
    change('floor-skid-stock', 'us-4x6');
    change('floor-spacing', '16"');
    fireEvent.click(screen.getByTestId('floor-ok'));
    expect(screen.queryByTestId('floor-tool')).toBeNull();
    const doc = t.documents.getState().document;
    const floor = doc.parts[0]!.features[1]!;
    expect(floor.kind === 'extension' && floor).toMatchObject({
      name: 'Floor 1',
      extension: 'construction.floor',
      dependsOn: [t.wall],
      operation: 'new',
      params: {
        level: 'level-1',
        floorType: 'floor',
        outline: 'walls',
        skids: { stock: 'us-4x6', count: 3 },
      },
      expressions: { spacing: { source: '16"' } },
    });
    expect(settingsOf(doc).stored.floorTypes).toEqual([
      { id: 'floor', name: 'Floor', joistStock: 'us-2x6', subfloor: 'us-osb-23-32' },
    ]);
    expect(t.documents.getState().undoLabel).toBe('Add Floor 1');
    expect(screen.getByTestId(`construction-feature-${floor.id}`)).toBeTruthy();

    // Edited: the joists turn to the long side, the type stays.
    fireEvent.click(screen.getByTestId(`construction-edit-${floor.id}`));
    expect(screen.getByTestId('floor-type-summary').textContent).toBe(
      'Joists 2x6, subfloor 3/4" OSB.',
    );
    change('field-floor-joists', 'long');
    fireEvent.click(screen.getByTestId('floor-ok'));
    const edited = t.documents.getState().document.parts[0]!.features[1]!;
    expect(edited.kind === 'extension' && edited.params.joists).toBe('long');

    act(() => void t.documents.getState().undo());
    act(() => void t.documents.getState().undo());
    const undone = t.documents.getState().document;
    expect(undone.parts[0]!.features).toHaveLength(1);
    expect(settingsOf(undone).stored.floorTypes).toEqual([]);
  });

  it('takes an outline of typed points, bounded, and refuses gaps', () => {
    const t = setup(false);
    act(() => t.ui.getState().startTool({ kind: 'floor', featureId: null }));
    expect((screen.getByTestId('field-floor-outline') as HTMLSelectElement).value).toBe('points');
    change('floor-type-joist', 'us-2x6');
    fireEvent.click(screen.getByTestId('floor-ok'));
    expect(screen.getByTestId('floor-x2-error').textContent).toBe('Enter a coordinate.');
    change('floor-x2', `8'`);
    change('floor-x3', `8'`);
    change('floor-y3', `10'`);
    change('floor-y4', `10'`);
    change('field-floor-joists', 'angle');
    change('floor-direction', '45deg');
    fireEvent.click(screen.getByTestId('floor-ok'));
    const floor = t.documents.getState().document.parts[0]!.features[0]!;
    expect(floor.kind === 'extension' && floor).toMatchObject({
      dependsOn: [],
      params: { outline: 'points', points: 4 },
      expressions: { x3: { source: `8'` }, y3: { source: `10'` }, direction: { source: '45deg' } },
    });
  });

  it('caps the outline at 64 points', () => {
    const t = setup(false);
    act(() => t.ui.getState().startTool({ kind: 'floor', featureId: null }));
    const add = screen.getByTestId('floor-point-add') as HTMLButtonElement;
    for (let i = 4; i < 64; i++) fireEvent.click(add);
    expect(screen.getByTestId('floor-x64')).toBeTruthy();
    expect(add.disabled).toBe(true);
  });
});
