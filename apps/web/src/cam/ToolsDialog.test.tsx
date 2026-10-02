// The Tools dialog: copying built-in tools into the document with their unverified numbers shown,
// editing a document tool with range checks, deleting one (refused while an operation cuts with
// it), and the user library: its tools, the files kept aside, and Reset library for a library this
// build cannot read.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  BUILTIN_TOOLS,
  findBuiltinTool,
  serializeToolLibrary,
  unverifiedToolFields,
} from '@manufakture/cam/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { createDocumentStore } from '../state/document';
import { apply, plywoodDocument, setupDocument } from './cam.test-fixture';
import { TOOL_LIBRARY_DIR, ToolLibraryStore } from './library/store';
import { ToolsDialog } from './ToolsDialog';
import { unverifiedText } from './toolForms';

afterEach(cleanup);
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

function mount(doc = plywoodDocument(), library: ToolLibraryStore | null = null) {
  const documents = createDocumentStore(doc);
  const onClose = vi.fn();
  render(
    <ToolsDialog
      documents={documents}
      openLibrary={library ? () => Promise.resolve(library) : null}
      onClose={onClose}
    />,
  );
  return { documents, onClose, tools: () => documents.getState().document.cam.tools };
}

describe('ToolsDialog', () => {
  it('copies a built-in tool into the document, one undo step', () => {
    const { tools, documents } = mount();
    expect(screen.getByTestId('cam-tools-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cam-use-c3d-201'));
    expect(tools()).toHaveLength(1);
    expect(tools()[0]).toMatchObject({
      id: 'tool#1',
      number: 201,
      diameter: { source: '0.25in', lengthUnit: 'in' },
      source: { library: 'builtin', id: 'c3d-201' },
    });
    expect(screen.getByTestId('cam-tool-tool#1').textContent).toContain('#201');
    expect(documents.getState().undoLabel).toBe(`Add tool ${findBuiltinTool('c3d-201')!.name}`);
  });

  it('marks the numbers of a built-in tool that were not checked against their source', () => {
    mount();
    const unverified = BUILTIN_TOOLS.filter((t) => unverifiedToolFields(t).length > 0);
    expect(unverified.length).toBeGreaterThan(0);
    for (const t of unverified) {
      expect(screen.getByTestId(`cam-unverified-${t.id}`).textContent).toBe(unverifiedText(t));
    }
    for (const t of BUILTIN_TOOLS.filter((x) => unverifiedToolFields(x).length === 0)) {
      expect(screen.queryByTestId(`cam-unverified-${t.id}`)).toBeNull();
    }
    expect(unverifiedText({ ...findBuiltinTool('c3d-201')!, verified: false })).toMatch(
      /^Not checked against the source: sizes/,
    );
  });

  it('marks a document tool copied from a built-in one with unverified numbers, and only that', () => {
    const builtin = BUILTIN_TOOLS.find((t) => unverifiedToolFields(t).length > 0)!;
    const { tools } = mount();
    fireEvent.click(screen.getByTestId(`cam-use-${builtin.id}`));
    const copied = tools()[0]!;
    expect(screen.getByTestId(`cam-doc-unverified-${copied.id}`).textContent).toBe(
      `Copied from a built-in tool. ${unverifiedText(builtin)}`,
    );
    cleanup();
    // A tool made here, and one whose source names an id no built-in has, carry no mark.
    let doc = plywoodDocument();
    doc = apply(doc, {
      type: 'addCamTool',
      tool: { ...copied, id: 'tool#1', source: { library: 'builtin', id: 'constructor' } },
    });
    const { source: _s, ...bare } = copied;
    void _s;
    doc = apply(doc, { type: 'addCamTool', tool: { ...bare, id: 'tool#2' } });
    mount(doc);
    expect(screen.queryByTestId('cam-doc-unverified-tool#1')).toBeNull();
    expect(screen.queryByTestId('cam-doc-unverified-tool#2')).toBeNull();
  });

  it('edits a document tool, refusing a negative diameter, and keeps the edit one step', () => {
    const { tools, documents } = mount(setupDocument());
    fireEvent.click(within(screen.getByTestId('cam-tool-tool#1')).getByText('Edit'));
    fireEvent.change(screen.getByTestId('cam-tool-diameter'), { target: { value: '-6' } });
    expect(screen.getByTestId('cam-tool-diameter-note').textContent).toBe(
      'The value must be greater than zero.',
    );
    fireEvent.click(screen.getByTestId('cam-tool-ok'));
    expect(screen.getByTestId('cam-tool-editor')).toBeTruthy();
    expect(tools()[0]!.diameter.source).toBe('0.25in');
    fireEvent.change(screen.getByTestId('cam-tool-diameter'), { target: { value: '6 mm' } });
    fireEvent.change(screen.getByTestId('cam-preset-plywood-stepover'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('cam-tool-ok'));
    expect(screen.getByTestId('cam-preset-plywood-stepover-note').textContent).toMatch(/fraction/);
    fireEvent.change(screen.getByTestId('cam-preset-plywood-stepover'), {
      target: { value: '0.3' },
    });
    fireEvent.click(screen.getByTestId('cam-tool-ok'));
    expect(screen.queryByTestId('cam-tool-editor')).toBeNull();
    expect(tools()[0]!.diameter).toEqual({ source: '6 mm', lengthUnit: 'mm', angleUnit: 'deg' });
    expect(tools()[0]!.presets.find((p) => p.material === 'plywood')!.stepover.source).toBe('0.3');
    documents.getState().undo();
    expect(tools()[0]!.diameter.source).toBe('0.25in');
  });

  it('says the tool is gone when an undo removes it while it is edited, adding nothing', () => {
    const { tools, documents } = mount();
    fireEvent.click(screen.getByTestId('cam-use-c3d-201'));
    fireEvent.click(within(screen.getByTestId('cam-tool-tool#1')).getByText('Edit'));
    act(() => {
      documents.getState().undo();
    });
    expect(tools()).toEqual([]);
    fireEvent.click(screen.getByTestId('cam-tool-ok'));
    expect(screen.getByTestId('cam-tool-form-error').textContent).toBe(
      'The tool is gone (undone or deleted meanwhile).',
    );
    expect(screen.getByTestId('cam-tool-editor')).toBeTruthy();
    expect(tools()).toEqual([]);
  });

  it('makes a new tool, and refuses to delete one an operation cuts with', () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: {
        id: 'facing#1',
        kind: 'facing',
        name: 'Face',
        suppressed: false,
        tool: 'tool#1',
        geometry: [],
        depth: { source: '1', lengthUnit: 'mm', angleUnit: 'deg' },
        angle: { source: '0', lengthUnit: 'mm', angleUnit: 'deg' },
      },
    });
    const { tools } = mount(doc);
    fireEvent.click(screen.getByTestId('cam-tool-delete-tool#1'));
    expect(screen.getByTestId('cam-tools-message').textContent).toContain('setup#1/facing#1');
    expect(tools()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('cam-tool-new'));
    fireEvent.change(screen.getByTestId('cam-tool-name'), { target: { value: 'Six' } });
    fireEvent.click(screen.getByTestId('cam-tool-ok'));
    expect(tools().map((t) => [t.id, t.name])).toEqual([
      ['tool#1', '#201 1/4" flat end mill'],
      ['tool#2', 'Six'],
    ]);
    fireEvent.click(screen.getByTestId('cam-tool-delete-tool#2'));
    expect(tools()).toHaveLength(1);
  });

  it('lists the user library and copies from it', async () => {
    const backend = new MemoryBackend();
    const lib = new ToolLibraryStore(backend, { locks: null });
    await lib.put({ ...findBuiltinTool('c3d-102')!, id: 'mine', name: 'My eighth' });
    const { tools } = mount(plywoodDocument(), lib);
    await waitFor(() => expect(screen.getByTestId('cam-library-tool-mine')).toBeTruthy());
    expect(screen.queryByTestId('cam-kept-aside')).toBeNull();
    fireEvent.click(screen.getByTestId('cam-use-mine'));
    expect(tools()[0]).toMatchObject({
      name: 'My eighth',
      source: { library: 'user', id: 'mine' },
    });
  });

  it('says a wedged library cannot be read, how many files are kept aside, and resets it', async () => {
    const backend = new MemoryBackend();
    const bad = JSON.parse(serializeToolLibrary([findBuiltinTool('c3d-201')!])) as {
      tools: Record<string, unknown>[];
    };
    bad.tools[0]!.diameter = 5000;
    const encoder = new TextEncoder();
    await backend.write(
      `${TOOL_LIBRARY_DIR}/tools-00000001.json`,
      encoder.encode(JSON.stringify(bad)),
    );
    await backend.write(`${TOOL_LIBRARY_DIR}/rejected-tools-00000000.json`, encoder.encode('{}'));
    mount(plywoodDocument(), new ToolLibraryStore(backend, { locks: null }));
    await waitFor(() => expect(screen.getByTestId('cam-user-library-error')).toBeTruthy());
    expect(screen.getByTestId('cam-user-library-error').textContent).toMatch(/cannot be read/);
    expect(screen.getByTestId('cam-kept-aside').textContent).toMatch(
      /^1 library file is kept aside/,
    );
    fireEvent.click(screen.getByTestId('cam-library-reset'));
    // The confirmation says what reset really does: older set-aside files are pruned.
    expect(screen.getByTestId('cam-library-reset-confirm').textContent).toMatch(
      /only the newest 5 set-aside files are kept, so older ones are removed/,
    );
    fireEvent.click(screen.getByTestId('cam-library-reset-yes'));
    await waitFor(() =>
      expect(screen.getByTestId('cam-kept-aside').textContent).toMatch(
        /^2 library files are kept aside/,
      ),
    );
    expect(screen.queryByTestId('cam-user-library-error')).toBeNull();
    expect(screen.getByTestId('cam-library-note').textContent).toMatch(
      /Started an empty library; 1 file kept aside/,
    );
  });
});
