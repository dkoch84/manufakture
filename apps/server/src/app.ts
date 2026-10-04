import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import type { PushMessage, ServerMessage } from '@manufakture/sync';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { WebSocket } from 'ws';
import { TokenBucket, checkJsonShape, type Limits } from './limits';
import { SyncService, type Reply, type ReplyError } from './service';
import type { SyncStore } from './store';

/**
 * The HTTP and WebSocket transport (ADR 0009 decision 11), everything under `/api`:
 *
 * - `GET /api/health` (no token): `{ ok: true }`.
 * - `POST /api/documents`, `GET /api/documents`, `GET /api/documents/:id/snapshot`.
 * - `POST /api/documents/:id/hello`, `POST /api/documents/:id/entries` (submit),
 *   `GET /api/documents/:id/entries?since=` (pull): protocol messages in `{ messages }`.
 * - `PUT` and `GET /api/blobs/:sha256`.
 * - `GET /api/documents/:id/socket`: a WebSocket carrying the same protocol messages, and pushes.
 *
 * Every route but `health` needs the instance's bearer token: `Authorization: Bearer <token>`,
 * or for a WebSocket (browsers cannot set its headers) the subprotocol `bearer.<token>` next to
 * `manufakture-sync`. No cookies; CORS only for the configured origins.
 */

export const API_PREFIX = '/api';
/** The WebSocket subprotocol the server speaks. */
export const SUBPROTOCOL = 'manufakture-sync';
/** The HTTP header that carries the client key on submits and hellos. */
export const CLIENT_KEY_HEADER = 'manufakture-client-key';

export interface AppOptions {
  /** The instance's bearer token. */
  readonly token: string;
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
}

