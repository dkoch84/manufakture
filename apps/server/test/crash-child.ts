import { readFileSync } from 'node:fs';
import { DEFAULT_LIMITS } from '../src/limits';
import { SyncService } from '../src/service';
import { SqliteStore } from '../src/sqlite';

/**
 * Test-only child process for the torn-write test: submits a message through the real service and
 * store, and inside the commit transaction (after the entries and outcomes are written, before
 * the head moves) says "ready" and blocks until the parent kills it with SIGKILL.
 */
const [dbPath, inputPath] = process.argv.slice(2) as [string, string];
const input = JSON.parse(readFileSync(inputPath, 'utf8')) as {
  documentId: string;
  key: string;
  message: unknown;
};
const store = new SqliteStore(dbPath, {
  duringCommit: () => {
    process.stdout.write('ready\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
const service = new SyncService(store, { limits: DEFAULT_LIMITS });
const r = service.submit(input.documentId, input.message, { key: input.key });
process.stdout.write(`finished ${JSON.stringify(r)}\n`);
