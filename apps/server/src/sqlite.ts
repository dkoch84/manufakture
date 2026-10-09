import Database from 'better-sqlite3';
import type { CounterTable, ManufaktureDocument } from '@manufakture/core';
import {
  ProvenanceSchema,
  type Outcome,
  type Provenance,
  type PushedEntry,
  type ServerBranch,
  type ServerVersion,
} from '@manufakture/sync';
import type {
  BranchMeta,
  ClientRecord,
  DocumentInfo,
  LoadedBranch,
  StoredBundle,
  StoredSnapshot,
  SubmitWrite,
  SyncStore,
} from './store';
import { MAIN_BRANCH } from './store';

/**
 * The schema version this code writes; `meta.schema`. A newer database is refused. 2 (T7.1e)
 * adds `versions` and `branch_records`; a version 1 database gets them on open. 3 (T8.4b) adds
 * agent branches (`provenance`, `created_by` and the reopen marker on `branch_records`), review
 * bundles (`review_bundles`, with their size and the agent token that stored one), agent tokens
 * (`agent_tokens`, tokens.ts), and who made a version or stored a blob (`created_by` on
 * `versions` and `blobs`, and `start_of` on a start version); an older database gets them on open.
 *
 * `start_of` marks a start version (one stored with a branch by `createBranch`): it names that
 * branch while the branch is there, and is `''` once the version outlives it (`GONE_BRANCH`), so a
 * branch made later under a reused id never inherits it. Who may delete one is `deleteBranch`'s.
 */
export const STORE_SCHEMA_VERSION = 3;

/** `start_of` of a start version whose branch is gone: no branch id (`RECORD_ID`) is empty. */
const GONE_BRANCH = '';

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
CREATE TABLE IF NOT EXISTS versions (
  document_id TEXT NOT NULL REFERENCES documents(id),
  id TEXT NOT NULL,
  branch TEXT NOT NULL,
  rev INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  start_of TEXT,
  PRIMARY KEY (document_id, id),
  FOREIGN KEY (document_id, branch) REFERENCES branches(document_id, branch)
) STRICT;
CREATE TABLE IF NOT EXISTS branch_records (
  document_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  name TEXT NOT NULL,
  from_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provenance TEXT,
  created_by TEXT,
  reopened_from TEXT,
  reopened_head INTEGER,
  PRIMARY KEY (document_id, branch),
  FOREIGN KEY (document_id, branch) REFERENCES branches(document_id, branch),
  FOREIGN KEY (document_id, from_version) REFERENCES versions(document_id, id)
) STRICT;
CREATE TABLE IF NOT EXISTS review_bundles (
  document_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (document_id, branch, revision),
  FOREIGN KEY (document_id, branch) REFERENCES branches(document_id, branch)
) STRICT;
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
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

interface BranchRow {
  id: string;
  name: string;
  fromVersion: string;
  createdAt: string;
  provenance: string | null;
  createdBy: string | null;
  reopenedFrom: string | null;
  reopenedHead: number | null;
}

/** Columns T8.4b adds to existing tables, for a database made before it. */
const ADDED_COLUMNS: readonly [table: string, column: string, type: string][] = [
  ['branch_records', 'provenance', 'TEXT'],
  ['branch_records', 'created_by', 'TEXT'],
  ['branch_records', 'reopened_from', 'TEXT'],
  ['branch_records', 'reopened_head', 'INTEGER'],
  ['versions', 'created_by', 'TEXT'],
  ['versions', 'start_of', 'TEXT'],
  ['blobs', 'created_by', 'TEXT'],
];

interface VersionRow {
  id: string;
  name: string;
  description: string;
  branch: string;
  rev: number;
  createdAt: string;
  createdBy: string | null;
}

/** A stored version row as a record: `createdBy` only when an agent token made it. */
function versionOf(r: VersionRow): ServerVersion {
  const { createdBy, ...rest } = r;
  return createdBy === null ? rest : { ...rest, createdBy };
}

const VERSION_SELECT = `SELECT id, name, description, branch, rev, created_at AS createdAt,
  created_by AS createdBy FROM versions`;

/**
 * A stored branch row as a record. A provenance that does not check makes the row unreadable
 * (undefined), never a person's branch.
 */
