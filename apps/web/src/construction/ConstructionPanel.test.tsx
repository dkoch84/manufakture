import { createDocument } from '@manufakture/core';
import { DISCLAIMER_SHORT, memberListing } from '@manufakture/domain-construction';
import {
  A as SHED_WALL,
  DOOR as SHED_DOOR,
  PART as SHED_PART,
  shedDocument,
  shedFeatures,
  shedSets,
} from '@manufakture/domain-construction/fixtures/shed-model';
import { boxMesh, memberInstances, type MemberData } from '@manufakture/regen';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../model/model';
import { createDocumentStore } from '../state/document';
import { createSelectionStore } from '../state/selection';
import { memberRef } from '../viewport/members';
import { createMemberStore } from '../viewport/memberStore';
import type { ViewportApi } from '../viewport/Viewport';
import { FT_IN, PART, constructionDocument, settingsOf } from './construction.test-fixture';
import { ConstructionPanel } from './ConstructionPanel';
import { ConstructionTools } from './ConstructionTools';
import { createConstructionUiStore } from './state';
import { buildWall, pathPoints } from './walls';

const FT = 304.8;
const stock = { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 };

function member(owner: string, id: string, role: string): MemberData {
  return {
    id,
    owner,
    role,
    stock,
    length: 2352.675,
    placement: { origin: [0, 0, 0], x: [0, 0, 1], y: [1, 0, 0] },
    cuts: [],
  };
}

function setup(doc = constructionDocument()) {
  const documents = createDocumentStore(doc);
  const model = createModelStore();
  const members = createMemberStore();
  const selection = createSelectionStore();
  const ui = createConstructionUiStore();
  ui.getState().setOpen(true);
  render(
    <>
      <ConstructionPanel
        documents={documents}
        model={model}
        members={members}
        selection={selection}
        ui={ui}
        partId={PART}
      />
      <ConstructionTools
        documents={documents}
        model={model}
        selection={selection}
        ui={ui}
        partId={PART}
        viewport={null}
      />
    </>,
  );
  return { documents, model, members, selection, ui };
}

function addOutline(t: ReturnType<typeof setup>) {
  const doc = t.documents.getState().document;
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
  act(() => {
    t.documents.getState().execute(r.command, r.label);
  });
  return r.feature.id;
}

