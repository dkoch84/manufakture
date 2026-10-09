// The export dialog in the Manufacture workspace, with a fake geometry stage and CAM worker:
// Export generates what is out of date first (with progress and a Cancel), shows the summary and
// the setup sheet, and saves through the download it is given; it refuses, with the reason, when
// an operation has an error or the post cannot write the job.

import { packToolpath } from '@manufakture/cam';
import type { CamClient } from '@manufakture/cam/client';
import type { CamOperation, ManufaktureDocument } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportedFile } from '../../io/actions';
import { createModelStore } from '../../model/model';
import { createDocumentStore } from '../../state/document';
import { apply, mm, setupDocument } from '../cam.test-fixture';
import { CamTree } from '../CamWorkspace';
import type { CamGeometer } from '../geometer';
import { createCamUiStore } from '../state';
import { square } from './export.test-fixture';

afterEach(cleanup);

const facing = (id: string, name: string): CamOperation => ({
  id,
  kind: 'facing',
  name,
  suppressed: false,
  tool: 'tool#1',
  geometry: [],
  depth: mm('1'),
  angle: mm('0'),
});

const lostProfile: CamOperation = {
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

/**
 * A stage resolving every operation as a facing with tool number `toolNumber` (none for null);
 * `gone` faces are lost. An operation's key covers it and the setup's stock and heights. While
 * `gate.hold` is set, replies wait until `gate.release()`.
 */
function fakeGeometer(toolNumber: number | null = 201, gate?: Gate): CamGeometer {
  return {
    geometry: vi.fn(async (doc: ManufaktureDocument, setupId: string) => {
      if (gate?.hold) await new Promise<void>((resolve) => gate.waiting.push(resolve));
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
          const lost = op.geometry.some((s) => s.kind === 'face' && s.face.ref.face === 'gone');
          const base = {
            operationId: op.id,
            kind: op.kind,
            key: JSON.stringify([rest, setup.stock, setup.heights]),
            warnings: [],
            references: [],
            sources: [],
          };
          if (op.suppressed)
            return { ...base, status: 'suppressed' as const, errors: [], values: null };
          if (lost) {
            return {
              ...base,
              status: 'error' as const,
              errors: [
                {
                  code: 'reference-lost' as const,
                  message: 'Face gone is not on the body',
                  source: 0,
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
                name: '#201 1/4" flat',
                kind: 'flat' as const,
                ...(toolNumber !== null ? { number: toolNumber } : {}),
                diameter: 6.35,
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
}

interface Gate {
  hold: boolean;
  waiting: (() => void)[];
}

function gate(): Gate & { release(): void } {
  const g: Gate & { release(): void } = {
    hold: false,
    waiting: [],
    release() {
      g.hold = false;
      for (const w of g.waiting.splice(0)) w();
    },
  };
  return g;
}

/** A worker that answers each operation with a square; `hold` keeps the reply until cancelled. */
function fakeClient(hold = false) {
  let release: ((v: null) => void) | null = null;
  const generate = vi.fn(
    async (setup: { id: string; operations: readonly { id: string; kind: string }[] }) => {
      if (hold) return new Promise<null>((resolve) => (release = resolve));
      return {
        status: 'done' as const,
        generation: 1,
        setup: setup.id,
        operations: setup.operations.map((o, i) => ({
          id: o.id,
          kind: o.kind,
          key: `tp-${o.id}`,
          cached: false,
          ms: 1,
          ok: true as const,
          toolpath: packToolpath(square(o.id, 5 + 12 * i, 5, 10, -1)),
          warnings: [],
        })),
        ms: 1,
      };
    },
  );
  const cancel = vi.fn(async () => {
    release?.(null);
  });
  return { client: { generate, cancel } as unknown as CamClient, generate, cancel };
}

function mount(doc: ManufaktureDocument, options: { geometer?: CamGeometer; hold?: boolean } = {}) {
  const documents = createDocumentStore(doc);
  const camUi = createCamUiStore();
  camUi.getState().setOpen(true);
  const { client, generate, cancel } = fakeClient(options.hold ?? false);
  const saved: ExportedFile[] = [];
  render(
    <CamTree
      documents={documents}
      model={createModelStore()}
      camUi={camUi}
      geometer={options.geometer ?? fakeGeometer()}
      client={client}
      onSave={(f) => saved.push(f)}
    />,
  );
  return { documents, camUi, generate, cancel, saved };
}

function withOps(...ops: CamOperation[]): ManufaktureDocument {
  let doc = setupDocument();
  for (const operation of ops) {
    doc = apply(doc, { type: 'addCamOperation', setupId: 'setup#1', operation });
  }
  return doc;
}

const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

describe('ExportDialog', () => {
  it('generates what is out of date, summarises the job and saves the G-code', async () => {
    const { generate, saved } = mount(
      withOps(facing('facing#1', 'Face'), facing('facing#2', 'Skim')),
    );
    fireEvent.click(screen.getByTestId('cam-export'));
    expect(screen.getByTestId('cam-export-dialog')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('cam-export-summary')).toBeTruthy());
    expect(generate).toHaveBeenCalledTimes(1);
    // The setup's post (the machine's default on a new setup): Carbide Motion, one file.
    expect((screen.getByTestId('cam-export-post') as HTMLSelectElement).value).toBe(
      'carbide-motion',
    );
    expect(button('cam-export-multitool').disabled).toBe(true);
    expect(screen.getByTestId('cam-export-tools').textContent).toBe('T201 #201 1/4" flat: Face');
    expect(screen.getByTestId('cam-export-time').textContent).toMatch(/^\d+:\d\d /);
    expect(screen.getByTestId('cam-export-extents').textContent).toMatch(/^X 0 mm to /);
    const sheet = screen.getByTestId('cam-export-sheet') as HTMLIFrameElement;
    expect(sheet.getAttribute('srcdoc')).toContain('data-sheet="tool-changes"');

    fireEvent.click(button('cam-export-save'));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/ - Setup 1\.nc$/);
    const text = new TextDecoder().decode(saved[0]!.bytes);
    expect(text).toMatch(/^M6 T201$/m);
    expect(text).toMatch(/^\(Face\)$/m);
    expect(text).toMatch(/^\(Skim\)$/m);
    expect(screen.getByTestId('cam-export-saved').textContent).toMatch(/^Saved .*\.nc \(/);

    // The setup sheet saves on its own too.
    fireEvent.click(button('cam-export-save-sheet'));
    expect(saved[1]!.name).toMatch(/ - Setup 1 - setup sheet\.html$/);
    expect(saved[1]!.type).toBe('text/html');

    // Inches: the file says G20.
    fireEvent.change(screen.getByTestId('cam-export-units'), { target: { value: 'inch' } });
    fireEvent.click(button('cam-export-save'));
    expect(new TextDecoder().decode(saved[2]!.bytes)).toMatch(/^G20 /m);

    fireEvent.click(screen.getByTestId('cam-export-close'));
    expect(screen.queryByTestId('cam-export-dialog')).toBeNull();
  });

  it('refuses with the reason when an operation has an error', async () => {
    const { saved } = mount(withOps(facing('facing#1', 'Face'), lostProfile));
    fireEvent.click(screen.getByTestId('cam-export'));
    await waitFor(() =>
      expect(screen.getByTestId('cam-export-refused').textContent).toContain(
        'Outline: Face gone is not on the body',
      ),
    );
    expect(screen.queryByTestId('cam-export-summary')).toBeNull();
    expect(button('cam-export-save').disabled).toBe(true);
    fireEvent.click(button('cam-export-save'));
    expect(saved).toEqual([]);
  });

  it("refuses with the post's reason, and exports once another post can write the job", async () => {
    mount(withOps(facing('facing#1', 'Face')), { geometer: fakeGeometer(null) });
    fireEvent.click(screen.getByTestId('cam-export'));
    await waitFor(() =>
      expect(screen.getByTestId('cam-export-refused').textContent).toMatch(
        /The Carbide Motion post refuses the job: /,
      ),
    );
    expect(button('cam-export-save').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('cam-export-post'), { target: { value: 'grbl' } });
    await waitFor(() => expect(screen.getByTestId('cam-export-summary')).toBeTruthy());
    expect(screen.queryByTestId('cam-export-refused')).toBeNull();
    expect(button('cam-export-save').disabled).toBe(false);
    const modes = [
      ...(screen.getByTestId('cam-export-multitool') as HTMLSelectElement).options,
    ].map((o) => o.value);
    expect(modes).toEqual(['files', 'pause']);
  });

  it('does not export toolpaths of an older document: it waits for the geometry and generates', async () => {
    const g = gate();
    const { documents, generate, saved } = mount(withOps(facing('facing#1', 'Face')), {
      geometer: fakeGeometer(201, g),
    });
    // Generated and exportable.
    fireEvent.click(screen.getByTestId('cam-export'));
    await waitFor(() => expect(button('cam-export-save').disabled).toBe(false));
    expect(generate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('cam-export-close'));

    // An edit to the stock, then the dialog again before the geometry of the edit has come.
    g.hold = true;
    const setup = documents.getState().document.cam.setups[0]!;
    const stock = setup.stock;
    if (stock.kind !== 'fromBody') throw new Error('A new setup has stock from the body.');
    const r = documents.getState().execute(
      {
        type: 'editCamSetup',
        setupId: setup.id,
        stock: { ...stock, margins: { ...stock.margins, top: mm('3') } },
      },
      'Edit stock',
    );
    expect(r.ok).toBe(true);
    fireEvent.click(screen.getByTestId('cam-export'));
    expect(button('cam-export-save').disabled).toBe(true);
    expect(screen.queryByTestId('cam-export-summary')).toBeNull();
    expect(screen.getByTestId('cam-export-progress').textContent).toContain(
      'Resolving the geometry',
    );
    fireEvent.click(button('cam-export-save'));
    expect(saved).toEqual([]);

    // The reply for the edited document: the operation is stale, so it generates again.
    g.release();
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button('cam-export-save').disabled).toBe(false));

    // An edit while the dialog is open: pending again, and it generates once more.
    g.hold = true;
    const next = documents.getState().document.cam.setups[0]!;
    documents.getState().execute(
      {
        type: 'editCamSetup',
        setupId: next.id,
        heights: { ...next.heights, clearance: mm('12') },
      },
      'Edit clearance',
    );
    await waitFor(() => expect(button('cam-export-save').disabled).toBe(true));
    g.release();
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(button('cam-export-save').disabled).toBe(false));
    fireEvent.click(button('cam-export-save'));
    expect(saved).toHaveLength(1);
  });

  it('gives the setup sheet a sandboxed frame that can still print', async () => {
    mount(withOps(facing('facing#1', 'Face')));
    fireEvent.click(screen.getByTestId('cam-export'));
    await waitFor(() => expect(screen.getByTestId('cam-export-sheet')).toBeTruthy());
    expect(screen.getByTestId('cam-export-sheet').getAttribute('sandbox')).toBe(
      'allow-same-origin allow-modals',
    );
  });

  it('shows the progress of the generation and cancels it', async () => {
    const { cancel, generate } = mount(withOps(facing('facing#1', 'Face')), { hold: true });
    fireEvent.click(screen.getByTestId('cam-export'));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(screen.getByTestId('cam-export-progress').textContent).toMatch(
      /Generating toolpaths\.\.\. \(1 operation out of date\)/,
    );
    fireEvent.click(screen.getByTestId('cam-export-cancel'));
    expect(cancel).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('cam-export-progress').textContent).toContain(
        'Generation cancelled. 1 operation needs generating before export.',
      ),
    );
    expect(button('cam-export-save').disabled).toBe(true);
    expect(screen.getByTestId('cam-export-generate')).toBeTruthy();
  });
});
