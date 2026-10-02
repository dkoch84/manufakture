// The export section of the print panel and the Open in slicer help: an export downloads the
// setup's 3MF under `<document>-<setup>.3mf`, a refused one says why with its buttons off, Open
// in slicer shows the help once per slicer, and the slicer chosen is kept with the view settings.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { validate3mf } from '@manufakture/io';
import type { MeshData } from '@manufakture/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManufaktureDocument } from '@manufakture/core';
import type { ExportedFile } from '../io/actions';
import type { PartModel } from '../model/model';
import { VIEW_SETTINGS_KEY, createViewSettingsStore } from '../state/viewSettings';
import { editSetupCommand } from './commands';
import { PrintExport, type PrintExportProps, type PrintExporter } from './PrintExport';
import { SlicerHandoff } from './SlicerHandoff';
import { apply, boxPart, partsDocument, setupOf, withSetup } from './print.test-fixture';
import { resolveSetup } from './resolve';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function exporter(parts: readonly PartModel[], exclusive: PrintExporter['exclusive'] = null) {
  const views = parts.flatMap((p) => p.bodies.map((b) => b.view));
  return {
    exchanger: {
      tessellate: vi.fn(async (ids: readonly string[]) => ({
        ok: true as const,
        value: ids.map((id) => ({
          name: id,
          mesh: views.find((v) => v.id === id)!.mesh as MeshData,
        })),
      })),
    },
    exclusive,
  };
}

function mount(
  doc: ManufaktureDocument,
  setupId: string,
  parts: readonly PartModel[],
  ex: PrintExporter | null = exporter(parts),
  extra: Partial<PrintExportProps> = {},
) {
  const settings = createViewSettingsStore();
  const download = vi.fn<(f: ExportedFile) => void>();
  const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
  const view = render(
    <PrintExport
      doc={doc}
      resolved={resolved}
      issues={[]}
      exporter={ex}
      settings={settings}
      download={download}
      {...extra}
    />,
  );
  return { settings, download, view };
}

/** A document with configuration rows 20 and 30 (#w), named Jig, and a setup printing part#1. */
function configured() {
  const doc = withSetup(partsDocument(), [{ part: 'part#1' }]);
  const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;
  let d = apply(doc.doc, { type: 'setVariable', name: 'w', expression: mm('20 mm') });
  d = apply(d, {
    type: 'setConfigParameter',
    parameter: { id: 'cp#1', name: 'Width', kind: 'variable', variable: 'w' },
  });
  for (const w of ['20', '30']) {
    d = apply(d, {
      type: 'setConfigRow',
      row: { id: `cfg#${w}`, name: w, values: { 'cp#1': mm(`${w} mm`) } },
    });
  }
  return { doc: named(d), setupId: doc.setupId };
}

const box = (size: [number, number, number] = [20, 20, 10]) => [
  boxPart('part#1', [{ bodyId: 'extrude#1', size }]),
];

function named(doc: ManufaktureDocument): ManufaktureDocument {
  return apply(doc, { type: 'renameDocument', name: 'Jig' });
}

