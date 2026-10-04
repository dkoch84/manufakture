import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Share links (M7 plan, T7.3d; docs/user/sharing.md): a published view (`.mfkview`) stored under
 * an unguessable id, which anyone holding the link can download and nobody can list.
 *
 * - `POST /api/shares?name=&expires=` (token): the bundle as the body, `MFKVIEW_MIME`. `expires`
 *   is a whole number of days or `never`; without it the configured default (30 days). The size
 *   cap is the route's body limit, counted while the body streams in: a request that says or
 *   turns out larger is cut off at the cap and never held whole. The count cap is checked before
 *   the body is read, and again when it is stored.
 * - `GET /api/shares` (token): the active shares and the limits.
 * - `GET /api/shares/:id` (public): the bytes. CORS only for the viewer's origins, `nosniff`, a
 *   type no browser renders, `attachment`, a sandboxing CSP, and `no-store`, so a revoked or
 *   expired share is gone on the next request. Unknown, revoked and expired ids all answer the
 *   same 404.
 * - `DELETE /api/shares/:id` (token): revokes; the row and its bytes are deleted.
 *
 * Shares belong to the token that made them (its SHA-256), which is what the per-token limits
 * count. Expired shares are deleted when read, listed, or when a new share is made.
 */

/** The bundle's media type (`@manufakture/io`'s `MFKVIEW_MIME`). */
export const SHARE_MIME = 'application/vnd.manufakture.view+zip';

/** A share id: 128 random bits, base64url without padding. */
export const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

/** The longest share name kept (it is only shown to the share's owner). */
export const MAX_SHARE_NAME = 200;

/** The longest expiry that can be asked for, in days, besides `never`. */
export const MAX_EXPIRY_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a self-hoster can configure about shares (config.ts reads them). */
export interface ShareConfig {
  /** The largest bundle, in bytes. */
  readonly maxBytes: number;
  /** The most active shares one token may hold. */
  readonly maxShares: number;
  /** The expiry of a share that asks for none, in days. */
  readonly defaultExpiryDays: number;
  /** Whether a share may ask never to expire. */
  readonly allowNever: boolean;
  /** Public downloads served at once; more get 503 with Retry-After. */
  readonly maxConcurrentReads: number;
  /**
   * Milliseconds one public download may take before its connection is cut, so a slow (or
   * stalled) reader cannot hold one of the `maxConcurrentReads` slots, and the bundle's bytes in
   * memory, for ever.
   */
  readonly readTimeoutMs: number;
  /** Origins allowed by CORS on the public download: where the viewer is served. */
  readonly viewerOrigins: readonly string[];
}

export const DEFAULT_SHARE_CONFIG: ShareConfig = {
  maxBytes: 50 * 1024 * 1024,
  maxShares: 100,
  defaultExpiryDays: 30,
  allowNever: true,
  maxConcurrentReads: 8,
  readTimeoutMs: 120_000,
  viewerOrigins: [],
};

/** One share, as its owner sees it. */
export interface ShareInfo {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  /** ISO time. */
  readonly createdAt: string;
  /** ISO time, or null for never. */
  readonly expiresAt: string | null;
}

/** Where shares are kept. */
export interface ShareStore {
  /** Stores a share unless `owner` already holds `maxShares` active ones (then false). */
  create(
    owner: string,
    share: { id: string; name: string; createdAt: number; expiresAt: number | null },
    bytes: Buffer,
    maxShares: number,
    now: number,
  ): boolean;
  /** The bytes of an active share; an expired one is deleted and reads as missing. */
  read(id: string, now: number): Buffer | undefined;
  /** `owner`'s active shares, newest first. */
  list(owner: string, now: number): ShareInfo[];
  /** `owner`'s active shares, counted. */
  count(owner: string, now: number): number;
  /** Deletes `owner`'s share `id`; false when there is none. */
  remove(owner: string, id: string): boolean;
  /** Deletes every expired share; returns how many. */
  sweep(now: number): number;
}

/** A new share id: 16 bytes from the system's CSPRNG. */
export function newShareId(): string {
  return randomBytes(16).toString('base64url');
}

/** `expires` from the query: days, `never`, or absent; an error message when it is not allowed. */
export function parseExpiry(
  raw: string | undefined,
  config: Pick<ShareConfig, 'defaultExpiryDays' | 'allowNever'>,
): { ok: true; days: number | null } | { ok: false; message: string } {
  if (raw === undefined || raw === '') return { ok: true, days: config.defaultExpiryDays };
  if (raw === 'never') {
    return config.allowNever
      ? { ok: true, days: null }
      : { ok: false, message: 'This server does not keep shares forever: pick a number of days' };
  }
  if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_EXPIRY_DAYS) {
    return {
      ok: false,
      message: `expires must be a whole number of days from 1 to ${MAX_EXPIRY_DAYS}, or never`,
    };
  }
  return { ok: true, days: Number(raw) };
}

