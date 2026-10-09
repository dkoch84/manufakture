import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import type { PushMessage, PushedEntry, ServerMessage } from '@manufakture/sync';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { WebSocket } from 'ws';
import { TokenBucket, checkJsonShape, type Limits } from './limits';
import { BRANCH_ID, SyncService, type Reply, type ReplyError } from './service';
import {
  IssueTokenSchema,
  MAX_AGENT_TOKENS,
  OWNER,
  type AgentTokenStore,
  type Principal,
} from './tokens';
import {
  isShareRead,
  registerShareRoutes,
  type PublicRouteConfig,
  type ShareConfig,
  type ShareStore,
} from './shares';
import { MAIN_BRANCH, type SyncStore } from './store';

/**
 * The HTTP and WebSocket transport (ADR 0009 decision 11), everything under `/api`:
 *
 * - `GET /api/health` (no token): `{ ok: true }`.
 * - `POST /api/documents`, `GET /api/documents`, `GET /api/documents/:id/snapshot`.
 * - `POST /api/documents/:id/hello`, `POST /api/documents/:id/entries` (submit),
 *   `GET /api/documents/:id/entries?since=` (pull): protocol messages in `{ messages }`.
 * - `PUT` and `GET /api/blobs/:sha256`.
 * - `GET /api/documents/:id/socket`: a WebSocket carrying the same protocol messages, and pushes.
 * - Each of the sync routes above takes `?branch=<id>` for a branch's own log (default `main`).
 * - `GET`/`POST /api/documents/:id/versions`, `GET /api/documents/:id/versions/:versionId`,
 *   `GET`/`POST /api/documents/:id/branches`: named versions and branch records (T7.1e).
 * - `POST`/`GET /api/shares`, `GET`/`DELETE /api/shares/:id`: share links (shares.ts), when
 *   `shares` is given. `GET /api/shares/:id` is public, with CORS for the viewer's origins only.
 *
 * - `POST /api/documents/:id/release`: a client lets go of an agent branch's log (T8.4b).
 * - `POST /api/documents/:id/branches/:branch/review`, `DELETE /api/documents/:id/branches/:branch`,
 *   `PUT`/`GET /api/documents/:id/branches/:branch/bundle`, `GET .../bundle/meta`: agent branches'
 *   review states, their deletion and their review bundles (T8.4b).
 * - `POST`/`GET /api/agent-tokens`, `DELETE /api/agent-tokens/:tokenId`: agent tokens (T8.4b).
 *
 * Every route but `health` and the public share download needs a bearer token: `Authorization: Bearer <token>`,
 * or for a WebSocket (browsers cannot set its headers) the subprotocol `bearer.<token>` next to
 * `manufakture-sync`. No cookies; CORS only for the configured origins.
 *
 * Two kinds of token (ADR 0016 decision 12): the instance's own, which may do everything, and
 * agent tokens (tokens.ts), which reach only the routes marked `agent` in their config, and on
 * those only the documents they are scoped to; every other route answers an agent token 403.
 * What an agent token may do on a marked route is checked again in the service, from the stored
 * branch records.
 */

export const API_PREFIX = '/api';
/** The WebSocket subprotocol the server speaks. */
export const SUBPROTOCOL = 'manufakture-sync';
/** The HTTP header that carries the client key on submits and hellos. */
export const CLIENT_KEY_HEADER = 'manufakture-client-key';
/** The largest body of a version or branch record (a record is well under 3 KiB). */
export const RECORD_BODY_BYTES = 16 * 1024;

/** `?branch=`: absent is main; anything but a branch id is refused (null). */
function branchOf(query: unknown): string | null {
  const raw = (query as { branch?: unknown } | undefined)?.branch;
  if (raw === undefined) return MAIN_BRANCH;
  return typeof raw === 'string' && BRANCH_ID.test(raw) ? raw : null;
}

const BAD_BRANCH = { code: 'invalid-request', message: 'branch must be a branch id' } as const;

/**
 * Which routes an agent token reaches (`config.agent`): `scoped` ones under
 * `/documents/:id`, for the documents the token is scoped to, and `listed` and `blob-put`. A
 * route without it is the owner's alone.
 */
export interface RouteAccess {
  readonly agent?: 'scoped' | 'listed' | 'blob-put';
}