interface Connection {
  readonly socket: WebSocket;
  readonly documentId: string;
  clientId?: string;
}

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
  });

  const authorized = (req: FastifyRequest): boolean => {
    let token: string | undefined;
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.startsWith('Bearer ')) token = h.slice(7).trim();
    if (token === undefined && req.headers.upgrade?.toLowerCase() === 'websocket') {
      token = protocolsOf(req)
        .find((p) => p.startsWith('bearer.'))
        ?.slice(7);
    }
    if (token === undefined || token.length === 0 || token.length > 1024) return false;
    return timingSafeEqual(digest(token), tokenHash);
  };

  const sendReply = (reply: FastifyReply, r: Reply, documentId?: string) => {
    if (!r.ok) {
      if (r.retryAfterMs !== undefined) {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      }
      return reply.code(r.status).send(errorBody(r));
    }
    if (r.push && documentId !== undefined) broadcast(documentId, r.push);
    const body: { messages: ServerMessage[]; code?: string } = { messages: r.messages };
    if (r.status === 409) body.code = 'predecessor-unknown';
    return reply.code(r.status).send(body);
  };

  const broadcast = (documentId: string, push: PushMessage) => {
    const set = sockets.get(documentId);
    if (set === undefined) return;
    const text = JSON.stringify(push);
    for (const c of set) if (c.clientId !== undefined) sendText(c, text);
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

  await app.register(fastifyCors, {
    origin: (origin, cb) => cb(null, origin !== undefined && origins.has(origin)),
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT'],
    allowedHeaders: ['Authorization', 'Content-Type', CLIENT_KEY_HEADER],
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
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
    const code =
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? 'too-large'
        : error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
          ? 'unsupported-media-type'
          : 'invalid-request';
    return reply.code(status).send({ code, message: error.message.slice(0, 500) });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ code: 'not-found', message: 'Not found' }),
  );

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req, reply) => {
        if (req.method === 'OPTIONS') return;
        if (req.routeOptions.url === `${API_PREFIX}/health`) return;
        if (!authorized(req)) {
          return reply.code(401).header('www-authenticate', 'Bearer').send({
            code: 'unauthorized',
            message: 'A valid bearer token is required',
          });
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
        if (!shape.ok) {
          return reply
            .code(413)
            .send({ code: 'too-complex', message: `The body is ${shape.message}` });
        }
      });

      api.get('/health', async () => ({ ok: true }));

      api.post('/documents', async (req, reply) => {
        const r = service.createDocument(req.body);
        if (r.ok && 'id' in r) return reply.code(201).send({ id: r.id, head: r.head });
        return sendReply(reply, r as Reply);
      });

      api.get('/documents', async () => ({ documents: service.listDocuments() }));

      api.get<{ Params: { id: string } }>('/documents/:id/snapshot', async (req, reply) => {
        const s = service.snapshot(req.params.id);
        if (s === undefined)
          return reply.code(404).send({ code: 'not-found', message: 'No such document' });
        return s;
      });

      api.post<{ Params: { id: string } }>('/documents/:id/hello', async (req, reply) => {
        const key = req.headers[CLIENT_KEY_HEADER];
        const r = service.hello(req.params.id, req.body, typeof key === 'string' ? key : undefined);
        return sendReply(reply, r);
      });

      api.post<{ Params: { id: string } }>('/documents/:id/entries', async (req, reply) => {
        const key = req.headers[CLIENT_KEY_HEADER];
        const r = service.submit(req.params.id, req.body, {
          key: typeof key === 'string' ? key : undefined,
        });
        return sendReply(reply, r, req.params.id);
      });

      api.get<{ Params: { id: string }; Querystring: { since?: string } }>(
        '/documents/:id/entries',
        async (req, reply) => {
          const since = Number(req.query.since ?? '0');
          if (!/^\d{1,16}$/.test(req.query.since ?? '0') || !Number.isSafeInteger(since)) {
            return reply
              .code(400)
              .send({ code: 'invalid-request', message: 'since must be a revision' });
          }
          return sendReply(reply, service.pull(req.params.id, since));
        },
      );

      api.put<{ Params: { sha256: string } }>('/blobs/:sha256', async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) {
          return reply
            .code(415)
            .send({ code: 'unsupported-media-type', message: 'Send application/octet-stream' });
        }
        const r = service.putBlob(req.params.sha256, req.body);
        if (!r.ok) return sendReply(reply, r);
        return reply.code(r.status).send({ sha256: req.params.sha256, size: req.body.length });
      });

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
        { websocket: true },
        (socket, req) => {
          const documentId = req.params.id;
          if (connections >= limits.maxConnections) {
            socket.close(1013, 'too many connections');
            return;
          }
          if (!service.hasDocument(documentId)) {
            socket.close(4404, 'no such document');
            return;
          }
          const key = protocolsOf(req)
            .find((p) => p.startsWith('client.'))
            ?.slice(7);
          const c: Connection = { socket, documentId };
          const rate = new TokenBucket(limits.messagesPerMinute);
          connections += 1;
          let set = sockets.get(documentId);
          if (set === undefined) sockets.set(documentId, (set = new Set()));
          set.add(c);
          const helloTimer = setTimeout(() => {
            if (c.clientId === undefined) socket.close(4408, 'no hello');
          }, limits.helloTimeoutMs);
          socket.on('close', () => {
            clearTimeout(helloTimer);
            connections -= 1;
            set.delete(c);
            if (set.size === 0) sockets.delete(documentId);
          });
          const send = (m: ServerMessage) => sendText(c, JSON.stringify(m));
          const sendError = (e: ReplyError) => {
            if (e.messages !== undefined) for (const m of e.messages) send(m);
            else
              send({ type: 'error', code: 'invalid-message', message: `${e.code}: ${e.message}` });
          };
          socket.on('message', (data, isBinary) => {
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
                message: `The message is ${shape.message}`,
              });
              return;
            }
            const type = (message as { type?: unknown } | null)?.type;
            if (c.clientId === undefined) {
              if (type !== 'hello') {
                send({ type: 'error', code: 'invalid-message', message: 'Send a hello first' });
                return;
              }
              const r = service.hello(documentId, message, key);
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
              r = service.submit(documentId, message, { boundClientId: c.clientId });
            } else if (type === 'pull') {
              const since = (message as { since?: unknown }).since;
              r =
                typeof since === 'number' && Number.isSafeInteger(since) && since >= 0
                  ? service.pull(documentId, since)
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
                message: `Unexpected ${String(type)}`,
              };
            }
            if (!r.ok) {
              sendError(r);
              return;
            }
            for (const m of r.messages) send(m);
            if (r.push) broadcast(documentId, r.push);
          });
        },
      );
    },
    { prefix: API_PREFIX },
  );

  return app;
}
