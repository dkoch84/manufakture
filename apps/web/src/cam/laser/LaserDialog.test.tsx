// The laser and plasma export dialog with a scripted geometry stage and section: faces picked in
// the view, sketch regions and sections added from the lists, layer names, the outline's size,
// the kerf checked as typed (with visible messages), and the file handed to the download.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Loop2, PlanarLoops } from '@manufakture/cam';
import type { ManufaktureDocument } from '@manufakture/core';
import type { CamGeometryResult, CamSourceResult } from '@manufakture/regen';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore, geometryRef, type GeometryRef } from '../../state/selection';
import { setupDocument } from '../cam.test-fixture';
import type { CamGeometer } from '../geometer';
import type { FacePick } from '../picking';
import { middleAlong, type LaserBody } from '@manufakture/cam/export';
import { LaserDialog } from './LaserDialog';
import { svgLoops } from './readBack.test-fixture';

afterEach(cleanup);

/** A 20 x 4 mm counter-clockwise rectangle on the plane Z = 6. */
const rect: Loop2 = {
  segments: [
    { kind: 'line', start: [0, 0], end: [20, 0] },
    { kind: 'line', start: [20, 0], end: [20, 4] },
    { kind: 'line', start: [20, 4], end: [0, 4] },
    { kind: 'line', start: [0, 4], end: [0, 0] },
  ],
};
const TOP: PlanarLoops = { origin: [0, 0, 6], xDir: [1, 0, 0], normal: [0, 0, 1], loops: [rect] };

function fakeGeometer(): CamGeometer {
  return {
    geometry: vi.fn(async (document: ManufaktureDocument, setupId: string) => {
      const setup = document.cam.setups.find((s) => s.id === setupId)!;
      const op = setup.operations[0]!;
      const sources: CamSourceResult[] = op.geometry.map((g, i) =>
        g.kind === 'face'
          ? { source: i, kind: 'face', z: 6, facing: true, planar: TOP }
          : { source: i, kind: 'region', z: 6, planar: TOP },
      );
      return {
        generation: 1,
        setupId,
        partId: setup.part,
        bodyId: 'extrude#1',
        bodyKey: 'b',
        key: 'k',
        status: 'ok',
        errors: [],
        warnings: [],
        references: [],
        bounds: null,
        setup: null,
        operations: [
          {
            operationId: op.id,
            kind: op.kind,
            key: 'k',
            status: 'error',
            errors: [],
            warnings: [],
            references: [],
            sources,
            values: null,
          },
        ],
        cached: false,
        ms: 1,
      } as CamGeometryResult;
    }),
  };
}

async function fakeFace(geo: GeometryRef): Promise<FacePick> {
  if (geo.name.startsWith('curved'))
    return { ok: false, message: 'Pick a planar face: CAM takes flat faces only.' };
  return { ok: true, ref: { face: geo.name } };
}

const BODY: LaserBody = {
  bodyId: 'extrude#1',
  viewId: 'part#1/extrude#1',
  name: 'Plate',
  bounds: { min: [0, -2, 0], max: [20, 4, 6] },
};

