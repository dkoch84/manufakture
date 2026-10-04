import Database from 'better-sqlite3';
import type { CounterTable, ManufaktureDocument } from '@manufakture/core';
import type { Outcome, PushedEntry } from '@manufakture/sync';
import type { ClientRecord, DocumentInfo, LoadedBranch, SubmitWrite, SyncStore } from './store';
import { MAIN_BRANCH } from './store';

/** The schema version this code writes; `meta.schema`. A newer database is refused. */
export const STORE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS branches (
  document_id TEXT NOT NULL REFERENCES documents(id),
  branch TEXT NOT NULL,
  head INTEGER NOT NULL,
  high_water TEXT NOT NULL,
  PRIMARY KEY (document_id, branch)
) STRICT;
CREATE TABLE IF NOT EXISTS entries (
  document_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  rev INTEGER NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (document_id, branch, rev),
  FOREIGN KEY (document_id, branch) REFERENCES branches(document_id, branch)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots (
  document_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  rev INTEGER NOT NULL,
  document TEXT NOT NULL,
  high_water TEXT NOT NULL,
  PRIMARY KEY (document_id, branch, rev),
  FOREIGN KEY (document_id, branch) REFERENCES branches(document_id, branch)
) STRICT;
CREATE TABLE IF NOT EXISTS clients (
  document_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  client_id TEXT NOT NULL,
  key_hash BLOB NOT NULL,
  floor INTEGER NOT NULL,
  latest_accepted INTEGER,
  PRIMARY KEY (document_id, branch, client_id),
  FOREIGN KEY (document_id, branch) REFERENCES branches(document_id, branch)
) STRICT;
CREATE TABLE IF NOT EXISTS outcomes (
  document_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  rev INTEGER,
  error TEXT,
  PRIMARY KEY (document_id, branch, client_id, client_seq),
  FOREIGN KEY (document_id, branch, client_id) REFERENCES clients(document_id, branch, client_id),
  CHECK ((rev IS NULL) <> (error IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`;

export interface SqliteStoreOptions {
  /**
   * Test-only: called inside `commitSubmit`'s transaction after the entries and outcomes are
   * written and before the head moves, so a test can kill the process mid-transaction.
   */
  readonly duringCommit?: () => void;
}

interface OutcomeRow {
  rev: number | null;
  error: string | null;
}

interface ClientRow {
  client_id: string;
  key_hash: Buffer;
  floor: number;
  latest_accepted: number | null;
}

/**
 * `SyncStore` on SQLite through better-sqlite3: one database file, write-ahead logging, and
 * `synchronous = FULL`, so an answered submit survives a crash or power loss. Back it up with
 * SQLite's online backup (README).
 */
export class SqliteStore implements SyncStore {
  private readonly db: Database.Database;
  private readonly options: SqliteStoreOptions;
  private readonly stmt;
  private readonly commitTx: Database.Transaction<(write: SubmitWrite) => void>;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.options = options;
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.checkSchemaVersion();
    const db = this.db;
    this.stmt = {
      insertDocument: db.prepare('INSERT INTO documents (id, name, created_at) VALUES (?, ?, ?)'),
      insertBranch: db.prepare(
        'INSERT INTO branches (document_id, branch, head, high_water) VALUES (?, ?, 0, ?)',
      ),
      insertSnapshot: db.prepare(
        'INSERT INTO snapshots (document_id, branch, rev, document, high_water) VALUES (?, ?, ?, ?, ?)',
      ),
      hasDocument: db.prepare('SELECT 1 FROM documents WHERE id = ?').pluck(),
      listDocuments: db.prepare(
        `SELECT d.id, d.name, d.created_at AS createdAt, b.head
         FROM documents d JOIN branches b ON b.document_id = d.id AND b.branch = '${MAIN_BRANCH}'
         ORDER BY d.created_at, d.id`,
      ),
      documentCount: db.prepare('SELECT count(*) FROM documents').pluck(),
      branch: db.prepare(
        'SELECT head, high_water FROM branches WHERE document_id = ? AND branch = ?',
      ),
      latestSnapshot: db.prepare(
        `SELECT rev, document, high_water FROM snapshots
         WHERE document_id = ? AND branch = ? AND rev <= ? ORDER BY rev DESC LIMIT 1`,
      ),
      entries: db.prepare(
        `SELECT rev, entry FROM entries WHERE document_id = ? AND branch = ? AND rev > ? AND rev <= ?
         ORDER BY rev LIMIT ?`,
      ),
      insertEntry: db.prepare(
        'INSERT INTO entries (document_id, branch, rev, entry) VALUES (?, ?, ?, ?)',
      ),
      client: db.prepare(
        `SELECT client_id, key_hash, floor, latest_accepted FROM clients
         WHERE document_id = ? AND branch = ? AND client_id = ?`,
      ),
      clientCount: db
        .prepare('SELECT count(*) FROM clients WHERE document_id = ? AND branch = ?')
        .pluck(),
      insertClient: db.prepare(
        `INSERT INTO clients (document_id, branch, client_id, key_hash, floor, latest_accepted)
         VALUES (?, ?, ?, ?, 1, NULL)`,
      ),
      updateClient: db.prepare(
        `UPDATE clients SET floor = ?, latest_accepted = ?
         WHERE document_id = ? AND branch = ? AND client_id = ?`,
      ),
      outcome: db.prepare(
        `SELECT rev, error FROM outcomes
         WHERE document_id = ? AND branch = ? AND client_id = ? AND client_seq = ?`,
      ),
      insertOutcome: db.prepare(
        `INSERT INTO outcomes (document_id, branch, client_id, client_seq, rev, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      rowCount: db
        .prepare(
          `SELECT count(*) FROM outcomes
           WHERE document_id = ? AND branch = ? AND client_id = ? AND client_seq >= ?`,
        )
        .pluck(),
      prune: db.prepare(
        `DELETE FROM outcomes WHERE document_id = ? AND branch = ? AND client_id = ?
         AND client_seq < ? AND client_seq IS NOT ?`,
      ),
      updateHead: db.prepare(
        'UPDATE branches SET head = ?, high_water = ? WHERE document_id = ? AND branch = ? AND head = ?',
      ),
      putBlob: db.prepare(
        'INSERT OR IGNORE INTO blobs (sha256, size, data, created_at) VALUES (?, ?, ?, ?)',
      ),
      getBlob: db.prepare('SELECT data FROM blobs WHERE sha256 = ?').pluck(),
      hasBlob: db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').pluck(),
      blobBytes: db.prepare('SELECT coalesce(sum(size), 0) FROM blobs').pluck(),
    };
    this.commitTx = this.db.transaction((write: SubmitWrite) => this.writeSubmit(write));
  }

  private checkSchemaVersion(): void {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").pluck().get() as
      string | undefined;
    if (row === undefined) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)")
        .run(String(STORE_SCHEMA_VERSION));
      return;
    }
    if (Number(row) > STORE_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `The database was written by a newer server (schema ${row}, this one knows ${STORE_SCHEMA_VERSION}): upgrade the server.`,
      );
    }
  }

  createDocument(
    info: { id: string; name: string; createdAt: string },
    document: ManufaktureDocument,
    highWater: CounterTable,
  ): boolean {
    return this.db
      .transaction(() => {
        if (this.stmt.hasDocument.get(info.id) !== undefined) return false;
        const hw = JSON.stringify(highWater);
        this.stmt.insertDocument.run(info.id, info.name, info.createdAt);
        this.stmt.insertBranch.run(info.id, MAIN_BRANCH, hw);
        this.stmt.insertSnapshot.run(info.id, MAIN_BRANCH, 0, JSON.stringify(document), hw);
        return true;
      })
      .immediate();
  }

  listDocuments(): DocumentInfo[] {
    return this.stmt.listDocuments.all() as DocumentInfo[];
  }

  documentCount(): number {
    return this.stmt.documentCount.get() as number;
  }

  hasDocument(id: string): boolean {
    return this.stmt.hasDocument.get(id) !== undefined;
  }

  loadBranch(documentId: string, branch: string): LoadedBranch | undefined {
    return this.db.transaction(() => {
      const b = this.stmt.branch.get(documentId, branch) as
        { head: number; high_water: string } | undefined;
      if (b === undefined) return undefined;
      const s = this.stmt.latestSnapshot.get(documentId, branch, b.head) as
        { rev: number; document: string; high_water: string } | undefined;
      if (s === undefined) throw new Error(`Branch ${documentId}/${branch} has no snapshot`);
      const after = this.readEntries(documentId, branch, s.rev, b.head, b.head - s.rev);
      return {
        head: b.head,
        highWater: JSON.parse(b.high_water) as CounterTable,
        snapshot: {
          rev: s.rev,
          document: JSON.parse(s.document) as ManufaktureDocument,
          highWater: JSON.parse(s.high_water) as CounterTable,
        },
        after,
      };
    })();
  }

  entries(documentId: string, branch: string, since: number, limit: number): PushedEntry[] {
    const b = this.stmt.branch.get(documentId, branch) as { head: number } | undefined;
    if (b === undefined) return [];
    return this.readEntries(documentId, branch, since, b.head, limit);
  }

  private readEntries(
    documentId: string,
    branch: string,
    since: number,
    head: number,
    limit: number,
  ): PushedEntry[] {
    const rows = this.stmt.entries.all(documentId, branch, since, head, limit) as {
      rev: number;
      entry: string;
    }[];
    return rows.map((r) => ({ rev: r.rev, entry: JSON.parse(r.entry) as PushedEntry['entry'] }));
  }

  client(documentId: string, branch: string, clientId: string): ClientRecord | undefined {
    const r = this.stmt.client.get(documentId, branch, clientId) as ClientRow | undefined;
    if (r === undefined) return undefined;
    return {
      clientId: r.client_id,
      keyHash: r.key_hash,
      floor: r.floor,
      latestAccepted: r.latest_accepted ?? undefined,
    };
  }

  clientCount(documentId: string, branch: string): number {
    return this.stmt.clientCount.get(documentId, branch) as number;
  }

  claimClient(documentId: string, branch: string, clientId: string, keyHash: Buffer): void {
    this.stmt.insertClient.run(documentId, branch, clientId, keyHash);
  }

  outcome(
    documentId: string,
    branch: string,
    clientId: string,
    clientSeq: number,
  ): Outcome | undefined {
    const r = this.stmt.outcome.get(documentId, branch, clientId, clientSeq) as
      OutcomeRow | undefined;
    if (r === undefined) return undefined;
    if (r.rev !== null) return { kind: 'accepted', rev: r.rev };
    return { kind: 'refused', error: JSON.parse(r.error!) as { code: string; message: string } };
  }

  rowCount(documentId: string, branch: string, clientId: string, fromSeq = 0): number {
    return this.stmt.rowCount.get(documentId, branch, clientId, fromSeq) as number;
  }

  commitSubmit(write: SubmitWrite): void {
    this.commitTx.immediate(write);
  }

  private writeSubmit(w: SubmitWrite): void {
    const { documentId: d, branch: b, clientId: c } = w;
    for (const p of w.accepted) this.stmt.insertEntry.run(d, b, p.rev, JSON.stringify(p.entry));
    for (const { clientSeq, outcome } of w.outcomes) {
      if (outcome.kind === 'accepted') {
        this.stmt.insertOutcome.run(d, b, c, clientSeq, outcome.rev, null);
      } else {
        this.stmt.insertOutcome.run(d, b, c, clientSeq, null, JSON.stringify(outcome.error));
      }
    }
    this.options.duringCommit?.();
    for (const s of w.snapshots) {
      this.stmt.insertSnapshot.run(
        d,
        b,
        s.rev,
        JSON.stringify(s.document),
        JSON.stringify(s.highWater),
      );
    }
    if (w.head !== undefined) {
      const from = w.accepted.length > 0 ? w.accepted[0]!.rev - 1 : w.head.rev;
      const moved = this.stmt.updateHead.run(
        w.head.rev,
        JSON.stringify(w.head.highWater),
        d,
        b,
        from,
      );
      if (moved.changes !== 1) throw new Error(`Branch ${d}/${b} moved during a submit`);
    }
    this.stmt.updateClient.run(w.floor, w.latestAccepted ?? null, d, b, c);
    this.stmt.prune.run(d, b, c, w.floor, w.latestAccepted ?? null);
  }

  putBlob(sha256: string, bytes: Buffer): boolean {
    const r = this.stmt.putBlob.run(sha256, bytes.length, bytes, new Date().toISOString());
    return r.changes === 1;
  }

  getBlob(sha256: string): Buffer | undefined {
    return this.stmt.getBlob.get(sha256) as Buffer | undefined;
  }

  hasBlob(sha256: string): boolean {
    return this.stmt.hasBlob.get(sha256) !== undefined;
  }

  blobBytes(): number {
    return this.stmt.blobBytes.get() as number;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
