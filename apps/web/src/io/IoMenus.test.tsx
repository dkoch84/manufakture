import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chosenBodies, type ExportableBody } from './chosenBodies';
import { ExportMenu, ExportProgress } from './IoMenus';
import { exportSourceStore } from './exportSource';
import { agentSource } from './exportGate.test-fixture';
import { UNREVIEWED_EXPORT } from '@manufakture/io';

// Main is open: the export gate (T8.3c) lets these exports through unless a test says otherwise.
beforeEach(() => exportSourceStore.setState({ source: { id: 'main' } }));

const body = (id: string, hidden = false): ExportableBody => ({ id, name: id, hidden });

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Export' }));
const item = (format: string) => screen.getByTestId(`export-${format}`) as HTMLButtonElement;

describe('the Export menu', () => {
  it('chooses the shown bodies unless ticked otherwise', () => {
    const bodies = [body('a'), body('b', true)];
    expect(chosenBodies(bodies, new Map())).toEqual(['a']);
    expect(chosenBodies(bodies, new Map([['b', true]]))).toEqual(['a', 'b']);
    expect(chosenBodies(bodies, new Map([['a', false]]))).toEqual([]);
  });

  it('does not export a single hidden body, and says why', () => {
    const onExport = vi.fn();
    render(<ExportMenu bodies={[body('only', true)]} onExport={onExport} />);
    open();
    expect(item('3mf').disabled).toBe(true);
    expect(screen.getByTestId('export-nothing').textContent).toBe(
      'The body is hidden: show it to export it.',
    );
  });

  it('exports a single shown body', () => {
    const onExport = vi.fn();
    render(<ExportMenu bodies={[body('only')]} onExport={onExport} />);
    open();
    fireEvent.click(item('step'));
    expect(onExport).toHaveBeenCalledWith('step', 'normal', ['only']);
  });

  it('offers no STL, 3MF or STEP on an agent’s unreviewed branch, and says why', () => {
    exportSourceStore.setState({ source: agentSource('changes-requested') });
    const onExport = vi.fn();
    const onIfc = vi.fn();
    render(
      <ExportMenu bodies={[body('only')]} onExport={onExport} onIfc={onIfc} onLaser={vi.fn()} />,
    );
    open();
    expect(screen.getByTestId('export-gate-refusal').textContent).toBe(UNREVIEWED_EXPORT);
    for (const format of ['stl', 'stl-each', '3mf', 'step']) {
      expect(item(format)).toHaveProperty('disabled', true);
      fireEvent.click(item(format));
    }
    expect(onExport).not.toHaveBeenCalled();
    // IFC is not a fabrication file; the laser dialog says why itself.
    expect(item('ifc')).toHaveProperty('disabled', false);
    expect(item('laser')).toHaveProperty('disabled', false);
  });

  it('opens the laser and plasma export in a part studio, never in an assembly', () => {
    const onLaser = vi.fn();
    const { unmount } = render(
      <ExportMenu bodies={[body('only')]} onExport={vi.fn()} onLaser={onLaser} />,
    );
    open();
    expect(item('laser').textContent).toBe('Laser or plasma (DXF, SVG)...');
    fireEvent.click(item('laser'));
    expect(onLaser).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    unmount();
    render(<ExportMenu assembly bodies={[]} onExport={vi.fn()} onLaser={onLaser} />);
    open();
    expect(screen.queryByTestId('export-laser')).toBeNull();
  });

  it('offers IFC for a building only when asked to, and not in an assembly', () => {
    const onIfc = vi.fn();
    const { unmount } = render(
      <ExportMenu bodies={[body('only')]} onExport={vi.fn()} onIfc={onIfc} />,
    );
    open();
    expect(item('ifc').textContent).toBe('IFC (building)');
    fireEvent.click(item('ifc'));
    expect(onIfc).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    unmount();
    const again = render(<ExportMenu bodies={[body('only')]} onExport={vi.fn()} />);
    open();
    expect(screen.queryByTestId('export-ifc')).toBeNull();
    again.unmount();
    render(<ExportMenu assembly bodies={[]} onExport={vi.fn()} onIfc={onIfc} />);
    open();
    expect(screen.queryByTestId('export-ifc')).toBeNull();
  });

  it('publishes a view, with the source only when Include source is ticked', () => {
    const onPublish = vi.fn();
    render(<ExportMenu bodies={[body('only')]} onExport={vi.fn()} onPublish={onPublish} />);
    open();
    expect(item('publish').textContent).toBe('Publish view (.mfkview)');
    const source = screen.getByTestId('export-include-source') as HTMLInputElement;
    expect(source.checked).toBe(false);
    expect(source.parentElement!.textContent).toBe('Include source');
    fireEvent.click(item('publish'));
    expect(onPublish).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('menu')).toBeNull();
    open();
    fireEvent.click(screen.getByTestId('export-include-source'));
    fireEvent.click(item('publish'));
    expect(onPublish).toHaveBeenLastCalledWith(true);
  });

  it('publishes an assembly too, and offers nothing without a handler', () => {
    const onPublish = vi.fn();
    const { unmount } = render(
      <ExportMenu assembly bodies={[]} onExport={vi.fn()} onPublish={onPublish} />,
    );
    open();
    fireEvent.click(item('publish'));
    expect(onPublish).toHaveBeenCalledWith(false);
    unmount();
    render(<ExportMenu bodies={[body('only')]} onExport={vi.fn()} />);
    open();
    expect(screen.queryByTestId('export-publish')).toBeNull();
    expect(screen.queryByTestId('export-include-source')).toBeNull();
  });

  it('keeps the ticks in step with visibility while it is open', () => {
    const onExport = vi.fn();
    const { rerender } = render(<ExportMenu bodies={[body('a'), body('b')]} onExport={onExport} />);
    open();
    const boxes = () => screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked);
    expect(boxes()).toEqual([true, true]);
    // Hidden from the tree with the menu open: unticked at once.
    rerender(<ExportMenu bodies={[body('a'), body('b', true)]} onExport={onExport} />);
    expect(boxes()).toEqual([true, false]);
    // A tick the user set stays as set.
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    rerender(<ExportMenu bodies={[body('a', true), body('b')]} onExport={onExport} />);
    expect(boxes()).toEqual([false, true]);
    fireEvent.click(item('3mf'));
    expect(onExport).toHaveBeenCalledWith('3mf', 'normal', ['b']);
  });

  it('in an assembly exports it whole: no body choice, one file, no configurations', () => {
    const onExport = vi.fn();
    render(
      <ExportMenu
        assembly
        bodies={[body('a'), body('b', true)]}
        configurations={3}
        onExportAll={vi.fn()}
        onExport={onExport}
      />,
    );
    expect(screen.getByRole('button', { name: 'Export' }).title).toBe(
      'Export the assembly as STL, 3MF or STEP',
    );
    open();
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'STL',
      '3MF',
      'STEP',
    ]);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByTestId('export-every-configuration')).toBeNull();
    fireEvent.click(item('3mf'));
    expect(onExport).toHaveBeenCalledWith('3mf', 'normal', []);
  });

  it('says so when no body is ticked', () => {
    render(<ExportMenu bodies={[body('a', true), body('b', true)]} onExport={vi.fn()} />);
    open();
    expect(item('stl').disabled).toBe(true);
    expect(screen.getByTestId('export-nothing').textContent).toBe(
      'No body is chosen: tick one to export it.',
    );
  });

  it('offers every configuration, one file per row, when there are rows', () => {
    const onExport = vi.fn();
    const onExportAll = vi.fn();
    const { rerender } = render(
      <ExportMenu bodies={[body('a')]} onExport={onExport} onExportAll={onExportAll} />,
    );
    open();
    expect(screen.queryByTestId('export-every-configuration')).toBeNull();
    rerender(
      <ExportMenu
        bodies={[body('a')]}
        onExport={onExport}
        configurations={3}
        onExportAll={onExportAll}
      />,
    );
    const every = screen.getByTestId('export-every-configuration');
    expect(every.parentElement!.textContent).toBe('Every configuration (3 files)');
    fireEvent.click(every);
    expect(item('stl-each').disabled).toBe(true);
    fireEvent.click(item('3mf'));
    expect(onExportAll).toHaveBeenCalledWith('3mf', 'normal', ['a']);
    expect(onExport).not.toHaveBeenCalled();
  });

  it('shows the progress of an export of every configuration, and cancels it', () => {
    const onCancel = vi.fn();
    render(<ExportProgress index={1} count={3} row="800" onCancel={onCancel} />);
    expect(screen.getByTestId('export-progress').textContent).toContain(
      'Exporting configuration 2 of 3 (800)...',
    );
    fireEvent.click(screen.getByTestId('export-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