const SCOPED = { config: { agent: 'scoped' } satisfies RouteAccess };

/** The largest body of an agent token request (its name and up to 100 document ids). */
export const TOKEN_BODY_BYTES = 64 * 1024;

export interface AppOptions {
  /** The instance's bearer token. */
  readonly token: string;
  /** Agent tokens (T8.4b); without it only the instance's token is known and there are no token routes. */
  readonly agentTokens?: AgentTokenStore;
  readonly store: SyncStore;
  readonly limits: Limits;
  /** Origins allowed by CORS and on WebSocket upgrades (exact `scheme://host[:port]`). */
  readonly origins: readonly string[];
  /** Fastify's logger option (`false` in tests). */
  readonly logger?: boolean | { level: string };
  /** Trust `X-Forwarded-*` from a reverse proxy. */
  readonly trustProxy?: boolean;
  /** Passed to `SyncService` (version-skew tests). */
  readonly service?: SyncService;
  /**
   * Test only (the app's end-to-end sync test, T7.1d): how long to hold each WebSocket message
   * to a connection, in milliseconds (0: send now), so a test can deliver a verdict or a push
   * late. A held message is dropped if its connection closes meanwhile. Never set by `main.ts`.
   */
  readonly testReplyDelay?: (
    to: { readonly documentId: string; readonly clientId: string | undefined },
    message: ServerMessage,
  ) => number;
  /** Share links (shares.ts); without it the share routes do not exist. */
  readonly shares?: {
    readonly store: ShareStore;
    readonly config: ShareConfig;
    /** The clock expiry is judged by (tests). */
    readonly now?: () => number;
  };
}

interface Connection {
  readonly socket: WebSocket;
  readonly documentId: string;
  readonly branch: string;
  readonly principal: Principal;
  clientId?: string;
}

