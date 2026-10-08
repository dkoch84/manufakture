import { applyCommand, type ManufaktureDocument } from '@manufakture/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryBackend, DocumentLibrary, type LogEntry } from '@manufakture/library';
import { partDocument, unwrapDoc } from '@manufakture/library/test-fixtures';
import { HistoryPanel } from './HistoryPanel';
import { ViewerBanner } from './ViewerBanner';
import type { HistoryTarget } from './history';

let clock = 0;
// A save a minute apart, and two hours between the second and the third: two sessions.
const times = [
  '2026-09-30T09:00:00.000Z',
  '2026-09-30T09:01:00.000Z',
  '2026-09-30T11:01:00.000Z',
  '2026-09-30T11:02:00.000Z',
];

function rename(doc: ManufaktureDocument, name: string): [ManufaktureDocument, LogEntry] {
  const at = times[clock++ % times.length]!;
  return [
    unwrapDoc(applyCommand(doc, { type: 'renameDocument', name })),
    { cause: 'execute', label: `Rename to ${name}`, command: { type: 'renameDocument', name }, at },
  ];
}

/** A library holding doc-1 at revisions 1 (One), 2 (Two) and 3 (Three), each logged. */
async function stored() {
  clock = 0;
  let n = 0;
  const lib = new DocumentLibrary(new MemoryBackend(), {
    locks: null,
    newId: () => `v${++n}`,
    now: () => new Date('2026-09-30T12:00:00.000Z'),
  });
  let doc = partDocument('doc-1', 'Zero');
  for (const name of ['One', 'Two', 'Three']) {
    const [next, e] = rename(doc, name);
    await lib.save(next, [e]);
    doc = next;
  }
  return lib;
}

async function setup(options: { disabled?: boolean; viewing?: HistoryTarget | null } = {}) {
  const lib = await stored();
  const onView = vi.fn();
  const createVersion = vi.fn((meta: { name: string; description?: string }) =>
    lib.createVersion('doc-1', meta),
  );
  const view = render(
    <HistoryPanel
      source={lib}
      documentId="doc-1"
      createVersion={createVersion}
      onView={onView}
      viewing={options.viewing ?? null}
      disabled={options.disabled ?? false}
    />,
  );
  await screen.findByTestId('revision-3');
  return { lib, onView, createVersion, view };
}