/** A name fit to store: control characters dropped, trimmed, cut to `MAX_SHARE_NAME`. */
export function cleanName(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const s = (raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  return [...s].slice(0, MAX_SHARE_NAME).join('') || 'Shared view';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS shares_owner ON shares (owner, created_at);
`;

interface ShareRow {
  id: string;
  name: string;
  size: number;
  created_at: number;
  expires_at: number | null;
}

const ACTIVE = '(expires_at IS NULL OR expires_at > ?)';

/** `ShareStore` in the server's SQLite database (a `shares` table next to the sync tables). */
export class SqliteShareStore implements ShareStore {
  private readonly stmt;
  private readonly createTx;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    this.stmt = {
      insert: db.prepare(
        `INSERT INTO shares (id, owner, name, size, data, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      count: db.prepare(`SELECT count(*) FROM shares WHERE owner = ? AND ${ACTIVE}`).pluck(),
      read: db.prepare('SELECT data, expires_at FROM shares WHERE id = ?'),
      list: db.prepare(
        `SELECT id, name, size, created_at, expires_at FROM shares WHERE owner = ? AND ${ACTIVE}
         ORDER BY created_at DESC, id`,
      ),
      remove: db.prepare('DELETE FROM shares WHERE owner = ? AND id = ?'),
      removeId: db.prepare('DELETE FROM shares WHERE id = ?'),
      sweep: db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?'),
    };
    this.createTx = db.transaction(
      (
        owner: string,
        s: { id: string; name: string; createdAt: number; expiresAt: number | null },
        bytes: Buffer,
        maxShares: number,
        now: number,
      ): boolean => {
        this.stmt.sweep.run(now);
        if ((this.stmt.count.get(owner, now) as number) >= maxShares) return false;
        this.stmt.insert.run(s.id, owner, s.name, bytes.length, bytes, s.createdAt, s.expiresAt);
        return true;
      },
    );
  }

  create(
    owner: string,
    share: { id: string; name: string; createdAt: number; expiresAt: number | null },
    bytes: Buffer,
    maxShares: number,
    now: number,
  ): boolean {
    return this.createTx.immediate(owner, share, bytes, maxShares, now);
  }

  read(id: string, now: number): Buffer | undefined {
    const r = this.stmt.read.get(id) as { data: Buffer; expires_at: number | null } | undefined;
    if (r === undefined) return undefined;
    if (r.expires_at !== null && r.expires_at <= now) {
      this.stmt.removeId.run(id);
      return undefined;
    }
    return r.data;
  }

  list(owner: string, now: number): ShareInfo[] {
    this.stmt.sweep.run(now);
    return (this.stmt.list.all(owner, now) as ShareRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: r.expires_at === null ? null : new Date(r.expires_at).toISOString(),
    }));
  }

  count(owner: string, now: number): number {
    return this.stmt.count.get(owner, now) as number;
  }

  remove(owner: string, id: string): boolean {
    return this.stmt.remove.run(owner, id).changes === 1;
  }

  sweep(now: number): number {
    return this.stmt.sweep.run(now).changes;
  }
}

/**
 * The headers of a public download: nothing a browser would render, run or keep.
 *
 * `Cross-Origin-Resource-Policy` only governs no-cors loads (an `<img>`, `<script>` or `<object>`
 * on another site pointing at the link): `same-origin` refuses those. It does not affect the
 * viewer, which fetches the bundle in CORS mode; that is decided by `Access-Control-Allow-Origin`
 * alone, sent for the viewer's origins only (app.ts). Neither keeps the bytes from anyone holding
 * the link: a non-browser client ignores both.
 */
export const SHARE_READ_HEADERS: Readonly<Record<string, string>> = {
  'content-type': SHARE_MIME,
  'content-disposition': 'attachment; filename="shared.mfkview"',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store',
};

/** Whether `req` is a public read of one share (a GET or HEAD, or the preflight for one). */
export function isShareRead(req: FastifyRequest, prefix: string): boolean {
  const path = req.url.split('?', 1)[0]!;
  if (!path.startsWith(`${prefix}/shares/`) || path.slice(prefix.length + 8).includes('/')) {
    return false;
  }
  const method =
    req.method === 'OPTIONS'
      ? String(req.headers['access-control-request-method'] ?? '').toUpperCase()
      : req.method;
  return method === 'GET' || method === 'HEAD';
}

