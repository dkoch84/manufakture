import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AGENT_TOKEN } from '@manufakture/sync';
import { z } from 'zod';

/**
 * Agent tokens (ADR 0016 decision 12, T8.4b): a second kind of bearer token beside the instance's
 * own (product decision 0001), issued and revoked by the owner, scoped to documents. What an agent
 * token may do is decided in `service.ts` (`SyncService.authorize`) and on every route in
 * `app.ts`; this file only keeps them.
 *
 * A token is `agent.<id>.<secret>`: the id names the record, the secret is 256 random bits. Only
 * the secret's SHA-256 is stored (a secret this long needs no slow hash), compared in constant
 * time; the token itself is shown once, when it is issued. Revoking keeps the record (branches
 * name the token that made them) and refuses the token from then on.
 */

/** Who a request speaks for. */
export type Principal =
  | { readonly kind: 'owner' }
  | {
      readonly kind: 'agent';
      readonly tokenId: string;
      readonly documents: ReadonlySet<string>;
    };

export const OWNER: Principal = { kind: 'owner' };

/** Active agent tokens one instance keeps at most. */
export const MAX_AGENT_TOKENS = 100;
/** Documents one agent token is scoped to, at most. */
export const MAX_TOKEN_DOCUMENTS = 100;
/** The longest token name. */
export const MAX_TOKEN_NAME = 200;

const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{22}$/;

export const IssueTokenSchema = z.strictObject({
  /** What the owner calls it ("Claude Code on the laptop"): shown in the list, never trusted. */
  name: z
    .string()
    .min(1)
    .max(MAX_TOKEN_NAME)
    .refine((s) => s.trim() === s && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(s), {
      message: 'a token name is plain text, not padded',
    }),
  /** The documents it may read, and make and write agent branches of. */
  documents: z.array(z.string().regex(DOCUMENT_ID)).min(1).max(MAX_TOKEN_DOCUMENTS),
});

/** An agent token as the owner lists it (never its secret). */
export interface AgentTokenInfo {
  id: string;
  name: string;
  documents: string[];
  createdAt: string;
  revokedAt: string | null;
}

interface Row {
  id: string;
  secret_hash: Buffer;
  name: string;
  documents: string;
  created_at: string;
  revoked_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL,
  name TEXT NOT NULL,
  documents TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
`;

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

function info(r: Row): AgentTokenInfo {
  return {
    id: r.id,
    name: r.name,
    documents: JSON.parse(r.documents) as string[],
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

export class AgentTokenStore {
  readonly #stmt;

  constructor(db: Database.Database) {
    db.exec(SCHEMA);
    this.#stmt = {
      get: db.prepare('SELECT * FROM agent_tokens WHERE id = ?'),
      list: db.prepare('SELECT * FROM agent_tokens ORDER BY created_at, id'),
      active: db.prepare('SELECT count(*) FROM agent_tokens WHERE revoked_at IS NULL').pluck(),
      insert: db.prepare(
        `INSERT INTO agent_tokens (id, secret_hash, name, documents, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      revoke: db.prepare(
        'UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      ),
    };
  }

  /** Active tokens. */
  activeCount(): number {
    return this.#stmt.active.get() as number;
  }

  /** A new token: the record, and the token itself (shown once, kept nowhere). */
  issue(
    name: string,
    documents: readonly string[],
    now: string,
  ): { token: string; info: AgentTokenInfo } {
    const id = randomBytes(16).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const unique = [...new Set(documents)];
    this.#stmt.insert.run(id, sha256(secret), name, JSON.stringify(unique), now);
    return {
      token: `agent.${id}.${secret}`,
      info: { id, name, documents: unique, createdAt: now, revokedAt: null },
    };
  }

  list(): AgentTokenInfo[] {
    return (this.#stmt.list.all() as Row[]).map(info);
  }

  /** Revokes `id`: false when there is no such active token. */
  revoke(id: string, now: string): boolean {
    if (!TOKEN_ID.test(id)) return false;
    return this.#stmt.revoke.run(now, id).changes === 1;
  }

  /**
   * The principal of an agent token, or null when it is not one, is unknown or revoked, or its
   * secret does not match (compared in constant time).
   */
  verify(token: string): Principal | null {
    const m = AGENT_TOKEN.exec(token);
    if (m === null) return null;
    const row = this.#stmt.get.get(m[1]) as Row | undefined;
    // A hash is compared even for an unknown id, so the answer takes as long either way.
    const stored = row?.secret_hash ?? Buffer.alloc(32);
    const match = timingSafeEqual(sha256(m[2]!), stored);
    if (row === undefined || !match || row.revoked_at !== null) return null;
    return { kind: 'agent', tokenId: row.id, documents: new Set(info(row).documents) };
  }
}
