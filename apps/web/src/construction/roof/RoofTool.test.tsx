import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../../model/model';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore } from '../../state/selection';
import { createMemberStore } from '../../viewport/memberStore';
import type { ViewportApi } from '../../viewport/Viewport';
import { ConstructionPanel } from '../ConstructionPanel';
import { ConstructionTools } from '../ConstructionTools';
import { FT, FT_IN, PART, constructionDocument, settingsOf } from '../construction.test-fixture';
import { createConstructionUiStore } from '../state';
import { buildWall, pathPoints } from '../walls';
import { PitchField } from './PitchField';

function shed() {
  const doc = constructionDocument();
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
  const documents = createDocumentStore(doc);
  documents.getState().execute(r.command, r.label);
  return { documents, wall: r.feature.id };
}

/** A viewport that records the preview lines (the rest is not used by the Roof tool). */
function fakeViewport() {
  const lines: unknown[][] = [];
  const api = {
    setPreviewLines: (l: unknown[]) => lines.push(l),
    requestRender: () => {},
    onViewChange: () => () => {},
    projectToClient: () => ({ x: 10, y: 20 }),
  } as unknown as ViewportApi;
  return { api, lines };
}

function setup() {
  const { documents, wall } = shed();
  const model = createModelStore();
  const ui = createConstructionUiStore();
  const viewport = fakeViewport();
  // The wall as regen reports it, for the pitch preview.
  model.setState({
    parts: [
      {
        partId: PART,
        bodies: [],
        features: [
          {
            featureId: wall,
            kind: 'extension',
            index: 0,
            status: 'ok',
            errors: [],
            warnings: [],
            references: [],
            cached: false,
            ms: 0,
            metadata: {
              kind: 'wall',
              level: 'level-1',
              base: 0,
              height: 97.125 * 25.4,
              points: [
                [0, 0],
                [16 * FT, 0],
                [16 * FT, 12 * FT],
                [0, 12 * FT],
              ],
              closed: true,
              justification: 'left',
              thickness: 88.9,
              free: { start: false, end: false },
              layers: [],
              settings: {},
              overrides: [],
            } as never,
          },
        ],
      },
    ],
  } as never);
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
        viewport={viewport.api}
      />
    </>,
  );
  return { documents, ui, wall, viewport };
}

const change = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('the pitch field', () => {
  function field(value: string) {
    const r = render(<PitchField value={value} units={FT_IN} onChange={() => {}} />);
    return r;
  }

  it('accepts 6/12 and shows it back as 6/12 with its angle', () => {
    field('6/12');
    expect(screen.getByTestId('roof-pitch-shown').textContent).toBe('6/12, 26.57°');
    expect(screen.queryByTestId('roof-pitch-error')).toBeNull();
  });

  it('rejects a bare 30 with the ambiguity message', () => {
    field('30');
    expect(screen.getByTestId('roof-pitch-error').textContent).toBe(
      'Ambiguous: write 30° or 30/12',
    );
    expect(screen.queryByTestId('roof-pitch-shown')).toBeNull();
  });

  it('takes 6:12, degrees and percent, shown back as p/12', () => {
    const cases: [string, string][] = [
      ['6:12', '6/12, 26.57°'],
      ['30deg', '6.93/12, 30.00°'],
      ['25%', '3/12, 14.04°'],
    ];
    for (const [typed, shown] of cases) {
      const r = field(typed);
      expect(screen.getByTestId('roof-pitch-shown').textContent).toBe(shown);
      r.unmount();
    }
  });

  it('refuses a flat or vertical pitch and overlong text', () => {
    for (const typed of ['0/12', '90deg', '1'.repeat(101)]) {
      const r = field(typed);
      expect(screen.getByTestId('roof-pitch-error')).toBeTruthy();
      r.unmount();
    }
  });
});

