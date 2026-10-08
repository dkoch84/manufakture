// Setup file of the `library-node` test project (vitest.config.ts): the library's suites run
// again with every backend a directory on disk (`NodeBackend`), each in its own temporary
// directory, removed when the file's tests are done.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { NodeBackend } from './node';
import { useTestBackends, type FileMap, type TestBackend } from './test-fixtures';

/** A directory's files, read and changed with synchronous calls, as `MemoryBackend.files`. */
class DirectoryFiles implements FileMap {
  readonly #backend: NodeBackend;

  constructor(backend: NodeBackend) {
    this.#backend = backend;
  }

  get(p: string): Uint8Array | undefined {
    const full = this.#backend.resolve(p);
    return existsSync(full) ? new Uint8Array(readFileSync(full)) : undefined;
  }

  set(p: string, bytes: Uint8Array): this {
    const full = this.#backend.resolve(p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    return this;
  }

  has(p: string): boolean {
    return existsSync(this.#backend.resolve(p));
  }

  delete(p: string): boolean {
    const full = this.#backend.resolve(p);
    if (!existsSync(full)) return false;
    unlinkSync(full);
    return true;
  }

  *keys(): IterableIterator<string> {
    const walk = function* (dir: string, prefix: string): Generator<string> {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile()) yield `${prefix}${e.name}`;
        else if (e.isDirectory()) yield* walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      }
    };
    yield* walk(this.#backend.root, '');
  }

  *[Symbol.iterator](): IterableIterator<[string, Uint8Array]> {
    for (const k of this.keys()) yield [k, this.get(k)!];
  }
}

class NodeTestBackend extends NodeBackend {
  readonly files = new DirectoryFiles(this);
}

const made: string[] = [];

function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'manufakture-library-'));
  made.push(dir);
  return dir;
}

useTestBackends({
  make: (): TestBackend => new NodeTestBackend(directory()),
  clone: (from): TestBackend => {
    const to = directory();
    if (from instanceof NodeBackend) cpSync(from.root, to, { recursive: true });
    else for (const [k, v] of from.files) new DirectoryFiles(new NodeBackend(to)).set(k, v);
    return new NodeTestBackend(to);
  },
});

afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
