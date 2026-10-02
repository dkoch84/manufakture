// The Manufacture workspace's panels with a fake geometry stage and CAM worker: a new setup on the
// default machine, the operation list (status from the stage, rename, suppress, reorder, move,
// delete, each one undo step), re-pick for lost geometry, Generate and stale marks, and the setup
// panel (machine, post, stock and heights checks, WCS origin and a WCS face picked in the view).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CamClient } from '@manufakture/cam/client';
import { defaultPost, findMachine } from '@manufakture/cam/library';
import type { CamOperation, ManufaktureDocument } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelStore } from '../model/model';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef } from '../state/selection';
import { apply, mm, plywoodDocument, setupDocument, withTool } from './cam.test-fixture';
import { CamSidePanel, CamTree } from './CamWorkspace';
import type { CamGeometer } from './geometer';
import { createCamUiStore } from './state';

afterEach(cleanup);

const facing = (id: string, name: string): CamOperation & { kind: 'facing' } => ({
  id,
  kind: 'facing',
  name,
  suppressed: false,
  tool: 'tool#1',
  geometry: [],
  depth: mm('1'),
  angle: mm('0'),
});

const profileOnFace: CamOperation = {
  id: 'profile#1',
  kind: 'profile',
  name: 'Outline',
  suppressed: false,
  tool: 'tool#1',
  geometry: [{ kind: 'face', face: { id: 'r1', ref: { face: 'gone' } } }],
  side: 'outside',
  depth: { kind: 'through' },
  entry: { kind: 'plunge' },
  leadIn: { kind: 'none' },
  leadOut: { kind: 'none' },
  climb: true,
};

/** A stage that resolves every operation (a face named `gone` is lost), keyed by its fields. */
function fakeGeometer(): CamGeometer & { calls: number } {
  const g = {
    calls: 0,
    geometry: vi.fn(async (doc: ManufaktureDocument, setupId: string) => {
      g.calls++;
      const setup = doc.cam.setups.find((s) => s.id === setupId)!;
      const result: CamGeometryResult = {
        generation: 1,
        setupId,
        partId: setup.part,
        bodyId: 'extrude#1',
        bodyKey: 'body',
        key: 'all',
        status: 'ok',
        errors: [],
        warnings: [],
        references: [],
        bounds: { min: [0, 0, 0], max: [40, 30, 10] },
        setup: {
          machine: setup.machine,
          post: setup.post,
          stock: {
            kind: 'fromBody',
            margins: { xMin: 0, xMax: 0, yMin: 0, yMax: 0, top: 0, bottom: 0 },
          },
          wcs: { up: { kind: 'axis', axis: '+z' }, origin: setup.wcs.origin },
          heights: { clearance: 10, retract: 5 },
          stockZ: { top: 0, bottom: -10 },
        },
        operations: setup.operations.map((op) => {
          const { name: _name, ...rest } = op;
          void _name;
          const lost = op.geometry.findIndex(
            (s) => s.kind === 'face' && s.face.ref.face === 'gone',
          );
          const base = {
            operationId: op.id,
            kind: op.kind,
            key: JSON.stringify(rest),
            warnings: [],
            references: [],
            sources: [],
          };
          if (op.suppressed)
            return { ...base, status: 'suppressed' as const, errors: [], values: null };
          if (lost >= 0) {
            return {
              ...base,
              status: 'error' as const,
              errors: [
                {
                  code: 'reference-lost' as const,
                  message: 'Face gone is not on the body',
                  source: lost,
                },
              ],
              values: null,
            };
          }
          return {
            ...base,
            status: 'ok' as const,
            errors: [],
            values: {
              id: op.id,
              name: op.name,
              tool: {
                id: 'tool#1',
                name: 'Flat',
                kind: 'flat' as const,
                diameter: 6,
                fluteLength: 20,
                flutes: 2,
              },
              feeds: { spindle: 18000, cut: 1000, plunge: 300 },
              kind: 'facing' as const,
              depth: { top: 0, bottom: -1 },
              stepdown: 1,
              stepover: 0.5,
              angle: 0,
            },
          };
        }),
        cached: false,
        ms: 0,
      };
      return result;
    }),
  };
  return g;
}

