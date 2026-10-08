// `doc-comments.json` must say what core's sources say. After a deliberate change to core's
// comments (or commands), rerun with `-u`: the file is rewritten from the sources.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SimpleCommandSchema } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { extractDocComments } from './doc-comments';

const core = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../core/src/${file}`, import.meta.url)), 'utf8');

describe('doc comments', () => {
  const table = extractDocComments(core('commands.ts'), core('schema.ts'));

  it('are read for every command type', () => {
    const types = SimpleCommandSchema.options.map(
      (o) => (o as unknown as { shape: { type: { value: string } } }).shape.type.value,
    );
    expect(Object.keys(table.commands).sort()).toEqual([...types].sort());
  });

  it('match doc-comments.json', async () => {
    await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot('./doc-comments.json');
  });
});