export interface ShareRoutesOptions {
  readonly store: ShareStore;
  readonly config: ShareConfig;
  /** The owner key of the request's (already checked) token. */
  readonly ownerOf: (req: FastifyRequest) => string;
  readonly now?: () => number;
}

/** Fastify route config: a route the token check lets through. */
export interface PublicRouteConfig {
  readonly public?: boolean;
}

const notFound = { code: 'not-found', message: 'No such share' } as const;

/** Registers the share routes on `api` (the `/api` scope, behind its token check). */
export function registerShareRoutes(api: FastifyInstance, options: ShareRoutesOptions): void {
  const { store, config, ownerOf } = options;
  const now = options.now ?? Date.now;
  let reading = 0;

  // The bundle is taken as raw bytes; the route's body limit (`maxBytes`) caps it as it streams.
  api.addContentTypeParser(SHARE_MIME, { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  api.post<{ Querystring: { name?: string; expires?: string } }>(
    '/shares',
    {
      bodyLimit: config.maxBytes,
      // Before the body is read: a full quota or a bad expiry costs the client no upload.
      onRequest: async (req, reply) => {
        const expiry = parseExpiry(req.query.expires, config);
        if (!expiry.ok) {
          return reply.code(400).send({ code: 'invalid-request', message: expiry.message });
        }
        if (store.count(ownerOf(req), now()) >= config.maxShares) {
          return reply.code(409).send({
            code: 'too-many-shares',
            message: `This server keeps at most ${config.maxShares} active shares: revoke one first`,
          });
        }
      },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) {
        return reply
          .code(415)
          .send({ code: 'unsupported-media-type', message: `Send ${SHARE_MIME}` });
      }
      const bytes = req.body;
      // A .mfkview is a zip: its first local file header. The viewer checks the rest.
      if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
        return reply
          .code(400)
          .send({ code: 'not-a-bundle', message: 'The body is not a .mfkview bundle' });
      }
      const expiry = parseExpiry(req.query.expires, config);
      if (!expiry.ok) {
        return reply.code(400).send({ code: 'invalid-request', message: expiry.message });
      }
      const t = now();
      const share = {
        id: newShareId(),
        name: cleanName(req.query.name),
        createdAt: t,
        expiresAt: expiry.days === null ? null : t + expiry.days * DAY_MS,
      };
      if (!store.create(ownerOf(req), share, bytes, config.maxShares, t)) {
        return reply.code(409).send({
          code: 'too-many-shares',
          message: `This server keeps at most ${config.maxShares} active shares: revoke one first`,
        });
      }
      const info: ShareInfo = {
        id: share.id,
        name: share.name,
        size: bytes.length,
        createdAt: new Date(share.createdAt).toISOString(),
        expiresAt: share.expiresAt === null ? null : new Date(share.expiresAt).toISOString(),
      };
      return reply.code(201).send(info);
    },
  );

  api.get('/shares', async (req) => ({
    shares: store.list(ownerOf(req), now()),
    limits: {
      maxBytes: config.maxBytes,
      maxShares: config.maxShares,
      defaultExpiryDays: config.defaultExpiryDays,
      allowNever: config.allowNever,
    },
  }));

  api.get<{ Params: { id: string } }>(
    '/shares/:id',
    { config: { public: true } satisfies PublicRouteConfig },
    async (req, reply) => {
      const { id } = req.params;
      if (!SHARE_ID.test(id)) return reply.code(404).send(notFound);
      if (reading >= config.maxConcurrentReads) {
        return reply
          .code(503)
          .header('retry-after', '5')
          .send({ code: 'busy', message: 'Too many downloads at once: try again shortly' });
      }
      reading += 1;
      // The bundle is one SQLite value, read whole (better-sqlite3 has no incremental blob
      // reads); what a slow reader can hold is bounded by the slot count, the size cap and this
      // deadline, after which the connection is cut and the slot freed.
      const deadline = setTimeout(() => reply.raw.destroy(), config.readTimeoutMs);
      reply.raw.once('close', () => {
        clearTimeout(deadline);
        reading -= 1;
      });
      const bytes = store.read(id, now());
      if (bytes === undefined) return reply.code(404).send(notFound);
      return reply.headers(SHARE_READ_HEADERS).send(bytes);
    },
  );

  api.delete<{ Params: { id: string } }>('/shares/:id', async (req, reply) => {
    const { id } = req.params;
    if (!SHARE_ID.test(id) || !store.remove(ownerOf(req), id)) {
      return reply.code(404).send(notFound);
    }
    return reply.code(204).send();
  });
}