function fakeClient() {
  const generate = vi.fn(
    async (setup: { id: string; operations: readonly { id: string; kind: string }[] }) => ({
      status: 'done' as const,
      generation: 1,
      setup: setup.id,
      operations: setup.operations.map((o) => ({
        id: o.id,
        kind: o.kind,
        key: `tp-${o.id}`,
        cached: false,
        ms: 1,
        ok: true as const,
        toolpath: {} as never,
        warnings: [],
      })),
      ms: 1,
    }),
  );
  return { client: { generate } as unknown as CamClient, generate };
}

function mount(
  doc: ManufaktureDocument,
  options: {
    geometer?: CamGeometer | null;
    disabled?: boolean;
    bodies?: readonly { id: string; name: string }[];
  } = {},
) {
  const documents = createDocumentStore(doc);
  const model = createModelStore();
  const camUi = createCamUiStore();
  camUi.getState().setOpen(true);
  const selection = createSelectionStore();
  const geometer = options.geometer === undefined ? fakeGeometer() : options.geometer;
  const { client, generate } = fakeClient();
  render(
    <>
      <CamTree
        documents={documents}
        model={model}
        camUi={camUi}
        geometer={geometer}
        client={client}
        disabled={options.disabled ?? false}
      />
      <CamSidePanel
        documents={documents}
        camUi={camUi}
        selection={selection}
        resolveFace={async (geo) => ({ ok: true, ref: { face: geo.name } })}
        bodiesOf={() => options.bodies ?? [{ id: 'extrude#1', name: 'Body 1' }]}
        openLibrary={null}
        disabled={options.disabled ?? false}
      />
    </>,
  );
  const cam = () => documents.getState().document.cam;
  return { documents, camUi, selection, generate, cam, geometer };
}

const TWO_BODIES = [
  { id: 'extrude#1', name: 'Body 1' },
  { id: 'extrude#2', name: 'Body 2' },
];

const status = (id: string) => screen.getByTestId(`cam-op-status-${id}`);

