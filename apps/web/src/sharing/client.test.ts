import { describe, expect, it, vi } from 'vitest';
import {
  SERVER_SETTINGS_KEY,
  SHARE_MIME,
  ShareError,
  checkServerUrl,
  checkShareable,
  checkToken,
  createShare,
  forgetServerSettings,
  listShares,
  loadServerSettings,
  revokeShare,
  saveServerSettings,
  shareLink,
  viewerUrlFor,
} from './client';
import { IDENTITY_MATRIX } from '@manufakture/io';
import { MFKVIEW_MIME, MFKVIEW_VIEWER_LIMITS, writeMfkview } from '@manufakture/io/mfkview';
import { sourceFromHash } from '../viewer/load';
import { boxBundle, meshOf } from '../viewer/bundles.test-fixture';
import { boxBody } from '../viewport/testMeshes';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const SERVER = { url: 'https://cad.example.test', token: TOKEN };
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('server settings', () => {
  it('takes https addresses, and http only on localhost from localhost', () => {
    expect(checkServerUrl('https://cad.example.test/', 'app.example.test')).toBe(
      'https://cad.example.test',
    );
    expect(checkServerUrl(' https://h.example.test/sub/api/ ', 'x')).toBe(
      'https://h.example.test/sub',
    );
    expect(checkServerUrl('http://127.0.0.1:8787', 'localhost')).toBe('http://127.0.0.1:8787');
    expect(() => checkServerUrl('http://127.0.0.1:8787', 'app.example.test')).toThrow(ShareError);
    expect(() => checkServerUrl('http://cad.example.test', 'localhost')).toThrow(/https/);
    expect(() => checkServerUrl('https://u:p@cad.example.test', 'x')).toThrow(/user name/);
    expect(() => checkServerUrl('https://cad.example.test/?a=1', 'x')).toThrow(ShareError);
    expect(() => checkServerUrl('javascript:alert(1)', 'x')).toThrow(ShareError);
    expect(() => checkServerUrl('cad', 'x')).toThrow(ShareError);
  });

  it('takes tokens the server could accept', () => {
    expect(checkToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(() => checkToken('short')).toThrow(/MANUFAKTURE_TOKEN/);
    expect(() => checkToken(`${TOKEN} x`)).toThrow(ShareError);
  });

  it('saves, loads and forgets them, ignoring anything unusable', () => {
    const storage = localStorage;
    storage.clear();
    expect(loadServerSettings(storage, 'app.example.test')).toBeNull();
    saveServerSettings(SERVER, storage);
    expect(loadServerSettings(storage, 'app.example.test')).toEqual(SERVER);
    storage.setItem(SERVER_SETTINGS_KEY, '{"url":"http://evil.example.test","token":"x"}');
    expect(loadServerSettings(storage, 'app.example.test')).toBeNull();
    storage.setItem(SERVER_SETTINGS_KEY, 'not json');
    expect(loadServerSettings(storage, 'app.example.test')).toBeNull();
    saveServerSettings(SERVER, storage);
    forgetServerSettings(storage);
    expect(storage.getItem(SERVER_SETTINGS_KEY)).toBeNull();
  });
});

describe('links', () => {
  it('open the viewer with the download address in the fragment, as the viewer reads it', () => {
    const viewer = viewerUrlFor({ origin: 'https://app.example.test' }, '/');
    expect(viewer).toBe('https://app.example.test/viewer.html');
    const link = shareLink(`${viewer}#old`, SERVER, ID);
    expect(link).toBe(
      `https://app.example.test/viewer.html#src=https://cad.example.test/api/shares/${ID}`,
    );
    expect(sourceFromHash(new URL(link).hash)).toBe(`https://cad.example.test/api/shares/${ID}`);
  });
});

describe('requests', () => {
  it('upload a bundle with the token, no cookies and no referrer', async () => {
    const fetch = vi.fn(async () =>
      reply(201, { id: ID, name: 'Bracket', size: 3, createdAt: 'x', expiresAt: null }),
    );
    const made = await createShare(
      SERVER,
      new Uint8Array([1, 2, 3]),
      { name: 'Bracket & co', expires: 'never' },
      { fetch },
    );
    expect(made.id).toBe(ID);
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://cad.example.test/api/shares?name=Bracket+%26+co&expires=never');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': SHARE_MIME },
    });
  });

  it('turn answers into messages', async () => {
    const at = (status: number, body?: unknown) => ({ fetch: async () => reply(status, body) });
    await expect(listShares(SERVER, at(401, {}))).rejects.toThrow(/token/);
    await expect(
      createShare(SERVER, new Uint8Array(1), { name: 'x' }, at(409, { message: 'Full up' })),
    ).rejects.toThrow('Full up');
    await expect(
      createShare(SERVER, new Uint8Array(1), { name: 'x' }, at(201, { id: '../../x' })),
    ).rejects.toThrow(/no share|not answer/);
    await expect(
      listShares(SERVER, {
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).rejects.toThrow(/could not be reached/);
  });

  it('list only well-formed shares, and revoke idempotently', async () => {
    const r = await listShares(SERVER, {
      fetch: async () =>
        reply(200, {
          shares: [
            { id: ID, name: 'a', size: 1, createdAt: 'x', expiresAt: null },
            { id: 'bad/id', name: 'b', size: 1, createdAt: 'x', expiresAt: null },
          ],
          limits: { maxBytes: 1, maxShares: 2, defaultExpiryDays: 30, allowNever: true },
        }),
    });
    expect(r.shares.map((s) => s.id)).toEqual([ID]);
    const fetch = vi.fn(async () => reply(404, { code: 'not-found' }));
    await expect(revokeShare(SERVER, ID, { fetch })).resolves.toBeUndefined();
    expect((fetch.mock.calls[0]! as unknown as [string, RequestInit])[1].method).toBe('DELETE');
    await expect(revokeShare(SERVER, ID, { fetch: async () => reply(500) })).rejects.toThrow(/500/);
  });
});

describe('checkShareable', () => {
  it("uses io's media type", () => {
    expect(SHARE_MIME).toBe(MFKVIEW_MIME);
  });

  it('passes a bundle the viewer opens', async () => {
    expect(() => checkShareable(new Uint8Array(0), null)).toThrow(ShareError);
    const bytes = await boxBundle();
    expect(() => checkShareable(bytes, null)).not.toThrow();
    expect(() => checkShareable(bytes, bytes.length)).not.toThrow();
  });

  it("refuses by size: the smaller of the server's limit and the viewer's", async () => {
    const bytes = await boxBundle();
    const n = bytes.length;
    const viewer = { ...MFKVIEW_VIEWER_LIMITS, maxFileBytes: n - 1 };
    expect(() => checkShareable(bytes, n - 10)).toThrow(/this server takes at most/);
    expect(() => checkShareable(bytes, n * 2, viewer)).toThrow(/the viewer opens at most/);
    expect(() => checkShareable(bytes, null, viewer)).toThrow(/the viewer opens at most/);
    expect(() => checkShareable(bytes, n - 10, viewer)).toThrow(/this server takes at most/);
  });

  it('refuses what the writer allows but the viewer does not, naming the limit', async () => {
    const bytes = await boxBundle();
    expect(() => checkShareable(bytes, null, { ...MFKVIEW_VIEWER_LIMITS, maxBodies: 1 })).toThrow(
      /^The viewer cannot open this view \(the body list has more than 1 items\)/,
    );
    expect(() =>
      checkShareable(bytes, null, { ...MFKVIEW_VIEWER_LIMITS, maxTotalTriangles: 10 }),
    ).toThrow(/the view has more than 10 triangles/);
  });

  it('refuses more instances than the viewer reads, with its real limits', async () => {
    const max = MFKVIEW_VIEWER_LIMITS.maxInstances;
    const bytes = await writeMfkview({
      name: 'Many',
      kind: 'assembly',
      bodies: [
        {
          name: 'Cube',
          color: null,
          material: null,
          volume: null,
          mass: null,
          mesh: meshOf(boxBody({ id: 'c', size: [1, 1, 1] })),
        },
      ],
      parts: [{ name: 'Cube', bodies: [0] }],
      instances: Array.from({ length: max + 1 }, (_, i) => ({
        name: `Cube ${i}`,
        part: 0,
        transform: [...IDENTITY_MATRIX],
      })),
      source: null,
    });
    expect(() => checkShareable(bytes, null)).toThrow(
      new RegExp(`instance list has more than ${max} items`),
    );
  });
});
