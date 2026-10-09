import {
  FORMAT_VERSION,
  PROTOCOL_VERSION,
  parseDocument,
  type CounterTable,
  type ManufaktureDocument,
} from '@manufakture/core';
import { z } from 'zod';
import {
  PushSchema,
  ServerMessageSchema,
  WelcomeSchema,
  type PushedEntry,
  type ServerMessage,
  type SubmitMessage,
  type WelcomeMessage,
} from './protocol';
import {
  MAIN_BRANCH_ID,
  RECORD_ID,
  ServerBranchSchema,
  ServerVersionSchema,
  type ReviewChange,
  type ReviewState,
  type ServerBranch,
  type ServerVersion,
} from './records';

/**
 * A client of the sync server's HTTP routes (apps/server README, "The API"), for Node and the
 * browser alike: a headless session's branch over sync (`packages/session`, T8.4b) and the app's
 * reviewer side of agent branches. It sends the bearer token and nothing else (no cookies, no
 * referrer), checks everything the server answers with the shared schemas and core, and turns
 * every refusal into a `ServerApiError` with the server's status and code. It never quotes the
 * token in an error.
 */

/**
 * An agent token (T8.4b): `agent.<id>.<secret>`, the id 22 and the secret 43 base64url characters
 * (128 and 256 random bits). It fits a WebSocket subprotocol (`bearer.<token>`) unchanged.
 */
export const AGENT_TOKEN = /^agent\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export interface ServerApiOptions {
  /** The server's address (`https://host[:port]`); `/api` is added. */
  readonly url: string;
  /** The instance's token or an agent token. */
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** How long one request may take, ms (default 60 s). */
  readonly timeoutMs?: number;
}

/** A refusal or failure, with the server's status (0: not reached) and code. */
export class ServerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

export interface ServerDocumentInfo {
  id: string;
  name: string;
  /** When it was made on the server, ISO 8601. */
  createdAt: string;
  head: number;
}

export interface ServerSnapshot {
  rev: number;
  document: ManufaktureDocument;
  highWater: CounterTable;
}

export interface ServerBundle {
  revision: number;
  record: Record<string, unknown>;
}

/** A client's claim on a branch log, as `hello` makes it. */
export interface BranchWriter {
  clientId: string;
  key: string;
}

const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;

const DocumentListSchema = z.object({
  documents: z.array(
    z
      .object({ id: z.string(), name: z.string(), createdAt: z.string(), head: z.int().min(0) })
      .loose(),
  ),
});
const MessagesSchema = z.object({ messages: z.array(ServerMessageSchema).max(2000) }).loose();

function query(branch: string): string {
  return branch === MAIN_BRANCH_ID ? '' : `?branch=${encodeURIComponent(branch)}`;
}

