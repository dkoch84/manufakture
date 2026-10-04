// Share links (M7 plan, T7.3d; docs/user/sharing.md): the app's half. A published view
// (`.mfkview`) is uploaded to the person's own manufakture server, which keeps it under an
// unguessable id; the link opens the read-only viewer with the download's address in the
// fragment (`viewer.html#src=<server>/api/shares/<id>`), so the viewer's host never sees it.
//
// The server address and token are kept in this origin's storage (never in a document or a
// `.mfk`). Requests send the token as a bearer header and nothing else: no cookies, no referrer.
// Kept free of React.

/** The bundle's media type (`@manufakture/io`'s `MFKVIEW_MIME`). */
export const SHARE_MIME = 'application/vnd.manufakture.view+zip';

/** Where the server and its token are kept in the origin's storage. */
export const SERVER_SETTINGS_KEY = 'manufakture.server';

/** A share id as the server makes them: 128 random bits, base64url. */
export const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The server to share through. `url` is its base, without `/api` or a trailing slash. */
export interface ServerSettings {
  url: string;
  token: string;
}

/** One share, as the server lists it. */
export interface ShareInfo {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
}

/** What the server allows. */
export interface ShareLimits {
  maxBytes: number;
  maxShares: number;
  defaultExpiryDays: number;
  allowNever: boolean;
}

/** A failure, worded to be shown as it is. */
export class ShareError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

/**
 * `raw` as a server base URL, or a `ShareError`. https only, except http on localhost when the app
 * itself runs on localhost (development and the end-to-end tests), as the viewer allows.
 */
export function checkServerUrl(raw: string, appHostname: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ShareError('The server address must be a full https:// address.');
  }
  const local = LOCAL_HOSTS.has(url.hostname) && LOCAL_HOSTS.has(appHostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new ShareError('The server address must start with https://.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ShareError(
      'The server address must be just the address: no user name, password, query or #.',
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`;
}

/** A token the server could accept (`apps/server`'s `TOKEN`). */
export function checkToken(raw: string): string {
  const token = raw.trim();
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) {
    throw new ShareError(
      "The token is the server's MANUFAKTURE_TOKEN: at least 32 letters, digits or ._~-",
    );
  }
  return token;
}

/** The saved server, or null when none is saved (or what is saved is unusable). */
export function loadServerSettings(
  storage: Storage = localStorage,
  appHostname = location.hostname,
): ServerSettings | null {
  try {
    const raw = storage.getItem(SERVER_SETTINGS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown };
    if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return null;
    return { url: checkServerUrl(parsed.url, appHostname), token: checkToken(parsed.token) };
  } catch {
    return null;
  }
}

export function saveServerSettings(s: ServerSettings, storage: Storage = localStorage): void {
  storage.setItem(SERVER_SETTINGS_KEY, JSON.stringify({ url: s.url, token: s.token }));
}

export function forgetServerSettings(storage: Storage = localStorage): void {
  storage.removeItem(SERVER_SETTINGS_KEY);
}

/** The public download address of share `id`. */
export function shareDownloadUrl(server: Pick<ServerSettings, 'url'>, id: string): string {
  return `${server.url}/api/shares/${encodeURIComponent(id)}`;
}

/** The link to give out: the viewer, with the download's address in the fragment. */
export function shareLink(viewerUrl: string, server: Pick<ServerSettings, 'url'>, id: string) {
  return `${viewerUrl.split('#', 1)[0]}#src=${shareDownloadUrl(server, id)}`;
}

/** The viewer page next to the app (`viewer.html` under the app's base). */
export function viewerUrlFor(appLocation: { origin: string }, base: string): string {
  return new URL('viewer.html', appLocation.origin + base).href;
}

export interface ClientOptions {
  /** For tests. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** One request to the server, its JSON answer, or a `ShareError` with the server's message. */
async function request<T>(
  server: ServerSettings,
  method: string,
  path: string,
  options: ClientOptions & { body?: Uint8Array; type?: string },
): Promise<T | null> {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${server.token}` };
  if (options.type) headers['content-type'] = options.type;
  let res: Response;
  try {
    res = await doFetch(`${server.url}/api${path}`, {
      method,
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      ...(options.body ? { body: options.body as BodyInit } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new ShareError(
      'The server could not be reached. Check its address, that it is running, and that it allows this app (MANUFAKTURE_ORIGINS).',
    );
  }
  if (res.status === 204) return null;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new ShareError('The server did not accept the token.', 401);
    }
    const message = (body as { message?: unknown } | null)?.message;
    throw new ShareError(
      typeof message === 'string' && message.length > 0
        ? message.slice(0, 300)
        : `The server answered ${res.status}.`,
      res.status,
    );
  }
  return body as T;
}

/** The active shares and the server's limits. */
export async function listShares(
  server: ServerSettings,
  options: ClientOptions = {},
): Promise<{ shares: ShareInfo[]; limits: ShareLimits }> {
  const r = await request<{ shares: ShareInfo[]; limits: ShareLimits }>(
    server,
    'GET',
    '/shares',
    options,
  );
  if (r === null || !Array.isArray(r.shares)) throw new ShareError('The server sent no list.');
  return { shares: r.shares.filter((s) => SHARE_ID.test(s.id)), limits: r.limits };
}

/** Uploads a bundle. `expires`: days, or `never`; absent: the server's default. */
export async function createShare(
  server: ServerSettings,
  bytes: Uint8Array,
  share: { name: string; expires?: number | 'never' },
  options: ClientOptions = {},
): Promise<ShareInfo> {
  const q = new URLSearchParams({ name: share.name });
  if (share.expires !== undefined) q.set('expires', String(share.expires));
  const r = await request<ShareInfo>(server, 'POST', `/shares?${q}`, {
    ...options,
    body: bytes,
    type: SHARE_MIME,
  });
  if (r === null || typeof r.id !== 'string' || !SHARE_ID.test(r.id)) {
    throw new ShareError('The server did not answer with a share.');
  }
  return r;
}

/** Revokes share `id`; one already gone counts as revoked. */
export async function revokeShare(
  server: ServerSettings,
  id: string,
  options: ClientOptions = {},
): Promise<void> {
  try {
    await request(server, 'DELETE', `/shares/${encodeURIComponent(id)}`, options);
  } catch (e) {
    if (e instanceof ShareError && e.status === 404) return;
    throw e;
  }
}
