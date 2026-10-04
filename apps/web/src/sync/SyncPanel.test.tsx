import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_SETTINGS_KEY, saveServerSettings } from '../sharing/client';
import type { SyncController, SyncState } from './controller';
import { SyncPanel } from './SyncPanel';
import { createStore } from 'zustand/vanilla';

const SERVER = {
  url: 'https://cad.example.test',
  token: 'token-0123456789abcdefghijklmnopqrstuvwxyz',
};

function fakeController(patch: Partial<SyncState> = {}) {
  const state = createStore<SyncState>()(() => ({
    documentId: 'doc-1',
    enabled: false,
    status: { kind: 'off' },
    notices: [],
    busy: false,
    error: null,
    ...patch,
  }));
  const controller = {
    state,
    enable: vi.fn(() => Promise.resolve(true)),
    disable: vi.fn(() => Promise.resolve(true)),
    refresh: vi.fn(() => Promise.resolve()),
    dismissNotice: vi.fn(),
    listServerDocuments: vi.fn(() => Promise.resolve([{ id: 'doc-2', name: 'Shelf' }])),
    openFromServer: vi.fn((id: string) => Promise.resolve(id)),
  };
  return controller as unknown as SyncController & typeof controller;
}

beforeEach(() => {
  localStorage.clear();
});

describe('SyncPanel', () => {
  it('asks for the server first, and keeps it with the share links’ setting', () => {
    const c = fakeController();
    render(<SyncPanel controller={c} appHostname="app.example.test" />);
    fireEvent.click(screen.getByTestId('sync-button'));
    fireEvent.change(screen.getByTestId('sync-server-url'), { target: { value: SERVER.url } });
    fireEvent.change(screen.getByTestId('sync-token'), { target: { value: SERVER.token } });
    fireEvent.click(screen.getByTestId('sync-save-server'));
    expect(JSON.parse(localStorage.getItem(SERVER_SETTINGS_KEY)!)).toEqual(SERVER);
    expect(c.refresh).toHaveBeenCalled();
    expect(screen.getByTestId('sync-switch')).toBeTruthy();
  });

  it('switches sync on and off, shows the status, notices and their branch', async () => {
    saveServerSettings(SERVER);
    const c = fakeController();
    render(<SyncPanel controller={c} appHostname="app.example.test" />);
    expect(screen.getByTestId('sync-button').textContent).toContain('Not synced');
    fireEvent.click(screen.getByTestId('sync-button'));
    fireEvent.click(screen.getByTestId('sync-switch'));
    expect(c.enable).toHaveBeenCalledOnce();

    c.state.setState({
      enabled: true,
      status: { kind: 'pending', pending: 2 },
      notices: [{ id: 1, text: '"Fillet 2" could not be kept', branch: { id: 'b', name: 'Kept' } }],
    });
    expect(await screen.findByTestId('sync-status')).toHaveProperty('textContent', 'Pending 2');
    expect(screen.getByTestId('sync-notice').textContent).toContain('Fillet 2');
    expect(screen.getByTestId('sync-notice-branch').textContent).toContain('"Kept"');
    expect(screen.getByTestId('sync-notice-count').textContent).toBe('1');
    fireEvent.click(screen.getByText('Dismiss'));
    expect(c.dismissNotice).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByTestId('sync-switch'));
    expect(c.disable).toHaveBeenCalledOnce();
  });

  it('offers to update the app when the server speaks a newer protocol', () => {
    saveServerSettings(SERVER);
    const c = fakeController({
      enabled: true,
      status: { kind: 'update-app', message: 'older than the server' },
    });
    render(<SyncPanel controller={c} appHostname="app.example.test" />);
    fireEvent.click(screen.getByTestId('sync-button'));
    expect(screen.getByTestId('update-needed').textContent).toContain('sync server');
  });

  it('lists the server’s documents and opens one here', async () => {
    saveServerSettings(SERVER);
    const c = fakeController();
    const open = vi.fn();
    render(<SyncPanel controller={c} openDocument={open} appHostname="app.example.test" />);
    fireEvent.click(screen.getByTestId('sync-button'));
    fireEvent.click(screen.getByTestId('sync-list-documents'));
    fireEvent.click(await screen.findByTestId('sync-open-document'));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('doc-2'));
    expect(c.openFromServer).toHaveBeenCalledWith('doc-2');
  });
});