export class ServerApi {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ServerApiOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('The sync server is an http or https address.');
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('The sync server address carries no credentials.');
    }
    this.#base = `${url.origin}${url.pathname.replace(/\/+$/, '')}/api`;
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** The id of the agent token this client sends (null: the instance's own token). */
  get agentTokenId(): string | null {
    return AGENT_TOKEN.exec(this.#token)?.[1] ?? null;
  }

  async #request(
    method: string,
    path: string,
    options: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: unknown; bytes?: Uint8Array }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      ...options.headers,
    };
    let body: string | Uint8Array | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.bytes !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = options.bytes;
    }
    let res: Response;
    try {
      // Called unbound: a browser's `fetch` refuses any other `this` than the window.
      const doFetch = this.#fetch;
      res = await doFetch(`${this.#base}${path}`, {
        method,
        headers,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body !== undefined
          ? { body: body as unknown as NonNullable<RequestInit['body']> }
          : {}),
      });
    } catch {
      throw new ServerApiError('The sync server could not be reached.', 0, 'unreachable');
    }
    if ((res.headers.get('content-type') ?? '').startsWith('application/octet-stream')) {
      return { status: res.status, body: null, bytes: new Uint8Array(await res.arrayBuffer()) };
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Not JSON.
    }
    return { status: res.status, body: parsed };
  }

  /** The refusal the server answered with: its code when it is one, a fixed message. */
  #refusal(status: number, body: unknown): ServerApiError {
    const b = body as { code?: unknown; message?: unknown } | null;
    const code = typeof b?.code === 'string' && CODE.test(b.code) ? b.code : `http-${status}`;
    const message =
      typeof b?.message === 'string' && b.message.length > 0
        ? b.message.slice(0, 300)
        : `The sync server answered ${status}.`;
    return new ServerApiError(message, status, code);
  }

  #damaged(what: string): ServerApiError {
    return new ServerApiError(`The sync server sent a damaged ${what}.`, 200, 'damaged');
  }

  #doc(documentId: string): string {
    if (!DOCUMENT_ID.test(documentId)) {
      throw new ServerApiError('There is no such document.', 404, 'not-found');
    }
    return `/documents/${encodeURIComponent(documentId)}`;
  }

  #branch(branch: string): string {
    if (!RECORD_ID.test(branch)) {
      throw new ServerApiError('There is no such branch.', 404, 'not-found');
    }
    return encodeURIComponent(branch);
  }

  /** The documents the token may read. */
  async listDocuments(): Promise<ServerDocumentInfo[]> {
    const r = await this.#request('GET', '/documents');
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const parsed = DocumentListSchema.safeParse(r.body);
    if (!parsed.success) throw this.#damaged('list of documents');
    return parsed.data.documents
      .filter((d) => DOCUMENT_ID.test(d.id))
      .map((d) => ({
        id: d.id,
        name: d.name.slice(0, 200),
        createdAt: d.createdAt.slice(0, 64),
        head: d.head,
      }));
  }

  /** A branch's head (default main), checked by core; null when there is none. */
  async snapshot(documentId: string, branch = MAIN_BRANCH_ID): Promise<ServerSnapshot | null> {
    const r = await this.#request(
      'GET',
      `${this.#doc(documentId)}/snapshot${query(this.#branchId(branch))}`,
    );
    if (r.status === 404) return null;
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const b = r.body as { rev?: unknown; document?: unknown; highWater?: unknown } | null;
    if (!b || !Number.isSafeInteger(b.rev) || (b.rev as number) < 0) throw this.#damaged('head');
    const doc = parseDocument(b.document);
    if (!doc.ok || doc.value.document.id !== documentId) throw this.#damaged('head');
    return {
      rev: b.rev as number,
      document: doc.value.document,
      highWater: (b.highWater ?? {}) as CounterTable,
    };
  }

  #branchId(branch: string): string {
    if (branch !== MAIN_BRANCH_ID) this.#branch(branch);
    return branch;
  }

  async listVersions(documentId: string): Promise<ServerVersion[]> {
    const r = await this.#request('GET', `${this.#doc(documentId)}/versions`);
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const list = (r.body as { versions?: unknown } | null)?.versions;
    if (!Array.isArray(list)) throw this.#damaged('list of versions');
    return list.flatMap((v) => {
      const p = ServerVersionSchema.safeParse(v);
      return p.success ? [p.data] : [];
    });
  }

  /** A version and its document (checked by core); null when there is none. */
  async readVersion(
    documentId: string,
    versionId: string,
  ): Promise<{ version: ServerVersion; document: ManufaktureDocument } | null> {
    const r = await this.#request(
      'GET',
      `${this.#doc(documentId)}/versions/${this.#branch(versionId)}`,
    );
    if (r.status === 404) return null;
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const b = r.body as { version?: unknown; document?: unknown } | null;
    const version = ServerVersionSchema.safeParse(b?.version);
    const doc = parseDocument(b?.document);
    if (!version.success || version.data.id !== versionId || !doc.ok) {
      throw this.#damaged('version');
    }
    if (doc.value.document.id !== documentId) throw this.#damaged('version');
    return { version: version.data, document: doc.value.document };
  }

  async createVersion(documentId: string, version: ServerVersion): Promise<ServerVersion> {
    const r = await this.#request('POST', `${this.#doc(documentId)}/versions`, {
      json: { version },
    });
    if (r.status !== 200 && r.status !== 201) throw this.#refusal(r.status, r.body);
    const p = ServerVersionSchema.safeParse((r.body as { version?: unknown } | null)?.version);
    if (!p.success) throw this.#damaged('version');
    return p.data;
  }

  /** The branch records, provenance included; records that do not check are left out. */
  async listBranches(documentId: string): Promise<ServerBranch[]> {
    const r = await this.#request('GET', `${this.#doc(documentId)}/branches`);
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const list = (r.body as { branches?: unknown } | null)?.branches;
    if (!Array.isArray(list)) throw this.#damaged('list of branches');
    return list.flatMap((b) => {
      const p = ServerBranchSchema.safeParse(b);
      return p.success ? [p.data] : [];
    });
  }

  /**
   * Makes a branch. `commentFrom` names the agent branch whose reviewer's comment carries over;
   * `startVersion` is the version of Main an agent branch starts from, stored with it (T8.4b).
   */
  async createBranch(
    documentId: string,
    branch: ServerBranch,
    options: { commentFrom?: string; startVersion?: ServerVersion } = {},
  ): Promise<ServerBranch> {
    const { commentFrom, startVersion } = options;
    const r = await this.#request('POST', `${this.#doc(documentId)}/branches`, {
      json: {
        branch,
        ...(commentFrom === undefined ? {} : { commentFrom }),
        ...(startVersion === undefined ? {} : { startVersion }),
      },
    });
    if (r.status !== 200 && r.status !== 201) throw this.#refusal(r.status, r.body);
    const p = ServerBranchSchema.safeParse((r.body as { branch?: unknown } | null)?.branch);
    if (!p.success || p.data.id !== branch.id) throw this.#damaged('branch');
    return p.data;
  }

  /**
   * Sets a branch's review state (a compare-and-set with `expected`). A 409 with code
   * `review-changed` means the state was not one of `expected`.
   */
  async setReview(documentId: string, branch: string, change: ReviewChange): Promise<ServerBranch> {
    const r = await this.#request(
      'POST',
      `${this.#doc(documentId)}/branches/${this.#branch(branch)}/review`,
      { json: change },
    );
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const p = ServerBranchSchema.safeParse((r.body as { branch?: unknown } | null)?.branch);
    if (!p.success || p.data.id !== branch) throw this.#damaged('branch');
    return p.data;
  }

  /**
   * Deletes a branch and its log; with `expected`, only while its review state is that. With
   * `withVersions` (the owner's, agent branches only), the versions agents made on it go too.
   */
  async deleteBranch(
    documentId: string,
    branch: string,
    expected?: ReviewState,
    options: { withVersions?: boolean } = {},
  ): Promise<void> {
    const params = new URLSearchParams();
    if (expected !== undefined) params.set('expected', expected);
    if (options.withVersions === true) params.set('withVersions', 'true');
    const q = params.toString() === '' ? '' : `?${params.toString()}`;
    const r = await this.#request(
      'DELETE',
      `${this.#doc(documentId)}/branches/${this.#branch(branch)}${q}`,
    );
    if (r.status !== 204 && r.status !== 404) throw this.#refusal(r.status, r.body);
  }

  /** Claims `writer.clientId` on a branch log with its key: the server's welcome. */
  async hello(documentId: string, branch: string, writer: BranchWriter): Promise<WelcomeMessage> {
    const r = await this.#request('POST', `${this.#doc(documentId)}/hello${query(branch)}`, {
      json: {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        format: FORMAT_VERSION,
        clientId: writer.clientId,
      },
      headers: { 'manufakture-client-key': writer.key },
    });
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const welcome = MessagesSchema.safeParse(r.body);
    const first = welcome.success ? WelcomeSchema.safeParse(welcome.data.messages[0]) : null;
    if (!first?.success) throw this.#damaged('welcome');
    return first.data;
  }

  /** Lets go of a branch log this client holds (one writer per agent branch). */
  async release(documentId: string, branch: string, writer: BranchWriter): Promise<void> {
    const r = await this.#request('POST', `${this.#doc(documentId)}/release${query(branch)}`, {
      json: { clientId: writer.clientId },
      headers: { 'manufakture-client-key': writer.key },
    });
    if (r.status !== 204) throw this.#refusal(r.status, r.body);
  }

  /**
   * A submit; the answers in entry order (a 409 `predecessor-unknown` included). A 409 without
   * messages (`branch-not-open`, `branch-busy`) is a refusal like any other.
   */
  async submit(
    documentId: string,
    branch: string,
    key: string,
    message: SubmitMessage,
  ): Promise<ServerMessage[]> {
    const r = await this.#request('POST', `${this.#doc(documentId)}/entries${query(branch)}`, {
      json: message,
      headers: { 'manufakture-client-key': key },
    });
    const answered =
      r.status === 200 ||
      (r.status === 409 && typeof r.body === 'object' && r.body !== null && 'messages' in r.body);
    if (!answered) throw this.#refusal(r.status, r.body);
    const p = MessagesSchema.safeParse(r.body);
    if (!p.success) throw this.#damaged('answer');
    return p.data.messages as ServerMessage[];
  }

  /** Accepted entries after `since` (up to the server's page size). */
  async pull(documentId: string, branch: string, since: number): Promise<PushedEntry[]> {
    const sep = branch === MAIN_BRANCH_ID ? '?' : `${query(branch)}&`;
    const r = await this.#request('GET', `${this.#doc(documentId)}/entries${sep}since=${since}`);
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const m = MessagesSchema.safeParse(r.body);
    const push = m.success ? PushSchema.safeParse(m.data.messages[0]) : null;
    if (!push?.success) throw this.#damaged('pull');
    return push.data.entries as PushedEntry[];
  }

  async putBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    if (!SHA256.test(sha256)) throw new ServerApiError('Not a blob name.', 400, 'invalid-hash');
    const r = await this.#request('PUT', `/blobs/${sha256}`, { bytes });
    if (r.status !== 200 && r.status !== 201) throw this.#refusal(r.status, r.body);
  }

  /** A blob's bytes (not checked here: the caller checks them against the name); null if none. */
  async getBlob(sha256: string): Promise<Uint8Array | null> {
    if (!SHA256.test(sha256)) return null;
    const r = await this.#request('GET', `/blobs/${sha256}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || r.bytes === undefined) throw this.#refusal(r.status, r.body);
    return r.bytes;
  }

  async putBundle(
    documentId: string,
    branch: string,
    revision: number,
    record: unknown,
  ): Promise<void> {
    const r = await this.#request(
      'PUT',
      `${this.#doc(documentId)}/branches/${this.#branch(branch)}/bundle`,
      { json: { revision, record } },
    );
    if (r.status !== 200 && r.status !== 201) throw this.#refusal(r.status, r.body);
  }

  /**
   * The revision and size of the newest review bundle stored with a branch, or null: a cheap look
   * before downloading one (`getBundle`).
   */
  async bundleMeta(
    documentId: string,
    branch: string,
  ): Promise<{ revision: number; bytes: number } | null> {
    const r = await this.#request(
      'GET',
      `${this.#doc(documentId)}/branches/${this.#branch(branch)}/bundle/meta`,
    );
    if (r.status === 404) return null;
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const b = r.body as { revision?: unknown; bytes?: unknown } | null;
    if (
      !b ||
      !Number.isSafeInteger(b.revision) ||
      (b.revision as number) < 1 ||
      !Number.isSafeInteger(b.bytes) ||
      (b.bytes as number) < 0
    ) {
      throw this.#damaged('review bundle');
    }
    return { revision: b.revision as number, bytes: b.bytes as number };
  }

  /** The newest review bundle stored with a branch, or null. Its content is unchecked. */
  async getBundle(documentId: string, branch: string): Promise<ServerBundle | null> {
    const r = await this.#request(
      'GET',
      `${this.#doc(documentId)}/branches/${this.#branch(branch)}/bundle`,
    );
    if (r.status === 404) return null;
    if (r.status !== 200) throw this.#refusal(r.status, r.body);
    const b = r.body as { revision?: unknown; record?: unknown } | null;
    if (
      !b ||
      !Number.isSafeInteger(b.revision) ||
      (b.revision as number) < 1 ||
      typeof b.record !== 'object' ||
      b.record === null ||
      Array.isArray(b.record)
    ) {
      throw this.#damaged('review bundle');
    }
    return { revision: b.revision as number, record: b.record as Record<string, unknown> };
  }
}
