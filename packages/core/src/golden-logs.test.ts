import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SimpleCommandSchema, applyCommand, type Command } from './commands';
import { parseDocument, serialize } from './format';
import { migrateCommand } from './migrations';
import { FORMAT_VERSION } from './schema';

/**
 * Golden command logs (M7 plan, cross-cutting decision 3: core is a wire protocol). Each file in
 * `fixtures/logs/` is a log written under one format version: a start document, entries in the
 * persistence `LogEntry` shape, and the document they lead to. The test replays every entry
 * through the command migrations and compares the canonical output (`serialize`) with the
 * expected document brought up to the current format.
 *
 * A golden is never regenerated or edited. A change that alters one is a breaking change: give
 * the new meaning a new command type, and keep the old golden passing. A format bump adds a
 * command migration (`COMMAND_MIGRATIONS`) so old goldens still replay.
 */

interface GoldenLog {
  format: 'manufakture-golden-log';
  version: number;
  description: string;
  base: unknown;
  entries: { cause: 'execute' | 'undo' | 'redo'; label: string; command: unknown; at: string }[];
  expected: unknown;
}

const DIR = fileURLToPath(new URL('./fixtures/logs/', import.meta.url));
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const logs = files.map((f) => [f, JSON.parse(readFileSync(DIR + f, 'utf8')) as GoldenLog] as const);

function load(value: unknown, what: string) {
  const r = parseDocument(value);
  if (!r.ok) throw new Error(`${what}: ${r.error.code} ${r.error.message}`);
  return r.value.document;
}

/** Every command type a list names, batches opened. */
function types(commands: readonly Command[], into: Set<string>): void {
  for (const c of commands) {
    into.add(c.type);
    if (c.type === 'batch') types(c.commands, into);
  }
}

describe('golden command logs', () => {
  it('has logs', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(logs)('%s replays to its expected document', (file, log) => {
    expect(log.format).toBe('manufakture-golden-log');
    expect(log.version).toBeLessThanOrEqual(FORMAT_VERSION);
    let doc = load(log.base, `${file} base`);
    log.entries.forEach((entry, i) => {
      const command = migrateCommand(entry.command, log.version);
      if (!command.ok) throw new Error(`${file} entry ${i}: ${command.error.message}`);
      const r = applyCommand(doc, command.value);
      if (!r.ok) throw new Error(`${file} entry ${i} (${entry.label}): ${r.error.message}`);
      doc = r.value.document;
    });
    expect(serialize(doc)).toBe(serialize(load(log.expected, `${file} expected`)));
  });

  it('covers every command type, batch included', () => {
    const seen = new Set<string>();
    for (const [file, log] of logs) {
      const commands = log.entries.map((e) => {
        const c = migrateCommand(e.command, log.version);
        if (!c.ok) throw new Error(`${file}: ${c.error.message}`);
        return c.value;
      });
      types(commands, seen);
    }
    const all = [...SimpleCommandSchema.options.map((o) => o.shape.type.value), 'batch'];
    expect(all.filter((t) => !seen.has(t))).toEqual([]);
  });
});
