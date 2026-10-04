import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_SETTINGS_KEY, saveServerSettings, type ShareInfo } from './client';
import { SharePanel } from './SharePanel';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const SERVER = { url: 'https://cad.example.test', token: TOKEN };
const VIEWER = 'https://app.example.test/viewer.html';
const LIMITS = { maxBytes: 1000, maxShares: 2, defaultExpiryDays: 30, allowNever: true };

/** A fake server holding shares in memory. */
function fakeServer() {
  const shares: ShareInfo[] = [];
  let n = 0;
  const calls: { method: string; url: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (method === 'GET' && url.endsWith('/api/shares'))
      return json(200, { shares, limits: LIMITS });
    if (method === 'POST') {
      const id = `share${String(++n).padStart(17, '0')}`;
      const name = new URL(url).searchParams.get('name') ?? '';
      const s = { id, name, size: 10, createdAt: '2026-10-04T00:00:00Z', expiresAt: null };
      shares.unshift(s);
      return json(201, s);
    }
    if (method === 'DELETE') {
      const id = url.split('/').pop()!;
      const i = shares.findIndex((s) => s.id === id);
      if (i < 0) return json(404, { message: 'No such share' });
      shares.splice(i, 1);
      return json(204);
    }
    return json(404, {});
  });
  return { fetch, shares, calls };
}

const bundle = vi.fn(async () => ({
  ok: true as const,
  bytes: new Uint8Array(10),
  name: 'Bracket',
}));

beforeEach(() => {
  localStorage.clear();
  bundle.mockClear();
});

describe('the Share panel', () => {
  it('asks for the server first and keeps it in this browser', async () => {
    const server = fakeServer();
    render(
      <SharePanel makeBundle={bundle} viewerUrl={VIEWER} fetch={server.fetch} appHostname="x" />,
    );
    fireEvent.click(screen.getByTestId('share-button'));
    fireEvent.change(screen.getByTestId('share-server-url'), {
      target: { value: 'http://cad.example.test' },
    });
    fireEvent.change(screen.getByTestId('share-token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId('share-save-server'));
    expect(screen.getByTestId('share-status').textContent).toMatch(/https/);
    fireEvent.change(screen.getByTestId('share-server-url'), {
      target: { value: 'https://cad.example.test/' },
    });
    fireEvent.click(screen.getByTestId('share-save-server'));
    expect(JSON.parse(localStorage.getItem(SERVER_SETTINGS_KEY)!)).toEqual(SERVER);
    await waitFor(() => expect(screen.getByTestId('share-create')).toBeTruthy());
  });

  it('makes a link, lists it and revokes it', async () => {
    saveServerSettings(SERVER, localStorage);
    const server = fakeServer();
    render(
      <SharePanel makeBundle={bundle} viewerUrl={VIEWER} fetch={server.fetch} appHostname="x" />,
    );
    fireEvent.click(screen.getByTestId('share-button'));
    fireEvent.change(await screen.findByTestId('share-expiry'), { target: { value: 'never' } });
    fireEvent.click(screen.getByTestId('share-include-source'));
    fireEvent.click(screen.getByTestId('share-create'));
    const link = (await screen.findByTestId('share-link')) as HTMLInputElement;
    const id = server.shares[0]!.id;
    expect(link.value).toBe(`${VIEWER}#src=https://cad.example.test/api/shares/${id}`);
    expect(bundle).toHaveBeenCalledWith(true);
    expect(server.calls.find((c) => c.method === 'POST')!.url).toContain('expires=never');
    await waitFor(() => expect(screen.getAllByTestId('share-item')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('share-revoke'));
    await waitFor(() => expect(screen.queryAllByTestId('share-item')).toHaveLength(0));
    expect(screen.queryByTestId('share-link')).toBeNull();
    expect(server.shares).toHaveLength(0);
  });

  it('refuses a bundle over the server limit before uploading, and shows publish errors', async () => {
    saveServerSettings(SERVER, localStorage);
    const server = fakeServer();
    const big = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array(2000),
      name: 'Big',
    }));
    const { unmount } = render(
      <SharePanel makeBundle={big} viewerUrl={VIEWER} fetch={server.fetch} appHostname="x" />,
    );
    fireEvent.click(screen.getByTestId('share-button'));
    await waitFor(() => expect(server.calls).toHaveLength(1));
    await screen.findByText(/Active links \(0 of 2\)/);
    fireEvent.click(screen.getByTestId('share-create'));
    await waitFor(() =>
      expect(screen.getByTestId('share-status').textContent).toMatch(/at most 1000 B/),
    );
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false);
    unmount();

    const none = async () => ({ ok: false as const, message: 'There is nothing to publish.' });
    render(
      <SharePanel makeBundle={none} viewerUrl={VIEWER} fetch={server.fetch} appHostname="x" />,
    );
    fireEvent.click(screen.getByTestId('share-button'));
    fireEvent.click(await screen.findByTestId('share-create'));
    await waitFor(() =>
      expect(screen.getByTestId('share-status').textContent).toBe('There is nothing to publish.'),
    );
  });
});