describe('the construction panel', () => {
  it('shows the short disclaimer once, puts it away for the document, and keeps it in help', () => {
    const t = setup(createDocument({ id: 'empty', name: 'Empty', units: FT_IN }));
    expect(screen.getByTestId('construction-disclaimer').textContent).toContain(DISCLAIMER_SHORT);
    expect(screen.getAllByText(DISCLAIMER_SHORT, { exact: false })).toHaveLength(2); // notice + help
    fireEvent.click(screen.getByTestId('construction-disclaimer-hide'));
    expect(screen.queryByTestId('construction-disclaimer')).toBeNull();
    expect(screen.getByTestId('construction-help-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    expect(t.ui.getState().noticeHidden.has('empty')).toBe(true);
  });

  it('starts construction with one level and no header rules, as one undo step', () => {
    const t = setup(createDocument({ id: 'empty', name: 'Empty', units: FT_IN }));
    fireEvent.click(screen.getByTestId('construction-start'));
    const data = settingsOf(t.documents.getState().document);
    expect(data.stored.levels).toHaveLength(1);
    expect(data.stored.headerRules).toEqual([]);
    expect(screen.getByTestId('levels-panel')).toBeTruthy();
    t.documents.getState().undo();
    expect(t.documents.getState().document.domains?.construction).toBeUndefined();
  });

  it('asks a new wall type for its default header, offering no sizes', () => {
    const t = setup(createDocument({ id: 'empty', name: 'Empty', units: FT_IN }));
    fireEvent.click(screen.getByTestId('construction-start'));
    fireEvent.click(screen.getByTestId('wall-type-new'));
    fireEvent.click(screen.getByTestId('wall-type-create'));
    expect(screen.getByText('Choose the header stock.')).toBeTruthy();
    expect(screen.getByText('Choose how many plies.')).toBeTruthy();
    expect(settingsOf(t.documents.getState().document).stored.wallTypes).toEqual([]);
    fireEvent.change(screen.getByTestId('wall-type-header-stock'), { target: { value: 'us-2x8' } });
    fireEvent.change(screen.getByTestId('field-wall-type-header-plies'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByTestId('field-wall-type-header-jacks'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByTestId('wall-type-create'));
    const types = settingsOf(t.documents.getState().document).stored.wallTypes;
    expect(types.map((x) => [x.id, x.layers.map((l) => l.kind)])).toEqual([
      ['exterior-2x4', ['sheathing', 'framing']],
    ]);
  });

  it('adds and renames levels', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('level-add'));
    fireEvent.change(screen.getByTestId('level-name-level-2'), { target: { value: 'Loft' } });
    fireEvent.change(screen.getByTestId('level-height-level-2'), { target: { value: `7'` } });
    fireEvent.click(screen.getByTestId('level-save-level-2'));
    const level = settingsOf(t.documents.getState().document).stored.levels[1]!;
    expect([level.name, level.height.source]).toEqual(['Loft', `7'`]);
    fireEvent.change(screen.getByTestId('level-elevation-level-2'), { target: { value: '#e' } });
    fireEvent.click(screen.getByTestId('level-save-level-2'));
    expect(screen.getByTestId('level-elevation-level-2-error').textContent).toContain('variable');
  });

  it("lists each wall's members by role and each opening's header and where it came from", () => {
    const t = setup();
    const wall = addOutline(t);
    act(() =>
      t.members.getState().load(PART, {
        meshes: new Map([['k', boxMesh(1, 1, 1)]]),
        sets: [
          {
            group: wall,
            namespace: 'construction',
            features: [wall, 'extension#2'],
            members: [
              member(wall, 's0', 'stud'),
              member(wall, 's1', 'stud'),
              member(wall, 'bottom1:1', 'bottom-plate'),
              member('extension#2', 'header', 'header'),
            ],
            instances: memberInstances([]),
            metadata: {
              openings: [
                {
                  id: 'extension#2',
                  header: { source: 'default', stock: 'us-2x8', plies: 2, jacks: 1 },
                  framed: true,
                },
              ],
            },
          },
        ],
      }),
    );
    // The opening itself, as the Opening tool adds it.
    act(() => {
      t.documents.getState().execute({
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'extension#2',
          kind: 'extension',
          name: 'Door 1',
          suppressed: false,
          extension: 'construction.opening',
          schemaVersion: 1,
          dependsOn: [wall],
          references: [],
          expressions: {},
          params: { kind: 'door' },
        },
      });
    });
    expect(screen.getByTestId(`wall-members-${wall}`).textContent).toBe('4 members');
    expect(screen.getByTestId(`wall-role-${wall}-stud`).getAttribute('data-count')).toBe('2');
    expect(screen.getByTestId('opening-header-extension#2').textContent).toBe(
      "Header: The wall type's default header: 2 plies of 2x8 on 1 jack stud each end.",
    );
    expect(screen.getByTestId('opening-members-extension#2').textContent).toBe('1 members');
  });

  it("edits a wall's framing settings as one step", () => {
    const t = setup();
    const wall = addOutline(t);
    fireEvent.click(screen.getByTestId(`wall-framing-${wall}`));
    fireEvent.change(screen.getByTestId('wall-spacing'), { target: { value: '24"' } });
    fireEvent.click(screen.getByTestId('wall-framing-save'));
    const f = t.documents.getState().document.parts[0]!.features[0]!;
    expect(f.kind === 'extension' && f.expressions.spacing?.source).toBe('24"');
    expect(screen.queryByTestId('wall-framing-editor')).toBeNull();
    expect(t.documents.getState().undoLabel).toBe('Set the framing of Wall 1');
  });

  it('deletes a picked member and changes its stock', () => {
    const t = setup();
    const wall = addOutline(t);
    act(() => t.selection.getState().select([memberRef(`${wall}:s2`)]));
    const actions = screen.getByTestId('member-actions');
    fireEvent.click(within(actions).getByTestId('member-delete'));
    const overrides = () => {
      const f = t.documents.getState().document.parts[0]!.features[0]!;
      return f.kind === 'extension' ? f.params.overrides : undefined;
    };
    expect(overrides()).toEqual([{ id: 's2', delete: true }]);
    expect(screen.getByTestId('member-actions-state').textContent).toContain('Deleted');
    fireEvent.change(screen.getByTestId('member-stock'), { target: { value: 'us-2x6' } });
    fireEvent.click(screen.getByTestId('member-stock-apply'));
    expect(overrides()).toEqual([{ id: 's2', stock: 'us-2x6' }]);
    fireEvent.click(screen.getByTestId('member-restore'));
    expect(overrides()).toBeUndefined();
  });
});

describe('member actions record where a layout stud is (#1215)', () => {
  it("stores a wall stud's position with its override, and none for an opening's member", () => {
    expect(SHED_PART).toBe(PART);
    const t = setup(shedDocument());
    act(() => {
      t.model.setState({ parts: [{ partId: PART, features: shedFeatures(), bodies: [] }] });
      t.members.getState().load(PART, { meshes: new Map(), sets: shedSets() });
    });
    const centre = memberListing({
      owner: SHED_WALL,
      features: shedFeatures(),
      sets: shedSets(),
    })!.members.find((m) => m.local === 's5')!.along!.centre;
    const overridesOf = (id: string) => {
      const f = t.documents.getState().document.parts[0]!.features.find((x) => x.id === id)!;
      return f.kind === 'extension' ? f.params.overrides : undefined;
    };
    act(() => t.selection.getState().select([memberRef(`${SHED_WALL}:s5`)]));
    fireEvent.click(within(screen.getByTestId('member-actions')).getByTestId('member-delete'));
    expect(overridesOf(SHED_WALL)).toEqual([{ id: 's5', delete: true, at: centre }]);
    // A later change keeps the position the override was made with.
    fireEvent.change(screen.getByTestId('member-stock'), { target: { value: 'us-2x6' } });
    fireEvent.click(screen.getByTestId('member-stock-apply'));
    expect(overridesOf(SHED_WALL)).toEqual([{ id: 's5', stock: 'us-2x6', at: centre }]);
    // An opening's members keep their ids whatever the wall's layout: no position. (The
    // fixture's openings have no params; give the door its kind.)
    act(() => {
      const door = t.documents
        .getState()
        .document.parts[0]!.features.find((x) => x.id === SHED_DOOR)!;
      if (door.kind !== 'extension') return;
      t.documents.getState().execute({
        type: 'editFeature',
        partId: PART,
        feature: { ...door, params: { kind: 'door' } },
      });
      t.selection.getState().select([memberRef(`${SHED_DOOR}:king-l`)]);
    });
    fireEvent.click(within(screen.getByTestId('member-actions')).getByTestId('member-delete'));
    expect(overridesOf(SHED_DOOR)).toEqual([{ id: 'king-l', delete: true }]);
  });
});

describe('the wall tool', () => {
  it("draws a 12' x 16' outline from typed lengths and closes it", () => {
    const t = setup();
    act(() => t.ui.getState().startTool({ kind: 'wall' }));
    const type = (v: string) => {
      fireEvent.change(screen.getByTestId('wall-length'), { target: { value: v } });
      fireEvent.click(screen.getByTestId('wall-length-add'));
    };
    type(`16'`);
    type(`12'`);
    type(`16'`);
    expect(screen.getByTestId('wall-step-2').textContent).toBe(`12' up (+y)`);
    fireEvent.click(screen.getByTestId('wall-closed'));
    expect(screen.getByTestId('wall-summary').textContent).toBe(
      `4 segments, 56' 0" in all, closed.`,
    );
    fireEvent.click(screen.getByTestId('wall-add'));
    const wall = t.documents.getState().document.parts[0]!.features[0]!;
    expect(wall.kind === 'extension' && wall.params).toEqual({
      level: 'level-1',
      wallType: 'exterior-2x4',
      points: 4,
      closed: true,
    });
    expect(t.ui.getState().tool).toBeNull();
  });

  it('closes a loop typed back onto its start, and refuses a bad length', () => {
    const t = setup();
    act(() => t.ui.getState().startTool({ kind: 'wall' }));
    fireEvent.change(screen.getByTestId('wall-length'), { target: { value: 'twelve' } });
    fireEvent.click(screen.getByTestId('wall-length-add'));
    expect(screen.getByTestId('wall-length-error')).toBeTruthy();
    for (const v of [`11' 6-1/2"`, `8'`, `11' 6-1/2"`, `8'`]) {
      fireEvent.change(screen.getByTestId('wall-length'), { target: { value: v } });
      fireEvent.click(screen.getByTestId('wall-length-add'));
    }
    fireEvent.click(screen.getByTestId('wall-add'));
    const wall = t.documents.getState().document.parts[0]!.features[0]!;
    expect(wall.kind === 'extension' && wall.params.closed).toBe(true);
    expect(wall.kind === 'extension' && wall.expressions.x2!.source).toBe('138.5');
  });
});

describe('the wall tool in the view', () => {
  it('takes a new start point from the next click after Remove last empties the path', () => {
    let delegate: { down: (e: unknown, p: { x: number; y: number }) => boolean } | null = null;
    const viewport = {
      setPointerDelegate: (d: typeof delegate) => (delegate = d),
      // Canvas pixels are millimetres on the level's plane, for the test.
      canvasToPlane: (x: number, y: number) => [x, y, 0],
      setPreviewLines: () => {},
    } as unknown as ViewportApi;
    const documents = createDocumentStore(constructionDocument());
    const ui = createConstructionUiStore();
    render(
      <ConstructionTools
        documents={documents}
        model={createModelStore()}
        selection={createSelectionStore()}
        ui={ui}
        partId={PART}
        viewport={viewport}
      />,
    );
    act(() => ui.getState().startTool({ kind: 'wall' }));
    const click = (x: number, y: number) => act(() => void delegate!.down({}, { x, y }));
    const value = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value;
    click(0, 0);
    click(10 * FT, 0);
    expect(screen.getAllByTestId(/^wall-step-\d+$/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('wall-step-undo'));
    expect(screen.queryAllByTestId(/^wall-step-\d+$/)).toHaveLength(0);
    // The next click is a new start, not a segment from the old one.
    click(4 * FT, 2 * FT);
    expect([value('wall-start-x'), value('wall-start-y')]).toEqual(['48', '24']);
    expect(screen.queryAllByTestId(/^wall-step-\d+$/)).toHaveLength(0);
    click(4 * FT, 8 * FT);
    expect(screen.getByTestId('wall-step-1').textContent).toBe(`6' 0" up (+y)`);
  });
});

describe('the wall tool joining walls', () => {
  it('names the earlier wall the new one meets in its dependsOn, for the layer joins', () => {
    const t = setup();
    // A first wall, 16' along X, as regen reports it.
    const first = addOutline(t);
    act(() =>
      t.model.setState({
        parts: [
          {
            partId: PART,
            bodies: [],
            features: [
              {
                featureId: first,
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
                  points: [
                    [0, 0],
                    [16 * FT, 0],
                  ],
                  closed: false,
                  free: { start: false, end: false },
                  layers: [],
                } as never,
              },
            ],
          },
        ],
      }),
    );
    act(() => t.ui.getState().startTool({ kind: 'wall' }));
    // Starting at the first wall's end, 12' up: an L.
    fireEvent.change(screen.getByTestId('wall-start-x'), { target: { value: `16'` } });
    fireEvent.change(screen.getByTestId('wall-length'), { target: { value: `12'` } });
    fireEvent.change(screen.getByTestId('field-wall-direction'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('wall-length-add'));
    fireEvent.click(screen.getByTestId('wall-add'));
    const second = t.documents.getState().document.parts[0]!.features[1]!;
    expect(second.kind === 'extension' && second.dependsOn).toEqual([first]);
  });
});

describe('the opening tool', () => {
  it("shows which header it will use, and adds a door centred on a wall's segment", () => {
    const t = setup();
    const wall = addOutline(t);
    // The wall's path as regen reports it, for its segment lengths.
    act(() =>
      t.model.setState({
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
                  height: 2466.975,
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
      }),
    );
    act(() => t.ui.getState().startTool({ kind: 'opening', featureId: null, wall: null }));
    fireEvent.change(screen.getByTestId('field-opening-segment'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('opening-width'), { target: { value: `3'` } });
    fireEvent.change(screen.getByTestId('opening-height'), { target: { value: `6' 8"` } });
    expect(screen.getByTestId('opening-header-preview').textContent).toBe(
      "The wall type's default header: 2 plies of 2x8 on 1 jack stud each end.",
    );
    fireEvent.click(screen.getByTestId('opening-ok'));
    const door = t.documents.getState().document.parts[0]!.features[1]!;
    expect(door.kind === 'extension' && [door.name, door.expressions.position!.source]).toEqual([
      'Door 1',
      '72',
    ]);
  });
});
