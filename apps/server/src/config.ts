import { readFileSync } from 'node:fs';
import { MAX_ENTRIES_PER_MESSAGE } from '@manufakture/sync';
import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from './limits';

/** The server's configuration, from environment variables (README, "Configuration"). */
export interface Config {
  readonly token: string;
  readonly databasePath: string;
  readonly host: string;
  readonly port: number;
  readonly origins: readonly string[];
  readonly trustProxy: boolean;
  readonly logLevel: string;
  readonly limits: Limits;
}

/**
 * A bearer token: at least 32 characters of letters, digits and `._~-`, so it fits in a WebSocket
 * subprotocol (`bearer.<token>`) unchanged. `openssl rand -base64 48 | tr '+/' '-_' | tr -d =`
 * makes one.
 */
export const TOKEN = /^[A-Za-z0-9._~-]{32,512}$/;

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

const LIMIT_VARS: Record<keyof Limits, string> = {
  maxBodyBytes: 'MANUFAKTURE_MAX_BODY_BYTES',
  maxMessageBytes: 'MANUFAKTURE_MAX_MESSAGE_BYTES',
  maxEntryBytes: 'MANUFAKTURE_MAX_ENTRY_BYTES',
  maxJsonDepth: 'MANUFAKTURE_MAX_JSON_DEPTH',
  maxJsonNodes: 'MANUFAKTURE_MAX_JSON_NODES',
  maxCreatedIdsPerSubmit: 'MANUFAKTURE_MAX_CREATED_IDS_PER_SUBMIT',
  maxBlobBytes: 'MANUFAKTURE_MAX_BLOB_BYTES',
  maxBlobTotalBytes: 'MANUFAKTURE_MAX_BLOB_TOTAL_BYTES',
  maxDocuments: 'MANUFAKTURE_MAX_DOCUMENTS',
  maxClientsPerDocument: 'MANUFAKTURE_MAX_CLIENTS_PER_DOCUMENT',
  maxRowsPerClient: 'MANUFAKTURE_MAX_ROWS_PER_CLIENT',
  entriesPerMinute: 'MANUFAKTURE_ENTRIES_PER_MINUTE',
  messagesPerMinute: 'MANUFAKTURE_MESSAGES_PER_MINUTE',
  validationBudgetMs: 'MANUFAKTURE_VALIDATION_BUDGET_MS',
  maxConnections: 'MANUFAKTURE_MAX_CONNECTIONS',
  maxSocketBufferBytes: 'MANUFAKTURE_MAX_SOCKET_BUFFER_BYTES',
  helloTimeoutMs: 'MANUFAKTURE_HELLO_TIMEOUT_MS',
};

const positive = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Reads the configuration; throws with a message naming the variable on any bad value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fromFile = env.MANUFAKTURE_TOKEN_FILE;
  const token = (fromFile ? readFileSync(fromFile, 'utf8') : (env.MANUFAKTURE_TOKEN ?? '')).trim();
  if (!TOKEN.test(token)) {
    throw new Error(
      'MANUFAKTURE_TOKEN (or MANUFAKTURE_TOKEN_FILE) must hold at least 32 characters of A-Z, a-z, 0-9 and ._~-',
    );
  }
  const origins = (env.MANUFAKTURE_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  for (const o of origins) {
    if (!ORIGIN.test(o))
      throw new Error(`MANUFAKTURE_ORIGINS: "${o}" is not an origin (scheme://host[:port])`);
  }
  const port = positive.max(65535).safeParse(env.MANUFAKTURE_PORT ?? '8787');
  if (!port.success) throw new Error('MANUFAKTURE_PORT must be a port number');
  const limits: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const [name, variable] of Object.entries(LIMIT_VARS)) {
    const raw = env[variable];
    if (raw === undefined || raw === '') continue;
    const v = positive.safeParse(raw);
    if (!v.success) throw new Error(`${variable} must be a positive integer`);
    limits[name] = v.data;
  }
  if (limits.entriesPerMinute! < MAX_ENTRIES_PER_MESSAGE) {
    throw new Error(
      `MANUFAKTURE_ENTRIES_PER_MINUTE must be at least ${MAX_ENTRIES_PER_MESSAGE} (one full submit)`,
    );
  }
  return {
    token,
    databasePath: env.MANUFAKTURE_DB ?? 'manufakture.db',
    host: env.MANUFAKTURE_HOST ?? '127.0.0.1',
    port: port.data,
    origins,
    trustProxy: env.MANUFAKTURE_TRUST_PROXY === '1' || env.MANUFAKTURE_TRUST_PROXY === 'true',
    logLevel: env.MANUFAKTURE_LOG_LEVEL ?? 'info',
    limits: limits as unknown as Limits,
  };
}