function mount(document: ManufaktureDocument = setupDocument(), body: LaserBody = BODY) {
  const documents = createDocumentStore(document);
  const selection = createSelectionStore();
  const onSave = vi.fn();
  const onClose = vi.fn();
  const section = vi.fn(async () => ({
    ok: true as const,
    value: {
      height: 0,
      regions: [
        {
          outer: {
            area: 80,
            segments: rect.segments.map((s) => ({
              kind: 'line' as const,
              start: [s.start[0], s.start[1]] as [number, number],
              end: [s.end[0], s.end[1]] as [number, number],
            })),
          },
          holes: [],
        },
      ],
      open: [],
    },
  }));
  const services = { geometer: fakeGeometer(), section };
  render(
    <LaserDialog
      documents={documents}
      partId="part#1"
      bodies={[body]}
      selection={selection}
      resolveFace={vi.fn((geo: GeometryRef) => fakeFace(geo))}
      services={services}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  const pick = async (name: string) => {
    await act(async () => {
      selection.getState().select([geometryRef('face', 'part#1/extrude#1', name)]);
      await Promise.resolve();
    });
  };
  return { onSave, onClose, pick, section, services };
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
const outline = () => screen.getByTestId('laser-outline');
const exportButton = () => screen.getByTestId('laser-export') as HTMLButtonElement;

describe('the laser and plasma export dialog', () => {
  it('reads a picked face, shows its size and exports it as SVG', async () => {
    const { onSave, pick } = mount();
    expect(outline().dataset.state).toBe('empty');
    expect(exportButton().disabled).toBe(true);
    await pick('extrude#1:top');
    await waitFor(() => expect(outline().dataset.state).toBe('ok'));
    expect(screen.getByTestId('laser-source-0').textContent).toContain('Face extrude#1:top');
    expect((screen.getByTestId('laser-layer-0') as HTMLInputElement).value).toBe('face-1');
    expect(outline().textContent).toContain('Outline 20 x 4 mm: 1 loop on 1 layer.');
    type('laser-layer-0', 'cut');
    await waitFor(() => expect(outline().dataset.state).toBe('ok'));
    type('laser-format', 'svg');
    type('laser-kerf', '0.2');
    expect(exportButton().disabled).toBe(false);
    fireEvent.click(exportButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    const [file, message] = onSave.mock.calls[0]! as [
      { name: string; bytes: Uint8Array; type: string },
      string,
    ];
    expect(file.name).toBe('Plate.svg');
    expect(file.type).toBe('image/svg+xml');
    expect(message).toMatch(/^Exported Plate\.svg \(.*\): 20\.2 x 4\.2 mm, kerf 0\.2 mm\.$/);
    expect(screen.getByTestId('laser-result').textContent).toContain('Exported Plate.svg');
    const [loop] = svgLoops(new TextDecoder().decode(file.bytes));
    expect(loop!.layer).toBe('cut');
    // 20 x 4 grown by 0.1 all round, with round outside corners: + P d + pi d^2.
    expect(loop!.area).toBeCloseTo(80 + 48 * 0.1 + Math.PI * 0.01, 2);
  });

  it('checks the kerf as it is typed, with a visible message', async () => {
    const { pick } = mount();
    await pick('extrude#1:top');
    await waitFor(() => expect(outline().dataset.state).toBe('ok'));
    type('laser-kerf', '-0.1');
    expect(screen.getByTestId('laser-kerf-error').textContent).toBe(
      'The kerf must be zero or more.',
    );
    expect(exportButton().disabled).toBe(true);
    type('laser-kerf', '1.5');
    expect(screen.getByTestId('laser-kerf-error').textContent).toBe(
      'The kerf is too wide for this outline (20 x 4 mm): at most 1 mm, a quarter of its smaller side.',
    );
    expect(exportButton().disabled).toBe(true);
    type('laser-kerf', '12');
    expect(screen.getByTestId('laser-kerf-error').textContent).toMatch(/^A kerf over 10 mm/);
    type('laser-kerf', '');
    expect(screen.queryByTestId('laser-kerf-error')).toBeNull();
    expect(exportButton().disabled).toBe(false);
  });

  it('refuses a curved face, and adds sketch regions and a section on layers of their own', async () => {
    const { pick, section } = mount();
    await pick('curved#1');
    expect(screen.getByTestId('laser-pick-message').textContent).toBe(
      'Pick a planar face: CAM takes flat faces only.',
    );
    fireEvent.click(screen.getByTestId('laser-add-region'));
    // The section's plane defaults to the middle of the body along the axis.
    type('laser-section-axis', 'z');
    expect((screen.getByTestId('laser-section-position') as HTMLInputElement).value).toBe('3 mm');
    fireEvent.click(screen.getByTestId('laser-add-section'));
    await waitFor(() => expect(outline().dataset.state).toBe('ok'));
    expect(screen.getByTestId('laser-source-0').textContent).toMatch(/^Regions of /);
    expect(screen.getByTestId('laser-source-1').textContent).toContain('Section across Z at 3 mm');
    expect(section).toHaveBeenCalledWith(
      'part#1/extrude#1',
      { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
      3,
      0.01,
    );
    expect(outline().textContent).toContain('2 loops on 2 layers');
    // An empty layer name is refused by name.
    type('laser-layer-1', ' ');
    await waitFor(() => expect(outline().dataset.state).toBe('error'));
    expect(outline().textContent).toContain('give it a layer name');
    fireEvent.click(screen.getByRole('button', { name: /^Remove Section/ }));
    await waitFor(() => expect(outline().dataset.state).toBe('ok'));
  });

  it('puts the default section plane through the body in an inch document too', async () => {
    // A body straddling the origin, 2 in (50.8 mm) wide along X: its middle is 12.7 mm, which a
    // bare "12.7" would read as 12.7 in.
    const inches = {
      ...setupDocument(),
      units: { length: { unit: 'in' as const }, angle: { unit: 'deg' as const } },
    };
    const straddling: LaserBody = {
      ...BODY,
      bounds: { min: [-12.7, -2, 0], max: [38.1, 4, 6] },
    };
    const { section } = mount(inches, straddling);
    type('laser-section-axis', 'x');
    expect((screen.getByTestId('laser-section-position') as HTMLInputElement).value).toBe(
      '12.7 mm',
    );
    fireEvent.click(screen.getByTestId('laser-add-section'));
    await waitFor(() => expect(outline().dataset.state).toBe('ok'));
    expect(screen.getByTestId('laser-source-0').textContent).toContain(
      'Section across X at 12.7 mm',
    );
    expect(section).toHaveBeenCalledWith(
      'part#1/extrude#1',
      { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
      12.7,
      0.01,
    );
  });

  it('closes on Escape and with Close', () => {
    const { onClose } = mount();
    fireEvent.keyDown(screen.getByTestId('laser-dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('laser-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('puts a section plane through the middle of the body by default', () => {
    expect(middleAlong(BODY, 'x')).toBe(10);
    expect(middleAlong(BODY, 'y')).toBe(1);
    expect(middleAlong(undefined, 'y')).toBe(0);
  });
});
