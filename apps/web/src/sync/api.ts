// The server's HTTP side for sync (apps/server, T7.1c): its documents, a document's snapshot
// (what a new client starts from), and creating a document from this browser's copy. The
// address and the bearer token are the same server setting the share links use
// (`src/sharing/client.ts`, kept in this origin's storage, never in a document). Requests carry
// the token and nothing else: no cookies, no referrer. Everything the server answers is
// checked before use. Kept free of React.

import { parseDocument, type CounterTable, type ManufaktureDocument } from '@manufakture/core';
import {
  RECORD_ID,
  ServerBranchSchema,
  ServerVersionSchema,
  type ServerBranch,
  type ServerVersion,
} from '@manufakture/sync';
import type { ServerSettings } from '../sharing/client';

/** A failure, worded to be shown as it is. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** A document id as the server accepts it (apps/server `DOCUMENT_ID`). */
export const SERVER_DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ServerDocument {
  id: string;
  name: string;
}

export interface Snapshot {
  rev: number;
  document: ManufaktureDocument;
  highWater: CounterTable;
}

export interface ApiOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

async function request(
  server: ServerSettings,
  method: string,
  path: string,
  options: ApiOptions & { body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${server.token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await doFetch(`${server.url}/api${path}`, {
      method,
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new SyncError(
      'The server could not be reached. Check its address, that it is running, and that it allows this app (MANUFAKTURE_ORIGINS).',
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (res.status === 401) throw new SyncError('The server did not accept the token.', 401);
  return { status: res.status, body };
}

function failure(status: number, body: unknown): SyncError {
  const message = (body as { message?: unknown } | null)?.message;
  return new SyncError(
    typeof message === 'string' && message.length > 0
      ? message.slice(0, 300)
      : `The server answered ${status}.`,
    status,
  );
}

const isCounterTable = (v: unknown): v is CounterTable =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every(
    (t) =>
      typeof t === 'object' &&
      t !== null &&
      Object.values(t).every((n) => Number.isSafeInteger(n) && (n as number) >= 0),
  );

/** The documents the server holds (ids it would accept, names cut to a sensible length). */
export async function listServerDocuments(
  server: ServerSettings,
  options: ApiOptions = {},
): Promise<ServerDocument[]> {
  const r = await request(server, 'GET', '/documents', options);
  if (r.status !== 200) throw failure(r.status, r.body);
  const list = (r.body as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(list)) throw new SyncError('The server sent no list of documents.');
  return list
    .filter(
      (d): d is { id: string; name: string } =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as { id?: unknown }).id === 'string' &&
        SERVER_DOCUMENT_ID.test((d as { id: string }).id) &&
        typeof (d as { name?: unknown }).name === 'string',
    )
    .map((d) => ({ id: d.id, name: d.name.slice(0, 200) }));
}

/**
 * Document `id`'s head on the server, validated by core like any document read from outside;
 * null when the server has no such document.
 */
export async function fetchSnapshot(
  server: ServerSettings,
  id: string,
  options: ApiOptions = {},
): Promise<Snapshot | null> {
  if (!SERVER_DOCUMENT_ID.test(id)) return null;
  const r = await request(server, 'GET', `/documents/${encodeURIComponent(id)}/snapshot`, options);
  if (r.status === 404) return null;
  if (r.status !== 200) throw failure(r.status, r.body);
  const b = r.body as { rev?: unknown; document?: unknown; highWater?: unknown } | null;
  if (!b || !Number.isSafeInteger(b.rev) || (b.rev as number) < 0) {
    throw new SyncError('The server sent a damaged snapshot.');
  }
  const parsed = parseDocument(b.document);
  if (!parsed.ok) throw new SyncError(`The server's copy is invalid: ${parsed.error.message}`);
  if (parsed.value.document.id !== id)
    throw new SyncError("The server's copy is another document.");
  return {
    rev: b.rev as number,
    document: parsed.value.document,
    highWater: isCounterTable(b.highWater) ? b.highWater : {},
  };
}

/** Stores `document` on the server as a new document at revision 0. */
export async function createServerDocument(
  server: ServerSettings,
  document: ManufaktureDocument,
  options: ApiOptions = {},
): Promise<void> {
  const r = await request(server, 'POST', '/documents', { ...options, body: { document } });
  if (r.status !== 201) throw failure(r.status, r.body);
}

/** The WebSocket address of document `id`'s sync connection. */
export function socketUrl(server: Pick<ServerSettings, 'url'>, id: string): string {
  const url = new URL(`${server.url}/api/documents/${encodeURIComponent(id)}/socket`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** The subprotocols a connection offers: the protocol, the token and the client key. */
export function socketProtocols(
  server: Pick<ServerSettings, 'token'>,
  clientKey: string,
): string[] {
  return ['manufakture-sync', `bearer.${server.token}`, `client.${clientKey}`];
}

// ---------------------------------------------------------------------------------------------
// Versions and branches on the server (T7.1e). Every record read is checked with the schemas the
// server checks with (`@manufakture/sync`); one that does not pass is left out.

/** Document `id`'s versions on the server (every branch's), in the order they were stored. */
export async function listServerVersions(
  server: ServerSettings,
  id: string,
  options: ApiOptions = {},
): Promise<ServerVersion[]> {
  if (!SERVER_DOCUMENT_ID.test(id)) return [];
  const r = await request(server, 'GET', `/documents/${encodeURIComponent(id)}/versions`, options);
  if (r.status === 404) return [];
  if (r.status !== 200) throw failure(r.status, r.body);
  const list = (r.body as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(list)) throw new SyncError('The server sent no list of versions.');
  return list.flatMap((v) => {
    const parsed = ServerVersionSchema.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Document `id`'s branches on the server (main has no record). */
export async function listServerBranches(
  server: ServerSettings,
  id: string,
  options: ApiOptions = {},
): Promise<ServerBranch[]> {
  if (!SERVER_DOCUMENT_ID.test(id)) return [];
  const r = await request(server, 'GET', `/documents/${encodeURIComponent(id)}/branches`, options);
  if (r.status === 404) return [];
  if (r.status !== 200) throw failure(r.status, r.body);
  const list = (r.body as { branches?: unknown } | null)?.branches;
  if (!Array.isArray(list)) throw new SyncError('The server sent no list of branches.');
  return list.flatMap((b) => {
    const parsed = ServerBranchSchema.safeParse(b);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Version `versionId` of document `id` on the server with its document (validated by core), or
 * null when the server has no such version.
 */
export async function fetchServerVersion(
  server: ServerSettings,
  id: string,
  versionId: string,
  options: ApiOptions = {},
): Promise<{ version: ServerVersion; document: ManufaktureDocument } | null> {
  if (!SERVER_DOCUMENT_ID.test(id) || !RECORD_ID.test(versionId)) return null;
  const r = await request(
    server,
    'GET',
    `/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
    options,
  );
  if (r.status === 404) return null;
  if (r.status !== 200) throw failure(r.status, r.body);
  const b = r.body as { version?: unknown; document?: unknown } | null;
  const version = ServerVersionSchema.safeParse(b?.version);
  if (!version.success || version.data.id !== versionId) {
    throw new SyncError('The server sent a damaged version.', r.status);
  }
  const parsed = parseDocument(b?.document);
  if (!parsed.ok) {
    throw new SyncError(`The server's version is invalid: ${parsed.error.message}`, r.status);
  }
  if (parsed.value.document.id !== id)
    throw new SyncError("The server's version is of another document.", r.status);
  return { version: version.data, document: parsed.value.document };
}

/**
 * Stores a version on the server. Resolves when it is there (made now, or already); throws with
 * the server's message otherwise (`status` 409: another version has its id).
 */
export async function uploadServerVersion(
  server: ServerSettings,
  id: string,
  version: ServerVersion,
  options: ApiOptions = {},
): Promise<void> {
  const r = await request(server, 'POST', `/documents/${encodeURIComponent(id)}/versions`, {
    ...options,
    body: { version },
  });
  if (r.status !== 200 && r.status !== 201) throw failure(r.status, r.body);
}

/** Stores a branch record on the server (its log starts from the version it names). */
export async function uploadServerBranch(
  server: ServerSettings,
  id: string,
  branch: ServerBranch,
  options: ApiOptions = {},
): Promise<void> {
  const r = await request(server, 'POST', `/documents/${encodeURIComponent(id)}/branches`, {
    ...options,
    body: { branch },
  });
  if (r.status !== 200 && r.status !== 201) throw failure(r.status, r.body);
}