describe('PrintExport', () => {
  it('exports the setup as <document>-<setup>.3mf', async () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const parts = box();
    const { download } = mount(named(built.doc), built.setupId, parts);
    expect(screen.queryByTestId('print-export-refusal')).toBeNull();
    fireEvent.click(screen.getByTestId('print-export-button'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const file = download.mock.calls[0]![0];
    expect(file.name).toBe('Jig-Plate 1.3mf');
    expect(validate3mf(file.bytes).problems).toEqual([]);
    expect(screen.getByTestId('print-export-status').textContent).toMatch(
      /^Exported Jig-Plate 1\.3mf .*: 1 copy of 1 item on the Bambu Lab X1 Carbon's plate\.$/,
    );
    // A plain export does not show the slicer help.
    expect(screen.queryByTestId('slicer-handoff')).toBeNull();
  });

  it('exports one STL per body when asked', async () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const { download } = mount(named(built.doc), built.setupId, box());
    fireEvent.change(screen.getByTestId('print-export-format'), { target: { value: 'stl' } });
    fireEvent.change(screen.getByTestId('print-export-tolerance'), { target: { value: 'fine' } });
    fireEvent.click(screen.getByTestId('print-export-button'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0]![0].name).toBe('Jig-Plate 1-Part 1.stl');
  });

  it('refuses a part too big for the bed, naming the axis, with the buttons off', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const doc = apply(built.doc, editSetupCommand(built.setupId, { printer: 'bambu-a1-mini' }));
    mount(doc, built.setupId, box([200, 20, 10]));
    expect(screen.getByTestId('print-export-refusal').textContent).toBe(
      "Not exported. Part 1 does not fit the Bambu Lab A1 mini's bed: too big by x 20.00 mm.",
    );
    expect((screen.getByTestId('print-export-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('print-open-slicer') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says an empty setup has nothing to export, without an error', () => {
    const built = withSetup(partsDocument(), []);
    mount(built.doc, built.setupId, box());
    expect(screen.getByTestId('print-export-empty')).toBeTruthy();
    expect(screen.queryByTestId('print-export-refusal')).toBeNull();
    expect((screen.getByTestId('print-export-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('waits for the model, and says when there is no kernel', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    mount(built.doc, built.setupId, [], null);
    expect(screen.getByTestId('print-export-waiting')).toBeTruthy();
    expect(screen.getByTestId('print-export-unavailable').textContent).toBe(
      'Export needs the geometry kernel.',
    );
    expect(screen.queryByTestId('print-export-refusal')).toBeNull();
    expect((screen.getByTestId('print-export-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('waits while the model regenerates, though the setup resolves against the last one', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const parts = box();
    const ex = exporter(parts);
    mount(built.doc, built.setupId, parts, ex, { modelPending: true });
    expect(screen.getByTestId('print-export-waiting').textContent).toBe('Waiting for the model.');
    for (const id of ['print-export-button', 'print-open-slicer']) {
      const button = screen.getByTestId(id) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(ex.exchanger.tessellate).not.toHaveBeenCalled();
  });

  it('keeps Export all configurations off while the model regenerates', () => {
    const { doc, setupId } = configured();
    const parts = box();
    const exclusive = vi.fn() as unknown as NonNullable<PrintExporter['exclusive']>;
    mount(doc, setupId, parts, exporter(parts, exclusive), { modelPending: true });
    const button = screen.getByTestId('print-export-configurations') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(exclusive).not.toHaveBeenCalled();
  });

  it('does not mesh while the kernel holds another document, and tells the app it is busy', async () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const parts = box();
    let held = true;
    const ex = { ...exporter(parts), busy: () => held };
    const onBusy = vi.fn<(busy: boolean) => void>();
    const { download } = mount(named(built.doc), built.setupId, parts, ex, { onBusy });
    fireEvent.click(screen.getByTestId('print-export-button'));
    expect(screen.getByTestId('print-export-status').textContent).toMatch(/^The kernel is busy/);
    expect(ex.exchanger.tessellate).not.toHaveBeenCalled();
    expect(onBusy).not.toHaveBeenCalled();

    held = false;
    fireEvent.click(screen.getByTestId('print-export-button'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onBusy.mock.calls).toEqual([[true], [false]]));
  });

  it('cancels an export of every configuration when it is closed', async () => {
    const { doc, setupId } = configured();
    const parts = box();
    let release: () => void = () => {};
    const exclusive = vi.fn(async (work: (regen: never) => Promise<unknown>) =>
      work((async () => {
        // Held in the first row's regen until the panel is gone.
        await new Promise<void>((resolve) => (release = resolve));
        return { generation: 1, ms: 1, parts };
      }) as never),
    ) as unknown as NonNullable<PrintExporter['exclusive']>;
    const onBusy = vi.fn<(busy: boolean) => void>();
    const { download, view } = mount(doc, setupId, parts, exporter(parts, exclusive), { onBusy });
    fireEvent.click(screen.getByTestId('print-export-configurations'));
    await waitFor(() => expect(exclusive).toHaveBeenCalled());
    expect(onBusy.mock.calls).toEqual([[true]]);
    view.unmount();
    release();
    // Not cancelled, the row would have been exported and downloaded now.
    await waitFor(() => expect(onBusy.mock.calls).toEqual([[true], [false]]));
    expect(download).not.toHaveBeenCalled();
  });

  it('Open in slicer downloads the 3MF and shows the help once per slicer', async () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const { download, settings } = mount(named(built.doc), built.setupId, box());
    // Whatever the format chosen, Open in slicer writes the 3MF.
    fireEvent.change(screen.getByTestId('print-export-format'), { target: { value: 'stl' } });
    fireEvent.click(screen.getByTestId('print-open-slicer'));
    await waitFor(() => expect(screen.getByTestId('slicer-handoff')).toBeTruthy());
    expect(download.mock.calls[0]![0].name).toBe('Jig-Plate 1.3mf');
    const help = screen.getByTestId('slicer-handoff');
    expect(help.getAttribute('role')).toBe('region');
    expect(help.dataset.slicer).toBe('orcaslicer');
    expect(screen.getByTestId('slicer-steps').textContent).toContain('Jig-Plate 1.3mf');
    fireEvent.click(screen.getByTestId('slicer-handoff-close'));
    expect(screen.queryByTestId('slicer-handoff')).toBeNull();
    expect(settings.getState().slicerHelpDismissed).toEqual(['orcaslicer']);

    // Again: downloaded, no help; it can still be asked for.
    fireEvent.click(screen.getByTestId('print-open-slicer'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('slicer-handoff')).toBeNull();
    fireEvent.click(screen.getByTestId('print-slicer-help'));
    expect(screen.getByTestId('slicer-handoff')).toBeTruthy();

    // Another slicer chosen in the help and closed: read for that one too. A third one's help
    // is shown after the next Open in slicer.
    fireEvent.change(screen.getByTestId('slicer-choice'), { target: { value: 'bambustudio' } });
    fireEvent.click(screen.getByTestId('slicer-handoff-close'));
    expect(settings.getState().slicerHelpDismissed).toEqual(['orcaslicer', 'bambustudio']);
    act(() => settings.getState().setSlicer('prusaslicer'));
    fireEvent.click(screen.getByTestId('print-open-slicer'));
    await waitFor(() =>
      expect(screen.getByTestId('slicer-handoff').dataset.slicer).toBe('prusaslicer'),
    );
  });

  it('exports every configuration through the exclusive regen', async () => {
    const doc = configured();
    const parts = box();
    const exclusive = vi.fn(async (work: (regen: never) => Promise<unknown>) =>
      work((async () => ({ generation: 1, ms: 1, parts })) as never),
    ) as unknown as NonNullable<PrintExporter['exclusive']>;
    const { download } = mount(doc.doc, doc.setupId, parts, exporter(parts, exclusive));
    fireEvent.click(screen.getByTestId('print-export-configurations'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(download.mock.calls.map((c) => c[0].name)).toEqual([
      'Jig-Plate 1-20.3mf',
      'Jig-Plate 1-30.3mf',
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('print-export-status').textContent).toBe(
        'Exported 2 of 2 configurations: Jig-Plate 1-20.3mf, Jig-Plate 1-30.3mf.',
      ),
    );
  });
});

describe('SlicerHandoff', () => {
  it('explains the steps for the slicer and platform, as text', () => {
    const settings = createViewSettingsStore();
    const onClose = vi.fn();
    render(
      <SlicerHandoff
        fileName={'<img src=x onerror=alert(1)>.3mf'}
        settings={settings}
        onClose={onClose}
        platform="macos"
      />,
    );
    const steps = screen.getByTestId('slicer-steps');
    // The name is shown as text, never parsed as markup.
    expect(steps.querySelector('img')).toBeNull();
    expect(steps.textContent).toContain('<img src=x onerror=alert(1)>.3mf');
    expect(steps.textContent).toContain('File > Get Info');
    expect(steps.textContent).toContain('OrcaSlicer');
    expect(steps.textContent).not.toMatch(/always open/i);
    fireEvent.change(screen.getByTestId('slicer-platform'), { target: { value: 'windows' } });
    expect(screen.getByTestId('slicer-steps').textContent).toContain('Choose another app');
    fireEvent.change(screen.getByTestId('slicer-choice'), { target: { value: 'prusaslicer' } });
    expect(settings.getState().slicer).toBe('prusaslicer');
    expect(screen.getByTestId('slicer-handoff').textContent).toContain('not their colours');
    fireEvent.click(screen.getByTestId('slicer-handoff-close'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(settings.getState().slicerHelpDismissed).toEqual(['prusaslicer']);
  });

  it('remembers the slicer across a reload', () => {
    const a = createViewSettingsStore();
    a.getState().setSlicer('bambustudio');
    expect(JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY)!).state.slicer).toBe('bambustudio');
    render(
      <SlicerHandoff fileName="a.3mf" settings={createViewSettingsStore()} onClose={() => {}} />,
    );
    expect((screen.getByTestId('slicer-choice') as HTMLSelectElement).value).toBe('bambustudio');
  });
});