describe('the roof tool', () => {
  it('adds a 6/12 gable roof on the walls with a new roof type, as one undo step', () => {
    const t = setup();
    act(() => t.ui.getState().startTool({ kind: 'roof', featureId: null }));
    // The new document has no roof type: the tool makes one, sizes unchosen.
    expect(screen.getByTestId('roof-type-form')).toBeTruthy();
    expect((screen.getByTestId(`roof-wall-${t.wall}`) as HTMLInputElement).checked).toBe(true);
    change('roof-pitch', '30');
    fireEvent.click(screen.getByTestId('roof-ok'));
    expect(screen.getByTestId('roof-pitch-error').textContent).toBe(
      'Ambiguous: write 30° or 30/12',
    );
    expect(screen.getByTestId('roof-type-rafter').closest('.dialog-field')!.textContent).toContain(
      'Choose the rafter stock.',
    );
    expect(t.documents.getState().document.parts[0]!.features).toHaveLength(1);

    change('roof-pitch', '6/12');
    change('roof-type-rafter', 'us-2x6');
    change('roof-type-ridge', 'us-2x8');
    // The preview: eaves, two gable ends and the ridge, with the pitch at the ridge.
    expect(screen.getByTestId('roof-pitch-label').textContent).toBe('6/12, 26.57°');
    const last = t.viewport.lines.at(-1)!;
    expect(last).toHaveLength(4);
    fireEvent.click(screen.getByTestId('roof-ok'));
    expect(screen.queryByTestId('roof-tool')).toBeNull();
    const doc = t.documents.getState().document;
    const roof = doc.parts[0]!.features[1]!;
    expect(roof.kind === 'extension' && roof).toMatchObject({
      name: 'Roof 1',
      extension: 'construction.roof',
      dependsOn: [t.wall],
      operation: 'new',
      params: { level: 'level-1', roofType: 'roof', kind: 'gable' },
      expressions: { pitch: { source: '6/12' } },
    });
    expect(settingsOf(doc).stored.roofTypes).toEqual([
      {
        id: 'roof',
        name: 'Roof',
        rafterStock: 'us-2x6',
        ridgeStock: 'us-2x8',
        sheathing: 'us-osb-7-16',
      },
    ]);
    expect(t.documents.getState().undoLabel).toBe('Add Roof 1');
    expect(screen.getByTestId(`roof-summary-${roof.id}`).textContent).toBe('Gable, 6/12, 26.57°');

    // Reopened, the field shows 6/12 back; 4/12 and hip need the type's hip stock.
    fireEvent.click(screen.getByTestId(`construction-edit-${roof.id}`));
    expect((screen.getByTestId('roof-pitch') as HTMLInputElement).value).toBe('6/12');
    change('roof-pitch', '4/12');
    change('field-roof-kind', 'hip');
    fireEvent.click(screen.getByTestId('roof-ok'));
    expect(screen.getByTestId('roof-hip-stock').closest('.dialog-field')!.textContent).toContain(
      'The Roof roof type has no hip rafters',
    );
    change('roof-hip-stock', 'us-2x8');
    fireEvent.click(screen.getByTestId('roof-ok'));
    const after = t.documents.getState().document;
    const hip = after.parts[0]!.features[1]!;
    expect(hip.kind === 'extension' && [hip.params.kind, hip.expressions.pitch!.source]).toEqual([
      'hip',
      '4/12',
    ]);
    expect(settingsOf(after).stored.roofTypes[0]!.hipStock).toBe('us-2x8');

    // One undo takes back the hip roof and its type's hip stock; one more, the roof and its type.
    act(() => void t.documents.getState().undo());
    const undone = t.documents.getState().document;
    const gable = undone.parts[0]!.features[1]!;
    expect(gable.kind === 'extension' && gable.params.kind).toBe('gable');
    expect(settingsOf(undone).stored.roofTypes[0]!.hipStock).toBeUndefined();
    act(() => void t.documents.getState().undo());
    expect(t.documents.getState().document.parts[0]!.features).toHaveLength(1);
    expect(settingsOf(t.documents.getState().document).stored.roofTypes).toEqual([]);
  });

  it('bears on a level by a typed rectangle, with ties and overhangs', () => {
    const t = setup();
    act(() => t.ui.getState().startTool({ kind: 'roof', featureId: null }));
    change('field-roof-bearing', 'level');
    change('roof-x', '0');
    change('roof-y', '0');
    change('roof-length', `16'`);
    change('roof-width', `12'`);
    change('roof-type-rafter', 'us-2x6');
    change('roof-type-ridge', 'us-2x8');
    change('roof-pitch', '25%');
    change('roof-overhang', `1'`);
    change('field-roof-ties', 'rafter-ties');
    change('roof-tie-stock', 'us-2x4');
    change('field-roof-tie-every', '2');
    fireEvent.click(screen.getByTestId('roof-ok'));
    expect(screen.getByTestId('roof-tie-height-error').textContent).toBe(
      'Rafter ties need a height above the plates.',
    );
    change('roof-tie-height', `2'`);
    fireEvent.click(screen.getByTestId('roof-ok'));
    const roof = t.documents.getState().document.parts[0]!.features[1]!;
    expect(roof.kind === 'extension' && roof).toMatchObject({
      dependsOn: [],
      params: { ties: { kind: 'rafter-ties', stock: 'us-2x4', every: 2 } },
      expressions: {
        pitch: { source: '25%' },
        length: { source: `16'` },
        overhang: { source: `1'` },
        tieHeight: { source: `2'` },
      },
    });
  });
});