describe('CamTree', () => {
  it('starts a setup for the part shown on the default machine with its default post', () => {
    const { cam, documents } = mount(withTool(plywoodDocument()));
    expect(screen.getByTestId('cam-empty').textContent).toContain('Shapeoko 5 Pro 4x4');
    fireEvent.click(screen.getByTestId('cam-add-setup'));
    expect(cam().setups).toHaveLength(1);
    const machine = findMachine('shapeoko-5-pro-4x4')!;
    expect(cam().setups[0]).toMatchObject({
      part: 'part#1',
      machine: machine.id,
      post: defaultPost(machine),
    });
    expect((screen.getByTestId('cam-setup-machine') as HTMLSelectElement).value).toBe(machine.id);
    expect((screen.getByTestId('cam-setup-material') as HTMLSelectElement).value).toBe('plywood');
    expect(documents.getState().undoLabel).toBe('Add CAM setup');
  });

  it('shows each operation resolved ok, and renames, suppresses, reorders and deletes them', async () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face top'),
    });
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#2', 'Face again'),
    });
    const { cam, documents } = mount(doc);
    await waitFor(() => expect(status('facing#1').dataset.state).toBe('ok'));
    expect(status('facing#1').textContent).toBe('ok');
    const ops = () => cam().setups[0]!.operations;

    fireEvent.click(screen.getByLabelText('Rename Face top'));
    fireEvent.change(screen.getByTestId('cam-rename-facing#1'), { target: { value: 'Skim' } });
    fireEvent.keyDown(screen.getByTestId('cam-rename-facing#1'), { key: 'Enter' });
    expect(ops()[0]!.name).toBe('Skim');

    fireEvent.click(screen.getByTestId('cam-suppress-facing#1'));
    expect(ops()[0]!.suppressed).toBe(true);
    await waitFor(() => expect(status('facing#1').dataset.state).toBe('suppressed'));

    fireEvent.click(screen.getByTestId('cam-down-facing#1'));
    expect(ops().map((o) => o.id)).toEqual(['facing#2', 'facing#1']);
    documents.getState().undo();
    expect(ops().map((o) => o.id)).toEqual(['facing#1', 'facing#2']);

    fireEvent.click(screen.getByTestId('cam-delete-facing#2'));
    expect(ops().map((o) => o.id)).toEqual(['facing#1']);
    documents.getState().undo();
    expect(ops().map((o) => o.id)).toEqual(['facing#1', 'facing#2']);
  });

  it('moves an operation to another setup', () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    doc = apply(doc, {
      type: 'addCamSetup',
      setup: { ...doc.cam.setups[0]!, id: 'setup#2', name: 'Back', operations: [] },
    });
    const { cam } = mount(doc);
    fireEvent.change(screen.getByTestId('cam-move-facing#1'), { target: { value: 'setup#2' } });
    expect(cam().setups.map((s) => s.operations.map((o) => o.id))).toEqual([[], ['facing#1']]);
  });

  it('offers to move an operation only to setups of the same part', () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' });
    doc = apply(doc, {
      type: 'addCamSetup',
      setup: {
        ...doc.cam.setups[0]!,
        id: 'setup#2',
        name: 'Lid top',
        part: 'part#2',
        operations: [],
      },
    });
    mount(doc);
    // The only other setup machines the lid: no move is offered.
    expect(screen.queryByTestId('cam-move-facing#1')).toBeNull();
  });

  it('offers to move an operation only to setups of the same body', () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'editCamSetup', setupId: 'setup#1', body: 'extrude#1' });
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    const other = (id: string, name: string, body?: string) => {
      const { body: _body, ...rest } = doc.cam.setups[0]!;
      void _body;
      doc = apply(doc, {
        type: 'addCamSetup',
        setup: { ...rest, id, name, operations: [], ...(body ? { body } : {}) },
      });
    };
    other('setup#2', 'Other body', 'extrude#2');
    other('setup#3', 'No body chosen');
    other('setup#4', 'Same body back', 'extrude#1');
    const { cam } = mount(doc, { bodies: TWO_BODIES });
    const move = screen.getByTestId('cam-move-facing#1') as HTMLSelectElement;
    expect([...move.options].map((o) => o.value)).toEqual(['', 'setup#4']);
    fireEvent.change(move, { target: { value: 'setup#4' } });
    expect(cam().setups.map((s) => s.operations.map((o) => o.id))).toEqual([
      [],
      [],
      [],
      ['facing#1'],
    ]);
  });

  it('ignores the Delete key on a row while the workspace is disabled, like the Delete button', () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    const { cam } = mount(doc, { disabled: true });
    expect((screen.getByTestId('cam-delete-facing#1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId('cam-op-facing#1'), { key: 'Delete' });
    expect(cam().setups[0]!.operations.map((o) => o.id)).toEqual(['facing#1']);
    cleanup();
    const enabled = mount(doc);
    fireEvent.keyDown(screen.getByTestId('cam-op-facing#1'), { key: 'Delete' });
    expect(enabled.cam().setups[0]!.operations).toEqual([]);
  });

  it('shows a lost face as an error with a re-pick that opens the dialog on it', async () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'addCamOperation', setupId: 'setup#1', operation: profileOnFace });
    const { camUi } = mount(doc);
    await waitFor(() => expect(status('profile#1').dataset.state).toBe('error'));
    expect(screen.getByTestId('cam-op-messages-profile#1').textContent).toContain(
      'not on the body',
    );
    fireEvent.click(screen.getByTestId('cam-op-repick-profile#1-0'));
    expect(camUi.getState().dialog).toEqual({
      kind: 'operation',
      operation: 'profile',
      operationId: 'profile#1',
      repick: 0,
    });
    expect(screen.getByTestId('cam-op-dialog')).toBeTruthy();
    expect(screen.getByTestId('cam-source-0').textContent).toContain('not found');
  });

  it('generates on demand, and marks a toolpath stale after its operation changes', async () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    const { generate, documents } = mount(doc);
    await waitFor(() => expect(status('facing#1').dataset.state).toBe('ok'));
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cam-generate'));
    await waitFor(() => expect(status('facing#1').dataset.toolpath).toBe('generated'));
    expect(generate).toHaveBeenCalledTimes(1);
    const sent = generate.mock.calls[0]![0] as unknown as {
      id: string;
      operations: { id: string; loops: unknown[] }[];
    };
    expect(sent.id).toBe('setup#1');
    expect(sent.operations.map((o) => o.id)).toEqual(['facing#1']);
    // A facing with no source faces the whole stock outline.
    expect(sent.operations[0]!.loops).toHaveLength(1);
    expect(screen.getByTestId('cam-generate-message').textContent).toBe(
      'Generated 1 of 1 operation.',
    );
    expect(status('facing#1').dataset.stale).toBe('false');
    act(() => {
      documents.getState().execute(
        {
          type: 'editCamOperation',
          setupId: 'setup#1',
          operation: { ...facing('facing#1', 'Face'), depth: mm('2') },
        },
        'Edit',
      );
    });
    await waitFor(() => expect(status('facing#1').dataset.stale).toBe('true'));
    // Undo puts the inputs the toolpath came from back: it is current again.
    act(() => {
      documents.getState().undo();
    });
    await waitFor(() => expect(status('facing#1').dataset.stale).toBe('false'));
  });

  it('says the geometry is not available without a regen worker, and cannot generate', () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    mount(doc, { geometer: null });
    expect(status('facing#1').dataset.state).toBe('unavailable');
    expect((screen.getByTestId('cam-generate') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the setup panel', () => {
  it('changes machine with its default post, and refuses a retract above the clearance', () => {
    const { cam, documents } = mount(setupDocument());
    fireEvent.change(screen.getByTestId('cam-setup-machine'), {
      target: { value: 'shapeoko-4-xxl' },
    });
    const xxl = findMachine('shapeoko-4-xxl')!;
    expect(cam().setups[0]).toMatchObject({ machine: xxl.id, post: defaultPost(xxl) });
    expect(screen.getByTestId('cam-machine-summary').textContent).toContain('Travel');
    fireEvent.change(screen.getByTestId('cam-stock-retract'), { target: { value: '20 mm' } });
    fireEvent.click(screen.getByTestId('cam-stock-apply'));
    expect(screen.getByTestId('cam-stock-retract-note').textContent).toMatch(
      /not be above the clearance/,
    );
    expect(cam().setups[0]!.heights.retract.source).toBe('5 mm');
    fireEvent.change(screen.getByTestId('cam-stock-retract'), { target: { value: '3 mm' } });
    fireEvent.change(screen.getByTestId('cam-stock-xMin'), { target: { value: '-1' } });
    expect(screen.getByTestId('cam-stock-xMin-note').textContent).toBe(
      'The value must be zero or more.',
    );
    fireEvent.change(screen.getByTestId('cam-stock-xMin'), { target: { value: '10 mm' } });
    fireEvent.click(screen.getByTestId('cam-stock-apply'));
    const setup = cam().setups[0]!;
    expect(setup.heights.retract.source).toBe('3 mm');
    expect(setup.stock.kind === 'fromBody' && setup.stock.margins.xMin.source).toBe('10 mm');
    expect(documents.getState().undoLabel).toBe('Change stock and heights');
  });

  it('takes an explicit stock size', () => {
    const { cam } = mount(setupDocument());
    fireEvent.click(screen.getByTestId('cam-stock-explicit'));
    fireEvent.click(screen.getByTestId('cam-stock-apply'));
    expect(screen.getByTestId('cam-stock-sizeX-note').textContent).toBe('Enter a value.');
    for (const [k, v] of [
      ['sizeX', '100'],
      ['sizeY', '80'],
      ['sizeZ', '18'],
    ] as const) {
      fireEvent.change(screen.getByTestId(`cam-stock-${k}`), { target: { value: v } });
    }
    fireEvent.click(screen.getByTestId('cam-stock-apply'));
    expect(cam().setups[0]!.stock).toMatchObject({
      kind: 'explicit',
      size: { x: { source: '100' }, y: { source: '80' }, z: { source: '18' } },
      offset: { x: { source: '0 mm' } },
      material: 'plywood',
    });
  });

  it('moves the WCS origin (the gizmo follows) and takes a face picked in the view as up', async () => {
    const { cam, selection } = mount(setupDocument());
    fireEvent.change(screen.getByTestId('cam-wcs-corner'), { target: { value: 'centre' } });
    fireEvent.change(screen.getByTestId('cam-wcs-z'), { target: { value: 'bottom' } });
    expect(cam().setups[0]!.wcs.origin).toEqual({ xy: 'centre', z: 'bottom' });
    const gizmo = screen.getByTestId('cam-wcs-gizmo');
    expect(gizmo.dataset.corner).toBe('centre');
    expect(gizmo.dataset.z).toBe('bottom');
    fireEvent.click(screen.getByTestId('cam-wcs-pick'));
    await act(async () => {
      selection.getState().select([geometryRef('face', 'part#1/extrude#1', 'extrude#1:cap:start')]);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(cam().setups[0]!.wcs.up).toEqual({
        kind: 'face',
        face: { id: 'r1', ref: { face: 'extrude#1:cap:start' } },
      }),
    );
    expect((screen.getByTestId('cam-wcs-up') as HTMLSelectElement).value).toBe('face');
    fireEvent.change(screen.getByTestId('cam-wcs-up'), { target: { value: '-z' } });
    expect(cam().setups[0]!.wcs.up).toEqual({ kind: 'axis', axis: '-z' });
  });

  it('shows a machine this version does not know, even one named like a prototype key', () => {
    const doc = setupDocument();
    const odd = apply(doc, {
      type: 'editCamSetup',
      setupId: 'setup#1',
      machine: 'constructor',
      post: 'constructor',
    });
    mount(odd);
    expect(screen.getByTestId('cam-unknown-machine').textContent).toContain('constructor');
    expect((screen.getByTestId('cam-setup-machine') as HTMLSelectElement).value).toBe(
      'constructor',
    );
    expect(
      within(screen.getByTestId('cam-setup-post')).getByText('Unknown: constructor'),
    ).toBeTruthy();
  });

  it('changes the part only while nothing in the setup refers to it', () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' });
    const { cam, documents } = mount(doc);
    const part = () => screen.getByTestId('cam-setup-part') as HTMLSelectElement;
    // No operations and no WCS face: the part can change.
    expect(part().disabled).toBe(false);
    expect(screen.queryByTestId('cam-setup-part-note')).toBeNull();
    fireEvent.change(part(), { target: { value: 'part#2' } });
    expect(cam().setups[0]!.part).toBe('part#2');
    act(() => {
      documents.getState().undo();
    });
    // An operation's faces, sketches and holes are this part's: locked, with the way out.
    act(() => {
      documents
        .getState()
        .execute(
          { type: 'addCamOperation', setupId: 'setup#1', operation: facing('facing#1', 'Face') },
          'Add',
        );
    });
    expect(part().disabled).toBe(true);
    expect(screen.getByTestId('cam-setup-part-note').textContent).toMatch(
      /operations are on this part: start a new setup to machine another part/,
    );
    // A WCS face alone locks it too.
    act(() => {
      documents.getState().undo();
      documents.getState().execute(
        {
          type: 'editCamSetup',
          setupId: 'setup#1',
          wcs: {
            ...cam().setups[0]!.wcs,
            up: { kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
          },
        },
        'Face up',
      );
    });
    expect(part().disabled).toBe(true);
    expect(screen.getByTestId('cam-setup-part-note').textContent).toMatch(
      /WCS face is on this part/,
    );
  });

  it('changes the body only while nothing in the setup refers to it', () => {
    const { documents } = mount(setupDocument(), { bodies: TWO_BODIES });
    const body = () => screen.getByTestId('cam-setup-body') as HTMLSelectElement;
    expect(body().disabled).toBe(false);
    expect(screen.queryByTestId('cam-setup-body-note')).toBeNull();
    fireEvent.change(body(), { target: { value: 'extrude#2' } });
    expect(documents.getState().document.cam.setups[0]!.body).toBe('extrude#2');
    act(() => {
      documents
        .getState()
        .execute(
          { type: 'addCamOperation', setupId: 'setup#1', operation: facing('facing#1', 'Face') },
          'Add',
        );
    });
    expect(body().disabled).toBe(true);
    expect(body().getAttribute('aria-describedby')).toBe('cam-setup-body-note');
    expect(screen.getByTestId('cam-setup-body-note').textContent).toMatch(
      /operations are on this body: start a new setup to machine another body/,
    );
  });

  it('keeps the body locked when a second body appears after the setup was made, and says why', () => {
    // Made while the part had one body: no body is set, so its faces name none. Which of the two
    // bodies they were picked on cannot be told, so choosing one is not offered.
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: facing('facing#1', 'Face'),
    });
    mount(doc, { bodies: TWO_BODIES });
    const body = screen.getByTestId('cam-setup-body') as HTMLSelectElement;
    expect(body.disabled).toBe(true);
    expect(body.value).toBe('');
    expect([...body.options].map((o) => o.textContent)).toEqual(['Not chosen', 'Body 1', 'Body 2']);
    expect(screen.getByTestId('cam-setup-body-note').textContent).toBe(
      "This setup's operations are on a body this setup never chose (the part had one body " +
        'then): start a new setup, choose the body there, and add the operations again.',
    );
  });

  it('calls the empty body option "The only body" on a part with one body', () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'editCamSetup', setupId: 'setup#1', body: 'extrude#1' });
    mount(doc, { bodies: [TWO_BODIES[0]!] });
    const body = screen.getByTestId('cam-setup-body') as HTMLSelectElement;
    expect(body.options[0]!.textContent).toBe('The only body');
  });

  it('refuses a WCS face of another body, and one picked while an undo moved the setup', async () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'editCamSetup', setupId: 'setup#1', body: 'extrude#1' });
    const { cam, camUi, selection } = mount(doc, { bodies: TWO_BODIES });
    fireEvent.click(screen.getByTestId('cam-wcs-pick'));
    await act(async () => {
      selection.getState().select([geometryRef('face', 'part#1/extrude#2', 'extrude#2:cap:end')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(camUi.getState().message).toBe("Pick a face of the setup's body."));
    expect(cam().setups[0]!.wcs.up).toEqual({ kind: 'axis', axis: '+z' });
    expect(camUi.getState().pickingWcs).toBe(true);
  });

  it('refuses a WCS face when the setup machines another part by the time it resolves', async () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' });
    const documents = createDocumentStore(doc);
    const camUi = createCamUiStore();
    camUi.getState().setOpen(true);
    const selection = createSelectionStore();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    render(
      <CamSidePanel
        documents={documents}
        camUi={camUi}
        selection={selection}
        resolveFace={async (geo) => {
          await held;
          return { ok: true, ref: { face: geo.name } };
        }}
        bodiesOf={() => [{ id: 'extrude#1', name: 'Body 1' }]}
        openLibrary={null}
      />,
    );
    fireEvent.click(screen.getByTestId('cam-wcs-pick'));
    await act(async () => {
      selection.getState().select([geometryRef('face', 'part#1/extrude#1', 'extrude#1:cap:end')]);
      await Promise.resolve();
    });
    // The face resolves after the setup was pointed at another part.
    act(() => {
      documents
        .getState()
        .execute({ type: 'editCamSetup', setupId: 'setup#1', part: 'part#2' }, 'Other part');
    });
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() =>
      expect(camUi.getState().message).toBe(
        'The setup now machines another part: pick the face again.',
      ),
    );
    const setup = documents.getState().document.cam.setups[0]!;
    expect(setup.part).toBe('part#2');
    expect(setup.wcs.up).toEqual({ kind: 'axis', axis: '+z' });
  });

  it('shows the document name after a rename is undone, and blur does not apply it again', () => {
    const { cam, documents } = mount(setupDocument());
    const name = () => screen.getByTestId('cam-setup-name') as HTMLInputElement;
    fireEvent.change(name(), { target: { value: 'Top side' } });
    fireEvent.keyDown(name(), { key: 'Enter' });
    expect(cam().setups[0]!.name).toBe('Top side');
    act(() => {
      documents.getState().undo();
    });
    expect(name().value).toBe('Setup 1');
    fireEvent.blur(name());
    expect(cam().setups[0]!.name).toBe('Setup 1');
    expect(documents.getState().redoLabel).toBe('Rename CAM setup');
  });

  it('deletes the setup, one undo step', () => {
    const { cam, documents } = mount(setupDocument());
    fireEvent.click(screen.getByTestId('cam-delete-setup'));
    expect(cam().setups).toEqual([]);
    documents.getState().undo();
    expect(cam().setups).toHaveLength(1);
  });
});