/** Connections are grouped by document and branch: a push goes to that branch's only. */
const groupOf = (documentId: string, branch: string) => `${documentId}\u0000${branch}`;

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function protocolsOf(req: FastifyRequest): string[] {
  const h = req.headers['sec-websocket-protocol'];
  if (typeof h !== 'string') return [];
  return h
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * `push` cut into pushes of at most `maxBytes` of entries (as JSON; at least one entry each), the
 * same bound as a pull, so a large submit's push never passes the app's inbound limit
 * (`limits.ts`, `maxPullBytes`). Clients take pushed entries in any order.
 */
export function splitPush(push: PushMessage, maxBytes: number): PushMessage[] {
  const parts: PushMessage[] = [];
  let entries: PushedEntry[] = [];
  let bytes = 0;
  for (const e of push.entries) {
    const size = Buffer.byteLength(JSON.stringify(e.entry));
    if (entries.length > 0 && bytes + size > maxBytes) {
      parts.push({ type: 'push', entries });
      entries = [];
      bytes = 0;
    }
    entries.push(e);
    bytes += size;
  }
  if (entries.length > 0 || parts.length === 0) parts.push({ type: 'push', entries });
  return parts;
}

function errorBody(e: ReplyError) {
  return { code: e.code, message: e.message, ...(e.messages && { messages: e.messages }) };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { limits, store } = options;
  const tokenHash = digest(options.token);
  const service = options.service ?? new SyncService(store, { limits });
  const origins = new Set(options.origins);
  const sockets = new Map<string, Set<Connection>>();
  let connections = 0;

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: limits.maxBodyBytes,
    trustProxy: options.trustProxy ?? false,
    return503OnClosing: true,
    // Fastify leaves requestTimeout off (0), which also lifts Node's own 300 s default: without
    // these, a client trickling a 40 MiB body byte by byte would hold its connection and buffer
    // for as long as it liked. A WebSocket is not affected once upgraded (its idle peers are
    // bounded by the hello timeout and the socket buffer limit).
    requestTimeout: limits.requestTimeoutMs,
    connectionTimeout: limits.connectionTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
  });

  const principals = new WeakMap<FastifyRequest, Principal>();
  /** Who the request's token speaks for: the owner, an agent token, or nobody (null). */
  const principalOf = (req: FastifyRequest): Principal | null => {
    let token: string | undefined;
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.startsWith('Bearer ')) token = h.slice(7).trim();
    if (token === undefined && req.headers.upgrade?.toLowerCase() === 'websocket') {
      token = protocolsOf(req)
        .find((p) => p.startsWith('bearer.'))
        ?.slice(7);
    }
    if (token === undefined || token.length === 0 || token.length > 1024) return null;
    if (timingSafeEqual(digest(token), tokenHash)) return OWNER;
    return options.agentTokens?.verify(token) ?? null;
  };
  /**
   * The principal `onRequest` found (routes behind the token only). Fails closed: a route that
   * asks without one having been recorded is a bug, answered 500, never taken for the owner.
   */
  const principal = (req: FastifyRequest): Principal => {
    const p = principals.get(req);
    if (p === undefined) throw new Error('No principal was recorded for this request');
    return p;
  };

  const sendReply = (reply: FastifyReply, r: Reply, group?: string) => {
    if (!r.ok) {
      if (r.retryAfterMs !== undefined) {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      }
      return reply.code(r.status).send(errorBody(r));
    }
    if (r.push && group !== undefined) broadcast(group, r.push);
    const body: { messages: ServerMessage[]; code?: string } = { messages: r.messages };
    if (r.status === 409) body.code = 'predecessor-unknown';
    return reply.code(r.status).send(body);
  };

  const broadcast = (group: string, push: PushMessage) => {
    const set = sockets.get(group);
    if (set === undefined) return;
    for (const part of splitPush(push, limits.maxPullBytes)) {
      const text = JSON.stringify(part);
      for (const c of set) {
        if (c.clientId === undefined) continue;
        if (options.testReplyDelay) deliver(c, part);
        else sendText(c, text);
      }
    }
  };

  /** Sends `m` to `c`, held as long as the test hook says (when there is one). */
  const deliver = (c: Connection, m: ServerMessage) => {
    const delay = options.testReplyDelay?.({ documentId: c.documentId, clientId: c.clientId }, m);
    if (delay === undefined || delay <= 0) sendText(c, JSON.stringify(m));
    else setTimeout(() => sendText(c, JSON.stringify(m)), delay);
  };

  /** Closes every connection of a document's branch (it was deleted). */
  const closeGroup = (group: string, code: number, reason: string) => {
    for (const c of sockets.get(group) ?? []) c.socket.close(code, reason);
  };

  const sendText = (c: Connection, text: string) => {
    if (c.socket.readyState !== c.socket.OPEN) return;
    if (c.socket.bufferedAmount + text.length > limits.maxSocketBufferBytes) {
      // A reader this slow would hold the server's memory; it pulls what it missed on reconnect.
      c.socket.close(1013, 'too slow');
      return;
    }
    c.socket.send(text);
  };

  // The app's origins for everything, except a public share download (or its preflight), which
  // is allowed for the viewer's origins only, without credentials or extra headers.
  const viewerOrigins = new Set(options.shares?.config.viewerOrigins ?? []);
  await app.register(fastifyCors, {
    delegator: (req, cb) => {
      const origin = req.headers.origin;
      if (options.shares !== undefined && isShareRead(req, API_PREFIX)) {
        cb(null, {
          origin: origin !== undefined && viewerOrigins.has(origin),
          credentials: false,
          methods: ['GET', 'HEAD'],
          allowedHeaders: [],
          exposedHeaders: ['Content-Length'],
          maxAge: 600,
        });
        return;
      }
      cb(null, {
        origin: origin !== undefined && origins.has(origin),
        credentials: false,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', CLIENT_KEY_HEADER],
        exposedHeaders: ['Retry-After'],
        maxAge: 600,
      });
    },
  });
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: limits.maxMessageBytes,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    },
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: limits.maxBlobBytes },
    (_req, body, done) => done(null, body),
  );

  app.addHook('onSend', async (req, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: FastifyError, req, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      req.log.error(error);
      return reply.code(500).send({ code: 'internal', message: 'Internal server error' });
    }
    // Fixed messages: Fastify's own (a JSON syntax error, a bad header) can quote the request.
    const [code, message] =
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? ['too-large', 'The body is too large']
        : error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
          ? ['unsupported-media-type', 'Unsupported content type']
          : status === 408
            ? ['timeout', 'The request took too long']
            : ['invalid-request', 'The request is invalid'];
    return reply.code(status).send({ code, message });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ code: 'not-found', message: 'Not found' }),
  );

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req, reply) => {
        if (req.method === 'OPTIONS') return;
        if (req.routeOptions.url === `${API_PREFIX}/health`) return;
        if ((req.routeOptions.config as PublicRouteConfig | undefined)?.public === true) return;
        const who = principalOf(req);
        if (who === null) {
          return reply.code(401).header('www-authenticate', 'Bearer').send({
            code: 'unauthorized',
            message: 'A valid bearer token is required',
          });
        }
        principals.set(req, who);
        if (who.kind === 'agent') {
          // Deny by default: an agent token reaches only the routes marked for it.
          const access = (req.routeOptions.config as RouteAccess | undefined)?.agent;
          if (access === undefined) {
            return reply
              .code(403)
              .send({ code: 'owner-only', message: 'An agent token may not do this' });
          }
          const id = (req.params as { id?: unknown } | undefined)?.id;
          if (access === 'scoped' && (typeof id !== 'string' || !who.documents.has(id))) {
            return reply.code(403).send({
              code: 'out-of-scope',
              message: 'This token is not scoped to that document',
            });
          }
        }
        const origin = req.headers.origin;
        if (req.headers.upgrade !== undefined && origin !== undefined && !origins.has(origin)) {
          return reply.code(403).send({ code: 'origin', message: 'Origin not allowed' });
        }
      });
      // Every JSON body is checked for depth and size in values before any schema reads it.
      api.addHook('preValidation', async (req, reply) => {
        if (req.body === undefined || Buffer.isBuffer(req.body)) return;
        const shape = checkJsonShape(req.body, limits.maxJsonDepth, limits.maxJsonNodes);
        if (!shape.ok && shape.forbiddenKey) {
          return reply
            .code(400)
            .send({ code: 'invalid-request', message: 'The body holds a forbidden key' });
        }
        if (!shape.ok) {
          return reply
            .code(413)
            .send({ code: 'too-complex', message: `The body is ${shape.message}` });
        }
      });

      api.get('/health', async () => ({ ok: true }));

      if (options.shares !== undefined) {
        const owner = tokenHash.toString('hex');
        registerShareRoutes(api, {
          store: options.shares.store,
          config: options.shares.config,
          // One token per instance: every share belongs to it.
          ownerOf: () => owner,
          ...(options.shares.now && { now: options.shares.now }),
        });
      }

      api.post('/documents', async (req, reply) => {
        const r = service.createDocument(req.body);
        if (r.ok && 'id' in r) return reply.code(201).send({ id: r.id, head: r.head });
        return sendReply(reply, r as Reply);
      });

      api.get('/documents', { config: { agent: 'listed' } satisfies RouteAccess }, async (req) => ({
        documents: service.listDocuments(principal(req)),
      }));

      api.get<{ Params: { id: string } }>('/documents/:id/snapshot', SCOPED, async (req, reply) => {
        const branch = branchOf(req.query);
        if (branch === null) return reply.code(400).send(BAD_BRANCH);
        const s = service.snapshot(req.params.id, branch);
        if (s === undefined)
          return reply.code(404).send({ code: 'not-found', message: 'No such document' });
        return s;
      });

      api.post<{ Params: { id: string } }>('/documents/:id/hello', SCOPED, async (req, reply) => {
        const branch = branchOf(req.query);
        if (branch === null) return reply.code(400).send(BAD_BRANCH);
        const key = req.headers[CLIENT_KEY_HEADER];
        const r = service.hello(
          req.params.id,
          req.body,
          typeof key === 'string' ? key : undefined,
          branch,
          principal(req),
        );
        return sendReply(reply, r);
      });

      api.post<{ Params: { id: string } }>('/documents/:id/entries', SCOPED, async (req, reply) => {
        const branch = branchOf(req.query);
        if (branch === null) return reply.code(400).send(BAD_BRANCH);
        const key = req.headers[CLIENT_KEY_HEADER];
        const r = service.submit(
          req.params.id,
          req.body,
          { key: typeof key === 'string' ? key : undefined },
          branch,
          principal(req),
        );
        return sendReply(reply, r, groupOf(req.params.id, branch));
      });

      api.post<{ Params: { id: string } }>(
        '/documents/:id/release',
        { ...SCOPED, bodyLimit: RECORD_BODY_BYTES },
        async (req, reply) => {
          const branch = branchOf(req.query);
          if (branch === null) return reply.code(400).send(BAD_BRANCH);
          const key = req.headers[CLIENT_KEY_HEADER];
          const r = service.release(
            req.params.id,
            req.body,
            typeof key === 'string' ? key : undefined,
            branch,
            principal(req),
          );
          if (!r.ok) return sendReply(reply, r);
          return reply.code(204).send();
        },
      );

      api.get<{ Params: { id: string }; Querystring: { since?: string } }>(
        '/documents/:id/entries',
        SCOPED,
        async (req, reply) => {
          const branch = branchOf(req.query);
          if (branch === null) return reply.code(400).send(BAD_BRANCH);
          const since = Number(req.query.since ?? '0');
          if (!/^\d{1,16}$/.test(req.query.since ?? '0') || !Number.isSafeInteger(since)) {
            return reply
              .code(400)
              .send({ code: 'invalid-request', message: 'since must be a revision' });
          }
          return sendReply(reply, service.pull(req.params.id, since, branch));
        },
      );

      // Versions and branches (T7.1e). Records are small: their bodies are capped well below the
      // general limit, checked by schema, and every refusal has a fixed message.
      const recordReply = (
        reply: FastifyReply,
        r: Reply | { ok: true; status: 200 | 201; record: unknown },
        field: 'version' | 'branch',
      ) => {
        if ('record' in r) return reply.code(r.status).send({ [field]: r.record });
        return sendReply(reply, r);
      };

      api.get<{ Params: { id: string } }>('/documents/:id/versions', SCOPED, async (req, reply) => {
        const r = service.listVersions(req.params.id);
        if ('versions' in r) return { versions: r.versions };
        return sendReply(reply, r);
      });

      api.post<{ Params: { id: string } }>(
        '/documents/:id/versions',
        { ...SCOPED, bodyLimit: RECORD_BODY_BYTES },
        async (req, reply) =>
          recordReply(
            reply,
            service.createVersion(req.params.id, req.body, principal(req)),
            'version',
          ),
      );

      api.get<{ Params: { id: string; versionId: string } }>(
        '/documents/:id/versions/:versionId',
        SCOPED,
        async (req, reply) => {
          const r = service.readVersion(req.params.id, req.params.versionId);
          if ('version' in r) return { version: r.version, document: r.document };
          return sendReply(reply, r);
        },
      );

      // The owner's alone (no `agent` access): an agent-made version no branch starts from.
      api.delete<{ Params: { id: string; versionId: string } }>(
        '/documents/:id/versions/:versionId',
        async (req, reply) => {
          const r = service.deleteVersion(req.params.id, req.params.versionId, principal(req));
          if (!r.ok) return sendReply(reply, r);
          return reply.code(204).send();
        },
      );

      api.get<{ Params: { id: string } }>('/documents/:id/branches', SCOPED, async (req, reply) => {
        const r = service.listBranches(req.params.id);
        if ('branches' in r) return { branches: r.branches };
        return sendReply(reply, r);
      });

      api.post<{ Params: { id: string } }>(
        '/documents/:id/branches',
        { ...SCOPED, bodyLimit: RECORD_BODY_BYTES },
        async (req, reply) =>
          recordReply(
            reply,
            service.createBranch(req.params.id, req.body, principal(req)),
            'branch',
          ),
      );

      // Agent branches (T8.4b): review states, deletion (an update from Main), review bundles.
      api.post<{ Params: { id: string; branch: string } }>(
        '/documents/:id/branches/:branch/review',
        { ...SCOPED, bodyLimit: RECORD_BODY_BYTES },
        async (req, reply) =>
          recordReply(
            reply,
            service.setReview(req.params.id, req.params.branch, req.body, principal(req)),
            'branch',
          ),
      );

      api.delete<{
        Params: { id: string; branch: string };
        Querystring: { expected?: string; withVersions?: string };
      }>('/documents/:id/branches/:branch', SCOPED, async (req, reply) => {
        const withVersions = req.query.withVersions;
        if (withVersions !== undefined && withVersions !== 'true' && withVersions !== 'false') {
          return reply
            .code(400)
            .send({ code: 'invalid-request', message: 'withVersions is true or false' });
        }
        const r = service.deleteBranch(
          req.params.id,
          req.params.branch,
          req.query.expected,
          principal(req),
          withVersions === 'true',
        );
        if (!r.ok) return sendReply(reply, r);
        closeGroup(groupOf(req.params.id, req.params.branch), 4404, 'branch deleted');
        return reply.code(204).send();
      });

      // Its own body limit: a review bundle may be larger than other requests, and no larger than
      // the session's largest (`maxBundleBytes`).
      api.put<{ Params: { id: string; branch: string } }>(
        '/documents/:id/branches/:branch/bundle',
        { ...SCOPED, bodyLimit: limits.maxBundleBytes },
        async (req, reply) => {
          const r = service.putBundle(req.params.id, req.params.branch, req.body, principal(req));
          if (!r.ok) return sendReply(reply, r);
          return reply.code(201).send({ stored: true });
        },
      );

      // The newest bundle's revision and size, so a client looks before it downloads one.
      api.get<{ Params: { id: string; branch: string } }>(
        '/documents/:id/branches/:branch/bundle/meta',
        SCOPED,
        async (req, reply) => {
          const r = service.bundleMeta(req.params.id, req.params.branch);
          if (!r.ok) return sendReply(reply, r);
          return { revision: r.revision, bytes: r.bytes };
        },
      );

      api.get<{ Params: { id: string; branch: string } }>(
        '/documents/:id/branches/:branch/bundle',
        SCOPED,
        async (req, reply) => {
          const r = service.getBundle(req.params.id, req.params.branch);
          if (!r.ok) return sendReply(reply, r);
          return { revision: r.revision, record: r.record };
        },
      );

      // Agent tokens (T8.4b): the owner's alone (no `agent` access).
      const agentTokens = options.agentTokens;
      if (agentTokens !== undefined) {
        api.post('/agent-tokens', { bodyLimit: TOKEN_BODY_BYTES }, async (req, reply) => {
          const parsed = IssueTokenSchema.safeParse(req.body);
          if (!parsed.success) {
            return reply.code(400).send({
              code: 'invalid-token',
              message: 'A token has a name and 1 to 100 documents',
            });
          }
          if (parsed.data.documents.some((d) => !service.hasDocument(d))) {
            return reply.code(400).send({
              code: 'no-document',
              message: 'A token is scoped to documents the server has',
            });
          }
          if (agentTokens.activeCount() >= MAX_AGENT_TOKENS) {
            return reply.code(403).send({
              code: 'too-many-tokens',
              message: `An instance has at most ${MAX_AGENT_TOKENS} active agent tokens`,
            });
          }
          const issued = agentTokens.issue(
            parsed.data.name,
            parsed.data.documents,
            new Date().toISOString(),
          );
          return reply.code(201).send({ token: issued.token, ...issued.info });
        });
        api.get('/agent-tokens', async () => ({ tokens: agentTokens.list() }));
        api.delete<{ Params: { tokenId: string } }>(
          '/agent-tokens/:tokenId',
          async (req, reply) => {
            if (!agentTokens.revoke(req.params.tokenId, new Date().toISOString())) {
              return reply.code(404).send({ code: 'not-found', message: 'No such active token' });
            }
            // Its open connections end now, its leases are let go of (the owner, or a new token,
            // takes its branches at once), the start versions it made that no branch starts from
            // go, and its next request, or one already let in, is refused (401). A socket is
            // terminated, not closed: a close handshake would leave it reading until the peer
            // answers, and a message already received is dropped once it is no longer open.
            service.revoked(req.params.tokenId);
            for (const set of sockets.values()) {
              for (const c of set) {
                if (c.principal.kind === 'agent' && c.principal.tokenId === req.params.tokenId) {
                  c.socket.terminate();
                }
              }
            }
            return reply.code(204).send();
          },
        );
      }

      api.put<{ Params: { sha256: string } }>(
        '/blobs/:sha256',
        { config: { agent: 'blob-put' } satisfies RouteAccess },
        async (req, reply) => {
          if (!Buffer.isBuffer(req.body)) {
            return reply
              .code(415)
              .send({ code: 'unsupported-media-type', message: 'Send application/octet-stream' });
          }
          const r = service.putBlob(req.params.sha256, req.body, principal(req));
          if (!r.ok) return sendReply(reply, r);
          return reply.code(r.status).send({ sha256: req.params.sha256, size: req.body.length });
        },
      );

      api.get<{ Params: { sha256: string } }>('/blobs/:sha256', async (req, reply) => {
        const bytes = service.getBlob(req.params.sha256);
        if (bytes === undefined)
          return reply.code(404).send({ code: 'not-found', message: 'No such blob' });
        return reply
          .type('application/octet-stream')
          .header('cache-control', 'private, max-age=31536000, immutable')
          .send(bytes);
      });

      api.get<{ Params: { id: string } }>(
        '/documents/:id/socket',
        { websocket: true, ...SCOPED },
        (socket, req) => {
          const documentId = req.params.id;
          const branch = branchOf(req.query);
          if (connections >= limits.maxConnections) {
            socket.close(1013, 'too many connections');
            return;
          }
          if (branch === null || !service.hasBranch(documentId, branch)) {
            socket.close(4404, 'no such document');
            return;
          }
          const group = groupOf(documentId, branch);
          const key = protocolsOf(req)
            .find((p) => p.startsWith('client.'))
            ?.slice(7);
          const c: Connection = { socket, documentId, branch, principal: principal(req) };
          const rate = new TokenBucket(limits.messagesPerMinute);
          connections += 1;
          let set = sockets.get(group);
          if (set === undefined) sockets.set(group, (set = new Set()));
          set.add(c);
          const helloTimer = setTimeout(() => {
            if (c.clientId === undefined) socket.close(4408, 'no hello');
          }, limits.helloTimeoutMs);
          socket.on('close', () => {
            clearTimeout(helloTimer);
            connections -= 1;
            set.delete(c);
            if (set.size === 0) sockets.delete(group);
          });
          const send = (m: ServerMessage) => deliver(c, m);
          const sendError = (e: ReplyError) => {
            if (e.messages !== undefined) for (const m of e.messages) send(m);
            else
              send({ type: 'error', code: 'invalid-message', message: `${e.code}: ${e.message}` });
          };
          socket.on('message', (data, isBinary) => {
            // Nothing is read from a socket that is closing or gone (a revoked token's, say).
            if (socket.readyState !== socket.OPEN) return;
            if (service.revokedCheck(c.principal) !== undefined) {
              socket.terminate();
              return;
            }
            if (isBinary || !rate.take(1).ok) {
              socket.close(1008, isBinary ? 'text messages only' : 'too many messages');
              return;
            }
            let message: unknown;
            try {
              message = JSON.parse(data.toString());
            } catch {
              send({ type: 'error', code: 'invalid-message', message: 'Not valid JSON' });
              return;
            }
            const shape = checkJsonShape(message, limits.maxJsonDepth, limits.maxJsonNodes);
            if (!shape.ok) {
              send({
                type: 'error',
                code: 'invalid-message',
                message: shape.forbiddenKey
                  ? 'The message holds a forbidden key'
                  : `The message is ${shape.message}`,
              });
              return;
            }
            const type = (message as { type?: unknown } | null)?.type;
            if (c.clientId === undefined) {
              if (type !== 'hello') {
                send({ type: 'error', code: 'invalid-message', message: 'Send a hello first' });
                return;
              }
              const r = service.hello(documentId, message, key, branch, c.principal);
              if (!r.ok) {
                sendError(r);
                socket.close(r.status === 400 ? 1008 : 4403, r.code);
                return;
              }
              c.clientId = (message as { clientId: string }).clientId;
              clearTimeout(helloTimer);
              for (const m of r.messages) send(m);
              return;
            }
            let r: Reply;
            if (type === 'submit') {
              r = service.submit(
                documentId,
                message,
                { boundClientId: c.clientId },
                branch,
                c.principal,
              );
            } else if (type === 'pull') {
              const since = (message as { since?: unknown }).since;
              r =
                typeof since === 'number' && Number.isSafeInteger(since) && since >= 0
                  ? service.pull(documentId, since, branch)
                  : {
                      ok: false,
                      status: 400,
                      code: 'invalid-message',
                      message: 'since must be a revision',
                    };
            } else {
              r = {
                ok: false,
                status: 400,
                code: 'invalid-message',
                message: 'Unexpected message type',
              };
            }
            if (!r.ok) {
              sendError(r);
              return;
            }
            for (const m of r.messages) send(m);
            if (r.push) broadcast(group, r.push);
          });
        },
      );
    },
    { prefix: API_PREFIX },
  );

  return app;
}