describe('the History panel', () => {
  it('lists the timeline in sessions, newest first, with what led to each revision', async () => {
    await setup();
    const panel = screen.getByTestId('history-panel');
    const sessions = panel.querySelectorAll('.history-session');
    expect(sessions).toHaveLength(2);
    expect(within(sessions[0] as HTMLElement).queryByTestId('revision-3')).not.toBeNull();
    expect(within(sessions[1] as HTMLElement).queryByTestId('revision-2')).not.toBeNull();
    expect(within(sessions[1] as HTMLElement).queryByTestId('revision-1')).not.toBeNull();
    expect(screen.getByTestId('revision-2').textContent).toContain('Rename to Two');
    expect(screen.getByTestId('versions-empty')).toBeDefined();
  });

  it('views a revision', async () => {
    const t = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'View revision 2' }));
    expect(t.onView).toHaveBeenCalledWith({ kind: 'revision', revision: 2 });
  });

  it('creates a version from the form, then lists and views it', async () => {
    const t = await setup();
    fireEvent.click(screen.getByTestId('version-create'));
    fireEvent.click(screen.getByTestId('version-save'));
    expect(screen.getByTestId('history-error').textContent).toBe('A version needs a name.');
    expect(t.createVersion).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: ' 6 mm ' } });
    fireEvent.change(screen.getByTestId('version-description'), {
      target: { value: 'Before the walls grew' },
    });
    fireEvent.click(screen.getByTestId('version-save'));
    await screen.findByTestId('version-6 mm');
    expect(t.createVersion).toHaveBeenCalledWith({
      name: '6 mm',
      description: 'Before the walls grew',
    });
    expect(screen.queryByTestId('version-form')).toBeNull();
    const item = screen.getByTestId('version-6 mm');
    expect(item.textContent).toContain('revision 3');
    expect(item.textContent).toContain('Before the walls grew');
    // The revision it names carries its name on the timeline.
    await waitFor(() => expect(screen.getByTestId('revision-3').textContent).toContain('6 mm'));
    fireEvent.click(screen.getByRole('button', { name: 'View version 6 mm' }));
    expect(t.onView).toHaveBeenCalledWith({
      kind: 'version',
      version: expect.objectContaining({ name: '6 mm', revision: 3 }),
    });
  });

  it('shows why a version was not created', async () => {
    const lib = await stored();
    render(
      <HistoryPanel
        source={lib}
        documentId="doc-1"
        createVersion={async () => ({ ok: false, message: 'The disk is full.' })}
        onView={vi.fn()}
      />,
    );
    await screen.findByTestId('revision-3');
    fireEvent.click(screen.getByTestId('version-create'));
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('version-save'));
    await waitFor(() =>
      expect(screen.getByTestId('history-error').textContent).toBe('The disk is full.'),
    );
    expect(screen.getByTestId('version-form')).toBeDefined();
  });

  it('marks what is viewed, and offers nothing while disabled', async () => {
    await setup({ viewing: { kind: 'revision', revision: 2 }, disabled: true });
    expect(screen.getByTestId('revision-2').className).toContain('history-current');
    for (const r of [1, 2, 3]) {
      expect(
        (screen.getByRole('button', { name: `View revision ${r}` }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect((screen.getByTestId('version-create') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads the history again when the document is saved', async () => {
    const t = await setup();
    const doc = (await t.lib.open('doc-1')) as {
      ok: true;
      value: { document: ManufaktureDocument };
    };
    const [next, e] = rename(doc.value.document, 'Four');
    await t.lib.save(next, [e]);
    expect(screen.queryByTestId('revision-4')).toBeNull();
    t.view.rerender(
      <HistoryPanel
        source={t.lib}
        documentId="doc-1"
        refresh={1}
        createVersion={t.createVersion}
        onView={t.onView}
      />,
    );
    await screen.findByTestId('revision-4');
  });

  it('says so when nothing is saved yet', async () => {
    const lib = new DocumentLibrary(new MemoryBackend(), { locks: null });
    render(<HistoryPanel source={lib} documentId="new-doc" onView={vi.fn()} />);
    await screen.findByText('Nothing is saved yet.');
    expect(screen.queryByTestId('version-create')).toBeNull();
  });

  it('says so when the log cannot be read', async () => {
    const lib = await stored();
    const broken = {
      has: (id: string) => lib.has(id),
      listVersions: (id: string) => lib.listVersions(id),
      historyStart: (id: string) => lib.historyStart(id),
      readVersion: (id: string, v: string) => lib.readVersion(id, v),
      readRevision: (id: string, rev: number) => lib.readRevision(id, rev),
      readHistory: async () => ({ ok: false as const, message: 'It is damaged.' }),
    };
    await act(async () => {
      render(<HistoryPanel source={broken} documentId="doc-1" onView={vi.fn()} />);
    });
    await screen.findByText('The history cannot be read: It is damaged.');
  });
});

describe('the viewer banner', () => {
  it('names what is viewed, lists the differences, and goes back or restores', () => {
    const onBack = vi.fn();
    const onRestore = vi.fn();
    const { rerender } = render(
      <ViewerBanner
        label='Version "6 mm"'
        differences={['Variables that differ: #thickness.']}
        onBack={onBack}
        onRestore={onRestore}
      />,
    );
    expect(screen.getByTestId('history-viewer-label').textContent).toBe('Viewing Version "6 mm"');
    expect(screen.getByTestId('history-compare').textContent).toContain(
      'Variables that differ: #thickness.',
    );
    expect(screen.queryByTestId('history-branch')).toBeNull();
    fireEvent.click(screen.getByTestId('history-back'));
    fireEvent.click(screen.getByTestId('history-restore'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledTimes(1);

    const onBranch = vi.fn();
    rerender(
      <ViewerBanner
        label="Revision 2"
        differences={[]}
        pending
        error="the kernel failed"
        onBack={onBack}
        onRestore={onRestore}
        onBranch={onBranch}
      />,
    );
    expect(screen.getByTestId('history-compare').textContent).toBe('Same as the current state.');
    expect(screen.getByText('Building it...')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('the kernel failed');
    // Branch asks for a name first.
    fireEvent.click(screen.getByTestId('history-branch'));
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('branch-name'), { target: { value: '  Wider  ' } });
    fireEvent.click(screen.getByTestId('branch-create'));
    expect(onBranch).toHaveBeenCalledWith('Wider');
  });

  it('keeps the branch form open with the reason when branching fails', async () => {
    const onBranch = vi.fn(async () => 'There is a branch called "Main" already.');
    render(
      <ViewerBanner
        label='Version "6 mm"'
        differences={[]}
        onBack={() => undefined}
        onRestore={() => undefined}
        onBranch={onBranch}
        branchName="6 mm"
      />,
    );
    fireEvent.click(screen.getByTestId('history-branch'));
    expect((screen.getByTestId('branch-name') as HTMLInputElement).value).toBe('6 mm');
    fireEvent.change(screen.getByTestId('branch-name'), { target: { value: ' ' } });
    fireEvent.click(screen.getByTestId('branch-create'));
    expect(screen.getByTestId('branch-error').textContent).toBe('A branch needs a name.');
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('branch-name'), { target: { value: 'Main' } });
    fireEvent.click(screen.getByTestId('branch-create'));
    await waitFor(() =>
      expect(screen.getByTestId('branch-error').textContent).toBe(
        'There is a branch called "Main" already.',
      ),
    );
    expect(screen.getByTestId('branch-name')).toBeDefined();
  });
});

describe('the History panel on a branch', () => {
  it('shows the branch’s own versions and timeline, and views its revisions on it', async () => {
    const lib = await stored();
    const version = await lib.createVersion('doc-1', { name: 'Base' });
    if (!version.ok) throw new Error(version.message);
    const branched = await lib.createBranch('doc-1', version.value.id, 'Wide');
    if (!branched.ok) throw new Error(branched.message);
    const b = branched.value.id;
    expect((await lib.open('doc-1', b)).ok).toBe(true);
    const [next, e] = rename(partDocument('doc-1', 'Three'), 'Wide one');
    await lib.save(next, [e], b);
    const onBranchVersion = await lib.createVersion('doc-1', { name: 'On the branch' }, b);
    expect(onBranchVersion.ok).toBe(true);

    const onView = vi.fn();
    const { rerender } = render(
      <HistoryPanel source={lib} documentId="doc-1" branch={b} branchName="Wide" onView={onView} />,
    );
    await screen.findByTestId('revision-2');
    expect(screen.getByTestId('history-branch-name').textContent).toBe('Wide');
    expect(screen.queryByTestId('revision-3')).toBeNull();
    // Every branch's versions, another branch's tagged with it; the timeline marks this one's.
    expect(screen.getByTestId('version-On the branch')).toBeDefined();
    expect(screen.queryByTestId('version-branch-On the branch')).toBeNull();
    expect(screen.getByTestId('version-branch-Base').textContent).toBe('Main');
    expect(screen.getByTestId('revision-2').textContent).toContain('On the branch');
    fireEvent.click(screen.getByRole('button', { name: 'View revision 2' }));
    expect(onView).toHaveBeenCalledWith({ kind: 'revision', revision: 2, branch: b });

    rerender(
      <HistoryPanel
        source={lib}
        documentId="doc-1"
        branch="main"
        branches={[{ id: 'main', name: 'Main', fromVersion: null, createdAt: '' }, branched.value]}
        onView={onView}
      />,
    );
    await screen.findByTestId('revision-3');
    expect(screen.queryByTestId('history-branch-name')).toBeNull();
    expect(screen.queryByTestId('version-branch-Base')).toBeNull();
    expect(screen.getByTestId('version-branch-On the branch').textContent).toBe('Wide');
    expect(screen.getByTestId('revision-3').textContent).toContain('Base');
    expect(screen.getByTestId('revision-2').textContent).not.toContain('On the branch');
  });

  it('lists a version kept from the sync server as it arrives, and views it', async () => {
    const t = await setup();
    expect(screen.getByTestId('versions-empty')).toBeDefined();
    const doc = partDocument('doc-1', 'Elsewhere');
    await act(async () => {
      const r = await t.lib.adoptVersion(
        'doc-1',
        {
          id: 'server-v',
          name: 'From the laptop',
          description: '',
          createdAt: '2026-09-30T10:00:00.000Z',
          branch: 'main',
          serverRev: 7,
        },
        doc,
      );
      expect(r.ok).toBe(true);
    });
    const item = await screen.findByTestId('version-From the laptop');
    expect(within(item).getByTestId('version-from-server-From the laptop').textContent).toBe(
      'from the server',
    );
    fireEvent.click(within(item).getByRole('button', { name: 'View version From the laptop' }));
    expect(t.onView).toHaveBeenCalledWith({
      kind: 'version',
      version: expect.objectContaining({ id: 'server-v', revision: 0, serverRev: 7 }),
    });
  });
});
