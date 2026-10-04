import { MAX_IMPORT_BYTES } from '@manufakture/core';

/**
 * Every limit the server enforces, with its default. Each is configurable (see `config.ts` and the
 * README); the defaults suit one user with a few devices. Validation runs core on the event loop,
 * so the size, depth and node limits are what bound one request's cost (a huge `batch` would
 * otherwise stall every other request).
 */
export interface Limits {
  /** The largest request body, in bytes (JSON requests; blobs have `maxBlobBytes`). */
  readonly maxBodyBytes: number;
  /** The largest WebSocket message, in bytes. */
  readonly maxMessageBytes: number;
  /**
   * The largest single entry, as JSON, in bytes. Every accepted entry is pushed to every client
   * and may come back alone in a pull, so it must fit the app's `MAX_INBOUND_BYTES`
   * (`apps/web/src/sync/transport.ts`, 16 MiB) with room for the push wrapper: an entry the app
   * cannot receive would close its socket on every reconnect. 12 MiB leaves 4 MiB; it also means
   * an import over about 9 MiB (base64 inside the entry) is refused rather than synced.
   */
  readonly maxEntryBytes: number;
  /** How deeply a JSON body or message may nest. Real commands nest about 15 levels. */
  readonly maxJsonDepth: number;
  /** How many JSON values (objects, arrays, strings, numbers, ...) one body or message may hold. */
  readonly maxJsonNodes: number;
  /**
   * The most ids the entries of one submit may list in `created`. Core's own cap per entry
   * (`MAX_CREATED_IDS`) is far higher; this one bounds a whole message.
   */
  readonly maxCreatedIdsPerSubmit: number;
  /** The largest blob, in bytes: core's `MAX_IMPORT_BYTES`. */
  readonly maxBlobBytes: number;
  /** All blobs together, in bytes. */
  readonly maxBlobTotalBytes: number;
  /** The most documents the instance holds. */
  readonly maxDocuments: number;
  /** The most clients (`clientId`s) one document may have. */
  readonly maxClientsPerDocument: number;
  /**
   * The most de-duplication rows one client may hold. A correct client holds rows from its
   * retention floor up, so this bounds how many entries it can keep in flight.
   */
  readonly maxRowsPerClient: number;
  /** Entries per minute per client (a token bucket, refilled continuously). */
  readonly entriesPerMinute: number;
  /** WebSocket messages per minute per connection. */
  readonly messagesPerMinute: number;
  /**
   * Milliseconds of validation per submit. Once spent, the remaining entries of the submit are
   * left unjudged and unanswered (the client resends entries that got no answer).
   */
  readonly validationBudgetMs: number;
  /** Open WebSocket connections across the instance. */
  readonly maxConnections: number;
  /** Bytes queued on a WebSocket before a slow reader is disconnected (it pulls on reconnect). */
  readonly maxSocketBufferBytes: number;
  /** Milliseconds a new WebSocket has to send its `hello`. */
  readonly helloTimeoutMs: number;
  /** The most named versions one document may hold on the server (every branch's together). */
  readonly maxVersionsPerDocument: number;
  /** The most branches one document may have on the server besides main. */
  readonly maxBranchesPerDocument: number;
  /**
   * The most bytes of entries (as stored JSON) one pull answers with. At least one entry is always
   * sent, so a pull makes progress whatever this is; the client pulls again for the rest. The
   * answer adds a wrapper (`{"type":"push","entries":[...]}` and `{"rev":n,"entry":...}` per
   * entry, under 40 bytes each, at most `MAX_ENTRIES_PER_MESSAGE` of them), so this must stay
   * well under the app's `MAX_INBOUND_BYTES` (16 MiB): 8 MiB leaves half of it as headroom.
   * `test/hardening.test.ts` checks both against the app's constant.
   */
  readonly maxPullBytes: number;
  /**
   * Milliseconds a client has to send a whole HTTP request, body included (Fastify's
   * `requestTimeout`). Bounds a slow sender holding a connection and a body buffer.
   */
  readonly requestTimeoutMs: number;
  /** Milliseconds a connection may sit idle before it is closed (Fastify's `connectionTimeout`). */
  readonly connectionTimeoutMs: number;
  /**
   * Milliseconds an idle keep-alive connection stays open between requests. Keep it above the
   * reverse proxy's own idle timeout, so the server never closes a connection the proxy reuses.
   */
  readonly keepAliveTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 40 * 1024 * 1024,
  maxMessageBytes: 40 * 1024 * 1024,
  maxEntryBytes: 12 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 1_000_000,
  maxCreatedIdsPerSubmit: 100_000,
  maxBlobBytes: MAX_IMPORT_BYTES,
  maxBlobTotalBytes: 10 * 1024 * 1024 * 1024,
  maxDocuments: 10_000,
  maxClientsPerDocument: 256,
  maxRowsPerClient: 20_000,
  entriesPerMinute: 20_000,
  messagesPerMinute: 1_200,
  validationBudgetMs: 2_000,
  maxConnections: 256,
  maxSocketBufferBytes: 64 * 1024 * 1024,
  helloTimeoutMs: 10_000,
  maxVersionsPerDocument: 2_000,
  maxBranchesPerDocument: 100,
  maxPullBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 120_000,
  connectionTimeoutMs: 300_000,
  keepAliveTimeoutMs: 72_000,
};

/**
 * Object keys a message may not hold. JSON.parse keeps `__proto__` as an own key, and copying it
 * into another object (a zod record does) sets that object's prototype instead; `constructor`
 * holding a `prototype` is the other classic. Same rule as Fastify's body parser
 * (secure-json-parse), so HTTP bodies and WebSocket messages are refused alike. A bare
 * `constructor` or `prototype` key is plain data (a parameter may be called that) and is allowed.
 */
function poisoned(key: string, value: unknown): boolean {
  if (key === '__proto__') return true;
  return (
    key === 'constructor' &&
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, 'prototype')
  );
}

/**
 * Whether a parsed JSON value stays within `maxDepth` levels and `maxNodes` values and holds no
 * prototype-poisoning key (`poisoned`). Iterative, so hostile nesting cannot overflow the stack;
 * it stops at the first excess.
 */
export function checkJsonShape(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
): { ok: true } | { ok: false; forbiddenKey: boolean; message: string } {
  const stack: [unknown, number][] = [[value, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (++nodes > maxNodes) {
      return { ok: false, forbiddenKey: false, message: `more than ${maxNodes} JSON values` };
    }
    if (depth > maxDepth) {
      return { ok: false, forbiddenKey: false, message: `nested deeper than ${maxDepth} levels` };
    }
    if (typeof v !== 'object' || v === null) continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push([x, depth + 1]);
    } else {
      for (const k in v) {
        if (!Object.hasOwn(v, k)) continue;
        const child = (v as Record<string, unknown>)[k];
        if (poisoned(k, child)) return { ok: false, forbiddenKey: true, message: 'forbidden key' };
        stack.push([child, depth + 1]);
      }
    }
  }
  return { ok: true };
}

/** A token bucket: `capacity` tokens, refilled at `capacity` per minute. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Takes `n` tokens if there are enough; otherwise takes none and says how long to wait (ms). */
  take(n: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.capacity) / 60_000);
    this.last = t;
    if (n <= this.tokens) {
      this.tokens -= n;
      return { ok: true };
    }
    const missing = Math.min(n, this.capacity) - this.tokens;
    return { ok: false, retryAfterMs: Math.ceil((missing * 60_000) / this.capacity) };
  }
}