function branchOf(r: BranchRow): BranchMeta | undefined {
  const record: ServerBranch = {
    id: r.id,
    name: r.name,
    fromVersion: r.fromVersion,
    createdAt: r.createdAt,
  };
  if (r.provenance !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.provenance);
    } catch {
      return undefined;
    }
    const p = ProvenanceSchema.safeParse(parsed);
    if (!p.success) return undefined;
    record.provenance = p.data;
  }
  return {
    record,
    createdBy: r.createdBy,
    reopenedFrom: r.reopenedFrom,
    reopenedHead: r.reopenedHead,
  };
}

const BRANCH_SELECT = `SELECT branch AS id, name, from_version AS fromVersion, created_at AS createdAt,
  provenance, created_by AS createdBy, reopened_from AS reopenedFrom,
  reopened_head AS reopenedHead FROM branch_records`;

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
        `INSERT OR IGNORE INTO blobs (sha256, size, data, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      agentBlobBytes: db
        .prepare('SELECT coalesce(sum(size), 0) FROM blobs WHERE created_by = ?')
        .pluck(),
      getBlob: db.prepare('SELECT data FROM blobs WHERE sha256 = ?').pluck(),
      hasBlob: db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').pluck(),
      blobBytes: db.prepare('SELECT coalesce(sum(size), 0) FROM blobs').pluck(),
      hasBranch: db.prepare('SELECT 1 FROM branches WHERE document_id = ? AND branch = ?').pluck(),
      insertSnapshotIfAbsent: db.prepare(
        `INSERT OR IGNORE INTO snapshots (document_id, branch, rev, document, high_water)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      versions: db.prepare(`${VERSION_SELECT} WHERE document_id = ? ORDER BY rowid`),
      version: db.prepare(`${VERSION_SELECT} WHERE document_id = ? AND id = ?`),
      versionCount: db.prepare('SELECT count(*) FROM versions WHERE document_id = ?').pluck(),
      agentVersionCount: db
        .prepare('SELECT count(*) FROM versions WHERE document_id = ? AND created_by = ?')
        .pluck(),
      insertVersion: db.prepare(
        `INSERT INTO versions
           (document_id, id, branch, rev, name, description, created_at, created_by, start_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      openAgentBranchCount: db
        .prepare(
          `SELECT count(*) FROM branch_records WHERE document_id = ? AND created_by = ?
           AND json_extract(provenance, '$.review') NOT IN ('approved', 'rejected')`,
        )
        .pluck(),
      branchRecords: db.prepare(`${BRANCH_SELECT} WHERE document_id = ? ORDER BY rowid`),
      branchRecord: db.prepare(`${BRANCH_SELECT} WHERE document_id = ? AND branch = ?`),
      branchCount: db.prepare('SELECT count(*) FROM branch_records WHERE document_id = ?').pluck(),
      insertBranchRecord: db.prepare(
        `INSERT INTO branch_records
           (document_id, branch, name, from_version, created_at, provenance, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateReview: db.prepare(
        `UPDATE branch_records SET provenance = ?, reopened_from = ?, reopened_head = ?
         WHERE document_id = ? AND branch = ? AND json_extract(provenance, '$.review') = ?`,
      ),
      branchVersionCount: db
        .prepare('SELECT count(*) FROM versions WHERE document_id = ? AND branch = ?')
        .pluck(),
      putBundle: db.prepare(
        `INSERT OR REPLACE INTO review_bundles
           (document_id, branch, revision, record, bytes, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      pruneBundles: db.prepare(
        `DELETE FROM review_bundles WHERE document_id = ? AND branch = ? AND revision NOT IN (
           SELECT revision FROM review_bundles WHERE document_id = ? AND branch = ?
           ORDER BY revision DESC LIMIT ?)`,
      ),
      latestBundle: db.prepare(
        `SELECT revision, record FROM review_bundles WHERE document_id = ? AND branch = ?
         ORDER BY revision DESC LIMIT 1`,
      ),
      bundleMeta: db.prepare(
        `SELECT revision, bytes FROM review_bundles
         WHERE document_id = ? AND branch = ? ORDER BY revision DESC LIMIT 1`,
      ),
      bundleBytes: db
        .prepare(
          `SELECT coalesce(sum(bytes), 0) FROM review_bundles
           WHERE document_id = ? AND NOT (branch IS ? AND revision IS ?)`,
        )
        .pluck(),
      agentBundleBytes: db
        .prepare(
          `SELECT coalesce(sum(bytes), 0) FROM review_bundles WHERE created_by = ?
           AND NOT (document_id IS ? AND branch IS ? AND revision IS ?)`,
        )
        .pluck(),
      totalBundleBytes: db
        .prepare(
          `SELECT coalesce(sum(bytes), 0) FROM review_bundles
           WHERE NOT (document_id IS ? AND branch IS ? AND revision IS ?)`,
        )
        .pluck(),
      // An agent-made version, or a start version of the owner's, that no branch starts from
      // (versions name a revision; only a branch record refers to a version).
      deleteUnreferencedVersion: db.prepare(
        `DELETE FROM versions WHERE document_id = ? AND id = ?
         AND (created_by IS NOT NULL OR start_of IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM branch_records r
           WHERE r.document_id = versions.document_id AND r.from_version = versions.id)`,
      ),
      versionReferenced: db
        .prepare('SELECT count(*) FROM branch_records WHERE document_id = ? AND from_version = ?')
        .pluck(),
      versionOrigin: db.prepare(
        `SELECT created_by AS createdBy, start_of AS startOf FROM versions
         WHERE document_id = ? AND id = ?`,
      ),
      // The start version a deleted branch started from, when nothing starts from it now and the
      // delete may take it: an agent token made it, or the owner did and the branch was the
      // owner's (only the owner deletes the owner's branches). Never the owner's through an
      // agent's branch.
      deleteStartVersion: db.prepare(
        `DELETE FROM versions WHERE document_id = ? AND id = ? AND start_of IS NOT NULL
         AND (created_by IS NOT NULL OR ? IS NULL)
         AND NOT EXISTS (SELECT 1 FROM branch_records r
           WHERE r.document_id = versions.document_id AND r.from_version = versions.id)`,
      ),
      strandStartVersions: db.prepare(
        `UPDATE versions SET start_of = '${GONE_BRANCH}' WHERE document_id = ? AND start_of = ?`,
      ),
      sweepStartVersions: db.prepare(
        `DELETE FROM versions WHERE created_by = ? AND start_of IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM branch_records r
           WHERE r.document_id = versions.document_id AND r.from_version = versions.id)`,
      ),
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
    if (Number(row) < STORE_SCHEMA_VERSION) {
      // The tables a newer schema adds were created above (`IF NOT EXISTS`); the columns T8.4b
      // adds to older tables are added here (absent: a person's branch, a version or blob of the
      // owner's).
      for (const [table, name, type] of ADDED_COLUMNS) {
        const have = (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === name);
        if (!have) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'schema'")
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

  entries(
    documentId: string,
    branch: string,
    since: number,
    limit: number,
    maxBytes = Number.POSITIVE_INFINITY,
  ): PushedEntry[] {
    const b = this.stmt.branch.get(documentId, branch) as { head: number } | undefined;
    if (b === undefined) return [];
    if (maxBytes === Number.POSITIVE_INFINITY) {
      return this.readEntries(documentId, branch, since, b.head, limit);
    }
    // Row by row, stopping once the stored JSON passes `maxBytes`: the first row always comes, so
    // a pull makes progress even past an entry larger than the cap.
    const out: PushedEntry[] = [];
    let bytes = 0;
    for (const r of this.stmt.entries.iterate(
      documentId,
      branch,
      since,
      b.head,
      limit,
    ) as Iterable<{
      rev: number;
      entry: string;
    }>) {
      bytes += Buffer.byteLength(r.entry);
      if (out.length > 0 && bytes > maxBytes) break;
      out.push({ rev: r.rev, entry: JSON.parse(r.entry) as PushedEntry['entry'] });
    }
    return out;
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

  hasBranch(documentId: string, branch: string): boolean {
    return this.stmt.hasBranch.get(documentId, branch) !== undefined;
  }

  snapshotAt(documentId: string, branch: string, rev: number): StoredSnapshot | undefined {
    const s = this.stmt.latestSnapshot.get(documentId, branch, rev) as
      { rev: number; document: string; high_water: string } | undefined;
    if (s === undefined) return undefined;
    return {
      rev: s.rev,
      document: JSON.parse(s.document) as ManufaktureDocument,
      highWater: JSON.parse(s.high_water) as CounterTable,
    };
  }

  listVersions(documentId: string): ServerVersion[] {
    return (this.stmt.versions.all(documentId) as VersionRow[]).map(versionOf);
  }

  version(documentId: string, versionId: string): ServerVersion | undefined {
    const r = this.stmt.version.get(documentId, versionId) as VersionRow | undefined;
    return r === undefined ? undefined : versionOf(r);
  }

  agentVersionCount(documentId: string, tokenId: string): number {
    return this.stmt.agentVersionCount.get(documentId, tokenId) as number;
  }

  openAgentBranchCount(documentId: string, tokenId: string): number {
    return this.stmt.openAgentBranchCount.get(documentId, tokenId) as number;
  }

  versionCount(documentId: string): number {
    return this.stmt.versionCount.get(documentId) as number;
  }

  insertVersion(
    documentId: string,
    v: ServerVersion,
    snapshot: StoredSnapshot,
    createdBy: string | null = null,
  ): boolean {
    return this.db
      .transaction(() => this.#insertVersion(documentId, v, snapshot, createdBy, null))
      .immediate();
  }

  #insertVersion(
    documentId: string,
    v: ServerVersion,
    snapshot: StoredSnapshot,
    createdBy: string | null,
    startOf: string | null,
  ): boolean {
    if (this.stmt.version.get(documentId, v.id) !== undefined) return false;
    this.stmt.insertVersion.run(
      documentId,
      v.id,
      v.branch,
      v.rev,
      v.name,
      v.description,
      v.createdAt,
      createdBy,
      startOf,
    );
    this.stmt.insertSnapshotIfAbsent.run(
      documentId,
      v.branch,
      snapshot.rev,
      JSON.stringify(snapshot.document),
      JSON.stringify(snapshot.highWater),
    );
    return true;
  }

  listBranches(documentId: string): ServerBranch[] {
    return (this.stmt.branchRecords.all(documentId) as BranchRow[]).flatMap((r) => {
      const b = branchOf(r);
      return b === undefined ? [] : [b.record];
    });
  }

  branchRecord(documentId: string, branch: string): ServerBranch | undefined {
    return this.branchMeta(documentId, branch)?.record;
  }

  branchMeta(documentId: string, branch: string): BranchMeta | undefined {
    const r = this.stmt.branchRecord.get(documentId, branch) as BranchRow | undefined;
    return r === undefined ? undefined : branchOf(r);
  }

  updateReview(
    documentId: string,
    branch: string,
    from: string,
    provenance: Provenance,
    reopened: { from: string; head: number } | null,
  ): boolean {
    return (
      this.stmt.updateReview.run(
        JSON.stringify(provenance),
        reopened?.from ?? null,
        reopened?.head ?? null,
        documentId,
        branch,
        from,
      ).changes === 1
    );
  }

  branchVersionCount(documentId: string, branch: string): number {
    return this.stmt.branchVersionCount.get(documentId, branch) as number;
  }

  deleteBranch(
    documentId: string,
    branch: string,
    review?: string,
    options: { withAgentVersions?: boolean } = {},
  ): 'deleted' | 'gone' | 'changed' | 'has-versions' {
    if (branch === MAIN_BRANCH) return 'gone';
    return this.db
      .transaction(() => {
        const d = this.db;
        const meta = this.branchMeta(documentId, branch);
        if (meta === undefined) return 'gone' as const;
        if (review !== undefined && meta.record.provenance?.review !== review) {
          return 'changed' as const;
        }
        const named = d
          .prepare(
            `SELECT v.id, v.created_by AS createdBy,
               (SELECT count(*) FROM branch_records r
                 WHERE r.document_id = v.document_id AND r.from_version = v.id) AS starts
             FROM versions v WHERE v.document_id = ? AND v.branch = ?`,
          )
          .all(documentId, branch) as { id: string; createdBy: string | null; starts: number }[];
        if (named.length > 0) {
          const removable =
            options.withAgentVersions === true &&
            named.every((v) => v.createdBy !== null && v.starts === 0);
          if (!removable) return 'has-versions' as const;
          d.prepare('DELETE FROM versions WHERE document_id = ? AND branch = ?').run(
            documentId,
            branch,
          );
        }
        for (const table of ['outcomes', 'clients', 'entries', 'snapshots', 'review_bundles']) {
          d.prepare(`DELETE FROM ${table} WHERE document_id = ? AND branch = ?`).run(
            documentId,
            branch,
          );
        }
        d.prepare('DELETE FROM branch_records WHERE document_id = ? AND branch = ?').run(
          documentId,
          branch,
        );
        d.prepare('DELETE FROM branches WHERE document_id = ? AND branch = ?').run(
          documentId,
          branch,
        );
        // The version it started from goes with it when it is a start version that no other
        // branch starts from now, and this delete may take it: an agent token's (whichever branch
        // it was stored with), or the owner's when this branch was the owner's too. An agent's
        // delete never takes a version the owner made. Otherwise an agent-made version of main
        // could outlive every branch and every token.
        this.stmt.deleteStartVersion.run(documentId, meta.record.fromVersion, meta.createdBy);
        // A start version stored with this branch that outlives it no longer names it, so a
        // branch made later under this id inherits nothing.
        this.stmt.strandStartVersions.run(documentId, branch);
        return 'deleted' as const;
      })
      .immediate();
  }

  putBundle(
    documentId: string,
    branch: string,
    revision: number,
    record: string,
    keep: number,
    createdBy: string | null = null,
  ): void {
    this.db
      .transaction(() => {
        this.stmt.putBundle.run(
          documentId,
          branch,
          revision,
          record,
          Buffer.byteLength(record),
          createdBy,
        );
        this.stmt.pruneBundles.run(documentId, branch, documentId, branch, keep);
      })
      .immediate();
  }

  latestBundle(documentId: string, branch: string): StoredBundle | undefined {
    return this.stmt.latestBundle.get(documentId, branch) as StoredBundle | undefined;
  }

  bundleMeta(documentId: string, branch: string): { revision: number; bytes: number } | undefined {
    return this.stmt.bundleMeta.get(documentId, branch) as
      { revision: number; bytes: number } | undefined;
  }

  bundleBytes(documentId: string, except?: { branch: string; revision: number }): number {
    return this.stmt.bundleBytes.get(
      documentId,
      except?.branch ?? null,
      except?.revision ?? null,
    ) as number;
  }

  agentBundleBytes(
    tokenId: string,
    except?: { documentId: string; branch: string; revision: number },
  ): number {
    return this.stmt.agentBundleBytes.get(
      tokenId,
      except?.documentId ?? null,
      except?.branch ?? null,
      except?.revision ?? null,
    ) as number;
  }

  totalBundleBytes(except?: { documentId: string; branch: string; revision: number }): number {
    return this.stmt.totalBundleBytes.get(
      except?.documentId ?? null,
      except?.branch ?? null,
      except?.revision ?? null,
    ) as number;
  }

  deleteAgentVersion(
    documentId: string,
    versionId: string,
  ): 'deleted' | 'gone' | 'owner-made' | 'referenced' {
    return this.db
      .transaction(() => {
        const v = this.stmt.versionOrigin.get(documentId, versionId) as
          { createdBy: string | null; startOf: string | null } | undefined;
        if (v === undefined) return 'gone' as const;
        if (v.createdBy === null && v.startOf === null) return 'owner-made' as const;
        if ((this.stmt.versionReferenced.get(documentId, versionId) as number) > 0) {
          return 'referenced' as const;
        }
        this.stmt.deleteUnreferencedVersion.run(documentId, versionId);
        return 'deleted' as const;
      })
      .immediate();
  }

  sweepStartVersions(tokenId: string): number {
    return this.stmt.sweepStartVersions.run(tokenId).changes;
  }

  branchCount(documentId: string): number {
    return this.stmt.branchCount.get(documentId) as number;
  }

  createBranch(
    documentId: string,
    record: ServerBranch,
    document: ManufaktureDocument,
    highWater: CounterTable,
    createdBy: string | null = null,
    startVersion?: { version: ServerVersion; snapshot: StoredSnapshot },
  ): boolean {
    return this.db
      .transaction(() => {
        if (this.stmt.hasBranch.get(documentId, record.id) !== undefined) return false;
        if (startVersion !== undefined) {
          const v = startVersion.version;
          const stored = this.stmt.version.get(documentId, v.id);
          // Stored already (a resend) or not, it is the version the branch starts from.
          if (stored === undefined) {
            this.#insertVersion(documentId, v, startVersion.snapshot, createdBy, record.id);
          }
        }
        const hw = JSON.stringify(highWater);
        this.stmt.insertBranch.run(documentId, record.id, hw);
        this.stmt.insertSnapshot.run(documentId, record.id, 0, JSON.stringify(document), hw);
        this.stmt.insertBranchRecord.run(
          documentId,
          record.id,
          record.name,
          record.fromVersion,
          record.createdAt,
          record.provenance === undefined ? null : JSON.stringify(record.provenance),
          createdBy,
        );
        return true;
      })
      .immediate();
  }

  putBlob(sha256: string, bytes: Buffer, createdBy: string | null = null): boolean {
    const r = this.stmt.putBlob.run(
      sha256,
      bytes.length,
      bytes,
      new Date().toISOString(),
      createdBy,
    );
    return r.changes === 1;
  }

  agentBlobBytes(tokenId: string): number {
    return this.stmt.agentBlobBytes.get(tokenId) as number;
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

  /** The open database, for tables kept beside the sync store's (shares.ts). */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
